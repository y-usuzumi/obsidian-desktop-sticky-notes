const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness } = require("./obsidian-harness.cjs");

const settled = () => new Promise((resolve) => setImmediate(resolve));
const classes = (leaf) => [...leaf.document.body.classes].filter((name) => name.startsWith("desktop-sticky-note-")).sort();
const COMPACT = "desktop-sticky-note-compact";
const SMALL = "desktop-sticky-note-header-small";
const EXTRA_SMALL = "desktop-sticky-note-header-extra-small";

// Obsidian marks the popout body with this class when the window frame style
// is "Hidden", the only style where the traffic lights sit on the note itself.
function openWithHiddenFrame(h) {
  const originalOpen = h.workspace.openPopoutLeaf.bind(h.workspace);
  h.workspace.openPopoutLeaf = () => {
    const leaf = originalOpen();
    leaf.document.body.classList.add("is-hidden-frameless");
    return leaf;
  };
}

async function openNote(h) {
  await h.plugin.openStickyNote(new h.TFile("Notes/Example.md"));
  return h.leaves.get("new-1");
}

test("an unknown stored header size falls back to the stock header", async () => {
  const h = createHarness({ headerSize: "huge" }, true);
  await h.plugin.onload();
  assert.equal(h.plugin.settings.headerSize, "default");
  const leaf = await openNote(h);
  assert.deepEqual(classes(leaf), []);
});

test("compact header classes follow the setting on open notes", async () => {
  const h = createHarness({ headerSize: "small" }, true);
  await h.plugin.onload();
  const leaf = await openNote(h);
  assert.deepEqual(classes(leaf), [COMPACT, SMALL]);

  await h.plugin.setHeaderSize("extra-small");
  h.flushTimers();
  assert.deepEqual(classes(leaf), [COMPACT, EXTRA_SMALL]);
  assert.equal(h.saved().headerSize, "extra-small");

  await h.plugin.setHeaderSize("default");
  h.flushTimers();
  assert.deepEqual(classes(leaf), []);
});

test("windows restored after a restart get the compact header", async () => {
  const h = createHarness({ headerSize: "extra-small", stickyNoteLeafIds: ["restored"] });
  const leaf = h.addLeaf("restored");
  await h.plugin.onload();
  h.ready();
  await settled();
  assert.equal(leaf.document.body.classList.contains("desktop-sticky-note"), true);
  assert.deepEqual(classes(leaf), [COMPACT, EXTRA_SMALL]);
});

test("macOS traffic lights are hidden once with the hidden frame style and restored on the way back to default", async () => {
  const h = createHarness({ headerSize: "small" }, true, true, { macOS: true });
  openWithHiddenFrame(h);
  await h.plugin.onload();
  const leaf = await openNote(h);
  const calls = leaf.nativeWindow.buttonVisibilityCalls;
  assert.deepEqual(calls, [false]);

  // Focus and layout refreshes rerun the presentation pass; the tracked state
  // keeps them from calling into the main process again.
  h.workspace.trigger("layout-change");
  h.flushTimers();
  assert.deepEqual(calls, [false]);

  // Moving between two compact sizes must not briefly show the buttons.
  await h.plugin.setHeaderSize("extra-small");
  h.flushTimers();
  assert.deepEqual(calls, [false]);

  await h.plugin.setHeaderSize("default");
  h.flushTimers();
  assert.deepEqual(calls, [false, true]);
});

test("macOS traffic lights are left alone with frame styles that draw a title bar", async () => {
  const h = createHarness({ headerSize: "small" }, true, true, { macOS: true });
  await h.plugin.onload();
  const leaf = await openNote(h);
  assert.deepEqual(classes(leaf), [COMPACT, SMALL]);
  await h.plugin.setHeaderSize("default");
  h.flushTimers();
  assert.deepEqual(leaf.nativeWindow.buttonVisibilityCalls, []);
});

test("other platforms never reach for the macOS-only window API", async () => {
  const h = createHarness({ headerSize: "small" }, true);
  openWithHiddenFrame(h);
  await h.plugin.onload();
  const leaf = await openNote(h);
  await h.plugin.setHeaderSize("default");
  h.flushTimers();
  assert.deepEqual(leaf.nativeWindow.buttonVisibilityCalls, []);
});

test("disabling the plugin restores hidden traffic lights; quitting leaves teardown to Obsidian", async () => {
  const disabled = createHarness({ headerSize: "small" }, true, true, { macOS: true });
  openWithHiddenFrame(disabled);
  await disabled.plugin.onload();
  const disabledLeaf = await openNote(disabled);
  disabled.plugin.unload();
  assert.deepEqual(disabledLeaf.nativeWindow.buttonVisibilityCalls, [false, true]);

  const quit = createHarness({ headerSize: "small" }, true, true, { macOS: true });
  openWithHiddenFrame(quit);
  await quit.plugin.onload();
  const quitLeaf = await openNote(quit);
  quit.workspace.trigger("quit");
  quit.plugin.unload();
  assert.deepEqual(quitLeaf.nativeWindow.buttonVisibilityCalls, [false]);
});

test("a native proxy that throws does not break note setup", async () => {
  const h = createHarness({ headerSize: "small" }, true, true, { macOS: true });
  const originalOpen = h.workspace.openPopoutLeaf.bind(h.workspace);
  h.workspace.openPopoutLeaf = () => {
    const leaf = originalOpen();
    leaf.document.body.classList.add("is-hidden-frameless");
    leaf.nativeWindow.setWindowButtonVisibility = () => { throw new Error("Object has been destroyed"); };
    return leaf;
  };
  await h.plugin.onload();
  const leaf = await openNote(h);
  assert.deepEqual(classes(leaf), [COMPACT, SMALL]);
  assert.equal(leaf.view.actions.children.length, 4);
  assert.equal(h.notices.length, 0);
});

test("restored windows also hide the macOS traffic lights", async () => {
  const h = createHarness({ headerSize: "small", stickyNoteLeafIds: ["restored"] }, false, true, { macOS: true });
  const leaf = h.addLeaf("restored");
  leaf.document.body.classList.add("is-hidden-frameless");
  await h.plugin.onload();
  h.ready();
  await settled();
  assert.deepEqual(classes(leaf), [COMPACT, SMALL]);
  assert.deepEqual(leaf.nativeWindow.buttonVisibilityCalls, [false]);
});

test("the presentation check notices compact classes stripped from the body", async () => {
  const h = createHarness({ headerSize: "small" }, true);
  await h.plugin.onload();
  const leaf = await openNote(h);
  // The harness MutationObserver never fires, so ask the check it would run.
  const [note] = [...h.plugin.allNotes()];
  assert.equal(h.plugin.presentationIsIntact(note), true);
  leaf.document.body.classList.remove(SMALL);
  assert.equal(h.plugin.presentationIsIntact(note), false);
  leaf.document.body.classList.add(SMALL);
  leaf.document.body.classList.add(EXTRA_SMALL);
  assert.equal(h.plugin.presentationIsIntact(note), false);
});

test("a stale switch to default does not flash the traffic lights after a newer compact choice", async () => {
  const h = createHarness({ headerSize: "small" }, true, true, { macOS: true });
  openWithHiddenFrame(h);
  await h.plugin.onload();
  const leaf = await openNote(h);
  await Promise.all([h.plugin.setHeaderSize("default"), h.plugin.setHeaderSize("extra-small")]);
  h.flushTimers();
  assert.equal(h.plugin.settings.headerSize, "extra-small");
  assert.deepEqual(leaf.nativeWindow.buttonVisibilityCalls, [false]);
});

test("a throwing native proxy is not recorded as hidden", async () => {
  const h = createHarness({ headerSize: "small" }, true, true, { macOS: true });
  openWithHiddenFrame(h);
  await h.plugin.onload();
  const leaf = await openNote(h);
  const attempts = [];
  leaf.nativeWindow.setWindowButtonVisibility = (visible) => { attempts.push(visible); throw new Error("gone"); };
  const [note] = [...h.plugin.allNotes()];
  note.trafficLightsHidden = false;
  h.workspace.trigger("layout-change");
  h.flushTimers();
  assert.equal(note.trafficLightsHidden, false);
  attempts.length = 0;
  await h.plugin.setHeaderSize("default");
  h.flushTimers();
  assert.deepEqual(attempts, [], "a button the plugin never hid is not shown again");
});

test("a setup failure after hiding restores the traffic lights before untracking", async () => {
  const h = createHarness({ headerSize: "small" }, true, true, { macOS: true });
  const originalOpen = h.workspace.openPopoutLeaf.bind(h.workspace);
  h.workspace.openPopoutLeaf = () => {
    const leaf = originalOpen();
    leaf.document.body.classList.add("is-hidden-frameless");
    // configureWindowOwnership() runs after the header pass in prepareWindow().
    leaf.nativeWindow.setSkipTaskbar = () => { throw new Error("gone"); };
    return leaf;
  };
  await h.plugin.onload();
  await assert.rejects(openNote(h));
  const leaf = h.leaves.get("new-1");
  // Restoration retries the failed setup, so the pair can repeat; each failed
  // attempt must still leave the buttons visible.
  const calls = leaf.nativeWindow.buttonVisibilityCalls;
  assert.ok(calls.length >= 2);
  assert.deepEqual(calls, calls.map((_, index) => index % 2 === 1));
});
