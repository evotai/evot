use axum::response::Html;
use axum::response::IntoResponse;
use axum::response::Redirect;
use axum::routing::get;
use axum::Router;

/// Embedded console assets need no application state. Keep imports and routes
/// together so new frontend modules do not expand the business HTTP server.
pub(super) fn router() -> Router {
    let mut router = Router::new()
        .route(
            "/models",
            get(|| async {
                Html(include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/assets/console/ui/models.html"
                )))
            }),
        )
        .route(
            "/feishu",
            get(|| async {
                Html(include_str!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/assets/console/ui/feishu.html"
                )))
            }),
        )
        .route("/", get(|| async { Redirect::to("/models") }))
        .route(
            "/settings",
            get(|| async { Redirect::permanent("/models") }),
        )
        .route(
            "/brand/icon.png",
            get(|| async {
                (
                    [
                        ("content-type", "image/png"),
                        ("cache-control", "public, max-age=604800"),
                    ],
                    include_bytes!(concat!(
                        env!("CARGO_MANIFEST_DIR"),
                        "/assets/console/brand/icon.png"
                    ))
                    .as_slice(),
                )
            }),
        );
    for (path, body) in [
        (
            "/ui/app.js",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/console/ui/app.js"
            )),
        ),
        (
            "/ui/json-client.js",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/console/ui/json-client.js"
            )),
        ),
        (
            "/ui/theme.js",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/console/ui/theme.js"
            )),
        ),
        (
            "/ui/rail.js",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/console/ui/rail.js"
            )),
        ),
        (
            "/ui/models.js",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/console/ui/models.js"
            )),
        ),
        (
            "/ui/feishu.js",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/console/ui/feishu.js"
            )),
        ),
    ] {
        router = router.route(
            path,
            get(move || async move { asset(body, "text/javascript; charset=utf-8") }),
        );
    }
    for (path, body) in [
        (
            "/ui/app.css",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/console/ui/app.css"
            )),
        ),
        (
            "/ui/theme.css",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/console/ui/theme.css"
            )),
        ),
        (
            "/ui/rail.css",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/console/ui/rail.css"
            )),
        ),
        (
            "/ui/trace-theme.css",
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/assets/console/ui/trace-theme.css"
            )),
        ),
    ] {
        router = router.route(
            path,
            get(move || async move { asset(body, "text/css; charset=utf-8") }),
        );
    }
    router
}

fn asset(body: &'static str, content_type: &'static str) -> impl IntoResponse {
    (
        [
            ("content-type", content_type),
            ("cache-control", "no-cache"),
        ],
        body,
    )
}
