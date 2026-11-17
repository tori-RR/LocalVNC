const assert = require('node:assert/strict');
const { test } = require('node:test');
const { environment, seed, settle, deferred, D } = require('./harness.cjs');

test('F02 credential generation is acquired before authentication starts and reused at save', async () => {
  const lease = deferred();
  const env = environment(command => command === 'credential_generation' ? lease.promise : undefined);
  seed(env, [D], D.id);
  const pending = env.run('startConnection(beginOperation(), "TEST")');
  await settle();
  assert.equal(env.calls.some(call => call.command === 'connect_direct'), false);
  lease.resolve('CAPTURED_BEFORE_AUTH'); await pending;
  await env.sessions.at(-1).emit('credentialsrequired', { types: ['password'] });
  env.element('#password').value = 'SYNTHETIC';
  await env.element('#password-form').fire('submit');
  await env.sessions.at(-1).emit('connect');
  const save = env.calls.find(call => call.command === 'save_password');
  assert.equal(save.args.generation, 'CAPTURED_BEFORE_AUTH');
  assert.equal(env.calls.filter(call => call.command === 'credential_generation').length, 1);
});

test('F05 cosmetic edits and unchanged saves preserve the active connection and update its display', async () => {
  const env = environment(); seed(env, [D], D.id);
  await env.run('startConnection(beginOperation(), "TEST")');
  const session = env.sessions.at(-1); await session.emit('connect');
  for (const name of ['Renamed desktop', 'Renamed desktop']) {
    await env.element('#edit-server').fire('click');
    env.element('#server-form').elements.name.value = name;
    await env.element('#server-form').fire('submit');
    assert.equal(session.disconnectCount, 0);
    assert.equal(env.run('activeOperation.server.name'), name);
    assert.equal(env.element('#stage-title').textContent, name);
  }
});

test('F05 security policy edits rebuild the connection while preserving the credential ID', async () => {
  const env = environment(); seed(env, [{ ...D, securityPolicy: 'plain' }], D.id);
  await env.run('startConnection(beginOperation(), "TEST")');
  const session = env.sessions.at(-1); await session.emit('connect');
  await env.element('#edit-server').fire('click');
  env.element('#server-form').elements.securityPolicy.value = 'requireTls';
  await env.element('#server-form').fire('submit');
  assert.equal(session.disconnectCount, 1);
  assert.equal(env.run('servers[0].id'), D.id);
  assert.equal(env.calls.some(call => call.command === 'forget_password'), false);
});

test('F06 failed-save render preserves kind-specific field disabling and the draft', async () => {
  let fail = true;
  const env = environment(command => command === 'save_config' && fail ? Promise.reject(Error('TEST storage failure')) : undefined);
  seed(env, [D], D.id);
  const form = env.element('#server-form');
  const vmid = form.elements.vmid, address = form.elements.address;
  vmid.tagName = address.tagName = 'INPUT';
  vmid.querySelectorAll = address.querySelectorAll = () => [];
  form.querySelectorAll = selector => selector === '.for-pve' ? [vmid] : selector === '.for-direct' ? [address] : [vmid, address];
  await env.element('#edit-server').fire('click');
  vmid.value = '0';
  await form.fire('submit');
  assert.equal(vmid.value, '0');
  assert.equal(vmid.hidden, true);
  assert.equal(vmid.disabled, true);
  assert.equal(address.disabled, false);
  assert.equal(env.element('#server-dialog').open, true);
  fail = false; await form.fire('submit');
  assert.equal(env.element('#server-dialog').open, false);
});

for (const code of ['integrity', 'protocol', 'handshake']) {
  test(`F07 TLS ${code} failure terminates without automatic recovery`, async () => {
    const env = environment(); await env.run('boot()'); seed(env, [D], D.id);
    await env.run('startConnection(beginOperation(), "TEST")');
    await env.sessions.at(-1).emit('connect');
    const sessionId = env.run('activeOperation.sessionId');
    env.events.get('vnc-error')({ payload: { sessionId, stage: 'tls', code, safeMessage: 'TEST TLS failure' } });
    await settle(); env.advance(60000);
    assert.equal(env.run('recovery'), null);
    assert.equal(env.sessions.length, 1);
  });
}
