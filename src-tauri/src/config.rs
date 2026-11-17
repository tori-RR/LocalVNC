use crate::error::random_token;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

static STORE: Mutex<Option<ConfigStore>> = Mutex::new(None);
const MAX_CONFIG: u64 = 4 * 1024 * 1024;

pub fn config_file(documents: &Path) -> PathBuf {
    documents.join("localVNC").join("config.json")
}

struct ConfigStore {
    path: PathBuf,
    expected: Option<Vec<u8>>,
    _lock: File,
}

impl ConfigStore {
    fn open(path: PathBuf) -> Result<(Self, Value), String> {
        fs::create_dir_all(path.parent().ok_or("配置路径不正确")?)
            .map_err(|_| "无法创建配置目录")?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0);
        }
        let lock = options
            .open(path.with_extension("lock"))
            .map_err(|_| "配置正由另一实例使用，或目录不可写")?;
        let expected = read_bytes(&path)?;
        if expected.is_none() && path.with_extension("json.bak").exists() {
            return Err("配置文件缺失但备份存在，请恢复 config.json.bak 后重新打开应用".into());
        }
        let mut config = match &expected {
            Some(bytes) => parse_config(bytes)?,
            None => default_config(),
        };
        strip_secrets(&mut config);
        Ok((
            Self {
                path,
                expected,
                _lock: lock,
            },
            config,
        ))
    }

    fn save(&mut self, mut config: Value) -> Result<(), String> {
        strip_secrets(&mut config);
        validate(&config)?;
        if read_bytes(&self.path)? != self.expected {
            return Err("配置已被其他程序修改，已停止覆盖，请重新打开应用".into());
        }
        let bytes = serde_json::to_vec_pretty(&config).map_err(|_| "配置无法编码")?;
        if bytes.len() as u64 > MAX_CONFIG {
            return Err("配置超过大小限制".into());
        }
        if let Some(previous) = &self.expected {
            // The prior complete version is durable before publishing the next one.
            write_replace(&self.path.with_extension("json.bak"), previous)?;
        }
        write_replace(&self.path, &bytes)?;
        self.expected = Some(bytes);
        Ok(())
    }
}

pub fn load() -> Result<Value, String> {
    let mut slot = STORE.lock().map_err(|_| "配置锁不可用")?;
    if let Some(store) = slot.as_ref() {
        return match &store.expected {
            Some(bytes) => parse_config(bytes),
            None => Ok(default_config()),
        };
    }
    let path = config_file(&dirs::document_dir().ok_or("找不到文档文件夹")?);
    let (store, config) = ConfigStore::open(path)?;
    *slot = Some(store);
    Ok(config)
}

pub fn save(config: Value) -> Result<(), String> {
    STORE
        .lock()
        .map_err(|_| "配置锁不可用")?
        .as_mut()
        .ok_or("配置未成功加载，已阻止覆盖")?
        .save(config)
}

fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("读取配置失败".into()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取配置失败")?;
    if bytes.len() as u64 > MAX_CONFIG {
        return Err("配置超过大小限制".into());
    }
    Ok(Some(bytes))
}

fn parse_config(bytes: &[u8]) -> Result<Value, String> {
    let mut config: Value = serde_json::from_slice(bytes)
        .map_err(|_| "配置 JSON 损坏，原文件已保留；请检查 config.json.bak")?;
    validate(&config)?;
    strip_secrets(&mut config);
    Ok(config)
}

fn validate(config: &Value) -> Result<(), String> {
    if !config.is_object()
        || !config.get("servers").is_some_and(Value::is_array)
        || config
            .get("schemaVersion")
            .is_some_and(|version| version != 1)
    {
        return Err("配置格式或版本不受支持，原文件已保留".into());
    }
    Ok(())
}

fn default_config() -> Value {
    json!({"schemaVersion":1,"servers":[],"settings":{"scaleToWindow":true,"viewOnly":false,"shared":true},"selectedId":""})
}

fn write_replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", random_token()));
    let write = || -> Result<(), String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| "创建临时配置失败")?;
        file.write_all(bytes).map_err(|_| "写入临时配置失败")?;
        file.sync_all().map_err(|_| "配置同步失败")?;
        drop(file);
        replace_file(&temp, path)
    };
    let result = write();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        },
    };
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    // Same-directory rename only; COPY_ALLOWED is deliberately absent.
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(target.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|_| "替换配置失败，原配置或备份已保留".into())
}
#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|_| "替换配置失败".into())
}

fn strip_secrets(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|key, _| key != "password" && key != "vncPassword");
            for child in map.values_mut() {
                strip_secrets(child);
            }
        }
        Value::Array(items) => {
            for child in items {
                strip_secrets(child);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("localvnc-config-test-{}", random_token()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> PathBuf {
            self.0.join("config.json")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn preserves_previous_complete_config_and_refuses_external_overwrite() {
        let fixture = Fixture::new();
        let (mut store, mut config) = ConfigStore::open(fixture.path()).unwrap();
        store.save(config.clone()).unwrap();
        let first = fs::read(fixture.path()).unwrap();
        config["selectedId"] = json!("changed");
        store.save(config).unwrap();
        assert_eq!(
            fs::read(fixture.path().with_extension("json.bak")).unwrap(),
            first
        );
        fs::write(fixture.path(), b"external").unwrap();
        assert!(store.save(default_config()).is_err());
        assert_eq!(fs::read(fixture.path()).unwrap(), b"external");
    }
    #[test]
    fn corrupt_or_missing_with_backup_is_never_reset() {
        let fixture = Fixture::new();
        fs::write(fixture.path(), b"{broken").unwrap();
        assert!(ConfigStore::open(fixture.path()).is_err());
        assert_eq!(fs::read(fixture.path()).unwrap(), b"{broken");
        fs::rename(fixture.path(), fixture.path().with_extension("json.bak")).unwrap();
        assert!(ConfigStore::open(fixture.path()).is_err());
        assert!(!fixture.path().exists());
    }
    #[test]
    fn second_writer_is_rejected_and_failed_replace_keeps_old_file() {
        let fixture = Fixture::new();
        let (mut store, config) = ConfigStore::open(fixture.path()).unwrap();
        store.save(config).unwrap();
        assert!(ConfigStore::open(fixture.path()).is_err());
        let old = fs::read(fixture.path()).unwrap();
        assert!(replace_file(&fixture.0.join("absent.tmp"), &fixture.path()).is_err());
        assert_eq!(fs::read(fixture.path()).unwrap(), old);
    }
    #[test]
    fn secrets_are_removed_recursively() {
        let mut config =
            json!({"servers":[{"password":"secret","nested":{"vncPassword":"ticket"}}]});
        strip_secrets(&mut config);
        assert!(config["servers"][0].get("password").is_none());
        assert!(config["servers"][0]["nested"].get("vncPassword").is_none());
    }
}
