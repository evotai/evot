use evot::command::parse_command;
use evot::command::Command;
use evot::search::SessionSearch;
use evot::search::DEFAULT_WINDOW_DAYS;

fn search(query: &str, window_days: Option<u32>) -> SessionSearch {
    SessionSearch {
        query: query.to_string(),
        window_days,
    }
}

#[test]
fn parse_defaults_to_one_week_and_strips_window_flags() {
    assert_eq!(
        SessionSearch::parse("github enterprise"),
        Some(search("github enterprise", Some(DEFAULT_WINDOW_DAYS)))
    );
    assert_eq!(
        SessionSearch::parse("--days 30 spill oom"),
        Some(search("spill oom", Some(30)))
    );
    assert_eq!(
        SessionSearch::parse("spill --since 2w oom"),
        Some(search("spill oom", Some(14)))
    );
    assert_eq!(
        SessionSearch::parse("--since=3m fts"),
        Some(search("fts", Some(90)))
    );
    assert_eq!(SessionSearch::parse("--all fts"), Some(search("fts", None)));
    assert_eq!(
        SessionSearch::parse("\"quoted query\""),
        Some(search("quoted query", Some(DEFAULT_WINDOW_DAYS)))
    );
}

#[test]
fn parse_rejects_empty_queries_and_malformed_windows() {
    assert_eq!(SessionSearch::parse(""), None);
    assert_eq!(SessionSearch::parse("--days 7"), None);
    assert_eq!(SessionSearch::parse("--days abc fts"), None);
    assert_eq!(SessionSearch::parse("--days 0 fts"), None);
    assert_eq!(SessionSearch::parse("--since 2x fts"), None);
}

#[test]
fn describe_window_names_common_windows() {
    assert_eq!(search("q", Some(7)).describe_window(), "last week");
    assert_eq!(search("q", Some(14)).describe_window(), "last 2 weeks");
    assert_eq!(search("q", Some(30)).describe_window(), "last month");
    assert_eq!(search("q", Some(10)).describe_window(), "last 10 days");
    assert_eq!(search("q", None).describe_window(), "all time");
}

#[test]
fn slash_sessions_with_a_query_is_a_prompt_command() {
    assert!(matches!(
        parse_command("/sessions --days 30 recluster"),
        Some(Command::SessionSearch(ref s)) if s.query == "recluster" && s.window_days == Some(30)
    ));
    assert!(matches!(
        parse_command("/sessions --days 30"),
        Some(Command::UsageError(_))
    ));
    // Bare `/sessions` stays a TUI command.
    assert!(parse_command("/sessions").is_none());
}
