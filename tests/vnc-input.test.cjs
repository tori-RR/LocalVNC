const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/vnc-input.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const apiContext = vm.createContext({});
vm.runInContext(`${source}\nthis.create = createVncInputGuard;`, apiContext);
const novnc = path.join(__dirname, '../node_modules/@novnc/novnc');
const rfbSource = fs.readFileSync(path.join(novnc, 'lib/rfb.js'), 'utf8');

class Element {
  constructor() { this.listeners = []; this.children = []; this.hidden = false; this.attributes = {};
    this.classList = { toggle() {} }; }
  append(element) { element.parentElement = this; this.children.push(element); }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, fn, options = false) { this.listeners.push({ type, fn, capture: typeof options === 'boolean' ? options : !!options.capture }); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter(item => item.type !== type || item.fn !== fn); }
  getBoundingClientRect() { return { left: 10, top: 20, right: 410, bottom: 320, width: 400, height: 300 }; }
  fire(type, data = {}) {
    const event = { type, target: this, relatedTarget: null, button: 0, buttons: 0, pointerId: 1, isPrimary: true,
      detail: 1, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; }, ...data };
    const parents = [];
    for (let element = this; element; element = element.parentElement) parents.push(element);
    for (const [elements, capture] of [[parents.slice().reverse(), true], [parents, false]]) {
      for (const element of elements) {
        for (const listener of element.listeners.filter(item => item.type === type && item.capture === capture)) {
          if (!event.stopped) listener.fn(event);
        }
        if (event.stopped) break;
      }
      if (event.stopped) break;
    }
    return event;
  }
}

function environment({ version = '1.6.0' } = {}) {
  const doc = new Element(), win = new Element(), stage = new Element(), screen = new Element(), canvas = new Element();
  const cad = new Element(), outside = new Element();
  doc.append(stage); stage.append(screen); screen.append(canvas); doc.append(cad); doc.append(outside);
  doc.createElement = () => new Element(); doc.hasFocus = () => doc.focused; doc.focused = true;
  const timers = new Map(); let timerId = 0;
  const fakeSetTimeout = callback => { timers.set(++timerId, callback); return timerId; };
  const fakeClearTimeout = id => timers.delete(id);
  function installedModule(relative, dependencies = {}) {
    const moduleContext = vm.createContext({ exports: {}, window: win, document: doc,
      setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
      require(name) { return dependencies[name] || {}; } });
    vm.runInContext(fs.readFileSync(path.join(novnc, relative), 'utf8'), moduleContext);
    return moduleContext.exports;
  }
  const Keyboard = installedModule('lib/input/keyboard.js', {
    '../util/logging.js': { Debug() {} }, '../input/keysym.js': {},
    './keysym.js': { XK_Control_L: 0xffe3 },
  }).default;
  const Gesture = installedModule('lib/input/gesturehandler.js').default;
  const clientToElement = installedModule('lib/util/element.js').clientToElement;
  const packets = [];
  const session = { _canvas: canvas, _mouseMoveTimer: null, _mouseButtonMask: 0, _mousePos: {}, _viewOnly: false,
    _rfbConnectionState: 'connected', _display: { absX: x => x, absY: y => y }, _sock: {},
    focusOnClick: true, disconnects: 0, focusCalls: 0, blurCalls: 0,
    sendKey(keysym, code, down) { if (!this._viewOnly) packets.push({ type: 'key', keysym, code, down }); },
    focus() { this.focusCalls++; doc.activeElement = canvas; canvas.fire('focusin'); },
    blur() { this.blurCalls++; if (doc.activeElement === canvas) { doc.activeElement = null; canvas.fire('focusout'); } },
    disconnect() { this.disconnects++; },
  };
  session._keyboard = new Keyboard(canvas);
  session._keyboard.onkeyevent = session.sendKey.bind(session);
  session._gestures = new Gesture(); session._gestures.attach(canvas);
  // Exercise the actual pinned noVNC setter and wire pointer method, including
  // their viewOnly suppression, rather than a test-only "release" implementation.
  const methodContext = vm.createContext({ RFB: { messages: {
    pointerEvent(sock, x, y, mask) { packets.push({ type: 'pointer', x, y, mask }); },
  } } });
  session._sendMouse = vm.runInContext(`(${rfbSource.match(/key: "_sendMouse",\s*value: (function _sendMouse\([\s\S]*?\n    })\n  }/)[1]})`, methodContext);
  const setter = vm.runInContext(`(${rfbSource.match(/set: (function set\(viewOnly\)[\s\S]*?\n    })\n  }/)[1]})`, methodContext);
  Object.defineProperty(session, 'viewOnly', { get() { return this._viewOnly; }, set: setter });
  let releases = 0;
  const changes = [];
  const guard = apiContext.create({ screen, allowControlTargets: [cad], onChange: state => changes.push(state), dependencies: {
    document: doc, window: win, GestureHandler: Gesture, clientToElement,
    noVncVersion: version, clearTimeout: fakeClearTimeout,
    releaseCapture() { releases++; doc.captureElement = null; },
  } });
  const overlay = stage.children.find(child => child !== screen);
  function activate() {
    overlay.fire('pointerdown', { buttons: 1 });
    overlay.fire('mousedown', { buttons: 1 });
    overlay.fire('pointerup'); overlay.fire('mouseup'); overlay.fire('click');
  }
  return { guard, session, doc, win, screen, canvas, cad, outside, overlay, packets, changes, timers,
    fakeSetTimeout, activate, get releases() { return releases; } };
}

test('the narrow release adapter is pinned to installed noVNC 1.6.0', () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(novnc, 'package.json'), 'utf8')).version, '1.6.0');
  const env = environment({ version: '2.0.0' });
  env.guard.attach(env.session); env.activate();
  assert.equal(env.guard.canControl, false);
  assert.equal(env.session.viewOnly, true);
  assert.match(env.overlay.children[0].textContent, /版本/);
  env.guard.dispose();
});

test('initial control requires a complete primary click and its down/up/click never reach noVNC', () => {
  const env = environment();
  const leaked = [];
  for (const event of ['mousedown', 'mouseup', 'click', 'wheel', 'keydown', 'touchstart']) {
    env.canvas.addEventListener(event, () => leaked.push(event));
  }
  env.guard.attach(env.session);
  env.canvas.fire('mousedown', { buttons: 1 }); env.canvas.fire('wheel'); env.canvas.fire('keydown');
  env.overlay.fire('click', { detail: 0 }); env.overlay.fire('keydown', { key: 'Enter' });
  assert.equal(env.guard.canControl, false);
  assert.equal(env.overlay.fire('keydown', { key: 'Tab' }).defaultPrevented, false);
  env.activate();
  assert.equal(env.guard.canControl, true);
  assert.equal(env.overlay.hidden, true);
  assert.equal(env.session.focusCalls, 1);
  assert.deepEqual(leaked, []);
  env.canvas.fire('mousedown', { buttons: 1 });
  assert.deepEqual(leaked, ['mousedown']);
  env.guard.dispose();
});

for (const key of ['Enter', ' ']) {
  test(`focused ${JSON.stringify(key)} activation consumes the complete confirmation before grabbing remote input`, () => {
    const env = environment(); env.guard.attach(env.session); env.doc.activeElement = env.overlay;
    const down = env.overlay.fire('keydown', { key });
    assert.equal(down.defaultPrevented, true);
    assert.equal(env.guard.canControl, false);
    env.overlay.fire('keydown', { key, repeat: true });
    const up = env.overlay.fire('keyup', { key });
    assert.equal(up.defaultPrevented, true);
    assert.equal(env.guard.canControl, true);
    assert.equal(env.doc.activeElement, env.canvas);
    assert.deepEqual(env.packets, []);
    env.overlay.fire('click', { detail: 0 });
    assert.equal(env.session.focusCalls, 1);
    env.guard.dispose();
  });
}

test('keyboard grants reject repeat-only, incomplete, modified, mismatched, blurred and unfocused confirmations', () => {
  for (const reason of ['repeat', 'release-only', 'mismatch', 'modifier', 'focusout', 'blur', 'unfocused', 'hidden', 'read-only']) {
    const env = environment(); env.guard.attach(env.session); env.doc.activeElement = env.overlay;
    if (reason === 'read-only') env.guard.setReadOnly(true);
    if (reason === 'unfocused') env.doc.activeElement = env.outside;
    if (reason !== 'release-only') env.overlay.fire('keydown', { key: 'Enter', repeat: reason === 'repeat', ctrlKey: reason === 'modifier' });
    if (reason === 'focusout') { env.overlay.fire('focusout'); env.doc.activeElement = env.overlay; }
    if (reason === 'blur') env.win.fire('blur');
    if (reason === 'hidden') env.doc.hidden = true;
    env.overlay.fire('keyup', { key: reason === 'mismatch' ? ' ' : 'Enter' });
    env.overlay.fire('click', { detail: 0 });
    assert.equal(env.guard.canControl, false, reason);
    assert.deepEqual(env.packets, [], reason);
    env.guard.dispose();
  }
});

test('blur releases held modifier keys before viewOnly suppresses key-up packets', () => {
  const env = environment();
  env.guard.attach(env.session); env.activate();
  env.session._keyboard._sendKeyEvent(0xffe3, 'ControlLeft', true);
  env.session._keyboard._sendKeyEvent(0xffe9, 'AltLeft', true);
  env.win.fire('blur');
  assert.deepEqual(env.packets.filter(packet => packet.type === 'key').map(packet => [packet.code, packet.down]),
    [['ControlLeft', true], ['AltLeft', true], ['ControlLeft', false], ['AltLeft', false]]);
  assert.equal(env.session.viewOnly, true);
  assert.equal(env.guard.canControl, false);
  assert.equal(env.session.disconnects, 0);
  env.win.fire('focus'); env.canvas.fire('focusin');
  assert.equal(env.guard.canControl, false);
  env.guard.dispose();
});

test('touch activation preserves its final click without forwarding the activation gesture', () => {
  const env = environment();
  env.guard.attach(env.session);
  env.overlay.fire('pointerdown', { buttons: 1, pointerType: 'touch' });
  const start = env.overlay.fire('touchstart', { touches: [{}] });
  assert.equal(start.defaultPrevented, false);
  assert.equal(start.stopped, true);
  env.overlay.fire('pointerup', { pointerType: 'touch' });
  env.overlay.fire('touchend', { touches: [] });
  assert.equal(env.guard.canControl, false);
  env.overlay.fire('click');
  assert.equal(env.guard.canControl, true);
  assert.deepEqual(env.packets, []);
  env.guard.dispose();
});

test('blur cancels delayed AltGr control and sends its balanced release', () => {
  const env = environment();
  env.guard.attach(env.session); env.activate();
  const keyboard = env.session._keyboard;
  keyboard._altGrArmed = true;
  keyboard._altGrTimeout = env.fakeSetTimeout(() => keyboard._interruptAltGrSequence());
  env.win.fire('blur');
  assert.equal(env.timers.size, 0);
  assert.equal(keyboard._altGrArmed, false);
  assert.deepEqual(env.packets.filter(packet => packet.type === 'key').map(packet => packet.down), [true, false]);
  env.guard.dispose();
});

test('virtual input preparation releases physical modifiers without pausing or changing focus', () => {
  const env = environment();
  env.guard.attach(env.session); env.activate();
  const keyboard = env.session._keyboard;
  keyboard._sendKeyEvent(0xffe3, 'ControlLeft', true);
  keyboard._sendKeyEvent(0xffe1, 'ShiftLeft', true);
  const focusCalls = env.session.focusCalls;
  const blurCalls = env.session.blurCalls;
  const changeCount = env.changes.length;
  assert.equal(env.guard.prepareVirtualInput(), true);
  assert.deepEqual(env.packets.map(packet => [packet.code, packet.down]),
    [['ControlLeft', true], ['ShiftLeft', true], ['ControlLeft', false], ['ShiftLeft', false]]);
  assert.equal(Object.keys(keyboard._keyDownList).length, 0);
  assert.equal(env.guard.canControl, true);
  assert.equal(env.session.viewOnly, false);
  assert.equal(env.overlay.hidden, true);
  assert.equal(env.session.focusCalls, focusCalls);
  assert.equal(env.session.blurCalls, blurCalls);
  assert.equal(env.changes.length, changeCount);
  assert.equal(env.canvas.listeners.filter(listener => listener.type === 'keydown' && !listener.capture).length, 1);
  assert.equal(env.canvas.listeners.filter(listener => listener.type === 'keyup' && !listener.capture).length, 1);
  const packetCount = env.packets.length;
  assert.equal(env.guard.prepareVirtualInput(), true);
  keyboard._sendKeyEvent(0xffe3, 'ControlLeft', false);
  assert.equal(env.packets.length, packetCount, 'an eventual physical key-up must not release a virtual key twice');
  keyboard._sendKeyEvent(0xffe9, 'AltLeft', true);
  env.win.fire('blur');
  assert.deepEqual(env.packets.slice(-2).map(packet => [packet.code, packet.down]),
    [['AltLeft', true], ['AltLeft', false]]);
  assert.equal(env.guard.canControl, false);
  env.guard.dispose();
});

test('virtual input preparation balances and cancels pending Windows AltGr', () => {
  const env = environment();
  env.guard.attach(env.session); env.activate();
  const keyboard = env.session._keyboard;
  keyboard._altGrArmed = true;
  keyboard._altGrTimeout = env.fakeSetTimeout(() => keyboard._interruptAltGrSequence());
  assert.equal(env.guard.prepareVirtualInput(), true);
  assert.equal(env.timers.size, 0);
  assert.equal(keyboard._altGrArmed, false);
  assert.deepEqual(env.packets.map(packet => [packet.code, packet.down]),
    [['ControlLeft', true], ['ControlLeft', false]]);
  assert.equal(env.guard.canControl, true);
  env.guard.dispose();
});

test('virtual input preparation cannot grant input when paused, read-only, unfocused or disposed', () => {
  const env = environment();
  assert.equal(env.guard.prepareVirtualInput(), false);
  env.guard.attach(env.session);
  assert.equal(env.guard.prepareVirtualInput(), false);
  env.activate();
  env.doc.focused = false;
  assert.equal(env.guard.prepareVirtualInput(), false);
  env.doc.focused = true; env.doc.hidden = true;
  assert.equal(env.guard.prepareVirtualInput(), false);
  env.doc.hidden = false;
  env.guard.setReadOnly(true);
  assert.equal(env.guard.prepareVirtualInput(), false);
  env.guard.setReadOnly(false);
  assert.equal(env.guard.prepareVirtualInput(), false);
  env.activate(); env.guard.detach();
  assert.equal(env.guard.prepareVirtualInput(), false);
  env.guard.dispose();
  assert.equal(env.guard.prepareVirtualInput(), false);
  assert.deepEqual(env.packets, []);
});

test('the virtual input adapter rejects keyboard implementations without grab', () => {
  const env = environment();
  env.session._keyboard.grab = undefined;
  env.guard.attach(env.session); env.activate();
  assert.equal(env.guard.prepareVirtualInput(), false);
  assert.equal(env.guard.canControl, false);
  assert.equal(env.session.viewOnly, true);
  assert.match(env.overlay.children[0].textContent, /版本/);
  env.guard.dispose();
});

test('mouse drag releases at the last click position, cancels queued moves and relinquishes capture', () => {
  const env = environment();
  env.guard.attach(env.session); env.activate();
  env.canvas.fire('mousedown', { clientX: 111, clientY: 92, buttons: 1 });
  env.session._mouseButtonMask = 1;
  env.session._viewportDragging = true;
  env.session._accumulatedWheelDeltaY = 49;
  env.session._mouseMoveTimer = env.fakeSetTimeout(() => env.session._sendMouse(90, 90, 1));
  env.doc.captureElement = env.canvas;
  env.win.fire('blur');
  assert.deepEqual(env.packets.filter(packet => packet.type === 'pointer'), [{ type: 'pointer', x: 101, y: 72, mask: 0 }]);
  assert.equal(env.timers.size, 0);
  assert.equal(env.session._mouseButtonMask, 0);
  assert.equal(env.session._viewportDragging, false);
  assert.equal(env.session._accumulatedWheelDeltaY, 0);
  assert.equal(env.releases, 1);
  assert.equal(env.doc.captureElement, null);
  env.guard.dispose();
});

test('suspending a touch gesture clears timers and resume uses a fresh gesture state', () => {
  const env = environment();
  env.guard.attach(env.session); env.activate();
  const previous = env.session._gestures;
  previous._tracked.push({ identifier: 7 });
  previous._startLongpressTimeout(); previous._startTwoTouchTimeout();
  env.guard.suspend();
  assert.equal(env.timers.size, 0);
  assert.equal(previous._target, null);
  env.activate();
  assert.notEqual(env.session._gestures, previous);
  assert.equal(env.session._gestures._tracked.length, 0);
  assert.equal(env.session._gestures._target, env.canvas);
  env.guard.dispose();
});

test('local toolbar, SSH and form interactions keep the grant without stealing their focus', () => {
  const env = environment();
  env.guard.attach(env.session); env.activate();
  env.cad.fire('pointerdown'); env.canvas.fire('focusout', { relatedTarget: env.cad }); env.cad.fire('focusin');
  assert.equal(env.guard.canControl, true);
  const focusCalls = env.session.focusCalls;
  env.session._keyboard._sendKeyEvent(0xffe3, 'ControlLeft', true);
  env.doc.activeElement = env.outside;
  env.canvas.fire('focusout', { relatedTarget: env.outside });
  env.outside.fire('focusin');
  assert.equal(env.guard.canControl, true);
  assert.equal(env.session.viewOnly, false);
  assert.equal(env.overlay.hidden, true);
  assert.equal(env.doc.activeElement, env.outside);
  assert.equal(env.session.focusCalls, focusCalls);
  assert.deepEqual(env.packets.map(packet => [packet.code, packet.down]),
    [['ControlLeft', true], ['ControlLeft', false]]);
  const packets = env.packets.length;
  env.outside.fire('keydown', { key: 'a', code: 'KeyA' });
  env.outside.fire('keyup', { key: 'a', code: 'KeyA' });
  assert.equal(env.packets.length, packets, 'local typing must stay local');
  env.cad.fire('pointerdown'); env.cad.fire('click');
  env.outside.fire('pointerdown');
  assert.equal(env.guard.canControl, true);
  let clicks = 0;
  env.canvas.addEventListener('mousedown', () => clicks++);
  env.canvas.fire('mousedown', { buttons: 1 });
  assert.equal(clicks, 1, 'the first returning canvas click is a real remote click');
  env.win.fire('blur');
  assert.equal(env.guard.canControl, false);
  env.outside.fire('pointerdown'); env.outside.fire('focusin');
  assert.equal(env.guard.canControl, false, 'local UI cannot re-grant after window blur');
  env.guard.dispose();
});

test('local interaction balances a drag, cancels timers and replaces stale gestures without pausing', () => {
  const env = environment(); env.guard.attach(env.session); env.activate();
  const previous = env.session._gestures;
  previous._tracked.push({ identifier: 7 });
  previous._startLongpressTimeout(); previous._startTwoTouchTimeout();
  env.canvas.fire('mousedown', { clientX: 111, clientY: 92, buttons: 1 });
  env.session._mouseButtonMask = 1;
  env.session._mouseMoveTimer = env.fakeSetTimeout(() => env.session._sendMouse(90, 90, 1));
  env.doc.captureElement = env.canvas;
  env.outside.fire('pointerdown');
  assert.deepEqual(env.packets.filter(packet => packet.type === 'pointer'), [{ type: 'pointer', x: 101, y: 72, mask: 0 }]);
  assert.equal(env.timers.size, 0);
  assert.equal(env.doc.captureElement, null);
  assert.equal(env.session._mouseButtonMask, 0);
  assert.notEqual(env.session._gestures, previous);
  assert.equal(env.session._gestures._tracked.length, 0);
  assert.equal(env.guard.canControl, true);
  assert.equal(env.session.viewOnly, false);
  env.guard.dispose();
});

test('read-only preference and visibility restoration never implicitly restore input', () => {
  const env = environment();
  env.guard.attach(env.session); env.activate();
  env.guard.setReadOnly(true); env.activate();
  assert.equal(env.guard.canControl, false);
  env.guard.setReadOnly(false);
  assert.equal(env.guard.canControl, false);
  env.activate(); assert.equal(env.guard.canControl, true);
  env.doc.hidden = true; env.doc.fire('visibilitychange');
  assert.equal(env.guard.canControl, false);
  env.activate(); assert.equal(env.guard.canControl, false);
  env.doc.hidden = false; env.doc.fire('visibilitychange');
  assert.equal(env.guard.canControl, false);
  env.activate(); assert.equal(env.guard.canControl, true);
  env.guard.dispose();
});

test('blur during an activation click cancels the pending grant', () => {
  const env = environment();
  env.guard.attach(env.session);
  env.overlay.fire('pointerdown', { buttons: 1 });
  env.win.fire('blur');
  env.overlay.fire('pointerup'); env.overlay.fire('click');
  assert.equal(env.guard.canControl, false);
  env.guard.dispose();
});

test('detach releases held input without disconnecting and disposal removes the shield and listeners', () => {
  const env = environment();
  env.guard.attach(env.session); env.activate();
  env.session._keyboard._sendKeyEvent(0xffe1, 'ShiftLeft', true);
  env.guard.detach();
  assert.equal(env.packets.at(-1).down, false);
  assert.equal(env.session.disconnects, 0);
  assert.equal(env.overlay.hidden, true);
  env.guard.dispose();
  assert.equal(env.screen.listeners.length, 0);
  assert.equal(env.win.listeners.length, 0);
});
