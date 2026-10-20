const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness } = require("./obsidian-harness.cjs");

const settled = () => new Promise((resolve) => setImmediate(resolve));

async function advanceTimers(h, turns) {
  for (let turn = 0; turn < turns; turn++) {
    h.flushTimers(true);
    await settled();
  }
}

async function openTranslucentNote(settings = {}) {
  const h = createHarness({ windowOpacity: 0.5, ...settings }, true);
  await h.plugin.onload();
  await h.plugin.openStickyNote(new h.TFile("Notes/Example.md"));
  return { h, leaf: h.leaves.get("new-1") };
}

function dispatch(target, name) {
  target.dispatchEvent(new Event(name));
}

test("the default setting never calls into the native window", async () => {
  const h = createHarness({}, true);
  await h.plugin.onload();
  await h.plugin.openStickyNote(new h.TFile("Notes/Example.md"));
  const leaf = h.leaves.get("new-1");
  leaf.document.focused = true;
  dispatch(leaf.document.defaultView, "focus");
  dispatch(leaf.document.documentElement, "mouseenter");
  await advanceTimers(h, 3);
  assert.equal(leaf.nativeWindow.opacityCalls, 0);
  assert.equal(leaf.nativeWindow.opacity, 1);
});

test("a note uses the configured opacity and is opaque while focused or hovered", async () => {
  const { h, leaf } = await openTranslucentNote();
  assert.equal(leaf.nativeWindow.opacity, 0.5);

  leaf.document.focused = true;
  dispatch(leaf.document.defaultView, "focus");
  await advanceTimers(h, 2);
  assert.equal(leaf.nativeWindow.opacity, 1);

  dispatch(leaf.document.documentElement, "mouseenter");
  leaf.document.focused = false;
  dispatch(leaf.document.defaultView, "blur");
  await advanceTimers(h, 2);
  assert.equal(leaf.nativeWindow.opacity, 1, "the pointer still keeps it opaque");

  dispatch(leaf.document.documentElement, "mouseleave");
  assert.equal(leaf.nativeWindow.opacity, 0.5);

  const calls = leaf.nativeWindow.opacityCalls;
  h.workspace.trigger("layout-change");
  await advanceTimers(h, 3);
  assert.equal(leaf.nativeWindow.opacityCalls, calls, "unchanged passes skip the remote call");
});

test("turning off the focus setting keeps a focused note at the configured opacity", async () => {
  const { h, leaf } = await openTranslucentNote();
  leaf.document.focused = true;
  dispatch(leaf.document.defaultView, "focus");
  await advanceTimers(h, 2);
  assert.equal(leaf.nativeWindow.opacity, 1);

  await h.plugin.setOpaqueWhileFocused(false);
  assert.equal(leaf.nativeWindow.opacity, 0.5);
  assert.equal(h.saved().opaqueWhileFocused, false);
});

test("changing the opacity applies at once and saves only the settled value", async () => {
  const { h, leaf } = await openTranslucentNote();
  h.plugin.setWindowOpacity(0.7);
  h.plugin.setWindowOpacity(0.33);
  assert.equal(leaf.nativeWindow.opacity, 0.35, "values snap to the slider's grid");
  assert.equal(h.saved().windowOpacity, 0.5, "the write waits for the slider to settle");
  await advanceTimers(h, 3);
  assert.equal(h.saved().windowOpacity, 0.35);

  h.plugin.setWindowOpacity("0.8");
  h.plugin.setWindowOpacity(0.1);
  h.plugin.setWindowOpacity(Number.NaN);
  assert.equal(h.plugin.settings.windowOpacity, 0.35, "values outside the setting's range are ignored");
});

test("a stored opacity is validated and corrected values are written back", async () => {
  for (const [stored, expected] of [[0.537, 0.55], [5, 1], ["0.5", 1]]) {
    const h = createHarness({ windowOpacity: stored, opaqueWhileFocused: "yes" });
    await h.plugin.onload();
    assert.equal(h.plugin.settings.windowOpacity, expected);
    assert.equal(h.plugin.settings.opaqueWhileFocused, true);
    assert.equal(h.saved().windowOpacity, expected);
  }

  const untouched = createHarness({ defaultFolder: "Inbox" });
  await untouched.plugin.onload();
  assert.equal(untouched.plugin.settings.windowOpacity, 1);
  assert.equal(Object.hasOwn(untouched.saved(), "windowOpacity"), false, "a vault without the key keeps its data untouched");
});

test("hiding a note restores its opacity, and later passes cannot undo that", async () => {
  const { h, leaf } = await openTranslucentNote();
  // Keep the native window alive after close, as when another app blocks it.
  leaf.nativeWindow.close = () => { leaf.nativeWindow.closes++; };
  leaf.nativeWindow.destroy = () => {};
  assert.equal(leaf.nativeWindow.opacity, 0.5);
  leaf.view.actions.children.find((element) => element.title === "Hide sticky note").callback();
  assert.equal(leaf.nativeWindow.opacity, 1);

  dispatch(leaf.document.documentElement, "mouseenter");
  dispatch(leaf.document.documentElement, "mouseleave");
  dispatch(leaf.document.defaultView, "blur");
  await advanceTimers(h, 3);
  assert.equal(leaf.nativeWindow.opacity, 1);
});

test("a canceled close leaves the surviving window opaque while it has the focus", async () => {
  const { h, leaf } = await openTranslucentNote();
  leaf.nativeWindow.close = () => {
    leaf.nativeWindow.closes++;
    dispatch(leaf.document.defaultView, "beforeunload");
  };
  h.reload();
  await settled();
  // The close was canceled, and the window gains the focus before the plugin
  // initializes it again as a new note.
  leaf.document.focused = true;
  await advanceTimers(h, 60);
  assert.equal(h.reloadCalls(), 0);
  assert.equal([...h.plugin.allNotes()].length, 1);
  assert.equal(leaf.nativeWindow.opacity, 1);

  leaf.document.focused = false;
  dispatch(leaf.document.defaultView, "blur");
  await advanceTimers(h, 2);
  assert.equal(leaf.nativeWindow.opacity, 0.5, "the new note still manages the window");
});

test("the top-level toggle restores the opacity of the window it closes", async () => {
  const { h, leaf } = await openTranslucentNote({ topLevelNotePath: "Notes/Example.md", opaqueWhileFocused: false });
  leaf.nativeWindow.close = () => { leaf.nativeWindow.closes++; };
  leaf.nativeWindow.destroy = () => {};
  leaf.nativeWindow.focused = true;
  await h.plugin.toggleTopLevelNote();
  assert.equal(leaf.nativeWindow.closes, 1);
  assert.equal(leaf.nativeWindow.opacity, 1);
});

test("disabling the plugin restores the opacity and saves a pending value", async () => {
  const { h, leaf } = await openTranslucentNote();
  // Electron closes asynchronously, so beforeunload cannot untrack the note
  // before unloading has already dropped it.
  leaf.nativeWindow.close = () => { leaf.nativeWindow.closes++; };
  h.plugin.setWindowOpacity(0.8);
  h.plugin.unload();
  await settled();
  assert.equal(leaf.nativeWindow.opacity, 1);
  assert.equal(h.saved().windowOpacity, 0.8);
});

// The same collector contract Obsidian passes to quit handlers.
function createQuitTasks() {
  const promises = [];
  return {
    add(callback) { promises.push(callback()); },
    addPromise(promise) { promises.push(promise); },
    isEmpty() { return promises.length === 0; },
    promise() { return Promise.all(promises); }
  };
}

test("quitting saves an opacity whose debounced write is still pending", async () => {
  const { h } = await openTranslucentNote();
  h.plugin.setWindowOpacity(0.4);
  h.workspace.trigger("quit", createQuitTasks());
  await settled();
  assert.equal(h.saved().windowOpacity, 0.4);
});

test("quit waits for the pending opacity write to finish", async () => {
  const { h } = await openTranslucentNote();
  const saveData = h.plugin.saveData.bind(h.plugin);
  let finishSave;
  const gate = new Promise((resolve) => { finishSave = resolve; });
  h.plugin.saveData = async (data) => { await gate; await saveData(data); };
  h.plugin.setWindowOpacity(0.4);
  const tasks = createQuitTasks();
  h.workspace.trigger("quit", tasks);
  let quitFinished = false;
  void tasks.promise().then(() => { quitFinished = true; });
  await settled();
  assert.equal(quitFinished, false, "quit must not finish while the opacity write is still running");
  finishSave();
  await settled();
  assert.equal(quitFinished, true);
  assert.equal(h.saved().windowOpacity, 0.4);
});

test("a failed opacity write on unload does not become an unhandled rejection", async () => {
  const { h, leaf } = await openTranslucentNote();
  leaf.nativeWindow.close = () => { leaf.nativeWindow.closes++; };
  const unhandled = [];
  const record = (reason) => { unhandled.push(reason); };
  process.on("unhandledRejection", record);
  try {
    h.plugin.saveData = async () => { throw new Error("disk full"); };
    h.plugin.setWindowOpacity(0.8);
    h.plugin.unload();
    await settled();
    await settled();
  } finally {
    process.off("unhandledRejection", record);
  }
  assert.deepEqual(unhandled, []);
});

test("quit waits for an opacity write that the debounce already started", async () => {
  const { h } = await openTranslucentNote();
  const saveData = h.plugin.saveData.bind(h.plugin);
  let finishSave;
  let writesStarted = 0;
  const gate = new Promise((resolve) => { finishSave = resolve; });
  h.plugin.saveData = async (data) => { writesStarted++; await gate; await saveData(data); };
  h.plugin.setWindowOpacity(0.4);
  h.flushTimers();
  assert.equal(writesStarted, 1, "the debounced write must already be running when quit arrives");
  const tasks = createQuitTasks();
  h.workspace.trigger("quit", tasks);
  let quitFinished = false;
  void tasks.promise().then(() => { quitFinished = true; });
  await settled();
  assert.equal(quitFinished, false, "quit must not finish while the started opacity write is still running");
  finishSave();
  await settled();
  assert.equal(quitFinished, true);
  assert.equal(h.saved().windowOpacity, 0.4);
});
