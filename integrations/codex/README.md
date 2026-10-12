# Wardrobe plugin for OpenAI Codex

This folder is a Codex plugin marketplace with one plugin, `wardrobe`. The plugin connects Codex to the Garderobe MCP server (`apps/worker`, tools `garderobe_*`) and signs in with Garderobe's own MCP OAuth. It also ships a skill that tells Codex how to use the tools within the owner's rules. The plugin holds no credentials; Codex gets its own Garderobe grant through the owner's consent page.

```
integrations/codex/
├── .agents/plugins/marketplace.json   marketplace "wardrobe-codex" (one plugin: ./plugin)
├── plugin/
│   ├── plugin.json                    portable Agent Plugins manifest + extensions.com.openai.interface
│   ├── mcp.json                       the MCP server: streamable HTTP, URL of the Garderobe MCP resource
│   └── skills/wardrobe/SKILL.md       how to use the tools: reads, routine actions with receipt and undo, proposals
├── scripts/retarget.mjs               copy the package with another MCP URL (a hosted deployment)
├── scripts/verify-codex.mjs           end-to-end check with the real Codex CLI
├── scripts/board-guard.mjs            the verifier's write guard: fresh read, same revision, no owner's choice on a hosted board
├── scripts/ferrite-consent.mjs        the owner's consent on the Ferrite app's page (form fetched, issued/form_mac posted back)
└── test/plugin.test.mjs               static checks (node --test)
```

## Which Garderobe it connects to

The committed `plugin/mcp.json` points at `http://127.0.0.1:8787/mcp`, which is where both the local Worker (`npm run dev` in `apps/worker`) and the local Ferrite app (`ferrite dev` in `ferrite/`) serve by default. No hosted Garderobe MCP endpoint exists yet, on Ferrite or anywhere else. To use a hosted deployment, write a copy whose URL is that deployment's MCP resource (`MCP_ORIGIN` + `/mcp`):

```
node integrations/codex/scripts/retarget.mjs --mcp-url https://<mcp-host>/mcp --out ~/wardrobe-codex
```

The script refuses plain HTTP for anything but loopback, and refuses URLs that carry credentials, a query or a fragment.

## Install

You need the Codex CLI (tested with 0.162.1: `npm install -g @openai/codex`), or the ChatGPT desktop app, which shares Codex's configuration.

```
codex plugin marketplace add <path-to>/wardrobe/integrations/codex     # or the retargeted copy
codex plugin add wardrobe@wardrobe-codex
codex mcp list                                                          # shows: wardrobe  <url>  enabled  Not logged in
codex mcp login wardrobe --scopes wardrobe.read,wardrobe.write --oauth-client-registration dcr
```

`codex mcp login` opens Garderobe's consent page. The owner signs in, and allows or denies "Make changes": leave it off for a read-only connection. Then Codex stores the grant. Use `--no-browser` on a machine without a browser: Codex prints the URL and accepts the final callback URL pasted back. A grant can be withdrawn at any time in the Garderobe app under Settings › Connected assistants. `codex mcp logout wardrobe` deletes only Codex's local copy of the credentials; it is not shown to revoke the grant on the server, so remove the connection in the app as well.

Why `--oauth-client-registration dcr`: by default Codex 0.162.1 identifies itself with its Client ID Metadata Document (`https://chatgpt.com/oauth/codex/client.json`). The local Worker could not fetch that document: chatgpt.com answered its request with HTTP 403, so the consent page says "This application could not be verified". Dynamic client registration works, and Garderobe supports it. On a deployment, try the default first.

Optional tool approvals in `~/.codex/config.toml`: the server enforces what a connection may do, and these settings only add prompts in Codex.

```toml
[plugins."wardrobe@wardrobe-codex".mcp_servers.wardrobe]
default_tools_approval_mode = "writes"   # prompt for tools not marked read-only
```

In a session, ask for example "Use Wardrobe to show me tomorrow's outfit board" or "choose option 2 on tomorrow's board".

## What Codex may do with the owner's wardrobe

The server decides, on every request, from the grant and the owner's current rules (`apps/worker/src/mcp/handler.ts`, `apps/worker/src/mcp/policy.ts`). The plugin hard-codes no policy of its own. Its skill tells Codex to make only the changes the owner asked for and to report the server's answer as it is:

- **Read-only grant** (`wardrobe.read`): six tools. `garderobe_command` is not listed, and calling it gets an `insufficient_scope` challenge.
- **Write grant** (`wardrobe.read wardrobe.write`): all seven tools.
- **Applied:** the answer carries a receipt, and `command.undo` takes the change back. Choosing from the published board, laundry pickup and return, packing for a planned trip, and the owner's wear and wash reports are always applied this way.
- **Waiting for the owner:** the answer is `confirmation_required` with a proposal identifier and a system-written summary. Only the signed-in owner can confirm it, in the app. Codex cannot list or decide proposals. Which changes wait follows the owner's decisions. Under the decision of 2026-10-05 only its named exceptions wait (the contract's section 3: irreversible erasure, authorization towards another party, what a model or outside connection may reach, rewriting the profile document, and unbounded bulk changes). On the tree of 2026-10-12 a piece swap (`board.swap_slot`) still waited; the server's current policy (`apps/worker/src/mcp/policy.ts`) applies it directly.
- **Refused:** lifting a restriction, undoing the command that recorded one, and account-level and system commands.
- **Wear and wash** are recorded only as the owner reported them. A board choice is an intention, not a wear.

## Verify

Static checks (no network):

```
node --test integrations/codex/test/plugin.test.mjs
```

End to end with the real Codex CLI. First start the local Worker in another terminal: `cd apps/worker && npm run dev`. Then:

```
CODEX_BIN=$(command -v codex) node integrations/codex/scripts/verify-codex.mjs --report codex-verify.json
```

Against a hosted deployment (a retargeted copy), also pass the owner's timezone from Garderobe settings, which picks the owner's day: `--marketplace ~/wardrobe-codex --timezone Europe/London`. The script refuses a hosted run without it. Against the local Worker it reads the timezone from the owner's settings.

Against the Ferrite port of the app (`ferrite/`), pass `--app ferrite` and `--timezone`, with the app's owner token in `WARDROBE_OWNER_TOKEN` (never on the command line, never written out; Codex's own process does not receive it). Locally, start `ferrite dev --fresh` in `ferrite/` on the origin the app announces (http://127.0.0.1:8787 by default, which the committed `mcp.json` names), take the token from `[secrets]` in `ferrite/ferrite.local.toml`, and run:

```
WARDROBE_OWNER_TOKEN=… CODEX_BIN=$(command -v codex) node integrations/codex/scripts/verify-codex.mjs --app ferrite --timezone Europe/London --disposable-test-instance
```

Pass `--disposable-test-instance` only for a throw-away `ferrite dev --fresh` whose state you will discard. It allows the two writes that leave something behind even after undo: publishing tomorrow's board as the owner when `garderobe_today` answers that day has none (`board.publish` has no undo; the port has no recommender yet), and the synthetic care report on a port without board tools. Without it, or at a URL that is not loopback, neither is sent: the board must already be published, and the care write is reported as not run.

For a Ferrite deployment, run the same against a retargeted copy (`--marketplace`). The Ferrite consent page needs its own form: the script GETs the consent page first, copies its hidden fields (among them the server-issued `issued` and `form_mac`; a form is valid for 10 minutes) and posts them back at once with the owner token and the decision (`scripts/ferrite-consent.mjs`). The owner token is sent only when the discovered authorization page is on the origin of the plugin's MCP URL; an authorization server anywhere else is refused before any request.

The script works in a throw-away `CODEX_HOME` and runs these steps:

1. Installs the plugin from the marketplace.
2. Runs `codex mcp login`. Against a loopback Worker it gives the owner's consent with the local run mode's sign-in, which stands in for Cloudflare Access. With `--app ferrite` it gives it on the Ferrite app's consent page with the owner token. Against any other host it prints the URL for the owner to approve in a browser.
3. Starts `codex app-server`, the protocol the Codex IDE extension and the desktop app use, and through Codex:
   - lists the tools;
   - reads the inventory and the board;
   - chooses a board option other than the owner's current choice, checks the receipt and (against the local Worker) that the day's recorded wear is unchanged, then undoes the choice and checks that the board shows exactly the owner's prior choice (or none, if there was none). A hosted run prints a note that the wear check was not verified;
   - asks for a piece swap on the board. Under the owner's 2026-10-05 contract it must apply at once with a receipt; the script reads the board to check that the piece in that role really changed, then always undoes the swap and checks that the option has its original pieces again. A `confirmation_required` answer fails this check, because it is the superseded behaviour;
   - after the swap and its undo, sends the same swap with the board version read before the swap, now stale: it must be refused with `conflict`, and the board must be unchanged (same board, revision, choice and pieces). If the swap and its undo did not advance the revision, or the board after the undo is not the same board restored, that is reported as a failure and nothing is sent;
   - checks that a restriction lift is refused (the request names no real restriction, and nothing is written);
   - with `--app ferrite`: the port publishes no recommender, so on a disposable local instance the owner's app publishes tomorrow's board first (`board.publish` through `POST /v1/commands` with the owner token, two outfits of the owner's seed garments, the ones the port's own test uses), then the board steps above run unchanged. On a port without `garderobe_today` it reports the board steps as not run, and only on an instance declared disposable (`--disposable-test-instance`, at a loopback URL), it shows the routine write with its receipt and undo with the one write the port offers, a care report (`care.mark_dirty` on one clean, single, laundered garment): it checks that exactly that garment moved from clean to dirty, undoes it at once and checks that every garment's balances are as before. A loopback address alone is not enough, because a persistent local app or a tunnel to a deployment also answers there; anywhere else the write would record a wash the owner did not report, so it is not sent.
No model runs in this script. Codex can run only OpenAI models, and the project authorizes only claude-opus-5-5 for inference, so there is no model-driven `codex exec` step: every check above goes through `codex app-server`, which calls the tools without a model, and no Codex sign-in is needed. The script refuses `--codex-model` and `CODEX_MODEL`. A model-driven session would need an explicit owner exception to that rule.

Against a local Worker, setup (publishing tomorrow's board) and cleanup (rejecting a waiting proposal) are done as the owner through the app API. Against a deployment the daily service publishes the board, and the script does not write on a board where the owner has already made a choice: it reports the board writes as not run. Before every write (choice, swap and both undos) it reads the board again and sends the revision it observed as `expectedVersions`; if the board changed between steps, it stops instead of writing. A writing run against real data leaves undone changes in the history, and possibly one pending proposal, which the owner rejects in the app.

### Results

All results below are local, not a hosted check.

**Current version, 2026-10-12, local Worker, with the stale-swap step:** `npm run dev` in `apps/worker`, then `CODEX_BIN=… node integrations/codex/scripts/verify-codex.mjs`: **23 of 23 checks passed** (exit 0), including the swap with a stale board version refused (`conflict`) with the board unchanged.

**Earlier the same day, local Worker** (Miniflare via `npm run dev` in `apps/worker`, with the real owner profile and the 127-garment inventory), Codex CLI 0.162.1, `--registration dcr`, no model, after the daily service gave `board.swap_slot` an undo (commit fdb48436): **21 of 21 checks passed** (exit 0). Install and login, all seven tools, the inventory and board reads, the refused restriction lift, `board.select` with a receipt and the day's wear unchanged, its undo with the whole board exactly as before, and the piece swap applied at once with a receipt, then taken back by `command.undo` with its own receipt and the whole board exactly as before.

**Current version, 2026-10-12, local Ferrite app with the board** (`ferrite dev --port 8787 --fresh --no-reload` in `ferrite/`, ferrite 0.1.20, the port at garderobe-rebuild a5d1c57d with the board tools of 3eecd7a8, seeded with the owner's 127-garment inventory), Codex CLI 0.162.1, `--app ferrite --timezone Europe/London --disposable-test-instance`, no model: **22 of 23 checks passed, 1 failed** (exit 1). Passed: install, Garderobe's authorization server discovered with both scopes, the owner's consent on the Ferrite consent page (form fetched, `issued` and `form_mac` posted back), `codex mcp login`, the server connected over OAuth, the complete inventory (127 garments), the refused restriction lift (`forbidden`), tomorrow's board published by the owner ("Board for 2026-10-13 published (revision 1): 2 outfits"), `garderobe_today` reading it, `board.select` with a receipt naming the connected assistant ("an intention, not a recorded wear"), its undo with the whole board exactly as before, the piece swap applied at once with a receipt ("Lightweight oxford — blue swapped for Lightweight oxford — laurel"), its undo with the whole board exactly as before, and a swap with the stale board version refused (`conflict`) with the board unchanged at revision 3. Failed: the port lists three tools (`garderobe_command`, `garderobe_inventory`, `garderobe_today`), not seven; `garderobe_recommend`, `garderobe_ask`, `garderobe_research` and `garderobe_run` are not ported yet. Choosing is not wearing was not verified (the verifier has no owner read of the day's wear on this app). A second run on the same instance without `--disposable-test-instance` (board already there, nothing published): 21 of 22, the same single failure. The owner token appeared 0 times in either output.

**2026-10-12, local Ferrite app before the board** (the port's milestone 1a, two tools), `--app ferrite --timezone Europe/London` (before `--disposable-test-instance` existed): **15 of 17**. The care report, its receipt, its undo and the restored balances passed; the board steps were not run because the port had no `garderobe_today`.

The same day, the refusals were checked: a missing `CODEX_BIN` fails the "Codex CLI available" check with exit 1; `--app ferrite` without `WARDROBE_OWNER_TOKEN` or without `--timezone`, an unknown `--app`, `--codex-model`, `--codex-model=…` and `CODEX_MODEL` each exit 2; no temporary Codex home was left. `node --test integrations/codex/test/plugin.test.mjs`: 22 of 22 tests passed (after the board changes).

**Earlier on 2026-10-12, local Worker:** 19 of 21, when `command.undo` of a swap was still refused (`not_undoable`, "swap the piece back instead") because `board.swap_slot` declared no undo plan in `packages/daily/src/boards.ts`; the daily service has since added it.

**Earlier versions, 2026-10-12:** 22 of 22 checks passed, and 21 of 21 before the restriction-lift check was added. Those versions accepted a `confirmation_required` answer to the piece swap (the server then still kept swaps for the owner), and they included a model-driven `codex exec` step that ran Codex 0.162.1's default OpenAI model (its name was not recorded); that step has since been removed because the project authorizes only claude-opus-5-5 for inference.

What these results do not cover:

- No hosted deployment was tested, so no hosted run has happened: neither a Cloudflare deployment nor a Ferrite deployment (the Ferrite deploy waits on the owner's Ferrite account credential).
- Real Cloudflare Access was not used: consent on the Worker was given with the local sign-in stand-in.
- The ChatGPT desktop app's plugin installer and its sign-in on install were not exercised; only the CLI was.

## Codex format

The format comes from OpenAI's documentation, read on 2026-10-12:

- [Package your plugin](https://developers.openai.com/plugins/build/plugins): root `plugin.json` with the Agent Plugins schema, root `mcp.json`, `skills/<name>/SKILL.md`, marketplaces in `.agents/plugins/marketplace.json`, `codex plugin marketplace add`, and per-plugin MCP policy under `plugins."<plugin>".mcp_servers.<server>`.
- [Model Context Protocol (Codex)](https://developers.openai.com/codex/mcp): streamable HTTP servers, OAuth with CIMD and DCR, `codex mcp login`, and approval modes.

Where this package differs from those pages, because of what Codex CLI 0.162.1 actually does:

- The documentation describes `extensions["com.openai"].auth` in `mcp.json` (OAuth client mode, scopes). Codex 0.162.1 silently drops a server entry that carries any field besides `type` and `url`: the plugin then installs, but no MCP server appears. So `mcp.json` declares only `type` and `url`. OAuth is Codex's default for a streamable HTTP server, discovery finds Garderobe's authorization server, and the scopes and registration mode are given to `codex mcp login`. `test/plugin.test.mjs` keeps it that way.
- OpenAI-specific presentation is inline in `plugin.json` under `extensions.com.openai`, so there is no `.codex-plugin/plugin.json`.

This plugin is for Codex only. The ChatGPT-native Wardrobe plugin is a separate project in another repository and is not part of this package.
