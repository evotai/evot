use evot::agent::command::parse_command;
use evot::agent::command::Command;
use evot::session::search::SessionSearch;

fn search(query: &str) -> SessionSearch {
    SessionSearch {
        query: query.to_string(),
    }
}

#[test]
fn parse_keeps_the_whole_request_as_the_query() {
    assert_eq!(
        SessionSearch::parse("github enterprise"),
        Some(search("github enterprise"))
    );
    // Time phrases are not parsed here: the model reads them from the request.
    assert_eq!(
        SessionSearch::parse("最近半个月 小红书"),
        Some(search("最近半个月 小红书"))
    );
    assert_eq!(
        SessionSearch::parse("  spill oom in the last 2 weeks "),
        Some(search("spill oom in the last 2 weeks"))
    );
    assert_eq!(
        SessionSearch::parse("\"quoted query\""),
        Some(search("quoted query"))
    );
    assert_eq!(SessionSearch::parse("“中文引号”"), Some(search("中文引号")));
}

#[test]
fn parse_rejects_empty_queries() {
    assert_eq!(SessionSearch::parse(""), None);
    assert_eq!(SessionSearch::parse("   "), None);
    assert_eq!(SessionSearch::parse("\"\""), None);
}

#[test]
fn slash_sessions_with_a_request_is_a_prompt_command() {
    assert!(matches!(
        parse_command("/sessions recluster last month"),
        Some(Command::SessionSearch(ref s)) if s.query == "recluster last month"
    ));
    assert!(matches!(
        parse_command("/sessions \"\""),
        Some(Command::UsageError(_))
    ));
    // Bare `/sessions` stays a TUI command.
    assert!(parse_command("/sessions").is_none());
}
