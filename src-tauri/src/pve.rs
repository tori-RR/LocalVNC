use std::time::Duration;

use crate::error::AppError;
use serde::Deserialize;
use serde_json::Value;

pub struct PveSession {
    pub websocket_url: String,
    pub cookie: String,
    pub vnc_password: String,
}

pub async fn open_console(
    origin: &str,
    node: &str,
    vmid: u32,
    username: &str,
    password: &str,
    insecure: bool,
    trusted_ca: Option<&[u8]>,
) -> Result<PveSession, AppError> {
    let invalid = |message| AppError::new("address", "invalid_address", message);
    let origin = normalize_origin(origin).map_err(invalid)?;
    let node = normalize_node(node).map_err(invalid)?;
    if vmid == 0 {
        return Err(invalid("VMID 不正确".to_string()));
    }
    let username = username.trim();
    if username.is_empty() || username.len() > 128 {
        return Err(invalid("用户名不正确".to_string()));
    }

    let client = http_client(insecure, trusted_ca)?;

    let login = client
        .post(format!("{origin}/api2/json/access/ticket"))
        .form(&[("username", username), ("password", password)])
        .send()
        .await
        .map_err(|error| request_error("pve_login", &error))?;
    let auth: AuthTicket = read_api(login, "pve_login").await?;

    let proxy = client
        .post(format!(
            "{origin}/api2/json/nodes/{node}/qemu/{vmid}/vncproxy"
        ))
        .header("CSRFPreventionToken", &auth.csrf)
        .header("Cookie", format!("PVEAuthCookie={}", auth.ticket))
        .form(&[("websocket", "1")])
        .send()
        .await
        .map_err(|error| request_error("pve_proxy", &error))?;
    let console: VncProxy = read_api(proxy, "pve_proxy").await?;
    let port = console
        .port
        .parse::<u16>()
        .map_err(|_| AppError::new("pve_proxy", "invalid_response", "PVE 没有返回可用端口"))?;
    if !(5900..=5999).contains(&port) {
        return Err(AppError::new(
            "pve_proxy",
            "invalid_response",
            "PVE 返回的端口不在控制台范围内",
        ));
    }

    Ok(PveSession {
        websocket_url: vnc_websocket_url(&origin, &node, vmid, port, &console.ticket),
        cookie: auth.ticket,
        vnc_password: console.ticket,
    })
}

pub(crate) fn http_client(
    insecure: bool,
    trusted_ca: Option<&[u8]>,
) -> Result<reqwest::Client, AppError> {
    let mut builder = reqwest::Client::builder()
        .danger_accept_invalid_certs(insecure)
        .danger_accept_invalid_hostnames(insecure)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(20));
    if let Some(pem) = trusted_ca {
        let certificate = reqwest::Certificate::from_pem(pem)
            .map_err(|_| AppError::new("pve_tls", "invalid_ca", "PVE CA 证书格式不正确"))?;
        builder = builder.add_root_certificate(certificate);
    }
    builder
        .build()
        .map_err(|_| AppError::new("pve_login", "client", "无法创建 PVE 连接"))
}

pub fn normalize_origin(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    let lower = trimmed.to_ascii_lowercase();
    let with_scheme = if lower.starts_with("https://") || lower.starts_with("http://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = reqwest::Url::parse(&with_scheme).map_err(|_| "PVE 地址不正确".to_string())?;
    if url.scheme() != "https" {
        return Err("PVE 地址需要 https，以保护登录密码".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("PVE 地址里不要写用户名或密码".to_string());
    }
    if url.host_str().is_none() {
        return Err("PVE 地址不正确".to_string());
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("PVE 地址只填写主机，不要带路径".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("PVE 地址不正确".to_string());
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

pub fn normalize_node(value: &str) -> Result<String, String> {
    let node = value.trim();
    let ok = !node.is_empty()
        && node.len() <= 63
        && node
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_');
    if ok {
        Ok(node.to_string())
    } else {
        Err("节点名不正确".to_string())
    }
}

pub fn vnc_websocket_url(origin: &str, node: &str, vmid: u32, port: u16, ticket: &str) -> String {
    let ws_origin = if let Some(rest) = origin.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = origin.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        format!("wss://{origin}")
    };
    format!(
        "{ws_origin}/api2/json/nodes/{node}/qemu/{vmid}/vncwebsocket?port={port}&vncticket={}",
        urlencoding::encode(ticket)
    )
}

#[derive(Deserialize)]
struct ApiResponse<T> {
    data: T,
}

#[derive(Deserialize)]
struct AuthTicket {
    ticket: String,
    #[serde(rename = "CSRFPreventionToken")]
    csrf: String,
}

#[derive(Deserialize)]
struct VncProxy {
    ticket: String,
    #[serde(deserialize_with = "port_as_string")]
    port: String,
}

fn port_as_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(text) => Ok(text),
        Value::Number(number) => Ok(number.to_string()),
        _ => Err(serde::de::Error::custom("port")),
    }
}

async fn read_api<T: serde::de::DeserializeOwned>(
    mut response: reqwest::Response,
    stage: &'static str,
) -> Result<T, AppError> {
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(stage, status.as_u16()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| request_error(stage, &error))?
    {
        if body.len() + chunk.len() > 64 * 1024 {
            return Err(AppError::new(
                stage,
                "response_too_large",
                "PVE 响应超过大小限制",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let parsed: ApiResponse<T> = serde_json::from_slice(&body)
        .map_err(|_| AppError::new(stage, "invalid_response", "PVE 的响应无法识别"))?;
    Ok(parsed.data)
}

fn request_error(stage: &'static str, error: &reqwest::Error) -> AppError {
    if error.is_timeout() {
        AppError::new(stage, "timeout", "PVE 请求超时")
    } else {
        AppError::new(
            stage,
            "transport",
            "PVE 连接失败，请检查地址、网络及证书信任",
        )
    }
}

fn status_error(stage: &'static str, status: u16) -> AppError {
    let (code, message) = match status {
        401 => ("unauthorized", "PVE 登录失效或用户名、密码不正确"),
        403 => ("forbidden", "PVE 用户没有访问此控制台的权限"),
        _ => ("http_status", "PVE 请求失败"),
    };
    AppError::new(stage, code, format!("{message}（HTTP {status}）"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_frontend_backend_origin_matrix() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/pve-origins.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let input = case["input"].as_str().unwrap();
            if let Some(expected) = case["expected"].as_str() {
                assert_eq!(normalize_origin(input).unwrap(), expected, "{input}");
            } else {
                assert!(normalize_origin(input).is_err(), "{input}");
            }
        }
    }

    #[test]
    fn origin_adds_https_and_rejects_paths() {
        assert_eq!(
            normalize_origin("192.0.2.5:8006").unwrap(),
            "https://192.0.2.5:8006"
        );
        assert!(normalize_origin("https://pve.example:8006/api2").is_err());
        assert!(normalize_origin("http://pve.example:8006").is_err());
    }

    #[test]
    fn http_errors_have_safe_distinct_categories() {
        assert_eq!(status_error("pve_login", 401).code, "unauthorized");
        assert_eq!(status_error("pve_proxy", 403).code, "forbidden");
        assert_eq!(status_error("pve_proxy", 500).code, "http_status");
    }

    #[test]
    fn websocket_url_encodes_ticket_once() {
        let url = vnc_websocket_url(
            "https://pve.example:8006",
            "pve",
            100,
            5900,
            "PVEVNC:abc+def=",
        );
        assert!(
            url.starts_with("wss://pve.example:8006/api2/json/nodes/pve/qemu/100/vncwebsocket?")
        );
        assert!(url.contains("vncticket=PVEVNC%3Aabc%2Bdef%3D"));
        assert!(!url.contains("vncticket=PVEVNC%253A"));
    }
}
