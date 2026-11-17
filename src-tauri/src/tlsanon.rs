//! Legacy anonymous TLSVnc only; PVE never uses this context.
//! OpenSSL owns the complete TLS handshake and CBC record processing.
use openssl::ssl::{
    Ssl, SslContext, SslContextBuilder, SslMethod, SslOptions, SslVerifyMode, SslVersion,
};
use std::{io, pin::Pin, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio_openssl::SslStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsError {
    Transport,
    Security,
    Timeout,
}

impl TlsError {
    pub fn app_error(self) -> crate::error::AppError {
        let (code, message) = match self {
            Self::Transport => ("transport", "TLS 连接中断"),
            Self::Security => ("integrity", "TLS 安全校验失败，连接已终止"),
            Self::Timeout => ("timeout", "TLS 握手超时"),
        };
        crate::error::AppError::new("tls", code, message)
    }
}

fn io_error(error: io::Error) -> TlsError {
    // Never disclose padding/MAC/alert reason strings or retry failed validation.
    if let Some(ssl) = error
        .get_ref()
        .and_then(|source| source.downcast_ref::<openssl::ssl::Error>())
    {
        if ssl.code() == openssl::ssl::ErrorCode::SSL {
            // OpenSSL 3 can report a raw TCP FIN as an SSL error. Match only
            // ERR_LIB_SSL / SSL_R_UNEXPECTED_EOF_WHILE_READING from err.h and
            // sslerr.h; never turn a bad record/MAC or mixed error stack into
            // an ordinary retry, and never accept a truncated record as data.
            let eof = ssl.ssl_error().is_some_and(|stack| {
                !stack.errors().is_empty()
                    && stack
                        .errors()
                        .iter()
                        .all(|error| error.library_code() == 20 && error.reason_code() == 294)
            });
            if eof {
                return TlsError::Transport;
            }
            return TlsError::Security;
        }
    }
    if error.kind() == io::ErrorKind::InvalidData {
        TlsError::Security
    } else {
        TlsError::Transport
    }
}

fn legacy_context(method: SslMethod) -> Result<SslContext, TlsError> {
    let mut context = SslContextBuilder::new(method).map_err(|_| TlsError::Security)?;
    // Anonymous suites require level 0. The exception is context-local and
    // restricted to the same suite/version/group supported before migration.
    context.set_security_level(0);
    context.set_verify(SslVerifyMode::NONE);
    context
        .set_min_proto_version(Some(SslVersion::TLS1_2))
        .map_err(|_| TlsError::Security)?;
    context
        .set_max_proto_version(Some(SslVersion::TLS1_2))
        .map_err(|_| TlsError::Security)?;
    context
        .set_cipher_list("AECDH-AES256-SHA")
        .map_err(|_| TlsError::Security)?;
    context
        .set_groups_list("P-256")
        .map_err(|_| TlsError::Security)?;
    context.set_options(
        SslOptions::NO_COMPRESSION | SslOptions::NO_RENEGOTIATION | SslOptions::NO_TICKET,
    );
    Ok(context.build())
}

pub struct AnonTls(SslStream<TcpStream>);
pub struct AnonReader(ReadHalf<SslStream<TcpStream>>);
pub struct AnonWriter(WriteHalf<SslStream<TcpStream>>);

impl AnonTls {
    pub async fn connect(io: TcpStream) -> Result<Self, TlsError> {
        let context = legacy_context(SslMethod::tls_client())?;
        let ssl = Ssl::new(&context).map_err(|_| TlsError::Security)?;
        let mut stream = SslStream::new(ssl, io).map_err(|_| TlsError::Security)?;
        tokio::time::timeout(Duration::from_secs(15), Pin::new(&mut stream).connect())
            .await
            .map_err(|_| TlsError::Timeout)?
            .map_err(|_| TlsError::Security)?;
        if stream.ssl().version_str() != "TLSv1.2"
            || stream.ssl().current_cipher().map(|cipher| cipher.name()) != Some("AECDH-AES256-SHA")
        {
            return Err(TlsError::Security);
        }
        Ok(Self(stream))
    }
    pub async fn read_exact(&mut self, buf: &mut [u8]) -> Result<(), TlsError> {
        self.0.read_exact(buf).await.map(|_| ()).map_err(io_error)
    }
    pub async fn write(&mut self, data: &[u8]) -> Result<(), TlsError> {
        self.0.write_all(data).await.map_err(io_error)
    }
    pub fn into_split(self) -> (AnonReader, AnonWriter) {
        // Split TLS, not raw TCP: reads may need to write protocol traffic.
        let (reader, writer) = tokio::io::split(self.0);
        (AnonReader(reader), AnonWriter(writer))
    }
}
impl AnonReader {
    pub async fn read(&mut self, buf: &mut [u8]) -> Result<usize, TlsError> {
        self.0.read(buf).await.map_err(io_error)
    }
}
impl AnonWriter {
    pub async fn write(&mut self, data: &[u8]) -> Result<(), TlsError> {
        self.0.write_all(data).await.map_err(io_error)
    }
}

#[cfg(test)]
pub(crate) async fn test_accept(io: TcpStream) -> SslStream<TcpStream> {
    let context = legacy_context(SslMethod::tls_server()).unwrap();
    let mut stream = SslStream::new(Ssl::new(&context).unwrap(), io).unwrap();
    tokio::time::timeout(Duration::from_secs(5), Pin::new(&mut stream).accept())
        .await
        .unwrap()
        .unwrap();
    stream
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn openssl_unexpected_eof_reason_is_transport_but_other_ssl_reasons_are_terminal() {
        for (reason, expected) in [
            (294, TlsError::Transport),
            (281, TlsError::Security),
            (999, TlsError::Security),
        ] {
            let _ = openssl::error::ErrorStack::get();
            // Populate only this thread's synthetic error queue. Codes are
            // OpenSSL ERR_LIB_SSL, SSL_R_UNEXPECTED_EOF_WHILE_READING and
            // SSL_R_DECRYPTION_FAILED_OR_BAD_RECORD_MAC from the vendored headers.
            unsafe {
                openssl_sys::ERR_new();
                openssl_sys::ERR_set_debug(c"test".as_ptr(), 1, c"classification".as_ptr());
                openssl_sys::ERR_set_error(20, reason, c"synthetic".as_ptr());
            }
            let error = openssl::ssl::Error::from(openssl::error::ErrorStack::get());
            assert_eq!(io_error(io::Error::other(error)), expected);
        }
    }

    #[tokio::test]
    async fn established_tls_plain_tcp_fin_is_transport_not_integrity_failure() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (io, _) = listener.accept().await.unwrap();
            let mut stream = test_accept(io).await;
            // A process stop may send FIN without a TLS close_notify.
            stream.get_mut().shutdown().await.unwrap();
            tokio::time::sleep(Duration::from_millis(200)).await;
        });
        let mut tls = AnonTls::connect(TcpStream::connect(address).await.unwrap())
            .await
            .unwrap();
        assert_eq!(
            tls.read_exact(&mut [0; 1]).await.unwrap_err(),
            TlsError::Transport
        );
        server.await.unwrap();
    }

    #[tokio::test]
    async fn legacy_engine_negotiates_exact_suite_and_full_duplex_records() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (io, _) = listener.accept().await.unwrap();
            let stream = test_accept(io).await;
            assert_eq!(
                stream.ssl().current_cipher().unwrap().name(),
                "AECDH-AES256-SHA"
            );
            assert_eq!(stream.ssl().version_str(), "TLSv1.2");
            let (mut reader, mut writer) = tokio::io::split(stream);
            let down = async {
                writer.write_all(&vec![0xa5; 65537]).await.unwrap();
                writer.shutdown().await.unwrap();
            };
            let up = async {
                let mut bytes = vec![0; 65537];
                reader.read_exact(&mut bytes).await.unwrap();
                assert_eq!(bytes, vec![0x5a; 65537]);
            };
            tokio::join!(down, up);
        });
        let tls = AnonTls::connect(TcpStream::connect(address).await.unwrap())
            .await
            .unwrap();
        let (mut reader, mut writer) = tls.into_split();
        let up = async {
            writer.write(&vec![0x5a; 65537]).await.unwrap();
        };
        let down = async {
            let mut bytes = Vec::new();
            let mut buf = [0; 4096];
            loop {
                let count = reader.read(&mut buf).await.unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buf[..count]);
            }
            assert_eq!(bytes, vec![0xa5; 65537]);
        };
        tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(up, down);
            server.await.unwrap();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn modified_records_are_terminal_and_truncation_releases_no_plaintext() {
        // Tamper only after a genuine handshake. No custom CBC code remains.
        for mode in 0..6 {
            let remote = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let remote_address = remote.local_addr().unwrap();
            let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let proxy_address = proxy.local_addr().unwrap();
            let (release, ready) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (io, _) = remote.accept().await.unwrap();
                let mut tls = test_accept(io).await;
                ready.await.unwrap();
                let _ = tls.write_all(&[0x42; 128]).await;
                tokio::time::sleep(Duration::from_millis(100)).await;
            });
            let pump = tokio::spawn(async move {
                let (local, _) = proxy.accept().await.unwrap();
                let upstream = TcpStream::connect(remote_address).await.unwrap();
                let (mut lr, mut lw) = local.into_split();
                let (mut rr, mut rw) = upstream.into_split();
                let up = tokio::io::copy(&mut lr, &mut rw);
                let down = async {
                    loop {
                        let mut header = [0; 5];
                        rr.read_exact(&mut header).await?;
                        let mut body = vec![0; u16::from_be_bytes([header[3], header[4]]) as usize];
                        rr.read_exact(&mut body).await?;
                        if header[0] == 23 {
                            match mode {
                                0 => body[16] ^= 1,                  // content/MAC corruption
                                1 => *body.last_mut().unwrap() ^= 1, // padding corruption
                                2 => header[0] = 99,
                                3 => header[3..].copy_from_slice(&u16::MAX.to_be_bytes()),
                                4 => {
                                    lw.write_all(&header).await?;
                                    lw.write_all(&body[..body.len() / 2]).await?;
                                    return Ok(());
                                }
                                _ => {
                                    lw.write_all(&header).await?;
                                    lw.write_all(&body).await?;
                                } // replay
                            }
                        }
                        lw.write_all(&header).await?;
                        lw.write_all(&body).await?;
                    }
                    #[allow(unreachable_code)]
                    Ok::<(), io::Error>(())
                };
                tokio::select! { _ = up => {}, _ = down => {} }
            });
            let mut tls = AnonTls::connect(TcpStream::connect(proxy_address).await.unwrap())
                .await
                .unwrap();
            release.send(()).unwrap();
            let error = tokio::time::timeout(Duration::from_secs(3), async {
                if mode == 5 {
                    tls.read_exact(&mut [0; 128]).await.unwrap();
                }
                tls.read_exact(&mut [0; 1]).await.unwrap_err()
            })
            .await
            .unwrap();
            if mode == 4 {
                // Dropping a partial record can arrive as a TCP reset on
                // Windows. It is still an error, never unauthenticated data.
                assert!(matches!(error, TlsError::Security | TlsError::Transport));
            } else {
                assert_eq!(error, TlsError::Security, "mode {mode}");
                assert_eq!(error.app_error().code, "integrity");
            }
            drop(tls);
            pump.abort();
            let _ = pump.await;
            server.await.unwrap();
        }
    }
}
