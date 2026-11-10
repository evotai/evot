//! End-to-end chain tests for the unified session addressing system.
//!
//! These tests simulate the full flow: locator construction → session resolution
//! → transcript accumulation → restart recovery. They verify the chain behavior,
//! not individual methods.

use std::sync::Arc;

use evot::session::storage::MemoryStorage;
use evot::session::Session;
use evot::session::SessionLocator;
use evot::types::AssistantBlock;
use evot::types::TranscriptItem;
use evot::types::UsageSummary;

#[test]
fn locator_identity_is_stable_and_scoped() {
    let a = SessionLocator::new("feishu", "chat:c1:user:u1");
    assert_eq!(
        a.session_id(),
        SessionLocator::new("feishu", "chat:c1:user:u1").session_id()
    );
    assert_ne!(
        a.session_id(),
        SessionLocator::new("feishu", "chat:c1:user:u2").session_id()
    );
    assert_ne!(
        a.session_id(),
        SessionLocator::new("slack", "chat:c1:user:u1").session_id()
    );
    assert_eq!(a.stable_key(), "feishu:chat:c1:user:u1");
    let id = a.session_id();
    assert!(id.starts_with("ch_"));
    assert_eq!(id.len(), 35);
    assert!(id[3..].chars().all(|c| c.is_ascii_hexdigit()));
}

fn text_item(text: &str) -> TranscriptItem {
    TranscriptItem::user_from_content(&[evot_engine::Content::Text {
        text: text.to_string(),
    }])
}

fn assistant_item(text: &str) -> TranscriptItem {
    TranscriptItem::Assistant {
        content: vec![AssistantBlock::Text {
            text: text.to_string(),
        }],
        stop_reason: "stop".to_string(),
        usage: UsageSummary::default(),
        model: String::new(),
        provider: String::new(),
        timestamp: 0,
        error_message: None,
    }
}

// ---------------------------------------------------------------------------
// Chain 1: Topic session — multiple messages in the same topic share one
// session and accumulate transcript across turns.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn topic_chain_messages_share_session_and_accumulate() {
    let storage: Arc<dyn evot::session::storage::Storage> = Arc::new(MemoryStorage::new());

    // Simulate: first topic reply has no thread_id from ws, but after API
    // fetch we get thread_id "omt_abc". Second reply has thread_id directly.
    // Both should produce the same locator.
    let thread_id = "omt_abc";
    let loc = SessionLocator::new("feishu", &format!("chat:c1:topic:{thread_id}"));

    // Turn 1: first message in topic
    let s1 = Session::open_or_create(&loc, "/tmp", "m", storage.clone())
        .await
        .expect("turn 1 session");
    let sid = s1.session_id().await;
    s1.write_items(vec![text_item("hello"), assistant_item("hi there")])
        .await
        .expect("write turn 1");
    s1.increment_turn().await;
    s1.save().await.expect("save turn 1");

    // Turn 2: second message in same topic — same locator
    let s2 = Session::open_or_create(&loc, "/tmp", "m", storage.clone())
        .await
        .expect("turn 2 session");
    assert_eq!(s2.session_id().await, sid, "same session");
    assert_eq!(s2.transcript().await.len(), 2, "transcript from turn 1");

    s2.write_items(vec![text_item("follow up"), assistant_item("got it")])
        .await
        .expect("write turn 2");
    s2.increment_turn().await;
    s2.save().await.expect("save turn 2");

    // Verify accumulated state
    let meta = s2.meta().await;
    assert_eq!(meta.turns, 2);
    assert_eq!(s2.transcript().await.len(), 4);
}

// ---------------------------------------------------------------------------
// Chain 2: DM session — non-topic messages use chat:user scope and persist
// across process restarts.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn dm_chain_persists_across_restart() {
    let storage: Arc<dyn evot::session::storage::Storage> = Arc::new(MemoryStorage::new());
    let loc = SessionLocator::new("feishu", "chat:c1:user:u1");

    // Turn 1: create session, write transcript
    {
        let session = Session::open_or_create(&loc, "/tmp", "m", storage.clone())
            .await
            .expect("create");
        session
            .write_items(vec![
                text_item("what is rust"),
                assistant_item("a language"),
            ])
            .await
            .expect("write");
        session.increment_turn().await;
        session.save().await.expect("save");
    }
    // Session dropped — simulates process restart

    // Turn 2: reopen via same locator — transcript should be restored
    let restored = Session::open_or_create(&loc, "/tmp", "m", storage.clone())
        .await
        .expect("restore");

    assert_eq!(restored.transcript().await.len(), 2);
    assert_eq!(restored.meta().await.turns, 1);

    // Continue conversation
    restored
        .write_items(vec![text_item("tell me more"), assistant_item("sure")])
        .await
        .expect("write turn 2");
    restored.increment_turn().await;
    restored.save().await.expect("save turn 2");

    assert_eq!(restored.transcript().await.len(), 4);
    assert_eq!(restored.meta().await.turns, 2);
}

// ---------------------------------------------------------------------------
// Chain 3: Topic isolation — different topics in the same chat produce
// different sessions with independent transcripts.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn different_topics_are_isolated() {
    let storage: Arc<dyn evot::session::storage::Storage> = Arc::new(MemoryStorage::new());

    let topic_a = SessionLocator::new("feishu", "chat:c1:topic:omt_aaa");
    let topic_b = SessionLocator::new("feishu", "chat:c1:topic:omt_bbb");

    // Write to topic A
    let sa = Session::open_or_create(&topic_a, "/tmp", "m", storage.clone())
        .await
        .expect("topic a");
    sa.write_items(vec![text_item("topic a msg")])
        .await
        .expect("write a");
    sa.save().await.expect("save a");

    // Write to topic B
    let sb = Session::open_or_create(&topic_b, "/tmp", "m", storage.clone())
        .await
        .expect("topic b");
    sb.write_items(vec![text_item("topic b msg")])
        .await
        .expect("write b");
    sb.save().await.expect("save b");

    // Verify isolation
    assert_ne!(sa.session_id().await, sb.session_id().await);
    assert_eq!(sa.transcript().await.len(), 1);
    assert_eq!(sb.transcript().await.len(), 1);

    // Reopen topic A — should only see topic A's transcript
    let sa2 = Session::open_or_create(&topic_a, "/tmp", "m", storage.clone())
        .await
        .expect("reopen a");
    assert_eq!(sa2.session_id().await, sa.session_id().await);
    assert_eq!(sa2.transcript().await.len(), 1);
}

// ---------------------------------------------------------------------------
// Chain 4: Topic vs DM isolation — topic messages and non-topic messages
// from the same user in the same chat use different sessions.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn topic_and_dm_are_isolated_in_same_chat() {
    let storage: Arc<dyn evot::session::storage::Storage> = Arc::new(MemoryStorage::new());

    let dm = SessionLocator::new("feishu", "chat:c1:user:u1");
    let topic = SessionLocator::new("feishu", "chat:c1:topic:omt_xyz");

    let s_dm = Session::open_or_create(&dm, "/tmp", "m", storage.clone())
        .await
        .expect("dm");
    s_dm.write_items(vec![text_item("dm msg 1"), assistant_item("dm reply")])
        .await
        .expect("write dm");
    s_dm.save().await.expect("save dm");

    let s_topic = Session::open_or_create(&topic, "/tmp", "m", storage.clone())
        .await
        .expect("topic");
    s_topic
        .write_items(vec![
            text_item("topic msg 1"),
            assistant_item("topic reply"),
        ])
        .await
        .expect("write topic");
    s_topic.save().await.expect("save topic");

    // Different sessions
    assert_ne!(s_dm.session_id().await, s_topic.session_id().await);

    // Each has its own transcript
    assert_eq!(s_dm.transcript().await.len(), 2);
    assert_eq!(s_topic.transcript().await.len(), 2);
}

// ---------------------------------------------------------------------------
// Chain 5: Locator determinism — the same scope always produces the same
// session ID, even across different SessionLocator instances.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn locator_determinism_across_instances() {
    let storage: Arc<dyn evot::session::storage::Storage> = Arc::new(MemoryStorage::new());

    // Create session with one locator instance
    let loc1 = SessionLocator::new("feishu", "chat:c1:topic:omt_stable");
    let s1 = Session::open_or_create(&loc1, "/tmp", "m", storage.clone())
        .await
        .expect("create");
    s1.write_items(vec![text_item("msg 1")])
        .await
        .expect("write");
    s1.save().await.expect("save");

    // Construct a completely new locator with the same parameters
    let loc2 = SessionLocator::new("feishu", "chat:c1:topic:omt_stable");
    let s2 = Session::open_or_create(&loc2, "/tmp", "m", storage.clone())
        .await
        .expect("reopen");

    assert_eq!(s1.session_id().await, s2.session_id().await);
    assert_eq!(s2.transcript().await.len(), 1);
}
