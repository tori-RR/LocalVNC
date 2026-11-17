const { test } = require('node:test');
const assert = require('node:assert/strict');
const { environment, deferred, settle, seed, A, B, D } = require('./harness.cjs');
const json = value => JSON.stringify(value);
const value = (env, code) => JSON.parse(env.run(`JSON.stringify(${code})`));
async function connect(env, password = 'TEST_ONLY') {
  return env.run(`startConnection(beginOperation(), ${json(password)})`);
}

test('mixed PVE/direct config survives load/save and removes stale fields', async () => {
  const env = environment();
  env.run(`applyStored(${json({servers:[{...A, address:'stale::5900'},D], selectedId:A.id})}); persist();`);
  await settle();
  const saved = env.calls.find(c => c.command === 'save_config').args.config;
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.servers.length, 2);
  assert.equal(saved.servers[0].kind, 'pve');
  assert.equal(saved.servers[0].address, undefined);
  assert.equal(saved.selectedId, A.id);
  env.run(`applyStored(${json(saved)})`);
  assert.deepEqual(value(env, 'snapshot()'), saved);
});

test('unknown or damaged config prevents any automatic overwrite', async () => {
  for (const config of [{servers:[{...A, kind:'unknown'}]}, {servers:[A,A]}, {schemaVersion:99, servers:[]}, {}]) {
    const env = environment();
    assert.throws(() => env.run(`applyStored(${json(config)})`));
    env.run('persist()'); await settle();
    assert.equal(env.calls.some(c => c.command === 'save_config'), false);
  }
});

test('legacy address remains intact and global insecure does not silently carry forward', () => {
  const env = environment();
  env.run(`applyStored(${json({servers:[A,{id:D.id,name:D.name,address:'[::1]::5901'}],settings:{insecure:true}})})`);
  assert.equal(value(env, 'servers[0]').insecure, false);
  assert.equal(value(env, 'servers[1]').address, '[::1]::5901');
});

for (const delayedCommand of ['password_saved', 'load_password']) {
  test(`switching target during ${delayedCommand} cannot submit A password to B`, async () => {
    const delay = deferred();
    const env = environment(command => command === delayedCommand ? delay.promise : command === 'password_saved' ? true : undefined);
    seed(env);
    const click = env.element('#connect').fire('click'); await settle();
    env.run(`selectServer(${json(B.id)})`);
    delay.resolve(delayedCommand === 'password_saved' ? true : 'TEST_ONLY_A');
    await click; await settle();
    assert.equal(env.calls.some(c => c.command === 'connect_pve'), false);
  });
}

test('dialog target is cancelled on selection change and does not save before auth', async () => {
  const env = environment(); seed(env);
  await env.element('#connect').fire('click');
  env.element('#password').value = 'TEST_ONLY_A';
  env.run(`selectServer(${json(B.id)})`);
  await env.element('#password-form').fire('submit');
  assert.equal(env.calls.some(c => ['connect_pve','save_password'].includes(c.command)), false);
});

test('late connection completion only disconnects its own backend session', async () => {
  const pendingA = deferred();
  const env = environment((command,args) => command === 'connect_pve' && args.request.origin === A.origin ? pendingA.promise : undefined);
  seed(env);
  const old = connect(env); await settle();
  const oldId = env.calls.find(c => c.command === 'connect_pve').args.request.sessionId;
  env.run(`selectServer(${json(B.id)})`);
  await connect(env);
  const current = env.sessions.at(-1);
  pendingA.resolve({url:'ws://test.invalid/A',password:'TEST_TICKET'});
  await old; await settle();
  assert.equal(env.sessions.at(-1), current);
  assert.equal(current.disconnectCount, 0);
  assert.equal(env.calls.filter(c => c.command === 'disconnect').every(c => c.args.sessionId === oldId), true);
});

test('late reservation is released before a newer reservation completes', async () => {
  const delay = deferred(); let calls = 0;
  const env = environment(command => command === 'begin_session' && ++calls === 1 ? delay.promise : undefined);
  seed(env); const old = connect(env); await settle();
  env.run(`selectServer(${json(B.id)})`); const current = connect(env);
  delay.resolve('OLD_SESSION'); await old; await current;
  const starts = env.calls.filter(c => c.command === 'connect_pve');
  assert.equal(starts.length, 1); assert.equal(starts[0].args.request.origin, B.origin);
  assert(env.calls.some(c => c.command === 'disconnect' && c.args.sessionId === 'OLD_SESSION'));
});

test('old security and disconnect callbacks do not change a new session', async () => {
  const env = environment(); seed(env); await connect(env);
  const old = env.sessions.at(-1);
  env.run(`selectServer(${json(B.id)})`); await connect(env);
  const current = env.sessions.at(-1);
  old.emit('securityfailure', {reason:'STALE'}); old.emit('disconnect');
  assert.equal(current.disconnectCount, 0);
  assert.equal(env.run('rfb'), current);
});

test('empty password stays explicit and supplemental credentials are handled', async () => {
  const env = environment(); seed(env,[D],D.id); await connect(env,'');
  const session = env.sessions.at(-1);
  assert.equal(session.options.credentials.password, '');
  await session.emit('credentialsrequired',{types:['password']});
  env.element('#password').value = 'SUPPLEMENT';
  await env.element('#password-form').fire('submit');
  assert.equal(session.credentials.password, 'SUPPLEMENT');
});

test('password is saved after successful authentication; save failure keeps connection', async () => {
  const env = environment(command => command === 'save_password' ? Promise.reject(new Error('mock vault unavailable')) : undefined);
  seed(env); await env.element('#connect').fire('click');
  env.element('#password').value = 'TEST_ONLY';
  env.element('#remember-password').checked = true;
  await env.element('#password-form').fire('submit');
  assert.equal(env.calls.some(c => c.command === 'save_password'), false);
  const session = env.sessions.at(-1); await session.emit('connect');
  assert.equal(env.calls.filter(c => c.command === 'save_password').length, 1);
  assert.equal(session.disconnectCount, 0);
  assert.match(env.element('#stage-hint').textContent, /未能保存/);
});

test('failed authentication cannot overwrite a stored credential', async () => {
  const env = environment(); seed(env); await env.element('#connect').fire('click');
  env.element('#password').value = 'WRONG'; env.element('#remember-password').checked = true;
  await env.element('#password-form').fire('submit');
  env.sessions.at(-1).emit('securityfailure',{reason:'failed'});
  assert.equal(env.calls.some(c => c.command === 'save_password'), false);
  assert.equal(env.element('#password-dialog').open, false);
});

test('editing target rotates credential identity and strips fields of previous kind', async () => {
  const env = environment(); seed(env); env.run(`fillForm(selectedServer())`);
  env.element('#server-kind').value = 'direct';
  env.element('#server-form').elements.name.value = A.name;
  env.element('#server-form').elements.address.value = 'new.invalid::5900';
  await env.element('#server-form').fire('submit');
  const changed = value(env, 'servers[0]');
  assert.notEqual(changed.id, A.id); assert.equal(changed.origin, undefined);
  assert.equal(changed.kind, 'direct');
});

test('backend errors are scoped to their session', async () => {
  const env = environment(); await env.run('boot()'); seed(env); await connect(env);
  const current = env.sessions.at(-1);
  env.events.get('vnc-error')({payload:{sessionId:'OLD',safeMessage:'STALE'}});
  assert.equal(current.disconnectCount, 0);
  const sessionId = env.calls.find(c => c.command === 'connect_pve').args.request.sessionId;
  env.events.get('vnc-error')({payload:{sessionId,safeMessage:'TLS error'}});
  assert.equal(current.disconnectCount, 1);
  assert.equal(env.element('#stage-hint').textContent, 'TLS error');
});

test('mode tabs filter server list without disconnecting the active console', async () => {
  const env = environment(); seed(env, [A, D]); await connect(env);
  const session = env.sessions.at(-1);
  env.run('switchMode("direct")');
  assert.equal(env.element('#servers').children.length, 1);
  assert.equal(env.element('#servers').children[0].children[0].children[0].textContent, D.name);
  assert.equal(env.run('selectedId'), A.id);
  assert.equal(session.disconnectCount, 0);
  assert.equal(env.run('layout.mode'), 'direct');
});

test('sidebar controls persist visibility without closing VNC', async () => {
  const env = environment(); seed(env); await connect(env);
  const session = env.sessions.at(-1);
  await env.element('#toggle-left').fire('click');
  await env.element('#toggle-right').fire('click');
  assert.equal(env.element('#app').classList.contains('left-hidden'), true);
  assert.equal(env.element('#app').classList.contains('right-hidden'), true);
  await settle();
  const saved = env.calls.filter(c => c.command === 'save_config').at(-1).args.config;
  assert.equal(saved.layout.leftVisible, false);
  assert.equal(saved.layout.rightVisible, false);
  assert.equal(session.disconnectCount, 0);
});

test('opening and cancelling new-server editor leaves the active selection intact', async () => {
  const env = environment(); seed(env); await connect(env);
  const session = env.sessions.at(-1);
  await env.element('#add-server').fire('click');
  assert.equal(env.element('#server-dialog').open, true);
  assert.equal(env.run('selectedId'), A.id);
  await env.element('#server-dialog-close').fire('click');
  assert.equal(env.element('#server-dialog').open, false);
  assert.equal(session.disconnectCount, 0);
});

test('add flow hides actions that only apply to an existing server', async () => {
  const env = environment(); seed(env);
  await env.element('#add-server').fire('click');
  assert.equal(env.element('#new-server').hidden, true);
  assert.equal(env.element('#forget-password').hidden, true);
  await env.element('#server-dialog-close').fire('click');
  await env.element('#edit-server').fire('click');
  assert.equal(env.element('#new-server').hidden, false);
  assert.equal(env.element('#forget-password').hidden, false);
});

test('server deletion waits for explicit confirmation', async () => {
  const env = environment(); seed(env); env.run('render()');
  const removeButton = () => env.element('#servers').children[0].children[1];
  const dialog = env.element('#confirm-dialog');
  const declined = removeButton().fire('click');
  assert.equal(dialog.open, true);
  assert.match(env.element('#confirm-title').textContent, /Mock A/);
  dialog.open = false; dialog.returnValue = 'cancel'; await dialog.fire('close'); await declined;
  assert.deepEqual(value(env, 'servers.map(server => server.id)'), [A.id, B.id]);
  assert.equal(env.calls.some(call => ['save_config', 'forget_password'].includes(call.command)), false);
  const accepted = removeButton().fire('click');
  dialog.open = false; dialog.returnValue = 'delete'; await dialog.fire('close'); await accepted; await settle();
  assert.deepEqual(value(env, 'servers.map(server => server.id)'), [B.id]);
  assert.equal(env.calls.find(call => call.command === 'forget_password').args.serverId, A.id);
});

test('new-server editor cannot clear the selected existing server credential', async () => {
  const saved = deferred();
  const env = environment(command => command === 'password_saved' ? saved.promise : undefined);
  seed(env);
  const refresh = env.run('refreshPasswordButton(selectedId)');
  await env.element('#add-server').fire('click');
  saved.resolve(true); await refresh;
  assert.equal(env.element('#forget-password').disabled, true);
  await env.element('#forget-password').fire('click');
  assert.equal(env.calls.some(call => call.command === 'forget_password'), false);
});

test('SSH profile and layout round-trip without storing password fields', () => {
  const env = environment();
  env.run(`applyStored(${json({servers:[{...A, ssh:{host:'ssh.invalid',port:2222,username:'tester',password:'EXCLUDE'}}],layout:{mode:'direct',leftVisible:false,rightVisible:true}})})`);
  assert.deepEqual(value(env, 'snapshot().servers[0].ssh'), {host:'ssh.invalid',port:2222,username:'tester'});
  assert.deepEqual(value(env, 'snapshot().layout'), {mode:'direct',leftVisible:false,rightVisible:true});
});

test('renaming a server preserves SSH profile; changing its endpoint removes the old association', async () => {
  const env = environment(); seed(env, [{...A,ssh:{host:'ssh.invalid',port:22,username:'tester'}}]);
  env.run('fillForm(selectedServer())');
  env.element('#server-form').elements.name.value = 'Renamed';
  await env.element('#server-form').fire('submit');
  assert.equal(value(env, 'selectedServer().ssh').host, 'ssh.invalid');
  env.element('#server-form').elements.origin.value = 'https://new.invalid:8006';
  await env.element('#server-form').fire('submit');
  assert.equal(env.run('selectedServer().ssh'), undefined);
});

test('authenticated VNC starts with click-to-control and stays connected after native blur', async () => {
  const env = environment(); seed(env); await connect(env);
  const session = env.sessions.at(-1);
  await session.emit('connect');
  assert.equal(env.inputState.session, session);
  assert.equal(session.viewOnly, true);
  assert.equal(session.focusOnClick, false);
  env.inputState.canControl = true; session.viewOnly = false;
  env.inputState.onChange();
  assert.equal(env.keyboardState.canControl, true);
  await env.element('#toggle-keyboard').fire('click');
  assert.equal(env.keyboardState.visible, true);
  assert.equal(session.cadCount, undefined);
  env.keyboardState.sendKey(97, 'KeyA', true);
  env.keyboardState.sendKey(97, 'KeyA', false);
  assert.equal(session.keys.length, 2);
  env.inputState.nativeFocusLost();
  assert.equal(session.viewOnly, true);
  assert.equal(env.keyboardState.canControl, false);
  env.keyboardState.sendKey(98, 'KeyB', true);
  assert.equal(session.keys.length, 2);
  assert.equal(session.disconnectCount, 0);
  assert.equal(env.calls.some(call => call.command === 'disconnect'), false);
});

test('read-only preference cannot be bypassed by ordinary rerenders or disabling the setting', async () => {
  const env = environment(); seed(env); await connect(env);
  const session = env.sessions.at(-1); await session.emit('connect');
  env.inputState.canControl = true; session.viewOnly = false;
  env.element('#view-only').checked = true;
  await env.element('#view-only').fire('change');
  assert.equal(env.inputState.readOnly, true);
  assert.equal(env.inputState.canControl, false);
  env.element('#view-only').checked = false;
  await env.element('#view-only').fire('change');
  assert.equal(env.inputState.readOnly, false);
  assert.equal(env.inputState.canControl, false);
  assert.equal(session.viewOnly, true);
  env.run('render()');
  assert.equal(env.keyboardState.canControl, false);
});

test('disconnect detaches input guard and a late connect event cannot attach an old session', async () => {
  const env = environment(); seed(env); await connect(env);
  const old = env.sessions.at(-1); await old.emit('connect');
  env.run(`selectServer(${json(B.id)})`);
  assert.equal(env.inputState.session, null);
  await connect(env);
  const current = env.sessions.at(-1); await current.emit('connect');
  await old.emit('connect');
  assert.equal(env.inputState.session, current);
});

test('opening the virtual keyboard while paused does not grant control or send CtrlAltDel', async () => {
  const env = environment(); seed(env); await connect(env);
  const session = env.sessions.at(-1); await session.emit('connect');
  await env.element('#toggle-keyboard').fire('click');
  assert.equal(env.keyboardState.visible, true);
  assert.equal(env.keyboardState.connected, true);
  assert.equal(env.keyboardState.canControl, false);
  assert.equal(env.keyboardState.beforeSend(), false);
  env.keyboardState.sendKey(97, 'KeyA', true);
  assert.equal(session.keys, undefined);
  assert.equal(session.cadCount, undefined);
  assert.equal(session.viewOnly, true);
});

test('virtual keyboard cannot send after disconnect or during a replacement handshake', async () => {
  const env = environment(); seed(env); await connect(env);
  const old = env.sessions.at(-1); await old.emit('connect');
  env.inputState.canControl = true; env.inputState.onChange();
  env.run(`selectServer(${json(B.id)})`);
  assert.equal(env.keyboardState.connected, false);
  assert.equal(env.keyboardState.canControl, false);
  env.keyboardState.sendKey(97, 'KeyA', true);
  assert.equal(old.keys, undefined);
  await connect(env);
  const current = env.sessions.at(-1);
  env.keyboardState.sendKey(97, 'KeyA', true);
  assert.equal(current.keys, undefined);
  assert.equal(env.keyboardState.connected, false);
});

test('server search filters names and endpoints within the chosen mode without changing an active session', async () => {
  const env = environment(); seed(env, [A, B, D]); await connect(env);
  const session = env.sessions.at(-1); await session.emit('connect');
  const visibleNames = () => env.element('#servers').children
    .filter(item => item.children.length).map(item => item.children[0].children[0].textContent);
  async function search(query, names) {
    env.element('#server-search').value = query;
    await env.element('#server-search').fire('input');
    assert.deepEqual(visibleNames(), names);
    assert.equal(env.run('selectedId'), A.id);
    assert.equal(env.run('rfb'), session);
    assert.equal(session.disconnectCount, 0);
    assert.equal(env.calls.some(call => call.command === 'disconnect'), false);
  }
  await search('  MOCK B  ', [B.name]);
  await search('a.invalid', [A.name]);
  await search('mock-b / 101', [B.name]);
  await search('vnc.invalid', []);
  assert.match(env.element('#servers').children[0].textContent, /没有匹配/);
  assert.equal(env.element('#server-count').textContent, '0 / 2');
  assert.equal(env.element('#clear-server-search').hidden, false);
  await env.element('#clear-server-search').fire('click');
  assert.equal(env.element('#server-search').value, '');
  assert.equal(env.element('#clear-server-search').hidden, true);
  assert.equal(env.element('#server-count').textContent, '2');
  assert.deepEqual(visibleNames(), [A.name, B.name]);
  assert.equal(session.disconnectCount, 0);
  await env.element('#mode-direct').fire('click');
  assert.equal(env.element('#server-search').value, '');
  await search('VNC.INVALID::5900', [D.name]);
  await search('a.invalid', []);
  assert.equal(env.element('#server-count').textContent, '0 / 1');
});

test('empty-workspace action opens a new editor with the selected mode and no implicit connection', async () => {
  const env = environment(); seed(env, [], '');
  env.run('switchMode("direct")');
  assert.equal(env.element('#workspace-empty').hidden, false);
  assert.equal(env.element('#empty-action').textContent, '添加服务器');
  await env.element('#empty-action').fire('click');
  assert.equal(env.element('#server-dialog').open, true);
  assert.equal(env.element('#server-form').dataset.mode, 'new');
  assert.equal(env.element('#server-kind').value, 'direct');
  assert.equal(env.run('selectedId'), '');
  assert.equal(env.calls.some(call => ['begin_session', 'connect_pve', 'connect_direct'].includes(call.command)), false);
});

test('empty-workspace action negotiates before requesting credentials for its selected target', async () => {
  const env = environment(); seed(env, [D], D.id); env.run('render()');
  assert.equal(env.element('#empty-title').textContent, '随时可以连接');
  assert.doesNotMatch(env.element('#empty-description').textContent, /vnc\.invalid/);
  assert.equal(env.element('#empty-action').textContent, '打开远程桌面');
  await env.element('#empty-action').fire('click');
  assert.equal(env.element('#password-dialog').open, false);
  await env.sessions.at(-1).emit('credentialsrequired', { types: ['password'] });
  assert.equal(env.element('#password-dialog').open, true);
  assert.equal(env.element('#password-title').textContent, D.name);
  assert.equal(env.element('#server-dialog').open, false);
  assert.equal(env.element('#workspace-empty').dataset.state, 'connecting');
  assert.equal(env.element('#empty-action').hidden, true);
  env.element('#password').value = '';
  await env.element('#password-form').fire('submit');
  assert.equal(env.calls.find(call => call.command === 'connect_direct').args.request.address, D.address);
  assert.equal(env.element('#workspace-empty').hidden, false);
  await env.sessions.at(-1).emit('connect');
  assert.equal(env.element('#workspace-empty').hidden, true);
  assert.equal(env.element('#stage-hint').hidden, true);
});

test('failed configuration disables the empty action and cannot open an editor or reserve a session', async () => {
  for (const selected of [false, true]) {
    const env = environment(); seed(env, selected ? [A] : [], selected ? A.id : '');
    env.run('configReady = false; render()');
    assert.equal(env.element('#empty-action').disabled, true);
    await env.element('#empty-action').fire('click');
    assert.equal(env.element('#server-dialog').open, false);
    assert.equal(env.element('#password-dialog').open, false);
    assert.equal(env.calls.some(call => call.command === 'begin_session'), false);
  }
});

test('configuration and credential errors are not presented as connection failures', () => {
  const env = environment(); seed(env); env.run('render()');
  env.run('setHint("TEST credential removal failed", true)');
  assert.equal(env.element('#empty-title').textContent, '暂时无法继续');
  assert.equal(env.element('#empty-description').textContent, 'TEST credential removal failed');
  assert.equal(env.element('#empty-action').textContent, '打开远程桌面');
  env.run('configReady = false; setHint("TEST configuration load failed", true)');
  assert.equal(env.element('#empty-action').disabled, true);
  assert.equal(env.element('#empty-title').textContent, '暂时无法继续');
});

test('input status follows connect, explicit control, blur, read-only and disconnect', async () => {
  const env = environment(); seed(env); env.run('render()');
  const status = env.element('#input-status');
  assert.equal(status.textContent, '尚未连接');
  await connect(env);
  assert.equal(status.textContent, '尚未连接');
  const session = env.sessions.at(-1); await session.emit('connect');
  assert.equal(status.textContent, '点击画面接管');
  env.inputState.canControl = true; env.inputState.onChange();
  assert.equal(status.textContent, '正在控制');
  assert.equal(status.dataset.state, 'active');
  env.inputState.nativeFocusLost();
  assert.equal(status.textContent, '点击画面接管');
  assert.equal(status.dataset.state, 'idle');
  assert.equal(session.disconnectCount, 0);
  env.element('#view-only').checked = true;
  await env.element('#view-only').fire('change');
  assert.equal(status.textContent, '只读模式');
  assert.equal(env.keyboardState.canControl, false);
  env.element('#view-only').checked = false;
  await env.element('#view-only').fire('change');
  assert.equal(status.textContent, '点击画面接管');
  await env.element('#connect').fire('click');
  assert.equal(status.textContent, '尚未连接');
  assert.equal(status.dataset.state, 'idle');
});

test('connection error card exposes its reason and retry starts a new scoped connection', async () => {
  const env = environment(command => command === 'password_saved' ? true : undefined);
  seed(env); await env.element('#empty-action').fire('click');
  const first = env.sessions.at(-1);
  assert.equal(env.element('#connect').textContent, '取消连接');
  await first.emit('securityfailure', { reason: 'TEST authentication failed' });
  assert.equal(first.disconnectCount, 1);
  assert.equal(env.element('#workspace-empty').hidden, false);
  assert.equal(env.element('#workspace-empty').dataset.state, 'error');
  assert.equal(env.element('#stage-status').textContent, '连接失败');
  assert.equal(env.element('#stage-status').dataset.state, 'error');
  assert.equal(env.element('#empty-description').textContent, 'TEST authentication failed');
  assert.equal(env.element('#empty-action').textContent, '重新连接');
  assert.equal(env.element('#empty-action').hidden, false);
  await env.element('#empty-action').fire('click');
  const second = env.sessions.at(-1);
  assert.notEqual(second, first);
  assert.equal(env.element('#workspace-empty').dataset.state, 'connecting');
  assert.equal(env.element('#stage-hint').classList.contains('error'), false);
  const attempts = env.calls.filter(call => call.command === 'connect_pve');
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].args.request.sessionId, attempts[1].args.request.sessionId);
  await first.emit('disconnect');
  await second.emit('connect');
  assert.equal(env.element('#connect').textContent, '断开');
  assert.equal(second.disconnectCount, 0);
  assert.equal(env.element('#workspace-empty').hidden, true);
});
