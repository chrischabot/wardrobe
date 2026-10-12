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
└── test/plugin.test.mjs               static checks (node --test)
```

## Which Garderobe it connects to

The committed `plugin/mcp.json` points at the local Worker, `http://127.0.0.1:8787/mcp` (`npm run dev` in `apps/worker`). No hosted Garderobe MCP endpoint exists yet, on Ferrite or anywhere else. To use a hosted deployment, write a copy whose URL is that deployment's MCP resource (`MCP_ORIGIN` + `/mcp`):

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

`codex mcp login` opens Garderobe's consent page. The owner signs in, and allows or denies "Make changes": leave it off for a read-only connection. Then Codex stores the grant. Use `--no-browser` on a machine without a browser: Codex prints the URL and accepts the final callback URL pasted back. A grant can be withdrawn at any time in the Garderobe app under Settings › Connected assistants.

Why `--oauth-client-registration dcr`: by default Codex 0.162.1 identifies itself with its Client ID Metadata Document (`https://chatgpt.com/oauth/codex/client.json`). The local Worker could not fetch that document: chatgpt.com answered its request with HTTP 403, so the consent page says "This application could not be verified". Dynamic client registration works, and Garderobe supports it. On a deployment, try the default first.

Optional tool approvals in `~/.codex/config.toml`: the server enforces what a connection may do, and these settings only add prompts in Codex.

```toml
[plugins."wardrobe@wardrobe-codex".mcp_servers.wardrobe]
default_tools_approval_mode = "writes"   # prompt for tools not marked read-only
```

In a session, ask for example "Use Wardrobe to show me tomorrow's outfit board" or "choose option 2 on tomorrow's board".

## What Codex may do with the owner's wardrobe

The server decides, on every request, from the grant (`apps/worker/src/mcp/handler.ts`, `apps/worker/src/mcp/policy.ts`). The plugin's skill repeats the rules so that Codex does not try anything else:

- **Read-only grant** (`wardrobe.read`): six tools. `garderobe_command` is not listed, and calling it gets an `insufficient_scope` challenge.
- **Write grant** (`wardrobe.read wardrobe.write`): all seven tools.
- **Run directly, with a receipt and undo:** choosing from the published board (`board.select`), laundry pickup and return (`laundry.collect`, `laundry.return`) and packing for a planned trip (`stock.pack`, `stock.unpack`). These follow the owner's decision of 2026-10-03. The owner's own wear and wash reports and research records also run directly. The undo is `command.undo`.
- **Wait for the owner:** every other change answers `confirmation_required` with a proposal identifier and a system-written summary. Only the signed-in owner can confirm it, in the app. Codex cannot list or decide proposals.
- **Refused:** lifting a restriction, or undoing the command that recorded one, and account-level and system commands.
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

The script works in a throw-away `CODEX_HOME` and runs these steps:

1. Installs the plugin from the marketplace.
2. Runs `codex mcp login`. Against a loopback Worker it gives the owner's consent with the local run mode's sign-in, which stands in for Cloudflare Access. Against any other host it prints the URL for the owner to approve in a browser.
3. Starts `codex app-server`, the protocol the Codex IDE extension and the desktop app use, and through Codex:
   - lists the tools;
   - reads the inventory and the board;
   - chooses a board option, checks the receipt and that no wear was recorded, then undoes the choice;
   - checks that a piece swap waits for the owner.
4. Asks a model-driven `codex exec` session to read the board through the plugin. This step uses your existing Codex sign-in (the `auth.json` in `CODEX_HOME` or `~/.codex`, copied into the throw-away home and deleted with it), or `OPENAI_API_KEY` when there is none; `--no-model` skips it.

Against a local Worker, setup (publishing tomorrow's board) and cleanup (rejecting the proposal) are done as the owner through the app API. Against a deployment the daily service publishes the board. A writing run against real data leaves one undone board choice and one pending proposal, which the owner rejects in the app.

### Results

The results below are from a local run, not a hosted check. On 2026-10-12, against the local Worker (Miniflare, with the real owner profile and the 127-garment inventory), with Codex CLI 0.162.1, `verify-codex.mjs` passed 21 of 21 checks, once using an existing Codex sign-in with `OPENAI_API_KEY` unset, and once from no sign-in with `OPENAI_API_KEY`:

- plugin install and login: marketplace add, plugin add, server configured, login with consent (DCR);
- tools: server connected over OAuth, all seven tools listed;
- reads: the complete inventory (127 garments) and the published board;
- routine write: `board.select` with a receipt (actor `assistant`, channel `mcp`), shown on the app's board, with no wear recorded;
- undo: `command.undo` with its own receipt, after which the board has no choice;
- `board.swap_slot` answered `confirmation_required`;
- the model session (signed in) called `wardrobe.garderobe_today` and answered with the board id.

What these results do not cover:

- No hosted deployment was tested, so no hosted run has happened.
- Real Cloudflare Access was not used: consent was given with the local sign-in stand-in.
- The ChatGPT desktop app's plugin installer and its sign-in on install were not exercised; only the CLI was.

## Codex format

The format comes from OpenAI's documentation, read on 2026-10-12:

- [Package your plugin](https://developers.openai.com/plugins/build/plugins): root `plugin.json` with the Agent Plugins schema, root `mcp.json`, `skills/<name>/SKILL.md`, marketplaces in `.agents/plugins/marketplace.json`, `codex plugin marketplace add`, and per-plugin MCP policy under `plugins."<plugin>".mcp_servers.<server>`.
- [Model Context Protocol (Codex)](https://developers.openai.com/codex/mcp): streamable HTTP servers, OAuth with CIMD and DCR, `codex mcp login`, and approval modes.

Where this package differs from those pages, because of what Codex CLI 0.162.1 actually does:

- The documentation describes `extensions["com.openai"].auth` in `mcp.json` (OAuth client mode, scopes). Codex 0.162.1 silently drops a server entry that carries any field besides `type` and `url`: the plugin then installs, but no MCP server appears. So `mcp.json` declares only `type` and `url`. OAuth is Codex's default for a streamable HTTP server, discovery finds Garderobe's authorization server, and the scopes and registration mode are given to `codex mcp login`. `test/plugin.test.mjs` keeps it that way.
- OpenAI-specific presentation is inline in `plugin.json` under `extensions.com.openai`, so there is no `.codex-plugin/plugin.json`.

This plugin is for Codex only. The ChatGPT-native Wardrobe plugin is a separate project in another repository and is not part of this package.
