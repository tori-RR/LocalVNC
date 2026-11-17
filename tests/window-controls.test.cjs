const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/window-controls.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const context = vm.createContext({});
vm.runInContext(`${source}\nthis.setupWindowControls = setupWindowControls;`, context);
const { setupWindowControls } = context;

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function settle() { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); }
function environment({ desktop = true, overrides = {} } = {}) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, dataset: {}, attributes: {}, title: '', listeners: new Map(),
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(type, handler) { this.listeners.set(type, handler); },
      removeEventListener(type, handler) { if (this.listeners.get(type) === handler) this.listeners.delete(type); },
      click() { return this.listeners.get('click')?.(); },
    });
    return elements.get(id);
  }
  const calls = [], callbacks = {}, unlistens = [];
  let maximized = false, focusLost = 0, getWindowCalls = 0;
  const native = {
    async minimize() { calls.push('minimize'); },
    async toggleMaximize() { calls.push('toggleMaximize'); maximized = !maximized; },
    async close() { calls.push('close'); },
    async isMaximized() { return maximized; },
    async onResized(handler) { callbacks.resize = handler; return () => unlistens.push('resize'); },
    async onFocusChanged(handler) { callbacks.focus = handler; return () => unlistens.push('focus'); },
    ...overrides,
  };
  const api = setupWindowControls({
    onFocusLost() { focusLost++; },
    dependencies: {
      document: { querySelector: element }, window: { __TAURI_INTERNALS__: desktop },
      getCurrentWindow() { getWindowCalls++; return native; },
    },
  });
  return { api, element, calls, callbacks, unlistens, get focusLost() { return focusLost; },
    get getWindowCalls() { return getWindowCalls; } };
}

test('browser preview hides native controls without querying Tauri', async () => {
  const env = environment({ desktop: false });
  await env.api.ready;
  assert.equal(env.element('#window-controls').hidden, true);
  assert.equal(env.getWindowCalls, 0);
  env.api.dispose();
});

test('native buttons minimize, toggle maximize/restore, and close', async () => {
  const env = environment();
  await env.api.ready;
  assert.equal(env.element('#window-controls').hidden, false);
  await env.element('#window-minimize').click();
  await env.element('#window-maximize').click();
  assert.equal(env.element('#window-controls').dataset.maximized, 'true');
  assert.equal(env.element('#window-maximize').attributes['aria-label'], '还原窗口');
  await env.element('#window-maximize').click();
  assert.equal(env.element('#window-maximize').title, '最大化窗口');
  await env.element('#window-close').click();
  assert.deepEqual(env.calls, ['minimize', 'toggleMaximize', 'toggleMaximize', 'close']);
  env.api.dispose();
});

test('focus loss is reported; restored native focus never re-enables remote input', async () => {
  const env = environment();
  await env.api.ready;
  env.callbacks.focus({ payload: false });
  assert.equal(env.focusLost, 1);
  assert.equal(env.element('#app').dataset.windowFocused, 'false');
  env.callbacks.focus({ payload: true });
  assert.equal(env.focusLost, 1);
  assert.equal(env.element('#app').dataset.windowFocused, 'true');
  env.api.dispose();
  env.callbacks.focus({ payload: false });
  assert.equal(env.focusLost, 1);
  assert.deepEqual(env.unlistens.sort(), ['focus', 'resize']);
});

test('dispose releases delayed native registrations and removes button listeners', async () => {
  const registration = deferred();
  let released = 0;
  const env = environment({ overrides: { onFocusChanged: () => registration.promise } });
  env.api.dispose();
  registration.resolve(() => released++);
  await env.api.ready;
  assert.equal(released, 1);
  assert.deepEqual(env.unlistens, ['resize']);
  assert.equal(env.element('#window-close').listeners.size, 0);
  env.api.dispose();
  assert.equal(released, 1);
});

test('late maximize queries cannot overwrite the current restore button', async () => {
  const requests = [];
  const env = environment({ overrides: { isMaximized() {
    const request = deferred(); requests.push(request); return request.promise;
  } } });
  requests[0].resolve(false);
  await env.api.ready;
  env.callbacks.resize();
  env.callbacks.resize();
  requests[2].resolve(true);
  await settle();
  requests[1].resolve(false);
  await settle();
  assert.equal(env.element('#window-controls').dataset.maximized, 'true');
  env.api.dispose();
});

test('a failed native action is caught and remains retryable', async () => {
  let attempts = 0;
  const env = environment({ overrides: { async close() {
    attempts++;
    if (attempts === 1) throw new Error('native action unavailable');
  } } });
  await env.api.ready;
  await env.element('#window-close').click();
  assert.equal(env.element('#window-close').title, '窗口操作失败，请重试');
  await env.element('#window-close').click();
  assert.equal(attempts, 2);
  env.api.dispose();
});
