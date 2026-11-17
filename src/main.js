import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import RFB from "@novnc/novnc/lib/rfb.js";
import { createSshPanel } from "./ssh.js";
import { normalizePveOrigin } from "./pve-endpoint.js";
import { createVncInputGuard } from "./vnc-input.js";
import { setupWindowControls } from "./window-controls.js";
import { createVirtualKeyboard } from "./virtual-keyboard.js";

const serversEl = document.querySelector("#servers");
const serverForm = document.querySelector("#server-form");
const kindInput = document.querySelector("#server-kind");
const stageTitle = document.querySelector("#stage-title");
const stageStatus = document.querySelector("#stage-status");
const stageHint = document.querySelector("#stage-hint");
const serverSearch = document.querySelector("#server-search");
const clearServerSearch = document.querySelector("#clear-server-search");
const emptyState = document.querySelector("#workspace-empty");
const emptyAction = document.querySelector("#empty-action");
const screen = document.querySelector("#screen");
const connectButton = document.querySelector("#connect");
const keyboardButton = document.querySelector("#toggle-keyboard");
const keyboardContainer = document.querySelector("#virtual-keyboard");
const settings = document.querySelector("#settings");
const passwordDialog = document.querySelector("#password-dialog");
const passwordForm = document.querySelector("#password-form");
const passwordInput = document.querySelector("#password");
const passwordUsernameField = document.querySelector("#password-username-field");
const passwordUsernameInput = document.querySelector("#password-username");
const passwordTitle = document.querySelector("#password-title");
const passwordNote = document.querySelector("#password-note");
const rememberInput = document.querySelector("#remember-password");
const forgetPasswordButton = document.querySelector("#forget-password");
const scaleInput = document.querySelector("#scale");
const viewOnlyInput = document.querySelector("#view-only");
const sharedInput = document.querySelector("#shared");
const insecureInput = document.querySelector("#insecure");
const serverDialog = document.querySelector("#server-dialog");
const formError = document.querySelector("#server-form-error");
const confirmDialog = document.querySelector("#confirm-dialog");
const app = document.querySelector("#app");

const serversKey = "localvnc.servers";
const settingsKey = "localvnc.settings";
const selectedKey = "localvnc.selected";
const layoutKey = "localvnc.layout";

const defaultSettings = {
  scaleToWindow: true,
  viewOnly: false,
  shared: true,
};

let servers = [];
let selectedId = "";
let preferences = { ...defaultSettings };
let persistChain = Promise.resolve();
let rfb = null;
let connecting = false;
let configReady = false;
let activeOperation = null;
let passwordOperation = null;
let beginChain = Promise.resolve();
let layout = { mode: "pve", leftVisible: true, rightVisible: true };
let inputGuard = null;
let virtualKeyboard = null;
let serverMutationPending = false;
const rejectedPasswords = new Set();
let connectionError = null;
let passwordRefresh = 0;
const CONNECTION_TIMEOUT_MS = 60000;
const RECOVERY_TIMEOUT_MS = 60000;
const RECOVERY_STABLE_MS = 10000;
const RECOVERY_DELAYS = [1000, 2000, 3000, 5000, 8000];
let recovery = null;
function updateInputControls() {
  const connected = !!rfb && !connecting;
  const inputStatus = document.querySelector("#input-status");
  inputStatus.textContent = !connected ? "尚未连接" : preferences.viewOnly ? "只读模式" : inputGuard?.canControl ? "正在控制" : "点击画面接管";
  inputStatus.dataset.state = connected && inputGuard?.canControl ? "active" : "idle";
  virtualKeyboard?.setState({
    connected: !!rfb && !connecting,
    canControl: !!inputGuard?.canControl,
    readOnly: preferences.viewOnly,
  });
}
inputGuard = createVncInputGuard({ screen, allowControlTargets: [keyboardButton, keyboardContainer], onChange: updateInputControls });
virtualKeyboard = createVirtualKeyboard({
  container: keyboardContainer,
  beforeSend: () => inputGuard.prepareVirtualInput(),
  sendKey(keysym, code, down) {
    if (rfb && !connecting && !preferences.viewOnly && inputGuard.canControl) rfb.sendKey(keysym, code, down);
  },
  onVisibilityChange(visible) {
    keyboardButton.setAttribute("aria-expanded", String(visible));
    keyboardButton.setAttribute("aria-label", visible ? "收起虚拟键盘" : "展开虚拟键盘");
    keyboardButton.title = visible ? "收起虚拟键盘" : "展开虚拟键盘";
    if (!visible && inputGuard.canControl) rfb?.focus({ preventScroll: true });
  },
});
for (const target of [keyboardButton, keyboardContainer]) {
  for (const event of ["pointerdown", "focusin"]) {
    target.addEventListener(event, () => inputGuard.prepareVirtualInput());
  }
}
const windowControls = setupWindowControls({ onFocusLost: () => inputGuard.suspend() });
const sshPanel = createSshPanel({
  onProfileChange(serverId, profile) {
    if (!configReady) return;
    const ssh = normalizeSshProfile(profile);
    return mutateServers(config => {
      if (!config.servers.some(server => server.id === serverId)) return null;
      config.servers = config.servers.map(server => server.id === serverId ? { ...server, ssh } : server);
      return { config };
    });
  },
});

function normalizeSshProfile(profile) {
  if (!profile || typeof profile.host !== "string" || !profile.host.trim()
      || typeof profile.username !== "string" || !profile.username.trim()
      || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) {
    throw new Error("SSH 配置不完整，已停止自动保存。");
  }
  return { host: profile.host.trim(), port: profile.port, username: profile.username.trim() };
}

function loadServers() {
  return JSON.parse(localStorage.getItem(serversKey) || "[]");
}

function normalizeServer(item) {
  if (!item || typeof item.id !== "string" || !/^[a-f\d-]{1,64}$/i.test(item.id)
      || typeof item.name !== "string" || !item.name.trim()) throw new Error("配置中的服务器条目损坏，已停止自动保存。");
  const base = { id: item.id, name: item.name };
  if (item.ssh != null) base.ssh = normalizeSshProfile(item.ssh);
  if (item.kind === "pve") {
    if (typeof item.origin !== "string" || !item.origin.trim() || typeof item.node !== "string"
        || !item.node.trim() || !Number.isInteger(item.vmid) || item.vmid <= 0) {
      throw new Error("PVE 配置不完整，已停止自动保存。");
    }
    return { ...base, kind: "pve", origin: item.origin, node: item.node, vmid: item.vmid,
      username: item.username || "root@pam", insecure: item.insecure === true };
  }
  if (item.kind !== "direct" && item.kind != null) throw new Error("配置包含未知服务器类型，已停止自动保存。");
  const address = directAddress(item);
  if (!address || typeof address !== "string") throw new Error("VNC 配置缺少地址，已停止自动保存。");
  const securityPolicy = item.securityPolicy || "preferTls";
  if (!["preferTls", "requireTls", "plain"].includes(securityPolicy)) throw new Error("VNC 安全策略无法识别。");
  if (item.username != null && typeof item.username !== "string") throw new Error("VNC 用户名格式不正确。");
  if (item.username?.trim()) validateAccountCredential(item.username.trim(), "用户名");
  return { ...base, kind: "direct", address, securityPolicy, username: item.username?.trim() || "" };
}

function loadSettings() {
  try {
    return { ...defaultSettings, ...JSON.parse(localStorage.getItem(settingsKey) || "{}") };
  } catch {
    return { ...defaultSettings };
  }
}

function snapshot() {
  return {
    schemaVersion: 1,
    servers,
    settings: preferences,
    selectedId: selectedId || "",
    layout,
  };
}

function applyStored(config) {
  configReady = false;
  if (!config || !Array.isArray(config.servers) || (config.schemaVersion != null && config.schemaVersion !== 1)) {
    throw new Error("配置版本或格式无法识别，已停止自动保存。");
  }
  const normalized = config.servers.map(normalizeServer);
  if (new Set(normalized.map(server => server.id)).size !== normalized.length) throw new Error("配置中有重复的服务器标识。");
  servers = normalized;
  preferences = Object.fromEntries(Object.entries(defaultSettings).map(([key, fallback]) =>
    [key, typeof config.settings?.[key] === "boolean" ? config.settings[key] : fallback]));
  selectedId = servers.some((server) => server.id === config?.selectedId) ? config.selectedId : "";
  layout = {
    mode: ["pve", "direct"].includes(config.layout?.mode) ? config.layout.mode : selectedServer()?.kind || "pve",
    leftVisible: config.layout?.leftVisible !== false,
    rightVisible: config.layout?.rightVisible !== false,
  };
  configReady = true;
}

async function saveSnapshot(config) {
  if (!window.__TAURI_INTERNALS__) {
    localStorage.setItem(serversKey, JSON.stringify(config.servers));
    localStorage.setItem(settingsKey, JSON.stringify(config.settings));
    localStorage.setItem(layoutKey, JSON.stringify(config.layout));
    if (config.selectedId) localStorage.setItem(selectedKey, config.selectedId);
    else localStorage.removeItem(selectedKey);
    return;
  }
  return invoke("save_config", { config });
}

function enqueueSave(work) {
  const save = persistChain.then(work);
  persistChain = save.catch(() => {});
  return save;
}

function persist(reportError = true) {
  if (!configReady) {
    setHint("配置加载失败，已阻止保存。请先检查文档目录中的 localVNC/config.json 和备份。", true);
    return;
  }
  // Snapshot when this job runs: a pending model commit must not be overwritten
  // by an older list captured during a selection/settings change.
  const save = enqueueSave(() => saveSnapshot(structuredClone(snapshot())));
  return reportError ? save.catch(error => setHint(errorMessage(error), true)) : save;
}

function mutateServers(build) {
  return enqueueSave(async () => {
    const base = structuredClone(snapshot());
    const plan = build(structuredClone(base));
    if (!plan) return null;
    const generations = await saveSnapshot(plan.config);
    plan.credentialGeneration = generations?.[plan.newId];
    // Publish only after durable storage. Preserve newer UI choices while IPC
    // was pending; subsequent queued UI saves capture the committed list.
    servers = plan.config.servers;
    if (selectedId === base.selectedId) selectedId = plan.config.selectedId;
    else if (selectedId === plan.oldId) selectedId = plan.newId || "";
    if (selectedId && !servers.some(server => server.id === selectedId)) selectedId = "";
    if (layout.mode === base.layout.mode && selectedId === plan.config.selectedId) layout.mode = plan.config.layout.mode;
    if (plan.authenticatedOperation && activeOperation === plan.authenticatedOperation && selectedId === plan.newId) {
      activeOperation.server = structuredClone(servers.find(server => server.id === plan.newId));
    }
    if (activeOperation && (activeOperation.server.id === plan.closeId || activeOperation.server.id !== selectedId)) closeSession();
    else if (activeOperation) activeOperation.server = structuredClone(servers.find(server => server.id === selectedId));
    return plan;
  });
}

function errorMessage(error) {
  return error?.safeMessage || String(error).replace(/^Error:\s*/, "");
}

async function cleanOldCredential(id) {
  if (!id || !window.__TAURI_INTERNALS__) return;
  try {
    await invoke("forget_password", { serverId: id });
    rejectedPasswords.delete(id);
  } catch {
    setHint("配置已保存，但旧密码未能清理；可在 Windows 凭据管理器中删除对应的 LocalVNC 条目。", true);
  }
}

function selectedServer() {
  return servers.find((server) => server.id === selectedId) || null;
}

function directAddress(item) {
  if (item?.address) return item.address;
  if (!item?.host) return "";
  const port = Number(item.port);
  return Number.isInteger(port) && port > 0 ? `${item.host}::${port}` : item.host;
}

function subtitle(server) {
  if (server.kind === "pve") return `${server.node || "节点"} / ${server.vmid || ""}`;
  return server.address || directAddress(server);
}

function setHint(text, isError = false, errorKind = "general") {
  stageHint.textContent = text || "";
  stageHint.dataset.errorKind = errorKind;
  stageHint.classList.toggle("error", Boolean(text && isError));
  updateWorkspaceState();
}

function updateWorkspaceState() {
  const current = selectedServer();
  const live = !!rfb && !connecting;
  const error = stageHint.classList.contains("error");
  const isConnectionError = error && stageHint.dataset.errorKind === "connection";
  emptyState.hidden = live;
  stageHint.hidden = !(live && error && stageHint.textContent);
  const restoring = !!recovery && !live;
  emptyState.dataset.state = connecting || restoring ? "connecting" : error ? "error" : "idle";
  if (isConnectionError && !live && !connecting && !restoring) {
    stageStatus.textContent = "连接失败";
    stageStatus.dataset.state = "error";
  }
  document.querySelector("#empty-eyebrow").textContent = restoring ? "正在恢复连接" : connecting ? "正在建立会话" : current ? current.kind === "pve" ? "PVE 控制台" : "VNC 直连" : "你的远程工作台";
  document.querySelector("#empty-title").textContent = restoring ? connecting ? "正在重新连接" : "等待 VNC 服务恢复" : connecting ? "即将进入远程桌面" : error ? isConnectionError ? "连接未完成" : "暂时无法继续" : current ? "随时可以连接" : "从一台服务器开始";
  document.querySelector("#empty-description").textContent = restoring ? connecting ? `第 ${recovery.attempts} 次重连。恢复后，点击画面接管键鼠。` : `连接已中断，将在 ${recovery.delay / 1000} 秒后重试。\n可在上方取消重连。` : error ? stageHint.textContent : connecting ? "正在连接，请稍候。" : current ? "连接后，点击画面接管键鼠。" : "添加 PVE 或 VNC 服务器，\n在同一个窗口中使用远程桌面与 SSH。";
  emptyAction.textContent = !current ? "添加服务器" : !isConnectionError ? "打开远程桌面"
    : rejectedPasswords.has(current.id) ? "重新输入密码" : "重新连接";
  emptyAction.disabled = !configReady;
  emptyAction.hidden = connecting || restoring;
}

function setStatus(text) {
  stageStatus.textContent = text;
  stageStatus.dataset.state = text === "已连接" ? "connected" : ["正在连接", "正在重连"].includes(text) ? "connecting" : "idle";
}

function applyKindFields() {
  const pve = kindInput.value === "pve";
  for (const input of serverForm.querySelectorAll("input, select")) input.disabled = serverMutationPending;
  for (const [selector, visible] of [[".for-pve", pve], [".for-direct", !pve]]) {
    for (const field of serverForm.querySelectorAll(selector)) {
      field.hidden = !visible;
      if (["INPUT", "SELECT"].includes(field.tagName)) field.disabled = serverMutationPending || !visible;
      for (const input of field.querySelectorAll("input, select")) input.disabled = serverMutationPending || !visible;
    }
  }
}

function fillForm(server) {
  kindInput.value = server?.kind || layout.mode;
  serverForm.elements.name.value = server?.name || "";
  serverForm.elements.origin.value = server?.origin || "";
  serverForm.elements.node.value = server?.node || "";
  serverForm.elements.vmid.value = server?.vmid || "";
  serverForm.elements.username.value = server?.username || (server ? "" : "root@pam");
  serverForm.elements.vncUsername.value = server?.kind === "direct" ? server.username || "" : "";
  serverForm.elements.address.value = directAddress(server);
  insecureInput.checked = server?.insecure === true;
  serverForm.elements.securityPolicy.value = server?.securityPolicy || "preferTls";
  applyKindFields();
}

function readForm() {
  const kind = kindInput.value === "direct" ? "direct" : "pve";
  const name = serverForm.elements.name.value.trim();
  if (!name) throw new Error("先写一个名称。");
  if (kind === "pve") {
    const origin = normalizePveOrigin(serverForm.elements.origin.value);
    const node = serverForm.elements.node.value.trim();
    const vmid = Number(serverForm.elements.vmid.value);
    const username = serverForm.elements.username.value.trim() || "root@pam";
    if (!origin || !node || !Number.isInteger(vmid) || vmid <= 0) {
      throw new Error("PVE 需要主机、节点和 VMID。");
    }
    return { kind, name, origin, node, vmid, username, insecure: insecureInput.checked };
  }
  const address = serverForm.elements.address.value.trim();
  if (!address) throw new Error("直接连接需要 VNC 地址。");
  const username = serverForm.elements.vncUsername.value.trim();
  if (username) validateAccountCredential(username, "用户名");
  return { kind, name, address, username,
    securityPolicy: serverForm.elements.securityPolicy.value || "preferTls" };
}

function validateAccountCredential(value, label) {
  if (value.includes("\0") || new TextEncoder().encode(value).length > 63) {
    throw new Error(`macOS 账户${label}不能包含空字符，且最多为 63 个 UTF-8 字节。`);
  }
}

const trashIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;

async function deleteServer(id) {
  if (!configReady || serverMutationPending) return;
  serverMutationPending = true;
  render();
  try {
    const plan = await mutateServers(config => {
      if (!config.servers.some(server => server.id === id)) return null;
      config.servers = config.servers.filter(server => server.id !== id);
      if (config.selectedId === id) config.selectedId = config.servers.find(server => server.kind === config.layout.mode)?.id || "";
      return { config, oldId: id, closeId: id };
    });
    if (!serverDialog.open) fillForm(selectedServer());
    render();
    if (plan) await cleanOldCredential(id);
  } catch (error) {
    setHint(errorMessage(error), true);
  } finally {
    serverMutationPending = false;
    render();
    refreshPasswordButton(credentialContextId());
  }
}

// Deletion also removes the saved credential and cannot be undone.
let resolveConfirm = null;
function confirmServerDeletion(server) {
  resolveConfirm?.(false);
  document.querySelector("#confirm-title").textContent = `删除“${server.name}”？`;
  confirmDialog.returnValue = "";
  confirmDialog.showModal();
  return new Promise(resolve => { resolveConfirm = resolve; });
}
confirmDialog.addEventListener("close", () => {
  const resolve = resolveConfirm;
  resolveConfirm = null;
  resolve?.(confirmDialog.returnValue === "delete");
});

function renderServerList() {
  // Replacing rows must not drop keyboard focus when selection or status changes.
  const focusedServerId = document.activeElement?.dataset.serverId;
  let focusTarget;
  const modeServers = servers.filter(server => server.kind === layout.mode);
  const query = serverSearch.value.trim().toLocaleLowerCase();
  const visibleServers = modeServers.filter(server => `${server.name} ${subtitle(server)} ${server.origin || ""}`.toLocaleLowerCase().includes(query));
  serversEl.replaceChildren();
  document.querySelector("#server-count").textContent = query ? `${visibleServers.length} / ${modeServers.length}` : String(modeServers.length);
  clearServerSearch.hidden = !serverSearch.value;
  if (visibleServers.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = query ? "没有匹配的服务器\n试试其他名称或地址" : layout.mode === "pve" ? "还没有 PVE 服务器\n点击 + 添加控制台" : "还没有 VNC 服务器\n点击 + 添加直连地址";
    serversEl.append(empty);
  }
  for (const server of visibleServers) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "server-main";
    button.dataset.serverId = server.id;
    if (focusedServerId === server.id) focusTarget = button;
    button.title = `${server.name}\n${subtitle(server)}`;
    button.setAttribute("aria-current", server.id === selectedId ? "true" : "false");
    const name = document.createElement("span");
    name.className = "server-name";
    name.textContent = server.name;
    const address = document.createElement("span");
    address.className = "server-address";
    address.textContent = subtitle(server);
    button.append(name, address);
    button.addEventListener("click", () => selectServer(server.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon";
    remove.disabled = serverMutationPending;
    remove.setAttribute("aria-label", `删除 ${server.name}`);
    remove.innerHTML = trashIcon;
    remove.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (await confirmServerDeletion(server)) return deleteServer(server.id);
    });
    item.append(button, remove);
    serversEl.append(item);
  }
  focusTarget?.focus({ preventScroll: true });
}

function render() {
  const current = selectedServer();
  applyLayout();
  renderServerList();

  stageTitle.textContent = current ? current.name : "未选择服务器";
  stageTitle.title = current?.name || "";
  const target = document.querySelector("#stage-target");
  target.textContent = current ? subtitle(current) : "";
  target.title = target.textContent;
  target.hidden = !current;
  document.querySelector(".workspace .panel-caption").textContent = current
    ? current.kind === "pve" ? "PVE 控制台" : "VNC 直连" : "远程桌面";
  connectButton.disabled = !current || !configReady;
  connectButton.textContent = recovery && (connecting || !rfb) ? "取消重连" : connecting ? "取消连接" : rfb ? "断开" : "连接";
  connectButton.dataset.action = rfb || connecting || recovery ? "disconnect" : "connect";
  updateInputControls();
  updateWorkspaceState();
  document.querySelector("#edit-server").disabled = !current || !configReady || serverMutationPending;
  for (const selector of ["#add-server", "#new-server"]) document.querySelector(selector).disabled = !configReady || serverMutationPending;
  document.querySelector("#server-save").disabled = serverMutationPending;
  document.querySelector("#server-dialog-close").disabled = serverMutationPending;
  applyKindFields();
  if (serverMutationPending) forgetPasswordButton.disabled = true;
  if (!rfb && !connecting && !recovery && !stageHint.classList.contains("error")) {
    setStatus("未连接");
    setHint(current ? "点击连接，打开远程控制台" : "从左侧选择服务器，开始远程会话");
  }

  scaleInput.checked = preferences.scaleToWindow;
  viewOnlyInput.checked = preferences.viewOnly;
  sharedInput.checked = preferences.shared;
  sshPanel.setServer(current);
}

function applyLayout() {
  app.dataset.mode = layout.mode;
  app.classList.toggle("left-hidden", !layout.leftVisible);
  app.classList.toggle("right-hidden", !layout.rightVisible);
  for (const [side, visible] of [["left", layout.leftVisible], ["right", layout.rightVisible]]) {
    const toggle = document.querySelector(`#toggle-${side}`);
    toggle.setAttribute("aria-expanded", String(visible));
    toggle.setAttribute("aria-pressed", String(visible));
    const label = `${visible ? "收起" : "展开"}${side === "left" ? "服务器列表" : "SSH 终端"}`;
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }
  for (const mode of ["pve", "direct"]) {
    document.querySelector(`#mode-${mode}`).setAttribute("aria-pressed", String(layout.mode === mode));
    document.querySelector(`#mode-${mode}`).tabIndex = layout.mode === mode ? 0 : -1;
  }
}

function switchMode(mode) {
  if (!["pve", "direct"].includes(mode)) return;
  layout.mode = mode;
  serverSearch.value = "";
  persist();
  render();
}

function openServerEditor(isNew) {
  if (!configReady || serverMutationPending) return;
  formError.textContent = "";
  if (isNew) serverForm.dataset.mode = "new";
  else delete serverForm.dataset.mode;
  serverForm.dataset.serverId = isNew ? "" : selectedId;
  fillForm(isNew ? null : selectedServer());
  document.querySelector("#server-dialog-title").textContent = isNew ? "添加服务器" : "编辑服务器";
  // Actions that only apply to an existing entry stay out of the add flow.
  for (const selector of ["#new-server", "#forget-password"]) document.querySelector(selector).hidden = isNew;
  if (!serverDialog.open) serverDialog.showModal();
  refreshPasswordButton(isNew ? "" : selectedId);
  serverForm.elements.name.focus();
}

function selectServer(id) {
  if (id !== selectedId) closeSession();
  selectedId = id;
  persist();
  if (!serverDialog.open) fillForm(selectedServer());
  refreshPasswordButton(credentialContextId());
  render();
}

function applySessionPreferences() {
  if (!rfb) return;
  rfb.scaleViewport = preferences.scaleToWindow;
  rfb.clipViewport = false;
  rfb.resizeSession = false;
  inputGuard.setReadOnly(preferences.viewOnly);
  rfb.showDotCursor = true;
}

function cancelRecovery() {
  if (!recovery) return;
  for (const timer of [recovery.retryTimer, recovery.expiryTimer, recovery.stableTimer]) clearTimeout(timer);
  recovery = null;
}

function closeSession({ preserveRecovery = false } = {}) {
  if (!preserveRecovery) cancelRecovery();
  const operation = activeOperation;
  clearConnectionDeadline(operation);
  activeOperation = null;
  passwordOperation = null;
  passwordInput.value = "";
  passwordUsernameInput.value = "";
  passwordDialog.close();
  const current = rfb;
  inputGuard.detach();
  rfb = null;
  current?.disconnect();
  screen.replaceChildren();
  if (operation?.sessionId) invoke("disconnect", { sessionId: operation.sessionId }).catch(() => {});
  if (operation) operation.password = undefined;
  connecting = false;
  updateInputControls();
  stageHint.classList.remove("error");
  setStatus("未连接");
}

function isCurrent(operation) {
  return activeOperation === operation && selectedId === operation.server.id;
}

function clearConnectionDeadline(operation) {
  if (!operation) return;
  clearTimeout(operation.deadline);
  operation.deadline = null;
}

function armConnectionDeadline(operation) {
  clearConnectionDeadline(operation);
  operation.deadline = setTimeout(() => {
    if (!isCurrent(operation) || !connecting) return;
    failSession({ stage: "rfb_init", code: "timeout", safeMessage: "建立远程桌面超时，请检查服务器后重新连接。" });
  }, CONNECTION_TIMEOUT_MS);
}

function beginOperation(plan = null) {
  const server = selectedServer();
  if (!server || !configReady) return null;
  closeSession({ preserveRecovery: !!plan });
  const operation = { server: structuredClone(server), sessionId: null, password: undefined, remember: false,
    username: server.kind === "direct" ? server.username || "" : "", waitingCredentials: false,
    connected: false, recovery: plan };
  activeOperation = operation;
  // Capture the capability before authentication. Clear/delete revokes it in
  // the backend, even when an old save IPC arrives after that operation.
  operation.credentialLease = invoke("credential_generation", { serverId: server.id }).catch(() => null);
  connectionError = null;
  connecting = true;
  armConnectionDeadline(operation);
  setHint("");
  setStatus(plan ? "正在重连" : "正在连接");
  render();
  return operation;
}

function openSession(operation, url, password) {
  screen.replaceChildren();
  const session = new RFB(screen, url, {
    shared: preferences.shared,
    credentials: { password, ...(operation.username ? { username: operation.username } : {}) },
  });
  rfb = session;
  session.background = "#000000";
  // Input stays suspended through authentication and until an explicit canvas click.
  session.viewOnly = true;
  session.focusOnClick = false;
  applySessionPreferences();
  session.addEventListener("connect", async () => {
    if (rfb !== session || !isCurrent(operation)) return;
    clearConnectionDeadline(operation);
    connecting = false;
    operation.connected = true;
    // Brief successes must not reset the recovery budget during a flapping
    // service. Each restored connection still starts with suspended input.
    if (recovery && recovery === operation.recovery) {
      const plan = recovery;
      plan.stableTimer = setTimeout(() => {
        if (recovery === plan && isCurrent(operation) && !connecting) cancelRecovery();
      }, RECOVERY_STABLE_MS);
    }
    inputGuard.attach(session);
    setStatus("已连接");
    setHint("");
    render();
    const savedPassword = operation.password;
    operation.password = undefined;
    if (operation.remember && savedPassword !== undefined) {
      try {
        if (operation.server.kind === "direct" && operation.username !== (operation.server.username || "")) {
          const plan = await mutateServers(config => {
            if (!isCurrent(operation)) return null;
            const index = config.servers.findIndex(server => server.id === operation.server.id);
            if (index < 0) return null;
            const oldId = config.servers[index].id;
            const newId = crypto.randomUUID();
            config.servers[index] = { ...config.servers[index], id: newId, username: operation.username };
            config.selectedId = newId;
            return { config, oldId, newId, authenticatedOperation: operation };
          });
          if (!plan || !isCurrent(operation)) return;
          // Captured atomically with the new binding, before it is published.
          operation.credentialLease = Promise.resolve(plan.credentialGeneration);
          if (!serverDialog.open) fillForm(selectedServer());
          render();
          await cleanOldCredential(plan.oldId);
        }
        if (!isCurrent(operation)) return;
        const generation = await operation.credentialLease;
        if (!isCurrent(operation)) return;
        if (!generation) throw new Error("凭据保存授权不可用");
        await invoke("save_password", { serverId: operation.server.id, generation, password: savedPassword });
        rejectedPasswords.delete(operation.server.id);
        if (isCurrent(operation)) refreshPasswordButton(operation.server.id);
      } catch {
        if (isCurrent(operation)) setHint("已连接，但登录信息未能保存；本次连接仍可使用。", true);
      }
    }
  });
  session.addEventListener("securityfailure", (event) => {
    if (rfb !== session || !isCurrent(operation)) return;
    const reason = event.detail?.reason || "认证没有通过";
    // noVNC 1.6 also emits status=1 for missing/unsupported security types.
    // Only an actual password/account SecurityResult is eligible for re-entry.
    const authResult = [2, 30].includes(session._rfbAuthScheme)
      && (session._rfbInitState === "SecurityResult" || session._securityContext === "security result");
    const limited = authResult && event.detail?.status === 2;
    failSession({ stage: authResult ? "rfb_auth" : "rfb_security",
      code: limited ? "auth_limited" : authResult && event.detail?.status === 1 ? "unauthorized" : "security_failure",
      safeMessage: limited ? "服务器已限制认证重试，请稍后再连接。" : reason });
  });
  session.addEventListener("credentialsrequired", async (event) => {
    if (rfb !== session || !isCurrent(operation)) return;
    const types = event.detail?.types || [];
    if (types.some(type => !["username", "password"].includes(type))
        || operation.server.kind !== "direct" && types.includes("username")) {
      failSession("服务器要求此客户端尚未支持的身份验证方式。");
      return;
    }
    if (operation.waitingCredentials) return;
    operation.waitingCredentials = true;
    const needsUsername = types.includes("username");
    if (operation.server.kind === "direct" && !rejectedPasswords.has(operation.server.id)
        && (needsUsername ? !!operation.username : !operation.server.username)) {
      try {
        const saved = await invoke("password_saved", { serverId: operation.server.id });
        if (rfb !== session || !isCurrent(operation)) return;
        if (saved) {
          const savedPassword = await invoke("load_password", { serverId: operation.server.id });
          if (rfb !== session || !isCurrent(operation)) return;
          if (needsUsername) {
            validateAccountCredential(operation.username, "用户名");
            validateAccountCredential(savedPassword, "密码");
          }
          operation.waitingCredentials = false;
          armConnectionDeadline(operation);
          session.sendCredentials({ password: savedPassword, ...(needsUsername ? { username: operation.username } : {}) });
          return;
        }
      } catch (error) {
        if (isCurrent(operation)) failSession(error);
        return;
      }
    }
    openPasswordDialog(operation, true, needsUsername);
  });
  session.addEventListener("disconnect", () => {
    if (rfb !== session || !isCurrent(operation)) return;
    failSession({ stage: "rfb", code: "transport", safeMessage: "连接中断。" });
  });
}

function failSession(error) {
  connectionError = { stage: error?.stage || "connection", code: error?.code || "failed", safeMessage: errorMessage(error) };
  const operation = activeOperation;
  const transient = ["rfb", "tls"].includes(connectionError.stage) && connectionError.code === "transport"
    || connectionError.stage === "tcp" && ["connect", "timeout"].includes(connectionError.code)
    || ["rfb_init", "rfb_security"].includes(connectionError.stage) && connectionError.code === "timeout";
  if (transient && operation?.server.kind === "direct" && isCurrent(operation)
      && (operation.connected || recovery && operation.recovery === recovery)) {
    queueRecovery(operation);
    return;
  }
  if ((connectionError.stage === "pve_login" || connectionError.stage === "rfb_auth")
      && connectionError.code === "unauthorized" && activeOperation) rejectedPasswords.add(activeOperation.server.id);
  closeSession();
  setStatus("未连接");
  setHint(connectionError.safeMessage, true, "connection");
  render();
}

function queueRecovery(operation) {
  if (!recovery) {
    const plan = { serverId: operation.server.id, attempts: 0 };
    recovery = plan;
    plan.expiryTimer = setTimeout(() => {
      if (recovery !== plan) return;
      // A healthy connection survives the campaign deadline.
      if (rfb && !connecting) { cancelRecovery(); return; }
      cancelRecovery();
      failSession({ stage: "reconnect", code: "exhausted",
        safeMessage: "自动重连在 60 秒内未能恢复，请确认 VNC 服务已启动后重新连接。" });
    }, RECOVERY_TIMEOUT_MS);
  }
  const plan = recovery;
  clearTimeout(plan.stableTimer);
  closeSession({ preserveRecovery: true });
  connectionError = null;
  plan.delay = RECOVERY_DELAYS[Math.min(plan.attempts, RECOVERY_DELAYS.length - 1)];
  setStatus("正在重连");
  setHint("");
  render();
  plan.retryTimer = setTimeout(() => {
    if (recovery !== plan || selectedId !== plan.serverId) return;
    plan.attempts++;
    const next = beginOperation(plan);
    if (next) void startConnection(next);
    else { cancelRecovery(); render(); }
  }, plan.delay);
}

function openPasswordDialog(operation, supplement = false, needsUsername = false) {
  if (!isCurrent(operation)) return;
  // User interaction ends background recovery; no deadline may dismiss this
  // dialog or replay an unsaved password from the previous connection.
  cancelRecovery();
  clearConnectionDeadline(operation);
  setStatus("正在连接");
  render();
  const server = operation.server;
  const accountAuth = server.kind === "direct" && needsUsername;
  passwordOperation = { operation, supplement, accountAuth };
  passwordTitle.textContent = server.name;
  document.querySelector("#password-context").textContent = server.kind === "pve" ? "PVE 登录" : accountAuth ? "macOS 账户认证" : "VNC 密码认证";
  passwordInput.value = "";
  passwordUsernameField.hidden = !accountAuth;
  passwordUsernameInput.disabled = !accountAuth;
  passwordUsernameInput.required = accountAuth;
  passwordUsernameInput.readOnly = false;
  passwordUsernameInput.value = accountAuth ? operation.username : "";
  rememberInput.disabled = false;
  rememberInput.checked = true;
  passwordNote.textContent = server.kind === "pve"
    ? "这是 PVE 的登录密码。记住后存在这台 Windows 的凭据管理器里，不写入配置文件。"
    : accountAuth ? "服务器要求账户认证，请填写 Mac 账户的短名称和登录密码。用户名仅在认证成功且勾选记住后保存；密码存在 Windows 凭据管理器里。"
    : "这是 VNC 密码。服务器没有密码时可以留空。记住后存在这台 Windows 的凭据管理器里。";
  passwordDialog.showModal();
  if (accountAuth && !operation.username) passwordUsernameInput.focus();
  else passwordInput.focus();
}

function credentialContextId() {
  return serverForm.dataset.mode === "new" ? "" : serverDialog.open ? serverForm.dataset.serverId ?? selectedId : selectedId;
}

async function refreshPasswordButton(serverId) {
  const refresh = ++passwordRefresh;
  if (!serverId || serverForm.dataset.mode === "new" || !window.__TAURI_INTERNALS__) {
    forgetPasswordButton.disabled = true;
    return;
  }
  try {
    const saved = await invoke("password_saved", { serverId });
    if (refresh !== passwordRefresh || credentialContextId() !== serverId) return;
    forgetPasswordButton.disabled = !saved || serverMutationPending;
  } catch {
    if (refresh === passwordRefresh) forgetPasswordButton.disabled = true;
  }
}

async function startConnection(operation, password) {
  if (!isCurrent(operation)) return;
  const server = operation.server;
  if (!window.__TAURI_INTERNALS__) {
    failSession("连接要在 LocalVNC 窗口里进行。");
    return;
  }
  try {
    await operation.credentialLease;
    if (!isCurrent(operation)) return;
    // Serialize reservations so an older IPC response cannot replace a newer session.
    const reservation = beginChain.then(() => isCurrent(operation) ? invoke("begin_session") : null);
    beginChain = reservation.catch(() => {});
    operation.sessionId = await reservation;
    if (!isCurrent(operation)) {
      if (operation.sessionId) invoke("disconnect", { sessionId: operation.sessionId }).catch(() => {});
      return;
    }
    const session = server.kind === "pve"
      ? await invoke("connect_pve", {
          request: {
            sessionId: operation.sessionId,
            origin: server.origin,
            node: server.node,
            vmid: server.vmid,
            username: server.username || "root@pam",
            password,
            insecure: server.insecure === true,
          },
        })
      : await invoke("connect_direct", {
          request: { sessionId: operation.sessionId, address: server.address,
            securityPolicy: server.securityPolicy || "preferTls" },
        });
    if (!isCurrent(operation)) {
      invoke("disconnect", { sessionId: operation.sessionId }).catch(() => {});
      return;
    }
    openSession(operation, session.url, server.kind === "pve" ? session.password : password);
  } catch (error) {
    if (!isCurrent(operation)) return;
    failSession(error);
  }
}

function targetKey(server) {
  let origin = server.origin;
  if (server.kind === "pve") {
    // Canonical spelling preserves credential identity. Keep legacy invalid
    // targets editable so fixing one cannot block loading every other server.
    try { origin = normalizePveOrigin(origin); } catch { /* Compare the old literal. */ }
  }
  return JSON.stringify(server.kind === "pve"
    ? [server.kind, origin, server.node, server.vmid, server.username]
    : [server.kind, server.address, server.username || ""]);
}

kindInput.addEventListener("change", applyKindFields);

serverForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configReady || serverMutationPending) return;
  let draft;
  try {
    draft = readForm();
  } catch (error) {
    formError.textContent = error.message;
    return;
  }
  const editingId = serverForm.dataset.mode === "new" ? "" : serverForm.dataset.serverId ?? selectedId;
  serverMutationPending = true;
  formError.textContent = "";
  render();
  try {
    const plan = await mutateServers(config => {
      const current = config.servers.find(server => server.id === editingId);
      if (editingId && !current) throw new Error("正在编辑的服务器已不存在，请重新选择。");
      const changedTarget = current && targetKey(current) !== targetKey(draft);
      const id = !current || changedTarget ? crypto.randomUUID() : current.id;
      const updated = { id, ...draft, ...(!changedTarget && current?.ssh ? { ssh: current.ssh } : {}) };
      config.servers = current ? config.servers.map(server => server.id === current.id ? updated : server) : [...config.servers, updated];
      // Editing is bound to the original ID, even if the list selection changed.
      if (!current || config.selectedId === current.id) {
        config.selectedId = id;
        config.layout.mode = draft.kind;
      }
      const connectionChanged = current && (changedTarget
        || (current.securityPolicy || "preferTls") !== (draft.securityPolicy || "preferTls")
        || (current.insecure === true) !== (draft.insecure === true));
      return { config, oldId: current?.id, newId: id, closeId: connectionChanged ? current.id : null,
        cleanupId: changedTarget ? current.id : null };
    });
    delete serverForm.dataset.mode;
    delete serverForm.dataset.serverId;
    serverDialog.close();
    fillForm(selectedServer());
    render();
    await cleanOldCredential(plan.cleanupId);
  } catch (error) {
    formError.textContent = errorMessage(error);
  } finally {
    serverMutationPending = false;
    render();
    refreshPasswordButton(credentialContextId());
  }
});

document.querySelector("#new-server").addEventListener("click", () => openServerEditor(true));
document.querySelector("#add-server").addEventListener("click", () => openServerEditor(true));
document.querySelector("#edit-server").addEventListener("click", () => openServerEditor(false));
document.querySelector("#server-dialog-close").addEventListener("click", () => { if (!serverMutationPending) serverDialog.close(); });
serverDialog.addEventListener("cancel", event => { if (serverMutationPending) event.preventDefault(); });
for (const mode of ["pve", "direct"]) {
  const button = document.querySelector(`#mode-${mode}`);
  button.addEventListener("click", () => switchMode(mode));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "pve" : event.key === "End" ? "direct" : mode === "pve" ? "direct" : "pve";
    switchMode(next);
    document.querySelector(`#mode-${next}`).focus();
  });
}
for (const side of ["left", "right"]) {
  document.querySelector(`#toggle-${side}`).addEventListener("click", () => {
    const key = `${side}Visible`;
    layout[key] = !layout[key];
    applyLayout();
    persist();
    requestAnimationFrame(() => sshPanel.fit());
  });
}
window.addEventListener("beforeunload", () => {
  closeSession();
  windowControls.dispose();
  inputGuard.dispose();
  virtualKeyboard.dispose();
  sshPanel.dispose();
});

async function connectSelected() {
  if (rfb || connecting || recovery) {
    closeSession();
    stageHint.classList.remove("error");
    render();
    return;
  }
  const operation = beginOperation();
  if (!operation) return;
  const server = operation.server;
  if (server.kind === "direct") {
    await startConnection(operation);
    return;
  }
  if (window.__TAURI_INTERNALS__ && !rejectedPasswords.has(server.id)) {
    try {
      const saved = await invoke("password_saved", { serverId: server.id });
      if (!isCurrent(operation)) return;
      if (saved) {
        const password = await invoke("load_password", { serverId: server.id });
        if (isCurrent(operation)) await startConnection(operation, password);
        return;
      }
    } catch (error) {
      if (isCurrent(operation)) failSession(error);
      return;
    }
  }
  openPasswordDialog(operation);
}

passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pending = passwordOperation;
  if (!pending || !isCurrent(pending.operation)) return;
  const { operation, supplement, accountAuth } = pending;
  const username = accountAuth ? passwordUsernameInput.value.trim() : "";
  if (accountAuth && !username) {
    passwordNote.textContent = "请填写 Mac 账户的短名称。";
    passwordUsernameInput.focus();
    return;
  }
  const password = passwordInput.value;
  if (accountAuth) {
    try {
      validateAccountCredential(username, "用户名");
      validateAccountCredential(password, "密码");
    } catch (error) {
      passwordNote.textContent = errorMessage(error);
      return;
    }
  }
  const remember = !rememberInput.disabled && rememberInput.checked;
  passwordInput.value = "";
  passwordUsernameInput.value = "";
  passwordDialog.close();
  passwordOperation = null;
  operation.password = remember ? password : undefined;
  operation.remember = remember;
  if (operation.server.kind === "direct") operation.username = accountAuth ? username : "";
  operation.waitingCredentials = false;
  armConnectionDeadline(operation);
  if (supplement) rfb?.sendCredentials({ password, ...(accountAuth ? { username } : {}) });
  else await startConnection(operation, password);
});

forgetPasswordButton.addEventListener("click", async () => {
  const server = servers.find(item => item.id === credentialContextId());
  if (!server || serverForm.dataset.mode === "new" || serverMutationPending) return;
  try {
    await invoke("forget_password", { serverId: server.id });
    rejectedPasswords.delete(server.id);
    refreshPasswordButton(server.id);
  } catch (error) {
    setHint(String(error).replace(/^Error:\s*/, ""), true);
  }
});

document.querySelector("#password-cancel").addEventListener("click", () => {
  closeSession();
  render();
});
connectButton.addEventListener("click", connectSelected);
emptyAction.addEventListener("click", () => {
  if (!selectedServer()) return openServerEditor(true);
  const pending = connectSelected();
  // The empty-state action disappears during connection. Keep cancellation
  // reachable without losing focus or taking focus from a credentials dialog.
  if (connecting && !passwordDialog.open) connectButton.focus({ preventScroll: true });
  return pending;
});
serverSearch.addEventListener("input", renderServerList);
clearServerSearch.addEventListener("click", () => {
  serverSearch.value = "";
  serverSearch.focus();
  renderServerList();
});
passwordDialog.addEventListener("cancel", () => { closeSession(); render(); });

keyboardButton.addEventListener("click", () => virtualKeyboard.toggle());

document.querySelector("#fullscreen").addEventListener("click", () => {
  const stage = document.querySelector(".workspace");
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen();
});

document.querySelector("#open-settings").addEventListener("click", () => settings.showModal());

for (const [input, key] of [
  [scaleInput, "scaleToWindow"],
  [viewOnlyInput, "viewOnly"],
  [sharedInput, "shared"],
]) {
  input.addEventListener("change", () => {
    preferences = { ...preferences, [key]: input.checked };
    persist();
    applySessionPreferences();
    render();
  });
}

async function boot() {
  if (window.__TAURI_INTERNALS__) {
    listen("vnc-error", (event) => {
      if (event.payload?.sessionId !== activeOperation?.sessionId) return;
      failSession(event.payload);
    }).catch(() => {});
    try {
      applyStored(await invoke("load_config"));
    } catch (error) {
      setHint(String(error).replace(/^Error:\s*/, ""), true);
    }
  } else {
    try { applyStored({
      servers: loadServers(),
      settings: loadSettings(),
      selectedId: localStorage.getItem(selectedKey) || "",
      layout: JSON.parse(localStorage.getItem(layoutKey) || "null"),
    }); } catch (error) { setHint(error.message, true); }
  }
  fillForm(selectedServer());
  applyKindFields();
  render();
  refreshPasswordButton(selectedId);
}

boot();
