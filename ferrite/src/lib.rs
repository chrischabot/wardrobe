#![forbid(unsafe_code)]
//! Wardrobe on Ferrite: the first slice of the port of the TypeScript
//! Cloudflare backend (apps/worker, packages/domain) to a Ferrite constrained
//! app. See README.md for what is ported, the platform limits and the plan.

pub mod api;
pub mod app_routes;
pub mod assistant;
pub mod board;
pub mod inference;
pub mod laundry;
pub mod canonical;
pub mod command_types;
pub mod feedback;
pub mod trips;
pub mod ledger;
pub mod mcp;
pub mod oauth;
pub mod random;
pub mod recommend;
pub mod returns;
pub mod runs;
pub mod seed;
pub mod sha256;
pub mod studio;
pub mod temperature;
pub mod time;
pub mod weather;
pub mod wear;

use ferrite_app::{serde_json, AppContext, IngressRequest};

pub use api::Tokens;

/// The deployed entry point: tokens come from the app's deploy secrets.
pub async fn run(ctx: AppContext) -> std::io::Result<()> {
    let tokens = Tokens {
        owner: ctx.secret(api::OWNER_TOKEN_SECRET),
        assistant: ctx.secret(api::ASSISTANT_TOKEN_SECRET),
        public_origin: ctx.secret(oauth::PUBLIC_ORIGIN_SECRET),
        app_client_id: ctx.secret(oauth::APP_CLIENT_ID_SECRET),
        app_redirect_uri: ctx.secret(oauth::APP_REDIRECT_URI_SECRET),
    };
    serve(ctx, tokens).await
}

/// How many requests one instance answers at once. Each request loop polls the shared request queue
/// with its own store and egress clients, so a request waiting on a model call (up to 6 s) holds up
/// only its own loop: health, OAuth, reads and commands keep being answered by the others. Every
/// write is a guarded commit, so concurrent loops are safe in the same way as concurrent instances.
pub const REQUEST_LOOPS: usize = 4;

/// The request loops, with the tokens given (tests pass their own). The model route comes from the
/// app's deploy secret and egress handle; without either, the assistant's tools refuse by name.
pub async fn serve(ctx: AppContext, tokens: Tokens) -> std::io::Result<()> {
    // Open every loop's clients first, so a wiring mistake fails at startup.
    let mut loops = Vec::with_capacity(REQUEST_LOOPS);
    for _ in 0..REQUEST_LOOPS {
        let requests = ctx.queue("requests")?;
        let state = ctx.ape("state")?;
        let clock = ctx.clone();
        let inference = inference::Inference::new(ctx.secret(inference::AI_GATEWAY_SECRET), ctx.egress(inference::EGRESS_HANDLE).ok()).with_clock(move || clock.now_ms());
        loops.push(ferrite_app::rt::spawn(request_loop(ctx.clone(), tokens.clone(), requests, state, inference)));
    }
    // Watch every loop at once: a loop never returns while healthy, so the first one to end (with an
    // error, a panic or at all) stops the app, rather than leaving it running on fewer loops unseen.
    let (ended, mut first) = ferrite_app::rt::mpsc::channel::<String>(REQUEST_LOOPS);
    for (i, handle) in loops.into_iter().enumerate() {
        let ended = ended.clone();
        ferrite_app::rt::spawn(async move {
            let why = match handle.await {
                Ok(Ok(())) => format!("request loop {i} ended"),
                Ok(Err(e)) => format!("request loop {i} failed: {e}"),
                Err(_) => format!("request loop {i} panicked"),
            };
            let _ = ended.send(why).await;
        });
    }
    drop(ended);
    let why = first.recv().await.unwrap_or_else(|| "every request loop stopped".to_string());
    Err(std::io::Error::new(std::io::ErrorKind::Other, why))
}

/// One request loop: poll, answer, reply, ack.
async fn request_loop(
    ctx: AppContext,
    tokens: Tokens,
    mut requests: ferrite_app::client::QueueClusterClient,
    mut state: ferrite_app::client::ApeClusterClient,
    mut inference: inference::Inference<ferrite_app::EgressHandle>,
) -> std::io::Result<()> {
    loop {
        let lease = match requests.poll_wait(1_000).await {
            Ok(Some(l)) => l,
            Ok(None) => continue,
            Err(_) => {
                ferrite_app::sleep_ms(200).await;
                continue;
            }
        };
        // A malformed envelope is acked away, never retried for ever.
        let Ok(req) = serde_json::from_slice::<IngressRequest>(&lease.payload) else {
            let _ = requests.ack(lease.token).await;
            continue;
        };
        let reply = api::handle_with(&mut state, &tokens, &mut inference, ctx.now_ms(), &req).await;
        let (content_type, body) = reply.content();
        let mut headers = vec![vec!["content-type".to_string(), content_type], vec!["cache-control".to_string(), "no-store".to_string()]];
        headers.extend(reply.headers.iter().map(|(k, v)| vec![k.clone(), v.clone()]));
        let envelope = serde_json::json!({
            "correlation_id": req.correlation_id,
            "status": reply.status,
            "headers": headers,
            "body": body,
        });
        // Reply first, ack only once the reply is published: a lost reply leaves
        // the lease to redeliver with the same correlation ID. A redelivered
        // command is answered from its idempotency record, and a redelivered
        // OAuth consent, code exchange or refresh recomputes the secrets it
        // already recorded and answers again (oauth::Mint) instead of running
        // twice.
        let replied = match ctx.reply_to_queue(&req.reply_to).await {
            Ok(mut replies) => match serde_json::to_vec(&envelope) {
                Ok(payload) => replies.publish(&payload).await.is_ok(),
                Err(_) => true,
            },
            Err(_) => false,
        };
        if replied {
            let _ = requests.ack(lease.token).await;
        }
    }
}
