//! Serialize credential side effects together with durable binding changes.
//! A generation is a short-lived capability, never persisted in user config.
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
};

pub trait CredentialStore: Send + Sync {
    fn put(&self, id: &str, password: &str) -> Result<(), String>;
    fn forget(&self, id: &str) -> Result<(), String>;
}

pub struct WindowsStore;
impl CredentialStore for WindowsStore {
    fn put(&self, id: &str, password: &str) -> Result<(), String> {
        crate::secrets::write(id, password)
    }
    fn forget(&self, id: &str) -> Result<(), String> {
        crate::secrets::forget(id)
    }
}

pub struct CredentialService<B = WindowsStore> {
    generations: Mutex<HashMap<String, String>>,
    backend: B,
}

impl Default for CredentialService {
    fn default() -> Self {
        Self::new(WindowsStore)
    }
}

impl<B: CredentialStore> CredentialService<B> {
    pub fn new(backend: B) -> Self {
        Self {
            generations: Mutex::new(HashMap::new()),
            backend,
        }
    }

    pub fn configuration(
        &self,
        commit: impl FnOnce() -> Result<Value, String>,
    ) -> Result<(Value, HashMap<String, String>), String> {
        let mut generations = self.generations.lock().map_err(|_| "凭据服务不可用")?;
        // A failed durable commit must not revoke the old binding or password.
        let config = commit()?;
        let ids: HashSet<String> = config
            .get("servers")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|server| server.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect();
        generations.retain(|id, _| ids.contains(id));
        for id in ids {
            generations
                .entry(id)
                .or_insert_with(crate::error::random_token);
        }
        Ok((config, generations.clone()))
    }

    pub fn generation(&self, id: &str) -> Result<String, String> {
        crate::secrets::credential_target(id)?;
        self.generations
            .lock()
            .map_err(|_| "凭据服务不可用")?
            .get(id)
            .cloned()
            .ok_or_else(|| "服务器凭据绑定已失效".to_string())
    }

    pub fn put(&self, id: &str, generation: &str, password: &str) -> Result<(), String> {
        crate::secrets::credential_target(id)?;
        let generations = self.generations.lock().map_err(|_| "凭据服务不可用")?;
        if generations.get(id).map(String::as_str) != Some(generation) {
            return Err("凭据保存授权已失效，请重新连接后保存".into());
        }
        // Called only on blocking workers. Hold the ordering boundary until
        // CredWriteW finishes, so Forget cannot return before an accepted Put.
        self.backend.put(id, password)
    }

    pub fn forget(&self, id: &str) -> Result<(), String> {
        crate::secrets::credential_target(id)?;
        let mut generations = self.generations.lock().map_err(|_| "凭据服务不可用")?;
        if let Some(generation) = generations.get_mut(id) {
            *generation = crate::error::random_token();
        }
        // Rotate even on delete failure; stale auth callbacks must not overwrite
        // the user's explicit clear intent. Explicit new sessions can save again.
        self.backend.forget(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar,
    };
    const ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    #[derive(Default)]
    struct FakeStore {
        values: Mutex<HashMap<String, String>>,
        gate: (Mutex<(bool, bool)>, Condvar),
        fail_put: AtomicBool,
        fail_forget: AtomicBool,
    }
    impl CredentialStore for Arc<FakeStore> {
        fn put(&self, id: &str, password: &str) -> Result<(), String> {
            if self.fail_put.load(Ordering::SeqCst) {
                return Err("TEST write failure".into());
            }
            let (lock, changed) = &self.gate;
            let mut gate = lock.lock().unwrap();
            gate.0 = true;
            changed.notify_all();
            while gate.1 {
                gate = changed.wait(gate).unwrap();
            }
            self.values
                .lock()
                .unwrap()
                .insert(id.into(), password.into());
            Ok(())
        }
        fn forget(&self, id: &str) -> Result<(), String> {
            if self.fail_forget.load(Ordering::SeqCst) {
                return Err("TEST delete failure".into());
            }
            self.values.lock().unwrap().remove(id);
            Ok(())
        }
    }
    fn configured() -> (Arc<CredentialService<Arc<FakeStore>>>, Arc<FakeStore>) {
        let backend = Arc::new(FakeStore::default());
        let service = Arc::new(CredentialService::new(backend.clone()));
        service
            .configuration(|| Ok(serde_json::json!({"servers":[{"id":ID}]})))
            .unwrap();
        (service, backend)
    }
    #[test]
    fn forget_waits_for_accepted_put_and_rejects_late_put() {
        let (service, backend) = configured();
        let generation = service.generation(ID).unwrap();
        backend.gate.0.lock().unwrap().1 = true;
        let save = {
            let service = service.clone();
            let generation = generation.clone();
            std::thread::spawn(move || service.put(ID, &generation, "SYNTHETIC"))
        };
        let mut gate = backend.gate.0.lock().unwrap();
        while !gate.0 {
            gate = backend.gate.1.wait(gate).unwrap();
        }
        drop(gate);
        let clear = {
            let service = service.clone();
            std::thread::spawn(move || service.forget(ID))
        };
        backend.gate.0.lock().unwrap().1 = false;
        backend.gate.1.notify_all();
        save.join().unwrap().unwrap();
        clear.join().unwrap().unwrap();
        assert!(!backend.values.lock().unwrap().contains_key(ID));
        assert!(service.put(ID, &generation, "STALE").is_err());
        assert!(!backend.values.lock().unwrap().contains_key(ID));
        service
            .put(ID, &service.generation(ID).unwrap(), "NEW_SESSION")
            .unwrap();
    }
    #[test]
    fn durable_removal_revokes_binding_but_failed_commit_preserves_it() {
        let (service, backend) = configured();
        let generation = service.generation(ID).unwrap();
        service.put(ID, &generation, "SYNTHETIC").unwrap();
        assert!(service
            .configuration(|| Err("TEST save failure".into()))
            .is_err());
        assert_eq!(service.generation(ID).unwrap(), generation);
        assert!(backend.values.lock().unwrap().contains_key(ID));
        service
            .configuration(|| Ok(serde_json::json!({"servers":[]})))
            .unwrap();
        assert!(service.put(ID, &generation, "STALE").is_err());
        service.forget(ID).unwrap();
        assert!(backend.values.lock().unwrap().is_empty());
        service
            .configuration(|| Ok(serde_json::json!({"servers":[{"id":ID}]})))
            .unwrap();
        assert_ne!(service.generation(ID).unwrap(), generation);
        assert!(service.put(ID, &generation, "STALE").is_err());
    }
    #[test]
    fn empty_value_is_an_explicit_put_not_a_delete() {
        let (service, backend) = configured();
        service
            .put(ID, &service.generation(ID).unwrap(), "")
            .unwrap();
        assert_eq!(
            backend.values.lock().unwrap().get(ID).map(String::as_str),
            Some("")
        );
        service.forget(ID).unwrap();
        assert!(backend.values.lock().unwrap().is_empty());
    }

    #[test]
    fn failed_delete_still_revokes_stale_writes_and_failed_put_keeps_previous_value() {
        let (service, backend) = configured();
        let generation = service.generation(ID).unwrap();
        service.put(ID, &generation, "OLD").unwrap();
        backend.fail_put.store(true, Ordering::SeqCst);
        assert!(service.put(ID, &generation, "NEW").is_err());
        assert_eq!(backend.values.lock().unwrap().get(ID).unwrap(), "OLD");
        backend.fail_put.store(false, Ordering::SeqCst);
        backend.fail_forget.store(true, Ordering::SeqCst);
        assert!(service.forget(ID).is_err());
        assert_ne!(service.generation(ID).unwrap(), generation);
        assert!(service.put(ID, &generation, "STALE").is_err());
        backend.fail_forget.store(false, Ordering::SeqCst);
        service.forget(ID).unwrap();
        assert!(backend.values.lock().unwrap().is_empty());
    }
}
