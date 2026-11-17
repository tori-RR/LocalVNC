use windows::core::PWSTR;
use windows::Win32::Foundation::ERROR_NOT_FOUND;
use windows::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};

pub fn credential_target(server_id: &str) -> Result<String, String> {
    if server_id.is_empty()
        || server_id.len() > 64
        || !server_id
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() || ch == '-')
    {
        return Err("服务器标识不正确".to_string());
    }
    Ok(format!("LocalVNC/{server_id}"))
}

pub fn saved(server_id: &str) -> Result<bool, String> {
    let target = wide(&credential_target(server_id)?)?;
    let mut credential = std::ptr::null_mut();
    let result = unsafe {
        CredReadW(
            windows::core::PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            Some(0),
            &mut credential,
        )
    };
    match result {
        Ok(()) => {
            // Existence only: do not copy or decode CredentialBlob.
            unsafe { CredFree(credential.cast()) };
            Ok(true)
        }
        Err(error) if error.code() == ERROR_NOT_FOUND.into() => Ok(false),
        Err(_) => Err("检查已保存的密码失败".to_string()),
    }
}

pub fn read(server_id: &str) -> Result<String, String> {
    let target = wide(&credential_target(server_id)?)?;
    let mut credential = std::ptr::null_mut();
    let read = unsafe {
        CredReadW(
            windows::core::PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            Some(0),
            &mut credential,
        )
    };
    if let Err(error) = read {
        if error.code() == ERROR_NOT_FOUND.into() {
            return Err("没有已保存的密码".to_string());
        }
        return Err("读取已保存的密码失败".to_string());
    }
    let password = unsafe {
        let record = &*credential;
        if record.CredentialBlobSize == 0 {
            CredFree(credential.cast());
            return Ok(String::new());
        }
        let bytes =
            std::slice::from_raw_parts(record.CredentialBlob, record.CredentialBlobSize as usize);
        let password =
            String::from_utf8(bytes.to_vec()).map_err(|_| "已保存的密码无法读取".to_string());
        CredFree(credential.cast());
        password
    }?;
    Ok(password)
}

pub fn write(server_id: &str, password: &str) -> Result<(), String> {
    if password.len() > 1024 {
        return Err("密码太长".to_string());
    }
    let mut target = wide(&credential_target(server_id)?)?;
    let mut blob = password.as_bytes().to_vec();
    let mut comment = wide("LocalVNC")?;
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        Comment: PWSTR(comment.as_mut_ptr()),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: if blob.is_empty() {
            std::ptr::null_mut()
        } else {
            blob.as_mut_ptr()
        },
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        ..Default::default()
    };
    unsafe { CredWriteW(&credential, 0) }.map_err(|_| "保存密码失败".to_string())
}

pub fn forget(server_id: &str) -> Result<(), String> {
    let target = wide(&credential_target(server_id)?)?;
    let deleted = unsafe {
        CredDeleteW(
            windows::core::PCWSTR(target.as_ptr()),
            CRED_TYPE_GENERIC,
            Some(0),
        )
    };
    if let Err(error) = deleted {
        if error.code() == ERROR_NOT_FOUND.into() {
            return Ok(());
        }
        return Err("清除密码失败".to_string());
    }
    Ok(())
}

fn wide(text: &str) -> Result<Vec<u16>, String> {
    if text.contains('\0') {
        return Err("名称不正确".to_string());
    }
    let mut units: Vec<u16> = text.encode_utf16().collect();
    units.push(0);
    Ok(units)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Opt-in Windows credential integration test; never run by default"]
    fn round_trip_uses_credential_manager() {
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = forget(&self.0);
            }
        }
        let cleanup = Cleanup(crate::error::random_token());
        let id = &cleanup.0;
        write(id, "localvnc-test").unwrap();
        assert_eq!(read(id).unwrap(), "localvnc-test");
        assert!(saved(id).unwrap());
        write(id, "").unwrap();
        assert!(saved(id).unwrap());
        assert_eq!(read(id).unwrap(), "");
        forget(id).unwrap();
        assert!(!saved(id).unwrap());
    }

    #[test]
    fn target_uses_the_server_id() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(credential_target(id).unwrap(), format!("LocalVNC/{id}"));
        assert!(credential_target("../secret").is_err());
    }
}
