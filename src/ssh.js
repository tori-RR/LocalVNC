import { invoke, Channel } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { normalizePveOrigin } from "./pve-endpoint.js";

const INPUT_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = 512 * 1024;
const WRITE_LIMIT = 64 * 1024;

export function inferSshProfile(server) {
  let host = "";
  if (server?.kind === "pve") {
    try { host = new URL(normalizePveOrigin(server.origin)).hostname.replace(/^\[|\]$/g, ""); } catch { /* No usable default. */ }
  } else if (server?.address) {
    const address = server.address.trim();
    if (address.startsWith("[")) host = address.match(/^\[([^\]]+)\](?::.*)?$/)?.[1] || "";
    else {
      try {
        new URL(`http://[${address}]/`);
        host = address;
      } catch { host = address.replace(/:{1,2}\d+$/, ""); }
    }
  }
  return { host: server?.ssh?.host || host, port: server?.ssh?.port || 22,
    username: server?.ssh?.username || "root" };
}

function safeMessage(error) {
  return typeof error?.safeMessage === "string" ? error.safeMessage : "SSH 终端连接失败，请检查目标地址及本机 OpenSSH。";
}

// Runtime injection keeps race and flow-control tests independent of WebView/PTY.
export function createSshPanel({ onProfileChange = () => {}, dependencies = {} } = {}) {
  const doc = dependencies.document || document;
  const win = dependencies.window || window;
  const call = dependencies.invoke || invoke;
  const ChannelType = dependencies.Channel || Channel;
  const TerminalType = dependencies.Terminal || Terminal;
  const FitType = dependencies.FitAddon || FitAddon;
  const Observer = dependencies.ResizeObserver || ResizeObserver;
  const newId = dependencies.newId || (() => crypto.randomUUID());
  const elements = Object.fromEntries(["form", "host", "port", "username", "connect", "connect-label", "disconnect", "terminal", "hint", "status", "target", "empty"]
    .map(name => [name, doc.querySelector(`#ssh-${name}`)]));
  let selectedServer = null;
  let operation = null;
  let terminal = null;
  let fitAddon = null;
  let disposed = false;
  let connectChain = Promise.resolve();
  let fitFrame = null;
  const encoder = new TextEncoder();

  function current(op) { return !disposed && operation === op && !op.cancelled; }
  function show(status, hint) {
    elements.status.textContent = status;
    elements.status.dataset.state = status === "终端就绪" ? "ready" : status === "正在启动" ? "connecting"
      : ["连接中断", "检查连接信息"].includes(status) ? "error" : "idle";
    elements.hint.textContent = hint;
  }
  function controls() {
    const busy = !!operation;
    for (const name of ["host", "port", "username", "connect"]) elements[name].disabled = busy || disposed;
    elements.disconnect.disabled = !busy || disposed;
    elements["connect-label"].textContent = busy ? operation.ready ? "终端运行中" : "正在启动" : "连接 SSH";
    // xterm also gates terminal protocol replies (e.g. ConPTY's startup DSR)
    // behind disableStdin. Queue them while IPC startup is still pending.
    if (terminal) terminal.options.disableStdin = !busy || disposed;
  }
  function fillProfile() {
    const profile = inferSshProfile(selectedServer);
    elements.host.value = profile.host;
    elements.port.value = String(profile.port);
    elements.username.value = profile.username;
  }
  function targetLabel(profile) {
    const host = profile.host.includes(":") ? `[${profile.host}]` : profile.host;
    return `${profile.username}@${host}:${profile.port}`;
  }
  function closeBackend(op) {
    return call("ssh_disconnect", { sessionId: op.id }).catch(() => {});
  }
  function finish(op, status, hint, close = false) {
    if (!current(op)) return;
    op.cancelled = true;
    op.queue.length = 0;
    operation = null;
    controls();
    show(status, hint);
    // Keep the submitted draft on failure; switch defaults only for a new target.
    if (selectedServer?.id !== op.serverId) fillProfile();
    if (close) void closeBackend(op);
  }
  function fail(op, hint) { finish(op, "连接中断", hint, true); }

  async function drainInput(op) {
    if (op.writing || !op.ready) return;
    op.writing = true;
    try {
      while (current(op) && op.queue.length) {
        const chunk = op.queue.shift();
        await call("ssh_write", { sessionId: op.id, data: Array.from(chunk) });
        op.inputBytes -= chunk.length;
      }
    } catch (error) {
      if (current(op)) fail(op, safeMessage(error));
    } finally { op.writing = false; }
  }
  function sendInput(data, binary = false) {
    const op = operation;
    if (!op || !current(op) || !data) return;
    if (data.length > INPUT_LIMIT) {
      fail(op, "待发送的终端输入过多，已断开 SSH。请缩小粘贴内容后重试。");
      return;
    }
    // onBinary strings are byte containers, not Unicode text. Both paths use
    // the same ordered byte queue, including startup replies and in-flight IPC.
    const bytes = binary ? new Uint8Array(data.length) : encoder.encode(data);
    if (binary) {
      for (let i = 0; i < data.length; i++) {
        const byte = data.charCodeAt(i);
        if (byte > 255) { fail(op, "SSH 终端收到无效的二进制输入，连接已关闭。"); return; }
        bytes[i] = byte;
      }
    }
    if (op.inputBytes + bytes.length > INPUT_LIMIT) {
      fail(op, "待发送的终端输入过多，已断开 SSH。请缩小粘贴内容后重试。");
      return;
    }
    // PTY input is a byte stream; Unicode can safely span adjacent writes.
    for (let i = 0; i < bytes.length; i += WRITE_LIMIT) op.queue.push(bytes.subarray(i, i + WRITE_LIMIT));
    op.inputBytes += bytes.length;
    void drainInput(op);
  }
  async function drainResize(op) {
    if (op.resizing || !op.ready) return;
    op.resizing = true;
    try {
      while (current(op) && op.size) {
        const size = op.size;
        op.size = null;
        await call("ssh_resize", { sessionId: op.id, ...size });
      }
    } catch (error) {
      if (current(op)) fail(op, safeMessage(error));
    } finally { op.resizing = false; }
  }
  function visible() {
    return elements.terminal.clientWidth > 0 && elements.terminal.clientHeight > 0
      && elements.terminal.getClientRects().length > 0;
  }
  function createTerminal() {
    terminal?.dispose();
    elements.terminal.replaceChildren();
    terminal = new TerminalType({
      cursorBlink: true, disableStdin: true, convertEol: false, scrollback: 2000,
      fontFamily: '"Cascadia Mono", "Consolas", monospace', fontSize: 13, lineHeight: 1.25,
      theme: { background: "#212121", foreground: "#ededed", cursor: "#f0f0f0",
        selectionBackground: "#454545", black: "#292929", brightBlack: "#999999" },
      linkHandler: { activate() {} },
    });
    fitAddon = new FitType();
    terminal.loadAddon(fitAddon);
    terminal.open(elements.terminal);
    terminal.parser.registerOscHandler(52, () => true);
    terminal.onData(sendInput);
    terminal.onBinary(data => sendInput(data, true));
    terminal.onResize(size => {
      if (!operation) return;
      operation.size = { cols: size.cols, rows: size.rows };
      void drainResize(operation);
    });
  }
  function fit() {
    if (disposed || !visible()) return;
    if (!terminal) createTerminal();
    fitAddon.fit();
  }
  function scheduleFit() {
    if (disposed || fitFrame !== null) return;
    fitFrame = win.requestAnimationFrame(() => { fitFrame = null; fit(); });
  }
  function receive(op, event) {
    if (!current(op) || event?.sessionId !== op.id) return;
    if (event.kind === "data") {
      if (!Array.isArray(event.data) || event.data.length > OUTPUT_LIMIT
          || event.data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        fail(op, "SSH 终端收到无效数据，连接已关闭。");
        return;
      }
      const bytes = event.data.length;
      if (op.outputBytes + bytes > OUTPUT_LIMIT) {
        fail(op, "终端输出超过处理上限，已断开 SSH。请减少持续输出后重试。");
        return;
      }
      op.outputBytes += bytes;
      op.terminal.write(new Uint8Array(event.data), () => {
        op.outputBytes -= bytes;
        if (current(op) && bytes) {
          void call("ssh_ack", { sessionId: op.id, bytes }).catch(error => {
            if (current(op)) fail(op, safeMessage(error));
          });
        }
      });
    } else if (event.kind === "exit") {
      finish(op, "已退出", event.message || "SSH 会话已结束，可以重新连接。");
    } else if (event.kind === "error") {
      fail(op, event.message || "SSH 会话发生错误，请重新连接。");
    }
  }
  async function connect(event) {
    event?.preventDefault();
    if (disposed || operation) return;
    if (!win.__TAURI_INTERNALS__) {
      show("浏览器预览", "请在 LocalVNC 桌面窗口中使用 SSH 终端。");
      return;
    }
    const profile = { host: elements.host.value.trim().replace(/^\[|\]$/g, ""),
      port: Number(elements.port.value), username: elements.username.value.trim() };
    if (!profile.host || /[\s\x00-\x1f\x7f/@\\]/.test(profile.host) || profile.host.startsWith("-")
        || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535
        || !/^[A-Za-z0-9_.\\@-]{1,128}$/.test(profile.username) || profile.username.startsWith("-")) {
      show("检查连接信息", "请输入有效的 SSH 主机、端口（1–65535）和用户名。");
      return;
    }
    if (!visible()) { show("等待终端显示", "展开 SSH 侧栏后再连接。"); return; }
    elements.empty.hidden = true;
    createTerminal();
    fitAddon.fit();
    const op = { id: newId(), profile, serverId: selectedServer?.id, terminal,
      cancelled: false, ready: false, queue: [], inputBytes: 0, outputBytes: 0, size: null };
    operation = op;
    elements.target.textContent = targetLabel(profile);
    controls();
    show("正在启动", "主机指纹确认与密码输入将在终端内进行。");
    const channel = new ChannelType();
    channel.onmessage = value => receive(op, value);
    const start = async () => {
      if (!current(op)) return;
      try {
        await call("ssh_connect", { request: { sessionId: op.id, ...profile,
          cols: op.terminal.cols, rows: op.terminal.rows }, onEvent: channel });
        if (!current(op)) { await closeBackend(op); return; }
        op.ready = true;
        controls();
        void drainInput(op);
        show("终端就绪", "首次连接请核对主机指纹；密码输入时不会显示字符。");
        op.terminal.focus();
        void drainResize(op);
        if (op.serverId) {
          try { await onProfileChange(op.serverId, { ...profile }); }
          catch { if (current(op)) elements.hint.textContent = "终端已启动，但 SSH 地址未能保存。"; }
        }
      } catch (error) {
        if (current(op)) fail(op, safeMessage(error));
        else await closeBackend(op);
      }
    };
    connectChain = connectChain.then(start, start);
    await connectChain;
  }
  function disconnect() {
    if (operation) finish(operation, "已断开", "SSH 已断开，VNC 会话保持不变。", true);
  }
  const observer = new Observer(scheduleFit);
  observer.observe(elements.terminal);
  elements.form.addEventListener("submit", connect);
  elements.disconnect.addEventListener("click", disconnect);
  fillProfile();
  controls();
  show("未连接", "");
  scheduleFit();

  return {
    setServer(server) {
      const previous = JSON.stringify([selectedServer?.id, inferSshProfile(selectedServer)]);
      selectedServer = server ? structuredClone(server) : null;
      const next = JSON.stringify([selectedServer?.id, inferSshProfile(selectedServer)]);
      if (!operation && previous !== next) fillProfile();
    },
    fit: scheduleFit,
    dispose() {
      if (disposed) return;
      const op = operation;
      disposed = true;
      if (op) { op.cancelled = true; op.queue.length = 0; void closeBackend(op); }
      operation = null;
      observer.disconnect();
      if (fitFrame !== null) win.cancelAnimationFrame(fitFrame);
      elements.form.removeEventListener("submit", connect);
      elements.disconnect.removeEventListener("click", disconnect);
      terminal?.dispose();
      controls();
    },
  };
}
