import { MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, TextFileView, WorkspaceLeaf, WorkspaceWindow, normalizePath, requireApiVersion, setIcon, setTooltip } from "obsidian";
import type { App, SettingDefinitionItem, Tasks, ViewState } from "obsidian";
import { BrowserWindow, globalShortcut, screen } from "@electron/remote";

const DEFAULT_COLOR = "#fff3a3";
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 360;
const NATIVE_WINDOW_LOOKUP_ATTEMPTS = 20;
const NATIVE_WINDOW_LOOKUP_INTERVAL = 50;
const RESTORATION_RETRY_LIMIT = 20;
const RESTORATION_RETRY_INTERVAL = 250;
const TOGGLE_INITIALIZATION_WAIT = 2000;
const RELOAD_WINDOW_CLOSE_ATTEMPTS = 40;
const RELOAD_WINDOW_CLOSE_INTERVAL = 50;
const WINDOW_NAME_PREFIX = "desktop-sticky-notes:";
const STICKY_VIEW_STATE_KEY = "desktopStickyNote";
const LEGACY_DEFAULT_GLOBAL_SHORTCUT = "CommandOrControl+Alt+N";

type DesktopPlatform = "linux" | "macos" | "windows";

const CURRENT_PLATFORM: DesktopPlatform = Platform.isMacOS ? "macos" : Platform.isWin ? "windows" : "linux";
const DEFAULT_GLOBAL_SHORTCUTS: Record<DesktopPlatform, string> = {
  linux: "Super+F10",
  macos: "Option+F10",
  windows: "Super+F10"
};
const KNOWN_DEFAULT_GLOBAL_SHORTCUTS = new Set([
  LEGACY_DEFAULT_GLOBAL_SHORTCUT,
  ...Object.values(DEFAULT_GLOBAL_SHORTCUTS)
]);

const ACCELERATOR_KEYS_BY_CODE: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  CapsLock: "Capslock",
  NumLock: "Numlock",
  ScrollLock: "Scrolllock",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Enter: "Enter",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  PrintScreen: "PrintScreen",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "\"",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  NumpadDecimal: "numdec",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv"
};

function acceleratorKeyForEvent(event: KeyboardEvent): string | null {
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5);
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.code)) return event.code;
  if (/^Numpad[0-9]$/.test(event.code)) return `num${event.code.slice(6)}`;
  return ACCELERATOR_KEYS_BY_CODE[event.code] ?? null;
}

function acceleratorForEvent(event: KeyboardEvent): string | null {
  const key = acceleratorKeyForEvent(event);
  if (!key) return null;

  const modifiers: string[] = [];
  if (event.getModifierState("AltGraph")) {
    modifiers.push("AltGr");
  } else {
    if (event.metaKey) modifiers.push(Platform.isMacOS ? "Command" : "Super");
    if (event.ctrlKey) modifiers.push("Control");
    if (event.altKey) modifiers.push("Alt");
  }
  if (event.shiftKey) modifiers.push("Shift");
  return [...modifiers, key].join("+");
}

function displayAccelerator(accelerator: string): string {
  if (!accelerator) return "Disabled";
  const labels = accelerator.split("+").map((part) => {
    if (Platform.isMacOS) {
      if (["Command", "Cmd", "CommandOrControl", "CmdOrCtrl", "Super", "Meta"].includes(part)) return "⌘";
      if (["Control", "Ctrl"].includes(part)) return "⌃";
      if (["Alt", "Option"].includes(part)) return "⌥";
      if (part === "Shift") return "⇧";
    } else {
      if (["Super", "Meta"].includes(part)) return "Win";
      if (["Control", "Ctrl", "CommandOrControl", "CmdOrCtrl"].includes(part)) return "Ctrl";
    }
    return part === "Plus" ? "+" : part;
  });
  return labels.join(Platform.isMacOS ? " " : " + ");
}

function normalizeAcceleratorForPlatform(accelerator: string): string {
  if (KNOWN_DEFAULT_GLOBAL_SHORTCUTS.has(accelerator)) return DEFAULT_GLOBAL_SHORTCUTS[CURRENT_PLATFORM];

  return accelerator.split("+").map((part) => {
    if (CURRENT_PLATFORM === "macos") {
      if (["Command", "Cmd", "CommandOrControl", "CmdOrCtrl", "Super", "Meta"].includes(part)) return "Command";
      if (part === "Option") return "Alt";
    } else {
      if (["Command", "Cmd", "Super", "Meta"].includes(part)) return "Super";
      if (["CommandOrControl", "CmdOrCtrl"].includes(part)) return "Control";
      if (part === "Option") return "Alt";
    }
    return part;
  }).join("+");
}

interface StickyNoteSettings {
  defaultFolder: string;
  defaultNoteColor: string;
  enableCollapsibleNotes: boolean;
  globalToggleShortcuts: Record<DesktopPlatform, string>;
  topLevelNotePath: string | null;
  topLevelWindowPosition: WindowPosition | null;
  colorsByPath: Record<string, string>;
  stickyNoteLeafIds: string[];
}

type StoredStickyNoteSettings = Partial<Omit<StickyNoteSettings, "globalToggleShortcuts" | "stickyNoteLeafIds">> & {
  globalToggleShortcut?: unknown;
  globalToggleShortcuts?: Partial<Record<DesktopPlatform, unknown>>;
  openNotePaths?: unknown;
  stickyNoteLeafIds?: unknown;
};

interface WindowPosition {
  x: number;
  y: number;
}

function createDefaultSettings(): StickyNoteSettings {
  return {
    defaultFolder: "",
    defaultNoteColor: DEFAULT_COLOR,
    enableCollapsibleNotes: false,
    globalToggleShortcuts: { ...DEFAULT_GLOBAL_SHORTCUTS },
    topLevelNotePath: null,
    topLevelWindowPosition: null,
    colorsByPath: {},
    stickyNoteLeafIds: []
  };
}

interface StickyActions {
  pin: HTMLElement;
  colorPicker: HTMLInputElement;
  mode: HTMLElement;
  hide: HTMLElement;
  collapse?: HTMLElement;
}

interface StickyNoteWindow {
  file: TFile;
  leaf: WorkspaceLeaf;
  leafId: string | null;
  document: Document;
  window: NativeBrowserWindow;
  observer?: MutationObserver;
  // Collapse state lives here rather than in the popout DOM: Obsidian rebuilds
  // that DOM on focus and layout changes, so only the plugin can be relied on
  // to know whether a window is collapsed and how tall it was before.
  isCollapsed: boolean;
  expandedSize?: { width: number; height: number };
}

interface PendingStickyNoteInitialization {
  path: string | null;
  ready: Promise<boolean>;
  finish: (initialized: boolean) => void;
}

interface ReloadCommand {
  callback?: () => unknown;
}

// The built-in command registry is not in Obsidian's public typings. Limit
// this compatibility boundary to the one reload command and feature-check it.
interface AppWithReloadCommand extends App {
  commands?: { commands?: Record<string, ReloadCommand | undefined> };
}

function createReloadTasks(): Tasks {
  // Tasks is declared in the API types but its constructor is not exported by
  // Obsidian 1.13.7. Match the quit event's public collector contract instead.
  const promises: Promise<unknown>[] = [];
  return {
    add(callback) { promises.push(callback()); },
    addPromise(promise) { promises.push(promise); },
    isEmpty() { return promises.length === 0; },
    promise() { return Promise.all(promises); }
  };
}

interface NativeBrowserWindow {
  setResizable(resizable: boolean): void;
  setAlwaysOnTop(alwaysOnTop: boolean): void;
  isAlwaysOnTop(): boolean;
  setTitle(title: string): void;
  getTitle(): string;
  isDestroyed(): boolean;
  isFocused(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  show(): void;
  restore(): void;
  focus(): void;
  moveTop(): void;
  setParentWindow(parent: NativeBrowserWindow | null): void;
  setSkipTaskbar(skip: boolean): void;
  close(): void;
  destroy(): void;
  getPosition(): [number, number];
  getContentSize(): [number, number];
  setContentSize(width: number, height: number): void;
  webContents: { getZoomFactor(): number };
}

export default class DesktopStickyNotesPlugin extends Plugin {
  settings: StickyNoteSettings = createDefaultSettings();
  private notesByPath = new Map<string, Set<StickyNoteWindow>>();
  private initializedLeaves = new WeakSet<WorkspaceLeaf>();
  private stickyStateLeaves = new WeakSet<WorkspaceLeaf>();
  private initializingLeaves = new Map<WorkspaceLeaf, PendingStickyNoteInitialization>();
  private watchedLeafWindows = new WeakMap<WorkspaceLeaf, Window>();
  private leavesByWindow = new WeakMap<Window, Map<WorkspaceLeaf, string | null>>();
  private closingLeaves = new WeakSet<WorkspaceLeaf>();
  private unloading = false;
  private quitting = false;
  private restorationTimer: number | null = null;
  private restorationRetries = 0;
  private discoveringRestoredLeaves = true;
  private registeredGlobalShortcut: string | null = null;
  private shortcutRegistrationTimer: number | null = null;
  private toggleInProgress = false;
  private reloading = false;
  private stickySessionActive = false;
  private closedWindowSavePending = false;
  private settingsSave: Promise<void> | null = null;

  async onload(): Promise<void> {
    // Capture workspace markers before asynchronous settings loading gives
    // Obsidian a chance to construct Markdown views and discard unknown state.
    this.registerStickyStatePersistence();
    await this.loadSettings();
    this.addSettingTab(new DesktopStickyNotesSettingTab(this.app, this));
    this.registerCommands();
    this.registerFileLifecycle();
    this.registerContextMenu();
    this.registerGlobalToggleShortcut();
    this.registerReloadLifecycle();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.restoreStickyNotes();
      this.scheduleRefreshAllNotes();
    }));
    this.registerEvent(this.app.workspace.on("window-open", () => this.restoreStickyNotes()));
    this.registerEvent(this.app.workspace.on("window-close", (container, domWindow) => this.onPopoutClosed(container, domWindow)));
    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.restoreStickyNotes();
      this.scheduleRefreshAllNotes();
    }));
    this.registerEvent(this.app.workspace.on("quit", () => {
      this.quitting = true;
      this.cancelPendingInitializations();
    }));
    const mainWindow = this.app.workspace.containerEl.ownerDocument.defaultView;
    if (mainWindow) this.registerDomEvent(mainWindow, "beforeunload", () => {
      this.quitting = true;
      this.cancelPendingInitializations();
    });
    // Observe already restored windows before layout readiness. Closing one
    // during startup must still remove its identity without loading its view.
    this.restoreStickyNotes();
    this.app.workspace.onLayoutReady(() => this.restoreStickyNotes());
  }

  private registerReloadLifecycle(): void {
    const command = (this.app as AppWithReloadCommand).commands?.commands?.["app:reload"];
    if (typeof command?.callback !== "function") return;
    const previousCallback = command.callback;
    const originalReload = previousCallback.bind(command);
    let active = true;
    const callback = () => {
      if (!active) return originalReload();
      void this.reloadWithStickyNotes(originalReload);
    };
    command.callback = callback;
    this.register(() => {
      active = false;
      if (command.callback === callback) command.callback = previousCallback;
    });
  }

  private async flushWorkspaceLayout(): Promise<void> {
    // Scheduling alone leaves a debounce timer behind, which a renderer
    // reload discards. run() is public from Obsidian 1.4.4 onward.
    this.app.workspace.requestSaveLayout();
    await this.app.workspace.requestSaveLayout.run();
  }

  private async flushSettings(): Promise<void> {
    await this.saveSettings();
    // Settings controls remain usable while saving. Include any newer writes
    // queued during the wait before discarding this renderer.
    while (this.settingsSave) await this.settingsSave;
  }

  private async reloadWithStickyNotes(originalReload: () => unknown): Promise<void> {
    if (this.reloading || this.quitting || this.unloading) return;
    const workspace = this.app.workspace;
    const popouts = new Set<Window>();
    const editors = new Set<TextFileView>();
    let hasSticky = false;
    workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof TextFileView) editors.add(leaf.view);
      const container = leaf.getContainer();
      if (!(container instanceof WorkspaceWindow)) return;
      if (container.win) popouts.add(container.win);
      if (leaf.getViewState().state?.[STICKY_VIEW_STATE_KEY] === true
        || this.settings.stickyNoteLeafIds.includes(this.workspaceLeafId(leaf) ?? "")) hasSticky = true;
    });
    this.stickySessionActive ||= hasSticky;
    // Keep managing reload after the last note closes: its removal still
    // needs to reach disk before "reload without saving" reads the workspace.
    if (!this.stickySessionActive) {
      originalReload();
      return;
    }
    if (!workspace.layoutReady) {
      new Notice("Obsidian is still loading. Try reloading again shortly.");
      return;
    }

    this.reloading = true;
    // A different command or plugin can open a popout while saving is pending,
    // even though this plugin's own open/toggle commands are blocked.
    const windowOpened = workspace.on("window-open", (_container, domWindow) => popouts.add(domWindow));
    const collectPopouts = () => workspace.iterateAllLeaves((leaf) => {
      const container = leaf.getContainer();
      if (container instanceof WorkspaceWindow && container.win) popouts.add(container.win);
    });
    let reloadStarted = false;
    try {
      // Catch a failed editor save before quit handlers close any editors.
      await Promise.all([...editors].map((view) => view.save()));
      await this.flushSettings();
      await this.flushWorkspaceLayout();
      if (this.unloading) return;
      collectPopouts();
      // The quit handlers save pending edits and close Obsidian's own popouts.
      // Freeze layout saves first: closing those windows must not replace the
      // saved snapshot with an empty layout, even if old callbacks fire later.
      workspace.layoutReady = false;
      this.quitting = true;
      const tasks = createReloadTasks();
      workspace.trigger("quit", tasks);
      await tasks.promise();
      for (let attempt = 0; attempt < RELOAD_WINDOW_CLOSE_ATTEMPTS; attempt++) {
        if (this.unloading) return;
        collectPopouts();
        if ([...popouts].every((domWindow) => domWindow.closed)) {
          // Native beforeunload may arrive after the quit tasks finish. Save
          // the position it records only once every old window has closed.
          await this.flushSettings();
          if (this.unloading) return;
          collectPopouts();
          if ([...popouts].some((domWindow) => !domWindow.closed)) continue;
          originalReload();
          reloadStarted = true;
          return;
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, RELOAD_WINDOW_CLOSE_INTERVAL));
      }
      throw new Error("Popout shutdown did not finish");
    } catch {
      // Honor a canceled close or a failed save. Never force-destroy an editor
      // to make reload succeed, and allow the user to continue using the app.
      new Notice("Reload stopped because Obsidian could not finish saving or closing its popouts.");
    } finally {
      workspace.offref(windowOpened);
      if (!reloadStarted) {
        workspace.layoutReady = true;
        this.quitting = false;
        // beforeunload can fire for a close that is subsequently canceled.
        // Allow any surviving managed views to initialize again.
        workspace.iterateAllLeaves((leaf) => this.closingLeaves.delete(leaf));
        this.restoreStickyNotes();
      }
      this.reloading = false;
    }
  }

  private onPopoutClosed(container: WorkspaceWindow, domWindow: Window): void {
    const leaves = this.leavesByWindow.get(domWindow);
    if (!leaves) return;
    this.leavesByWindow.delete(domWindow);
    const liveLeaves = new Set<WorkspaceLeaf>();
    this.app.workspace.iterateAllLeaves((leaf) => liveLeaves.add(leaf));
    let closedSticky = false;
    for (const [leaf, id] of leaves) {
      // A tab moved into another window must not inherit its former window's
      // close event. A removed leaf, however, may already have an empty view.
      if (liveLeaves.has(leaf) && leaf.getContainer() !== container) continue;
      closedSticky = true;
      this.closingLeaves.add(leaf);
      this.initializingLeaves.get(leaf)?.finish(false);
      if (!this.quitting && !this.unloading) {
        this.stickyStateLeaves.delete(leaf);
        if (id) this.forgetStickyLeafId(id);
      }
      for (const note of [...this.allNotes()]) {
        if (note.leaf === leaf) this.untrackNote(note);
      }
    }
    if (closedSticky && !this.quitting && !this.unloading) {
      // Obsidian can emit window-close while finishing tree removal. Let that
      // event complete, then persist the absence before another reload.
      this.closedWindowSavePending = true;
      window.setTimeout(() => this.saveClosedWindowLayout(), 0);
    }
  }

  private saveClosedWindowLayout(): void {
    if (!this.closedWindowSavePending || this.quitting || this.unloading || !this.app.workspace.layoutReady) return;
    this.closedWindowSavePending = false;
    void this.flushWorkspaceLayout().catch(() => {
      this.closedWindowSavePending = true;
      new Notice("Could not save the closed sticky-note window. Try reloading again.");
    });
  }

  private registerStickyStatePersistence(): void {
    const app = this.app;
    const stickyLeaves = this.stickyStateLeaves;
    // Capture unbound methods deliberately: each wrapper calls the original
    // with the invoking leaf, including when another plugin chains a wrapper.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The wrapper supplies the invoking leaf through call().
    const originalGetViewState = WorkspaceLeaf.prototype.getViewState;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- The wrapper supplies the invoking leaf through call().
    const originalSetViewState = WorkspaceLeaf.prototype.setViewState;
    let active = true;

    function getViewState(this: WorkspaceLeaf): ViewState {
      const state = originalGetViewState.call(this);
      // Keep normal Markdown views and their complete state. Only the known
      // popout gets a marker; an ordinary popout of the same file does not.
      if (!active || this.view?.app !== app || !stickyLeaves.has(this)
        || state.type !== "markdown" || !(this.getContainer() instanceof WorkspaceWindow)) return state;
      return { ...state, state: { ...state.state, [STICKY_VIEW_STATE_KEY]: true } };
    }

    function setViewState(this: WorkspaceLeaf, state: ViewState, ephemeralState?: unknown): Promise<void> {
      if (active && this.view?.app === app && state.type === "markdown"
        && state.state?.[STICKY_VIEW_STATE_KEY] === true) stickyLeaves.add(this);
      return originalSetViewState.call(this, state, ephemeralState);
    }

    // Obsidian's MarkdownView ignores additional state keys. Intercept the
    // public leaf methods so the marker survives view creation and is included
    // in the workspace file that Obsidian saves on main-window shutdown.
    WorkspaceLeaf.prototype.getViewState = getViewState;
    WorkspaceLeaf.prototype.setViewState = setViewState;
    this.register(() => {
      active = false;
      // Another plugin may have wrapped these methods after us. In that case,
      // leave its wrapper in place and make our retained wrapper pass through.
      if (WorkspaceLeaf.prototype.getViewState === getViewState) WorkspaceLeaf.prototype.getViewState = originalGetViewState;
      if (WorkspaceLeaf.prototype.setViewState === setViewState) WorkspaceLeaf.prototype.setViewState = originalSetViewState;
    });
  }

  onunload(): void {
    this.unloading = true;
    this.cancelPendingInitializations();
    const closedLeafIds = new Set<string>();
    if (this.restorationTimer !== null) window.clearTimeout(this.restorationTimer);
    if (this.shortcutRegistrationTimer !== null) window.clearTimeout(this.shortcutRegistrationTimer);
    this.unregisterGlobalToggleShortcut();
    for (const note of [...this.allNotes()]) {
      this.rememberTopLevelPosition(note);
      note.observer?.disconnect();
      // On quit/reload Obsidian owns window teardown. Detaching here can save
      // an empty layout over the windows it needs to restore at the next launch.
      if (!this.quitting) {
        if (note.leafId) closedLeafIds.add(note.leafId);
        note.leaf.detach();
        this.forceCloseWindow(note.window);
      }
    }
    this.notesByPath.clear();
    if (!this.quitting) {
      // Disabling can race a deferred view (or layout readiness), before it is
      // tracked above. Detaching a known Markdown popout closes it through
      // Obsidian's normal window lifecycle without needing a native proxy.
      for (const id of this.settings.stickyNoteLeafIds) {
        if (closedLeafIds.has(id)) continue;
        const leaf = this.app.workspace.getLeafById(id);
        if (leaf?.getContainer() instanceof WorkspaceWindow && leaf.getViewState().type === "markdown") {
          closedLeafIds.add(id);
          leaf.detach();
        }
      }
      const markedLeaves: WorkspaceLeaf[] = [];
      this.app.workspace.iterateAllLeaves((leaf) => {
        const state = leaf.getViewState();
        if (leaf.getContainer() instanceof WorkspaceWindow && state.type === "markdown"
          && state.state?.[STICKY_VIEW_STATE_KEY] === true) markedLeaves.push(leaf);
      });
      for (const leaf of markedLeaves) {
        const id = this.workspaceLeafId(leaf);
        if (id) closedLeafIds.add(id);
        leaf.detach();
      }
      // Keep identities for windows that have not arrived yet; if the plugin
      // is re-enabled after startup, it must still be able to recognize them.
      this.settings.stickyNoteLeafIds = this.settings.stickyNoteLeafIds.filter((id) => !closedLeafIds.has(id));
      void this.saveSettings();
      void this.app.workspace.requestSaveLayout();
    }
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData() ?? {}) as StoredStickyNoteSettings;
    const defaults = createDefaultSettings();
    const globalToggleShortcuts = { ...defaults.globalToggleShortcuts };
    const storedShortcuts = stored.globalToggleShortcuts;

    for (const platform of Object.keys(globalToggleShortcuts) as DesktopPlatform[]) {
      const accelerator = storedShortcuts?.[platform];
      if (typeof accelerator === "string") globalToggleShortcuts[platform] = accelerator;
    }

    const hasCurrentPlatformShortcut = Object.prototype.hasOwnProperty.call(storedShortcuts ?? {}, CURRENT_PLATFORM);
    if (!hasCurrentPlatformShortcut && typeof stored.globalToggleShortcut === "string") {
      globalToggleShortcuts[CURRENT_PLATFORM] = normalizeAcceleratorForPlatform(stored.globalToggleShortcut);
    }

    this.settings = {
      defaultFolder: stored.defaultFolder ?? defaults.defaultFolder,
      defaultNoteColor: stored.defaultNoteColor ?? defaults.defaultNoteColor,
      enableCollapsibleNotes: stored.enableCollapsibleNotes ?? defaults.enableCollapsibleNotes,
      globalToggleShortcuts,
      topLevelNotePath: stored.topLevelNotePath ?? defaults.topLevelNotePath,
      topLevelWindowPosition: stored.topLevelWindowPosition ?? defaults.topLevelWindowPosition,
      colorsByPath: stored.colorsByPath ?? defaults.colorsByPath,
      stickyNoteLeafIds: Array.isArray(stored.stickyNoteLeafIds)
        ? [...new Set(stored.stickyNoteLeafIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
        : []
    };

    if (Object.prototype.hasOwnProperty.call(stored, "globalToggleShortcut")) {
      await this.saveSettings();
    }
  }

  saveSettings(): Promise<void> {
    // Serialize settings writes so a slow earlier save cannot overwrite a new
    // color or close. Reload awaits a final save behind all outstanding writes.
    const saving = this.settingsSave
      ? this.settingsSave.catch(() => {}).then(() => this.saveData(this.settings))
      : this.saveData(this.settings);
    this.settingsSave = saving;
    const clear = () => { if (this.settingsSave === saving) this.settingsSave = null; };
    void saving.then(clear, clear);
    return saving;
  }

  scheduleGlobalShortcutRegistration(): void {
    if (this.shortcutRegistrationTimer !== null) window.clearTimeout(this.shortcutRegistrationTimer);
    this.shortcutRegistrationTimer = window.setTimeout(() => {
      this.shortcutRegistrationTimer = null;
      this.registerGlobalToggleShortcut(true);
    }, 500);
  }

  beginGlobalShortcutRecording(): void {
    if (this.shortcutRegistrationTimer !== null) {
      window.clearTimeout(this.shortcutRegistrationTimer);
      this.shortcutRegistrationTimer = null;
    }
    this.unregisterGlobalToggleShortcut();
  }

  cancelGlobalShortcutRecording(): void {
    this.registerGlobalToggleShortcut();
  }

  async setGlobalToggleShortcut(accelerator: string): Promise<void> {
    this.settings.globalToggleShortcuts[CURRENT_PLATFORM] = accelerator;
    await this.saveSettings();
    this.registerGlobalToggleShortcut(true);
  }

  getGlobalToggleShortcut(): string {
    return this.settings.globalToggleShortcuts[CURRENT_PLATFORM];
  }

  private registerGlobalToggleShortcut(showResult = false): void {
    this.unregisterGlobalToggleShortcut();
    const accelerator = this.getGlobalToggleShortcut().trim();
    if (!accelerator) {
      if (showResult) new Notice("Global sticky-note shortcut disabled.");
      return;
    }

    try {
      // Reclaim this configured accelerator after an Obsidian renderer reload,
      // where an older remote callback can otherwise remain registered.
      if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);
      const registered = globalShortcut.register(accelerator, () => void this.toggleTopLevelNote());
      if (!registered) {
        new Notice(`Could not register global shortcut: ${displayAccelerator(accelerator)}`);
        return;
      }
      this.registeredGlobalShortcut = accelerator;
      if (showResult) new Notice(`Global sticky-note shortcut: ${displayAccelerator(accelerator)}`);
    } catch {
      new Notice(`Invalid global shortcut: ${displayAccelerator(accelerator)}`);
    }
  }

  private unregisterGlobalToggleShortcut(): void {
    const accelerator = this.registeredGlobalShortcut;
    if (!accelerator) return;
    if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);
    this.registeredGlobalShortcut = null;
  }

  private registerCommands(): void {
    this.addCommand({
      id: "create-sticky-note",
      name: "Create sticky note",
      callback: () => void this.createStickyNote()
    });
    this.addCommand({
      id: "open-sticky-note",
      name: "Open sticky note for current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) void this.openStickyNote(file);
        return true;
      }
    });
    this.addCommand({
      id: "hide-sticky-note",
      name: "Hide sticky note for current file",
      checkCallback: (checking) => {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile || !this.stickyLeavesForPath(activeFile.path).length) return false;
        if (!checking && activeFile) this.closeNotesForPath(activeFile.path);
        return true;
      }
    });
    this.addCommand({
      id: "set-top-level-sticky-note",
      name: "Set current file as top-level sticky note",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) void this.setTopLevelNote(file.path);
        return true;
      }
    });
    this.addCommand({
      id: "toggle-top-level-sticky-note",
      name: "Toggle top-level sticky note",
      callback: () => void this.toggleTopLevelNote()
    });
  }

  private registerContextMenu(): void {
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile)) return;
      menu.addItem((item) => item
        .setTitle("Open as sticky note")
        .setIcon("sticky-note")
        .onClick(() => void this.openStickyNote(file)));
      menu.addItem((item) => item
        .setTitle("Set as top-level sticky note")
        .setIcon("star")
        .onClick(() => void this.setTopLevelNote(file.path)));
    }));
  }

  private registerFileLifecycle(): void {
    this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => {
      if (!(file instanceof TFile)) return;
      this.closeNotesForPath(file.path);
      if (this.settings.topLevelNotePath === file.path) {
        this.settings.topLevelNotePath = null;
        void this.saveSettings();
      }
      delete this.settings.colorsByPath[file.path];
      void this.saveSettings();
    }));

    this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
      if (!(file instanceof TFile)) return;
      const notes = this.notesByPath.get(oldPath);
      if (notes) {
        this.notesByPath.delete(oldPath);
        this.notesByPath.set(file.path, notes);
        for (const note of notes) note.file = file;
      }
      if (this.settings.topLevelNotePath === oldPath) this.settings.topLevelNotePath = file.path;
      const color = this.settings.colorsByPath[oldPath];
      if (color) {
        delete this.settings.colorsByPath[oldPath];
        this.settings.colorsByPath[file.path] = color;
      }
      void this.saveSettings();
    }));
  }

  async createStickyNote(): Promise<void> {
    const folder = this.normalizeFolder(this.settings.defaultFolder);
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }
    const prefix = folder ? `${folder}/` : "";
    const file = await this.app.vault.create(`${prefix}${this.uniqueNoteName()}.md`, "");
    await this.openStickyNote(file);
  }

  async toggleTopLevelNote(): Promise<void> {
    if (this.toggleInProgress || this.reloading || this.unloading || this.quitting || !this.app.workspace.layoutReady) return;
    this.toggleInProgress = true;
    try {
      await this.performTopLevelToggle();
    } finally {
      this.toggleInProgress = false;
    }
  }

  private async performTopLevelToggle(): Promise<void> {
    const path = this.settings.topLevelNotePath;
    if (!path) return;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.settings.topLevelNotePath = null;
      await this.saveSettings();
      return;
    }
    const collectWindows = () => {
      const nativeWindows = this.nativeNoteWindowsForPath(path);
      const trackedWindows = [...(this.notesByPath.get(path) ?? [])]
        .map((note) => note.window)
        .filter((window) => !window.isDestroyed());
      return [...new Set([...nativeWindows, ...trackedWindows])];
    };
    let knownWindows = collectWindows();
    if (!knownWindows.length) {
      // A restoring window has a temporary title and is not tracked yet. Wait
      // before opening a replacement, but never block an already usable note.
      this.restoreStickyNotes();
      const pending = [...this.initializingLeaves.values()]
        .filter((initialization) => initialization.path === path)
        .map((initialization) => initialization.ready);
      let initialized = true;
      if (pending.length) {
        let timeout: number | undefined;
        try {
          // A deferred view may never finish loading. Keep the wait bounded
          // without creating a duplicate while its popout still exists.
          initialized = await Promise.race([
            Promise.all(pending).then((results) => results.every(Boolean)),
            new Promise<boolean>((resolve) => {
              timeout = window.setTimeout(() => resolve(false), TOGGLE_INITIALIZATION_WAIT);
            })
          ]);
        } finally {
          if (timeout !== undefined) window.clearTimeout(timeout);
        }
        if (this.unloading || this.quitting || this.settings.topLevelNotePath !== path) return;
      }
      knownWindows = collectWindows();
      if (!initialized && !knownWindows.length) return;
    }

    if (knownWindows.some((window) => window.isFocused())) {
      // Do not detach the WorkspaceLeaf here. Obsidian responds to an explicit
      // detach by activating its main workspace window. Closing the independent
      // native popout lets its normal unload lifecycle remove the leaf without
      // asking Obsidian to focus a replacement first.
      for (const note of [...(this.notesByPath.get(path) ?? [])]) {
        this.rememberTopLevelPosition(note);
        this.forgetStickyNote(note);
        // Obsidian may replace the view before beforeunload fires, so its
        // document/ownership checks cannot reliably untrack a native close.
        this.untrackNote(note);
      }
      for (const nativeWindow of knownWindows) {
        try {
          if (!nativeWindow.isDestroyed()) nativeWindow.setParentWindow(null);
        } catch {
          // The popout can disappear while the command is collecting windows.
        }
        this.forceCloseWindow(nativeWindow);
      }
      window.setTimeout(() => void this.app.workspace.requestSaveLayout(), 100);
      return;
    }

    if (knownWindows.length) {
      this.bringWindowToFront(knownWindows[0]);
      return;
    }

    await this.openStickyNote(file);
  }

  private bringWindowToFront(nativeWindow: NativeBrowserWindow): void {
    if (nativeWindow.isDestroyed()) return;
    if (nativeWindow.isMinimized()) nativeWindow.restore();
    if (!nativeWindow.isVisible()) nativeWindow.show();
    nativeWindow.moveTop();
    nativeWindow.focus();
  }

  async setCollapsibleNotesEnabled(enabled: boolean): Promise<void> {
    this.settings.enableCollapsibleNotes = enabled;
    await this.saveSettings();
    // Turning the feature off removes the only control that can restore a
    // collapsed window, so no note may stay collapsed without it.
    if (!enabled) {
      for (const note of this.allNotes()) {
        try {
          // Resizing is restored first so that it does not depend on the expand
          // below: a window left at a fixed size has no control to unlock it.
          if (!note.window.isDestroyed()) note.window.setResizable(true);
          this.expandNote(note);
        } catch {
          // The remote proxy becomes invalid as soon as a window closes. One
          // unusable window must not leave the remaining notes collapsed.
        }
      }
    }
    this.scheduleRefreshAllNotes();
  }

  async setTopLevelNote(path: string | null): Promise<void> {
    this.settings.topLevelNotePath = path;
    await this.saveSettings();
    this.scheduleRefreshAllNotes();
    new Notice(path ? `Top-level sticky note: ${path}` : "Top-level sticky note cleared.");
  }

  async openStickyNote(file: TFile): Promise<void> {
    if (this.reloading || this.unloading || this.quitting) return;
    const savedPosition = file.path === this.settings.topLevelNotePath
      ? this.settings.topLevelWindowPosition
      : null;
    const initialPosition = savedPosition && this.positionIsVisible(savedPosition)
      ? savedPosition
      : null;
    const leaf = this.app.workspace.openPopoutLeaf({
      size: { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT },
      ...(initialPosition ? { x: initialPosition.x, y: initialPosition.y } : {})
    });
    // Layout events can also try to restore a newly saved identity while the
    // opening command waits for Electron. Only one lookup may own its title.
    const finishInitialization = this.beginLeafInitialization(leaf, file.path);
    try {
      await leaf.openFile(file, { active: true });
      await this.initializeStickyLeaf(file, leaf);
    } finally {
      finishInitialization(this.initializedLeaves.has(leaf));
      this.restoreStickyNotes();
    }
  }

  private async initializeStickyLeaf(file: TFile, leaf: WorkspaceLeaf, detachOnFailure = true, restoredLeafId?: string): Promise<boolean> {
    if (this.unloading || this.quitting || this.initializedLeaves.has(leaf) || this.closingLeaves.has(leaf)) return false;

    // Restoration already resolved this leaf through getLeafById. Keep that
    // identity even if the layout snapshot is temporarily incomplete.
    const leafId = restoredLeafId ?? this.workspaceLeafId(leaf);
    this.stickyStateLeaves.add(leaf);
    // Save before waiting for native/DOM readiness so a main-window shutdown
    // cannot erase the identity of a newly opened popout.
    if (leafId) this.rememberStickyLeafId(leafId);

    // During restoration a view can still be attached to the main document.
    // The public workspace window identifies the actual popout document.
    const container = leaf.getContainer();
    if (!(container instanceof WorkspaceWindow)) return false;
    const document = container.doc;
    if (!document || document === this.app.workspace.containerEl.ownerDocument) return false;
    const domWindow = document.defaultView;
    if (!domWindow) {
      if (detachOnFailure) {
        leaf.detach();
        new Notice("Could not access the sticky-note document.");
      }
      return false;
    }
    this.watchLeafClosure(leaf, domWindow, leafId);
    const browserWindow = await this.nativeWindowForDocument(document, leaf);
    // A lookup can outlive the popout or a move back into the main workspace.
    // Recheck ownership before applying sticky styling to either document.
    if (this.unloading || this.quitting || domWindow.closed
      || this.initializedLeaves.has(leaf) || this.closingLeaves.has(leaf)
      || !(leaf.getContainer() instanceof WorkspaceWindow)
      || leaf.view.containerEl.ownerDocument !== document
      || (leafId && this.app.workspace.getLeafById(leafId) !== leaf)) return false;
    if (!browserWindow) {
      if (detachOnFailure) {
        if (leafId) this.forgetStickyLeafId(leafId);
        leaf.detach();
        new Notice("Could not create the sticky-note window.");
      }
      return false;
    }

    const note: StickyNoteWindow = { file, leaf, leafId, document, window: browserWindow, isCollapsed: false };
    this.initializedLeaves.add(leaf);
    this.trackNote(note);
    try {
      this.prepareWindow(note);
      this.watchWindow(note, domWindow);
    } catch (error) {
      // A native proxy can disappear partway through setup. Do not leave the
      // leaf marked initialized with missing controls; restoration may retry.
      this.untrackNote(note);
      throw error;
    }
    void this.app.workspace.requestSaveLayout();
    return true;
  }

  private beginLeafInitialization(leaf: WorkspaceLeaf, path: string | null): (initialized: boolean) => void {
    let resolveReady!: (initialized: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { resolveReady = resolve; });
    const initialization: PendingStickyNoteInitialization = {
      path,
      ready,
      finish: (initialized) => {
        if (this.initializingLeaves.get(leaf) === initialization) this.initializingLeaves.delete(leaf);
        resolveReady(initialized);
      }
    };
    this.initializingLeaves.set(leaf, initialization);
    // Deferred views need closure detection before loadIfDeferred settles.
    const container = leaf.getContainer();
    const domWindow = container instanceof WorkspaceWindow ? container.win : null;
    if (domWindow) this.watchLeafClosure(leaf, domWindow);
    return initialization.finish;
  }

  private cancelPendingInitializations(): void {
    for (const initialization of this.initializingLeaves.values()) initialization.finish(false);
  }

  private watchLeafClosure(leaf: WorkspaceLeaf, domWindow: Window, knownId?: string | null): void {
    this.stickySessionActive = true;
    const leaves = this.leavesByWindow.get(domWindow) ?? new Map<WorkspaceLeaf, string | null>();
    leaves.set(leaf, knownId ?? this.workspaceLeafId(leaf) ?? leaves.get(leaf) ?? null);
    this.leavesByWindow.set(domWindow, leaves);
    if (this.watchedLeafWindows.get(leaf) === domWindow) return;
    this.watchedLeafWindows.set(leaf, domWindow);
    this.registerDomEvent(domWindow, "beforeunload", () => {
      // Register before discovery: closed stays false during beforeunload.
      // A leaf moved elsewhere must not inherit its former window's shutdown.
      const container = leaf.getContainer();
      if (!(container instanceof WorkspaceWindow) || container.win !== domWindow) return;
      this.closingLeaves.add(leaf);
      this.initializingLeaves.get(leaf)?.finish(false);
      for (const note of this.allNotes()) {
        if (note.leaf !== leaf) continue;
        this.rememberTopLevelPosition(note);
        this.untrackNote(note);
        break;
      }
    });
  }

  private nativeWindowsWithTitle(title: string): NativeBrowserWindow[] {
    try {
      return (BrowserWindow.getAllWindows() as unknown as NativeBrowserWindow[])
        .filter((candidate) => {
          try {
            return !candidate.isDestroyed() && candidate.getTitle() === title;
          } catch {
            // A window can close while its remote proxy is being inspected.
            return false;
          }
        });
    } catch {
      // Electron's window registry may not be available during startup.
      return [];
    }
  }

  private async nativeWindowForDocument(document: Document, leaf: WorkspaceLeaf): Promise<NativeBrowserWindow | null> {
    // Popout DOM windows do not expose webContents. Match a unique title, but
    // leave it in place across turns: DOM-to-Electron title propagation and
    // native window registration can lag behind Obsidian's layout-ready event.
    const marker = `desktop-sticky-note-${crypto.randomUUID()}`;
    const previousTitle = document.title;
    try {
      for (let attempt = 0; attempt < NATIVE_WINDOW_LOOKUP_ATTEMPTS; attempt++) {
        const container = leaf.getContainer();
        if (this.unloading || this.quitting || !document.defaultView || document.defaultView.closed
          || this.closingLeaves.has(leaf) || !(container instanceof WorkspaceWindow)
          || container.doc !== document) return null;
        // Let Obsidian adopt the restored editor into this document before
        // looking up its native window or installing controls.
        if (leaf.view.containerEl.ownerDocument === document) {
          if (document.title !== marker) document.title = marker;
          const nativeWindow = this.nativeWindowsWithTitle(marker)[0];
          if (nativeWindow) return nativeWindow;
        }
        if (attempt + 1 < NATIVE_WINDOW_LOOKUP_ATTEMPTS) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, NATIVE_WINDOW_LOOKUP_INTERVAL));
        }
      }
      return null;
    } finally {
      // Obsidian may have set a newer title while the lookup was pending.
      if (document.title === marker) document.title = previousTitle;
    }
  }

  private workspaceLeafId(leaf: WorkspaceLeaf): string | null {
    // Obsidian exposes an ID on live leaves, but omits it from the public
    // typings. Validate it with the public lookup before trusting it. A new
    // popout may not appear in a serialized layout snapshot immediately.
    const liveId = (leaf as WorkspaceLeaf & { id?: unknown }).id;
    if (typeof liveId === "string" && liveId && this.app.workspace.getLeafById(liveId) === leaf) return liveId;

    // Keep a layout fallback for versions that do not expose the runtime ID.
    const findId = (value: unknown): string | null => {
      if (!value || typeof value !== "object") return null;
      const item = value as Record<string, unknown>;
      if (item.type === "leaf" && typeof item.id === "string"
        && this.app.workspace.getLeafById(item.id) === leaf) return item.id;
      for (const child of Object.values(item)) {
        const id = findId(child);
        if (id) return id;
      }
      return null;
    };
    try {
      return findId(this.app.workspace.getLayout());
    } catch {
      // Identity is needed for persistence, not for displaying the note. A
      // later presentation refresh can retry while the workspace settles.
      return null;
    }
  }

  private restoreStickyNotes(): void {
    if (this.unloading || this.quitting) return;
    // With no legacy IDs, the first scan cannot tell whether marked popouts
    // have all arrived. Keep discovery bounded to the same startup retry window.
    let pending = this.discoveringRestoredLeaves;
    const candidates = new Map<WorkspaceLeaf, string | null>();
    for (const id of this.settings.stickyNoteLeafIds) {
      const leaf = this.app.workspace.getLeafById(id);
      if (!leaf) {
        pending = true;
        continue;
      }
      candidates.set(leaf, id);
    }
    // A window must remain recognizable if plugin data was not flushed at
    // shutdown or Obsidian restored it with a different ID. Its own workspace
    // state is authoritative; legacy IDs remain a migration fallback.
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.getViewState().state?.[STICKY_VIEW_STATE_KEY] === true && !candidates.has(leaf)) {
        candidates.set(leaf, this.workspaceLeafId(leaf));
      }
    });
    for (const [leaf, id] of candidates) {
      const container = leaf.getContainer();
      if (!(container instanceof WorkspaceWindow) || leaf.getViewState().type !== "markdown"
        || this.closingLeaves.has(leaf)) continue;
      this.stickyStateLeaves.add(leaf);
      if (container.win) this.watchLeafClosure(leaf, container.win, id);
      if (!this.app.workspace.layoutReady || this.initializedLeaves.has(leaf)) continue;
      pending = true;
      if (this.initializingLeaves.has(leaf)) continue;
      void this.restoreStickyLeaf(id, leaf);
    }
    if (!this.app.workspace.layoutReady) return;
    this.saveClosedWindowLayout();
    // Layout readiness does not guarantee that all floating leaves or native
    // windows exist yet. Retry briefly even when no further layout event fires;
    // stop polling absent identities instead of retaining an interval forever.
    if (pending && this.restorationTimer === null && this.restorationRetries < RESTORATION_RETRY_LIMIT) {
      this.restorationTimer = window.setTimeout(() => {
        this.restorationTimer = null;
        this.restorationRetries++;
        if (this.restorationRetries >= RESTORATION_RETRY_LIMIT) this.discoveringRestoredLeaves = false;
        this.restoreStickyNotes();
      }, RESTORATION_RETRY_INTERVAL);
    } else if (!pending) {
      if (this.restorationTimer !== null) window.clearTimeout(this.restorationTimer);
      this.restorationTimer = null;
      this.restorationRetries = 0;
    }
  }

  private async restoreStickyLeaf(id: string | null, leaf: WorkspaceLeaf): Promise<void> {
    const path: unknown = leaf.getViewState().state?.file;
    const finishInitialization = this.beginLeafInitialization(leaf, typeof path === "string" ? path : null);
    try {
      // Obsidian 1.7.2+ may restore a placeholder before constructing the view.
      // Only load known sticky leaves; other background tabs stay deferred.
      if (requireApiVersion("1.7.2") && leaf.isDeferred) await leaf.loadIfDeferred();
      if (this.unloading || this.quitting || (id && this.app.workspace.getLeafById(id) !== leaf)
        || !(leaf.getContainer() instanceof WorkspaceWindow)) return;
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) await this.initializeStickyLeaf(view.file, leaf, false, id ?? undefined);
    } catch {
      // A popout can close while its deferred view loads. Leave the user's
      // layout intact; scheduled retries can recover a surviving window.
    } finally {
      finishInitialization(this.initializedLeaves.has(leaf));
    }
  }

  private forgetStickyNote(note: StickyNoteWindow): void {
    this.stickyStateLeaves.delete(note.leaf);
    if (!note.leafId) return;
    this.forgetStickyLeafId(note.leafId);
  }

  private forgetStickyLeafId(leafId: string): void {
    const leaf = this.app.workspace.getLeafById(leafId);
    if (leaf) this.stickyStateLeaves.delete(leaf);
    this.settings.stickyNoteLeafIds = this.settings.stickyNoteLeafIds.filter((id) => id !== leafId);
    void this.saveSettings();
  }

  private prepareWindow(note: StickyNoteWindow): void {
    if (this.unloading || this.quitting || !this.initializedLeaves.has(note.leaf) || note.window.isDestroyed()) return;
    if (note.leaf.view.containerEl.ownerDocument !== note.document) return;
    const { document, window } = note;
    const nativeTitle = this.nativeNoteWindowTitle(note.file);
    const domWindow = document.defaultView;
    if (domWindow) domWindow.name = this.windowNameForPath(note.file.path);
    document.documentElement.dataset.desktopStickyNoteWindow = "true";
    document.documentElement.dataset.desktopStickyNotePath = note.file.path;
    document.title = nativeTitle;
    window.setTitle(nativeTitle);
    document.body.classList.add("desktop-sticky-note");
    this.applyCollapseClasses(note);
    document.querySelector(".workspace-tab-header-container")?.remove();
    this.applyColor(note, this.noteColor(note.file.path), false);
    this.configureWindowOwnership(note);
    // The setting gates the collapsed branch as well: a note that is still
    // collapsed after the feature was switched off has no control left to
    // expand it, so its window must at least become resizable again.
    if (note.isCollapsed && this.settings.enableCollapsibleNotes) {
      this.syncCollapsedHeight(note);
    } else {
      window.setResizable(true);
    }
    this.addStickyActions(note);
    this.observePresentation(note);
    this.rememberStickyNote(note);
  }

  private rememberStickyNote(note: StickyNoteWindow): void {
    const leafId = note.leafId ?? this.workspaceLeafId(note.leaf);
    if (!leafId) return;
    note.leafId = leafId;
    const domWindow = this.watchedLeafWindows.get(note.leaf);
    if (domWindow) this.leavesByWindow.get(domWindow)?.set(note.leaf, leafId);
    this.rememberStickyLeafId(leafId);
  }

  private rememberStickyLeafId(leafId: string): void {
    if (this.settings.stickyNoteLeafIds.includes(leafId)) return;
    // Keep IDs, not file paths: the same file can also be open in ordinary
    // windows. Missing IDs may belong to popouts still being restored, so
    // remove an ID only when a note is explicitly hidden or the plugin disabled.
    this.settings.stickyNoteLeafIds.push(leafId);
    void this.saveSettings();
  }

  private watchWindow(note: StickyNoteWindow, domWindow: Window): void {
    const restore = () => this.scheduleRefreshNote(note);
    this.registerDomEvent(domWindow, "focus", restore);
    this.registerDomEvent(domWindow, "blur", restore);
  }

  private scheduleRefreshNote(note: StickyNoteWindow): void {
    // Obsidian performs some focus/layout work after its events fire, so run
    // once immediately and once after that update has settled.
    window.setTimeout(() => this.prepareWindow(note), 0);
    window.setTimeout(() => this.prepareWindow(note), 75);
  }

  private scheduleRefreshAllNotes(): void {
    for (const note of this.allNotes()) this.scheduleRefreshNote(note);
  }

  private nativeMainWindow(): NativeBrowserWindow | null {
    const mainDocument = this.app.workspace.containerEl.ownerDocument;
    const previousTitle = mainDocument.title;
    const marker = `desktop-sticky-notes-main-${crypto.randomUUID()}`;
    mainDocument.title = marker;
    const mainWindow = this.nativeWindowsWithTitle(marker)[0] ?? null;
    mainDocument.title = previousTitle;
    return mainWindow;
  }

  private observePresentation(note: StickyNoteWindow): void {
    if (note.observer) return;
    let refreshScheduled = false;
    note.observer = new MutationObserver(() => {
      if (refreshScheduled || this.presentationIsIntact(note)) return;
      refreshScheduled = true;
      window.setTimeout(() => {
        refreshScheduled = false;
        this.prepareWindow(note);
      }, 0);
    });
    note.observer.observe(note.document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: ["class", "style"]
    });
  }

  private presentationIsIntact(note: StickyNoteWindow): boolean {
    const { document } = note;
    const actions = note.leaf.view.containerEl.querySelector(".view-actions");
    const expectedColor = this.noteColor(note.file.path);
    return document.body.classList.contains("desktop-sticky-note")
      && document.defaultView?.name === this.windowNameForPath(note.file.path)
      && document.documentElement.dataset.desktopStickyNoteWindow === "true"
      && document.documentElement.dataset.desktopStickyNotePath === note.file.path
      && document.title === this.nativeNoteWindowTitle(note.file)
      && document.documentElement.style.getPropertyValue("--background-primary") === expectedColor
      && document.body.style.getPropertyValue("--sticky-note-background") === expectedColor
      && !document.querySelector(".workspace-tab-header-container")
      && !!this.findStickyActions(actions);
  }

  private addStickyActions(note: StickyNoteWindow): void {
    const view = note.leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const actions = view.containerEl.querySelector(".view-actions");
    if (!actions) return;
    // prepareWindow() also runs when a click focuses an inactive note, that is
    // between the mousedown and the mouseup of that click. Rebuilding the
    // buttons then replaces the pressed button, so no click event fires and the
    // first click on an inactive note is lost. Buttons that are still present
    // are updated in place instead, and the bar is only rebuilt without them.
    const existing = this.findStickyActions(actions);
    if (existing) {
      this.updateStickyActions(note, view, actions, existing);
      return;
    }
    actions.empty();

    if (this.settings.enableCollapsibleNotes) {
      const collapse = view.addAction("chevron-down", "Collapse sticky note", () => {
        this.toggleCollapsed(note);
        this.updateCollapseButton(collapse, note.isCollapsed);
      });
      collapse.addClass("desktop-sticky-note-collapse");
      // A rebuilt bar starts from the tracked state, like the in-place update.
      this.updateCollapseButton(collapse, note.isCollapsed);
    }

    const pin = view.addAction("pin", "Keep on top", () => {
      const pinned = !note.window.isAlwaysOnTop();
      // A child window's stacking is constrained by its application parent on
      // some window managers. Promote it to a native top-level window before
      // enabling the OS-wide always-on-top state.
      if (pinned) note.window.setParentWindow(null);
      note.window.setAlwaysOnTop(pinned);
      this.configureWindowOwnership(note);
      if (pinned) note.window.moveTop();
      this.updatePinButton(pin, note.window.isAlwaysOnTop());
    });
    pin.addClass("desktop-sticky-note-pin");
    this.updatePinButton(pin, note.window.isAlwaysOnTop());

    const colorPicker = actions.createEl("input", {
      cls: "desktop-sticky-note-color-picker",
      attr: {
        type: "color",
        value: this.noteColor(note.file.path),
        "aria-label": "Choose sticky-note background color",
        title: "Choose background color"
      }
    });
    if (colorPicker instanceof HTMLInputElement) {
      this.registerDomEvent(colorPicker, "input", () => this.applyColor(note, colorPicker.value));
      this.registerDomEvent(colorPicker, "click", (event) => event.stopPropagation());
    }
    const mode = view.addAction("pencil", "Switch to edit mode", () => {
      const nextMode = view.getMode() === "source" ? "preview" : "source";
      void view.setState({ mode: nextMode }, { history: false });
      this.updateModeButton(mode, nextMode);
    });
    mode.addClass("desktop-sticky-note-mode");
    this.updateModeButton(mode, view.getMode());
    view.addAction("x", "Hide sticky note", () => this.hideNote(note))
      .addClass("desktop-sticky-note-hide");
  }

  private toggleCollapsed(note: StickyNoteWindow): void {
    if (note.isCollapsed) {
      this.expandNote(note);
    } else {
      this.collapseNote(note);
    }
  }

  private collapseNote(note: StickyNoteWindow): void {
    const { window } = note;
    // The setting is re-checked here because saving it is asynchronous: a
    // button rendered before the change can still be clicked in the meantime.
    if (window.isDestroyed() || note.isCollapsed || !this.settings.enableCollapsibleNotes) return;
    const [width, height] = window.getContentSize();
    note.expandedSize = { width, height };
    note.isCollapsed = true;
    // The collapsed styling is applied before the header is measured so that
    // the measurement is the height the header will actually be drawn at: in an
    // expanded window the note body can squeeze the header below that height.
    this.applyCollapseClasses(note);
    // Without a measurement there is no height to collapse to. Guessing one
    // could hide part of the header, and the window would then be locked at a
    // size its controls do not fit into.
    const collapsedHeight = this.collapsedHeight(note);
    if (collapsedHeight === null) {
      this.abandonCollapse(note);
      return;
    }
    // Resize first: a non-resizable window ignores size changes on some
    // platforms, so the window must still be resizable while it shrinks.
    window.setContentSize(width, collapsedHeight);
    // Programmatic resizing is not honored everywhere, notably under native
    // Wayland, so the new size is read back before the note is committed to a
    // collapsed state its window never entered.
    if (!this.contentHeightReached(window, collapsedHeight)) {
      // A window manager may clamp the request and apply part of it, so the
      // window is put back before the recorded size is dropped. Restoring is
      // harmless where the resize was ignored outright.
      window.setContentSize(width, height);
      this.abandonCollapse(note);
      return;
    }
    // A collapsed window must not be dragged to a new height, which would
    // silently replace the height that expanding is supposed to restore.
    window.setResizable(false);
  }

  private abandonCollapse(note: StickyNoteWindow): void {
    // Returns the note to the expanded state it never left. The window was not
    // made fixed-size yet, so only the tracked state has to be undone. Both
    // ways of failing to collapse report the same way: from the outside the
    // window simply did not collapse.
    note.isCollapsed = false;
    delete note.expandedSize;
    this.applyCollapseClasses(note);
    new Notice("Collapsing is not supported by this window manager.");
  }

  private expandNote(note: StickyNoteWindow): void {
    const { window } = note;
    // Collapsing always records the expanded size, so a collapsed note without
    // one is an inconsistent state rather than a case to guess a size for.
    if (window.isDestroyed() || !note.isCollapsed || !note.expandedSize) return;
    const { width, height } = note.expandedSize;
    // The note is moved to the expanded state before the window is touched. A
    // remote call that throws would otherwise leave a note reporting itself
    // collapsed while nothing on screen can expand it again.
    delete note.expandedSize;
    note.isCollapsed = false;
    this.applyCollapseClasses(note);
    window.setResizable(true);
    window.setContentSize(width, height);
  }

  private applyCollapseClasses(note: StickyNoteWindow): void {
    // A one-way projection of the setting and of note.isCollapsed for
    // stylesheets to hook into. The classes are never read back: Obsidian
    // rebuilds this DOM, so the plugin remains the only source of truth.
    const { classList } = note.document.body;
    classList.toggle("desktop-sticky-note-collapsible", this.settings.enableCollapsibleNotes);
    classList.toggle("desktop-sticky-note-collapsed", note.isCollapsed);
  }

  private syncCollapsedHeight(note: StickyNoteWindow): void {
    const { window } = note;
    const [width, height] = window.getContentSize();
    // The header can become taller or shorter while a note is already collapsed
    // (another theme, an Obsidian setting, a different zoom level), so every
    // refresh re-fits the window instead of trusting the height it collapsed to.
    // An unmeasurable header leaves the window alone: refreshes run on every
    // focus change, and resizing to a guessed height would make the window
    // flicker whenever a theme sizes the header only in some states.
    const collapsedHeight = this.collapsedHeight(note);
    if (collapsedHeight === null || height === collapsedHeight) return;
    // Same order as collapseNote(): a non-resizable window ignores size changes
    // on some platforms, so the window is resizable while it is resized.
    window.setResizable(true);
    window.setContentSize(width, collapsedHeight);
    // The window is collapsed either way, so it must not be left resizable when
    // the re-fit was ignored: dragging it would replace the height that
    // expanding restores.
    window.setResizable(false);
  }

  private contentHeightReached(window: NativeBrowserWindow, expectedHeight: number): boolean {
    // A window manager may round the requested size, so an exact match is not
    // required; a window that ignored the request stays at its old height.
    const [, height] = window.getContentSize();
    return Math.abs(height - expectedHeight) <= 1;
  }

  private collapsedHeight(note: StickyNoteWindow): number | null {
    // Collapsing leaves exactly the note header visible. The header is measured
    // instead of assumed so that a theme, a font size, or anything stacked
    // above the header changes the collapsed height with it.
    // The measurement is in CSS pixels within the web contents, so it can only
    // be applied to the content size: the full window size would additionally
    // contain an OS title bar whenever Obsidian runs with a native frame.
    // Scoped to this note's own view: a popout can be split, and the header of
    // another pane there says nothing about this note's height.
    const header = note.leaf.view.containerEl.querySelector(".view-header");
    const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
    // No usable measurement. Both callers then leave the window as it is: a
    // guessed height could cut off the header the collapsed window consists of.
    // Non-finite values are rejected as well, since NaN passes every comparison
    // and would reach setContentSize() as an undefined height.
    if (!Number.isFinite(headerBottom) || headerBottom <= 0) return null;
    // Content sizes are device-independent pixels, and the zoom factor is
    // exactly the conversion from the CSS pixels the header was measured in.
    // The renderer's own viewport dimensions must not be used for this: right
    // after a resize they can still report the previous size, which would make
    // the window collapse to a few pixels.
    const zoomFactor = note.window.webContents.getZoomFactor();
    const dipsPerCssPixel = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
    return Math.ceil(headerBottom * dipsPerCssPixel);
  }

  private updateCollapseButton(button: HTMLElement, collapsed: boolean): void {
    // Same no-op guard as the other buttons: see updatePinButton().
    if (button.dataset.desktopStickyNoteCollapsed === String(collapsed)) return;
    button.dataset.desktopStickyNoteCollapsed = String(collapsed);
    setIcon(button, collapsed ? "chevron-right" : "chevron-down");
    setTooltip(button, collapsed ? "Expand sticky note" : "Collapse sticky note");
    button.setAttribute("aria-expanded", String(!collapsed));
  }

  // One predicate for both the observer and the refresh: a bar is complete
  // exactly when every control is there, so neither can consider a bar the
  // other would rebuild as intact.
  private findStickyActions(actions: Element | null): StickyActions | null {
    if (!actions) return null;
    const pin = actions.querySelector<HTMLElement>(".desktop-sticky-note-pin");
    const colorPicker = actions.querySelector<HTMLInputElement>(".desktop-sticky-note-color-picker");
    const mode = actions.querySelector<HTMLElement>(".desktop-sticky-note-mode");
    const hide = actions.querySelector<HTMLElement>(".desktop-sticky-note-hide");
    if (!pin || !colorPicker || !mode || !hide) return null;
    // The collapse button follows its setting, so a bar built under the other
    // value is incomplete and gets rebuilt rather than patched.
    const collapse = actions.querySelector<HTMLElement>(".desktop-sticky-note-collapse") ?? undefined;
    if (this.settings.enableCollapsibleNotes !== !!collapse) return null;
    return { pin, colorPicker, mode, hide, collapse };
  }

  private updateStickyActions(note: StickyNoteWindow, view: MarkdownView, actions: Element, buttons: StickyActions): void {
    // The bar holds only the sticky-note controls, exactly as after a rebuild.
    const stickyActions: Element[] = [buttons.pin, buttons.colorPicker, buttons.mode, buttons.hide];
    if (buttons.collapse) stickyActions.push(buttons.collapse);
    for (const child of Array.from(actions.children)) {
      if (!stickyActions.includes(child)) child.remove();
    }
    if (buttons.collapse) this.updateCollapseButton(buttons.collapse, note.isCollapsed);
    this.updatePinButton(buttons.pin, note.window.isAlwaysOnTop());
    buttons.colorPicker.value = this.noteColor(note.file.path);
    this.updateModeButton(buttons.mode, view.getMode());
  }

  // The button updates skip work when nothing changed: setIcon() replaces the
  // icon element, and an in-place refresh during a click must leave the
  // element the mouse went down on in place, or the click is dropped again.
  private updatePinButton(button: HTMLElement, pinned: boolean): void {
    if (button.dataset.desktopStickyNotePinned === String(pinned)) return;
    button.dataset.desktopStickyNotePinned = String(pinned);
    setIcon(button, pinned ? "pin-off" : "pin");
    setTooltip(button, pinned ? "Stop keeping on top" : "Keep on top");
  }

  private configureWindowOwnership(note: StickyNoteWindow): void {
    const { window } = note;
    // Top-level and pinned notes must be independent native windows. A regular
    // unpinned note returns to Obsidian ownership for normal window grouping.
    if (note.file.path === this.settings.topLevelNotePath || window.isAlwaysOnTop()) {
      window.setParentWindow(null);
    } else {
      const mainWindow = this.nativeMainWindow();
      if (mainWindow && mainWindow !== window) window.setParentWindow(mainWindow);
    }
    window.setSkipTaskbar(false);
  }

  private updateModeButton(button: HTMLElement, mode: string): void {
    // Same no-op guard as updatePinButton().
    if (button.dataset.desktopStickyNoteMode === mode) return;
    button.dataset.desktopStickyNoteMode = mode;
    const editing = mode === "source";
    setIcon(button, editing ? "book-open" : "pencil");
    setTooltip(button, editing ? "Switch to reading view" : "Switch to edit mode");
  }

  private applyColor(note: StickyNoteWindow, color: string, persist = true): void {
    const rootStyle = note.document.documentElement.style;
    rootStyle.setProperty("--background-primary", color);
    rootStyle.setProperty("--background-primary-alt", color);
    rootStyle.setProperty("--background-secondary", color);
    rootStyle.setProperty("--background-secondary-alt", color);
    note.document.body.style.setProperty("--sticky-note-background", color);
    if (persist) {
      this.settings.colorsByPath[note.file.path] = color;
      void this.saveSettings();
    }
  }

  private noteColor(path: string): string {
    return this.settings.colorsByPath[path] ?? this.settings.defaultNoteColor;
  }

  private trackNote(note: StickyNoteWindow): void {
    const notes = this.notesByPath.get(note.file.path) ?? new Set<StickyNoteWindow>();
    notes.add(note);
    this.notesByPath.set(note.file.path, notes);
  }

  private untrackNote(note: StickyNoteWindow): void {
    note.observer?.disconnect();
    this.initializedLeaves.delete(note.leaf);
    const notes = this.notesByPath.get(note.file.path);
    if (!notes) return;
    notes.delete(note);
    if (!notes.size) this.notesByPath.delete(note.file.path);
  }

  private closeNotesForPath(path: string): void {
    const notes = [...(this.notesByPath.get(path) ?? [])];
    for (const note of notes) {
      this.rememberTopLevelPosition(note);
      this.clearWindowMarker(note);
      this.untrackNote(note);
      note.leaf.detach();
      this.forceCloseWindow(note.window);
    }
    for (const leaf of this.stickyLeavesForPath(path)) {
      const domWindow = leaf.view.containerEl.ownerDocument.defaultView;
      if (domWindow) domWindow.name = "";
      leaf.detach();
    }
    void this.app.workspace.requestSaveLayout();
  }

  private hideNote(note: StickyNoteWindow): void {
    this.rememberTopLevelPosition(note);
    this.clearWindowMarker(note);
    this.untrackNote(note);
    note.leaf.detach();
    this.forceCloseWindow(note.window);
    void this.app.workspace.requestSaveLayout();
  }

  private clearWindowMarker(note: StickyNoteWindow): void {
    this.forgetStickyNote(note);
    const domWindow = note.document.defaultView;
    if (domWindow) domWindow.name = "";
    delete note.document.documentElement.dataset.desktopStickyNoteWindow;
    delete note.document.documentElement.dataset.desktopStickyNotePath;
  }

  private forceCloseWindow(nativeWindow: NativeBrowserWindow): void {
    try {
      if (!nativeWindow.isDestroyed()) nativeWindow.close();
    } catch {
      // Fall through to the forced-destroy check below.
    }
    window.setTimeout(() => {
      try {
        if (!nativeWindow.isDestroyed()) nativeWindow.destroy();
      } catch {
        // The remote proxy becomes invalid as soon as the window closes.
      }
    }, 50);
  }

  private stickyLeavesForPath(path: string): WorkspaceLeaf[] {
    const stickyLeaves: WorkspaceLeaf[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView) || leaf.view.file?.path !== path) return;
      const document = leaf.view.containerEl.ownerDocument;
      if (document.documentElement.dataset.desktopStickyNoteWindow === "true"
        && document.body.classList.contains("desktop-sticky-note")) {
        stickyLeaves.push(leaf);
      }
    });
    return stickyLeaves;
  }

  private nativeNoteWindowsForPath(path: string): NativeBrowserWindow[] {
    const expectedTitle = this.nativeNoteWindowTitleForPath(path);
    return this.nativeWindowsWithTitle(expectedTitle);
  }

  private rememberTopLevelPosition(note: StickyNoteWindow): void {
    if (note.file.path !== this.settings.topLevelNotePath || note.window.isDestroyed()) return;
    const [x, y] = note.window.getPosition();
    this.settings.topLevelWindowPosition = { x, y };
    void this.saveSettings();
  }

  private positionIsVisible(position: WindowPosition): boolean {
    return screen.getAllDisplays().some((display) => {
      const { x, y, width, height } = display.workArea;
      // Keep the upper-left drag area reachable on at least one display.
      return position.x >= x - 40
        && position.x < x + width - 40
        && position.y >= y
        && position.y < y + height - 30;
    });
  }

  private nativeNoteWindowTitle(file: TFile): string {
    return this.nativeNoteWindowTitleForPath(file.path, file.basename);
  }

  private nativeNoteWindowTitleForPath(path: string, basename?: string): string {
    const label = basename ?? path.split("/").pop()?.replace(/\.md$/, "") ?? "Sticky note";
    // The invisible suffix is a stable, path-specific key shared by every
    // Obsidian renderer without cluttering the visible native window title.
    return `Sticky note — ${label}\u2063${encodeURIComponent(path)}`;
  }

  private windowNameForPath(path: string): string {
    return `${WINDOW_NAME_PREFIX}${encodeURIComponent(path)}`;
  }

  private *allNotes(): Iterable<StickyNoteWindow> {
    for (const notes of this.notesByPath.values()) yield* notes;
  }

  private normalizeFolder(folder: string): string {
    const trimmed = folder.trim().replace(/^\/+|\/+$/g, "");
    return trimmed ? normalizePath(trimmed) : "";
  }

  private uniqueNoteName(): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `Sticky note ${stamp}`;
  }
}

class DesktopStickyNotesSettingTab extends PluginSettingTab {
  private shortcutRecordingCleanup: (() => void) | null = null;

  constructor(app: PluginSettingTab["app"], private plugin: DesktopStickyNotesPlugin) {
    super(app, plugin);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Default folder",
        desc: "Folder for newly created sticky notes. Leave blank for the vault root.",
        render: (setting) => this.addDefaultFolderControl(setting)
      },
      {
        name: "Default note color",
        desc: "Background color used for notes that do not have a saved custom color.",
        render: (setting) => this.addDefaultColorControl(setting)
      },
      {
        name: "Collapsible sticky notes",
        desc: "Adds a collapse button that shrinks a sticky note to its header.",
        render: (setting) => this.addCollapsibleNotesControl(setting)
      },
      {
        name: "Global toggle shortcut",
        desc: "System-wide shortcut for toggling the top-level sticky note. Click the shortcut, press a new combination, or press escape to cancel.",
        render: (setting) => this.addGlobalShortcutControl(setting)
      },
      {
        name: "Top-level sticky note",
        desc: this.plugin.settings.topLevelNotePath ?? "No top-level note selected.",
        render: (setting) => this.addTopLevelNoteControl(setting)
      }
    ];
  }

  display(): void {
    this.stopShortcutRecording(true);
    const { containerEl } = this;
    containerEl.empty();
    this.addDefaultFolderControl(new Setting(containerEl)
      .setName("Default folder")
      .setDesc("Folder for newly created sticky notes. Leave blank for the vault root."));
    this.addDefaultColorControl(new Setting(containerEl)
      .setName("Default note color")
      .setDesc("Background color used for notes that do not have a saved custom color."));
    this.addCollapsibleNotesControl(new Setting(containerEl)
      .setName("Collapsible sticky notes")
      .setDesc("Adds a collapse button that shrinks a sticky note to its header."));
    this.addGlobalShortcutControl(new Setting(containerEl)
      .setName("Global toggle shortcut")
      .setDesc("System-wide shortcut for toggling the top-level sticky note. Click the shortcut, press a new combination, or press escape to cancel."));
    this.addTopLevelNoteControl(new Setting(containerEl)
      .setName("Top-level sticky note")
      .setDesc(this.plugin.settings.topLevelNotePath ?? "No top-level note selected."));
  }

  hide(): void {
    this.stopShortcutRecording(true);
    super.hide();
  }

  private addDefaultFolderControl(setting: Setting): void {
    setting.addText((text) => text
      .setPlaceholder("Vault root")
      .setValue(this.plugin.settings.defaultFolder)
      .onChange(async (value) => {
        this.plugin.settings.defaultFolder = value.trim();
        await this.plugin.saveSettings();
      }));
  }

  private addDefaultColorControl(setting: Setting): void {
    setting.addColorPicker((picker) => picker
      .setValue(this.plugin.settings.defaultNoteColor)
      .onChange(async (value) => {
        this.plugin.settings.defaultNoteColor = value;
        await this.plugin.saveSettings();
      }));
  }

  private addCollapsibleNotesControl(setting: Setting): void {
    setting.addToggle((toggle) => toggle
      .setValue(this.plugin.settings.enableCollapsibleNotes)
      .onChange((value) => void this.plugin.setCollapsibleNotesEnabled(value)));
  }

  private addGlobalShortcutControl(setting: Setting): () => void {
    let recorderButton: HTMLButtonElement;
    let clearButton: HTMLButtonElement;
    setting
      .addButton((button) => {
        button
          .setButtonText(displayAccelerator(this.plugin.getGlobalToggleShortcut()))
          .setTooltip("Record global shortcut")
          .setClass("desktop-sticky-note-shortcut-recorder")
          .onClick(() => {
            if (this.shortcutRecordingCleanup) {
              this.stopShortcutRecording(true);
            } else {
              this.startShortcutRecording(recorderButton, clearButton);
            }
          });
        recorderButton = button.buttonEl;
      })
      .addButton((button) => {
        button
          .setButtonText("Clear")
          .setTooltip("Disable global shortcut")
          .setDisabled(!this.plugin.getGlobalToggleShortcut())
          .onClick(async () => {
            this.stopShortcutRecording(false);
            await this.plugin.setGlobalToggleShortcut("");
            recorderButton.setText("Disabled");
            clearButton.disabled = true;
        });
        clearButton = button.buttonEl;
      });
    return () => this.stopShortcutRecording(true);
  }

  private addTopLevelNoteControl(setting: Setting): void {
    setting.addButton((button) => button
      .setButtonText("Use active file")
      .onClick(() => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("Open a Markdown file first.");
          return;
        }
        void this.plugin.setTopLevelNote(file.path).then(() => this.refresh());
      }))
      .addExtraButton((button) => button
        .setIcon("trash")
        .setTooltip("Clear top-level note")
        .onClick(() => void this.plugin.setTopLevelNote(null).then(() => this.refresh())));
  }

  private refresh(): void {
    const update = (this as { update?: () => void }).update;
    if (update) {
      update.call(this);
    } else {
      (this as unknown as { display: () => void }).display();
    }
  }

  private startShortcutRecording(recorderButton: HTMLButtonElement, clearButton: HTMLButtonElement): void {
    this.stopShortcutRecording(true);
    this.plugin.beginGlobalShortcutRecording();
    const previousLabel = displayAccelerator(this.plugin.getGlobalToggleShortcut());
    recorderButton.setText("Press shortcut…");
    recorderButton.addClass("is-recording");
    clearButton.disabled = true;
    recorderButton.focus();

    const finish = (restoreRegistration: boolean) => {
      const cleanup = this.shortcutRecordingCleanup;
      this.shortcutRecordingCleanup = null;
      cleanup?.();
      recorderButton.removeClass("is-recording");
      if (restoreRegistration) this.plugin.cancelGlobalShortcutRecording();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (event.key === "Escape") {
        finish(true);
        recorderButton.setText(previousLabel);
        clearButton.disabled = !this.plugin.getGlobalToggleShortcut();
        return;
      }
      const accelerator = acceleratorForEvent(event);
      if (!accelerator) return;

      finish(false);
      recorderButton.setText(displayAccelerator(accelerator));
      clearButton.disabled = false;
      void this.plugin.setGlobalToggleShortcut(accelerator);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === recorderButton || recorderButton.contains(event.target as Node)) return;
      finish(true);
      recorderButton.setText(previousLabel);
      clearButton.disabled = !this.plugin.getGlobalToggleShortcut();
    };
    const document = recorderButton.ownerDocument;
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    this.shortcutRecordingCleanup = () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }

  private stopShortcutRecording(restoreRegistration: boolean): void {
    if (!this.shortcutRecordingCleanup) return;
    const cleanup = this.shortcutRecordingCleanup;
    this.shortcutRecordingCleanup = null;
    cleanup();
    if (restoreRegistration) this.plugin.cancelGlobalShortcutRecording();
  }
}
