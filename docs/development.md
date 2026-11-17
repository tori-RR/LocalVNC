# 开发与验证

匿名 TLS 的 vendored OpenSSL 首次编译需要原生 Windows Perl 与 MSVC Build Tools。可在当前构建进程中用 `OPENSSL_SRC_PERL` 指定可移植 Strawberry Perl；不需要安装 OpenSSL DLL 或修改系统信任。依赖版本固定在 Cargo.lock。OpenSSL 许可见 [许可证](../licenses/OpenSSL.txt)。

```powershell
npm test
npm run build
cd src-tauri
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --lib
cargo build --locked
```

前端测试只使用假的 DOM、Tauri、RFB 和凭据接口。Rust 测试仅使用临时目录与本机随机端口；默认不连接内网主机、不读取真实密码、不修改 Documents 配置。SSH 冒烟测试调用本机 OpenSSH / ConPTY，验证版本输出、回环握手、输入、调整尺寸及取消回收，回环测试不读取用户 SSH 配置；完整远端登录尚需真实服务器联调。凭据管理器集成测试需要显式选择运行，使用随机测试标识并自动清理。

浏览器输入联调可运行 `node tests/vnc-browser-fixture.cjs`，访问输出地址同端口的 `/tests/fixtures/virtual-keyboard.html`。它用真实 noVNC 连接本机合成 RFB，显示实际键鼠包，便于检查展开零发包、组合键释放、失焦禁用与全屏布局；不连接真实主机。测试服务器忽略 Rust 和前端构建目录，避免 Windows 链接 EXE 时触发文件监视冲突。

Windows MSVC 构建会为应用与测试 EXE 嵌入 Common Controls v6 清单，避免测试启动时出现 `TaskDialogIndirect` / `0xc0000139`。实现参考 [Tauri 官方测试构建方式](https://github.com/tauri-apps/tauri/blob/dev/examples/api/src-tauri/build.rs)。

noVNC 1.6.0 的 CommonJS 文件包含异步 WebCodecs 检测，现有兼容补丁继续禁用 H.264；开发预打包和生产构建使用同一个补丁，匹配不再唯一时会直接失败。升级 noVNC 后必须重新评估该补丁。
