use crate::{error::AppError, pve::normalize_origin};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_CA: u64 = 64 * 1024;

fn trust_error() -> AppError {
    AppError::new(
        "pve_tls",
        "invalid_ca",
        "此 PVE 的本地 CA 文件不可读或格式不正确，请检查 pve-ca 目录。",
    )
}

pub fn certificate_path(documents: &Path, origin: &str) -> Result<PathBuf, AppError> {
    let origin = normalize_origin(origin)
        .map_err(|message| AppError::new("address", "invalid_address", message))?;
    let name: String = Sha256::digest(origin.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(documents
        .join("localVNC")
        .join("pve-ca")
        .join(format!("{name}.pem")))
}

pub fn load(origin: &str) -> Result<Option<Vec<u8>>, AppError> {
    let documents = dirs::document_dir().ok_or_else(trust_error)?;
    load_at(&documents, origin)
}

fn load_at(documents: &Path, origin: &str) -> Result<Option<Vec<u8>>, AppError> {
    let path = certificate_path(documents, origin)?;
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_CA => {}
        _ => return Err(trust_error()),
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| trust_error())?
        .take(MAX_CA + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| trust_error())?;
    let pem = std::str::from_utf8(&bytes)
        .map_err(|_| trust_error())?
        .trim();
    if bytes.len() as u64 > MAX_CA
        || !pem.starts_with("-----BEGIN CERTIFICATE-----")
        || !pem.ends_with("-----END CERTIFICATE-----")
        || pem.matches("-----BEGIN ").count() != 1
    {
        return Err(trust_error());
    }
    native_tls::Certificate::from_pem(&bytes).map_err(|_| trust_error())?;
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    const CA: &[u8] = include_bytes!("../../tests/fixtures/pve-tls/ca.pem");

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let parent = std::env::var_os("LOCALVNC_TEST_OUTPUT")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let root = parent.join(format!("pve-ca-{}", crate::error::random_token()));
            eprintln!("Creating isolated PVE CA fixture: {}", root.display());
            std::fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn put(&self, bytes: &[u8]) {
            let path = certificate_path(&self.0, "https://pve.invalid:8006").unwrap();
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, bytes).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            // Only exact files created by this fixture; no recursive deletion.
            let path = certificate_path(&self.0, "https://pve.invalid:8006").unwrap();
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_dir(path.parent().unwrap());
            let _ = std::fs::remove_dir(self.0.join("localVNC"));
            let _ = std::fs::remove_dir(&self.0);
        }
    }

    #[test]
    fn trust_is_scoped_to_canonical_https_origin_and_port() {
        let root = Path::new("documents");
        assert_eq!(
            certificate_path(root, "pve.invalid:8006/").unwrap(),
            certificate_path(root, "https://pve.invalid:8006").unwrap()
        );
        assert_ne!(
            certificate_path(root, "https://pve.invalid:8006").unwrap(),
            certificate_path(root, "https://pve.invalid:443").unwrap()
        );
        assert!(certificate_path(root, "http://pve.invalid:8006").is_err());
        assert!(certificate_path(root, "https://pve.invalid:8006/other").is_err());
    }
    #[test]
    fn missing_ca_does_not_create_files_or_apply_another_endpoints_ca() {
        let fixture = Fixture::new();
        assert!(load_at(&fixture.0, "https://pve.invalid:8006")
            .unwrap()
            .is_none());
        assert!(!fixture.0.join("localVNC").exists());
        fixture.put(CA);
        assert_eq!(
            load_at(&fixture.0, "https://pve.invalid:8006")
                .unwrap()
                .unwrap(),
            CA
        );
        assert!(load_at(&fixture.0, "https://other.invalid:8006")
            .unwrap()
            .is_none());
    }
    #[test]
    fn malformed_oversized_or_combined_ca_fails_closed() {
        let fixture = Fixture::new();
        for bytes in [
            b"INVALID CERTIFICATE".to_vec(),
            vec![b'x'; MAX_CA as usize + 1],
            [CA, CA].concat(),
            [CA, b"-----BEGIN PRIVATE KEY-----\nTEST_ONLY"].concat(),
        ] {
            fixture.put(&bytes);
            assert_eq!(
                load_at(&fixture.0, "https://pve.invalid:8006")
                    .unwrap_err()
                    .code,
                "invalid_ca"
            );
        }
    }

    fn listener() -> (std::net::TcpListener, String, native_tls::TlsAcceptor) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("https://{}", listener.local_addr().unwrap());
        let identity = native_tls::Identity::from_pkcs12(
            include_bytes!("../../tests/fixtures/pve-tls/server.p12"),
            "TEST_ONLY",
        )
        .unwrap();
        (
            listener,
            origin,
            native_tls::TlsAcceptor::new(identity).unwrap(),
        )
    }

    fn accept_with_deadline(listener: &std::net::TcpListener) -> std::net::TcpStream {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    return stream;
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(10))
                }
                Err(error) => panic!("Isolated TLS accept failed or timed out: {error}"),
            }
        }
    }

    #[tokio::test]
    async fn scoped_ca_verifies_real_https_login_proxy_and_wss() {
        use futures_util::StreamExt;
        use std::io::{Read, Write};
        let (listener, origin, acceptor) = listener();
        let server = std::thread::spawn(move || {
            for index in 0..3 {
                let tcp = accept_with_deadline(&listener);
                tcp.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut stream = acceptor.accept(tcp).unwrap();
                if index == 2 {
                    let mut socket = tokio_tungstenite::tungstenite::accept(stream).unwrap();
                    socket
                        .send(tokio_tungstenite::tungstenite::Message::Binary(
                            b"RFB 003.008\n".to_vec().into(),
                        ))
                        .unwrap();
                    break;
                }
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") && request.len() < 8192 {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let headers = String::from_utf8(request).unwrap();
                assert!(headers.starts_with(if index == 0 {
                    "POST /api2/json/access/ticket "
                } else {
                    "POST /api2/json/nodes/mock/qemu/103/vncproxy "
                }));
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .map(str::to_owned)
                    })
                    .unwrap()
                    .parse()
                    .unwrap();
                let mut body = vec![0; length];
                stream.read_exact(&mut body).unwrap();
                if index == 0 {
                    assert!(String::from_utf8(body)
                        .unwrap()
                        .contains("password=TEST_ONLY"));
                }
                let response = if index == 0 {
                    r#"{"data":{"ticket":"TEST_AUTH","CSRFPreventionToken":"TEST_CSRF"}}"#
                } else {
                    r#"{"data":{"port":5900,"ticket":"TEST_VNC"}}"#
                };
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
                stream.flush().unwrap();
            }
        });
        let session = crate::pve::open_console(
            &origin,
            "mock",
            103,
            "TEST_USER",
            "TEST_ONLY",
            false,
            Some(CA),
        )
        .await
        .unwrap();
        let mut socket =
            crate::bridge::connect_pve(&session.websocket_url, &session.cookie, false, Some(CA))
                .await
                .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().into_data().as_ref(),
            b"RFB 003.008\n"
        );
        server.join().unwrap();
    }

    #[tokio::test]
    async fn missing_or_wrong_ca_still_rejects_https_and_wss() {
        let other_ca = include_bytes!("../../tests/fixtures/pve-tls/other-ca.pem");
        for ca in [None, Some(other_ca.as_slice())] {
            for websocket in [false, true] {
                let (listener, origin, acceptor) = listener();
                let server = std::thread::spawn(move || {
                    let tcp = accept_with_deadline(&listener);
                    tcp.set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let _ = acceptor.accept(tcp);
                });
                if websocket {
                    let url = origin.replacen("https://", "wss://", 1);
                    assert!(crate::bridge::connect_pve(&url, "TEST_ONLY", false, ca)
                        .await
                        .is_err());
                } else {
                    assert!(crate::pve::http_client(false, ca)
                        .unwrap()
                        .get(&origin)
                        .send()
                        .await
                        .is_err());
                }
                server.join().unwrap();
            }
        }
    }
}
