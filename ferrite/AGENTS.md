FERRITE BRIEF. With a shell, these rules replace the MCP-only sequence of the `quickstart` and `guide` docs.

1. `ferrite new alloy <name>` for anything that serves pages, even one static page (`hello` for an API), edit `src/lib.rs`, then `ferrite check`, `ferrite test`, `ferrite dev`, `ferrite deploy`. CLI and MCP share one account; never provision another. Without a shell: `validate_spec`, `code_gate`, one `deploy_source`, poll `build_status`, request its URL.
2. An app is safe Rust with one dependency, `ferrite-app`; shared code (alloy, auth, crypto…) comes as source: `ferrite add <package>`, or over MCP† `list_packages`, `read_package`, then `deploy_source` with `packages` (else send its files).
3. Put the logic you ship (a calculation, a price) in a Rust function with `#[test]`s on known answers; `ferrite test` must show them passed, not "no tests executed". Then try the page with valid and invalid input.
4. Secrets: before deploying, `printf %s "$VALUE" | ferrite secrets set <NAME>` (MCP: `set_secret`); the next deploy delivers them. Never put a credential in source, even as a fallback.
5. Sign-in only for an app with users of its own (a shop's customers): `ferrite add auth`, then `src/auth/SETUP.md`. `ferrite host` (MCP: `app_host`†) gives the address before any deploy; set every secret SETUP.md lists, then deploy once. OAuth credentials come from your human or environment, never invented.
6. A deploy is a charged build of minutes: run it once with your shell's longest timeout, never again as a retry. If your shell stops it first, `ferrite deploy resume` reattaches.
7. Docs: `search_docs "<words>"`† returns sections; `read_docs` reads one. †: if in `tools/list`.
8. Limits: body 256 KiB, one `set-cookie` per reply, 8 s api deadline, egress reply ~1 MiB.

## API card (hello template)

Every call below compiles in this scaffold; read vendored source only for what is missing.

- `req: IngressRequest` (decoded in `run`): `method`, `path` (query string included), `body: Vec<u8>`, `headers: Vec<(String, String)>` (lowercase; only names the route's `forward_headers` lists), `idempotency_key`, `reply_to`.
- Query: `let (path, query) = req.path.split_once('?').unwrap_or((req.path.as_str(), ""));` then `query.split('&').filter_map(|p| p.split_once('=')).find(|(k, _)| *k == "n").map(|(_, v)| v)`; values stay percent-encoded.
- Reply: `IngressReply::to(&req, 200, bytes)`, then `reply.headers.push(("content-type".into(), "application/json".into()))`; never `content-length`. Send it with `ctx.reply_to_queue(&req.reply_to).await?.publish(&serde_json::to_vec(&reply)?).await?`, then ack the lease.
- APE: `let mut state = ctx.ape("state")?;` `state.get(b"k").await?` is `Option<Vec<u8>>`, bytes, not `String`; `state.commit_n(&[(key.as_slice(), value.as_slice())]).await?` writes atomically; `commit_n_if(&guard, expected, entries)` only if `guard` holds `expected` (`None`: absent). A store (`ctx.store(name)?`) has `get`, `put`, `delete`, `scan_prefix(prefix, None, limit)`.
- Secrets: `ctx.secret("NAME")` is `Option<String>`; locally under `[secrets]` in `ferrite.local.toml`.
- Tests (`--with-tests`): `let env = TestHarness::new().with_queue("requests").with_queue("replies").with_ape("state").build().await;` `env.run_app(|ctx| async move { wardrobe::run(ctx).await });` then `env.handle(ingress::get("/api/x")).await` (an `io::Result<IngressReply>`), or `ingress::post(path, body)`, `ingress::post_keyed(path, key, body)`. With a secret: `let mut p = env.payload().clone(); p.secrets.insert("NAME".into(), "v".into()); let ctx = ferrite_app::AppContext::with_clock(p, env.clock()); env.run_app(move |_| wardrobe::run(ctx));`. After `ferrite add auth`: `auth::testing`, see `src/auth/SETUP.md`.
- `ferrite.json`: every service has a small `workload`; raise one only for real traffic, and delete a service and its binding the app does not use.
- Source docs: `vendor/ferrite-app/src/` (`wire.rs` envelopes, `client.rs` plane clients), `vendor/ferrite-forge/src/harness.rs`.
