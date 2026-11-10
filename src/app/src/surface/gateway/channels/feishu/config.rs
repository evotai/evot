//! Feishu transport constants. The channel's configuration schema lives in
//! `conf::channels` — the config layer owns it, this module consumes it.

pub const FEISHU_API: &str = "https://open.feishu.cn/open-apis";
pub const FEISHU_MAX_MESSAGE_LEN: usize = 30_000;
