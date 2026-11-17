// Isolated browser fixture: actual noVNC/input guard, synthetic loopback RFB only.
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { workspaceFramebuffer, workspaceInit } = require('./fixtures/workspace-frame.cjs');
const root = path.resolve(__dirname, '..');
const log = { connections: 0, events: [] };
const sockets = new Set();

function send(socket, bytes, opcode = 2) {
  const header = Buffer.alloc(bytes.length < 126 ? 2 : bytes.length < 65536 ? 4 : 10);
  header[0] = 0x80 | opcode;
  if (header.length === 2) header[1] = bytes.length;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(bytes.length, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(bytes.length), 2); }
  if (!socket.destroyed) socket.write(Buffer.concat([header, bytes]));
}
function init() {
  const name = Buffer.from('LocalVNC isolated focus fixture');
  const bytes = Buffer.alloc(24 + name.length);
  bytes.writeUInt16BE(320, 0); bytes.writeUInt16BE(200, 2);
  bytes[4] = 32; bytes[5] = 24; bytes[7] = 1;
  for (const offset of [8, 10, 12]) bytes.writeUInt16BE(255, offset);
  bytes[14] = 16; bytes[15] = 8;
  bytes.writeUInt32BE(name.length, 20); name.copy(bytes, 24);
  return bytes;
}
function framebuffer() {
  const bytes = Buffer.alloc(16 + 320 * 200 * 4);
  bytes.writeUInt16BE(1, 2); bytes.writeUInt16BE(320, 8); bytes.writeUInt16BE(200, 10);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
    const at = 16 + (y * 320 + x) * 4;
    bytes[at] = 110 + Math.floor(x / 5); bytes[at + 1] = 55 + Math.floor(y / 3); bytes[at + 2] = 38;
  }
  return bytes;
}
let resizedWorkspace;
function resizedWorkspaceFrame() {
  if (resizedWorkspace) return resizedWorkspace;
  const width = 1440, height = 900, source = workspaceFramebuffer();
  const frame = Buffer.alloc(16 + width * height * 4);
  frame.writeUInt16BE(1, 2); frame.writeUInt16BE(width, 8); frame.writeUInt16BE(height, 10);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const from = 16 + (Math.floor(y * 640 / height) * 1024 + Math.floor(x * 1024 / width)) * 4;
    source.copy(frame, 16 + (y * width + x) * 4, from, from + 4);
  }
  const size = Buffer.alloc(16);
  size.writeUInt16BE(1, 2); size.writeUInt16BE(width, 8); size.writeUInt16BE(height, 10);
  size.writeInt32BE(-223, 12); // Standard server-initiated DesktopSize pseudo-encoding.
  resizedWorkspace = Buffer.concat([size, frame]);
  return resizedWorkspace;
}
function remember(event) {
  log.events.push({ ...event, index: log.events.length });
  if (log.events.length > 2000) log.events.shift();
}
async function main() {
  const { createServer } = await import('vite');
  const fixture = {
    name: 'isolated-vnc-fixture',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] === '/tests/fixtures/workspace.html') {
          try {
            // Always render the current production markup and entry point. No
            // copied UI, real configuration, credentials or desktop IPC exists.
            const source = await fs.readFile(path.join(root, 'src/index.html'), 'utf8');
            const html = source.replace('href="./styles.css"', 'href="/src/styles.css"')
              .replace('src="./assets/macintosh.svg"', 'src="/src/assets/macintosh.svg"')
              .replace('src="./main.js"', 'src="/src/main.js"')
              .replace('<title>LocalVNC</title>', '<title>LocalVNC · Isolated fixture</title>');
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; frame-src 'none'; base-uri 'self'");
            response.end(await server.transformIndexHtml(request.url, html));
          } catch (error) { next(error); }
          return;
        }
        if (request.url === '/__fixture/events') {
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(JSON.stringify(log));
        } else if (request.url === '/__fixture/clear' && request.method === 'POST') {
          log.events = []; response.end('cleared');
        } else next();
      });
    },
  };
  const vite = await createServer({ configFile: path.join(root, 'vite.config.js'), root,
    // Restrict pre-bundling discovery as well as file watching: the fixture root
    // includes Rust build output, whose historical HTML must never be scanned.
    optimizeDeps: { entries: ['src/index.html', 'tests/fixtures/*.html'] },
    resolve: { alias: Object.fromEntries(['core', 'event', 'window'].map(name =>
      [`@tauri-apps/api/${name}`, path.join(root, 'tests/fixtures/tauri-workspace.js')])) },
    plugins: [fixture], server: { host: '127.0.0.1', port: Number(process.env.VNC_FIXTURE_PORT || 0), strictPort: !!process.env.VNC_FIXTURE_PORT, open: false,
      // Rust linking replaces locked EXEs on Windows. Test-page watching must
      // never descend into build output or reload while a release is built.
      watch: { ignored: ['**/src-tauri/**', '**/dist/**', '**/artifacts/**', '**/.code-review/**', '**/private/**', '**/build/**'] } } });
  vite.httpServer.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url, 'http://127.0.0.1');
    if (requestUrl.pathname !== '/__fixture/rfb') return;
    const workspace = requestUrl.searchParams.get('scene') === 'workspace';
    const stall = requestUrl.searchParams.get('stall');
    const auth = requestUrl.searchParams.get('auth');
    const handoffs = Math.min(2, Math.max(0, Number(requestUrl.searchParams.get('handoff')) || 0));
    const attempt = Number(requestUrl.searchParams.get('attempt')) || 0;
    const resize = requestUrl.searchParams.get('resize') === '1';
    const accountAuth = ['ard', 'ard-failure', 'ard-limited'].includes(auth);
    const passwordAuth = ['challenge-before', 'challenge-after'].includes(stall) || ['vnc', 'failure', 'limited'].includes(auth);
    const authentication = accountAuth || passwordAuth;
    const ard = accountAuth ? crypto.getDiffieHellman('modp2') : null;
    if (ard) ard.generateKeys();
    const key = request.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    sockets.add(socket); log.connections++;
    const connection = log.connections;
    let wire = head, rfb = Buffer.alloc(0), stage = 0, drew = false, handoffTimer, resizeTimer;
    const phase = name => remember({ kind: 'phase', phase: name, connection });
    function consume(bytes) {
      rfb = Buffer.concat([rfb, bytes]);
      for (;;) {
        const length = stage === 0 ? 12 : stage === 2 && accountAuth ? 128 + ard.getPrime().length
          : stage === 2 && passwordAuth ? 16 : stage < (authentication ? 4 : 3) ? 1 : rfb.length ?
          ({ 0: 20, 2: rfb.length >= 4 ? 4 + rfb.readUInt16BE(2) * 4 : 4,
            3: 10, 4: 8, 5: 6, 6: rfb.length >= 8 ? 8 + rfb.readUInt32BE(4) : 8 })[rfb[0]] : 1;
        if (length === undefined || length > 1024 * 1024) { socket.destroy(); return; }
        if (rfb.length < length) return;
        const packet = rfb.subarray(0, length); rfb = rfb.subarray(length);
        if (stage === 0) {
          stage++; phase('banner');
          if (auth === 'unsupported') {
            const reason = Buffer.from('No compatible security types (isolated fixture)');
            const packet = Buffer.alloc(5 + reason.length); packet.writeUInt32BE(reason.length, 1); reason.copy(packet, 5);
            send(socket, packet);
          } else if (stall !== 'banner') send(socket, Buffer.from(accountAuth ? [5, 30, 33, 36, 2, 35] : [1, passwordAuth ? 2 : 1]));
        } else if (stage === 1) {
          if (packet[0] !== (accountAuth ? 30 : passwordAuth ? 2 : 1)) { socket.destroy(); return; }
          stage++; phase('security-selected');
          if (accountAuth) {
            const header = Buffer.alloc(4); header.writeUInt16BE(2, 0); header.writeUInt16BE(ard.getPrime().length, 2);
            send(socket, Buffer.concat([header, ard.getPrime(), ard.getPublicKey()]));
          } else if (passwordAuth) { if (stall !== 'challenge-before') send(socket, Buffer.alloc(16, 7)); }
          else send(socket, Buffer.alloc(4));
        } else if (stage === 2 && accountAuth) {
          stage++; phase('auth-response');
          let valid = false;
          try {
            const key = crypto.createHash('md5').update(ard.computeSecret(packet.subarray(128))).digest();
            const decipher = crypto.createDecipheriv('aes-128-ecb', key, null); decipher.setAutoPadding(false);
            const credentials = Buffer.concat([decipher.update(packet.subarray(0, 128)), decipher.final()]);
            const field = start => credentials.subarray(start, start + 64).toString('utf8').split('\0')[0];
            valid = field(0) === 'mac-demo' && field(64) === 'TEST_ONLY_MAC_PASSWORD';
          } catch { /* Reject invalid synthetic credentials without logging them. */ }
          remember({ kind: 'ard-auth', credentialsValid: valid, connection });
          const status = auth === 'ard-limited' ? 2 : auth === 'ard-failure' || !valid ? 1 : 0;
          if (status) {
            const reason = Buffer.from('Synthetic Mac account authentication result');
            const result = Buffer.alloc(8 + reason.length); result.writeUInt32BE(status, 0);
            result.writeUInt32BE(reason.length, 4); reason.copy(result, 8); send(socket, result);
          } else send(socket, Buffer.alloc(4));
        } else if (stage === 2 && passwordAuth) {
          stage++; phase('auth-response');
          if (['failure', 'limited'].includes(auth)) {
            const reason = Buffer.from('Synthetic authentication result (isolated fixture)');
            const packet = Buffer.alloc(8 + reason.length);
            packet.writeUInt32BE(auth === 'failure' ? 1 : 2, 0); packet.writeUInt32BE(reason.length, 4); reason.copy(packet, 8);
            send(socket, packet);
          } else if (stall !== 'challenge-after') send(socket, Buffer.alloc(4));
        } else if (stage === 2 || stage === 3 && authentication) {
          stage = 4; phase('client-init');
          if (stall !== 'server-init') send(socket, workspace ? workspaceInit() : init());
        }
        else if (packet[0] === 3 && !drew) {
          drew = true; send(socket, workspace ? workspaceFramebuffer() : framebuffer());
          if (handoffs && attempt <= handoffs) handoffTimer = setTimeout(() => {
            phase('synthetic-worker-restart'); send(socket, Buffer.alloc(0), 8); socket.end();
          }, 2000);
          else if (workspace && resize) resizeTimer = setTimeout(() => {
            phase('synthetic-desktop-resize'); send(socket, resizedWorkspaceFrame());
          }, 2000);
        }
        else if (packet[0] === 4) remember({ kind: 'key', connection, down: !!packet[1], keysym: packet.readUInt32BE(4) });
        else if (packet[0] === 5) remember({ kind: 'pointer', connection, mask: packet[1], x: packet.readUInt16BE(2), y: packet.readUInt16BE(4) });
      }
    }
    socket.on('data', bytes => {
      wire = Buffer.concat([wire, bytes]);
      while (wire.length >= 2) {
        const opcode = wire[0] & 15, masked = !!(wire[1] & 128);
        let length = wire[1] & 127, offset = 2;
        if (length === 126) { if (wire.length < 4) return; length = wire.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (wire.length < 10) return; length = Number(wire.readBigUInt64BE(2)); offset = 10; }
        if (!masked || length > 1024 * 1024) { socket.destroy(); return; }
        if (wire.length < offset + 4 + length) return;
        const mask = wire.subarray(offset, offset + 4), payload = Buffer.from(wire.subarray(offset + 4, offset + 4 + length));
        wire = wire.subarray(offset + 4 + length);
        for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
        if (opcode === 8) { socket.end(); return; }
        if (opcode === 9) send(socket, payload, 10);
        else if (opcode === 2 || opcode === 0) consume(payload);
      }
    });
    socket.on('error', () => {}); socket.on('close', () => { clearTimeout(handoffTimer); clearTimeout(resizeTimer); sockets.delete(socket); phase('closed'); });
    send(socket, Buffer.from(accountAuth ? 'RFB 003.889\n' : 'RFB 003.008\n'));
  });
  await vite.listen();
  console.log(`FIXTURE_URL=http://127.0.0.1:${vite.httpServer.address().port}/tests/fixtures/vnc-focus.html`);
  console.log(`WORKSPACE_URL=http://127.0.0.1:${vite.httpServer.address().port}/tests/fixtures/workspace.html`);
  console.log(`FIXTURE_PID=${process.pid}`);
  async function close() { for (const socket of sockets) socket.destroy(); await vite.close(); process.exit(0); }
  process.once('SIGINT', close); process.once('SIGTERM', close);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
