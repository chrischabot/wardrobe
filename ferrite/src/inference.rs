//! The inference adapter: the only place a model is reached, and only through the app's declared
//! egress handle (`inference`) to Cloudflare AI Gateway's Anthropic route
//! (packages/assistant/src/inference/gateway.ts is the TypeScript build's adapter).
//!
//! The route, verified against Cloudflare's AI Gateway documentation (Anthropic provider and
//! Unified Billing pages, July 2026):
//!   POST https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic/v1/messages
//!   cf-aig-authorization: Bearer {gateway token}   (Unified Billing: no provider key is sent)
//!   anthropic-version: 2023-06-01
//!   body: an Anthropic Messages request {model, max_tokens, system, messages}.
//!
//! Configuration is one deploy secret, [`AI_GATEWAY_SECRET`], holding
//! `{"accountId": "<32 hex>", "gatewayId": "garderobe-dev", "token": "...", "model": "claude-opus-5-5"}`
//! (`model` optional). Without it, or with a value that does not parse, every model call is refused
//! by the secret's name before anything is read, sent or saved; there is no fallback answer.
//!
//! Bounds:
//!   * deadline: each call is bounded by [`MODEL_DEADLINE_MS`] with `ferrite_app::rt::time::timeout`
//!     around the whole egress exchange (upstream Ferrite's SDK has no per-call egress budget, and its
//!     egress gateway allows 10 s for a buffered exchange, more than the 8 s ingress deadline). A call
//!     cut off this way may still have reached the model, and dropping the local future does not
//!     stop the gateway: such an error is marked `uncertain`, nothing is saved, and the assistant
//!     keeps the run's claim until its lease ends, so no second call for that run starts sooner.
//!     The rest of the 8 s is left for the store reads and the one write around the call;
//!   * reply size: the egress gateway refuses a response body over 1 MiB (an error, nothing parsed),
//!     and this adapter refuses a delivered body over [`MAX_REPLY_BYTES`] again before parsing it;
//!     `max_tokens` keeps the model's answer itself to a few kilobytes, so the MCP reply stays far
//!     below the 1 MiB ingress reply cap.

use std::io;
use std::time::Duration;

use ferrite_app::serde_json::{self, json, Value};
use ferrite_app::{EgressHandle, EgressHeader, EgressHttpMethod, EgressOutcome};

use crate::ledger::CmdError;

/// The deploy secret that configures the gateway route.
pub const AI_GATEWAY_SECRET: &str = "WARDROBE_AI_GATEWAY";
/// The egress handle declared in ferrite.json.
pub const EGRESS_HANDLE: &str = "inference";
/// Every model URL starts here (and the egress declaration allows only this prefix).
pub const DESTINATION_PREFIX: &str = "https://gateway.ai.cloudflare.com/v1/";
/// `ALLOWED_GATEWAY_IDS` in gateway.ts: the implicit `default` gateway is never used.
pub const GATEWAY_IDS: [&str; 2] = ["garderobe-dev", "garderobe-prod"];
/// The models this app may name: only `claude-opus-5-5`, the model the project brief requires for
/// all inference. (The TypeScript registry's `claude-odango-eap` is not accepted.)
pub const MODELS: [&str; 1] = ["claude-opus-5-5"];
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";
/// The whole-call egress budget of one model call, under the 8 s ingress deadline.
pub const MODEL_DEADLINE_MS: u64 = 6_000;
/// The largest delivered reply body this adapter parses (the egress gateway's cap is the same).
pub const MAX_REPLY_BYTES: usize = 1 << 20;

/// The parsed secret. The token is never shown in errors or diagnostics.
#[derive(Clone, PartialEq, Eq)]
pub struct GatewayConfig {
    pub account_id: String,
    pub gateway_id: String,
    token: String,
    pub model: String,
}

impl std::fmt::Debug for GatewayConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayConfig").field("account_id", &self.account_id).field("gateway_id", &self.gateway_id).field("model", &self.model).finish_non_exhaustive()
    }
}

impl GatewayConfig {
    /// The Messages URL of this gateway.
    pub fn url(&self) -> String {
        format!("{DESTINATION_PREFIX}{}/{}/anthropic/v1/messages", self.account_id, self.gateway_id)
    }
}

fn unavailable(why: String) -> CmdError {
    CmdError::with(
        "module_unavailable",
        format!("Garderobe's assistant is not available on this server: {why}. Nothing was sent to a model and nothing was saved; reading (garderobe_today, garderobe_inventory, garderobe_recommend, garderobe_run) still works."),
        json!({"secret": AI_GATEWAY_SECRET, "retryable": false}),
    )
}

fn hex32(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Parse the secret's value. Every refusal names the secret and what is wrong, never the token.
pub fn parse_config(raw: Option<&str>) -> Result<GatewayConfig, CmdError> {
    let Some(raw) = raw.filter(|r| !r.trim().is_empty()) else {
        return Err(unavailable(format!("the secret {AI_GATEWAY_SECRET} is not set, so no model can be reached")));
    };
    let bad = |what: &str| unavailable(format!("the secret {AI_GATEWAY_SECRET} is not usable: {what}"));
    let v: Value = serde_json::from_str(raw).map_err(|_| bad("it is not a JSON object"))?;
    let Some(m) = v.as_object() else { return Err(bad("it is not a JSON object")) };
    if let Some(k) = m.keys().find(|k| !["accountId", "gatewayId", "token", "model"].contains(&k.as_str())) {
        return Err(bad(&format!("'{k}' is not one of accountId, gatewayId, token, model")));
    }
    let account_id = m.get("accountId").and_then(Value::as_str).filter(|a| hex32(a)).ok_or_else(|| bad("accountId must be the 32-character Cloudflare account ID"))?;
    let gateway_id = m.get("gatewayId").and_then(Value::as_str).ok_or_else(|| bad("gatewayId is missing"))?;
    if !GATEWAY_IDS.contains(&gateway_id) {
        return Err(bad(&format!("gatewayId must name one of this application's gateways ({}); the implicit 'default' gateway is never used", GATEWAY_IDS.join(", "))));
    }
    let token = m
        .get("token")
        .and_then(Value::as_str)
        .filter(|t| (1..=512).contains(&t.len()) && t.bytes().all(|b| (0x21..=0x7e).contains(&b)))
        .ok_or_else(|| bad("token must be the gateway token (visible ASCII, at most 512 characters)"))?;
    let model = match m.get("model") {
        None => DEFAULT_MODEL,
        Some(Value::String(s)) if MODELS.contains(&s.as_str()) => s.as_str(),
        Some(_) => return Err(bad(&format!("model must be one of {}", MODELS.join(", ")))),
    };
    Ok(GatewayConfig { account_id: account_id.into(), gateway_id: gateway_id.into(), token: token.into(), model: model.into() })
}

/// What the egress gate answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delivery {
    Delivered { status: u16, body: Vec<u8> },
    Denied { reason: String },
}

/// One buffered POST: the egress handle in the deployed app, a labelled test double in tests. The
/// adapter bounds the call's time itself.
#[allow(async_fn_in_trait)]
pub trait Transport {
    async fn post(&mut self, url: &str, headers: &[(String, String)], body: &[u8]) -> io::Result<Delivery>;
}

impl Transport for EgressHandle {
    async fn post(&mut self, url: &str, headers: &[(String, String)], body: &[u8]) -> io::Result<Delivery> {
        let headers: Vec<EgressHeader> = headers.iter().map(|(name, value)| EgressHeader { name: name.clone(), value: value.clone() }).collect();
        Ok(match self.deliver_http(EgressHttpMethod::Post, url, &headers, body).await? {
            EgressOutcome::Delivered { status, body } => Delivery::Delivered { status, body },
            EgressOutcome::Denied { reason } => Delivery::Denied { reason },
        })
    }
}

/// The transport type of an app with no egress handle; never called.
pub struct NoEgress;

impl Transport for NoEgress {
    async fn post(&mut self, _: &str, _: &[(String, String)], _: &[u8]) -> io::Result<Delivery> {
        Err(io::Error::new(io::ErrorKind::NotConnected, "no egress handle"))
    }
}

/// One model call: a system prompt, the user's turn and an output bound.
#[derive(Debug, Clone)]
pub struct ModelRequest {
    pub system: String,
    pub user: String,
    pub max_tokens: u32,
    /// Short, non-personal Gateway metadata (the run ID and the task).
    pub run_id: String,
    pub task: &'static str,
}

/// The model's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelReply {
    pub text: String,
    /// The model stopped at `max_tokens`.
    pub truncated: bool,
    pub model: String,
}

/// The adapter: the secret's value and the egress handle, as the app was started with, and the
/// clock that bounds a claimed run's work (the app's own clock; without one, the request's time).
pub struct Inference<T> {
    secret: Option<String>,
    transport: Option<T>,
    clock: Option<Box<dyn Fn() -> u64 + Send + Sync>>,
    reply_deadline: Option<u64>,
}

impl Inference<NoEgress> {
    /// No secret and no handle: every model call is refused by the secret's name.
    pub fn unavailable() -> Self {
        Inference { secret: None, transport: None, clock: None, reply_deadline: None }
    }
}

fn upstream(message: String, retryable: bool) -> CmdError {
    CmdError::with("internal", format!("{message}; nothing was saved"), json!({"retryable": retryable, "upstream": "ai_gateway"}))
}

/// A call whose outcome is not known: cut off at the deadline, or a transport failure after the
/// request may have left. Dropping the local future does not stop the gateway or the model, so the
/// run's claim is kept (`uncertain: true`) until its lease ends; only then may the same ID claim the
/// run and call the model again.
fn uncertain(message: String) -> CmdError {
    CmdError::with(
        "internal",
        format!("{message}, and the request may still have reached the model, so this ID is held until its 10 s lease ends; send it again after that; nothing was saved"),
        json!({"retryable": true, "retryAfterMs": 10_000, "upstream": "ai_gateway", "uncertain": true}),
    )
}

/// The ingress reply deadline when a request does not carry one (the platform's 8 s).
pub const INGRESS_DEADLINE_MS: u64 = 8_000;

impl<T: Transport> Inference<T> {
    pub fn new(secret: Option<String>, transport: Option<T>) -> Self {
        Inference { secret, transport, clock: None, reply_deadline: None }
    }

    /// The current request's absolute reply deadline (epoch ms), or `None` when it carries none.
    pub fn set_reply_deadline(&mut self, deadline_ms: Option<u64>) {
        self.reply_deadline = deadline_ms;
    }

    /// The reply deadline of a request received at `request_ms`: its own, else [`INGRESS_DEADLINE_MS`].
    pub fn reply_deadline(&self, request_ms: u64) -> u64 {
        self.reply_deadline.unwrap_or(request_ms + INGRESS_DEADLINE_MS)
    }

    /// Read the time from `clock` (the deployed app passes `ctx.now_ms`) instead of the request's.
    pub fn with_clock(mut self, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        self.clock = Some(Box::new(clock));
        self
    }

    /// The time now: the clock's, or `request_ms` when there is none.
    pub fn now(&self, request_ms: u64) -> u64 {
        self.clock.as_ref().map_or(request_ms, |c| c())
    }

    /// The clock itself, for code that reads the time while this adapter is borrowed elsewhere.
    pub fn clock(&self) -> Option<&(dyn Fn() -> u64 + Send + Sync)> {
        self.clock.as_deref()
    }

    /// The transport, for tests that inspect what was sent.
    pub fn transport(&self) -> Option<&T> {
        self.transport.as_ref()
    }

    /// The configuration, or the refusal that names what is missing. Called before anything is read
    /// or written, so a refused request leaves no trace.
    pub fn config(&self) -> Result<GatewayConfig, CmdError> {
        let cfg = parse_config(self.secret.as_deref())?;
        if self.transport.is_none() {
            return Err(unavailable(format!("the egress handle '{EGRESS_HANDLE}' is not bound to this app, so the AI Gateway cannot be reached")));
        }
        Ok(cfg)
    }

    /// The Messages request body for `cfg` (exposed for tests).
    pub fn request_body(cfg: &GatewayConfig, req: &ModelRequest) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "model": cfg.model,
            "max_tokens": req.max_tokens,
            "system": req.system,
            "messages": [{"role": "user", "content": req.user}],
        }))
        .unwrap_or_default()
    }

    /// The request headers (exposed for tests): the gateway token, never a provider key.
    pub fn request_headers(cfg: &GatewayConfig, req: &ModelRequest) -> Vec<(String, String)> {
        let metadata = json!({"garderobe_run": req.run_id.chars().take(64).collect::<String>(), "garderobe_task": req.task});
        vec![
            ("content-type".into(), "application/json".into()),
            ("anthropic-version".into(), "2023-06-01".into()),
            ("cf-aig-authorization".into(), format!("Bearer {}", cfg.token)),
            ("cf-aig-metadata".into(), metadata.to_string()),
        ]
    }

    /// One model call through the gateway, within [`MODEL_DEADLINE_MS`].
    pub async fn complete(&mut self, cfg: &GatewayConfig, req: &ModelRequest) -> Result<ModelReply, CmdError> {
        let Some(transport) = self.transport.as_mut() else {
            return Err(unavailable(format!("the egress handle '{EGRESS_HANDLE}' is not bound to this app, so the AI Gateway cannot be reached")));
        };
        let body = Self::request_body(cfg, req);
        let headers = Self::request_headers(cfg, req);
        let url = cfg.url();
        let call = transport.post(&url, &headers, &body);
        let delivery = match ferrite_app::rt::time::timeout(Duration::from_millis(MODEL_DEADLINE_MS), call).await {
            Err(_) => return Err(uncertain(format!("the model did not answer within {} s", MODEL_DEADLINE_MS / 1000))),
            Ok(outcome) => outcome.map_err(|e| {
                if e.to_string().contains("exceeds the cap") {
                    upstream("the model's reply was larger than 1 MiB".into(), false)
                } else if e.kind() == io::ErrorKind::TimedOut {
                    uncertain(format!("the model did not answer within {} s", MODEL_DEADLINE_MS / 1000))
                } else {
                    uncertain("the AI Gateway could not be reached".into())
                }
            })?,
        };
        let (status, bytes) = match delivery {
            Delivery::Denied { reason } => return Err(upstream(format!("the egress gate refused the call to the AI Gateway ({reason})"), false)),
            Delivery::Delivered { status, body } => (status, body),
        };
        if bytes.len() > MAX_REPLY_BYTES {
            return Err(upstream("the model's reply was larger than 1 MiB".into(), false));
        }
        if status != 200 {
            let kind = serde_json::from_slice::<Value>(&bytes).ok().and_then(|v| v["error"]["type"].as_str().map(str::to_string));
            let what = kind.map_or(String::new(), |k| format!(", {k}"));
            return Err(match status {
                401 | 403 => upstream(format!("the AI Gateway refused the credential in {AI_GATEWAY_SECRET} (HTTP {status}{what})"), false),
                429 | 500..=599 => upstream(format!("the AI Gateway is busy or failing (HTTP {status}{what}); try again"), true),
                _ => upstream(format!("the AI Gateway refused the request (HTTP {status}{what})"), false),
            });
        }
        let v: Value = serde_json::from_slice(&bytes).map_err(|_| upstream("the model's reply was not JSON".into(), true))?;
        if v["type"] != "message" {
            return Err(upstream("the model's reply was not a message".into(), true));
        }
        let text: String = v["content"]
            .as_array()
            .map(|blocks| blocks.iter().filter(|b| b["type"] == "text").filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join(""))
            .unwrap_or_default();
        if text.trim().is_empty() {
            return Err(upstream("the model returned no text".into(), true));
        }
        let model = v["model"].as_str().filter(|m| !m.is_empty() && m.len() <= 128).unwrap_or(&cfg.model).to_string();
        Ok(ModelReply { text, truncated: v["stop_reason"] == "max_tokens", model })
    }
}
