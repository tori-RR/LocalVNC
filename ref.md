# LocalVNC 参考项目与直接依赖

来源核验日期：2026-11-15；文档整理日期：2026-11-18。

以下登记客户端的实现参考、直接依赖及外部系统组件。版本声明与锁定版本分别以依赖清单、`package-lock.json` 和 `src-tauri/Cargo.lock` 为准。

## 参考源码快照

以下为 2026-11-15 核验的上游源码版本；应用依赖版本以锁文件为准。

| 项目 | ref / commit SHA |
| --- | --- |
| TigerVNC | `master` / `ecbab04621580b9c38a54275a925dce47d017801` |
| Tauri | `dev` / `2e23492ab9bcec06bab041e0e47447aaa0da298c` |
| noVNC | `v1.6.0` / `a8dfd6a3ea3c74244f5ebdaa5a7f1023007a7820` |
| xterm.js | `6.0.0` / `f447274f430fd22513f6adbf9862d19524471c04` |
| OpenSSL | `openssl-3.6.3` / `aae016bfd52fcad2bc9657c2c782cfdf73b1ed5f` |
| WezTerm / portable-pty | `main` / `e1eae81a56be8b5487dc77a29616afa568fb57b7` |
| Windows OpenSSH | `latestw_all` / `0172cc6adb99d8b4324b8f0391b5b1fd6f39b2c6` |

## 实现与接口参考

### TigerVNC

- 上游：[TigerVNC/tigervnc](https://github.com/TigerVNC/tigervnc)。
- 地址格式：参考其 `host:display` / `host::port` 使用方式，单冒号后小于 100 的数字按显示编号换算，双冒号表示端口。本地实现：[src-tauri/src/address.rs](src-tauri/src/address.rs)；原有说明：[README.md](README.md)。
- 认证协商：参考 [`CConnection::processSecurityTypesMsg`](https://github.com/TigerVNC/tigervnc/blob/master/common/rfb/CConnection.cxx)，先选择服务器提供且客户端支持的认证类型，再请求所需凭据。本地实现：[src-tauri/src/vencrypt.rs](src-tauri/src/vencrypt.rs) 的 `choose_security` / `negotiate`；LocalVNC 另外保留自己的优先 TLS / 必须 TLS 策略。
- 认证及输入框：参考 [`CSecurityVncAuth`](https://github.com/TigerVNC/tigervnc/blob/master/common/rfb/CSecurityVncAuth.cxx)、[`CSecurityDH`](https://github.com/TigerVNC/tigervnc/blob/master/common/rfb/CSecurityDH.cxx) 和 [`AuthDialog(needsUser, needsPassword)`](https://github.com/TigerVNC/tigervnc/blob/master/vncviewer/AuthDialog.cxx)，按认证要求显示用户名或密码；DH 参数长度边界也用于后端校验。本地实现：[src/main.js](src/main.js)、[src-tauri/src/vencrypt.rs](src-tauri/src/vencrypt.rs)。
- 集成方式：参考协议与交互流程，客户端采用自有 Rust 桥接和 noVNC；TigerVNC Viewer 不嵌入应用。

### Tauri 官方构建示例

- 上游：[tauri-apps/tauri](https://github.com/tauri-apps/tauri)。Tauri 同时也是本项目的直接依赖，包名分别列在后文。
- 具体参考：[`examples/api/src-tauri/build.rs`](https://github.com/tauri-apps/tauri/blob/dev/examples/api/src-tauri/build.rs) 的 Windows manifest 处理方式，使应用与 Cargo 测试 EXE 都嵌入 Common Controls v6 清单，解决测试进程加载 `TaskDialogIndirect` 的问题。
- 本地实现：[src-tauri/build.rs](src-tauri/build.rs)、[src-tauri/windows-app-manifest.xml](src-tauri/windows-app-manifest.xml)。

## 直接依赖

以下逐项对应 [package.json](package.json) 与 [src-tauri/Cargo.toml](src-tauri/Cargo.toml) 的直接声明，包含运行、构建和测试依赖。

### 前端与构建工具

| 包 | 声明版本 | 类型 | 上游 | 具体用途与本地位置 |
| --- | --- | --- | --- | --- |
| `@novnc/novnc` | `1.6.0` | 运行 | [novnc/noVNC](https://github.com/novnc/noVNC) | VNC 画面、键鼠与 ARD 认证；`credentialsrequired.types` 驱动凭据表单。见 [main.js](src/main.js)、[vnc-input.js](src/vnc-input.js)、[virtual-keyboard.js](src/virtual-keyboard.js)。 |
| `@tauri-apps/api` | `^2` | 运行 | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) | 前后端命令、事件、SSH 数据通道与窗口控制。见 [main.js](src/main.js)、[ssh.js](src/ssh.js)、[window-controls.js](src/window-controls.js)。 |
| `@xterm/xterm` | `6.0.0` | 运行 | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) | SSH 终端渲染、键盘输入与二进制输入事件。见 [ssh.js](src/ssh.js)。 |
| `@xterm/addon-fit` | `0.11.0` | 运行 | [xtermjs/xterm.js](https://github.com/xtermjs/xterm.js) | 根据 SSH 面板尺寸调整终端行列数。见 [ssh.js](src/ssh.js)。 |
| `@tauri-apps/cli` | `^2` | 开发／构建 | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) | `npm run tauri` 使用的桌面开发与构建入口。见 [package.json](package.json)。 |
| `vite` | `^6` | 开发／构建 | [vitejs/vite](https://github.com/vitejs/vite) | 前端开发服务与生产打包。见 [vite.config.js](vite.config.js)。 |

noVNC 的版本相关适配另见 [scripts/novnc-compat.mjs](scripts/novnc-compat.mjs)：为 CommonJS 中的异步 WebCodecs 检测提供兼容补丁，继续禁用 H.264。输入释放适配依赖 1.6.0 的内部接口；上游协议实现入口见固定版本的 [`core/rfb.js`](https://github.com/novnc/noVNC/blob/v1.6.0/core/rfb.js)。

### Rust 后端

| crate | 声明版本 | 类型 | 上游 | 具体用途与本地位置 |
| --- | --- | --- | --- | --- |
| `dirs` | `6` | 运行 | [dirs-dev/dirs-rs](https://github.com/dirs-dev/dirs-rs) | 定位 Documents 配置及 PVE CA 目录。见 [lib.rs](src-tauri/src/lib.rs)、[pve_trust.rs](src-tauri/src/pve_trust.rs)。旧元数据链接 `soc/dirs-rs` 已跳转至此；核验时上游已归档。 |
| `futures-util` | `0.3` | 运行 | [rust-lang/futures-rs](https://github.com/rust-lang/futures-rs) | 异步 WebSocket Sink / Stream 操作。见 [bridge.rs](src-tauri/src/bridge.rs)、[vencrypt.rs](src-tauri/src/vencrypt.rs)。 |
| `native-tls` | `0.2` | 运行 | [rust-native-tls/rust-native-tls](https://github.com/rust-native-tls/rust-native-tls) | PVE WSS 的 TLS 连接与证书信任。见 [bridge.rs](src-tauri/src/bridge.rs)。 |
| `openssl` | `0.10`，`vendored` | 运行 | [rust-openssl/rust-openssl](https://github.com/rust-openssl/rust-openssl) | TLSVnc 专用匿名 TLS context、握手与记录处理。见 [tlsanon.rs](src-tauri/src/tlsanon.rs)。 |
| `tokio-openssl` | `0.6` | 运行 | [tokio-rs/tokio-openssl](https://github.com/tokio-rs/tokio-openssl) | 将 OpenSSL TLS 流接入 Tokio 异步 TCP。见 [tlsanon.rs](src-tauri/src/tlsanon.rs)。 |
| `socket2` | `0.6`，`all` | 运行 | [rust-lang/socket2](https://github.com/rust-lang/socket2) | 设置直连 VNC TCP keepalive 参数。见 [bridge.rs](src-tauri/src/bridge.rs)。 |
| `portable-pty` | `0.9` | 运行 | [wezterm/wezterm](https://github.com/wezterm/wezterm) | 创建 PTY／Windows ConPTY，启动和管理 OpenSSH 子进程并调整终端尺寸。见 [ssh.rs](src-tauri/src/ssh.rs)。 |
| `reqwest` | `0.12`，`native-tls` / `json` | 运行 | [seanmonstar/reqwest](https://github.com/seanmonstar/reqwest) | PVE HTTPS 登录、申请 VNC 票据及 API 响应处理。见 [pve.rs](src-tauri/src/pve.rs)。 |
| `serde` | `1`，`derive` | 运行 | [serde-rs/serde](https://github.com/serde-rs/serde) | IPC、配置及网络数据结构的序列化／反序列化。见 [lib.rs](src-tauri/src/lib.rs)、[pve.rs](src-tauri/src/pve.rs)、[ssh.rs](src-tauri/src/ssh.rs)。 |
| `serde_json` | `1` | 运行 | [serde-rs/json](https://github.com/serde-rs/json) | JSON 配置与 PVE API 数据处理。见 [config.rs](src-tauri/src/config.rs)、[pve.rs](src-tauri/src/pve.rs)。 |
| `tauri` | `2` | 运行 | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) | 桌面应用宿主、IPC、窗口和应用状态管理。见 [lib.rs](src-tauri/src/lib.rs)。 |
| `tokio` | `1` | 运行 | [tokio-rs/tokio](https://github.com/tokio-rs/tokio) | 异步 TCP、IO、任务、队列、取消与超时。见 [bridge.rs](src-tauri/src/bridge.rs)、[ssh.rs](src-tauri/src/ssh.rs)、[vencrypt.rs](src-tauri/src/vencrypt.rs)。 |
| `tokio-tungstenite` | `0.26`，`native-tls` | 运行 | [snapview/tokio-tungstenite](https://github.com/snapview/tokio-tungstenite) | 本机 WebSocket 桥接与 PVE WSS 转发。见 [bridge.rs](src-tauri/src/bridge.rs)、[vencrypt.rs](src-tauri/src/vencrypt.rs)。 |
| `urlencoding` | `2` | 运行 | [kornelski/rust_urlencoding](https://github.com/kornelski/rust_urlencoding) | 编码 PVE VNC WebSocket URL 中的票据。见 [pve.rs](src-tauri/src/pve.rs)。 |
| `rand_core` | `0.6`，`getrandom` | 运行 | [rust-random/rand](https://github.com/rust-random/rand) | 从系统随机源生成桥接令牌与临时标识。见 [error.rs](src-tauri/src/error.rs)。 |
| `sha2` | `0.10` | 运行 | [RustCrypto/hashes](https://github.com/RustCrypto/hashes) | 对规范化 PVE HTTPS origin 做 SHA-256，定位端点 CA 文件。见 [pve_trust.rs](src-tauri/src/pve_trust.rs)。 |
| `windows` | `0.62` | 运行 | [microsoft/windows-rs](https://github.com/microsoft/windows-rs) | Windows 凭据管理器、配置文件替换及系统 API。见 [secrets.rs](src-tauri/src/secrets.rs)、[config.rs](src-tauri/src/config.rs)、[ssh.rs](src-tauri/src/ssh.rs)。 |
| `tauri-build` | `2` | 构建 | [tauri-apps/tauri](https://github.com/tauri-apps/tauri) | 生成 Tauri 构建资源并配置 Windows manifest。见 [build.rs](src-tauri/build.rs)。 |
| `openssl-sys` | `0.9` | 测试 | [rust-openssl/rust-openssl](https://github.com/rust-openssl/rust-openssl) | 构造准确的 OpenSSL 引擎错误码，验证可恢复传输错误和终止性 TLS 错误的分类。见 [tlsanon.rs](src-tauri/src/tlsanon.rs)。 |

原生 TLS 引擎的上游为 [openssl/openssl](https://github.com/openssl/openssl)。它由 `openssl` 的 `vendored` feature 经间接依赖 `openssl-src` 编译并静态链接；原生引擎与上表的 Rust 绑定分别标注。仓库附带的许可文本见 [licenses/OpenSSL.txt](licenses/OpenSSL.txt)。

## 外部系统组件

| 项目 | 上游 | 调用方式与本地位置 |
| --- | --- | --- |
| Windows OpenSSH | [源码：PowerShell/openssh-portable](https://github.com/PowerShell/openssh-portable)；[发布与 Wiki：PowerShell/Win32-OpenSSH](https://github.com/PowerShell/Win32-OpenSSH) | 调用系统安装的 `OpenSSH/ssh.exe`；认证、主机指纹、密钥和 SSH 配置交由该客户端处理。见 [ssh.rs](src-tauri/src/ssh.rs)。上游 Win32-OpenSSH README 指向 openssh-portable 作为实际开发源码。 |
