use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use evot::base::error::EvotError;
use evot::surface::automation::lease::guard;
use tokio_util::sync::CancellationToken;

type TestResult = Result<(), Box<dyn std::error::Error>>;

#[tokio::test]
async fn rejected_initial_lease_never_polls_work() {
    let side_effects = AtomicUsize::new(0);
    let result = guard(
        async {
            side_effects.fetch_add(1, Ordering::SeqCst);
        },
        || async { Err(EvotError::Run("lease rejected".into())) },
        CancellationToken::new(),
        Duration::from_millis(1),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(side_effects.load(Ordering::SeqCst), 0);
}

struct Aborted(Arc<AtomicUsize>);
impl Drop for Aborted {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn lost_lease_drops_work_before_delivery() {
    let beats = AtomicUsize::new(0);
    let dropped = Arc::new(AtomicUsize::new(0));
    let delivery = AtomicUsize::new(0);
    let result = guard(
        async {
            let _abort_on_drop = Aborted(dropped.clone());
            std::future::pending::<()>().await;
            delivery.fetch_add(1, Ordering::SeqCst);
        },
        || async {
            if beats.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(())
            } else {
                Err(EvotError::Run("renewal rejected".into()))
            }
        },
        CancellationToken::new(),
        Duration::from_millis(1),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
    assert_eq!(delivery.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn renewals_continue_during_delivery_and_reporting() -> TestResult {
    let beats = AtomicUsize::new(0);
    let result = guard(
        async {
            tokio::time::sleep(Duration::from_millis(15)).await;
            tokio::time::sleep(Duration::from_millis(15)).await;
            "reported"
        },
        || async {
            beats.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
        CancellationToken::new(),
        Duration::from_millis(1),
    )
    .await?;
    assert_eq!(result, "reported");
    assert!(beats.load(Ordering::SeqCst) > 2);
    Ok(())
}

#[tokio::test]
async fn cancellation_interrupts_a_hung_renewal() -> TestResult {
    let cancel = CancellationToken::new();
    let child = cancel.clone();
    let run = guard(
        async {},
        std::future::pending,
        child,
        Duration::from_secs(30),
    );
    let (result, _) = tokio::join!(run, async {
        tokio::task::yield_now().await;
        cancel.cancel();
    });
    assert!(result.is_err());
    Ok(())
}
