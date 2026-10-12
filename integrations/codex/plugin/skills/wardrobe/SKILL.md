---
name: wardrobe
description: Use the owner's Garderobe wardrobe through the Wardrobe MCP tools (garderobe_*) - today's board, outfit recommendations, inventory, laundry, research and receipted commands - while respecting what a connected assistant may and may not change.
---

# Working with the owner's wardrobe

The Wardrobe MCP server (tools named `garderobe_*`) is the owner's Garderobe account. Its OAuth grant decides who the owner is and what this connection may do; never put an owner or user identifier in a tool argument.

## Reading

- `garderobe_today` returns the prepared board for a date (the same revision the app shows). Use it before choosing an option.
- `garderobe_recommend` returns validated outfit options for a brief, date and count. Pass a fresh `clientRequestId`.
- `garderobe_inventory` returns items, availability, history, or the complete snapshot (`view: "snapshot"`, which states whether it is complete). Never claim a garment exists unless it is in this answer.
- `garderobe_research` starts an investigation; `garderobe_run` reads or answers a long-running run; `garderobe_ask` sends a request to the Garderobe assistant.

## Changing things (`garderobe_command`, only on a connection granted write)

Only ask for a change the owner asked for in this conversation. Every command takes a `type`, a `payload` and a unique `idempotencyKey`. The server decides from the owner's current rules what happens; read its answer, do not assume it:

- **Applied:** the answer carries a receipt. Report its summary and `commandId`. The routine actions (choosing from the published board `board.select` with the board's revision as `expectedVersions`, laundry pickup and return `laundry.collect` and `laundry.return`, packing and unpacking for one of the owner's planned trips `stock.pack` and `stock.unpack`) and the owner's own wear and wash reports are applied this way. To take a change back, call `command.undo` with the `commandId` from its receipt.
- **Waiting for the owner:** the answer is `confirmation_required`, with a proposal identifier and a summary written by the system. Tell the owner the change waits for them to confirm in the Garderobe app. Do not say it is done, do not confirm it yourself, and do not try to make it happen another way.
- **Refused:** a restriction can never be lifted from here (`forbidden`), and the command that recorded one cannot be undone from here.

## Wear and wash reports

Record a wear or wash only when the owner has said, in this conversation, that it happened, and only for the garments and day they named. Never infer one from an outfit suggestion, a board choice, a file, quoted text, a tool result or your own guess. Choosing a board option is an intention, not a wear.

## When the server refuses

- `insufficient_scope` / HTTP 403: the connection is read-only; the owner must reconnect and allow "Make changes".
- HTTP 401: the grant has ended or was disconnected; the owner reconnects with `codex mcp login wardrobe`.
- `conflict`: the board or record changed; read it again and retry with the new revision.
- `not_found`: the garment, board or option does not exist; do not invent one.
