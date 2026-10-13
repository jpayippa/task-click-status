# Task Click Status

An Obsidian plugin that gives task checkboxes richer click behavior and five statuses
instead of the default two.

- Single-click an unchecked task: `[x]` (green highlight, no strikethrough).
- Double-click a checkbox within 450 ms: `[-]` (red cross, strikethrough).
- Single-click a completed or cancelled task: `[ ]` (reopen).
- Right-click the checkbox: choose To do, In progress `[/]`, Deferred `[>]`, Done, or Cancelled.
- In progress has a yellow highlight and clock icon; Deferred has a blue highlight and arrow.
- Single-click an in-progress or deferred task to complete it; double-click to cancel it.
- Deferred is a status only: it does not move the task to another note.
- A single click waits briefly to distinguish it from a double click.

Supports ordinary Markdown task checkboxes in Live Preview and Reading view.
Generated task-query results (e.g. from the Tasks or Dataview plugins) and unrecognized
custom task statuses are left alone.

No network access and no external dependencies - it only reads and edits the current
vault's own Markdown files.

## Installing

**Manually:** copy `main.js`, `manifest.json`, and `styles.css` from this repository
into `<your vault>/.obsidian/plugins/task-click-status/`, then restart Obsidian or
toggle **Task Click Status** off and on in Settings > Community plugins.

**Via BRAT:** install the community plugin
[Obsidian42 - BRAT](https://github.com/TfTHacker/obsidian42-brat), then use
"Add a beta plugin" and paste this repository's URL - BRAT installs it and checks for
updates automatically, without needing it listed in Obsidian's official directory.

Either way, enable **Task Click Status** afterward in Settings > Community plugins.
Disabling the plugin restores Obsidian's normal single-click-to-complete behavior.

## Development

`node test.cjs` runs simulated API tests against `main.js` directly (it does not open a
real Obsidian window, so it can't catch a live-UI-only regression).

## Author

Joel Payippara Shibu ([github.com/jpayippa](https://github.com/jpayippa))

## License

[MIT](LICENSE)
