import { getCurrentWindow } from "@tauri-apps/api/window";

// Tauri handles data-tauri-drag-region natively, including double-click maximize.
// Keeping that behavior in Tauri avoids a second JS toggle on the same click.
// default.json grants only minimize/toggle-maximize/close/start-dragging beyond
// core:default, which already includes state queries, events, and double-click.
export function setupWindowControls({ onFocusLost = () => {}, dependencies = {} } = {}) {
  const doc = dependencies.document || document;
  const win = dependencies.window || window;
  const getWindow = dependencies.getCurrentWindow || getCurrentWindow;
  const controls = doc.querySelector("#window-controls");
  const app = doc.querySelector("#app");
  const minimize = doc.querySelector("#window-minimize");
  const maximize = doc.querySelector("#window-maximize");
  const close = doc.querySelector("#window-close");
  controls.hidden = !win.__TAURI_INTERNALS__;
  if (controls.hidden) return { dispose() {}, ready: Promise.resolve() };

  const native = getWindow();
  const cleanups = [];
  let disposed = false;
  let stateRequest = 0;

  async function refreshMaximized() {
    const request = ++stateRequest;
    try {
      const maximized = await native.isMaximized();
      if (disposed || request !== stateRequest) return;
      controls.dataset.maximized = String(maximized);
      maximize.setAttribute("aria-label", maximized ? "还原窗口" : "最大化窗口");
      maximize.title = maximized ? "还原窗口" : "最大化窗口";
    } catch { /* An unavailable query must not disable the close/minimize actions. */ }
  }

  function bind(button, action) {
    let pending = false;
    const handler = async () => {
      if (disposed || pending) return;
      pending = true;
      try { await action(); }
      catch { if (!disposed) button.title = "窗口操作失败，请重试"; }
      finally { pending = false; }
    };
    button.addEventListener("click", handler);
    cleanups.push(() => button.removeEventListener("click", handler));
  }

  async function listen(register) {
    try {
      const unlisten = await register();
      if (disposed) unlisten();
      else cleanups.push(unlisten);
    } catch { /* Browser blur remains a fallback if native event setup is unavailable. */ }
  }

  bind(minimize, () => native.minimize());
  bind(maximize, async () => { await native.toggleMaximize(); await refreshMaximized(); });
  bind(close, () => native.close());
  const ready = Promise.all([
    refreshMaximized(),
    listen(() => native.onResized(() => { if (!disposed) void refreshMaximized(); })),
    listen(() => native.onFocusChanged(({ payload }) => {
      if (disposed) return;
      app.dataset.windowFocused = String(payload);
      // Regaining native focus never resumes VNC input automatically.
      if (payload === false) onFocusLost();
    })),
  ]).then(() => {});

  return {
    ready,
    dispose() {
      if (disposed) return;
      disposed = true;
      stateRequest++;
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
