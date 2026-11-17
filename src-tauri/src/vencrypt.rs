use crate::{
    error::AppError,
    tlsanon::{AnonTls, TlsError},
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};

const VNC_AUTH: u8 = 2;
const NONE: u8 = 1;
const VENCRYPT: u8 = 19;
const ARD: u8 = 30;
const TLS_VNC: u32 = 258;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SecurityPolicy {
    PreferTls,
    RequireTls,
    Plain,
}

enum Transport {
    Tcp(TcpStream),
    Tls(AnonTls),
}

pub async fn run(
    ws: &mut WebSocketStream<TcpStream>,
    tcp: TcpStream,
    policy: SecurityPolicy,
) -> Result<(), AppError> {
    run_with_timeout(ws, tcp, policy, Duration::from_secs(30)).await
}

async fn run_with_timeout(
    ws: &mut WebSocketStream<TcpStream>,
    tcp: TcpStream,
    policy: SecurityPolicy,
    network_timeout: Duration,
) -> Result<(), AppError> {
    let mut pending = Vec::new();
    let transport = tokio::time::timeout(network_timeout, negotiate(ws, tcp, &mut pending, policy))
        .await
        .map_err(|_| AppError::new("rfb_security", "timeout", "VNC 协商超时"))??;
    match transport {
        Transport::Tls(mut tls) => {
            // The challenge is already delivered. Only this local credential
            // wait is untimed; closing/cancelling the scoped bridge interrupts it.
            let response = recv_exact(ws, &mut pending, 16).await?;
            tokio::time::timeout(network_timeout, async {
                tls.write(&response).await.map_err(TlsError::app_error)?;
                let mut result = [0; 4];
                tls.read_exact(&mut result)
                    .await
                    .map_err(TlsError::app_error)?;
                check_auth_result(u32::from_be_bytes(result))?;
                send_bin(ws, &result).await?;
                if !pending.is_empty() {
                    tls.write(&pending).await.map_err(TlsError::app_error)?;
                    pending.clear();
                }
                Ok::<(), AppError>(())
            })
            .await
            .map_err(|_| AppError::new("rfb_auth", "timeout", "等待 VNC 认证结果超时"))??;
            join_tls(ws, tls).await.map_err(TlsError::app_error)
        }
        Transport::Tcp(mut tcp) => {
            if !pending.is_empty() {
                tcp.write_all(&pending)
                    .await
                    .map_err(|_| transport_error("VNC 传输中断"))?;
            }
            crate::bridge::join_tcp(ws, tcp)
                .await
                .map_err(|error| AppError::new("rfb", "transport", error))
        }
    }
}

fn protocol_error(message: impl Into<String>) -> AppError {
    AppError::new("rfb_security", "protocol", message)
}
fn transport_error(message: impl Into<String>) -> AppError {
    AppError::new("rfb", "transport", message)
}
fn unsupported(message: &str) -> AppError {
    AppError::new("rfb_security", "unsupported_security", message)
}

fn version(banner: &[u8; 12]) -> Result<u8, AppError> {
    if &banner[..8] != b"RFB 003."
        || banner[11] != b'\n'
        || !banner[8..11].iter().all(u8::is_ascii_digit)
    {
        return Err(protocol_error("VNC 协议版本不受支持"));
    }
    let minor = (banner[8] - b'0') as u16 * 100
        + (banner[9] - b'0') as u16 * 10
        + (banner[10] - b'0') as u16;
    match minor {
        7 => Ok(7),
        8 | 889 => Ok(8), // Apple's RFB 003.889 uses the 3.8 handshake.
        3.. => Ok(3),
        _ => Err(protocol_error("VNC 协议版本过旧")),
    }
}

fn choose_security(types: &[u8], policy: SecurityPolicy) -> Result<u8, AppError> {
    if policy != SecurityPolicy::Plain && types.contains(&VENCRYPT) {
        return Ok(VENCRYPT);
    }
    if policy == SecurityPolicy::RequireTls {
        return Err(unsupported("服务器没有提供 TLSVnc 加密认证"));
    }
    // As in TigerVNC, the server's order decides between supported non-TLS
    // schemes. Preserve the existing explicit TLS preference/requirement above.
    if let Some(selected) = types
        .iter()
        .find(|kind| matches!(**kind, VNC_AUTH | NONE | ARD))
    {
        return Ok(*selected);
    }
    Err(unsupported("服务器没有提供当前策略支持的认证方式"))
}

async fn negotiate(
    ws: &mut WebSocketStream<TcpStream>,
    mut tcp: TcpStream,
    pending: &mut Vec<u8>,
    policy: SecurityPolicy,
) -> Result<Transport, AppError> {
    let banner = read_array::<12>(&mut tcp).await?;
    let offered = version(&banner)?;
    let normalized = format!("RFB 003.00{offered}\n");
    send_bin(ws, normalized.as_bytes()).await?;
    let client = recv_exact(ws, pending, 12).await?;
    let client: [u8; 12] = client
        .try_into()
        .map_err(|_| protocol_error("VNC 版本格式错误"))?;
    let chosen = version(&client)?;
    if chosen > offered || client != *format!("RFB 003.00{chosen}\n").as_bytes() {
        return Err(protocol_error("画面端选择了无效协议版本"));
    }
    tcp.write_all(&client)
        .await
        .map_err(|_| transport_error("VNC 连接中断"))?;
    if chosen == 3 {
        let security = read_array::<4>(&mut tcp).await?;
        let kind = u32::from_be_bytes(security);
        if kind == 0 {
            return Err(protocol_error("VNC 服务拒绝了连接"));
        }
        if policy == SecurityPolicy::RequireTls || !matches!(kind, 1 | 2) {
            return Err(unsupported("RFB 3.3 服务器不支持所选认证策略"));
        }
        send_bin(ws, &security).await?;
        return Ok(Transport::Tcp(tcp));
    }
    let count = read_array::<1>(&mut tcp).await?[0] as usize;
    if count == 0 {
        return Err(protocol_error("VNC 服务拒绝了连接"));
    }
    let types = read_vec(&mut tcp, count).await?;
    let selected = choose_security(&types, policy)?;
    tcp.write_all(&[selected])
        .await
        .map_err(|_| transport_error("VNC 连接中断"))?;
    if selected != VENCRYPT {
        send_bin(ws, &[1, selected]).await?;
        if recv_exact(ws, pending, 1).await? != [selected] {
            return Err(protocol_error("画面端认证方式不匹配"));
        }
        if selected == ARD {
            // Match TigerVNC's DH key bounds before noVNC allocates or performs
            // modular exponentiation using parameters from the remote server.
            let header = read_array::<4>(&mut tcp).await?;
            let length = ard_key_length(&header)?;
            let parameters = read_vec(&mut tcp, length * 2).await?;
            if parameters[..length].iter().all(|byte| *byte == 0) {
                return Err(protocol_error("macOS 认证参数无效"));
            }
            send_bin(ws, &header).await?;
            send_bin(ws, &parameters).await?;
        }
        return Ok(Transport::Tcp(tcp));
    }
    if read_array::<2>(&mut tcp).await? != [0, 2] {
        return Err(unsupported("不支持的 VeNCrypt 版本"));
    }
    tcp.write_all(&[0, 2])
        .await
        .map_err(|_| transport_error("VNC 连接中断"))?;
    if read_array::<1>(&mut tcp).await?[0] != 0 {
        return Err(protocol_error("VeNCrypt 协商失败"));
    }
    let count = read_array::<1>(&mut tcp).await?[0] as usize;
    let subtypes = read_vec(&mut tcp, count * 4).await?;
    if !subtypes
        .as_chunks::<4>()
        .0
        .iter()
        .any(|bytes| *bytes == TLS_VNC.to_be_bytes())
    {
        return Err(unsupported(
            "服务器未提供 TLSVnc；不会自动降级，请检查安全策略",
        ));
    }
    tcp.write_all(&TLS_VNC.to_be_bytes())
        .await
        .map_err(|_| transport_error("VNC 连接中断"))?;
    if read_array::<1>(&mut tcp).await?[0] != 1 {
        return Err(protocol_error("服务器没有启动 TLS"));
    }
    let mut tls = AnonTls::connect(tcp)
        .await
        .map_err(|error| AppError::new("tls", "handshake", error.app_error().safe_message))?;
    let mut challenge = [0u8; 16];
    tls.read_exact(&mut challenge)
        .await
        .map_err(TlsError::app_error)?;
    send_bin(ws, &[1, VNC_AUTH]).await?;
    if recv_exact(ws, pending, 1).await? != [VNC_AUTH] {
        return Err(protocol_error("画面端没有选择 VNC 密码认证"));
    }
    send_bin(ws, &challenge).await?;
    Ok(Transport::Tls(tls))
}

fn ard_key_length(header: &[u8; 4]) -> Result<usize, AppError> {
    let length = u16::from_be_bytes([header[2], header[3]]) as usize;
    if !(128..=1024).contains(&length) {
        return Err(protocol_error("macOS 认证密钥长度不受支持"));
    }
    Ok(length)
}

fn check_auth_result(status: u32) -> Result<(), AppError> {
    match status {
        0 => Ok(()),
        1 => Err(AppError::new(
            "rfb_auth",
            "unauthorized",
            "VNC 密码认证失败",
        )),
        2 => Err(AppError::new(
            "rfb_auth",
            "auth_limited",
            "服务器已限制认证重试，请稍后再连接。",
        )),
        _ => Err(AppError::new(
            "rfb_auth",
            "protocol",
            "服务器返回未知认证结果。",
        )),
    }
}

async fn read_array<const N: usize>(reader: &mut TcpStream) -> Result<[u8; N], AppError> {
    let mut buf = [0u8; N];
    reader
        .read_exact(&mut buf)
        .await
        .map_err(|_| transport_error("VNC 协商中断"))?;
    Ok(buf)
}
async fn read_vec(reader: &mut TcpStream, len: usize) -> Result<Vec<u8>, AppError> {
    let mut buf = vec![0; len];
    reader
        .read_exact(&mut buf)
        .await
        .map_err(|_| transport_error("VNC 协商中断"))?;
    Ok(buf)
}
async fn send_bin(ws: &mut WebSocketStream<TcpStream>, bytes: &[u8]) -> Result<(), AppError> {
    ws.send(Message::Binary(bytes.to_vec().into()))
        .await
        .map_err(|_| transport_error("画面通道中断"))
}
async fn recv_exact(
    ws: &mut WebSocketStream<TcpStream>,
    pending: &mut Vec<u8>,
    len: usize,
) -> Result<Vec<u8>, AppError> {
    while pending.len() < len {
        match ws
            .next()
            .await
            .ok_or_else(|| transport_error("画面通道中断"))?
            .map_err(|_| transport_error("画面通道中断"))?
        {
            Message::Binary(data) => pending.extend_from_slice(&data),
            Message::Ping(data) => ws
                .send(Message::Pong(data))
                .await
                .map_err(|_| transport_error("画面通道中断"))?,
            Message::Text(_) => return Err(protocol_error("画面通道只接受二进制数据")),
            Message::Close(_) => return Err(transport_error("画面通道中断")),
            _ => {}
        }
        if pending.len() > 1024 * 1024 {
            return Err(protocol_error("画面通道数据过大"));
        }
    }
    Ok(pending.drain(..len).collect())
}

async fn join_tls(ws: &mut WebSocketStream<TcpStream>, tls: AnonTls) -> Result<(), TlsError> {
    let (mut reader, mut writer) = tls.into_split();
    let (mut sink, mut stream) = ws.split();
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let reply = tx.clone();
    let down = async move {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let count = reader.read(&mut buf).await?;
            if count == 0 {
                tx.send(Message::Close(None))
                    .await
                    .map_err(|_| TlsError::Transport)?;
                break;
            }
            tx.send(Message::Binary(buf[..count].to_vec().into()))
                .await
                .map_err(|_| TlsError::Transport)?;
        }
        Ok::<(), TlsError>(())
    };
    let up = async move {
        while let Some(message) = stream.next().await {
            match message.map_err(|_| TlsError::Transport)? {
                Message::Binary(data) => writer.write(&data).await?,
                Message::Ping(data) => reply
                    .send(Message::Pong(data))
                    .await
                    .map_err(|_| TlsError::Transport)?,
                Message::Text(_) => return Err(TlsError::Security),
                Message::Close(_) => break,
                _ => {}
            }
        }
        Ok::<(), TlsError>(())
    };
    let output = async move {
        while let Some(message) = rx.recv().await {
            let closed = matches!(message, Message::Close(_));
            sink.send(message).await.map_err(|_| TlsError::Transport)?;
            if closed {
                break;
            }
        }
        Ok::<(), TlsError>(())
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
    #[ignore = "Explicit loopback fixture for real-browser TLSVnc acceptance; no user state"]
    async fn browser_tlsvnc_fixture() {
        let remote = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = remote.local_addr().unwrap();
        let server = tokio::spawn(async move {
            loop {
                let (mut tcp, _) = remote.accept().await.unwrap();
                tokio::spawn(async move {
                    tcp.write_all(b"RFB 003.008\n").await.unwrap();
                    tcp.read_exact(&mut [0; 12]).await.unwrap();
                    tcp.write_all(&[1, VENCRYPT]).await.unwrap();
                    tcp.read_exact(&mut [0; 1]).await.unwrap();
                    tcp.write_all(&[0, 2]).await.unwrap();
                    tcp.read_exact(&mut [0; 2]).await.unwrap();
                    tcp.write_all(&[0, 1]).await.unwrap();
                    tcp.write_all(&TLS_VNC.to_be_bytes()).await.unwrap();
                    tcp.read_exact(&mut [0; 4]).await.unwrap();
                    tcp.write_all(&[1]).await.unwrap();
                    let mut tls = crate::tlsanon::test_accept(tcp).await;
                    tls.write_all(&[7; 16]).await.unwrap();
                    if tls.read_exact(&mut [0; 16]).await.is_err() {
                        return;
                    }
                    tls.write_all(&0u32.to_be_bytes()).await.unwrap();
                    if tls.read_u8().await.is_err() {
                        return;
                    }
                    let mut init = vec![
                        0, 2, 0, 2, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
                    ];
                    init.extend_from_slice(&4u32.to_be_bytes());
                    init.extend_from_slice(b"TEST");
                    tls.write_all(&init).await.unwrap();
                    while tls.read(&mut [0; 4096]).await.is_ok_and(|count| count > 0) {}
                });
            }
        });
        let bridge = crate::bridge::serve_vnc(
            None,
            "synthetic-browser".into(),
            "127.0.0.1".into(),
            address.port(),
            SecurityPolicy::RequireTls,
        )
        .await
        .unwrap();
        println!("TLS_FIXTURE_URL={}", bridge.local_url());
        tokio::time::sleep(Duration::from_secs(240)).await;
        bridge.stop();
        server.abort();
        let _ = server.await;
    }

    async fn tlsvnc_fixture(
        budget: Duration,
        stall: bool,
    ) -> (
        WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>,
        tokio::task::JoinHandle<Result<(), AppError>>,
        tokio::task::JoinHandle<()>,
    ) {
        let remote = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = remote.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut tcp, _) = remote.accept().await.unwrap();
            tcp.write_all(b"RFB 003.008\n").await.unwrap();
            tcp.read_exact(&mut [0; 12]).await.unwrap();
            tcp.write_all(&[1, VENCRYPT]).await.unwrap();
            tcp.read_exact(&mut [0; 1]).await.unwrap();
            tcp.write_all(&[0, 2]).await.unwrap();
            tcp.read_exact(&mut [0; 2]).await.unwrap();
            tcp.write_all(&[0, 1]).await.unwrap();
            tcp.write_all(&TLS_VNC.to_be_bytes()).await.unwrap();
            tcp.read_exact(&mut [0; 4]).await.unwrap();
            tcp.write_all(&[1]).await.unwrap();
            let mut tls = crate::tlsanon::test_accept(tcp).await;
            tls.write_all(&[7; 16]).await.unwrap();
            let mut response = [0; 16];
            if tls.read_exact(&mut response).await.is_err() {
                return;
            }
            assert_eq!(response, [9; 16]);
            if stall {
                tokio::time::sleep(budget * 3).await;
                return;
            }
            tls.write_all(&0u32.to_be_bytes()).await.unwrap();
            // Synthetic RFB ServerInit marker, then a clean TLS close.
            tls.write_all(b"INIT").await.unwrap();
            let _ = tls.shutdown().await;
        });
        let local = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_address = local.local_addr().unwrap();
        let bridge = tokio::spawn(async move {
            let (tcp, _) = local.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
            let remote = TcpStream::connect(address).await.unwrap();
            run_with_timeout(&mut ws, remote, SecurityPolicy::RequireTls, budget).await
        });
        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{local_address}"))
            .await
            .unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap().into_data(),
            b"RFB 003.008\n".as_slice()
        );
        ws.send(Message::Binary(b"RFB 003.008\n".to_vec().into()))
            .await
            .unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap().into_data(),
            [1, VNC_AUTH].as_slice()
        );
        ws.send(Message::Binary(vec![VNC_AUTH].into()))
            .await
            .unwrap();
        assert_eq!(
            ws.next().await.unwrap().unwrap().into_data(),
            [7; 16].as_slice()
        );
        (ws, bridge, server)
    }

    #[tokio::test]
    async fn tlsvnc_user_wait_45_and_90_seconds_outlives_network_deadline() {
        async fn exercise(wait: u64) {
            let (mut ws, bridge, server) = tlsvnc_fixture(Duration::from_secs(30), false).await;
            tokio::time::sleep(Duration::from_secs(wait)).await;
            assert!(
                !bridge.is_finished(),
                "user interaction must not consume network timeout"
            );
            ws.send(Message::Binary(vec![9; 16].into())).await.unwrap();
            assert_eq!(
                ws.next().await.unwrap().unwrap().into_data(),
                [0; 4].as_slice()
            );
            assert_eq!(
                ws.next().await.unwrap().unwrap().into_data(),
                b"INIT".as_slice()
            );
            bridge.await.unwrap().unwrap();
            server.await.unwrap();
        }
        tokio::join!(exercise(45), exercise(90));
    }

    #[tokio::test]
    async fn tlsvnc_cancel_releases_wait_and_server_result_still_times_out() {
        let budget = Duration::from_secs(2);
        let (mut ws, bridge, server) = tlsvnc_fixture(budget, false).await;
        ws.close(None).await.unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(1), bridge)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        server.await.unwrap();
        let (mut ws, bridge, server) = tlsvnc_fixture(budget, true).await;
        ws.send(Message::Binary(vec![9; 16].into())).await.unwrap();
        let error = tokio::time::timeout(budget * 2, bridge)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.stage, "rfb_auth");
        assert_eq!(error.code, "timeout");
        server.abort();
        let _ = server.await;
    }
    #[test]
    fn apple_dh_parameters_have_bounded_key_lengths() {
        for length in [0u16, 127, 1025, u16::MAX] {
            let bytes = length.to_be_bytes();
            assert!(ard_key_length(&[0, 2, bytes[0], bytes[1]]).is_err());
        }
        for length in [128u16, 256, 512, 1024] {
            let bytes = length.to_be_bytes();
            assert_eq!(
                ard_key_length(&[0, 2, bytes[0], bytes[1]]).unwrap(),
                length as usize
            );
        }
    }
    #[test]
    fn authentication_results_distinguish_bad_password_lockout_and_protocol() {
        assert!(check_auth_result(0).is_ok());
        assert_eq!(check_auth_result(1).unwrap_err().code, "unauthorized");
        assert_eq!(check_auth_result(2).unwrap_err().code, "auth_limited");
        assert_eq!(check_auth_result(3).unwrap_err().code, "protocol");
    }
    #[tokio::test]
    async fn negotiation_eof_is_transport_but_malformed_banner_is_protocol() {
        use tokio::net::TcpListener;
        for bytes in [b"RFB 003.".as_slice(), b"INVALID DATA".as_slice()] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut client = TcpStream::connect(listener.local_addr().unwrap())
                .await
                .unwrap();
            let (mut server, _) = listener.accept().await.unwrap();
            server.write_all(bytes).await.unwrap();
            drop(server);
            let result = read_array::<12>(&mut client)
                .await
                .and_then(|banner| version(&banner));
            let error = result.unwrap_err();
            if bytes.len() < 12 {
                assert_eq!(error.stage, "rfb");
                assert_eq!(error.code, "transport");
            } else {
                assert_eq!(error.stage, "rfb_security");
                assert_eq!(error.code, "protocol");
            }
        }
    }
    #[test]
    fn version_and_security_matrix() {
        for minor in [3, 7, 8] {
            assert_eq!(
                version(
                    format!("RFB 003.00{minor}\n")
                        .as_bytes()
                        .try_into()
                        .unwrap()
                )
                .unwrap(),
                minor
            );
        }
        assert!(version(b"RFB 004.008\n").is_err());
        assert!(version(b"RFB 003.xxx\n").is_err());
        assert_eq!(version(b"RFB 003.889\n").unwrap(), 8);
        for types in [vec![19], vec![19, 2], vec![2, 19]] {
            assert_eq!(
                choose_security(&types, SecurityPolicy::PreferTls).unwrap(),
                19
            );
        }
        assert_eq!(choose_security(&[2], SecurityPolicy::PreferTls).unwrap(), 2);
        assert_eq!(choose_security(&[1], SecurityPolicy::PreferTls).unwrap(), 1);
        assert_eq!(choose_security(&[19, 2], SecurityPolicy::Plain).unwrap(), 2);
        assert!(choose_security(&[2], SecurityPolicy::RequireTls).is_err());
        assert!(choose_security(&[19], SecurityPolicy::Plain).is_err());
    }

    #[test]
    fn automatic_authentication_follows_server_order_and_preserves_tls_policy() {
        for policy in [SecurityPolicy::PreferTls, SecurityPolicy::Plain] {
            assert_eq!(choose_security(&[30, 33, 36, 2, 35], policy).unwrap(), ARD);
            assert_eq!(choose_security(&[2, ARD], policy).unwrap(), VNC_AUTH);
            assert_eq!(choose_security(&[ARD], policy).unwrap(), ARD);
            assert!(choose_security(&[33, 35, 36], policy).is_err());
        }
        assert!(choose_security(&[ARD], SecurityPolicy::RequireTls).is_err());
        assert_eq!(
            choose_security(&[ARD, 19], SecurityPolicy::RequireTls).unwrap(),
            VENCRYPT
        );
        assert_eq!(
            choose_security(&[ARD, 19], SecurityPolicy::PreferTls).unwrap(),
            VENCRYPT
        );
    }

    #[tokio::test]
    async fn versions_and_authentication_pass_bytes_without_misalignment() {
        for minor in [3, 7, 8] {
            for auth in [NONE, VNC_AUTH] {
                tokio::time::timeout(Duration::from_secs(3), plain_round_trip(minor, auth, false))
                    .await
                    .unwrap();
            }
        }
    }

    #[tokio::test]
    async fn apple_banner_and_account_handshake_pass_through_the_real_bridge() {
        for mixed_offer in [false, true] {
            tokio::time::timeout(
                Duration::from_secs(3),
                plain_round_trip(889, ARD, mixed_offer),
            )
            .await
            .unwrap();
        }
    }

    async fn plain_round_trip(minor: u16, auth: u8, mixed_offer: bool) {
        use tokio::net::TcpListener;
        use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue};
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let remote_version = format!("RFB 003.{minor:03}\n");
        let banner = format!("RFB 003.{:03}\n", if minor == 889 { 8 } else { minor });
        let expected_client = banner.clone();
        let remote_banner = remote_version.clone();
        let remote = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            // A fragmented banner must behave exactly like an unfragmented one.
            for byte in remote_banner.bytes() {
                stream.write_all(&[byte]).await.unwrap();
            }
            assert_eq!(
                read_array::<12>(&mut stream).await.unwrap(),
                expected_client.as_bytes()
            );
            if minor == 3 {
                stream
                    .write_all(&(auth as u32).to_be_bytes())
                    .await
                    .unwrap();
            } else {
                if auth == ARD && mixed_offer {
                    stream.write_all(&[2, ARD, VNC_AUTH]).await.unwrap();
                } else {
                    stream.write_all(&[1, auth]).await.unwrap();
                }
                assert_eq!(read_array::<1>(&mut stream).await.unwrap(), [auth]);
            }
            if auth == VNC_AUTH {
                stream.write_all(&[7; 16]).await.unwrap();
                assert_eq!(read_array::<16>(&mut stream).await.unwrap(), [9; 16]);
            }
            if auth == ARD {
                stream.write_all(&[0, 2, 0, 128]).await.unwrap();
                stream.write_all(&[7; 256]).await.unwrap();
                assert_eq!(read_array::<256>(&mut stream).await.unwrap(), [9; 256]);
            }
            if auth == VNC_AUTH || auth == ARD || minor == 8 {
                stream.write_all(&[0; 4]).await.unwrap();
            }
            assert_eq!(read_array::<1>(&mut stream).await.unwrap(), [1]); // ClientInit
            stream.write_all(b"SERVER_INIT_SENTINEL").await.unwrap();
            assert_eq!(read_array::<4>(&mut stream).await.unwrap(), *b"ping");
            // Closing immediately after a response must not drop queued bytes.
            stream.write_all(b"pong").await.unwrap();
        });
        let bridge = crate::bridge::serve_vnc(
            None,
            "test".into(),
            "127.0.0.1".into(),
            port,
            SecurityPolicy::PreferTls,
        )
        .await
        .unwrap();
        let mut request = bridge.local_url().into_client_request().unwrap();
        request
            .headers_mut()
            .insert("Origin", HeaderValue::from_static("http://tauri.localhost"));
        let socket = TcpStream::connect(("127.0.0.1", bridge.port))
            .await
            .unwrap();
        let (mut ws, _) = tokio_tungstenite::client_async(request, socket)
            .await
            .unwrap();
        let mut pending = Vec::new();
        assert_eq!(
            recv_exact(&mut ws, &mut pending, 12).await.unwrap(),
            banner.as_bytes()
        );
        send_bin(&mut ws, banner.as_bytes()).await.unwrap();
        if minor == 3 {
            assert_eq!(
                recv_exact(&mut ws, &mut pending, 4).await.unwrap(),
                (auth as u32).to_be_bytes()
            );
        } else {
            assert_eq!(
                recv_exact(&mut ws, &mut pending, 2).await.unwrap(),
                [1, auth]
            );
            send_bin(&mut ws, &[auth]).await.unwrap();
        }
        if auth == VNC_AUTH {
            assert_eq!(
                recv_exact(&mut ws, &mut pending, 16).await.unwrap(),
                [7; 16]
            );
            send_bin(&mut ws, &[9; 16]).await.unwrap();
        }
        if auth == ARD {
            assert_eq!(
                recv_exact(&mut ws, &mut pending, 4).await.unwrap(),
                [0, 2, 0, 128]
            );
            assert_eq!(
                recv_exact(&mut ws, &mut pending, 256).await.unwrap(),
                [7; 256]
            );
            send_bin(&mut ws, &[9; 256]).await.unwrap();
        }
        if auth == VNC_AUTH || auth == ARD || minor == 8 {
            assert_eq!(recv_exact(&mut ws, &mut pending, 4).await.unwrap(), [0; 4]);
        }
        send_bin(&mut ws, &[1]).await.unwrap();
        assert_eq!(
            recv_exact(&mut ws, &mut pending, b"SERVER_INIT_SENTINEL".len())
                .await
                .unwrap(),
            b"SERVER_INIT_SENTINEL"
        );
        send_bin(&mut ws, b"ping").await.unwrap();
        assert_eq!(recv_exact(&mut ws, &mut pending, 4).await.unwrap(), b"pong");
        remote.await.unwrap();
    }
}
