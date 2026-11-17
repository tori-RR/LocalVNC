const { test } = require('node:test');
const assert = require('node:assert/strict');
const { environment, seed, settle, deferred, A, B, D } = require('./harness.cjs');
const mac = { ...D, username: 'mac-demo' };
const value = (env, code) => JSON.parse(env.run(`JSON.stringify(${code})`));
async function connect(env, password = 'TEST_ONLY_MAC') {
  await env.element('#connect').fire('click');
  if (env.run('activeOperation.server.kind') === 'direct') {
    await env.sessions.at(-1).emit('credentialsrequired', {
      types: env.run('!!activeOperation.server.username') ? ['username', 'password'] : ['password'],
    });
  }
  env.element('#password').value = password;
  await env.element('#password-form').fire('submit');
}

test('legacy direct profiles stay password-only; stored Mac usernames survive loading', () => {
  const env = environment();
  assert.equal(value(env, `normalizeServer(${JSON.stringify(D)})`).username, '');
  assert.equal(value(env, `normalizeServer(${JSON.stringify(mac)})`).username, 'mac-demo');
});

test('Mac profile supplies a username only when noVNC asks, without sending a password to the bridge', async () => {
  const env = environment(); seed(env, [mac], mac.id);
  await connect(env);
  const request = env.calls.find(call => call.command === 'connect_direct').args.request;
  assert.equal('accountAuth' in request, false);
  assert.equal('password' in request, false);
  assert.deepEqual(value(env, 'rfb.credentials'), { username: 'mac-demo', password: 'TEST_ONLY_MAC' });
  assert.equal(env.element('#password-username-field').hidden, false);
  assert.equal(env.element('#password-username').readOnly, false);
  assert.equal(env.calls.some(call => call.command === 'save_password'), false);
  await env.sessions[0].emit('connect');
  assert.equal(env.calls.find(call => call.command === 'save_password').args.password, 'TEST_ONLY_MAC');
});

test('blank VNC username sends only a password and does not inherit the PVE or SSH account', async () => {
  const env = environment(); seed(env, [D], D.id);
  await connect(env, '');
  assert.deepEqual(value(env, 'rfb.credentials'), { password: '' });
  assert.equal(env.element('#password-username-field').hidden, true);
});

test('automatic username detection opens one account prompt and saves its identity only after authentication', async () => {
  const env = environment(); seed(env, [D], D.id);
  await env.element('#connect').fire('click');
  assert.equal(env.element('#password-dialog').open, false);
  const session = env.sessions[0];
  await session.emit('credentialsrequired', { types: ['username', 'password'] });
  assert.equal(env.element('#password-dialog').open, true);
  assert.equal(env.element('#password-username').required, true);
  assert.equal(env.element('#remember-password').disabled, false);
  env.advance(120000);
  assert.equal(session.disconnectCount, 0);
  await env.element('#password-form').fire('submit');
  assert.equal(session.credentials, undefined);
  env.element('#password-username').value = 'mac-demo';
  env.element('#password').value = 'TEST_ONLY_SUPPLEMENT';
  await env.element('#password-form').fire('submit');
  assert.deepEqual(value(env, 'rfb.credentials'), { username: 'mac-demo', password: 'TEST_ONLY_SUPPLEMENT' });
  assert.equal(value(env, 'servers[0]').username, undefined);
  assert.equal(env.calls.some(call => call.command === 'save_password'), false);
  await session.emit('connect');
  const saved = value(env, 'servers[0]');
  assert.equal(saved.username, 'mac-demo');
  assert.notEqual(saved.id, D.id);
  assert.equal(env.run('selectedId'), saved.id);
  assert.equal(session.disconnectCount, 0);
  assert.equal(env.calls.find(call => call.command === 'save_password').args.serverId, saved.id);
});

test('changing a Mac username rotates credential identity only after the profile is saved', async () => {
  const env = environment(); seed(env, [mac], mac.id);
  await env.element('#edit-server').fire('click');
  env.element('#server-form').elements.vncUsername.value = 'another-account';
  await env.element('#server-form').fire('submit'); await settle();
  assert.notEqual(value(env, 'servers[0]').id, mac.id);
  assert.equal(value(env, 'servers[0]').username, 'another-account');
  const save = env.calls.findIndex(call => call.command === 'save_config');
  const cleanup = env.calls.findIndex(call => call.command === 'forget_password');
  assert(cleanup > save);
});

test('Mac SecurityResult failures allow explicit re-entry; unsupported requests do not', async () => {
  const env = environment(); seed(env, [mac], mac.id); await connect(env);
  Object.assign(env.sessions[0], { _rfbAuthScheme: 30, _rfbInitState: 'SecurityResult' });
  env.sessions[0].emit('securityfailure', { status: 1, reason: 'TEST wrong account password' });
  assert.equal(value(env, 'connectionError').code, 'unauthorized');
  assert.equal(env.run('rejectedPasswords.has(selectedId)'), true);
  await connect(env);
  env.sessions.at(-1).emit('credentialsrequired', { types: ['target'] });
  assert.equal(env.element('#password-dialog').open, false);
  assert.equal(value(env, 'connectionError').code, 'failed');
});

test('Mac credentials exceeding protocol byte limits remain in the dialog instead of being silently truncated', async () => {
  const env = environment(); seed(env, [mac], mac.id);
  await connect(env, '密'.repeat(22));
  assert.equal(env.element('#password-dialog').open, true);
  assert.match(env.element('#password-note').textContent, /63/);
  assert.equal(env.sessions[0].credentials, undefined);
});

test('no-auth servers connect without a credential dialog or a password lookup', async () => {
  const env = environment(); seed(env, [D], D.id);
  await env.element('#connect').fire('click'); await env.sessions[0].emit('connect');
  assert.equal(env.element('#password-dialog').open, false);
  assert.equal(env.calls.some(call => ['password_saved', 'load_password'].includes(call.command)), false);
});

test('a prefilled Mac username does not force a username field on a password-only server', async () => {
  const env = environment(); seed(env, [mac], mac.id); await env.element('#connect').fire('click');
  await env.sessions[0].emit('credentialsrequired', { types: ['password'] });
  assert.equal(env.element('#password-username-field').hidden, true);
  env.element('#password').value = 'TEST_ONLY_VNC'; await env.element('#password-form').fire('submit');
  assert.deepEqual(value(env, 'rfb.credentials'), { password: 'TEST_ONLY_VNC' });
});

test('changing from account to password-only authentication cannot reuse or overwrite the account password', async () => {
  const env = environment(command => command === 'password_saved' ? true : command === 'load_password' ? 'MAC_ACCOUNT_PASSWORD' : undefined);
  seed(env, [mac], mac.id); await env.element('#connect').fire('click');
  await env.sessions[0].emit('credentialsrequired', { types: ['password'] });
  assert.equal(env.calls.some(call => call.command === 'load_password'), false);
  assert.equal(env.element('#password-dialog').open, true);
  env.element('#password').value = 'VNC_ONLY_PASSWORD'; await env.element('#password-form').fire('submit');
  await env.sessions[0].emit('connect');
  const saved = value(env, 'servers[0]');
  assert.equal(saved.username, '');
  assert.notEqual(saved.id, mac.id);
  assert.equal(env.sessions[0].disconnectCount, 0);
  assert.equal(env.calls.find(call => call.command === 'save_password').args.serverId, saved.id);
  assert.equal(env.calls.find(call => call.command === 'save_password').args.password, 'VNC_ONLY_PASSWORD');
});

test('stored account credentials are loaded after negotiation and resume without a dialog', async () => {
  const env = environment(command => command === 'password_saved' ? true : command === 'load_password' ? 'STORED' : undefined);
  seed(env, [mac], mac.id); await env.element('#connect').fire('click');
  assert.equal(env.calls.some(call => call.command === 'load_password'), false);
  await env.sessions[0].emit('credentialsrequired', { types: ['username', 'password'] });
  assert.deepEqual(value(env, 'rfb.credentials'), { username: 'mac-demo', password: 'STORED' });
  assert.equal(env.element('#password-dialog').open, false);
});

test('failed automatic username persistence keeps the authenticated session and never saves a mismatched password', async () => {
  const env = environment(command => command === 'save_config' ? Promise.reject(new Error('TEST conflict')) : undefined);
  seed(env, [D], D.id); await env.element('#connect').fire('click');
  await env.sessions[0].emit('credentialsrequired', { types: ['username', 'password'] });
  env.element('#password-username').value = 'mac-demo'; env.element('#password').value = 'TEST_ONLY';
  await env.element('#password-form').fire('submit'); await env.sessions[0].emit('connect');
  assert.equal(value(env, 'servers[0]').id, D.id);
  assert.equal(env.sessions[0].disconnectCount, 0);
  assert.equal(env.calls.some(call => call.command === 'save_password'), false);
});

test('unremembered account logins keep username and password only in the active connection', async () => {
  const env = environment(); seed(env, [D], D.id); await env.element('#connect').fire('click');
  await env.sessions[0].emit('credentialsrequired', { types: ['username', 'password'] });
  env.element('#password-username').value = 'mac-demo'; env.element('#password').value = 'TEST_ONLY';
  env.element('#remember-password').checked = false;
  await env.element('#password-form').fire('submit'); await env.sessions[0].emit('connect');
  assert.equal(value(env, 'servers[0]').username, undefined);
  assert.equal(env.calls.some(call => ['save_config', 'save_password'].includes(call.command)), false);
});

test('duplicate credential requests share one lookup; a late lookup cannot send to a replacement session', async () => {
  const pending = deferred();
  const env = environment(command => command === 'password_saved' ? true : command === 'load_password' ? pending.promise : undefined);
  seed(env, [mac, B], mac.id); await env.element('#connect').fire('click');
  const old = env.sessions[0];
  const first = old.emit('credentialsrequired', { types: ['username', 'password'] });
  await old.emit('credentialsrequired', { types: ['username', 'password'] }); await settle();
  assert.equal(env.calls.filter(call => call.command === 'load_password').length, 1);
  env.run(`selectServer(${JSON.stringify(B.id)})`);
  pending.resolve('OLD'); await first;
  assert.equal(old.credentials, undefined);
  assert.equal(env.element('#password-dialog').open, false);
});

test('automatic credential lookups retain the connection deadline until a user dialog opens', async () => {
  const pending = deferred();
  const env = environment(command => command === 'password_saved' ? pending.promise : undefined);
  seed(env, [D], D.id); await env.element('#connect').fire('click');
  const lookup = env.sessions[0].emit('credentialsrequired', { types: ['password'] });
  env.advance(60000);
  assert.equal(value(env, 'connectionError').code, 'timeout');
  pending.resolve(false); await lookup;
  assert.equal(env.element('#password-dialog').open, false);
});

test('PVE console credentials do not inherit its host account as an ARD username', async () => {
  const env = environment(); seed(env, [A], A.id); await connect(env);
  assert.deepEqual(value(env, 'rfb.options.credentials'), { password: 'TEST_ONLY_TICKET' });
  env.sessions[0].emit('credentialsrequired', { types: ['username', 'password'] });
  assert.equal(env.element('#password-dialog').open, false);
  assert.equal(env.sessions[0].disconnectCount, 1);
});
