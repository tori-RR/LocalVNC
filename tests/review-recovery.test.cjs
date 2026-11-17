const { test } = require('node:test');
const assert = require('node:assert/strict');
const { environment, deferred, settle, seed, A, B, D } = require('./harness.cjs');
const json = JSON.stringify;
const value = (env, code) => JSON.parse(env.run(`JSON.stringify(${code})`));
async function editor(env, address = 'replacement.invalid::5900') {
  await env.element('#edit-server').fire('click');
  env.element('#server-kind').value = 'direct';
  env.element('#server-form').elements.address.value = address;
}

test('failed edit keeps the original model, connection, credential and open draft', async () => {
  const env = environment(command => command === 'save_config' ? Promise.reject(new Error('TEST disk conflict')) : undefined);
  seed(env); await env.run('startConnection(beginOperation(), "TEST")');
  const session = env.sessions.at(-1); await session.emit('connect');
  await editor(env); await env.element('#server-form').fire('submit');
  assert.deepEqual(value(env, 'servers'), [A, B]);
  assert.equal(env.run('selectedId'), A.id);
  assert.equal(env.run('rfb'), session);
  assert.equal(session.disconnectCount, 0);
  assert.equal(env.calls.some(call => call.command === 'forget_password'), false);
  assert.equal(env.element('#server-dialog').open, true);
  assert.equal(env.element('#server-form').elements.address.value, 'replacement.invalid::5900');
  assert.match(env.element('#server-form-error').textContent, /disk conflict/);
  assert.equal(env.element('#server-save').disabled, false);
});

test('failed deletion preserves the model and does not clear credentials or disconnect', async () => {
  const env = environment(command => command === 'save_config' ? Promise.reject(new Error('TEST cannot replace')) : undefined);
  seed(env); await env.run('startConnection(beginOperation(), "TEST")');
  const session = env.sessions.at(-1);
  await env.run(`deleteServer(${json(A.id)})`);
  assert.deepEqual(value(env, 'servers'), [A, B]);
  assert.equal(env.run('selectedId'), A.id);
  assert.equal(session.disconnectCount, 0);
  assert.equal(env.calls.some(call => call.command === 'forget_password'), false);
  assert.match(env.element('#stage-hint').textContent, /cannot replace/);
});

for (const action of ['edit', 'delete']) {
  test(`successful ${action} commits first; failed credential cleanup warns without reverting`, async () => {
    const saved = deferred();
    const env = environment(command => command === 'save_config' ? saved.promise
      : command === 'forget_password' ? Promise.reject(new Error('TEST vault busy')) : undefined);
    seed(env);
    if (action === 'edit') await editor(env);
    const pending = action === 'edit' ? env.element('#server-form').fire('submit') : env.run(`deleteServer(${json(A.id)})`);
    await settle();
    assert.deepEqual(value(env, 'servers'), [A, B]);
    assert.equal(env.calls.some(call => call.command === 'forget_password'), false);
    if (action === 'edit') assert.equal(env.element('#server-dialog').open, true);
    saved.resolve(); await pending;
    assert.equal(value(env, 'servers').some(server => server.id === A.id), false);
    const config = env.calls.find(call => call.command === 'save_config').args.config;
    assert.deepEqual(value(env, 'servers'), config.servers);
    assert.equal(env.element('#server-dialog').open, false);
    assert.match(env.element('#stage-hint').textContent, /配置已保存.*未能清理/);
    assert.equal(env.calls.find(call => call.command === 'forget_password').args.serverId, A.id);
  });
}

test('selection/settings changes during durable edit preserve the new list and the newer choice', async () => {
  const saved = deferred(); let saves = 0;
  const env = environment(command => command === 'save_config' && ++saves === 1 ? saved.promise : undefined);
  seed(env); await editor(env);
  const pending = env.element('#server-form').fire('submit'); await settle();
  const draft = env.element('#server-form').elements.address.value;
  env.run(`selectServer(${json(B.id)})`);
  env.element('#view-only').checked = true; await env.element('#view-only').fire('change');
  assert.equal(env.element('#server-form').elements.address.value, draft);
  // Duplicate submit/cancel cannot mutate or abandon a pending transaction.
  await env.element('#server-form').fire('submit');
  await env.element('#server-dialog-close').fire('click');
  assert.equal(env.element('#server-dialog').open, true);
  saved.resolve(); await pending; await settle();
  assert.equal(env.run('selectedId'), B.id);
  const latest = env.calls.filter(call => call.command === 'save_config').at(-1).args.config;
  assert.equal(latest.selectedId, B.id);
  assert.equal(latest.settings.viewOnly, true);
  assert.equal(latest.servers[0].address, draft);
  assert.notEqual(latest.servers[0].id, A.id);
});

test('editor identity remains bound to its original server if selection changes before submit', async () => {
  const env = environment(); seed(env); await editor(env);
  env.run(`selectServer(${json(B.id)})`);
  await env.element('#server-form').fire('submit');
  assert.deepEqual(value(env, 'servers[1]'), B);
  assert.equal(env.run('selectedId'), B.id);
  assert.equal(value(env, 'servers[0]').address, 'replacement.invalid::5900');
});

test('SSH profile failures do not publish unsaved state, and queued profile saves keep edits', async () => {
  const env = environment(command => command === 'save_config' ? Promise.reject(new Error('TEST unwritable')) : undefined);
  seed(env);
  await assert.rejects(env.sshState.onProfileChange(A.id, { host: 'ssh.invalid', port: 22, username: 'tester' }));
  assert.deepEqual(value(env, 'servers'), [A, B]);
  const saved = deferred(); let saves = 0;
  const other = environment(command => command === 'save_config' && ++saves === 1 ? saved.promise : undefined);
  seed(other); await other.element('#edit-server').fire('click');
  other.element('#server-form').elements.name.value = 'Renamed';
  const edit = other.element('#server-form').fire('submit'); await settle();
  const profile = other.sshState.onProfileChange(A.id, { host: 'ssh.invalid', port: 22, username: 'tester' });
  saved.resolve(); await Promise.all([edit, profile]);
  assert.equal(value(other, 'servers[0]').name, 'Renamed');
  assert.equal(value(other, 'servers[0]').ssh.host, 'ssh.invalid');
});

test('a rejected stored PVE password can be replaced only after new authentication succeeds', async () => {
  let stored = 'OLD'; let first = true;
  const env = environment((command, args) => {
    if (command === 'password_saved') return true;
    if (command === 'load_password') return stored;
    if (command === 'connect_pve' && first) { first = false; throw { stage: 'pve_login', code: 'unauthorized', safeMessage: 'TEST wrong password' }; }
    if (command === 'save_password') { stored = args.password; return null; }
  });
  seed(env); await env.element('#connect').fire('click');
  assert.equal(env.element('#empty-action').textContent, '重新输入密码');
  assert.deepEqual(value(env, 'connectionError'), { stage: 'pve_login', code: 'unauthorized', safeMessage: 'TEST wrong password' });
  const loads = env.calls.filter(call => call.command === 'load_password').length;
  await env.element('#empty-action').fire('click');
  assert.equal(env.element('#password-dialog').open, true);
  assert.equal(env.calls.filter(call => call.command === 'load_password').length, loads);
  env.element('#password').value = 'NEW';
  await env.element('#password-form').fire('submit');
  assert.equal(stored, 'OLD');
  await env.sessions.at(-1).emit('connect');
  assert.equal(stored, 'NEW');
  await env.element('#connect').fire('click'); await env.element('#connect').fire('click');
  const attempts = env.calls.filter(call => call.command === 'connect_pve');
  assert.deepEqual(attempts.map(call => call.args.request.password), ['OLD', 'NEW', 'NEW']);
  assert.equal(new Set(attempts.map(call => call.args.request.sessionId)).size, 3);
  assert.equal(env.calls.some(call => call.command === 'forget_password'), false);
});

test('failed replacement and cancellation keep old credentials; unremembered success does not reuse the rejected value', async () => {
  const env = environment(command => command === 'password_saved' ? true : command === 'load_password' ? 'OLD' : undefined);
  seed(env, [D], D.id); await env.element('#connect').fire('click');
  const ask = () => env.sessions.at(-1).emit('credentialsrequired', { types: ['password'] });
  await ask();
  const reject = () => {
    const session = env.sessions.at(-1);
    session._rfbAuthScheme = 2; session._rfbInitState = 'SecurityResult';
    return session.emit('securityfailure', { status: 1, reason: 'TEST incorrect' });
  };
  await reject(); await env.element('#empty-action').fire('click');
  await ask();
  env.element('#password').value = 'WRONG'; await env.element('#password-form').fire('submit'); await reject();
  assert.equal(env.calls.some(call => call.command === 'save_password'), false);
  await env.element('#empty-action').fire('click'); await ask(); await env.element('#password-cancel').fire('click');
  assert.equal(env.run('activeOperation'), null);
  await env.element('#connect').fire('click');
  await ask();
  env.element('#password').value = 'NEW'; env.element('#remember-password').checked = false;
  await env.element('#password-form').fire('submit'); await env.sessions.at(-1).emit('connect');
  await env.element('#connect').fire('click'); await env.element('#connect').fire('click');
  await ask();
  assert.equal(env.element('#password-dialog').open, true);
  assert.equal(env.calls.filter(call => call.command === 'load_password').length, 1);
  assert.equal(env.calls.some(call => ['save_password', 'forget_password'].includes(call.command)), false);
});

for (const [stage, code] of [['tls_handshake', 'certificate'], ['pve_proxy', 'unauthorized'], ['pve_login', 'forbidden'],
  ['rfb_security', 'unsupported_security'], ['rfb_auth', 'auth_limited'], ['rfb_init', 'timeout']]) {
  test(`${stage}/${code} is preserved without classifying it as a bad password`, async () => {
    const env = environment(command => command === 'password_saved' ? true : command === 'connect_pve'
      ? Promise.reject({ stage, code, safeMessage: 'TEST distinct error' }) : undefined);
    seed(env); await env.element('#connect').fire('click');
    assert.deepEqual(value(env, 'connectionError'), { stage, code, safeMessage: 'TEST distinct error' });
    assert.equal(env.element('#empty-action').textContent, '重新连接');
    assert.equal(env.element('#password-dialog').open, false);
    assert.equal(env.run('rejectedPasswords.size'), 0);
  });
}

test('noVNC missing security types are not password failures; actual SecurityResult limits get a retry-limit message', async () => {
  const env = environment(); seed(env, [D], D.id);
  await env.run('startConnection(beginOperation(), "TEST")');
  const unsupported = env.sessions.at(-1);
  unsupported._rfbAuthScheme = 2; unsupported._securityContext = 'authentication scheme';
  await unsupported.emit('securityfailure', { status: 1 });
  assert.equal(env.run('rejectedPasswords.size'), 0);
  await env.run('startConnection(beginOperation(), "TEST")');
  const locked = env.sessions.at(-1);
  locked._rfbAuthScheme = 2; locked._securityContext = 'security result';
  await locked.emit('securityfailure', { status: 2 });
  assert.equal(env.run('connectionError.code'), 'auth_limited');
  assert.match(env.element('#empty-description').textContent, /限制.*稍后/);
  assert.equal(env.run('rejectedPasswords.size'), 0);
});

test('backend authentication errors retain their structure across the event bridge', async () => {
  const env = environment(); await env.run('boot()'); seed(env); await env.run('startConnection(beginOperation(), "TEST")');
  const sessionId = env.calls.find(call => call.command === 'connect_pve').args.request.sessionId;
  env.events.get('vnc-error')({ payload: { sessionId, stage: 'rfb_auth', code: 'unauthorized', safeMessage: 'TEST expired' } });
  assert.equal(env.run('connectionError.stage'), 'rfb_auth');
  assert.equal(env.element('#empty-action').textContent, '重新输入密码');
});

for (const phase of ['ProtocolVersion', 'Security', 'Authentication', 'SecurityResult', 'ServerInitialisation']) {
  test(`connection deadline covers stalled ${phase} and releases only that session`, async () => {
    const env = environment(); seed(env, [D], D.id); await env.run('startConnection(beginOperation(), "TEST")');
    const session = env.sessions.at(-1); session._rfbInitState = phase;
    const id = env.calls.find(call => call.command === 'connect_direct').args.request.sessionId;
    env.advance(59999); assert.equal(session.disconnectCount, 0);
    env.advance(1); assert.equal(session.disconnectCount, 1);
    assert.equal(env.run('connectionError.code'), 'timeout');
    assert.ok(env.calls.some(call => call.command === 'disconnect' && call.args.sessionId === id));
    await env.run('startConnection(beginOperation(), "TEST")');
    const next = env.sessions.at(-1); await next.emit('connect'); env.advance(120000);
    assert.equal(next.disconnectCount, 0);
  });
}

test('password entry pauses the deadline; submission resumes it, and stale timers cannot close a replacement', async () => {
  const env = environment(); seed(env);
  await env.element('#connect').fire('click'); env.advance(120000);
  assert.equal(env.element('#password-dialog').open, true);
  assert.equal(env.run('connecting'), true);
  env.element('#password').value = 'TEST'; await env.element('#password-form').fire('submit');
  const first = env.sessions.at(-1);
  const stale = [...env.timers.values()][0].fn;
  first.emit('credentialsrequired', { types: ['password'] }); env.advance(120000);
  assert.equal(first.disconnectCount, 0);
  env.element('#password').value = 'SUPPLEMENT'; await env.element('#password-form').fire('submit');
  env.run(`selectServer(${json(B.id)})`); await env.run('startConnection(beginOperation(), "TEST")');
  const next = env.sessions.at(-1); stale();
  assert.equal(next.disconnectCount, 0);
  await next.emit('connect'); env.advance(120000);
  assert.equal(next.disconnectCount, 0);
});

test('deadline includes an unfinished backend reservation and ignores its late completion', async () => {
  const reservation = deferred();
  const env = environment(command => command === 'begin_session' ? reservation.promise : undefined);
  seed(env); const pending = env.run('startConnection(beginOperation(), "TEST")'); await settle();
  env.advance(60000); assert.equal(env.run('activeOperation'), null);
  reservation.resolve('LATE_SESSION'); await pending;
  assert.equal(env.calls.some(call => call.command === 'connect_pve'), false);
  assert.ok(env.calls.some(call => call.command === 'disconnect' && call.args.sessionId === 'LATE_SESSION'));
});

test('search, layout, preferences and unchanged renders do not query or load credentials', async () => {
  const env = environment(); seed(env); env.run('render()');
  for (const term of ['a', 'ab', 'abc', '']) { env.element('#server-search').value = term; await env.element('#server-search').fire('input'); }
  env.run('render(); render(); switchMode("direct")');
  await env.element('#toggle-left').fire('click'); await env.element('#scale').fire('change');
  assert.equal(env.calls.some(call => ['password_saved', 'load_password'].includes(call.command)), false);
  env.run(`selectServer(${json(B.id)})`); await settle();
  assert.equal(env.calls.filter(call => call.command === 'password_saved').length, 1);
  assert.equal(env.calls.some(call => call.command === 'load_password'), false);
});

test('canonical PVE spelling preserves credentials; invalid legacy origins remain editable', async () => {
  const env = environment(); seed(env, [{ ...A, origin: 'a.invalid:8006///' }, B]);
  await env.element('#edit-server').fire('click');
  env.element('#server-form').elements.name.value = 'Renamed';
  await env.element('#server-form').fire('submit');
  assert.equal(value(env, 'servers[0]').id, A.id);
  assert.equal(value(env, 'servers[0]').origin, A.origin);
  assert.equal(env.calls.some(call => call.command === 'forget_password'), false);
  const old = { ...A, origin: 'http://a.invalid:8006/old-path' };
  env.run(`applyStored(${json({ servers: [old, B], selectedId: A.id })})`);
  assert.equal(env.run('configReady'), true);
  await env.element('#edit-server').fire('click');
  env.element('#server-form').elements.origin.value = 'https://a.invalid:8006';
  await env.element('#server-form').fire('submit');
  assert.notEqual(value(env, 'servers[0]').id, A.id);
  assert.deepEqual(value(env, 'servers[1]'), { ...B, insecure: false });
});
