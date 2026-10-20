const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createHarness } = require("./obsidian-harness.cjs");

// A popout that looks like a sticky window to the DOM check, without the
// plugin tracking it as an open note.
function untrackedStickyLookingLeaf(h, id) {
  const leaf = h.addLeaf(id);
  leaf.document.documentElement.dataset.desktopStickyNoteWindow = "true";
  leaf.document.body.classList.add("desktop-sticky-note");
  return leaf;
}

// A main-window tab and an ordinary popout used earlier, then a sticky note
// that now has the focus: Obsidian's own answers for the next opened file
// both point at the note.
async function focusedStickyNote(settings = {}, { withMain = true, beforeLoad } = {}) {
  const h = createHarness(settings, true);
  const main = withMain ? h.addLeaf("main", { popout: false, file: new h.TFile("Notes/Main.md") }) : null;
  const ordinary = withMain ? h.addLeaf("ordinary", { file: new h.TFile("Notes/Popout.md") }) : null;
  beforeLoad?.(h);
  await h.plugin.onload();
  if (ordinary) h.workspace.setActiveLeaf(ordinary);
  if (main) h.workspace.setActiveLeaf(main);
  await h.plugin.openStickyNote(new h.TFile("Notes/Sticky.md"));
  const sticky = h.leaves.get("new-1");
  h.workspace.setActiveLeaf(sticky);
  return { h, main, ordinary, sticky };
}

test("by default, a file opened from a focused sticky note goes to the most recent leaf outside it", async () => {
  const { h, main, sticky } = await focusedStickyNote();
  assert.equal(h.plugin.settings.openFilesOutsideStickyNotes, true);

  assert.equal(h.workspace.getMostRecentLeaf(), main);
  assert.equal(h.workspace.getUnpinnedLeaf(), main);
  assert.equal(h.workspace.activeLeaf, main, "the chosen leaf must become active so its window comes forward");
  assert.equal(sticky.view.file.path, "Notes/Sticky.md");
});

test("an ordinary popout remains a valid destination", async () => {
  const { h, ordinary, sticky } = await focusedStickyNote();
  h.workspace.setActiveLeaf(ordinary);
  h.workspace.setActiveLeaf(sticky);
  assert.equal(h.workspace.getMostRecentLeaf(), ordinary);
  assert.equal(h.workspace.getUnpinnedLeaf(), ordinary);
});

test("with the setting off, Obsidian's own answers are returned unchanged", async () => {
  const { h, sticky } = await focusedStickyNote({ openFilesOutsideStickyNotes: false });
  assert.equal(h.workspace.getMostRecentLeaf(), sticky);
  const activations = h.workspace.activations;
  assert.equal(h.workspace.getUnpinnedLeaf(), sticky);
  assert.equal(h.workspace.activations, activations, "Obsidian hands back a navigable active leaf without activating it");
});

test("toggling the setting takes effect on the next call without reloading", async () => {
  const { h, main, sticky } = await focusedStickyNote();
  h.plugin.settings.openFilesOutsideStickyNotes = false;
  assert.equal(h.workspace.getUnpinnedLeaf(), sticky);
  h.plugin.settings.openFilesOutsideStickyNotes = true;
  assert.equal(h.workspace.getUnpinnedLeaf(), main);
});

test("the most recent leaf is left to Obsidian while the focus is not on a sticky note", async () => {
  const { h, sticky } = await focusedStickyNote();
  // For example, the focus is on a view outside any tab, and another feature
  // asks for the view last used: that is still the sticky note.
  h.workspace.activeLeaf = null;
  assert.equal(h.workspace.getMostRecentLeaf(), sticky);
});

test("an explicit root is passed through", async () => {
  const { h, sticky } = await focusedStickyNote();
  assert.equal(h.workspace.getMostRecentLeaf(sticky.getContainer()), sticky);
});

test("a leaf requested without activation is not made active", async () => {
  const { h, main, sticky } = await focusedStickyNote();
  assert.equal(h.workspace.getUnpinnedLeaf(false), main);
  assert.equal(h.workspace.activeLeaf, sticky);
});

test("a pinned most recent leaf gets a new tab beside it, outside the sticky note", async () => {
  const { h, main, sticky } = await focusedStickyNote();
  main.pinned = true;
  const chosen = h.workspace.getUnpinnedLeaf();
  assert.notEqual(chosen, main);
  assert.equal(chosen.getContainer(), main.getContainer());
  assert.notEqual(chosen.getContainer(), sticky.getContainer());
  assert.equal(h.workspace.activeLeaf, chosen);
});

test("if the lookup outside sticky windows finds nothing, no sticky leaf is handed out as a redirect", async () => {
  // Obsidian always keeps a leaf in rootSplit, so this guards against a
  // changed lookup rather than a state reachable today.
  const { h, sticky } = await focusedStickyNote({}, { withMain: false });
  assert.equal(h.workspace.getMostRecentLeaf(), sticky);
  const activations = h.workspace.activations;
  assert.equal(h.workspace.getUnpinnedLeaf(), sticky);
  assert.equal(h.workspace.activations, activations, "a sticky leaf must not be handed out as a redirect");
});

test("an Obsidian version that rejects an array of roots gets its own answer", async () => {
  const { h, sticky } = await focusedStickyNote({}, {
    beforeLoad(h) {
      const prototypeMethod = Object.getPrototypeOf(h.workspace).getMostRecentLeaf;
      h.workspace.getMostRecentLeaf = function (root) {
        if (Array.isArray(root)) throw new TypeError("root.children is not iterable");
        return prototypeMethod.call(this, root);
      };
    }
  });
  assert.equal(h.workspace.getMostRecentLeaf(), sticky);
});

test("navigation from an ordinary leaf, or with no sticky note open, is left to Obsidian", async () => {
  const { h, main } = await focusedStickyNote();
  h.workspace.setActiveLeaf(main);
  assert.equal(h.workspace.getUnpinnedLeaf(), main);

  h.plugin.hideNote([...h.plugin.allNotes()][0]);
  const lookalike = untrackedStickyLookingLeaf(h, "lookalike");
  h.workspace.setActiveLeaf(lookalike);
  assert.equal(h.workspace.getMostRecentLeaf(), lookalike);
  assert.equal(h.workspace.getUnpinnedLeaf(), lookalike);
});

test("unloading restores Obsidian's methods unless another plugin wrapped them since", async () => {
  const h = createHarness({}, true);
  const prototype = Object.getPrototypeOf(h.workspace);
  await h.plugin.onload();
  assert.ok(Object.prototype.hasOwnProperty.call(h.workspace, "getUnpinnedLeaf"));
  h.plugin.unload();
  for (const name of ["getMostRecentLeaf", "getUnpinnedLeaf"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(h.workspace, name), false, name);
    assert.equal(h.workspace[name], prototype[name], name);
  }

  const chained = createHarness({}, true);
  await chained.plugin.onload();
  const ours = chained.workspace.getUnpinnedLeaf;
  const theirs = (...args) => ours(...args);
  chained.workspace.getUnpinnedLeaf = theirs;
  chained.plugin.unload();
  assert.equal(chained.workspace.getUnpinnedLeaf, theirs);
  // The retained wrapper must pass straight through once the plugin is gone.
  const lookalike = untrackedStickyLookingLeaf(chained, "lookalike");
  chained.workspace.setActiveLeaf(lookalike);
  assert.equal(chained.workspace.getUnpinnedLeaf(), lookalike);
});

test("the setting is stored as a boolean and defaults to on", async () => {
  for (const [stored, expected] of [[undefined, true], ["false", true], [false, false], [true, true]]) {
    const h = createHarness(stored === undefined ? {} : { openFilesOutsideStickyNotes: stored }, true);
    await h.plugin.onload();
    assert.equal(h.plugin.settings.openFilesOutsideStickyNotes, expected, `stored ${JSON.stringify(stored)}`);
  }
});
