# Desktop Sticky Notes

An Obsidian desktop-only plugin that opens real Markdown files in resizable sticky-note popout windows.

## Commands

- **Create sticky note** — creates a Markdown file in the configured folder and opens it.
- **Open sticky note for current file** — opens the active Markdown file as a sticky note.
- **Hide sticky note for current file** — closes all sticky-note windows for the active file.
- **Set current file as top-level sticky note** — designates the active Markdown file as the top-level note.
- **Toggle top-level sticky note** — opens the designated note, brings it forward when it is behind another window, or hides it when it is already focused. It safely does nothing when no valid top-level file exists.

Each sticky-note window has controls for keeping it above other applications, selecting a color, switching between edit and reading views, and hiding it. Window contents are the underlying Obsidian Markdown file, so edits and previews stay in sync with the vault.

Sticky-note windows left open when Obsidian quits or reloads regain their styling, saved color, and controls when Obsidian restores the workspace, including after closing the main window. Restoration waits for Electron's native windows and retries for a few seconds while popouts load. Their size, position, and edit/reading view are restored by Obsidian. Ordinary popout windows, including ones displaying the same file, remain ordinary windows.

As of version 1.0.6, each sticky window saves its identity in Obsidian's workspace state. Restoration also accepts the window IDs saved by earlier versions, but no longer depends on that separate settings record being present or the IDs staying the same.

As of version 1.0.7, **Reload app without saving** and hotkeys assigned to that command perform an orderly reload during a sticky-note session. The plugin saves the current workspace, pending text edits, and plugin settings, runs Obsidian's normal popout shutdown, then reloads. This prevents old popouts from surviving alongside their restored replacements. Closing a sticky note with its standard window close button or its hide control keeps it closed after the next reload, including during startup before its sticky controls appear. If saving fails or a popout refuses to close, reload stops with a notice.

Fully quit Obsidian before installing 1.0.7 to clear orphaned windows left by older reloads. This is a one-time upgrade step.

If a window already lost its sticky-note controls before installing this fix, close that window and use **Open sticky note for current file** once after updating. A previously unmarked regular window cannot be distinguished safely from an ordinary popout of the same file.

> [!NOTE]
> On Linux, **Keep on top** works when Obsidian runs under X11 or XWayland. Electron does not support the required always-on-top window state under native Wayland, so the pin control cannot change window stacking in a native Wayland session.

## Settings

- **Default notes folder** — where newly created sticky-note files are stored; defaults to the vault root.
- **Default note color** — the initial background color for notes without a saved custom color.
- **Collapsible sticky notes** — adds a collapse control to every sticky-note window. Collapsing shrinks the window to its header, and expanding restores the height the window had before it was collapsed. A collapsed window cannot be resized; expanding makes it resizable again. Windows open expanded again after they are hidden or after Obsidian restarts. Off by default. A collapsed window keeps showing the note name in its header. CSS snippets can hook into the `desktop-sticky-note-collapsible` body class, present while the setting is on, and `desktop-sticky-note-collapsed`, present while a window is collapsed. Under native Wayland, Electron may be unable to resize a window programmatically; the plugin reads the size back and cancels the collapse when the window did not shrink.
- **Global toggle shortcut** — toggles the top-level sticky note even when Obsidian is in the background. Click the recorder and press the desired combination, or clear it to disable the shortcut. The default is `Win+F10` on Windows, `Super+F10` on Linux, and `Option+F10` on macOS. The plugin stores this setting separately for each operating system, so syncing a vault between computers does not translate one platform's shortcut into another platform's keys.
- **Top-level note** — the Markdown file controlled by the toggle command and global shortcut.

## Installation

Copy `manifest.json`, `main.js`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/desktop-sticky-notes/
```

Then enable **Desktop Sticky Notes** under Obsidian's community-plugin settings. This plugin requires Obsidian desktop 1.5.1 or newer.

## Permissions and privacy

Desktop Sticky Notes uses Obsidian's Electron APIs to manage popout windows and register the optional system-wide shortcut. It only creates or edits Markdown files inside your vault through the Obsidian API. It does not access files outside the vault, make network requests, collect telemetry, or send data anywhere.

## License

Desktop Sticky Notes is available under the [MIT License](LICENSE).

## Development

Run `npm test`, `npm run check`, `npm run lint`, and `npm run build` to verify a change. The tests exercise the plugin lifecycle with simulated Obsidian and Electron APIs; they do not launch Obsidian.

To check restart behavior in Obsidian, open two sticky notes and an ordinary popout of the same file, change a sticky note's color and reading view, then close the main window with the popouts still open and relaunch Obsidian. Confirm that the sticky notes retain their appearance and working controls, that the ordinary popout is unchanged, and that hiding a sticky note keeps it closed after the next restart. In a disposable test vault, also remove `stickyNoteLeafIds` from the plugin's `data.json` while Obsidian is closed and confirm that the workspace markers still restore the sticky windows. Also check **Reload app without saving**, and disabling/re-enabling the plugin (which closes its windows). With a top-level note designated and its windows closed, verify that the global shortcut opens, hides, and reopens it, including after a restart.

The persistence and reload compatibility constraints are documented in the architecture records for [workspace identity](docs/decisions/0001-sticky-workspace-identity.md) and [in-app reload](docs/decisions/0002-orderly-in-app-reload.md).
