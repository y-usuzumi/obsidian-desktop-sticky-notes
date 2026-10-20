const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness } = require("./obsidian-harness.cjs");

// A click on an inactive note focuses its window, and the focus refresh runs
// between that click's mousedown and mouseup. These tests check that the
// refresh leaves the pressed button element (and its icon) in place.

const buttons = (leaf) => [...leaf.view.actions.children];
const pinButton = (leaf) => buttons(leaf).find((element) => element.classes.has("desktop-sticky-note-pin"));

async function openNote() {
  const h = createHarness({}, true);
  await h.plugin.onload();
  await h.plugin.openStickyNote(new h.TFile("Notes/Example.md"));
  const leaf = h.leaves.get("new-1");
  assert.ok(leaf);
  h.flushTimers();
  return { h, leaf };
}

function focusRefresh(h, leaf) {
  leaf.document.defaultView.dispatchEvent(new Event("focus"));
  h.flushTimers();
}

test("a focus refresh keeps the existing header buttons and their icons", async () => {
  const { h, leaf } = await openNote();
  const before = buttons(leaf);
  assert.equal(before.length, 4);
  // setIcon() in the harness overwrites `icon`; a sentinel shows whether the
  // refresh replaced the icon of an unchanged button.
  for (const element of before) element.icon = "unchanged";

  focusRefresh(h, leaf);

  const after = buttons(leaf);
  assert.equal(after.length, 4);
  after.forEach((element, index) => assert.equal(element, before[index]));
  for (const element of after) assert.equal(element.icon, "unchanged");
});

test("a focus refresh updates a button whose state changed elsewhere", async () => {
  const { h, leaf } = await openNote();
  const pin = pinButton(leaf);
  assert.equal(pin.icon, "pin");

  leaf.nativeWindow.alwaysOnTop = true;
  focusRefresh(h, leaf);

  assert.equal(pinButton(leaf), pin);
  assert.equal(pin.icon, "pin-off");
  assert.equal(pin.title, "Stop keeping on top");
});

test("a focus refresh drops foreign header controls but keeps the sticky buttons", async () => {
  const { h, leaf } = await openNote();
  const before = buttons(leaf);
  leaf.view.addAction("more-vertical", "More options", () => {});

  focusRefresh(h, leaf);

  assert.deepEqual(buttons(leaf), before);
});

test("a header bar missing a sticky button is rebuilt", async () => {
  const { h, leaf } = await openNote();
  const before = buttons(leaf);
  pinButton(leaf).remove();

  focusRefresh(h, leaf);

  const after = buttons(leaf);
  assert.equal(after.length, 4);
  assert.ok(pinButton(leaf));
  for (const element of after) assert.equal(before.includes(element), false);
});

// The buttons are kept across refreshes, so their handlers must not act on the
// note object that existed when they were created. A leaf is initialized again
// with a new note object when, for example, a popout refuses to close during a
// reload and the finally block restores the leaf that beforeunload untracked.
test("kept header buttons act on the note that currently owns the leaf", async () => {
  const { h, leaf } = await openNote();
  const plugin = h.plugin;
  const [first] = [...plugin.allNotes()];
  plugin.untrackNote(first);
  assert.equal(await plugin.initializeStickyLeaf(first.file, leaf), true);
  h.flushTimers();
  const [second] = [...plugin.allNotes()];
  assert.notEqual(second, first);
  const colorPicker = buttons(leaf).find((element) => element.classes.has("desktop-sticky-note-color-picker"));
  assert.ok(colorPicker, "the reinitialization kept the existing bar");
  // The first note's focus and blur listeners stay registered until unload,
  // so a focus also refreshes through the untracked first note object.
  focusRefresh(h, leaf);
  // Timer order lets the second note's refresh run after the first one's, so
  // also refresh through the first note last to not depend on that order.
  plugin.prepareWindow(first);

  // The rename handler assigns the renamed file to the tracked note objects
  // only, so a handler holding the first note would still see the old path.
  const renamed = new h.TFile("Notes/Renamed.md");
  plugin.app.vault.trigger("rename", renamed, first.file.path);
  colorPicker.value = "#123456";
  colorPicker.dispatchEvent(new Event("input"));

  assert.equal(plugin.settings.colorsByPath["Notes/Renamed.md"], "#123456");
  assert.equal(plugin.settings.colorsByPath["Notes/Example.md"], undefined);

  buttons(leaf).find((element) => element.classes.has("desktop-sticky-note-hide")).callback();
  assert.equal([...plugin.allNotes()].length, 0);
  assert.equal(leaf.detaches, 1);
});
