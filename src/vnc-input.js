import noVncPackage from "@novnc/novnc/package.json";
import GestureHandler from "@novnc/novnc/lib/input/gesturehandler.js";
import { releaseCapture } from "@novnc/novnc/lib/util/events.js";
import { clientToElement } from "@novnc/novnc/lib/util/element.js";
import "./vnc-input.css";

const BLOCKED_EVENTS = ["pointerdown", "pointerup", "pointermove", "pointercancel", "mousedown", "mouseup",
  "mousemove", "click", "dblclick", "auxclick", "contextmenu", "wheel", "touchstart", "touchmove",
  "touchend", "touchcancel", "gesturestart", "gesturemove", "gestureend", "keydown", "keyup", "keypress"];

// noVNC 1.6.0 has no public release-all-input API. Its viewOnly setter sets
// _viewOnly BEFORE keyboard.ungrab(), so the resulting key-up packets are lost.
// Keep this adapter version-pinned and tested against the installed dependency.
// GestureHandler.detach() cancels timers but retains tracked touches; replace
// that handler on resume so a pre-blur gesture cannot continue into a new grant.
function compatible(session, version) {
  return version === "1.6.0" && session?._canvas && typeof session._keyboard?.ungrab === "function"
    && typeof session._keyboard?.grab === "function"
    && typeof session._gestures?.detach === "function" && typeof session._sendMouse === "function"
    && "_mouseMoveTimer" in session && "_mouseButtonMask" in session && "_mousePos" in session;
}

export function createVncInputGuard({ screen, onChange = () => {}, allowControlTargets = [], dependencies = {} }) {
  const doc = dependencies.document || document;
  const win = dependencies.window || window;
  const Gesture = dependencies.GestureHandler || GestureHandler;
  const freeCapture = dependencies.releaseCapture || releaseCapture;
  const position = dependencies.clientToElement || clientToElement;
  const cancelTimer = dependencies.clearTimeout || clearTimeout;
  const version = dependencies.noVncVersion || noVncPackage.version;
  let session = null;
  let paused = true;
  let readOnly = false;
  let supported = false;
  let disposed = false;
  let lastPosition = null;
  let activation = null;

  const overlay = doc.createElement("div");
  overlay.className = "vnc-input-overlay";
  overlay.tabIndex = 0;
  overlay.setAttribute("role", "button");
  overlay.setAttribute("aria-keyshortcuts", "Enter Space");
  overlay.hidden = true;
  const label = doc.createElement("span");
  label.className = "vnc-input-message";
  overlay.append(label);
  (screen.parentElement || screen).append(overlay);

  function controlling() { return !!session && !paused && !readOnly && supported && !disposed; }
  function notify() {
    overlay.hidden = !session || !paused;
    overlay.classList.toggle("vnc-input-readonly", readOnly || !supported);
    const text = !supported ? "远程输入暂不可用，请检查 noVNC 版本"
      : readOnly ? "只读模式 · 可在设置中关闭"
        : "远程控制已暂停 · 点击画面或按 Enter / 空格恢复";
    label.textContent = text;
    overlay.setAttribute("aria-label", text);
    overlay.setAttribute("aria-disabled", String(readOnly || !supported));
    onChange({ paused, canControl: controlling(), readOnly, compatible: supported });
  }
  function allowed(target) {
    return allowControlTargets.some(element => element === target || element.contains?.(target));
  }
  function inside(target) { return target === screen || screen.contains(target); }
  function block(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function releaseInput({ keepControl = false } = {}) {
    if (!session) return;
    if (supported) {
      // Release keys while sendKey is still permitted. ungrab also cancels the
      // delayed Windows AltGr sequence, including its synthetic Ctrl state.
      session._keyboard.ungrab();
      cancelTimer(session._mouseMoveTimer);
      session._mouseMoveTimer = null;
      const point = lastPosition || session._mousePos;
      if (!session.viewOnly && session._mouseButtonMask !== 0) {
        session._sendMouse(Number.isFinite(point?.x) ? point.x : 0,
          Number.isFinite(point?.y) ? point.y : 0, 0);
      }
      session._mouseButtonMask = 0;
      session._viewportDragging = false;
      session._viewportHasMoved = false;
      session._accumulatedWheelDeltaX = 0;
      session._accumulatedWheelDeltaY = 0;
      session._gestureLastTapTime = null;
      session._gestureFirstDoubleTapEv = null;
      session._gestureLastMagnitudeX = 0;
      session._gestureLastMagnitudeY = 0;
      session._gestures.detach();
      if (doc.captureElement === session._canvas) freeCapture();
    }
    if (keepControl && controlling()) {
      // Local controls keep the grant. Clear held input without moving focus
      // away from a form/SSH field; the next real canvas click still goes through.
      session._gestures = new Gesture();
      session._gestures.attach(session._canvas);
      session._keyboard.grab();
      return;
    }
    session.focusOnClick = false;
    session.viewOnly = true;
    session.blur?.();
  }
  function suspend() {
    activation = null;
    if (!session || paused) return;
    paused = true;
    releaseInput();
    notify();
  }
  function prepareVirtualInput() {
    if (!controlling() || doc.hidden || !doc.hasFocus()) return false;
    // Public RFB.sendKey() bypasses Keyboard's held-key list. Release physical
    // keys and pending AltGr before a synthetic chord so its key-ups cannot
    // conflict with a modifier still tracked by the physical keyboard handler.
    // Re-grab immediately without changing the input grant or canvas focus.
    session._keyboard.ungrab();
    session._keyboard.grab();
    return true;
  }
  function activate() {
    if (!session || !paused || readOnly || !supported || disposed || doc.hidden || !doc.hasFocus()) return;
    session._gestures = new Gesture();
    session._gestures.attach(session._canvas);
    session.focusOnClick = true;
    session.viewOnly = false;
    paused = false;
    notify();
    session.focus({ preventScroll: true });
  }
  function overlayEvent(event) {
    // Keep the browser's final click for touch activation. The overlay shields
    // the canvas, and touch-action:none prevents panning; cancelling touchstart
    // itself would suppress that click on engines with legacy touch events.
    if (event.type.startsWith("touch")) {
      event.stopImmediatePropagation();
      if (event.type === "touchcancel" || event.touches?.length > 1) activation = null;
      return;
    }
    if (event.type === "keydown" && event.key === "Tab") {
      activation = null;
      event.stopImmediatePropagation();
      return;
    }
    block(event);
    if (!session || readOnly || !supported) return;
    if (event.type === "keydown" || event.type === "keyup") {
      const focused = doc.activeElement === overlay || overlay.contains(doc.activeElement);
      const confirm = focused && ["Enter", " "].includes(event.key)
        && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
      if (event.type === "keydown") {
        if (!event.repeat) activation = confirm ? { kind: "keyboard", key: event.key } : null;
      } else {
        const explicitKey = confirm && !event.repeat && activation?.kind === "keyboard" && activation.key === event.key;
        activation = null;
        // Grant after consuming key-up: confirmation never reaches the canvas.
        if (explicitKey) activate();
      }
    } else if (event.type === "pointerdown" && event.button === 0 && event.buttons === 1 && event.isPrimary !== false) {
      activation = { kind: "pointer", pointerId: event.pointerId, released: false };
    } else if (event.type === "pointerup" && activation?.kind === "pointer" && activation.pointerId === event.pointerId && event.button === 0 && event.buttons === 0) {
      activation.released = true;
    } else if (event.type === "pointercancel") {
      activation = null;
    } else if (event.type === "click") {
      const explicitClick = activation?.kind === "pointer" && activation.released && event.button === 0 && event.detail > 0;
      activation = null;
      if (explicitClick) activate();
    }
  }
  function screenEvent(event) {
    if (!session) return;
    if (!controlling()) {
      if (event.type === "keydown" && event.key === "Tab") event.stopImmediatePropagation();
      else block(event);
      return;
    }
    const pointer = event.changedTouches?.[0] || event.touches?.[0] || event.detail || event;
    // A MouseEvent.detail is a number; gesture detail is the coordinate object.
    const source = Number.isFinite(pointer.clientX) ? pointer : event;
    if (Number.isFinite(source.clientX) && Number.isFinite(source.clientY)) {
      lastPosition = position(source.clientX, source.clientY, session._canvas);
    }
  }
  function outsideInteraction(event) {
    if (!session || paused || inside(event.target) || overlay.contains(event.target) || allowed(event.target)) return;
    releaseInput({ keepControl: true });
  }
  function focusOut(event) {
    if (!session || paused || inside(event.relatedTarget) || allowed(event.relatedTarget)) return;
    releaseInput({ keepControl: true });
  }
  function visibilityChanged() { if (doc.hidden) suspend(); }
  function cancelActivation() { activation = null; }
  const options = { capture: true, passive: false };
  for (const type of BLOCKED_EVENTS) {
    screen.addEventListener(type, screenEvent, options);
    overlay.addEventListener(type, overlayEvent, options);
  }
  screen.addEventListener("focusout", focusOut);
  overlay.addEventListener("focusout", cancelActivation);
  doc.addEventListener("pointerdown", outsideInteraction, true);
  doc.addEventListener("focusin", outsideInteraction, true);
  doc.addEventListener("visibilitychange", visibilityChanged);
  win.addEventListener("blur", suspend);

  function detach() {
    if (session) {
      paused = true;
      releaseInput();
    }
    session = null;
    supported = false;
    lastPosition = null;
    activation = null;
    notify();
  }
  return {
    attach(value) {
      if (disposed) return;
      detach();
      session = value;
      supported = compatible(value, version);
      paused = true;
      releaseInput();
      notify();
    },
    setReadOnly(value) {
      readOnly = value === true;
      if (readOnly) suspend();
      notify();
    },
    suspend,
    prepareVirtualInput,
    detach,
    get paused() { return paused; },
    get canControl() { return controlling(); },
    dispose() {
      if (disposed) return;
      detach();
      disposed = true;
      for (const type of BLOCKED_EVENTS) {
        screen.removeEventListener(type, screenEvent, options);
        overlay.removeEventListener(type, overlayEvent, options);
      }
      screen.removeEventListener("focusout", focusOut);
      overlay.removeEventListener("focusout", cancelActivation);
      doc.removeEventListener("pointerdown", outsideInteraction, true);
      doc.removeEventListener("focusin", outsideInteraction, true);
      doc.removeEventListener("visibilitychange", visibilityChanged);
      win.removeEventListener("blur", suspend);
      overlay.remove();
    },
  };
}
