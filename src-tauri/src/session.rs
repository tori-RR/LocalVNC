use crate::{
    bridge::RunningBridge,
    error::{random_token, AppError},
};
use std::{future::Future, sync::Mutex};
use tokio::sync::watch;

#[derive(Default)]
pub struct SessionManager {
    current: Mutex<Option<Session>>,
}

struct Session {
    id: String,
    cancel: watch::Sender<bool>,
    bridge: Option<RunningBridge>,
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.cancel.send(true);
    }
}

impl SessionManager {
    pub fn begin(&self) -> String {
        let id = random_token();
        let (cancel, _) = watch::channel(false);
        *self.current.lock().expect("session lock") = Some(Session {
            id: id.clone(),
            cancel,
            bridge: None,
        });
        id
    }

    pub async fn run<T>(
        &self,
        id: &str,
        work: impl Future<Output = Result<T, AppError>>,
    ) -> Result<T, AppError> {
        let mut cancelled = {
            let current = self.current.lock().expect("session lock");
            current
                .as_ref()
                .filter(|session| session.id == id)
                .ok_or_else(AppError::cancelled)?
                .cancel
                .subscribe()
        };
        tokio::select! {
            biased;
            _ = cancelled.changed() => Err(AppError::cancelled()),
            result = work => result,
        }
    }

    pub fn publish(&self, id: &str, bridge: RunningBridge) -> Result<(), AppError> {
        let mut current = self.current.lock().expect("session lock");
        let session = current
            .as_mut()
            .filter(|session| session.id == id)
            .ok_or_else(AppError::cancelled)?;
        session.bridge = Some(bridge);
        Ok(())
    }

    pub fn stop(&self, id: &str) {
        let mut current = self.current.lock().expect("session lock");
        if current.as_ref().is_some_and(|session| session.id == id) {
            current.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stale_work_and_disconnect_cannot_replace_new_session() {
        let manager = SessionManager::default();
        let a = manager.begin();
        let pending = manager.run(&a, std::future::pending::<Result<(), AppError>>());
        tokio::pin!(pending);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(10), &mut pending)
                .await
                .is_err()
        );
        let b = manager.begin();
        assert_eq!(pending.await.unwrap_err().code, "cancelled");
        manager.stop(&a);
        assert_eq!(manager.run(&b, async { Ok(42) }).await.unwrap(), 42);
        assert_eq!(
            manager.run(&a, async { Ok(()) }).await.unwrap_err().code,
            "cancelled"
        );
        manager.stop(&b);
        assert_eq!(
            manager.run(&b, async { Ok(()) }).await.unwrap_err().code,
            "cancelled"
        );
    }
}
