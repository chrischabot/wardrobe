# Ferrite deploy, verify and teardown

Tooling for the Wardrobe Ferrite app in `ferrite/` (the Rust port; that directory
belongs to the port and is only read here). Node 22, no dependencies.

| Command | Needs the owner's Ferrite account | What it does |
|---|---|---|
| `node deploy/ferrite/verify.mjs --local --start-dev` | no | starts `ferrite dev --fresh` on port 8790, runs every check over HTTP, stops it; evidence `evidence/verify-local.json` |
| `node deploy/ferrite/verify.mjs --local [--origin URL]` | no | the same against a `ferrite dev` already running (default `http://127.0.0.1:8790`) |
| `node deploy/ferrite/deploy.mjs --dry-run` | no | `ferrite check`, the plan and the account state; `evidence/deploy-dry-run.json` |
| `node deploy/ferrite/deploy.mjs --confirm=<account>/wardrobe [--public-origin=https://…]` | yes | `ferrite check`, `ferrite test`, the local verification, then under the target's lock the public origin (`--public-origin=`, else `ferrite host --json`; refused before any remote write when neither gives a bare https origin), the tokens into git-ignored `.state/<account>__<app>.tokens.json` (one file per target, created once, 0600, validated), `ferrite secrets set --app <account>/wardrobe` for both tokens and `WARDROBE_PUBLIC_ORIGIN` (stdin), one `ferrite deploy`, `ferrite host --app <account>/wardrobe` (must equal the origin set), then `verify.mjs --deployed`; `evidence/deploy.json` |
| `node deploy/ferrite/verify.mjs --deployed` | yes | the checks against the deployed origin; `evidence/verify-deployed.json` |
| `node deploy/ferrite/teardown.mjs` | no | the teardown plan only (default); `evidence/teardown-plan.json` |
| `node deploy/ferrite/teardown.mjs --execute --confirm=<account>/wardrobe` | yes | deletes the app's three secrets (both tokens and `WARDROBE_PUBLIC_ORIGIN`), deploys with zero instances, removes only that target's token file; `evidence/teardown.json` |
| `node --test deploy/ferrite/test/*.test.mjs` | no | the tooling's own tests (`lib`, `redact`, `ferrite` for verification, `deploy`) |

Without a signed-in account `deploy.mjs` stops before anything remote and writes
`evidence/deploy-preflight.json`: the exact reason, a read-only probe of
`$FERRITE_MCP_ENDPOINT` (status and error code only) and which steps need the account.
`FERRITE_OWNER_TOKEN` alone is answered `401 {"error":"unauthenticated","error_description":"present a Ferrite account token"}`:
the owner must supply his Ferrite account credential document (endpoint, account id,
token) and import it with `ferrite login --credentials-file <path>`.

## Guards

A remote write runs only for the app named in `ferrite/ferrite.json` when it is
exactly `wardrobe`, with a signed-in account, and with
`--confirm=<account>/<app>` naming exactly that account and app. A deploy is a
charged build and is never retried by the script (`ferrite deploy resume`
reattaches). Deploy and teardown of one target hold an exclusive lock
(`.state/<account>__<app>.tokens.json.lock`), published atomically with its owner record; a live
holder refuses the second run, and a lock left by a dead process is never taken over
automatically (the command names the file for the operator to remove). A command
still running at release, one that timed out, or one killed by an abort keeps its own
target's lock only; local verification holds a separate lock of its own. Each run copies the
Ferrite credential document once into a private 0700 home (`.state/cred-*`, removed at the end)
and runs every remote command with it, so a login elsewhere cannot redirect the run. Before
every remote command the account (read through that copy) and the spec's app must still be
the confirmed target, and an interrupt received meanwhile stops it. `ferrite host` and
`ferrite secrets set|delete` name the app explicitly (`--app <account>/wardrobe`), so they
never depend on the spec; `ferrite deploy` has no app selector, so the spec is checked right
before it spawns and again after it returns, and a change fails the run (check
`ferrite status`). That `--app` form is taken from the CLI's help and is unproven until the
first live deploy. The deployed origin must be a bare `https` origin. Deployed
verification (from `deploy.mjs`, in the same process, or `verify.mjs --deployed`) runs
inside the target's lock, so no teardown or second deploy can come between its commands
and its cleanup. Every CLI step runs asynchronously, so signals are handled while it
runs. The first SIGINT or SIGTERM lets the running step finish and starts no further
step, secret write or deploy; it is forwarded to the local-verification child's own PID
only (never a process group), and it lets a running verification undo its own changes
(recorded as interrupted, not passed). The dev server runs in a process group of its own,
so it keeps serving while the child reconciles; `deploy.mjs` stops it only after the
child has exited, or after a five-minute reconciliation timeout, when a child still running
is killed first. A second signal kills a dev server the run started and exits with 130; a held lock is
released by an exit hook unless a command or write may still be settling. The CLI has no verb that deletes an app: teardown leaves the app's APE
state and request queue with the platform, and says so.

## What the verification checks

All over HTTP with the app's own receipts as evidence: the public health route;
sign-in (no token and a wrong token refused with `401 unauthenticated` and no data);
the owner's inventory (`GET /v1/wardrobe`: one complete page of 127 owned garments
and 144 owned units), also read by the assistant and narrowed by category; the MCP
snapshot read (the same garments, balances and revision, its totals, and a source
digest equal to the SHA-256 of `requirements/wardrobe_inventory_clean.csv`; the
inventory page carries no import source, so this is checked only where MCP runs); `care.mark_dirty` relayed by the assistant, applied at
once with a receipt offering undo and the balances moved; the receipt stored and
listed; the same request answered from its receipt; a reused key refused
(`409 idempotency_key_reuse`); the assistant claiming an owner tap and the owner on
the assistant's channel refused (`403 forbidden`); a receipt unreadable without a
token; the owner's undo restoring the balances; the original receipt no longer
offering undo and a second undo refused (`409 not_undoable`); two identical
requests sent at once committing once (then undone); invalid, unknown and impossible
commands refused with their codes and writing nothing. Cross-owner isolation is
recorded as not run: the first slice serves one owner per deployment.

The MCP endpoint is then verified as a client uses it (the port's milestone 1a,
`ferrite/src/oauth.rs` and `ferrite/src/mcp.rs`): an unauthenticated `POST /mcp`
answered 401 with a `WWW-Authenticate` naming the protected-resource metadata, which
names the app as its authorization server (issuer, endpoints, S256, both scopes);
dynamic registration of a public client; the consent page fetched first and its
hidden `issued` and `form_mac` fields posted back, refusing a wrong owner token
(401) and a form it did not issue (400) with no redirect; "Make changes" allowed
(code with state and `iss`, PKCE exchange granting `wardrobe.read wardrobe.write`)
and left off (read only); a session (initialize, initialized, tools/list, a snapshot
read equal to the owner's inventory, then `care.mark_dirty` through
`garderobe_command` with its receipt and `command.undo` taking it back); the
read-only grant not offered the write tool and refused it with `403
insufficient_scope` while nothing is written; the owner's API token refused as an MCP
token. Whatever happens, the run's grants are ended at the end (owner disconnect and
RFC 7009 revocation), each token must be refused on its next request and listed as
revoked. The metadata must name `WARDROBE_PUBLIC_ORIGIN` (deployed: the verified
origin; locally: the dev secret in `ferrite/ferrite.local.toml`); requests go to the
origin under test. An app that does not serve MCP gets these checks recorded as not
run, which fails the gate. OAuth codes and tokens are redacted and never written.

A refusal passes only when the body is exactly `{"error":{code,message[,details]}}`,
and a sign-in refusal's details are absent or empty. Every check is required except
the cross-owner one; the run passes only when no check failed and no required check
was skipped. No command is sent until the starting inventory and receipt list have both
been read. Whatever the outcome, a final cleanup replays each request the run sent (the
app answers a repeated request from the receipt it created, so this names the run's own
receipts and no one else's), undoes those that still offer undo, and requires every
balance to equal the start; it is recorded as the `cleanup` check. A command another
client sends during the run is never undone; it makes the cleanup check fail, honestly.
With `--start-dev`, an occupied port is refused
before anything starts and the server is accepted only while the started child is
alive.

## Redaction

Every error and CLI output is redacted before it is printed or written, and shortened
only after redaction (`lib/redact.mjs`): known secret values of any length, one
credential-name pattern for object keys and strings (any case or separator, quoted
or not, JSON inside strings, header lines), bearer tokens, JWTs and long token-like
runs. The known secrets (one collector, `knownSecrets()` in `lib/state.mjs`) are the
local tokens, every stored target's tokens, `FERRITE_OWNER_TOKEN` and
`FERRITE_PREVIEW_TOKEN`. Dev-server output is held (up to 2^20 UTF-16 code units; beyond that none of it is shown) and redacted as a whole, one buffer per
stream, before its tail is kept. CLI evidence holds the command, exit status, signal,
time and output sizes only, never output text; the endpoint probe records the status, a
short error code and a fixed classification; failure evidence records the failed step
and the steps so far, never a message. Verification evidence keeps only an explicit
list of field paths (statuses, ids, counts and timings); origins are recorded as scheme,
host and port. Console echo of a command's output is held and redacted as a whole when the command ends, so a
credential split across lines keeps its context; output over the limit is not shown at all. A write answered with a 5xx or 408 counts as unanswered: its
effect may still commit, so the lock is kept unless cleanup confirms every receipt of the run's own.

## Reused from the Cloudflare tooling

Ported, not imported (the Cloudflare `deploy/` edits are not landed): the evidence
redaction of `deploy/verify.mjs` (`redactEvidence`), extended as its reviews asked;
the verification structure (grouped checks, `pass`/`fail`/`not_run` with a reason,
documented-refusal judgements, receipts as evidence); the guard-first,
dry-run-by-default command shape and atomic 0600 local state of `deploy/lib/state.mjs`.
Not needed yet and left in `deploy/lib/`: the outbound classifier
(`outbound-policy.mjs`; the slice makes no egress calls) and the model guard
(`model-constraint.mjs`, `registry-routes.mjs`; the slice makes no model calls).
Both apply when the port reaches egress (milestone 3) and the conversation actor
(milestone 4).
