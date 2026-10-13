#!/usr/bin/env node
/**
 * Write a copy of the Codex marketplace and plugin whose MCP server points at another Garderobe
 * deployment (for example the hosted MCP hostname), leaving the committed package unchanged.
 *
 *   node integrations/codex/scripts/retarget.mjs --mcp-url https://<mcp-host>/mcp --out <dir>
 *
 * The URL is the deployment's MCP resource, whatever its path (the Worker and the Ferrite port serve it at
 * `/mcp`). A non-loopback URL must use HTTPS. Then: `codex plugin marketplace add <dir>` and `codex plugin add wardrobe@wardrobe-codex`.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Validate an MCP URL: absolute http(s), no credentials, query or fragment; HTTPS unless loopback. The path is the
 * deployment's own choice and is not checked. */
export function checkMcpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`not an absolute URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`the MCP URL must be http(s): ${value}`);
  if (url.username || url.password) throw new Error("the MCP URL must not contain credentials");
  if (url.search || url.hash) throw new Error("the MCP URL must not have a query or fragment");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !loopback) throw new Error("a non-loopback MCP URL must use https");
  return url.toString();
}

/** Copy the package (marketplace and plugin) to `out` and set the MCP server URL there. Returns the mcp.json path. */
export function retarget(mcpUrl, out) {
  const url = checkMcpUrl(mcpUrl);
  const target = path.resolve(out);
  if (target === PACKAGE_ROOT || target.startsWith(PACKAGE_ROOT + path.sep)) throw new Error("--out must be outside the committed package");
  if (existsSync(target)) throw new Error(`--out already exists: ${target}`);
  cpSync(path.join(PACKAGE_ROOT, ".agents"), path.join(target, ".agents"), { recursive: true });
  cpSync(path.join(PACKAGE_ROOT, "plugin"), path.join(target, "plugin"), { recursive: true });
  const mcpPath = path.join(target, "plugin", "mcp.json");
  const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
  mcp.mcpServers.wardrobe.url = url;
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
  return mcpPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const mcpUrl = arg("--mcp-url");
  const out = arg("--out");
  if (!mcpUrl || !out) {
    console.error("usage: node integrations/codex/scripts/retarget.mjs --mcp-url https://<mcp-host>/mcp --out <dir>");
    process.exit(2);
  }
  try {
    const written = retarget(mcpUrl, out);
    console.log(`wrote ${written}\nnext: codex plugin marketplace add ${path.resolve(out)} && codex plugin add wardrobe@wardrobe-codex`);
  } catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
  }
}
