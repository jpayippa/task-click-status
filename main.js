const { Plugin, MarkdownRenderChild, Notice, Menu } = require('obsidian');
const { ViewPlugin } = require('@codemirror/view');

// Matches a Markdown task marker at the start of a list item, e.g. "- [ ]", "  * [x]",
// "> - [/]", or "12. [>]". Capture group 1 is everything up to and including the opening
// "[" (used to compute where the status character sits in the line); group 2 is the
// current status character itself.
const TASK = /^([\t >]*(?:[-+*]|\d+[.)])\s+\[)([ xX/>-])(\])(?=\s|$)/;

// How long (ms) a single click waits before committing, so a second click arriving in
// time can be read as a double-click instead. Tuned to feel instant but still leave room
// for a deliberate double-click; Obsidian itself has no built-in "was this a double click"
// signal for a raw DOM click handler, so this plugin has to detect it manually.
const CLICK_DELAY = 450;

// The five statuses this plugin cycles between, in the order they appear in the
// right-click menu. `value` is the literal character stored inside the task's `[ ]`.
const STATUSES = [
  { value: ' ', title: 'To do', icon: 'square' },
  { value: '/', title: 'In progress', icon: 'clock' },
  { value: '>', title: 'Deferred', icon: 'arrow-right' },
  { value: 'x', title: 'Done', icon: 'check' },
  { value: '-', title: 'Cancelled', icon: 'x' }
];

// Works out what the task's status character should become.
// `action` is one of:
//   - a specific status character (chosen from the right-click menu), or
//   - `true` for "cancel" (double-click), or
//   - `false`/omitted for "toggle" (single click): done <-> to do, unless the task is
//     already done or cancelled, in which case it reopens to "to do".
// Returns null if `line` isn't a recognized task line (e.g. the click landed on a plain
// checkbox that isn't part of a task-list item), so callers can bail out cleanly.
function replacement(line, action) {
  const match = TASK.exec(line);
  if (!match) return null;
  const status = typeof action === 'string' ? action : action ? '-' : /[xX-]/.test(match[2]) ? ' ' : 'x';
  if (!STATUSES.some(item => item.value === status)) throw new Error('Unsupported task status.');
  return { offset: match[1].length, status };
}

// Turns raw click/double-click/right-click DOM events on a task checkbox into a single
// "apply this status" call, written once and shared between the live editor (Live
// Preview/CodeMirror) and the rendered Reading view, which otherwise have completely
// different DOM structures and need to be wired up separately (see onload() below).
//
// The tricky part is telling a single click apart from the first half of a double-click
// without any native browser support for that distinction on non-interactive elements:
// a single click is delayed by CLICK_DELAY so that if a second click lands within that
// window, the timer is cancelled and the pair is treated as one double-click action
// instead of two single-click actions firing back to back.
//
// `resolve(box, event)` is supplied by the caller and turns a clicked checkbox element
// into a `{ key, status, apply(action) }` job describing which task line it corresponds
// to and how to write a new status back to it - the controller itself never touches
// Markdown text directly, so it works identically whether "apply" means editing the live
// CodeMirror document or rewriting the file on disk.
class ClickController {
  constructor(element, resolve) {
    this.element = element;
    this.resolve = resolve;
    // Pending single-click timers, keyed by the task's line number, so a double-click
    // on the SAME task can find and cancel the matching pending single-click timer.
    this.pending = new Map();
    this.destroyed = false;
    this.click = event => {
      const box = event.target?.closest?.('input.task-list-item-checkbox');
      // Ignore anything that isn't a plain left click (modifier keys are left to
      // Obsidian's own default checkbox behavior, e.g. Cmd-click to open in a new pane).
      if (!box || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const job = this.resolve(box, event);
      if (!job) return;
      // Prevent Obsidian's own built-in checkbox toggle from also firing - this plugin
      // owns the status transitions from here on.
      event.preventDefault();
      event.stopImmediatePropagation();
      const previous = this.pending.get(job.key);
      if (previous) {
        // A second click landed on the same task before its timer fired: this is the
        // trailing half of a double-click, so cancel the pending single-click action
        // and immediately run the double-click (cancel) action instead.
        clearTimeout(previous.timer);
        this.pending.delete(job.key);
        this.run(previous.job, true);
      } else if (event.detail === 2) {
        // Some environments (and the test harness) report a double-click as a single
        // `click` event with `detail === 2` rather than two separate click events.
        this.run(job, true);
      } else {
        // First click: wait briefly in case a second click arrives, then commit to the
        // single-click (toggle) action. `detail === 0` means a synthetic/programmatic
        // click (no real pointer device involved), which can't have a trailing second
        // click, so there's nothing to wait for.
        const timer = setTimeout(() => {
          this.pending.delete(job.key);
          this.run(job, false);
        }, event.detail === 0 ? 0 : CLICK_DELAY);
        this.pending.set(job.key, { timer, job });
      }
    };
    this.doubleClick = event => {
      // Browsers that DO send a real `dblclick` event land here; the `click` handler's
      // own `event.detail === 2` branch above covers the ones that don't.
      const box = event.target?.closest?.('input.task-list-item-checkbox');
      if (box && this.resolve(box, event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    this.contextMenu = event => {
      const box = event.target?.closest?.('input.task-list-item-checkbox');
      if (!box) return;
      const job = this.resolve(box, event);
      if (!job) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // Right-clicking should not also leave a pending single-click action queued up
      // from an earlier click on the same task.
      this.cancel();
      const menu = new Menu();
      this.menu = menu;
      for (const status of STATUSES) {
        menu.addItem(item => item.setTitle(status.title).setIcon(status.icon)
          .setChecked(job.status.toLowerCase() === status.value)
          .onClick(() => this.run(job, status.value)));
      }
      menu.onHide(() => { if (this.menu === menu) this.menu = null; });
      menu.showAtMouseEvent(event);
    };
    // The `true` (capture phase) argument matters: it lets this plugin intercept the
    // click before Obsidian's own checkbox handler sees it, so `preventDefault()` and
    // `stopImmediatePropagation()` above can actually stop the default toggle behavior.
    element.addEventListener('click', this.click, true);
    element.addEventListener('dblclick', this.doubleClick, true);
    element.addEventListener('contextmenu', this.contextMenu, true);
  }
  // Applies a job's action asynchronously and reports any failure as a Notice rather
  // than letting it disappear into an unhandled promise rejection - `apply()` can throw
  // (e.g. "the task changed while you were clicking"), and the user needs to see that.
  run(job, action) {
    Promise.resolve().then(() => { if (!this.destroyed) return job.apply(action); }).catch(error => {
      console.error('Task Click Status:', error);
      new Notice('Task was not changed: ' + error.message);
    });
  }
  // Clears any pending single-click timer and closes an open right-click menu, without
  // tearing down the controller itself. Used both mid-interaction (see contextMenu
  // above) and as part of destroy().
  cancel() {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    if (this.menu) this.menu.hide();
  }
  // Removes this controller's event listeners and prevents any in-flight timer from
  // applying a change after the editor/element it was attached to has gone away.
  destroy() {
    this.destroyed = true;
    this.cancel();
    this.element.removeEventListener('click', this.click, true);
    this.element.removeEventListener('dblclick', this.doubleClick, true);
    this.element.removeEventListener('contextmenu', this.contextMenu, true);
  }
}

module.exports = class TaskClickStatus extends Plugin {
  onload() {
    const plugin = this;
    // Every live ClickController, across every open editor pane and every rendered
    // Reading-view note, so onunload() can clean all of them up at once.
    this.controllers = new Set();

    // --- Live Preview / editing view -----------------------------------------------
    // A CodeMirror ViewPlugin gets one instance per editor pane and is rebuilt whenever
    // that pane's content changes substantially, so a ClickController is created and
    // destroyed alongside it rather than being managed by hand.
    this.registerEditorExtension(ViewPlugin.fromClass(class {
      constructor(view) {
        this.controller = new ClickController(view.dom, box => {
          // Only react to checkboxes CodeMirror itself has recognized as task lines;
          // anything else (e.g. a checkbox rendered by another plugin) is left alone.
          if (!box.closest('.HyperMD-task-line')) return null;
          let position;
          try { position = view.posAtDOM(box); } catch (_) { return null; }
          const line = view.state.doc.lineAt(position);
          if (!TASK.test(line.text)) return null;
          return {
            key: line.number,
            status: TASK.exec(line.text)[2],
            apply(action) {
              // Re-check the document hasn't moved out from under this click: the line
              // count may have shrunk, or - more commonly - CLICK_DELAY's wait let the
              // user (or another process) edit the line before the action committed.
              if (!view.dom.isConnected || line.number > view.state.doc.lines) return;
              const current = view.state.doc.line(line.number);
              if (current.text !== line.text) throw new Error('The task changed while you were clicking. Please try again.');
              const change = replacement(current.text, action);
              const from = current.from + change.offset;
              view.dispatch({ changes: { from, to: from + 1, insert: change.status } });
            }
          };
        });
        plugin.controllers.add(this.controller);
      }
      update(update) {
        // If the document changed since the click started (e.g. the user kept typing),
        // the pending single-click action's captured line number/text may no longer be
        // valid - drop it rather than risk applying a status change to the wrong line.
        if (update.docChanged) this.controller.cancel();
      }
      destroy() {
        this.controller.destroy();
        plugin.controllers.delete(this.controller);
      }
    }));

    // --- Reading view -----------------------------------------------------------
    // Reading view re-renders a note's Markdown to static HTML, so there's no live
    // CodeMirror document to edit here - instead, this maps each rendered checkbox back
    // to its source line number (via Obsidian's metadata cache) and edits the file
    // directly with `vault.process()`.
    this.registerMarkdownPostProcessor(async (element, context) => {
      // Live Preview's checkboxes are handled by the CodeMirror extension above; this
      // post-processor only needs to handle genuine Reading view.
      if (element.closest('.markdown-source-view')) return;
      const boxes = [...element.querySelectorAll('input.task-list-item-checkbox')]
        // Skip checkboxes that belong to the Tasks or Dataview plugins, or to embedded
        // notes - their own plugins (or the embed's source note) own those checkboxes.
        .filter(box => !box.closest('.internal-embed, .block-language-tasks, .block-language-dataview'));
      if (!boxes.length) return;
      const file = this.app.vault.getAbstractFileByPath(context.sourcePath);
      if (!file || file.extension !== 'md') return;
      const section = context.getSectionInfo(element);
      const cache = this.app.metadataCache.getFileCache(file);
      if (!section || !cache?.listItems) return;
      const items = cache.listItems.filter(item => item.task !== undefined &&
        item.position.start.line >= section.lineStart && item.position.start.line <= section.lineEnd);
      // The rendered checkboxes and the cached task list-items for this section should
      // line up 1:1. If they don't (a generated or partially rendered list, e.g. from a
      // query block), there's no reliable way to map a checkbox back to a source line,
      // so leave those checkboxes with Obsidian's normal default behavior instead of
      // risking editing the wrong task.
      if (items.length !== boxes.length) return;
      const source = await this.app.vault.cachedRead(file);
      const lines = source.split(/\r?\n/);
      // Snapshot each checkbox's source line/text up front, rather than re-reading the
      // file on every click, so a click can detect "the file changed since render" by
      // comparing against this snapshot (see `apply()` below).
      const targets = new Map(boxes.map((box, i) => [box, {
        line: items[i].position.start.line,
        text: lines[items[i].position.start.line]
      }]));
      const app = this.app;
      const controller = new ClickController(element, box => {
        const target = targets.get(box);
        if (!target || !TASK.test(target.text)) return null;
        return {
          key: target.line,
          status: TASK.exec(target.text)[2],
          async apply(action) {
            if (!element.isConnected) return;
            const change = replacement(target.text, action);
            await app.vault.process(file, content => {
              // Split on line breaks while keeping them as their own array entries, so
              // the file's original line-ending style (LF or CRLF) is preserved exactly
              // instead of being normalized away.
              const parts = content.split(/(\r?\n)/);
              const index = target.line * 2;
              if (parts[index] !== target.text) throw new Error('The note changed. Reopen it and try again.');
              parts[index] = target.text.slice(0, change.offset) + change.status + target.text.slice(change.offset + 1);
              target.text = parts[index];
              return parts.join('');
            });
          }
        };
      });
      this.controllers.add(controller);
      // Tying the controller's lifetime to a MarkdownRenderChild means Obsidian will
      // call onunload() automatically when this rendered block is replaced or removed,
      // so the click/dblclick/contextmenu listeners never outlive the DOM they're on.
      const child = new MarkdownRenderChild(element);
      child.onunload = () => {
        controller.destroy();
        this.controllers.delete(controller);
      };
      context.addChild(child);
    });
  }
  onunload() {
    for (const controller of this.controllers) controller.destroy();
    this.controllers.clear();
  }
};
