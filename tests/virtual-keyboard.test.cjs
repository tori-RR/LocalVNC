const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const KeyTable = require('../node_modules/@novnc/novnc/lib/input/keysym.js').default;
const source = fs.readFileSync(path.join(__dirname, '../src/virtual-keyboard.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const context = vm.createContext({ KeyTable });
vm.runInContext(`${source}\nthis.create = createVirtualKeyboard;`, context);

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.listeners = [];
    this.dataset = {};
    this.attributes = {};
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
    this.hidden = false;
    this.disabled = false;
  }
  append(...elements) { for (const element of elements) { element.parentElement = this; this.children.push(element); } }
  remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, handler) { this.listeners.push({ type, handler }); }
  removeEventListener(type, handler) { this.listeners = this.listeners.filter(item => item.type !== type || item.handler !== handler); }
  fire(type, overrides = {}) {
    const event = { target: this, button: 0, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides };
    for (let element = this; element && !event.stopped; element = element.parentElement) {
      for (const { handler } of element.listeners.filter(item => item.type === type)) handler(event);
    }
    return event;
  }
  all() { return [this, ...this.children.flatMap(child => child.all())]; }
}
function environment(options = {}) {
  const container = new Element();
  const packets = [], visibility = [];
  let preparations = 0;
  const api = context.create({ container,
    sendKey(keysym, code, down) { packets.push([keysym, code, down]); options.sendKey?.(keysym, code, down); },
    beforeSend() { preparations++; return options.beforeSend?.(); },
    onVisibilityChange(value) { visibility.push(value); },
    dependencies: { document: { createElement: tag => new Element(tag) } },
  });
  const root = container;
  const key = code => root.all().find(element => element.dataset.code === code);
  const status = () => root.all().find(element => element.className === 'vk-status').textContent;
  const click = code => key(code).fire('click');
  const ready = () => api.setState({ connected: true, canControl: true, readOnly: false });
  return { api, container, root, key, status, click, ready, packets, visibility,
    get preparations() { return preparations; } };
}
function openReady(env) { env.ready(); env.api.toggle(); }
const stroke = (symbol, code) => [[symbol, code, true], [symbol, code, false]];

for (const modifiers of [['ControlLeft'], ['ControlLeft', 'ShiftLeft'], ['AltLeft'], ['MetaLeft']]) {
  test(`F04 Caps preserves explicit shortcut modifiers: ${modifiers.join('+')}`, () => {
    const env = environment(); openReady(env);
    env.click('CapsLock');
    for (const code of modifiers) env.click(code);
    env.click('KeyC');
    assert.deepEqual(env.packets.filter(packet => packet[2]).map(packet => packet[1]), [...modifiers, 'KeyC']);
    assert.deepEqual(env.packets.filter(packet => !packet[2]).map(packet => packet[1]), ['KeyC', ...modifiers.toReversed()]);
  });
}

test('opening and closing only change visibility and never send a remote shortcut', () => {
  const env = environment();
  assert.equal(env.root.hidden, true);
  env.api.toggle();
  assert.equal(env.root.hidden, false);
  assert.equal(env.api.visible, true);
  assert.equal(env.root.dataset.state, 'disconnected');
  assert.equal(env.status(), '连接后可使用');
  assert.equal(env.key('KeyA').disabled, true);
  env.api.hide(); env.api.hide();
  assert.deepEqual(env.visibility, [true, false]);
  assert.deepEqual(env.packets, []);
  assert.equal(env.preparations, 0);
});

test('layout includes desktop function keys, editing keys and all arrows with no CAD command', () => {
  const env = environment();
  const expected = ['Escape', 'Backspace', 'Tab', 'Enter', 'CapsLock', 'ShiftLeft', 'ShiftRight',
    'ControlLeft', 'AltLeft', 'MetaLeft', 'Space', 'Delete', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight',
    ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)];
  for (const code of expected) assert.ok(env.key(code), code);
  for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') assert.ok(env.key(`Key${letter}`));
  assert.equal(env.root.all().filter(element => element.className?.startsWith('vk-row ')
    || element.className === 'vk-row').length, 6);
  assert.ok(env.root.all().every(element => !String(element.textContent).includes('Ctrl+Alt+Del')));
  assert.ok(env.root.all().filter(element => element.dataset.code).every(element => element.type === 'button'));
});

test('ordinary characters, navigation and function keys use installed noVNC keysyms', () => {
  const env = environment(); openReady(env);
  for (const code of ['KeyA', 'Digit0', 'Space', 'Backspace', 'Tab', 'Enter', 'Escape', 'Delete', 'ArrowLeft', 'F12']) env.click(code);
  assert.deepEqual(env.packets, [
    ...stroke(0x61, 'KeyA'), ...stroke(0x30, 'Digit0'), ...stroke(0x20, 'Space'),
    ...stroke(KeyTable.XK_BackSpace, 'Backspace'), ...stroke(KeyTable.XK_Tab, 'Tab'),
    ...stroke(KeyTable.XK_Return, 'Enter'), ...stroke(KeyTable.XK_Escape, 'Escape'),
    ...stroke(KeyTable.XK_Delete, 'Delete'), ...stroke(KeyTable.XK_Left, 'ArrowLeft'),
    ...stroke(KeyTable.XK_F12, 'F12'),
  ]);
  assert.equal(env.preparations, 10);
});

test('modifiers are local until a character click, then release in reverse order and reset', () => {
  const env = environment(); openReady(env);
  env.click('ControlLeft'); env.click('AltLeft'); env.click('MetaLeft'); env.click('ShiftLeft');
  assert.deepEqual(env.packets, []);
  assert.equal(env.key('KeyA').dataset.key, 'A');
  assert.equal(env.key('ShiftRight').attributes['aria-pressed'], 'true');
  env.click('KeyA');
  assert.deepEqual(env.packets, [
    [KeyTable.XK_Control_L, 'ControlLeft', true], [KeyTable.XK_Alt_L, 'AltLeft', true],
    [KeyTable.XK_Super_L, 'MetaLeft', true], [KeyTable.XK_Shift_L, 'ShiftLeft', true],
    [0x41, 'KeyA', true], [0x41, 'KeyA', false],
    [KeyTable.XK_Shift_L, 'ShiftLeft', false], [KeyTable.XK_Super_L, 'MetaLeft', false],
    [KeyTable.XK_Alt_L, 'AltLeft', false], [KeyTable.XK_Control_L, 'ControlLeft', false],
  ]);
  assert.equal(env.key('ShiftLeft').attributes['aria-pressed'], 'false');
  assert.equal(env.key('ControlLeft').attributes['aria-pressed'], 'false');
  assert.equal(env.key('KeyA').dataset.key, 'a');
  env.packets.length = 0;
  env.click('KeyA');
  assert.deepEqual(env.packets, stroke(0x61, 'KeyA'));
});

test('modifier toggle cancels locally and Shift applies the correct punctuation keysym', () => {
  const env = environment(); openReady(env);
  env.click('ControlLeft'); env.click('ControlLeft');
  assert.equal(env.key('ControlLeft').attributes['aria-pressed'], 'false');
  env.click('ShiftRight'); env.click('Digit2');
  assert.deepEqual(env.packets, [[KeyTable.XK_Shift_L, 'ShiftLeft', true],
    [0x40, 'Digit2', true], [0x40, 'Digit2', false], [KeyTable.XK_Shift_L, 'ShiftLeft', false]]);
});

test('Caps is local and repeats effective Shift chords for QEMU scancodes without remote CapsLock', () => {
  const env = environment(); openReady(env);
  env.click('CapsLock');
  assert.deepEqual(env.packets, []);
  env.click('KeyA'); env.click('KeyB'); env.click('Digit1');
  assert.deepEqual(env.packets, [
    [KeyTable.XK_Shift_L, 'ShiftLeft', true], [0x41, 'KeyA', true],
    [0x41, 'KeyA', false], [KeyTable.XK_Shift_L, 'ShiftLeft', false],
    [KeyTable.XK_Shift_L, 'ShiftLeft', true], [0x42, 'KeyB', true],
    [0x42, 'KeyB', false], [KeyTable.XK_Shift_L, 'ShiftLeft', false], ...stroke(0x31, 'Digit1'),
  ]);
  assert.equal(env.key('CapsLock').attributes['aria-pressed'], 'true');
  assert.ok(env.packets.every(packet => packet[0] !== KeyTable.XK_Caps_Lock));
  env.packets.length = 0;
  env.click('ShiftLeft'); env.click('KeyA');
  assert.deepEqual(env.packets, stroke(0x61, 'KeyA'));
  assert.equal(env.key('KeyA').dataset.key, 'A');
});

test('paused, read-only, disconnected and hidden states reject even programmatic clicks', () => {
  const env = environment(); openReady(env);
  for (const next of [
    { connected: true, canControl: false, readOnly: false },
    { connected: true, canControl: true, readOnly: true },
    { connected: false, canControl: true, readOnly: false },
  ]) {
    env.api.setState(next);
    env.click('KeyA'); env.click('ControlLeft');
    assert.equal(env.key('KeyA').disabled, true);
    assert.equal(env.key('ControlLeft').attributes['aria-pressed'], 'false');
  }
  env.ready(); env.api.hide(); env.click('KeyA');
  assert.deepEqual(env.packets, []);
  assert.equal(env.preparations, 0);
});

test('losing control clears Caps and modifiers but keeps the keyboard open with a recovery hint', () => {
  const env = environment(); openReady(env);
  env.click('CapsLock'); env.click('ShiftLeft'); env.click('ControlLeft');
  env.api.setState({ connected: true, canControl: false, readOnly: false });
  assert.equal(env.api.visible, true);
  assert.equal(env.status(), '点击画面恢复控制');
  for (const code of ['CapsLock', 'ShiftLeft', 'ControlLeft']) assert.equal(env.key(code).attributes['aria-pressed'], 'false');
  env.ready(); env.click('KeyA');
  assert.deepEqual(env.packets, stroke(0x61, 'KeyA'));
});

test('hidden keyboard discards modifier choices and emits one visibility change', () => {
  const env = environment(); openReady(env);
  env.click('CapsLock'); env.click('AltLeft');
  env.root.all().find(element => element.className === 'vk-hide').fire('click');
  env.api.toggle(); env.click('KeyA');
  assert.deepEqual(env.visibility, [true, false, true]);
  assert.deepEqual(env.packets, stroke(0x61, 'KeyA'));
});

test('preparation can refuse input and clears choices without sending any stroke', () => {
  const env = environment({ beforeSend: () => false }); openReady(env);
  env.click('CapsLock'); env.click('ControlLeft'); env.click('KeyA');
  assert.deepEqual(env.packets, []);
  assert.equal(env.preparations, 1);
  assert.equal(env.key('CapsLock').attributes['aria-pressed'], 'false');
  assert.equal(env.key('ControlLeft').attributes['aria-pressed'], 'false');
});

test('preparation exceptions or synchronous control loss cannot send a chord', () => {
  const failed = environment({ beforeSend: () => { throw new Error('focus race'); } }); openReady(failed);
  failed.click('KeyA'); assert.deepEqual(failed.packets, []);
  assert.match(failed.status(), /按键发送失败/);
  const paused = environment({ beforeSend: () => { paused.api.setState({ connected: true, canControl: false }); return true; } });
  openReady(paused); paused.click('KeyA'); assert.deepEqual(paused.packets, []);
});

test('down failure still releases the ordinary key and every held modifier in reverse order', () => {
  const env = environment({ sendKey(symbol, code, down) { if (code === 'KeyA' && down) throw new Error('socket failed'); } });
  openReady(env); env.click('ControlLeft'); env.click('ShiftLeft'); env.click('KeyA');
  assert.deepEqual(env.packets, [
    [KeyTable.XK_Control_L, 'ControlLeft', true], [KeyTable.XK_Shift_L, 'ShiftLeft', true],
    [0x41, 'KeyA', true], [0x41, 'KeyA', false], [KeyTable.XK_Shift_L, 'ShiftLeft', false],
    [KeyTable.XK_Control_L, 'ControlLeft', false],
  ]);
  assert.match(env.status(), /按键发送失败/);
  assert.equal(env.key('ControlLeft').attributes['aria-pressed'], 'false');
});

test('release failure does not skip remaining held modifiers', () => {
  const env = environment({ sendKey(symbol, code, down) { if (!down && code === 'KeyA') throw new Error('release failed'); } });
  openReady(env); env.click('ControlLeft'); env.click('KeyA');
  assert.deepEqual(env.packets, [[KeyTable.XK_Control_L, 'ControlLeft', true],
    [0x61, 'KeyA', true], [0x61, 'KeyA', false], [KeyTable.XK_Control_L, 'ControlLeft', false]]);
});

test('pointer interaction preserves focus, while native Enter/Space activation sends only one click', () => {
  const env = environment(); openReady(env);
  assert.equal(env.key('KeyA').fire('pointerdown', { pointerType: 'touch' }).defaultPrevented, true);
  assert.equal(env.key('KeyA').fire('mousedown').defaultPrevented, true);
  assert.equal(env.key('KeyA').fire('pointerdown', { button: 2 }).defaultPrevented, false);
  for (const key of ['Enter', ' ']) {
    const down = env.key('KeyA').fire('keydown', { key });
    const up = env.key('KeyA').fire('keyup', { key });
    assert.equal(down.defaultPrevented, false);
    assert.equal(down.stopped, true);
    assert.equal(up.stopped, true);
    // Browser supplies the button's native click; no handwritten key handler
    // is permitted to send a duplicate key before it.
    assert.equal(env.packets.length, key === 'Enter' ? 0 : 2);
    env.click('KeyA');
  }
  assert.deepEqual(env.packets, [...stroke(0x61, 'KeyA'), ...stroke(0x61, 'KeyA')]);
});

test('dispose removes the UI and event listeners and permanently rejects input', () => {
  const env = environment(); openReady(env);
  const key = env.key('KeyA');
  env.api.dispose(); env.api.dispose();
  key.fire('click'); env.api.toggle(); env.ready();
  assert.equal(env.container.children.length, 0);
  assert.ok(env.root.all().every(element => element.listeners.length === 0));
  assert.deepEqual(env.visibility, [true, false]);
  assert.deepEqual(env.packets, []);
});
