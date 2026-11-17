// Browser fixture only. Aliased by tests/vnc-browser-fixture.cjs, never imported
// by production source/build. All configuration is ephemeral and every VNC URL
// points back to this fixture origin. SSH never launches or contacts any host.
window.__TAURI_INTERNALS__ = Object.freeze({ isolatedFixture: true });
const scenario = new URLSearchParams(location.search);
const servers = [
  { id: 'aaa1', name: 'Ubuntu Studio', kind: 'pve', origin: 'https://lab.invalid:8006', node: 'atlas', vmid: 101, username: 'root@pam' },
  { id: 'aaa2', name: 'Development', kind: 'pve', origin: 'https://lab.invalid:8006', node: 'atlas', vmid: 102, username: 'root@pam' },
  { id: 'aaa3', name: 'Archive', kind: 'pve', origin: 'https://lab.invalid:8006', node: 'atlas', vmid: 103, username: 'root@pam' },
  { id: 'bbb1', name: 'Design Workstation', kind: 'direct', address: 'studio.invalid:5900', securityPolicy: 'preferTls' },
  { id: 'bbb2', name: 'Build Machine', kind: 'direct', address: 'build.invalid:5900', securityPolicy: 'preferTls' },
  { id: 'bbb3', name: 'Test Desktop', kind: 'direct', address: 'test.invalid:5900', securityPolicy: 'plain' },
];
if (scenario.get('mac') === '1') Object.assign(servers[3], { name: 'Mac Studio', username: 'mac-demo' });
if (scenario.get('dense') === '1') {
  const longHost = 'asia-pacific-research-and-development.virtualization-long-term-integration-cluster.lab.invalid';
  Object.assign(servers[0], {
    name: '亚太研发中心 · Ubuntu Studio — Long-running Integration & Virtualization Workstation',
    origin: `https://${longHost}:8006`,
    node: 'atlas-asia-pacific-research-and-development-integration-cluster-01',
  });
  Object.assign(servers[3], {
    name: '图形设计与远程协作工作站 · Design Workstation — Extended Display & Rendering Environment',
    address: `${longHost}::5900`,
  });
  for (let index = 4; index <= 18; index++) {
    const suffix = index.toString(16);
    const label = String(index).padStart(2, '0');
    servers.push(
      { id: `aaa${suffix}`, name: `实验环境 ${label} · Ubuntu Node`, kind: 'pve',
        origin: 'https://lab.invalid:8006', node: `atlas-${label}`, vmid: 100 + index, username: 'root@pam' },
      { id: `bbb${suffix}`, name: `工作站 ${label} · Remote Desktop`, kind: 'direct',
        address: `workstation-${label}.lab.invalid::5900`, securityPolicy: 'preferTls' },
    );
  }
}
const direct = scenario.get('mode') === 'direct';
let config = { schemaVersion: 1, servers: scenario.has('empty') ? [] : servers,
  selectedId: scenario.has('empty') ? '' : direct ? 'bbb1' : 'aaa1',
  settings: { scaleToWindow: true, viewOnly: false, shared: true },
  layout: { mode: direct ? 'direct' : 'pve', leftVisible: true, rightVisible: true } };
let sessionNumber = 0;
const sessions = new Set();
const listeners = new Map();
const noOp = async () => {};
const safeError = message => Object.assign(new Error(message), { safeMessage: message });
let saveRejected = false;
export class Channel { onmessage = noOp; }
export async function listen(name, callback) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(callback);
  return () => listeners.get(name)?.delete(callback);
}
export async function invoke(command, args = {}) {
  switch (command) {
    case 'load_config': return structuredClone(config);
    case 'save_config':
      if (scenario.get('save') === 'reject' || scenario.get('save') === 'once' && !saveRejected) {
        saveRejected = true;
        throw safeError('模拟保存冲突：配置未保存，草稿仍保留。（本机模拟）');
      }
      config = structuredClone(args.config); return Object.fromEntries(config.servers.map(server => [server.id, 'SYNTHETIC_GENERATION']));
    case 'password_saved': return !scenario.has('password');
    case 'load_password': return '';
    case 'credential_generation': return 'SYNTHETIC_GENERATION';
    case 'save_password': case 'forget_password': return;
    case 'begin_session': { const id = `fixture-${++sessionNumber}`; sessions.add(id); return id; }
    case 'disconnect': sessions.delete(args.sessionId); return;
    case 'connect_direct': case 'connect_pve': {
      const id = args.request?.sessionId;
      if (!sessions.has(id)) throw safeError('模拟连接已取消。');
      if (scenario.has('bridgeUrl')) {
        const bridge = new URL(scenario.get('bridgeUrl'));
        if (bridge.protocol !== 'ws:' || bridge.hostname !== '127.0.0.1') throw safeError('Only loopback test bridges are allowed');
        return { url: bridge.href, password: '' };
      }
      if (scenario.get('state') === 'error') throw safeError('无法连接到服务器，请检查地址或稍后重试。（本机模拟）');
      if (scenario.get('state') === 'connecting') return new Promise(() => {});
      await new Promise(resolve => setTimeout(resolve, 650));
      if (!sessions.has(id)) throw safeError('模拟连接已取消。');
      const url = new URL('/__fixture/rfb?scene=workspace', location.href);
      if (scenario.has('stall')) url.searchParams.set('stall', scenario.get('stall'));
      if (scenario.has('auth')) url.searchParams.set('auth', scenario.get('auth'));
      if (scenario.has('resize')) url.searchParams.set('resize', scenario.get('resize'));
      if (scenario.has('handoff')) {
        url.searchParams.set('handoff', scenario.get('handoff'));
        url.searchParams.set('attempt', id.split('-').at(-1));
      }
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return { url: url.href, password: '' };
    }
    case 'ssh_connect': throw safeError('隔离预览：SSH 不会连接任何主机。');
    case 'ssh_disconnect': case 'ssh_resize': case 'ssh_ack': case 'ssh_write': return;
    default: throw safeError(`隔离预览未实现 ${command}`);
  }
}
let maximized = false;
const resizeListeners = new Set();
export function getCurrentWindow() {
  return {
    isMaximized: async () => maximized,
    toggleMaximize: async () => { maximized = !maximized; for (const fn of resizeListeners) fn(); },
    minimize: noOp, close: noOp, startDragging: noOp,
    onResized: async fn => { resizeListeners.add(fn); return () => resizeListeners.delete(fn); },
    onFocusChanged: async fn => {
      const blur = () => fn({ payload: false });
      const focus = () => fn({ payload: true });
      window.addEventListener('blur', blur); window.addEventListener('focus', focus);
      return () => { window.removeEventListener('blur', blur); window.removeEventListener('focus', focus); };
    },
  };
}
