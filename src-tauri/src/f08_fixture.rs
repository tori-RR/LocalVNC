//! Explicit opt-in fixture: production Windows bridge plus synthetic RFB.
use crate::{bridge, vencrypt::SecurityPolicy};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

type Events = Arc<Mutex<Vec<Value>>>;
fn record(events: &Events, start: Instant, value: Value) {
    let mut value = value;
    value["elapsedMs"] = json!(start.elapsed().as_millis() as u64);
    events.lock().unwrap().push(value);
}

async fn desktop<S: AsyncRead + AsyncWrite + Unpin>(mut io: S) -> std::io::Result<()> {
    io.read_u8().await?; // ClientInit
    let mut init = vec![
        0, 2, 0, 2, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0,
    ];
    init.extend_from_slice(&4u32.to_be_bytes());
    init.extend_from_slice(b"F08!");
    io.write_all(&init).await?;
    // Respect noVNC's negotiated pixel format/encodings before its first FBU.
    loop {
        match io.read_u8().await? {
            0 => {
                io.read_exact(&mut [0; 19]).await?;
            }
            2 => {
                io.read_u8().await?;
                let count = io.read_u16().await? as usize;
                if count > 1024 {
                    return Err(std::io::ErrorKind::InvalidData.into());
                }
                io.read_exact(&mut vec![0; count * 4]).await?;
            }
            3 => {
                io.read_exact(&mut [0; 9]).await?;
                break;
            }
            _ => return Err(std::io::ErrorKind::InvalidData.into()),
        }
    }
    // One 2x2 raw rectangle, then absolutely no application output.
    let mut frame = vec![0, 0, 0, 1, 0, 0, 0, 0, 0, 2, 0, 2, 0, 0, 0, 0];
    frame.extend_from_slice(&[
        0x33, 0x66, 0x99, 0, 0x33, 0x66, 0x99, 0, 0x33, 0x66, 0x99, 0, 0x33, 0x66, 0x99, 0,
    ]);
    io.write_all(&frame).await?;
    while io.read(&mut [0; 4096]).await? > 0 {}
    Ok(())
}

async fn serve_peer(mut tcp: TcpStream, tls: bool) -> std::io::Result<()> {
    tcp.write_all(b"RFB 003.008\n").await?;
    tcp.read_exact(&mut [0; 12]).await?;
    if !tls {
        tcp.write_all(&[1, 1]).await?;
        tcp.read_u8().await?;
        tcp.write_all(&0u32.to_be_bytes()).await?;
        return desktop(tcp).await;
    }
    tcp.write_all(&[1, 19]).await?;
    tcp.read_u8().await?;
    tcp.write_all(&[0, 2]).await?;
    tcp.read_exact(&mut [0; 2]).await?;
    tcp.write_all(&[0, 1]).await?;
    tcp.write_all(&258u32.to_be_bytes()).await?;
    tcp.read_exact(&mut [0; 4]).await?;
    tcp.write_all(&[1]).await?;
    let mut io = crate::tlsanon::test_accept(tcp).await;
    io.write_all(&[7; 16]).await?;
    io.read_exact(&mut [0; 16]).await?;
    io.write_all(&0u32.to_be_bytes()).await?;
    desktop(io).await
}

async fn upstream(tls: bool, events: Events, start: Instant) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (tcp, peer) = listener.accept().await.unwrap();
            let events = events.clone();
            tokio::spawn(async move {
                record(
                    &events,
                    start,
                    json!({"kind":"accepted", "tls":tls, "clientPort":peer.port(), "serverPort":port}),
                );
                let result = serve_peer(tcp, tls).await;
                record(
                    &events,
                    start,
                    json!({"kind":"closed", "tls":tls, "clientPort":peer.port(), "serverPort":port, "error":result.err().map(|e|e.kind().to_string())}),
                );
            });
        }
    });
    port
}

#[tokio::test]
#[ignore = "Explicit long-duration native F08 fixture; loopback only, no user state"]
async fn native_network_fixture() {
    let start = Instant::now();
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let plain = upstream(false, events.clone(), start).await;
    let tls = upstream(true, events.clone(), start).await;
    let http = TcpListener::bind("127.0.0.1:0").await.unwrap();
    println!(
        "F08_CONTROL=http://127.0.0.1:{}",
        http.local_addr().unwrap().port()
    );
    println!("F08_PID={}", std::process::id());
    let mut bridges = Vec::new();
    let stop = std::env::var_os("LOCALVNC_F08_STOP").map(std::path::PathBuf::from);
    loop {
        let accepted = tokio::select! {
            value = http.accept() => Some(value.unwrap().0),
            _ = tokio::time::sleep(Duration::from_millis(250)) => None,
        };
        if start.elapsed() > Duration::from_secs(1200)
            || stop.as_ref().is_some_and(|path| path.exists())
        {
            break;
        }
        let Some(mut tcp) = accepted else {
            continue;
        };
        let mut buf = [0; 2048];
        let size = tcp.read(&mut buf).await.unwrap();
        let request = std::str::from_utf8(&buf[..size]).unwrap_or("");
        let body = if request.starts_with("GET /new/plain ") || request.starts_with("GET /new/tls ")
        {
            let secure = request.starts_with("GET /new/tls ");
            let bridge = bridge::serve_vnc(
                None,
                "f08-synthetic".into(),
                "127.0.0.1".into(),
                if secure { tls } else { plain },
                if secure {
                    SecurityPolicy::RequireTls
                } else {
                    SecurityPolicy::Plain
                },
            )
            .await
            .unwrap();
            let body = json!({"url":bridge.local_url(),"pid":std::process::id(),"tls":secure});
            bridges.push(bridge);
            body
        } else {
            json!({"pid":std::process::id(),"elapsedMs":start.elapsed().as_millis() as u64,"events":events.lock().unwrap().clone()})
        };
        let body = body.to_string();
        let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body);
        let _ = tcp.write_all(reply.as_bytes()).await;
    }
    for bridge in bridges {
        bridge.stop();
    }
}
