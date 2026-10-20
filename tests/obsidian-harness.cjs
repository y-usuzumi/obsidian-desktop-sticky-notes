const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { runInNewContext } = require("node:vm");
const { transformSync } = require("esbuild");

// Compile the actual plugin without loading Electron or adding a DOM dependency.
const { code } = transformSync(readFileSync(join(__dirname, "../main.ts"), "utf8"), {
  loader: "ts", format: "cjs", target: "es2022"
});

class Events {
  handlers = new Map();
  on(name, callback) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(callback);
    this.handlers.set(name, handlers);
    return { off: () => this.handlers.set(name, handlers.filter((handler) => handler !== callback)) };
  }
  trigger(name, ...args) {
    for (const callback of this.handlers.get(name) ?? []) callback(...args);
  }
  offref(ref) { ref.off(); }
}

class Element extends EventTarget {
  children = [];
  dataset = {};
  classes = new Set();
  properties = new Map();
  classList = {
    add: (name) => this.classes.add(name),
    remove: (name) => this.classes.delete(name),
    contains: (name) => this.classes.has(name)
  };
  style = {
    setProperty: (name, value) => this.properties.set(name, value),
    getPropertyValue: (name) => this.properties.get(name) ?? ""
  };
  addClass(name) { this.classList.add(name); return this; }
  empty() { this.children = []; }
  querySelector(selector) { return this.children.find((child) => child.classList.contains(selector.slice(1))) ?? null; }
  createEl(tag, options) {
    const element = tag === "input" ? new InputElement() : new Element();
    element.addClass(options.cls);
    Object.assign(element, options.attr);
    this.children.push(element);
    return element;
  }
}
class InputElement extends Element {}
class WorkspaceWindow {}
class TFile {
  constructor(path) { this.path = path; this.basename = path.split("/").pop().replace(/\.md$/, ""); }
}
class TextFileView {
  saveCalls = 0;
  async save() { this.saveCalls++; }
}
class MarkdownView extends TextFileView {
  mode = "source";
  constructor(file, document) {
    super();
    this.file = file;
    this.actions = new Element();
    this.actions.addClass("view-actions");
    this.containerEl = new Element();
    this.containerEl.ownerDocument = document;
    this.containerEl.children.push(this.actions);
  }
  addAction(icon, title, callback) {
    const action = new Element();
    Object.assign(action, { icon, title, callback });
    this.actions.children.push(action);
    return action;
  }
  getMode() { return this.mode; }
  getState() { return { file: this.file?.path, mode: this.mode }; }
  async setState(state) { if (state.mode) this.mode = state.mode; }
}

function createDocument() {
  const document = {
    title: "Example — Obsidian",
    defaultView: new EventTarget(),
    documentElement: new Element(),
    body: new Element(),
    tabHeadersPresent: true,
    querySelector(selector) {
      return selector === ".workspace-tab-header-container" && this.tabHeadersPresent
        ? { remove: () => { this.tabHeadersPresent = false; } }
        : null;
    }
  };
  document.defaultView.name = "";
  return document;
}

function createHarness(settings = {}, layoutReady = false, supportsDeferredViews = true) {
  const mainDocument = createDocument();
  const leaves = new Map();
  const files = new Map();
  const windows = [];
  const timers = new Map();
  const notices = [];
  const readyCallbacks = [];
  const shortcuts = new Map();
  let nextTimer = 0;
  let clockTime = 0;
  let nextLeaf = 0;
  let stored = structuredClone(settings);
  let layoutSavePending = false;
  let reloadCalls = 0;

  // Each harness has its own Obsidian runtime. Prototype wrappers must not
  // leak from one simulated app into another restart or test case.
  class WorkspaceLeaf {
    getViewState() {
      return { type: this.isDeferred || this.view instanceof MarkdownView ? "markdown" : "other", state: this.view.getState?.() ?? {} };
    }
    async setViewState(state) { await this.view.setState(state.state ?? {}); }
  }

  const workspace = Object.assign(new Events(), {
    layoutReady,
    containerEl: { ownerDocument: mainDocument },
    layoutSaves: 0,
    saveRuns: 0,
    savedLayout: null,
    popoutsOpened: 0,
    onLayoutReady(callback) { if (this.layoutReady) callback(); else readyCallbacks.push(callback); },
    getLeafById(id) { return leaves.get(id) ?? null; },
    iterateAllLeaves(callback) { for (const leaf of leaves.values()) callback(leaf); },
    getLayout() {
      const state = (leaf) => ({ type: "leaf", id: leaf.id, state: leaf.getViewState() });
      return {
        main: { type: "split", children: [...leaves.values()].filter((leaf) => !leaf.popout).map(state) },
        floating: { type: "floating", children: [...leaves.values()].filter((leaf) => leaf.popout).map((leaf) => ({
          type: "window", children: [{ type: "tabs", children: [state(leaf)] }]
        })) }
      };
    },
    requestSaveLayout() { this.layoutSaves++; layoutSavePending = true; return this.requestSaveLayout; },
    openPopoutLeaf() { this.popoutsOpened++; return addLeaf(`new-${++nextLeaf}`); }
  });
  workspace.requestSaveLayout.run = async () => {
    if (!layoutSavePending) return;
    layoutSavePending = false;
    if (!workspace.layoutReady) return;
    workspace.saveRuns++;
    workspace.savedLayout = structuredClone(workspace.getLayout());
  };
  workspace.requestSaveLayout.cancel = () => { layoutSavePending = false; };
  workspace.on("quit", (tasks) => {
    if (!tasks) return; // Existing tests can exercise only the plugin's quit notification.
    workspace.requestSaveLayout.cancel();
    for (const leaf of leaves.values()) {
      if (leaf.view instanceof TextFileView) tasks.addPromise(leaf.view.save());
    }
  });

  function addLeaf(id, { file = new TFile("Notes/Example.md"), popout = true, deferred = false, native = true, asyncTitle = false, state = {} } = {}) {
    const document = popout ? createDocument() : mainDocument;
    let nativeTitle = document.title;
    if (asyncTitle) {
      // DOM title changes travel to Electron on a later turn. Keeping these
      // values separate exposes lookups that only work with synchronous IPC.
      let domTitle = document.title;
      Object.defineProperty(document, "title", {
        get: () => domTitle,
        set(title) {
          domTitle = title;
          timers.set(++nextTimer, { callback: () => { nativeTitle = title; }, at: clockTime });
        }
      });
    }
    const view = new MarkdownView(file, document);
    view.app = app;
    if (state.mode) view.mode = state.mode;
    const container = popout ? new WorkspaceWindow() : {};
    if (popout) Object.assign(container, { doc: document, win: document.defaultView });
    let resolveLoad;
    const leaf = Object.assign(new WorkspaceLeaf(), {
      id, popout, document, container,
      view: deferred ? { app, containerEl: view.containerEl, getState: () => ({ file: file.path, ...state }) } : view,
      isDeferred: deferred,
      loadCalls: 0,
      detaches: 0,
      getContainer() { return this.container; },
      async openFile(opened, { active = false } = {}) {
        this.view.file = opened;
        files.set(opened.path, opened);
        if (active) {
          for (const nativeWindow of windows) nativeWindow.focused = false;
          this.nativeWindow.focused = true;
        }
      },
      loadIfDeferred() {
        this.loadCalls++;
        return new Promise((resolve) => { resolveLoad = () => { this.view = view; this.isDeferred = false; resolve(); }; });
      },
      finishLoading() { resolveLoad(); },
      detach() {
        this.detaches++;
        leaves.delete(id);
        // Each fixture popout contains one leaf, so removing it closes the
        // native window just as Obsidian does for an empty popout.
        if (popout && !this.nativeWindow.isDestroyed()) this.nativeWindow.close();
      }
    });
    const nativeWindow = {
      destroyed: false, closes: 0, destroys: 0, focused: false, alwaysOnTop: false,
      setResizable() {}, setParentWindow(parent) { this.parent = parent; }, setSkipTaskbar() {},
      setAlwaysOnTop(value) { this.alwaysOnTop = value; }, isAlwaysOnTop() { return this.alwaysOnTop; },
      setTitle(title) { nativeTitle = title; document.title = title; },
      getTitle() { return asyncTitle ? nativeTitle : document.title; },
      isDestroyed() { return this.destroyed; }, isFocused() { return this.focused; },
      isVisible() { return true; }, isMinimized() { return false; },
      show() {}, restore() {}, focus() { this.focused = true; }, moveTop() {},
      close() {
        this.closes++;
        document.defaultView.dispatchEvent(new Event("beforeunload"));
        document.defaultView.closed = true;
        this.destroyed = true;
        leaves.delete(id);
        if (popout) workspace.trigger("window-close", container, document.defaultView);
      },
      destroy() { this.destroys++; this.destroyed = true; leaves.delete(id); },
      getPosition() { return [120, 160]; }
    };
    leaf.nativeWindow = nativeWindow;
    if (native) windows.push(nativeWindow);
    if (popout) workspace.on("quit", (tasks) => {
      if (tasks && !nativeWindow.isDestroyed()) nativeWindow.close();
    });
    leaves.set(id, leaf);
    files.set(file.path, file);
    return leaf;
  }

  class Plugin {
    cleanups = [];
    constructor(app) { this.app = app; }
    async loadData() { return structuredClone(stored); }
    async saveData(data) { stored = structuredClone(data); }
    addSettingTab() {} addCommand() {}
    register(cleanup) { this.cleanups.push(cleanup); }
    registerEvent(ref) { this.cleanups.push(() => ref.off()); }
    registerDomEvent(target, name, callback) {
      target.addEventListener(name, callback);
      this.cleanups.push(() => target.removeEventListener(name, callback));
    }
    unload() { this.onunload(); for (const cleanup of this.cleanups) cleanup(); }
  }
  const obsidian = {
    Plugin, MarkdownView, TextFileView, WorkspaceLeaf, WorkspaceWindow, TFile,
    Notice: class { constructor(message) { notices.push(message); } },
    Platform: { isMacOS: false, isWin: false },
    requireApiVersion: () => supportsDeferredViews,
    PluginSettingTab: class {},
    setIcon: (element, icon) => { element.icon = icon; },
    setTooltip: (element, title) => { element.title = title; }
  };
  // Stands in for the @electron/remote instance Obsidian attaches to its
  // Electron module. The plugin must reach it only through
  // require("electron").remote, so a direct require of "@electron/remote"
  // falls through to the "Unexpected dependency" error below.
  const remote = {
    BrowserWindow: { getAllWindows: () => windows },
    globalShortcut: {
      isRegistered: (accelerator) => shortcuts.has(accelerator),
      register(accelerator, callback) { shortcuts.set(accelerator, callback); return true; },
      unregister(accelerator) { shortcuts.delete(accelerator); }
    },
    screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] }
  };
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports,
    require: (name) => {
      if (name === "obsidian") return obsidian;
      if (name === "electron") return { remote };
      throw new Error(`Unexpected dependency: ${name}`);
    },
    window: {
      setTimeout(callback, delay = 0) {
        const id = ++nextTimer;
        timers.set(id, { callback, at: clockTime + delay });
        return id;
      },
      clearTimeout(id) { timers.delete(id); }
    },
    crypto: { randomUUID }, HTMLInputElement: InputElement,
    MutationObserver: class { observe() {} disconnect() {} }
  });
  const app = {
    workspace,
    commands: { commands: { "app:reload": { callback: () => { reloadCalls++; } } } },
    vault: Object.assign(new Events(), { getAbstractFileByPath: (path) => files.get(path) ?? null })
  };
  const plugin = new module.exports.default(app);
  return {
    plugin, workspace, mainDocument, leaves, windows, notices, addLeaf, TFile,
    saved: () => structuredClone(stored),
    reloadCalls: () => reloadCalls,
    reload() { app.commands.commands["app:reload"].callback(); },
    pendingTimers: () => timers.size,
    pressShortcut(accelerator = plugin.getGlobalToggleShortcut()) {
      const callback = shortcuts.get(accelerator);
      if (!callback) throw new Error("Shortcut is not registered");
      callback();
    },
    ready() { workspace.layoutReady = true; for (const callback of readyCallbacks.splice(0)) callback(); },
    flushTimers(nextOnly = false) {
      if (!timers.size) return;
      const dueTimes = [...timers.values()].map((timer) => timer.at);
      clockTime = nextOnly ? Math.min(...dueTimes) : Math.max(...dueTimes);
      const due = [...timers].filter(([, timer]) => timer.at <= clockTime);
      for (const [id] of due) timers.delete(id);
      for (const [, timer] of due) timer.callback();
    }
  };
}

module.exports = { createHarness };
