mod address;
mod bridge;
mod config;
mod credentials;
mod error;
mod pve;
mod pve_trust;
mod secrets;
mod session;
mod ssh;
mod tlsanon;
mod vencrypt;

#[cfg(test)]
mod f08_fixture;

use error::AppError;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Manager, State};

struct AppState {
    sessions: session::SessionManager,
    ssh: ssh::SshManager,
    credentials: Arc<credentials::CredentialService>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PveRequest {
    session_id: String,
    origin: String,
    node: String,
    vmid: u32,
    username: String,
    password: String,
    insecure: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectRequest {
    session_id: String,
    address: String,
    security_policy: vencrypt::SecurityPolicy,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    url: String,
    password: String,
}

#[tauri::command]
fn begin_session(state: State<'_, AppState>) -> String {
    state.sessions.begin()
}

#[tauri::command]
async fn connect_pve(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: PveRequest,
) -> Result<SessionResponse, AppError> {
    let trusted_ca = pve_trust::load(&request.origin)?;
    let session = state
        .sessions
        .run(
            &request.session_id,
            pve::open_console(
                &request.origin,
                &request.node,
                request.vmid,
                &request.username,
                &request.password,
                request.insecure,
                trusted_ca.as_deref(),
            ),
        )
        .await?;
    let bridge = bridge::serve_pve(
        Some(app),
        request.session_id.clone(),
        session.websocket_url,
        session.cookie,
        request.insecure,
        trusted_ca,
    )
    .await?;
    let url = bridge.local_url();
    state.sessions.publish(&request.session_id, bridge)?;
    Ok(SessionResponse {
        url,
        password: session.vnc_password,
    })
}

#[tauri::command]
async fn connect_direct(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request: DirectRequest,
) -> Result<SessionResponse, AppError> {
    let endpoint = address::parse(&request.address)
        .map_err(|error| AppError::new("address", "invalid_address", error))?;
    let bridge = state
        .sessions
        .run(
            &request.session_id,
            bridge::serve_vnc(
                Some(app),
                request.session_id.clone(),
                endpoint.host,
                endpoint.port,
                request.security_policy,
            ),
        )
        .await?;
    let url = bridge.local_url();
    state.sessions.publish(&request.session_id, bridge)?;
    Ok(SessionResponse {
        url,
        password: String::new(),
    })
}

#[tauri::command]
fn disconnect(state: State<'_, AppState>, session_id: String) {
    state.sessions.stop(&session_id);
}

#[tauri::command]
async fn ssh_connect(
    state: State<'_, AppState>,
    request: ssh::SshRequest,
    on_event: tauri::ipc::Channel<ssh::SshEvent>,
) -> Result<(), AppError> {
    state.ssh.connect(request, on_event).await
}

#[tauri::command]
async fn ssh_write(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), AppError> {
    state.ssh.write(&session_id, data).await
}

#[tauri::command]
fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), AppError> {
    state.ssh.resize(&session_id, cols, rows)
}

#[tauri::command]
fn ssh_ack(state: State<'_, AppState>, session_id: String, bytes: usize) -> Result<(), AppError> {
    state.ssh.acknowledge(&session_id, bytes)
}

#[tauri::command]
fn ssh_disconnect(state: State<'_, AppState>, session_id: String) {
    state.ssh.disconnect(&session_id);
}

// Config fsync and Credential Manager calls can stall; keep them off the
// main thread so the WebView stays responsive.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "后台任务意外中止".to_string())?
}

#[tauri::command]
async fn load_config(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let service = state.credentials.clone();
    blocking(move || {
        service
            .configuration(config::load)
            .map(|(config, _)| config)
    })
    .await
}

#[tauri::command]
async fn save_config(
    state: State<'_, AppState>,
    config: serde_json::Value,
) -> Result<std::collections::HashMap<String, String>, String> {
    let service = state.credentials.clone();
    blocking(move || {
        service
            .configuration(|| {
                config::save(config.clone())?;
                Ok(config)
            })
            .map(|(_, generations)| generations)
    })
    .await
}

#[tauri::command]
async fn password_saved(server_id: String) -> Result<bool, String> {
    blocking(move || secrets::saved(&server_id)).await
}

#[tauri::command]
async fn load_password(server_id: String) -> Result<String, String> {
    blocking(move || secrets::read(&server_id)).await
}

#[tauri::command]
async fn credential_generation(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<String, String> {
    let service = state.credentials.clone();
    blocking(move || service.generation(&server_id)).await
}

#[tauri::command]
async fn save_password(
    state: State<'_, AppState>,
    server_id: String,
    generation: String,
    password: String,
) -> Result<(), String> {
    let service = state.credentials.clone();
    blocking(move || service.put(&server_id, &generation, &password)).await
}

#[tauri::command]
async fn forget_password(state: State<'_, AppState>, server_id: String) -> Result<(), String> {
    let service = state.credentials.clone();
    blocking(move || service.forget(&server_id)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            sessions: session::SessionManager::default(),
            ssh: ssh::SshManager::default(),
            credentials: Arc::new(credentials::CredentialService::default()),
        })
        .invoke_handler(tauri::generate_handler![
            begin_session,
            connect_pve,
            connect_direct,
            disconnect,
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_ack,
            ssh_disconnect,
            load_config,
            save_config,
            password_saved,
            load_password,
            credential_generation,
            save_password,
            forget_password
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<AppState>().ssh.shutdown();
            }
        });
}
