#![forbid(unsafe_code)]
//! Wardrobe on Ferrite: the first slice of the port of the TypeScript
//! Cloudflare backend (apps/worker, packages/domain) to a Ferrite constrained
//! app. See README.md for what is ported, the platform limits and the plan.

pub mod api;
pub mod canonical;
pub mod ledger;
pub mod seed;
pub mod sha256;
pub mod time;

use ferrite_app::{serde_json, AppContext, IngressRequest};

pub use api::Tokens;

/// The deployed entry point: tokens come from the app's deploy secrets.
pub async fn run(ctx: AppContext) -> std::io::Result<()> {
    let tokens = Tokens { owner: ctx.secret(api::OWNER_TOKEN_SECRET), assistant: ctx.secret(api::ASSISTANT_TOKEN_SECRET) };
    serve(ctx, tokens).await
}

/// The request loop, with the tokens given (tests pass their own).
pub async fn serve(ctx: AppContext, tokens: Tokens) -> std::io::Result<()> {
    let mut requests = ctx.queue("requests")?;
    let mut state = ctx.ape("state")?;
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
        let reply = api::handle(&mut state, &tokens, ctx.now_ms(), &req).await;
        let body = serde_json::to_vec(&reply.body).unwrap_or_default();
        let envelope = serde_json::json!({
            "correlation_id": req.correlation_id,
            "status": reply.status,
            "headers": [["content-type", "application/json; charset=utf-8"], ["cache-control", "no-store"]],
            "body": body,
        });
        // Reply first, ack only once the reply is published: a lost reply leaves
        // the lease to redeliver, and a redelivered command is answered from its
        // idempotency record instead of running twice.
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
