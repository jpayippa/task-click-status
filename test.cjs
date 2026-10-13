// Run with node test.cjs. These are simulated API tests, not in-app UI tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const notices = [];
const menus = [];
class Menu {
  constructor() { this.items = []; menus.push(this); }
  addItem(callback) {
    const item = {
      setTitle(value) { this.title = value; return this; },
      setIcon(value) { this.icon = value; return this; },
      setChecked(value) { this.checked = value; return this; },
      onClick(value) { this.choose = value; return this; }
    };
    callback(item); this.items.push(item); return this;
  }
  onHide(callback) { this.onHideCallback = callback; }
  showAtMouseEvent() { this.shown = true; }
  hide() { this.shown = false; this.onHideCallback?.(); }
}
class Plugin {
  registerEditorExtension(value) { this.extension = value; }
  registerMarkdownPostProcessor(value) { this.processor = value; }
}
const context = {
  module: { exports: {} }, console, setTimeout, clearTimeout,
  require(name) {
    if (name === 'obsidian') return { Plugin, Menu, MarkdownRenderChild: class {}, Notice: class { constructor(s) { notices.push(s); } } };
    if (name === '@codemirror/view') return { ViewPlugin: { fromClass: value => value } };
    throw Error(name);
  }
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8'), context);
const TaskPlugin = context.module.exports;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function dom() {
  const listeners = {};
  return { isConnected: true, listeners,
    addEventListener(type, handler) { listeners[type] = handler; },
    removeEventListener(type) { delete listeners[type]; }
  };
}
function click(element, box, detail = 1) {
  let prevented = false;
  element.listeners.click({ target: box, button: 0, detail,
    preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  return prevented;
}
async function main() {
  const plugin = new TaskPlugin(); plugin.onload();
  let text = '- [ ] Sample';
  const view = { dom: dom(), posAtDOM() { return 0; }, state: {} };
  function refresh() {
    view.state.doc = { lines: 1, lineAt: () => ({ number: 1, from: 0, text }), line: () => ({ number: 1, from: 0, text }) };
  }
  refresh();
  const extension = new plugin.extension(view);
  view.dispatch = ({ changes }) => {
    text = text.slice(0, changes.from) + changes.insert + text.slice(changes.to);
    refresh(); extension.update({ docChanged: true });
  };
  const box = { closest: () => box };
  assert.equal(click(view.dom, box), true);
  assert.equal(text, '- [ ] Sample', 'single action waits for double-click');
  await wait(480); assert.equal(text, '- [x] Sample');
  click(view.dom, box); await wait(480); assert.equal(text, '- [ ] Sample', 'completed task can reopen');
  click(view.dom, box); click(view.dom, box, 2); await wait(10);
  assert.equal(text, '- [-] Sample', 'double click cancels directly');
  await wait(480); assert.equal(text, '- [-] Sample', 'no trailing single action');
  click(view.dom, box); await wait(480); assert.equal(text, '- [ ] Sample', 'cancelled task can reopen');
  for (const original of ['  - [ ] Nested', '> - [ ] Quoted', '12. [ ] Numbered', '* [ ] Asterisk']) {
    text = original; refresh(); click(view.dom, box); await wait(480);
    assert.equal(text, original.replace('[ ]', '[x]'));
  }
  function openMenu(element, target) {
    let prevented = false;
    element.listeners.contextmenu({ target, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
    assert.equal(prevented, true);
    assert.equal(menus.at(-1).shown, true);
    return menus.at(-1);
  }
  text = '- [ ] Menu task'; refresh();
  let menu = openMenu(view.dom, box);
  assert.deepEqual(menu.items.map(item => item.title), ['To do', 'In progress', 'Deferred', 'Done', 'Cancelled']);
  assert.equal(menu.items.find(item => item.title === 'To do').checked, true);
  menu.items.find(item => item.title === 'In progress').choose(); await wait(10);
  assert.equal(text, '- [/] Menu task');
  click(view.dom, box); await wait(480); assert.equal(text, '- [x] Menu task', 'in progress single click completes');
  menu = openMenu(view.dom, box);
  menu.items.find(item => item.title === 'Deferred').choose(); await wait(10);
  assert.equal(text, '- [>] Menu task');
  menu = openMenu(view.dom, box);
  assert.equal(menu.items.find(item => item.title === 'Deferred').checked, true);
  menu.hide();
  click(view.dom, box); await wait(480); assert.equal(text, '- [x] Menu task', 'deferred single click completes');
  for (const status of ['/', '>']) {
    text = `- [${status}] Menu task`; refresh();
    click(view.dom, box); click(view.dom, box, 2); await wait(10);
    assert.equal(text, '- [-] Menu task', 'new statuses double click cancel');
  }
  text = '- [ ] Pending'; refresh(); click(view.dom, box);
  menu = openMenu(view.dom, box);
  menu.items.find(item => item.title === 'Deferred').choose(); await wait(480);
  assert.equal(text, '- [>] Pending', 'menu cancels pending single click');
  menu = openMenu(view.dom, box);
  menu.items.find(item => item.title === 'To do').choose(); await wait(10);
  assert.equal(text, '- [ ] Pending');
  text = '- [?] Custom'; refresh(); assert.equal(click(view.dom, box), false);
  text = '- [ ] Changed'; refresh(); click(view.dom, box);
  text = '- [ ] External edit'; refresh(); extension.update({ docChanged: true });
  await wait(480); assert.equal(text, '- [ ] External edit');
  click(view.dom, box); extension.destroy(); await wait(480);
  assert.equal(text, '- [ ] External edit', 'unload cancels pending click');

  let content = '# Title\r\n\r\n- [ ] Reading task\r\n  - [ ] Child\r\n';
  const file = { extension: 'md' };
  plugin.app = {
    vault: { getAbstractFileByPath: () => file, cachedRead: async () => content,
      process: async (_file, callback) => { content = callback(content); } },
    metadataCache: { getFileCache: () => ({ listItems: [2, 3].map(line => ({ task: ' ', position: { start: { line } } })) }) }
  };
  const reading = dom();
  const boxes = [0, 1].map(() => ({ closest(selector) { return selector === 'input.task-list-item-checkbox' ? this : null; } }));
  reading.closest = () => null;
  reading.querySelectorAll = () => boxes;
  let child;
  await plugin.processor(reading, { sourcePath: 'test.md', getSectionInfo: () => ({ lineStart: 2, lineEnd: 3 }), addChild(value) { child = value; } });
  click(reading, boxes[1]); click(reading, boxes[1], 2); await wait(10);
  assert.equal(content, '# Title\r\n\r\n- [ ] Reading task\r\n  - [-] Child\r\n');
  click(reading, boxes[0]); await wait(480);
  assert.equal(content, '# Title\r\n\r\n- [x] Reading task\r\n  - [-] Child\r\n');
  menu = openMenu(reading, boxes[0]);
  menu.items.find(item => item.title === 'In progress').choose(); await wait(10);
  assert.equal(content, '# Title\r\n\r\n- [/] Reading task\r\n  - [-] Child\r\n');
  menu = openMenu(reading, boxes[1]);
  menu.items.find(item => item.title === 'Deferred').choose(); await wait(10);
  assert.equal(content, '# Title\r\n\r\n- [/] Reading task\r\n  - [>] Child\r\n');
  click(reading, boxes[1]); await wait(480);
  assert.equal(content, '# Title\r\n\r\n- [/] Reading task\r\n  - [x] Child\r\n');
  menu = openMenu(reading, boxes[0]);
  child.onunload(); plugin.onunload();
  assert.equal(menu.shown, false, 'unload hides menu');
  assert.equal(reading.listeners.contextmenu, undefined, 'unload removes right-click handler');
  assert.equal(notices.length, 0);
  console.log('PASS: single/double click, reopen, right-click menus in editor and reading view, in-progress/deferred transitions, pending-click cancellation, nested/quoted/numbered tasks, custom statuses, concurrent edit cancellation, unload cleanup, reading-view mapping, CRLF preservation.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
