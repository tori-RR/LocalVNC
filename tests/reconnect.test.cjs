const { test } = require('node:test');
const assert = require('node:assert/strict');
const { environment, deferred, settle, seed, A, D } = require('./harness.cjs');
const transport = { stage: 'rfb', code: 'transport', safeMessage: 'TEST transport interrupted' };
async function connected(env, server = D) {
  seed(env, [server], server.id);
  await env.run('startConnection(beginOperation())');
  const session = env.sessions.at(-1);
  await session.emit('connect');
  return session;
}
async function retry(env, ms = 1000) { env.advance(ms); await settle(); return env.sessions.at(-1); }

test('a direct drop waits, reserves a fresh session and restores with input suspended', async () => {
  const env = environment(); const old = await connected(env);
  env.inputState.canControl = true;
  await old.emit('disconnect', { clean: true }); // Server-initiated orderly EOF is still a drop.
  assert.equal(env.run('rfb'), null);
  assert.equal(env.inputState.canControl, false);
  assert.equal(env.element('#stage-status').textContent, '正在重连');
  assert.equal(env.element('#connect').textContent, '取消重连');
  assert.match(env.element('#empty-description').textContent, /1 秒/);
  env.advance(999); await settle(); assert.equal(env.sessions.length, 1);
  const restored = await retry(env, 1);
  assert.notEqual(restored, old);
  const requests = env.calls.filter(call => call.command === 'connect_direct');
  assert.notEqual(requests[0].args.request.sessionId, requests[1].args.request.sessionId);
  assert.equal(requests[1].args.request.address, D.address);
  assert.equal(requests[1].args.request.securityPolicy, 'preferTls');
  await restored.emit('connect');
  assert.equal(env.element('#stage-status').textContent, '已连接');
  assert.equal(env.element('#input-status').textContent, '点击画面接管');
  assert.equal(restored.viewOnly, true);
  assert.equal(env.keyboardState.canControl, false);
  assert.equal(env.calls.some(call => call.command.startsWith('ssh_')), false);
});

test('failed first connections and PVE drops stay manual', async () => {
  const first = environment(); seed(first, [D], D.id);
  await first.run('startConnection(beginOperation())');
  await first.sessions[0].emit('disconnect');
  assert.equal(first.run('recovery'), null);
  const pve = environment(); const session = await connected(pve, A);
  await session.emit('disconnect');
  assert.equal(pve.run('recovery'), null);
  assert.equal(pve.element('#connect').textContent, '连接');
});

test('retry uses a saved credential only after the new server requests it', async () => {
  const env = environment(command => command === 'password_saved' ? true : command === 'load_password' ? 'TEST_ONLY_VNC' : undefined);
  const old = await connected(env); await old.emit('disconnect');
  const restored = await retry(env);
  assert.equal(env.calls.some(call => call.command === 'load_password'), false);
  assert.equal(restored.options.credentials.password, undefined);
  await restored.emit('credentialsrequired', { types: ['password'] });
  assert.equal(restored.credentials.password, 'TEST_ONLY_VNC');
  await restored.emit('connect');
  assert.equal(env.run('activeOperation.password'), undefined);
  assert.equal(env.calls.some(call => call.command === 'save_password'), false);
});

test('unsaved password prompts stop background recovery and never replay old secrets', async () => {
  const env = environment(); const old = await connected(env);
  await old.emit('disconnect'); const restored = await retry(env);
  await restored.emit('credentialsrequired', { types: ['password'] });
  assert.equal(env.run('recovery'), null);
  assert.equal(env.element('#password-dialog').open, true);
  assert.equal(env.element('#password').value, '');
  env.advance(120000); await settle();
  assert.equal(env.element('#password-dialog').open, true);
  assert.equal(env.run('rfb'), restored);
});

for (const error of [
  { stage: 'rfb_auth', code: 'unauthorized' }, { stage: 'rfb_auth', code: 'auth_limited' },
  { stage: 'rfb_security', code: 'unsupported_security' }, { stage: 'rfb_security', code: 'protocol' },
  { stage: 'tls', code: 'handshake' }, { stage: 'tcp', code: 'invalid_address' },
]) {
  test(`recovery stops on ${error.stage}/${error.code}`, async () => {
    const env = environment(); const old = await connected(env);
    await old.emit('disconnect'); await retry(env);
    env.run(`failSession(${JSON.stringify({ ...error, safeMessage: 'TEST terminal failure' })})`);
    assert.equal(env.run('recovery'), null);
    env.advance(120000); await settle(); assert.equal(env.sessions.length, 2);
    assert.match(env.element('#empty-description').textContent, /TEST terminal failure/);
    assert.equal(env.run(`rejectedPasswords.has(${JSON.stringify(D.id)})`), error.code === 'unauthorized');
  });
}

test('temporary TCP failures back off until the service is available', async () => {
  let requests = 0;
  const env = environment(command => command === 'connect_direct' && ++requests === 2
    ? Promise.reject({ stage: 'tcp', code: 'connect', safeMessage: 'TEST refused' }) : undefined);
  const old = await connected(env); await old.emit('disconnect'); await retry(env);
  assert.equal(env.sessions.length, 1);
  assert.match(env.element('#empty-description').textContent, /2 秒/);
  const restored = await retry(env, 2000); await restored.emit('connect');
  assert.equal(env.element('#stage-status').textContent, '已连接');
});

for (const action of ['manual', 'selection', 'unload']) {
  test(`${action} cancels every recovery timer and stale callbacks`, async () => {
    const env = environment(); const old = await connected(env); await old.emit('disconnect');
    if (action === 'manual') await env.run('connectSelected()');
    if (action === 'selection') env.run(`servers.push(${JSON.stringify(A)}); selectServer(${JSON.stringify(A.id)})`);
    if (action === 'unload') await env.element('window').fire('beforeunload');
    assert.equal(env.run('recovery'), null);
    env.advance(120000); await settle();
    await old.emit('connect'); await old.emit('disconnect');
    assert.equal(env.sessions.length, 1);
    assert.equal(env.run('rfb'), null);
    assert.equal(env.timers.size, 0);
  });
}

test('cancelled pending reconnect releases only its own late backend session', async () => {
  const pending = deferred(); let requests = 0;
  const env = environment(command => command === 'connect_direct' && ++requests === 2 ? pending.promise : undefined);
  const old = await connected(env); await old.emit('disconnect'); await retry(env);
  const cancelledId = env.calls.filter(call => call.command === 'connect_direct').at(-1).args.request.sessionId;
  await env.run('connectSelected()'); await env.run('connectSelected()');
  const current = env.sessions.at(-1);
  pending.resolve({ url: 'ws://late.invalid/TEST' }); await settle();
  assert.equal(env.run('rfb'), current);
  assert.equal(current.disconnectCount, 0);
  assert.equal(env.calls.filter(call => call.command === 'disconnect').at(-1).args.sessionId, cancelledId);
  assert.equal(env.sessions.length, 2);
});

test('flapping successes retain one 60-second budget, then allow manual retry', async () => {
  const env = environment(); let session = await connected(env); await session.emit('disconnect');
  const plan = env.run('recovery');
  for (const delay of [1000, 2000, 3000, 5000, 8000]) {
    session = await retry(env, delay); await session.emit('connect');
    assert.equal(env.run('recovery'), plan);
    await session.emit('disconnect');
  }
  env.advance(41000); await settle(); // First campaign has now reached 60 seconds.
  assert.equal(env.run('recovery'), null);
  assert.equal(env.run('rfb'), null);
  assert.match(env.element('#empty-description').textContent, /60 秒/);
  assert.equal(env.element('#connect').textContent, '连接');
  await env.run('connectSelected()');
  assert.notEqual(env.sessions.at(-1), session);
});

test('a stable restored connection resets the backoff and is never closed by expiry', async () => {
  const env = environment(); const old = await connected(env); await old.emit('disconnect');
  const restored = await retry(env); await restored.emit('connect');
  env.advance(10000); assert.equal(env.run('recovery'), null);
  env.advance(120000); assert.equal(env.run('rfb'), restored);
  await restored.emit('disconnect');
  assert.match(env.element('#empty-description').textContent, /1 秒/);
});

test('a campaign deadline cancels a stuck backend request and quarantines its completion', async () => {
  const pending = deferred(); let requests = 0;
  const env = environment(command => command === 'connect_direct' && ++requests === 2 ? pending.promise : undefined);
  const old = await connected(env); await old.emit('disconnect'); await retry(env);
  env.advance(59000); await settle();
  assert.equal(env.run('recovery'), null);
  assert.match(env.element('#empty-description').textContent, /60 秒/);
  pending.resolve({ url: 'ws://late.invalid/TEST' }); await settle();
  assert.equal(env.sessions.length, 1);
  assert.equal(env.run('rfb'), null);
});

test('late backend errors and old disconnects cannot restart or cancel a restored session', async () => {
  const env = environment(); await env.run('boot()'); const old = await connected(env);
  const oldId = env.calls.find(call => call.command === 'connect_direct').args.request.sessionId;
  await old.emit('disconnect'); const restored = await retry(env); await restored.emit('connect');
  env.events.get('vnc-error')({ payload: { ...transport, sessionId: oldId } });
  await old.emit('disconnect'); await old.emit('securityfailure', { status: 1 });
  assert.equal(env.run('rfb'), restored);
  assert.equal(env.element('#stage-status').textContent, '已连接');
});

test('a current backend transport error starts only one campaign despite the following disconnect', async () => {
  const env = environment(); await env.run('boot()'); const old = await connected(env);
  const sessionId = env.calls.find(call => call.command === 'connect_direct').args.request.sessionId;
  env.events.get('vnc-error')({ payload: { ...transport, sessionId } });
  const plan = env.run('recovery'); assert.ok(plan);
  await old.emit('disconnect');
  assert.equal(env.run('recovery'), plan);
  await retry(env); assert.equal(env.sessions.length, 2);
});

test('unloading a live connection invalidates it before its final disconnect callback', async () => {
  const env = environment(); const session = await connected(env);
  await env.element('window').fire('beforeunload');
  await session.emit('disconnect'); await session.emit('connect');
  env.advance(120000); await settle();
  assert.equal(env.run('activeOperation'), null);
  assert.equal(env.run('rfb'), null);
  assert.equal(env.run('recovery'), null);
  assert.equal(env.sessions.length, 1);
  assert.equal(env.timers.size, 0);
});
