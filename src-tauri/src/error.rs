use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub stage: &'static str,
    pub code: &'static str,
    pub safe_message: String,
}

impl AppError {
    pub fn new(stage: &'static str, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            stage,
            code,
            safe_message: message.into(),
        }
    }

    pub fn cancelled() -> Self {
        Self::new("session", "cancelled", "连接已取消")
    }
}

pub fn random_token() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
