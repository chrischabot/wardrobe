//! Offline smoke test against the local harness (the Forge planes,
//! in-process): the application boots and answers its public health route,
//! and refuses its API without a token. Binds every handle `ferrite.json` declares.

use ferrite_app_test::{ingress, TestHarness};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_app_boots_answers_health_and_requires_a_token() {
    let env = TestHarness::new().with_queue("requests").with_queue("replies").with_ape("state").build().await;
    env.run_app(|ctx| async move {
        wardrobe::serve(ctx, wardrobe::Tokens { owner: Some("smoke-owner-token".into()), assistant: None, ..Default::default() }).await
    });

    let health = env.handle(ingress::get("/health")).await.expect("a reply");
    assert_eq!(health.status, 200, "{}", String::from_utf8_lossy(&health.body));

    let api = env.handle(ingress::get("/v1/wardrobe")).await.expect("a reply");
    assert_eq!(api.status, 401, "{}", String::from_utf8_lossy(&api.body));
}
