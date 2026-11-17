const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/ssh.js'), 'utf8')
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const context = vm.createContext({ TextEncoder, URL, Uint8Array, structuredClone });
const endpointSource = fs.readFileSync(path.join(__dirname, '../src/pve-endpoint.js'), 'utf8').replace(/^export /gm, '');
vm.runInContext(`${endpointSource}\n${source}\nthis.api = { createSshPanel, inferSshProfile, normalizePveOrigin };`, context);
const { createSshPanel, inferSshProfile } = context.api;
const A = { id: 'a', kind: 'pve', origin: 'https://a.invalid:8006' };
const B = { id: 'b', kind: 'direct', address: 'b.invalid::5901' };

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}
function environment({ customInvoke = () => {}, desktop = true, autoParse = true } = {}) {
  const elements = new Map();
  function element(name) {
    if (!elements.has(name)) elements.set(name, {
      value: '', textContent: '', disabled: false, dataset: {}, clientWidth: 400, clientHeight: 500,
      handlers: new Map(), getClientRects() { return this.clientWidth ? [{}] : []; },
      replaceChildren() {}, addEventListener(type, fn) { this.handlers.set(type, fn); },
      removeEventListener(type, fn) { if (this.handlers.get(type) === fn) this.handlers.delete(type); },
      fire(type) { return this.handlers.get(type)?.({ preventDefault() {} }); },
    });
    return elements.get(name);
  }
  const calls = [], terminals = [], channels = [], profiles = [], observers = [];
  class FakeTerminal {
    constructor(options) {
      this.options = options; this.cols = 80; this.rows = 24; this.writes = []; this.callbacks = [];
      this.parser = { registerOscHandler() {} }; terminals.push(this);
    }
    loadAddon(addon) { addon.terminal = this; }
    open() {}
    onData(fn) { this.input = fn; }
    onBinary(fn) { this.binary = fn; }
    onResize(fn) { this.resize = fn; }
    focus() {}
    write(data, callback) {
      this.writes.push(data); this.callbacks.push(callback);
      if (Buffer.from(data).toString() === '\x1b[6n' && !this.options.disableStdin) this.input('\x1b[1;1R');
      if (autoParse) this.callbacks.shift()();
    }
    dispose() { this.disposed = true; }
  }
  class FakeFit {
    fit() {
      this.terminal.fits = (this.terminal.fits || 0) + 1;
      this.terminal.resize({ cols: this.terminal.cols, rows: this.terminal.rows });
    }
  }
  class FakeChannel { constructor() { channels.push(this); } }
  class FakeObserver {
    constructor(fn) { this.callback = fn; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const frames = new Map();
  let frameId = 0, sequence = 0;
  const win = {
    __TAURI_INTERNALS__: desktop,
    requestAnimationFrame(fn) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const panel = createSshPanel({
    onProfileChange(...args) { profiles.push(args); },
    dependencies: {
      document: { querySelector: selector => element(selector.slice(5)) }, window: win,
      Terminal: FakeTerminal, FitAddon: FakeFit, Channel: FakeChannel, ResizeObserver: FakeObserver,
      newId: () => `ssh-${++sequence}`,
      invoke(command, args) {
        calls.push({ command, args });
        try { return Promise.resolve(customInvoke(command, args)); }
        catch (error) { return Promise.reject(error); }
      },
    },
  });
  return { panel, element, calls, terminals, channels, profiles, observers,
    connect() { return element('form').fire('submit'); },
    disconnect() { return element('disconnect').fire('click'); },
    frame() { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } },
    event(index, kind, data) { channels[index].onmessage({ sessionId: `ssh-${index + 1}`, kind, ...data }); },
  };
}

test('SSH defaults parse PVE, display syntax, explicit VNC ports and IPv6 safely', () => {
  assert.equal(inferSshProfile(A).host, 'a.invalid');
  for (const [address, expected] of [['vnc.invalid:1', 'vnc.invalid'], ['vnc.invalid::5901', 'vnc.invalid'],
    ['[2001:db8::1]::5900', '2001:db8::1'], ['::1', '::1'], ['2001:db8::2', '2001:db8::2']]) {
    assert.equal(inferSshProfile({ kind: 'direct', address }).host, expected);
  }
  const profile = inferSshProfile({ ...A, ssh: { host: 'override.invalid', port: 2222, username: 'admin' } });
  assert.equal(profile.host, 'override.invalid');
  assert.equal(profile.port, 2222);
  assert.equal(profile.username, 'admin');
});

test('PVE origins use the same parsing matrix in the frontend and Rust, with independent SSH usernames', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/pve-origins.json')));
  for (const { input, expected, host } of cases) {
    if (expected === null) {
      assert.throws(() => context.api.normalizePveOrigin(input), input);
      assert.equal(inferSshProfile({ kind: 'pve', origin: input }).host, '', input);
    } else {
      assert.equal(context.api.normalizePveOrigin(input), expected, input);
      const profile = inferSshProfile({ kind: 'pve', origin: input, username: 'root@pam' });
      assert.equal(profile.host, host, input);
      assert.equal(profile.username, 'root');
    }
  }
});

test('text and binary terminal input share one serial raw-byte queue', async () => {
  const blocked = deferred();
  let count = 0;
  const env = environment({ customInvoke(command) { if (command === 'ssh_write' && ++count === 1) return blocked.promise; } });
  env.panel.setServer(A); await env.connect();
  const terminal = env.terminals.at(-1);
  const text = 'English 中文 😀\r\n第二行\r\n';
  const binary = '\x1b[M\x20\x80\xff\x00';
  terminal.input(text); terminal.binary(binary); terminal.input('END');
  await settle();
  assert.equal(env.calls.filter(call => call.command === 'ssh_write').length, 1);
  blocked.resolve(); await settle();
  const writes = env.calls.filter(call => call.command === 'ssh_write');
  const actual = Buffer.from(writes.flatMap(call => call.args.data));
  assert.deepEqual(actual, Buffer.concat([Buffer.from(text), Buffer.from([27, 91, 77, 32, 128, 255, 0]), Buffer.from('END')]));
  env.panel.dispose();
});

test('binary startup input is queued, bounded in bytes and discarded on cancellation', async () => {
  const startup = deferred();
  const env = environment({ customInvoke(command) { if (command === 'ssh_connect') return startup.promise; } });
  env.panel.setServer(A); const start = env.connect(); await settle();
  const terminal = env.terminals.at(-1);
  terminal.binary('\x80\xff');
  assert.equal(env.calls.some(call => call.command === 'ssh_write'), false);
  env.disconnect(); startup.resolve(); await start; await settle();
  assert.equal(env.calls.some(call => call.command === 'ssh_write'), false);
  env.panel.dispose();

  const slow = deferred();
  const bounded = environment({ customInvoke(command) { if (command === 'ssh_write') return slow.promise; } });
  bounded.panel.setServer(A); await bounded.connect();
  bounded.terminals.at(-1).binary('\xff'.repeat(256 * 1024));
  bounded.terminals.at(-1).input('x');
  assert.match(bounded.element('hint').textContent, /输入过多/);
  assert.ok(bounded.calls.some(call => call.command === 'ssh_disconnect'));
  slow.resolve(); await settle(); bounded.panel.dispose();
});

test('selection rerenders preserve edits and active SSH target stays independent', async () => {
  const env = environment();
  env.panel.setServer(A);
  env.element('username').value = 'operator';
  env.panel.setServer({ ...A });
  assert.equal(env.element('username').value, 'operator');
  await env.connect();
  env.panel.setServer(B);
  assert.equal(env.element('host').value, 'a.invalid');
  assert.equal(env.element('target').textContent, 'operator@a.invalid:22');
  assert.equal(env.calls.filter(call => call.command === 'ssh_connect').length, 1);
  assert.equal(env.profiles[0][0], 'a');
  env.disconnect();
  assert.equal(env.element('host').value, 'b.invalid');
  assert.ok(env.calls.every(call => call.command.startsWith('ssh_')));
  env.panel.dispose();
});

test('failed SSH startup keeps the submitted fields available for retry', async () => {
  let attempts = 0;
  const env = environment({ customInvoke(command) {
    if (command === 'ssh_connect' && ++attempts === 1) throw { safeMessage: 'TEST startup failure' };
  } });
  env.panel.setServer(A);
  env.element('host').value = 'edited.invalid';
  env.element('username').value = 'operator';
  env.element('port').value = '2222';
  await env.connect();
  assert.equal(env.element('status').dataset.state, 'error');
  assert.equal(env.element('hint').textContent, 'TEST startup failure');
  assert.equal(env.element('host').value, 'edited.invalid');
  assert.equal(env.element('username').value, 'operator');
  assert.equal(env.element('port').value, '2222');
  assert.equal(env.element('connect').disabled, false);
  await env.connect();
  const requests = env.calls.filter(call => call.command === 'ssh_connect');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].args.request.host, 'edited.invalid');
  assert.equal(requests[1].args.request.username, 'operator');
  assert.equal(requests[1].args.request.port, 2222);
  assert.equal(env.element('status').textContent, '终端就绪');
  assert.equal(env.element('status').dataset.state, 'ready');
  env.panel.dispose();
});

test('cancel during startup scopes cleanup and serializes the replacement session', async () => {
  const first = deferred();
  const env = environment({ customInvoke(command, args) {
    if (command === 'ssh_connect' && args.request.sessionId === 'ssh-1') return first.promise;
  } });
  env.panel.setServer(A);
  const startA = env.connect();
  await settle();
  env.disconnect();
  env.panel.setServer(B);
  const startB = env.connect();
  await settle();
  assert.equal(env.calls.filter(call => call.command === 'ssh_connect').length, 1);
  first.resolve();
  await Promise.all([startA, startB]);
  assert.equal(env.calls.filter(call => call.command === 'ssh_connect').length, 2);
  assert.equal(env.element('target').textContent, 'root@b.invalid:22');
  env.event(0, 'error', { message: 'stale error' });
  assert.equal(env.element('status').textContent, '终端就绪');
  assert.ok(env.calls.filter(call => call.command === 'ssh_disconnect').every(call => call.args.sessionId === 'ssh-1'));
  assert.deepEqual(env.profiles.map(value => value[0]), ['b']);
  env.panel.dispose();
});

test('terminal input preserves Ctrl+C and chunks Unicode paste under the IPC limit', async () => {
  const env = environment();
  env.panel.setServer(A);
  await env.connect();
  const terminal = env.terminals.at(-1);
  terminal.input('\x03');
  const paste = '😀中'.repeat(15000);
  terminal.input(paste);
  await settle();
  const writes = env.calls.filter(call => call.command === 'ssh_write');
  assert.deepEqual(Array.from(writes[0].args.data), [3]);
  assert.equal(Buffer.from(writes.slice(1).flatMap(call => call.args.data)).toString(), paste);
  assert.ok(writes.every(call => call.args.data.length <= 65536));
  env.panel.dispose();
});

test('output remains raw bytes across UTF8 fragments and is acknowledged after parsing', async () => {
  const env = environment({ autoParse: false });
  env.panel.setServer(A);
  await env.connect();
  env.event(0, 'data', { data: [0xe4, 0xb8] });
  env.event(0, 'data', { data: [0xad] });
  assert.equal(env.calls.filter(call => call.command === 'ssh_ack').length, 0);
  const terminal = env.terminals.at(-1);
  assert.ok(terminal.writes[0] instanceof Uint8Array);
  assert.deepEqual([...terminal.writes[0]], [0xe4, 0xb8]);
  terminal.callbacks.shift()();
  terminal.callbacks.shift()();
  assert.deepEqual(env.calls.filter(call => call.command === 'ssh_ack').map(call => call.args.bytes), [2, 1]);
  env.panel.dispose();
});

test('a slow input sink has a bounded queue and disconnects with an actionable hint', async () => {
  const pendingWrite = deferred();
  const env = environment({ customInvoke(command) { if (command === 'ssh_write') return pendingWrite.promise; } });
  env.panel.setServer(A);
  await env.connect();
  const terminal = env.terminals.at(-1);
  terminal.input('x'.repeat(256 * 1024));
  terminal.input('x');
  assert.equal(env.element('status').textContent, '连接中断');
  assert.match(env.element('hint').textContent, /输入过多/);
  assert.equal(env.calls.filter(call => call.command === 'ssh_write').length, 1);
  assert.equal(env.calls.filter(call => call.command === 'ssh_disconnect').length, 1);
  pendingWrite.resolve();
  await settle();
  env.panel.dispose();
});

test('unparsed output is bounded without acknowledging discarded bytes', async () => {
  const env = environment({ autoParse: false });
  env.panel.setServer(A);
  await env.connect();
  env.event(0, 'data', { data: new Array(256 * 1024).fill(65) });
  env.event(0, 'data', { data: new Array(256 * 1024).fill(66) });
  env.event(0, 'data', { data: [67] });
  assert.match(env.element('hint').textContent, /输出超过/);
  assert.equal(env.terminals.at(-1).writes.length, 2);
  env.terminals.at(-1).callbacks.shift()();
  assert.equal(env.calls.filter(call => call.command === 'ssh_ack').length, 0);
  env.panel.dispose();
});

test('hiding the panel retains SSH and restoring it resizes the same PTY', async () => {
  const env = environment();
  env.panel.setServer(A);
  await env.connect();
  const terminal = env.terminals.at(-1);
  env.element('terminal').clientWidth = 0;
  env.panel.fit(); env.frame();
  assert.equal(env.calls.filter(call => call.command === 'ssh_disconnect').length, 0);
  const previousFits = terminal.fits;
  env.element('terminal').clientWidth = 500;
  terminal.cols = 95;
  env.panel.fit(); env.frame();
  await settle();
  assert.equal(terminal.fits, previousFits + 1);
  assert.equal(env.calls.find(call => call.command === 'ssh_resize').args.cols, 95);
  env.panel.dispose();
});

test('process exit before start resolves does not revive a dead terminal', async () => {
  const pending = deferred();
  const env = environment({ customInvoke(command) { if (command === 'ssh_connect') return pending.promise; } });
  env.panel.setServer(A);
  const start = env.connect();
  await settle();
  env.event(0, 'exit', { message: 'exited' });
  pending.resolve();
  await start;
  assert.equal(env.element('status').textContent, '已退出');
  assert.equal(env.terminals.at(-1).options.disableStdin, true);
  assert.equal(env.profiles.length, 0);
  env.panel.dispose();
});

test('startup terminal queries are queued before connect resolves and flushed when ready', async () => {
  const pending = deferred();
  const env = environment({ customInvoke(command) { if (command === 'ssh_connect') return pending.promise; } });
  env.panel.setServer(A);
  const start = env.connect();
  await settle();
  env.event(0, 'data', { data: [...Buffer.from('\x1b[6n')] });
  assert.equal(env.terminals.at(-1).options.disableStdin, false);
  assert.equal(env.calls.filter(call => call.command === 'ssh_write').length, 0);
  pending.resolve();
  await start;
  await settle();
  const writes = env.calls.filter(call => call.command === 'ssh_write');
  assert.equal(writes.length, 1);
  assert.equal(Buffer.from(writes[0].args.data).toString(), '\x1b[1;1R');
  assert.equal(writes[0].args.sessionId, 'ssh-1');
  env.panel.dispose();
});

test('cancellation discards startup replies rather than sending them to a later session', async () => {
  const pending = deferred();
  const env = environment({ customInvoke(command) { if (command === 'ssh_connect') return pending.promise; } });
  env.panel.setServer(A);
  const start = env.connect();
  await settle();
  env.event(0, 'data', { data: [...Buffer.from('\x1b[6n')] });
  env.disconnect();
  pending.resolve();
  await start;
  assert.equal(env.calls.filter(call => call.command === 'ssh_write').length, 0);
  assert.equal(env.terminals.at(-1).options.disableStdin, true);
  env.panel.dispose();
});

test('browser preview and invalid targets never invoke SSH commands', async () => {
  const browser = environment({ desktop: false });
  browser.panel.setServer(A);
  await browser.connect();
  assert.match(browser.element('hint').textContent, /桌面窗口/);
  assert.equal(browser.calls.length, 0);
  browser.panel.dispose();
  const invalid = environment();
  invalid.panel.setServer(A);
  invalid.element('host').value = '-oProxyCommand=bad';
  await invalid.connect();
  assert.equal(invalid.calls.length, 0);
  invalid.panel.dispose();
});

test('Windows domain and UPN usernames reach OpenSSH as an unchanged argument', async () => {
  for (const username of ['CONTOSO\\operator', 'operator@contoso.example']) {
    const env = environment();
    env.panel.setServer(A);
    env.element('username').value = username;
    await env.connect();
    assert.equal(env.calls.find(call => call.command === 'ssh_connect').args.request.username, username);
    env.panel.dispose();
  }
});

test('disposing cancels startup and suppresses late callbacks and persistence', async () => {
  const pending = deferred();
  const env = environment({ customInvoke(command) { if (command === 'ssh_connect') return pending.promise; } });
  env.panel.setServer(A);
  const start = env.connect();
  await settle();
  env.panel.dispose();
  pending.resolve();
  await start;
  env.event(0, 'data', { data: [65] });
  assert.equal(env.terminals.at(-1).writes.length, 0);
  assert.equal(env.profiles.length, 0);
  assert.equal(env.observers[0].disconnected, true);
  assert.equal(env.terminals.at(-1).disposed, true);
  assert.ok(env.calls.filter(call => call.command === 'ssh_disconnect').every(call => call.args.sessionId === 'ssh-1'));
});

for (const end of ['exit', 'error', 'disconnect']) {
  test(`SSH empty prompt hides at startup and ${end} preserves visible terminal history`, async () => {
    const pending = deferred();
    const env = environment({ customInvoke(command) { if (command === 'ssh_connect') return pending.promise; } });
    env.panel.setServer(A);
    assert.equal(!!env.element('empty').hidden, false);
    const start = env.connect();
    await settle();
    assert.equal(env.element('empty').hidden, true);
    assert.equal(env.element('status').textContent, '正在启动');
    const terminal = env.terminals.at(-1);
    const output = [...Buffer.from('TEST_ONLY terminal history\r\n')];
    env.event(0, 'data', { data: output });
    pending.resolve(); await start;
    if (end === 'disconnect') env.disconnect();
    else env.event(0, end, { message: `TEST ${end}` });
    assert.equal(env.element('empty').hidden, true);
    assert.equal(env.terminals.at(-1), terminal);
    assert.equal(!!terminal.disposed, false);
    assert.equal(terminal.options.disableStdin, true);
    assert.deepEqual([...terminal.writes[0]], output);
    env.panel.setServer(B);
    env.panel.fit(); env.frame();
    assert.equal(env.element('empty').hidden, true);
    assert.equal(env.terminals.at(-1), terminal);
    assert.deepEqual([...terminal.writes[0]], output);
    env.panel.dispose();
  });
}

test('invalid SSH input keeps its empty prompt and does not start a terminal session', async () => {
  const env = environment();
  env.panel.setServer(A);
  env.element('port').value = '0';
  await env.connect();
  assert.equal(!!env.element('empty').hidden, false);
  assert.equal(env.calls.some(call => call.command === 'ssh_connect'), false);
  assert.equal(env.terminals.length, 0);
  env.panel.dispose();
});
