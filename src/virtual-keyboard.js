import KeyTable from "@novnc/novnc/lib/input/keysym.js";
import "./virtual-keyboard.css";

const MODIFIERS = [
  { name: "control", keysym: KeyTable.XK_Control_L, code: "ControlLeft" },
  { name: "alt", keysym: KeyTable.XK_Alt_L, code: "AltLeft" },
  { name: "meta", keysym: KeyTable.XK_Super_L, code: "MetaLeft" },
  { name: "shift", keysym: KeyTable.XK_Shift_L, code: "ShiftLeft" },
];
const action = (label, code, keysym, weight = 1) => ({ label, code, keysym, weight, action: true });
const character = (plain, shifted, code) => ({ label: plain, plain, shifted, code, weight: 1 });
const modifier = (label, name, code, weight = 1) => ({ label, modifier: name, code, weight });
const letters = text => [...text].map(letter => character(letter.toLowerCase(), letter, `Key${letter}`));
const ROWS = [
  [action("Esc", "Escape", KeyTable.XK_Escape),
    ...Array.from({ length: 12 }, (_, index) => action(`F${index + 1}`, `F${index + 1}`, KeyTable[`XK_F${index + 1}`])),
    action("Delete", "Delete", KeyTable.XK_Delete, 1.4)],
  [character("`", "~", "Backquote"),
    ...[..."1234567890"].map((number, index) => character(number, "!@#$%^&*()"[index], `Digit${number}`)),
    character("-", "_", "Minus"), character("=", "+", "Equal"), action("⌫", "Backspace", KeyTable.XK_BackSpace, 2)],
  [action("Tab", "Tab", KeyTable.XK_Tab, 1.5), ...letters("QWERTYUIOP"),
    character("[", "{", "BracketLeft"), character("]", "}", "BracketRight"), character("\\", "|", "Backslash")],
  [modifier("Caps", "caps", "CapsLock", 1.8), ...letters("ASDFGHJKL"),
    character(";", ":", "Semicolon"), character("'", '"', "Quote"), action("Enter", "Enter", KeyTable.XK_Return, 2.2)],
  [modifier("Shift", "shift", "ShiftLeft", 2.2), ...letters("ZXCVBNM"),
    character(",", "<", "Comma"), character(".", ">", "Period"), character("/", "?", "Slash"),
    modifier("Shift", "shift", "ShiftRight", 2.8)],
  [modifier("Ctrl", "control", "ControlLeft", 1.5), modifier("Win", "meta", "MetaLeft", 1.25),
    modifier("Alt", "alt", "AltLeft", 1.25), { ...character(" ", " ", "Space"), label: "空格", weight: 6 },
    action("←", "ArrowLeft", KeyTable.XK_Left, 1.25), action("↓", "ArrowDown", KeyTable.XK_Down, 1.25),
    action("↑", "ArrowUp", KeyTable.XK_Up, 1.25), action("→", "ArrowRight", KeyTable.XK_Right, 1.25)],
];
const ACCESSIBLE_NAMES = {
  Backspace: "退格", ArrowLeft: "向左", ArrowRight: "向右", ArrowUp: "向上", ArrowDown: "向下",
  Space: "空格", CapsLock: "大写锁定（仅虚拟键盘）", MetaLeft: "Win / Super",
};

// Modifiers are local one-shot choices. Each ordinary click is one complete,
// synchronous chord, so hiding the keyboard or losing focus cannot leave a
// virtual modifier held on the remote computer.
export function createVirtualKeyboard({ container, sendKey, beforeSend = () => true, onVisibilityChange = () => {}, dependencies = {} }) {
  const doc = dependencies.document || document;
  let connected = false, canControl = false, readOnly = false, visible = false, disposed = false;
  let caps = false, inputError = false;
  const modifiers = new Set();
  const keyButtons = [];
  const listeners = [];
  const root = container;
  root.className = "virtual-keyboard";
  root.hidden = true;
  root.setAttribute("aria-label", "远程虚拟键盘");
  const toolbar = doc.createElement("div");
  toolbar.className = "vk-toolbar";
  const title = doc.createElement("span");
  title.className = "vk-title";
  title.textContent = "虚拟键盘";
  const status = doc.createElement("span");
  status.className = "vk-status";
  status.setAttribute("role", "status");
  const hideButton = doc.createElement("button");
  hideButton.type = "button";
  hideButton.className = "vk-hide";
  hideButton.textContent = "收起";
  hideButton.setAttribute("aria-label", "收起虚拟键盘");
  toolbar.append(title, status, hideButton);
  const rows = doc.createElement("div");
  rows.className = "vk-rows";
  root.append(toolbar, rows);

  function listen(element, type, handler, options) {
    element.addEventListener(type, handler, options);
    listeners.push(() => element.removeEventListener(type, handler, options));
  }
  function enabled() { return !disposed && visible && connected && canControl && !readOnly; }
  function clearChoices() { modifiers.clear(); caps = false; }
  function shifted(key) {
    // Caps changes only letters; Shift temporarily reverses it. Sending the
    // effective Shift chord also works with noVNC's QEMU scancode extension,
    // where an uppercase keysym alone does not change the physical key.
    const shortcut = ["control", "alt", "meta"].some(name => modifiers.has(name));
    return key.code.startsWith("Key") && !shortcut ? caps !== modifiers.has("shift") : modifiers.has("shift");
  }
  function render() {
    root.hidden = !visible;
    root.dataset.state = !connected ? "disconnected" : readOnly ? "readonly" : !canControl ? "paused" : "ready";
    status.textContent = !connected ? "连接后可使用" : readOnly ? "只读模式" : !canControl ? "点击画面恢复控制"
      : inputError ? "按键发送失败，请重新连接" : "修饰键点选后，对下一个按键生效";
    for (const { key, button, label, alternate } of keyButtons) {
      button.disabled = !enabled();
      if (key.modifier) button.setAttribute("aria-pressed", String(key.modifier === "caps" ? caps : modifiers.has(key.modifier)));
      const selected = key.plain && key.code !== "Space" ? (shifted(key) ? key.shifted : key.plain) : key.label;
      label.textContent = selected;
      button.dataset.key = selected;
      button.setAttribute("aria-label", ACCESSIBLE_NAMES[key.code] || selected);
      if (alternate) alternate.textContent = shifted(key) ? key.plain : key.shifted;
    }
  }
  function press(key) {
    if (!enabled()) return;
    inputError = false;
    if (key.modifier) {
      if (key.modifier === "caps") caps = !caps;
      else if (modifiers.has(key.modifier)) modifiers.delete(key.modifier);
      else modifiers.add(key.modifier);
      render();
      return;
    }
    try {
      if (beforeSend() === false || !enabled()) { clearChoices(); render(); return; }
    } catch {
      inputError = true;
      clearChoices();
      render();
      return;
    }
    const shiftedKey = shifted(key);
    const held = [];
    const selected = new Set(modifiers);
    if (key.plain && key.code.startsWith("Key")) {
      if (shiftedKey) selected.add("shift");
      else selected.delete("shift");
    }
    const chord = MODIFIERS.filter(item => selected.has(item.name));
    chord.push({ keysym: key.keysym ?? (shiftedKey ? key.shifted : key.plain).codePointAt(0), code: key.code });
    try {
      for (const stroke of chord) {
        // Track before sending: even a sender that throws after writing a down
        // packet must receive a matching release attempt.
        held.push(stroke);
        sendKey(stroke.keysym, stroke.code, true);
      }
    } catch {
      inputError = true;
    } finally {
      for (const stroke of held.reverse()) {
        try { sendKey(stroke.keysym, stroke.code, false); } catch { inputError = true; }
      }
      modifiers.clear();
      render();
    }
  }
  ROWS.forEach((keys, index) => {
    const row = doc.createElement("div");
    row.className = index === 0 ? "vk-row vk-row--function" : "vk-row";
    rows.append(row);
    for (const key of keys) {
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "vk-key" + (key.modifier ? " vk-key--modifier" : key.action ? " vk-key--action" : "")
        + (key.code === "Space" ? " vk-key--space" : "");
      button.dataset.code = key.code;
      button.dataset.weight = String(key.weight);
      button.style.setProperty("--key-weight", key.weight);
      if (key.modifier) button.dataset.modifier = key.modifier;
      const label = doc.createElement("span");
      label.className = "vk-key-label";
      button.append(label);
      let alternate = null;
      if (key.plain && key.shifted !== key.plain && !key.code.startsWith("Key")) {
        alternate = doc.createElement("span");
        alternate.className = "vk-key-alternate";
        alternate.setAttribute("aria-hidden", "true");
        button.append(alternate);
      }
      keyButtons.push({ key, button, label, alternate });
      listen(button, "click", () => press(key));
      row.append(button);
    }
  });
  // Keep the canvas focused for mouse/touch interaction, preserving physical
  // key-up delivery. Native button click still fires after pointerdown is
  // cancelled. Keyboard accessibility uses the button's own Enter/Space click;
  // no additional keydown-to-click handler is installed.
  listen(root, "pointerdown", event => { if (event.button === 0) event.preventDefault(); });
  listen(root, "mousedown", event => { if (event.button === 0) event.preventDefault(); });
  for (const type of ["keydown", "keyup", "keypress"]) listen(root, type, event => event.stopPropagation());
  listen(hideButton, "click", hide);
  render();

  function hide() {
    if (disposed) return;
    const changed = visible;
    visible = false;
    clearChoices();
    inputError = false;
    render();
    if (changed) onVisibilityChange(false);
  }
  return {
    get visible() { return visible; },
    toggle() {
      if (disposed) return;
      if (visible) hide();
      else { visible = true; render(); onVisibilityChange(true); }
    },
    hide,
    setState(next) {
      if (disposed) return;
      connected = Boolean(next.connected);
      canControl = Boolean(next.canControl);
      readOnly = Boolean(next.readOnly);
      if (!connected || !canControl || readOnly) clearChoices();
      if (!connected) inputError = false;
      render();
    },
    dispose() {
      if (disposed) return;
      hide();
      disposed = true;
      for (const remove of listeners) remove();
      toolbar.remove();
      rows.remove();
    },
  };
}
