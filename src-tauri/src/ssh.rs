//! An independent terminal around the installed Windows OpenSSH client.
//! Authentication and host-key confirmation stay inside OpenSSH's terminal.

use crate::error::AppError;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot, watch};

const OUTPUT_CHUNK: usize = 16 * 1024;
const OUTPUT_WINDOW: usize = 256 * 1024;
const INPUT_LIMIT: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshRequest {
    pub session_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshEvent {
    session_id: String,
    kind: EventKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
enum EventKind {
    Data,
    Exit,
    Error,
}

fn error(code: &'static str, message: &str) -> AppError {
    AppError::new("ssh", code, message)
}

fn terminal_size(cols: u16, rows: u16) -> Result<PtySize, AppError> {
    if !(1..=1000).contains(&cols) || !(1..=500).contains(&rows) {
        return Err(error("invalid_size", "终端尺寸无效"));
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}

impl SshRequest {
    fn validate(&self) -> Result<(), AppError> {
        if self.session_id.len() != 36
            || !self.session_id.bytes().enumerate().all(|(index, byte)| {
                if [8, 13, 18, 23].contains(&index) {
                    byte == b'-'
                } else {
                    byte.is_ascii_hexdigit()
                }
            })
        {
            return Err(error("invalid_session", "SSH 会话标识无效"));
        }
        let host_valid = self.host.parse::<std::net::IpAddr>().is_ok()
            || (!self.host.is_empty()
                && self.host.len() <= 253
                && self.host.as_bytes()[0].is_ascii_alphanumeric()
                && self.host.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_')
                }));
        if !host_valid || self.port == 0 {
            return Err(error("invalid_address", "请输入有效的 SSH 主机和端口"));
        }
        if self.username.is_empty()
            || self.username.len() > 128
            || self.username.starts_with('-')
            || !self.username.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'\\' | b'@')
            })
        {
            return Err(error("invalid_username", "SSH 用户名格式无效"));
        }
        terminal_size(self.cols, self.rows)?;
        Ok(())
    }
}

fn ssh_executable() -> Result<PathBuf, AppError> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
        let mut buffer = [0u16; 32768];
        let length = unsafe { GetSystemDirectoryW(Some(&mut buffer)) } as usize;
        if length == 0 || length >= buffer.len() {
            return Err(error("ssh_unavailable", "无法定位 Windows 系统目录"));
        }
        let executable = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length]))
            .join("OpenSSH")
            .join("ssh.exe");
        if !executable.is_file() {
            return Err(error(
                "ssh_unavailable",
                "未找到系统 OpenSSH 客户端，请在 Windows 可选功能中安装 OpenSSH 客户端",
            ));
        }
        Ok(executable)
    }
    #[cfg(not(windows))]
    Err(error("ssh_unavailable", "SSH 终端当前仅支持 Windows"))
}

fn ssh_command(executable: PathBuf, request: &SshRequest) -> CommandBuilder {
    let mut command = CommandBuilder::new(executable);
    // These are individual argv entries; no shell or remote command is involved.
    // Keep known_hosts checks interactive even if a user's SSH config is permissive.
    command.args([
        "-tt",
        "-o",
        "StrictHostKeyChecking=ask",
        "-o",
        "BatchMode=no",
        "-o",
        "ConnectTimeout=15",
        "-o",
        "ConnectionAttempts=1",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "RemoteCommand=none",
        "-o",
        "EscapeChar=none",
        "-p",
        &request.port.to_string(),
        "-l",
        &request.username,
        "--",
        &request.host,
    ]);
    command.env("TERM", "xterm-256color");
    command.env("SSH_ASKPASS_REQUIRE", "never");
    command.env_remove("SSH_ASKPASS");
    command
}

#[derive(Default)]
struct FlowState {
    pending: usize,
    cancelled: bool,
}

#[derive(Default)]
struct OutputFlow {
    state: Mutex<FlowState>,
    changed: Condvar,
}

impl OutputFlow {
    fn reserve(&self, count: usize) -> bool {
        let mut state = self.state.lock().unwrap();
        while !state.cancelled && state.pending + count > OUTPUT_WINDOW {
            state = self.changed.wait(state).unwrap();
        }
        if state.cancelled {
            return false;
        }
        state.pending += count;
        true
    }

    fn acknowledge(&self, count: usize) -> Result<(), AppError> {
        let mut state = self.state.lock().unwrap();
        if count > state.pending {
            return Err(error("invalid_ack", "终端输出确认无效"));
        }
        state.pending -= count;
        self.changed.notify_all();
        Ok(())
    }

    fn cancel(&self) {
        self.state.lock().unwrap().cancelled = true;
        self.changed.notify_all();
    }
}

struct Input {
    data: Vec<u8>,
    reply: oneshot::Sender<Result<(), AppError>>,
}

struct Session {
    id: String,
    cancel: watch::Sender<bool>,
    flow: OutputFlow,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    input: Mutex<Option<mpsc::Sender<Input>>>,
    done: (Mutex<bool>, Condvar),
}

impl Session {
    fn new(id: String) -> Self {
        let (cancel, _) = watch::channel(false);
        Self {
            id,
            cancel,
            flow: OutputFlow::default(),
            killer: Mutex::new(None),
            master: Mutex::new(None),
            input: Mutex::new(None),
            done: (Mutex::new(false), Condvar::new()),
        }
    }

    fn cancelled(&self) -> bool {
        *self.cancel.borrow()
    }

    fn stop(&self) {
        self.cancel.send_replace(true);
        self.flow.cancel();
        self.input.lock().unwrap().take();
        if let Some(killer) = self.killer.lock().unwrap().as_mut() {
            let _ = killer.kill();
        }
    }

    fn event(&self, kind: EventKind, data: Option<Vec<u8>>, message: Option<String>) -> SshEvent {
        SshEvent {
            session_id: self.id.clone(),
            kind,
            data,
            message,
        }
    }

    fn finish(&self) {
        self.input.lock().unwrap().take();
        self.killer.lock().unwrap().take();
        *self.done.0.lock().unwrap() = true;
        self.done.1.notify_all();
    }
}

#[derive(Default)]
pub struct SshManager {
    current: Mutex<Option<Arc<Session>>>,
}

impl SshManager {
    fn reserve(&self, id: String) -> Arc<Session> {
        let session = Arc::new(Session::new(id));
        let previous = self.current.lock().unwrap().replace(session.clone());
        if let Some(previous) = previous {
            previous.stop();
        }
        session
    }

    fn get(&self, id: &str) -> Result<Arc<Session>, AppError> {
        self.current
            .lock()
            .unwrap()
            .as_ref()
            .filter(|session| session.id == id && !session.cancelled())
            .cloned()
            .ok_or_else(AppError::cancelled)
    }

    pub async fn connect(
        &self,
        request: SshRequest,
        events: Channel<SshEvent>,
    ) -> Result<(), AppError> {
        request.validate()?;
        let executable = ssh_executable()?;
        let session = self.reserve(request.session_id.clone());
        let session_for_spawn = session.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            spawn_session(session_for_spawn, request, executable, events)
        })
        .await
        .map_err(|_| error("start_failed", "SSH 终端启动失败"))
        .and_then(|result| result);
        if result.is_err() {
            session.stop();
            session.finish();
        }
        result
    }

    pub async fn write(&self, id: &str, data: Vec<u8>) -> Result<(), AppError> {
        if data.len() > INPUT_LIMIT {
            return Err(error("input_too_large", "单次终端输入过大，请分段粘贴"));
        }
        let session = self.get(id)?;
        let sender = session
            .input
            .lock()
            .unwrap()
            .as_ref()
            .cloned()
            .ok_or_else(|| error("not_ready", "SSH 终端尚未就绪"))?;
        let mut cancelled = session.cancel.subscribe();
        let (reply, received) = oneshot::channel();
        tokio::select! {
            biased;
            _ = cancelled.changed() => Err(AppError::cancelled()),
            result = async {
                if session.cancelled() { return Err(AppError::cancelled()); }
                sender.send(Input { data, reply }).await.map_err(|_| AppError::cancelled())?;
                received.await.map_err(|_| AppError::cancelled())?
            } => result,
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), AppError> {
        let size = terminal_size(cols, rows)?;
        let session = self.get(id)?;
        let master = session.master.lock().unwrap();
        master
            .as_ref()
            .ok_or_else(AppError::cancelled)?
            .resize(size)
            .map_err(|_| error("resize_failed", "无法调整终端尺寸"))
    }

    pub fn acknowledge(&self, id: &str, count: usize) -> Result<(), AppError> {
        self.get(id)?.flow.acknowledge(count)
    }

    pub fn disconnect(&self, id: &str) {
        let session = {
            let mut current = self.current.lock().unwrap();
            if current.as_ref().is_some_and(|session| session.id == id) {
                current.take()
            } else {
                None
            }
        };
        if let Some(session) = session {
            session.stop();
        }
    }

    pub fn shutdown(&self) {
        if let Some(session) = self.current.lock().unwrap().take() {
            session.stop();
            // Kill first; the reaper closes ConPTY while its separate reader drains.
            // A bounded wait keeps window shutdown responsive even if Windows stalls.
            let done = session.done.0.lock().unwrap();
            let _ = session
                .done
                .1
                .wait_timeout_while(done, Duration::from_secs(2), |done| !*done);
        }
    }
}

impl Drop for SshManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn spawn_session(
    session: Arc<Session>,
    request: SshRequest,
    executable: PathBuf,
    events: Channel<SshEvent>,
) -> Result<(), AppError> {
    spawn_terminal(
        session,
        ssh_command(executable, &request),
        terminal_size(request.cols, request.rows)?,
        events,
    )
}

fn spawn_terminal(
    session: Arc<Session>,
    command: CommandBuilder,
    size: PtySize,
    events: Channel<SshEvent>,
) -> Result<(), AppError> {
    if session.cancelled() {
        return Err(AppError::cancelled());
    }
    let pair = native_pty_system().openpty(size).map_err(|_| {
        error(
            "pty_unavailable",
            "无法创建终端，需要 Windows 10 1809 或更新版本",
        )
    })?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|_| error("start_failed", "无法读取终端输出"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|_| error("start_failed", "无法创建终端输入"))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|_| error("start_failed", "无法启动系统 OpenSSH 客户端"))?;
    drop(pair.slave);
    *session.killer.lock().unwrap() = Some(child.clone_killer());
    *session.master.lock().unwrap() = Some(pair.master);
    let (sender, mut receiver) = mpsc::channel::<Input>(4);
    *session.input.lock().unwrap() = Some(sender);

    let writing = session.clone();
    std::thread::spawn(move || {
        while let Some(input) = receiver.blocking_recv() {
            if writing.cancelled() {
                let _ = input.reply.send(Err(AppError::cancelled()));
                break;
            }
            let result = writer
                .write_all(&input.data)
                .and_then(|_| writer.flush())
                .map_err(|_| error("input_failed", "SSH 终端已无法接收输入"));
            let failed = result.is_err();
            let _ = input.reply.send(result);
            if failed {
                writing.stop();
                break;
            }
        }
    });

    let reading = session.clone();
    let read_events = events.clone();
    let reader_thread = std::thread::spawn(move || {
        let mut buffer = [0u8; OUTPUT_CHUNK];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if !reading.flow.reserve(count) {
                        // Continue draining until ClosePseudoConsole completes: stopping
                        // the pipe reader early can deadlock ConPTY shutdown on Windows.
                        continue;
                    }
                    let event =
                        reading.event(EventKind::Data, Some(buffer[..count].to_vec()), None);
                    if read_events.send(event).is_err() {
                        reading.stop();
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => {
                    if !reading.cancelled() {
                        let _ = read_events.send(reading.event(
                            EventKind::Error,
                            None,
                            Some("SSH 终端输出中断".into()),
                        ));
                        reading.stop();
                    }
                    break;
                }
            }
        }
    });

    let reaping = session.clone();
    std::thread::spawn(move || {
        let result = child.wait();
        reaping.input.lock().unwrap().take();
        // ClosePseudoConsole can wait for output to drain; never hold the manager
        // lock or perform this drop on Tauri's UI thread.
        let master = reaping.master.lock().unwrap().take();
        drop(master);
        let _ = reader_thread.join();
        if !reaping.cancelled() {
            let (kind, message) = match result {
                Ok(status) => (
                    EventKind::Exit,
                    format!("SSH 会话已结束（退出码 {}）", status.exit_code()),
                ),
                Err(_) => (EventKind::Error, "无法读取 SSH 进程退出状态".into()),
            };
            let _ = events.send(reaping.event(kind, None, Some(message)));
        }
        reaping.finish();
    });
    // A disconnect or newer reservation may have arrived while creating ConPTY.
    if session.cancelled() {
        session.stop();
        return Err(AppError::cancelled());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn input_queue_preserves_binary_ipc_bytes_and_rejects_oversized_writes() {
        let manager = SshManager::default();
        let session = manager.reserve("byte-test".into());
        let (sender, mut receiver) = mpsc::channel::<Input>(4);
        *session.input.lock().unwrap() = Some(sender);
        let bytes: Vec<u8> = serde_json::from_str("[27,91,77,32,128,255,0]").unwrap();
        let expected = bytes.clone();
        let reading = async {
            let input = receiver.recv().await.unwrap();
            assert_eq!(input.data, expected);
            input.reply.send(Ok(())).unwrap();
        };
        let (written, ()) = tokio::join!(manager.write(&session.id, bytes), reading);
        written.unwrap();
        assert_eq!(
            manager
                .write(&session.id, vec![255; INPUT_LIMIT + 1])
                .await
                .unwrap_err()
                .code,
            "input_too_large"
        );
        assert!(!session.cancelled());
        session.stop();
    }

    fn request() -> SshRequest {
        SshRequest {
            session_id: "12345678-abcd-1234-abcd-123456789abc".into(),
            host: "test.invalid".into(),
            port: 22,
            username: "test-user".into(),
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn rejects_option_shell_and_control_character_injection() {
        for host in [
            "-oProxyCommand=calc",
            "user@host",
            "host;calc",
            "a\r\nb",
            "a b",
            "",
        ] {
            let mut request = request();
            request.host = host.into();
            assert!(request.validate().is_err(), "{host:?}");
        }
        for username in ["-o", "user\nname", "user name", "a\"b", "a;calc", ""] {
            let mut request = request();
            request.username = username.into();
            assert!(request.validate().is_err(), "{username:?}");
        }
        for host in ["test.invalid", "192.0.2.1", "2001:db8::1"] {
            let mut request = request();
            request.host = host.into();
            assert!(request.validate().is_ok());
        }
        let command = ssh_command(
            PathBuf::from("C:\\Windows\\System32\\OpenSSH\\ssh.exe"),
            &request(),
        );
        let argv = command.get_argv();
        assert_eq!(argv[argv.len() - 2], "--");
        assert_eq!(argv[argv.len() - 1], "test.invalid");
        assert!(argv.iter().any(|arg| arg == "StrictHostKeyChecking=ask"));
    }

    #[test]
    fn bounds_size_input_identity_and_flow_acknowledgements() {
        assert!(terminal_size(0, 24).is_err());
        assert!(terminal_size(80, 501).is_err());
        let mut request = request();
        request.session_id = "not-a-uuid".into();
        assert!(request.validate().is_err());
        let flow = OutputFlow::default();
        assert!(flow.reserve(20));
        assert!(flow.acknowledge(21).is_err());
        assert!(flow.acknowledge(20).is_ok());
        assert_eq!(flow.state.lock().unwrap().pending, 0);
    }

    #[test]
    fn cancellation_unblocks_output_backpressure() {
        let flow = Arc::new(OutputFlow::default());
        assert!(flow.reserve(OUTPUT_WINDOW));
        let waiting = flow.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || sender.send(waiting.reserve(1)).unwrap());
        assert!(receiver.recv_timeout(Duration::from_millis(30)).is_err());
        flow.cancel();
        assert!(!receiver.recv_timeout(Duration::from_secs(1)).unwrap());
        thread.join().unwrap();
    }

    #[test]
    fn stale_disconnect_cannot_cancel_new_ssh_session() {
        let manager = SshManager::default();
        let first = manager.reserve("first".into());
        let second = manager.reserve("second".into());
        assert!(first.cancelled());
        manager.disconnect("first");
        assert!(!second.cancelled());
        manager.disconnect("second");
        assert!(second.cancelled());
    }

    #[cfg(windows)]
    fn test_events(
        session: Arc<Session>,
    ) -> (
        Channel<SshEvent>,
        std::sync::mpsc::Receiver<serde_json::Value>,
    ) {
        let (sender, receiver) = std::sync::mpsc::channel();
        let channel = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(json) = body else {
                panic!("expected JSON event");
            };
            let event: serde_json::Value = serde_json::from_str(&json).unwrap();
            if let Some(data) = event["data"].as_array() {
                let data: Vec<u8> = data
                    .iter()
                    .map(|byte| byte.as_u64().unwrap() as u8)
                    .collect();
                session.flow.acknowledge(data.len()).unwrap();
                // The in-app xterm responds to ConPTY's initial cursor query.
                // This headless fixture supplies that terminal response itself.
                if data.windows(4).any(|bytes| bytes == b"\x1b[6n") {
                    let (reply, _) = oneshot::channel();
                    if let Some(input) = session.input.lock().unwrap().as_ref() {
                        let _ = input.try_send(Input {
                            data: "\x1b[1;1R".into(),
                            reply,
                        });
                    }
                }
            }
            let _ = sender.send(event);
            Ok(())
        });
        (channel, receiver)
    }

    #[cfg(windows)]
    #[test]
    fn system_openssh_runs_inside_conpty_and_reaps() {
        let manager = SshManager::default();
        let session = manager.reserve(request().session_id);
        let (events, received) = test_events(session.clone());
        let mut command = CommandBuilder::new(ssh_executable().unwrap());
        command.arg("-V");
        spawn_terminal(session.clone(), command, PtySize::default(), events).unwrap();
        let mut output = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let event = received
                .recv_timeout(remaining)
                .expect("OpenSSH terminal must exit");
            if let Some(data) = event["data"].as_array() {
                output.extend(data.iter().map(|byte| byte.as_u64().unwrap() as u8));
            }
            if event["kind"] == "exit" {
                assert!(event["message"].as_str().unwrap().contains('0'));
                break;
            }
        }
        assert!(String::from_utf8_lossy(&output).contains("OpenSSH"));
        let done = session.done.0.lock().unwrap();
        let (done, _) = session
            .done
            .1
            .wait_timeout_while(done, Duration::from_secs(2), |done| !*done)
            .unwrap();
        assert!(*done, "OpenSSH child must be reaped");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn cancelling_loopback_handshake_reaps_child_without_remote_credentials() {
        use std::io::{BufRead, BufReader};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let (accepted, accepted_rx) = std::sync::mpsc::channel();
        let server = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            let mut socket = loop {
                if let Ok((socket, _)) = listener.accept() {
                    break socket;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "SSH must connect to loopback"
                );
                std::thread::sleep(Duration::from_millis(10));
            };
            // Windows sockets inherit the listener's non-blocking mode, which
            // would turn the banner read into an immediate WouldBlock.
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            socket
                .write_all(b"SSH-2.0-LocalVNC-Loopback-Test\r\n")
                .unwrap();
            let mut socket = BufReader::new(socket);
            let mut banner = String::new();
            socket.read_line(&mut banner).unwrap();
            accepted.send(banner).unwrap();
            let mut bytes = [0; 1024];
            while matches!(socket.read(&mut bytes), Ok(count) if count > 0) {}
        });
        let manager = SshManager::default();
        let mut request = request();
        request.host = "127.0.0.1".into();
        request.port = port;
        let session = manager.reserve(request.session_id.clone());
        let (events, _) = test_events(session.clone());
        let mut command = ssh_command(ssh_executable().unwrap(), &request);
        // Ignore real user SSH config in this synthetic loopback fixture.
        command.get_argv_mut().insert(1, "-F".into());
        command.get_argv_mut().insert(2, "NUL".into());
        spawn_terminal(session.clone(), command, PtySize::default(), events).unwrap();
        assert!(accepted_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap()
            .starts_with("SSH-2.0-"));
        manager.resize(&session.id, 100, 32).unwrap();
        manager.write(&session.id, "\r".into()).await.unwrap();
        manager.disconnect(&session.id);
        let done = session.done.0.lock().unwrap();
        let (done, _) = session
            .done
            .1
            .wait_timeout_while(done, Duration::from_secs(5), |done| !*done)
            .unwrap();
        assert!(*done, "cancel must kill and reap the OpenSSH process");
        server.join().unwrap();
    }
}
