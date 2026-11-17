# Isolated production workspace preview

Run `node tests/vnc-browser-fixture.cjs` from the repository root. Use the
`WORKSPACE_URL` printed by the process. Its path is
`/tests/fixtures/workspace.html`; the port is chosen by the fixture server.

The server reads the current `src/index.html` on every request and loads the
actual production JavaScript, styles, noVNC, input guard, keyboard and xterm.
Only Tauri's `core`, `event` and `window` imports are aliased to
`tauri-workspace.js` by this test server. Production Vite configuration is not
changed, and none of these fixture modules are production entry points.

## Scenarios and actions

| URL query | Initial view / interaction |
| --- | --- |
| None | Three PVE servers. Click **连接** for the synthetic desktop. |
| `?mode=direct` | Three VNC servers. Click **连接** for the same local desktop. |
| `?dense=1` | Eighteen servers per mode; the first has an extra-long mixed Chinese/English name and endpoint for scrolling and truncation checks. Combine with `&mode=direct` for VNC. |
| `?empty` | No servers; use the normal add-server dialog. |
| `?state=connecting` | Click **连接** to hold the pending state; click cancel/disconnect to stop it. |
| `?state=error` | Click **连接** to show a simulated connection error. |
| `?password` | Click **连接** to exercise the normal password dialog. Submit an empty test value. |

Queries can be combined. Connection opens the real noVNC instance against
`ws://127.0.0.1:<same port>/__fixture/rfb?scene=workspace`, performs RFB 3.8
negotiation and receives generated 1024 × 640 desktop pixels. Initial control
is paused. Click the canvas to resume; clicking another local field or blurring
the browser pauses it again. Sidebars, mode switching, virtual keyboard,
read-only settings, dialogs and fullscreen all use production code.

`/__fixture/events` exposes captured RFB input packets for verification.
`POST /__fixture/clear` resets them. These endpoints are also used by the
existing focused input/keyboard fixtures.

## Isolation boundary

- Six fictional `.invalid` hosts (36 with `dense=1`) exist only in memory. Reload resets changes.
- No disk configuration or localStorage is loaded or saved. Typed passwords
  are discarded by the facade and no credential manager exists.
- Every entered VNC/PVE address is ignored by the facade: only the same-origin
  loopback WebSocket is used. There is no TCP proxy or authentication service.
- SSH is never started; clicking it produces an explicit isolated-preview
  message. Its empty terminal and profile UI remain the actual production UI.
- Native titlebar buttons are visible. Maximize toggles only the icon state;
  minimize, close and dragging do nothing to the OS. Real native behavior must
  be checked separately in the desktop application.
- The route's CSP blocks external HTTP/WebSocket resources. The server binds
  only `127.0.0.1`. Generated desktop pixels and mock data stay under `tests/`.

Stop the fixture with Ctrl+C after verification.
