use crate::{
    error::{random_token, AppError},
    vencrypt::SecurityPolicy,
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{watch, Semaphore},
};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    handshake::server::{ErrorResponse, Request, Response},
    http::{HeaderValue, StatusCode},
    protocol::WebSocketConfig,
    Message,
};
use tokio_tungstenite::{
    accept_hdr_async_with_config, connect_async_tls_with_config, Connector, WebSocketStream,
};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);

pub struct RunningBridge {
    pub port: u16,
    token: String,
    cancel: watch::Sender<bool>,
}

impl RunningBridge {
    pub fn stop(&self) {
        let _ = self.cancel.send(true);
    }
    pub fn local_url(&self) -> String {
        format!("ws://127.0.0.1:{}/session/{}", self.port, self.token)
    }
}
impl Drop for RunningBridge {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone)]
enum Upstream {
    Vnc {
        host: String,
        port: u16,
        policy: SecurityPolicy,
    },
    Pve {
        url: String,
        cookie: String,
        insecure: bool,
        trusted_ca: Option<Vec<u8>>,
    },
}

#[derive(Clone)]
struct Context {
    app: Option<AppHandle>,
    session_id: String,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionError<'a> {
    session_id: &'a str,
    #[serde(flatten)]
    error: AppError,
}

pub async fn serve_vnc(
    app: Option<AppHandle>,
    session_id: String,
    host: String,
    port: u16,
    policy: SecurityPolicy,
) -> Result<RunningBridge, AppError> {
    if port == 0 || host.trim().is_empty() || host.chars().any(|ch| ch.is_whitespace() || ch == '/')
    {
        return Err(AppError::new(
            "address",
            "invalid_address",
            "VNC 主机或端口不正确",
        ));
    }
    serve(
        Upstream::Vnc { host, port, policy },
        Context { app, session_id },
    )
    .await
}

pub async fn serve_pve(
    app: Option<AppHandle>,
    session_id: String,
    url: String,
    cookie: String,
    insecure: bool,
    trusted_ca: Option<Vec<u8>>,
) -> Result<RunningBridge, AppError> {
    serve(
        Upstream::Pve {
            url,
            cookie,
            insecure,
            trusted_ca,
        },
        Context { app, session_id },
    )
    .await
}

async fn serve(upstream: Upstream, context: Context) -> Result<RunningBridge, AppError> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| AppError::new("bridge", "bind", "本机通道没有打开"))?;
    let port = listener
        .local_addr()
        .map_err(|_| AppError::new("bridge", "bind", "本机通道没有打开"))?
        .port();
    let token = random_token();
    let (cancel, rx) = watch::channel(false);
    tokio::spawn(accept_loop(
        listener,
        rx,
        upstream,
        context,
        format!("/session/{token}"),
    ));
    Ok(RunningBridge {
        port,
        token,
        cancel,
    })
}

fn allowed_origin(origin: &str) -> bool {
    matches!(
        origin,
        "http://tauri.localhost" | "https://tauri.localhost" | "tauri://localhost"
    ) || (cfg!(debug_assertions) && origin == "http://127.0.0.1:1420")
}

#[allow(clippy::result_large_err)]
fn authorize(request: &Request, response: Response, path: &str) -> Result<Response, ErrorResponse> {
    let origin = request
        .headers()
        .get("Origin")
        .and_then(|value| value.to_str().ok());
    if request.uri().path() != path
        || request.uri().query().is_some()
        || !origin.is_some_and(allowed_origin)
    {
        let mut rejected = ErrorResponse::new(Some("Forbidden".to_string()));
        *rejected.status_mut() = StatusCode::FORBIDDEN;
        return Err(rejected);
    }
    Ok(response)
}

#[allow(clippy::result_large_err)] // Required tungstenite handshake callback signature.
async fn accept_loop(
    listener: TcpListener,
    mut cancel: watch::Receiver<bool>,
    upstream: Upstream,
    context: Context,
    path: String,
) {
    let pending = Arc::new(Semaphore::new(4));
    let active = Arc::new(Semaphore::new(1));
    loop {
        tokio::select! {
            biased;
            _ = cancel.changed() => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { break; };
                let Ok(permit) = pending.clone().try_acquire_owned() else { continue; };
                let (upstream, context, path, active) = (upstream.clone(), context.clone(), path.clone(), active.clone());
                let mut cancelled = cancel.clone();
                tokio::spawn(async move {
                    if *cancelled.borrow() { return; }
                    tokio::select! {
                        biased;
                        _ = cancelled.changed() => {},
                        _ = async {
                            let _ = stream.set_nodelay(true);
                            let mut config = WebSocketConfig::default();
                            config.max_message_size = Some(1024 * 1024);
                            config.max_frame_size = Some(1024 * 1024);
                            let handshake = accept_hdr_async_with_config(stream,
                                |request: &Request, response: Response| authorize(request, response, &path), Some(config));
                            let result = tokio::time::timeout(HANDSHAKE_TIMEOUT, handshake).await;
                            drop(permit);
                            let Ok(Ok(mut socket)) = result else { return; };
                            let Ok(_slot) = active.try_acquire_owned() else { return; };
                            if let Err(error) = proxy_one(&mut socket, upstream).await {
                                if let Some(app) = &context.app {
                                    let _ = app.emit("vnc-error", SessionError { session_id: &context.session_id, error });
                                    // Keep the local transport alive while the scoped error is
                                    // delivered; the UI's disconnect cancels this task.
                                    let _ = tokio::time::timeout(Duration::from_secs(1), socket.next()).await;
                                }
                            }
                        } => {},
                    }
                });
            }
        }
    }
}

async fn proxy_one(
    local: &mut WebSocketStream<TcpStream>,
    upstream: Upstream,
) -> Result<(), AppError> {
    match upstream {
        Upstream::Vnc { host, port, policy } => {
            let remote = tokio::time::timeout(
                Duration::from_secs(10),
                TcpStream::connect((host.as_str(), port)),
            )
            .await
            .map_err(|_| AppError::new("tcp", "timeout", "连接 VNC 服务超时"))?
            .map_err(|_| AppError::new("tcp", "connect", "连接 VNC 服务失败"))?;
            configure_vnc_socket(&remote)?;
            crate::vencrypt::run(local, remote, policy).await
        }
        Upstream::Pve {
            url,
            cookie,
            insecure,
            trusted_ca,
        } => {
            let remote = connect_pve(&url, &cookie, insecure, trusted_ca.as_deref()).await?;
            join_ws(local, remote)
                .await
                .map_err(|_| AppError::new("websocket", "transport", "PVE 控制台传输中断"))
        }
    }
}

fn configure_vnc_socket(socket: &TcpStream) -> Result<(), AppError> {
    let fail = || AppError::new("tcp", "socket_options", "无法设置 VNC 连接活性检测");
    socket.set_nodelay(true).map_err(|_| fail())?;
    socket2::SockRef::from(socket)
        .set_tcp_keepalive(
            &socket2::TcpKeepalive::new()
                .with_time(Duration::from_secs(15))
                .with_interval(Duration::from_secs(5))
                .with_retries(3),
        )
        .map_err(|_| fail())
}

pub(crate) async fn connect_pve(
    url: &str,
    cookie: &str,
    insecure: bool,
    trusted_ca: Option<&[u8]>,
) -> Result<WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>, AppError> {
    let fail = || {
        AppError::new(
            "websocket",
            "connect",
            "PVE 控制台连接失败，请检查网络、票据权限及证书信任",
        )
    };
    let mut request = url.into_client_request().map_err(|_| fail())?;
    request.headers_mut().insert(
        "Cookie",
        HeaderValue::from_str(&format!("PVEAuthCookie={cookie}")).map_err(|_| fail())?,
    );
    let connector = if insecure || trusted_ca.is_some() {
        let mut builder = native_tls::TlsConnector::builder();
        builder
            .danger_accept_invalid_certs(insecure)
            .danger_accept_invalid_hostnames(insecure);
        if let Some(pem) = trusted_ca {
            builder
                .add_root_certificate(native_tls::Certificate::from_pem(pem).map_err(|_| fail())?);
        }
        let tls = builder.build().map_err(|_| fail())?;
        Some(Connector::NativeTls(tls))
    } else {
        None
    };
    let (socket, _) = tokio::time::timeout(
        Duration::from_secs(15),
        connect_async_tls_with_config(request, None, true, connector),
    )
    .await
    .map_err(|_| AppError::new("websocket", "timeout", "连接 PVE 控制台超时"))?
    .map_err(|_| fail())?;
    Ok(socket)
}

// Each direction has its own pump. Slow frame delivery does not stall keyboard input.
async fn join_ws<S>(
    local: &mut WebSocketStream<TcpStream>,
    remote: WebSocketStream<S>,
) -> Result<(), ()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut local_sink, mut local_stream) = local.split();
    let (mut remote_sink, mut remote_stream) = remote.split();
    let up = async {
        while let Some(message) = local_stream.next().await {
            let message = message.map_err(|_| ())?;
            match message {
                Message::Close(_) => break,
                Message::Text(_) => return Err(()),
                Message::Binary(_) | Message::Ping(_) | Message::Pong(_) => {
                    remote_sink.send(message).await.map_err(|_| ())?
                }
                _ => {}
            }
        }
        Ok(())
    };
    let down = async {
        while let Some(message) = remote_stream.next().await {
            let message = message.map_err(|_| ())?;
            if matches!(message, Message::Close(_)) {
                break;
            }
            local_sink.send(message).await.map_err(|_| ())?;
        }
        Ok(())
    };
    tokio::select! { result = up => result, result = down => result }
}

pub async fn join_tcp(
    local: &mut WebSocketStream<TcpStream>,
    remote: TcpStream,
) -> Result<(), String> {
    let (mut sink, mut stream) = local.split();
    let (mut reader, mut writer) = remote.into_split();
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let reply = tx.clone();
    let up = async move {
        while let Some(message) = stream.next().await {
            match message.map_err(|_| "画面通道中断")? {
                Message::Binary(data) => {
                    writer.write_all(&data).await.map_err(|_| "VNC 传输中断")?
                }
                Message::Ping(data) => {
                    reply
                        .send(Message::Pong(data))
                        .await
                        .map_err(|_| "画面通道中断")?;
                }
                Message::Text(_) => return Err("画面通道只接受二进制数据".to_string()),
                Message::Close(_) => break,
                _ => {}
            }
        }
        Ok::<(), String>(())
    };
    let down = async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let count = reader.read(&mut buf).await.map_err(|_| "VNC 传输中断")?;
            if count == 0 {
                tx.send(Message::Close(None))
                    .await
                    .map_err(|_| "画面通道中断")?;
                break;
            }
            tx.send(Message::Binary(buf[..count].to_vec().into()))
                .await
                .map_err(|_| "画面通道中断")?;
        }
        Ok::<(), String>(())
    };
    let output = async move {
        while let Some(message) = rx.recv().await {
            let closed = matches!(message, Message::Close(_));
            sink.send(message).await.map_err(|_| "画面通道中断")?;
            if closed {
                break;
            }
        }
        Ok::<(), String>(())
    };
    tokio::select! {
        result = up => result,
        result = async { tokio::try_join!(down, output).map(|_| ()) } => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn direct_socket_enables_keepalive_without_application_traffic_or_false_idle_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap())
            .await
            .unwrap();
        let (mut remote, _) = listener.accept().await.unwrap();
        configure_vnc_socket(&client).unwrap();
        let socket = socket2::SockRef::from(&client);
        assert!(socket.keepalive().unwrap());
        assert!(client.nodelay().unwrap());
        assert_eq!(socket.tcp_keepalive_retries().unwrap(), 3);
        // A quiet application is still a healthy connection. No synthetic
        // heartbeat bytes or read timeout may be inserted into the RFB stream.
        assert!(
            tokio::time::timeout(Duration::from_millis(40), remote.read_u8())
                .await
                .is_err()
        );
        client.writable().await.unwrap();
        client.try_write(&[0x42]).unwrap();
        assert_eq!(remote.read_u8().await.unwrap(), 0x42);
    }
    fn request(url: String, origin: &str) -> tokio_tungstenite::tungstenite::http::Request<()> {
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Origin", HeaderValue::from_str(origin).unwrap());
        request
    }
    #[tokio::test]
    async fn rejects_wrong_token_and_origin_without_consuming_the_session() {
        let bridge = serve_vnc(
            None,
            "test".into(),
            "127.0.0.1".into(),
            1,
            SecurityPolicy::PreferTls,
        )
        .await
        .unwrap();
        for (url, origin) in [
            (
                format!("ws://127.0.0.1:{}/wrong", bridge.port),
                "http://tauri.localhost",
            ),
            (bridge.local_url(), "https://untrusted.invalid"),
        ] {
            let error = tokio_tungstenite::connect_async(request(url, origin))
                .await
                .unwrap_err();
            assert!(
                matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 403)
            );
        }
        let half_open = TcpStream::connect(("127.0.0.1", bridge.port))
            .await
            .unwrap();
        let valid =
            tokio_tungstenite::connect_async(request(bridge.local_url(), "http://tauri.localhost"))
                .await;
        assert!(valid.is_ok());
        drop(half_open);
        bridge.stop();
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(TcpStream::connect(("127.0.0.1", bridge.port))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn half_open_connections_release_their_handshake_budget() {
        let bridge = serve_vnc(
            None,
            "test".into(),
            "127.0.0.1".into(),
            1,
            SecurityPolicy::PreferTls,
        )
        .await
        .unwrap();
        let mut sockets = Vec::new();
        for _ in 0..4 {
            sockets.push(
                TcpStream::connect(("127.0.0.1", bridge.port))
                    .await
                    .unwrap(),
            );
        }
        tokio::time::sleep(HANDSHAKE_TIMEOUT + Duration::from_millis(150)).await;
        assert!(tokio_tungstenite::connect_async(request(
            bridge.local_url(),
            "http://tauri.localhost"
        ))
        .await
        .is_ok());
    }
}
