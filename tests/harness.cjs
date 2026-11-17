// Isolated DOM/Tauri harness adapted from the supplied GPT6PRO reproduction package.
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/main.js'),'utf8').replace(/^import .*;\r?\n/gm, '').replace(/\bboot\(\);\s*$/, '');
const endpointSource = fs.readFileSync(require('node:path').join(__dirname, '../src/pve-endpoint.js'), 'utf8').replace(/^export /gm, '');
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
}
class Element {
  constructor() {
    this.value = ''; this.checked = false; this.disabled = false;
    this.hidden = false; this.dataset = {}; this.children = [];
    this.textContent = ''; this.handlers = new Map(); this.open = false;
    const classes = new Set();
    this.classList = {
      add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }
    };
    const fields = {};
    this.elements = new Proxy(fields, { get: (obj, name) => obj[name] ||= new Element() });
  }
  addEventListener(name, callback) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(callback);
  }
  fire(name, event = {}) {
    return Promise.all((this.handlers.get(name) || []).map(fn => fn({
      preventDefault() {}, stopPropagation() {}, ...event,
    })));
  }
  querySelectorAll() { return []; }
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  focus() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
  requestFullscreen() { return Promise.resolve(); }
}
function environment(customInvoke = () => undefined) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  const calls = [], sessions = [], events = new Map();
  const timers = new Map();
  let now = 0, timerId = 0;
  const sshState = {};
  const inputState = { session: null, canControl: false, readOnly: false, nativeFocusLost: null, onChange: null };
  const keyboardState = { visible: false, connected: false, canControl: false, readOnly: false };
  class FakeRFB {
    constructor(target, url, options) {
      this.target = target; this.url = url; this.options = options;
      this.handlers = new Map(); this.disconnectCount = 0;
      sessions.push(this);
    }
    addEventListener(name, fn) { this.handlers.set(name, fn); }
    emit(name, detail = {}) { return this.handlers.get(name)?.({ detail }); }
    disconnect() { this.disconnectCount++; }
    focus() {}
    sendCtrlAltDel() { this.cadCount = (this.cadCount || 0) + 1; }
    sendKey(keysym, code, down) { (this.keys ||= []).push({ keysym, code, down }); }
    sendCredentials(value) { this.credentials = value; }
  }
  const memory = new Map();
  const context = vm.createContext({
    document: {
      querySelector: element, createElement: () => new Element(),
      fullscreenElement: null, exitFullscreen: () => Promise.resolve(),
    },
    window: { __TAURI_INTERNALS__: true, addEventListener(name, callback) { element('window').addEventListener(name, callback); } },
    requestAnimationFrame: fn => fn(),
    createSshPanel: options => { sshState.onProfileChange = options.onProfileChange; return { setServer() {}, fit() {}, dispose() {} }; },
    createVirtualKeyboard({ sendKey, beforeSend, onVisibilityChange }) {
      keyboardState.sendKey = sendKey;
      keyboardState.beforeSend = beforeSend;
      return {
        toggle() { keyboardState.visible = !keyboardState.visible; onVisibilityChange(keyboardState.visible); },
        setState(state) { Object.assign(keyboardState, state); },
        dispose() {},
      };
    },
    createVncInputGuard({ onChange }) {
      inputState.onChange = onChange;
      return {
        get canControl() { return inputState.canControl; },
        prepareVirtualInput() { return inputState.canControl; },
        attach(session) { inputState.session = session; this.suspend(); },
        setReadOnly(value) { inputState.readOnly = value; if (value) this.suspend(); },
        suspend() { inputState.canControl = false; if (inputState.session) inputState.session.viewOnly = true; onChange(); },
        detach() { this.suspend(); inputState.session = null; },
        dispose() { this.detach(); },
      };
    },
    setupWindowControls({ onFocusLost }) { inputState.nativeFocusLost = onFocusLost; return { dispose() {} }; },
    RFB: FakeRFB,
    crypto: { randomUUID }, structuredClone, URL, TextEncoder,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    localStorage: {
      getItem: key => memory.get(key) ?? null,
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: key => memory.delete(key),
    },
    invoke(command, args) {
      calls.push({ command, args: args === undefined ? undefined : JSON.parse(JSON.stringify(args)) });
      try {
        const custom = customInvoke(command, args);
        if (custom !== undefined) return Promise.resolve(custom);
        if (command === 'begin_session') return Promise.resolve(randomUUID());
        if (command === 'credential_generation') return Promise.resolve('TEST_GENERATION');
        if (command === 'save_config') return Promise.resolve(Object.fromEntries(args.config.servers.map(server => [server.id, 'TEST_GENERATION'])));
        if (command === 'password_saved') return Promise.resolve(false);
        if (command === 'load_config') return Promise.resolve({ servers: [], settings: {}, selectedId: '' });
        if (command === 'connect_pve' || command === 'connect_direct') {
          return Promise.resolve({ url: 'ws://audit.invalid/mock', password: 'TEST_ONLY_TICKET' });
        }
        return Promise.resolve(null);
      } catch (error) { return Promise.reject(error); }
    },
    listen: (name, callback) => { events.set(name, callback); return Promise.resolve(() => {}); },
  });
  vm.runInContext(endpointSource + '\n' + source, context, { filename: 'audited-main.js', timeout: 1000 });
  return { calls, sessions, element, events, inputState, keyboardState, sshState, timers,
    advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } },
    run: code => vm.runInContext(code, context, { timeout: 1000 }) };
}
const A = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Mock A', kind: 'pve',
  origin: 'https://a.invalid:8006', node: 'mock-a', vmid: 100, username: 'audit@pam' };
const B = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Mock B', kind: 'pve',
  origin: 'https://b.invalid:8006', node: 'mock-b', vmid: 101, username: 'audit@pam' };
const D = { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'Mock direct', kind: 'direct', address: 'vnc.invalid::5900' };
function seed(env, servers = [A, B], selected = A.id) {
  env.run(`configReady = true; servers = ${JSON.stringify(servers)}; selectedId = ${JSON.stringify(selected)};`);
}

module.exports = { environment, deferred, settle, seed, A, B, D };
