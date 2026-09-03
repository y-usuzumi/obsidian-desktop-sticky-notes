import { MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, WorkspaceLeaf, normalizePath, setIcon, setTooltip } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { BrowserWindow, globalShortcut, screen } from "@electron/remote";

const DEFAULT_COLOR = "#fff3a3";
const DEFAULT_WIDTH = 360;
const DEFAULT_HEIGHT = 360;
const WINDOW_NAME_PREFIX = "desktop-sticky-notes:";
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

type HeaderSize = "default" | "extra-small" | "small";

// "default" maps to no class so that the default appearance stays exactly the
// stock Obsidian header, with no plugin rule participating in the cascade.
const HEADER_SIZE_CLASSES: Record<HeaderSize, string | null> = {
  "default": null,
  "small": "desktop-sticky-note-header-small",
  "extra-small": "desktop-sticky-note-header-extra-small"
};
const COMPACT_HEADER_CLASS = "desktop-sticky-note-compact";

function isHeaderSize(value: unknown): value is HeaderSize {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(HEADER_SIZE_CLASSES, value);
}

interface StickyNoteSettings {
  defaultFolder: string;
  defaultNoteColor: string;
  headerSize: HeaderSize;
  globalToggleShortcuts: Record<DesktopPlatform, string>;
  topLevelNotePath: string | null;
  topLevelWindowPosition: WindowPosition | null;
  colorsByPath: Record<string, string>;
}

type StoredStickyNoteSettings = Partial<Omit<StickyNoteSettings, "globalToggleShortcuts" | "headerSize">> & {
  // Saved data is user-editable, so a stored header size cannot be trusted to
  // be one of the known values.
  headerSize?: unknown;
  globalToggleShortcut?: unknown;
  globalToggleShortcuts?: Partial<Record<DesktopPlatform, unknown>>;
  openNotePaths?: unknown;
};

interface WindowPosition {
  x: number;
  y: number;
}

function createDefaultSettings(): StickyNoteSettings {
  return {
    defaultFolder: "",
    defaultNoteColor: DEFAULT_COLOR,
    headerSize: "default",
    globalToggleShortcuts: { ...DEFAULT_GLOBAL_SHORTCUTS },
    topLevelNotePath: null,
    topLevelWindowPosition: null,
    colorsByPath: {}
  };
}

interface StickyNoteWindow {
  file: TFile;
  leaf: WorkspaceLeaf;
  document: Document;
  window: NativeBrowserWindow;
  observer?: MutationObserver;
  trafficLightsHidden?: boolean;
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
  // macOS only: the proxy for a window on another platform does not carry it.
  setWindowButtonVisibility?(visible: boolean): void;
}

export default class DesktopStickyNotesPlugin extends Plugin {
  settings: StickyNoteSettings = createDefaultSettings();
  private notesByPath = new Map<string, Set<StickyNoteWindow>>();
  private initializedLeaves = new WeakSet<WorkspaceLeaf>();
  private registeredGlobalShortcut: string | null = null;
  private shortcutRegistrationTimer: number | null = null;
  private toggleInProgress = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.closeStaleStickyWindows();
    this.addSettingTab(new DesktopStickyNotesSettingTab(this.app, this));
    this.registerCommands();
    this.registerFileLifecycle();
    this.registerContextMenu();
    this.registerGlobalToggleShortcut();
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRefreshAllNotes()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.scheduleRefreshAllNotes()));
  }

  onunload(): void {
    if (this.shortcutRegistrationTimer !== null) window.clearTimeout(this.shortcutRegistrationTimer);
    this.unregisterGlobalToggleShortcut();
    for (const note of [...this.allNotes()]) {
      this.rememberTopLevelPosition(note);
      // Restore the traffic lights in case the window outlives the close below.
      this.setTrafficLightsVisible(note, true);
      note.observer?.disconnect();
      note.leaf.detach();
      this.forceCloseWindow(note.window);
    }
    this.notesByPath.clear();
    void this.app.workspace.requestSaveLayout();
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
      headerSize: isHeaderSize(stored.headerSize) ? stored.headerSize : defaults.headerSize,
      globalToggleShortcuts,
      topLevelNotePath: stored.topLevelNotePath ?? defaults.topLevelNotePath,
      topLevelWindowPosition: stored.topLevelWindowPosition ?? defaults.topLevelWindowPosition,
      colorsByPath: stored.colorsByPath ?? defaults.colorsByPath
    };

    if (Object.prototype.hasOwnProperty.call(stored, "globalToggleShortcut")) {
      await this.saveSettings();
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
    if (this.toggleInProgress) return;
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
    const nativeWindows = this.nativeNoteWindowsForPath(path);
    const trackedWindows = [...(this.notesByPath.get(path) ?? [])]
      .map((note) => note.window)
      .filter((window) => !window.isDestroyed());
    const knownWindows = [...new Set([...nativeWindows, ...trackedWindows])];

    if (knownWindows.some((window) => window.isFocused())) {
      // Do not detach the WorkspaceLeaf here. Obsidian responds to an explicit
      // detach by activating its main workspace window. Closing the independent
      // native popout lets its normal unload lifecycle remove the leaf without
      // asking Obsidian to focus a replacement first.
      for (const note of [...(this.notesByPath.get(path) ?? [])]) {
        this.rememberTopLevelPosition(note);
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

  async setHeaderSize(size: HeaderSize): Promise<void> {
    const previous = this.settings.headerSize;
    if (size === previous) return;
    this.settings.headerSize = size;
    await this.saveSettings();
    // prepareWindow() only ever hides the traffic lights, so this transition is
    // the one place that has to bring them back on the open notes. Restricted to
    // the move back to "default": between two compact sizes the refresh below
    // would immediately hide them again, which reads as a flicker.
    if (size === "default") {
      for (const note of this.allNotes()) this.setTrafficLightsVisible(note, true);
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
    await leaf.openFile(file, { active: true });

    this.initializeStickyLeaf(file, leaf);
  }

  private initializeStickyLeaf(file: TFile, leaf: WorkspaceLeaf, detachOnFailure = true): boolean {
    if (this.initializedLeaves.has(leaf)) return false;

    // The view's ownerDocument is permanently tied to this popout. Obsidian's
    // activeDocument is global and can point at the main window after blur.
    const document = leaf.view.containerEl.ownerDocument;
    const domWindow = document.defaultView;
    if (!domWindow) {
      if (detachOnFailure) {
        leaf.detach();
        new Notice("Could not access the sticky-note document.");
      }
      return false;
    }
    // The DOM Window exposed by an Obsidian popout deliberately does not expose
    // Electron's webContents. A unique document title is visible to Electron,
    // however, and reliably gives us the corresponding native BrowserWindow.
    const windowMarker = `desktop-sticky-note-${crypto.randomUUID()}`;
    document.title = windowMarker;
    const browserWindow = BrowserWindow.getAllWindows().find(
      (candidate) => candidate.getTitle() === windowMarker
    ) as NativeBrowserWindow | undefined;
    if (!browserWindow) {
      if (detachOnFailure) {
        leaf.detach();
        new Notice("Could not create the sticky-note window.");
      }
      return false;
    }

    const note: StickyNoteWindow = { file, leaf, document, window: browserWindow };
    this.initializedLeaves.add(leaf);
    this.trackNote(note);
    this.prepareWindow(note);
    this.watchWindow(note, domWindow);
    this.registerDomEvent(domWindow, "beforeunload", () => {
      this.rememberTopLevelPosition(note);
      this.untrackNote(note);
    });
    return true;
  }

  private prepareWindow(note: StickyNoteWindow): void {
    if (note.window.isDestroyed()) return;
    const { document, window } = note;
    const nativeTitle = this.nativeNoteWindowTitle(note.file);
    const domWindow = document.defaultView;
    if (domWindow) domWindow.name = this.windowNameForPath(note.file.path);
    document.documentElement.dataset.desktopStickyNoteWindow = "true";
    document.documentElement.dataset.desktopStickyNotePath = note.file.path;
    document.title = nativeTitle;
    window.setTitle(nativeTitle);
    document.body.classList.add("desktop-sticky-note");
    document.querySelector(".workspace-tab-header-container")?.remove();
    this.applyColor(note, this.noteColor(note.file.path), false);
    this.applyHeaderSize(note);
    this.configureWindowOwnership(note);
    window.setResizable(true);
    this.addStickyActions(note);
    this.observePresentation(note);
  }

  // Obsidian rebuilds parts of a popout on focus and layout changes, so the
  // classes that drive the compact stylesheet are re-synced on every pass
  // instead of being applied once when the window is created.
  private applyHeaderSize(note: StickyNoteWindow): void {
    const size = this.settings.headerSize;
    const { classList } = note.document.body;
    classList.toggle(COMPACT_HEADER_CLASS, size !== "default");
    for (const [candidate, className] of Object.entries(HEADER_SIZE_CLASSES)) {
      if (className) classList.toggle(className, candidate === size);
    }
    // Hiding only. The default size must not reach for a native window API on
    // every focus and layout pass; setHeaderSize() and onunload() restore the
    // buttons once per transition instead.
    if (size !== "default") this.hideTrafficLights(note);
  }

  private hideTrafficLights(note: StickyNoteWindow): void {
    // Only the "Hidden" window frame style puts the traffic lights on top of the
    // note itself. The other styles give the window a title bar that this plugin
    // neither draws nor replaces, so their buttons are left alone. The restoring
    // call deliberately skips this check: once the buttons are hidden they have
    // to come back even if the window has since stopped matching it.
    if (!note.document.body.classList.contains("is-hidden-frameless")) return;
    this.setTrafficLightsVisible(note, false);
  }

  private setTrafficLightsVisible(note: StickyNoteWindow, visible: boolean): void {
    // Hiding is on prepareWindow()'s path, which Obsidian runs on every focus
    // and layout change, and only a window this plugin hid is ever shown again.
    // Tracking that state keeps both directions off the main process unless the
    // call would change something.
    if ((note.trafficLightsHidden ?? false) === !visible) return;
    try {
      // setWindowButtonVisibility only exists on macOS.
      if (CURRENT_PLATFORM !== "macos" || note.window.isDestroyed()) return;
      if (!note.window.setWindowButtonVisibility) return;
      note.window.setWindowButtonVisibility(visible);
    } catch {
      // isDestroyed() is itself a call into the main process, and the remote
      // proxy becomes invalid as soon as the window closes. Callers are
      // part-way through building or tearing down a note and must carry on.
      return;
    }
    note.trafficLightsHidden = !visible;
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
    const mainWindow = (BrowserWindow.getAllWindows() as unknown as NativeBrowserWindow[])
      .find((candidate) => !candidate.isDestroyed() && candidate.getTitle() === marker) ?? null;
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
      && !!actions?.querySelector(".desktop-sticky-note-color-picker");
  }

  private addStickyActions(note: StickyNoteWindow): void {
    const view = note.leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const actions = view.containerEl.querySelector(".view-actions");
    actions?.empty();

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
    this.updatePinButton(pin, note.window.isAlwaysOnTop());

    const colorPicker = actions?.createEl("input", {
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
    this.updateModeButton(mode, view.getMode());
    view.addAction("x", "Hide sticky note", () => this.hideNote(note))
      .addClass("desktop-sticky-note-hide");
  }

  private updatePinButton(button: HTMLElement, pinned: boolean): void {
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

  private closeStaleStickyWindows(): void {
    const windows = BrowserWindow.getAllWindows() as unknown as NativeBrowserWindow[];
    for (const candidate of windows) {
      if (candidate.isDestroyed()) continue;
      if (candidate.getTitle().startsWith("Sticky note —") && !candidate.isDestroyed()) {
        candidate.destroy();
      }
    }
    void this.app.workspace.requestSaveLayout();
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
    return (BrowserWindow.getAllWindows() as unknown as NativeBrowserWindow[])
      .filter((candidate) => !candidate.isDestroyed() && candidate.getTitle() === expectedTitle);
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
        name: "Header size",
        desc: "Height of the sticky-note header. Small and extra small also hide the window buttons on macOS when the window frame style is hidden.",
        render: (setting) => this.addHeaderSizeControl(setting)
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
    this.addHeaderSizeControl(new Setting(containerEl)
      .setName("Header size")
      .setDesc("Height of the sticky-note header. Small and extra small also hide the window buttons on macOS when the window frame style is hidden."));
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

  private addHeaderSizeControl(setting: Setting): void {
    setting.addDropdown((dropdown) => dropdown
      .addOption("default", "Default")
      .addOption("small", "Small")
      .addOption("extra-small", "Extra small")
      .setValue(this.plugin.settings.headerSize)
      .onChange(async (value) => {
        if (isHeaderSize(value)) await this.plugin.setHeaderSize(value);
      }));
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
