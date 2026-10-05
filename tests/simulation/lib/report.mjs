/** Turns the per-seed results of a run into the Markdown summary that is committed beside them. */
import { INVENTORY_VIEWS, TOOL_NAMES } from "./handlers-daily.mjs";

const sum = (list, pick) => list.reduce((n, item) => n + (pick(item) ?? 0), 0);
const row = (cells) => `| ${cells.join(" | ")} |`;
const table = (header, rows) => [row(header), row(header.map(() => "---")), ...rows.map(row)].join("\n");

export function summarize(results, { title, command, notes = [] }) {
  const out = [`# ${title}`, ""];
  const failed = sum(results, (r) => r.invariantChecks.failed);
  const incomplete = results.filter((r) => !r.completed);
  out.push(`Run command: \`${command}\``, "");
  out.push(`${results.length} seeds. ${incomplete.length === 0 ? "Every seed ran to its last step." : `${incomplete.length} seed(s) did NOT run to the last step: ${incomplete.map((r) => r.seed).join(", ")}.`} ${failed === 0 ? "No invariant check failed." : `${failed} invariant checks failed (listed below).`}`, "");
  for (const note of notes) out.push(note, "");

  out.push("## Seeds", "");
  out.push(
    table(
      ["Seed", "Simulated days", "Season", "Steps run / planned", "Step errors", "Checks passed", "Checks failed", "Not applicable", "MCP tool calls", "Commands", "Plan digest", "Outcome digest", "Real time"],
      results.map((r) => [r.seed, `${r.timeline.startDate} to ${r.timeline.endDate} (${r.timeline.days})`, r.timeline.season, `${r.steps.run} / ${r.steps.planned}`, r.steps.errors.length, r.invariantChecks.passed, r.invariantChecks.failed, r.invariantChecks.notApplicable, sum(Object.values(r.toolCoverage.byTool), (t) => t.calls), r.commands.total, `\`${r.timeline.planDigest}\``, `\`${r.outcomeDigest}\``, `${r.realSeconds} s`]),
    ),
    "",
  );

  out.push("## Tool coverage", "", "Calls made through the MCP client, per tool and seed (answered + refused with a typed error).", "");
  out.push(table(["Tool", ...results.map((r) => `Seed ${r.seed}`), "Exercised"], TOOL_NAMES.map((tool) => [`\`${tool}\``, ...results.map((r) => (r.toolCoverage.byTool[tool] ? `${r.toolCoverage.byTool[tool].answered} + ${r.toolCoverage.byTool[tool].refused}` : "0")), results.every((r) => (r.toolCoverage.byTool[tool]?.calls ?? 0) > 0) ? "yes, in every seed" : "NO"])), "");
  out.push("`garderobe_inventory` views:", "");
  out.push(table(["View", ...results.map((r) => `Seed ${r.seed}`)], INVENTORY_VIEWS.map((view) => [`\`${view}\``, ...results.map((r) => r.toolCoverage.inventoryViews[view] ?? 0)])), "");
  const actions = [...new Set(results.flatMap((r) => Object.keys(r.toolCoverage.runActions)))].sort();
  out.push("`garderobe_run` actions:", "", table(["Action", ...results.map((r) => `Seed ${r.seed}`)], actions.map((a) => [`\`${a}\``, ...results.map((r) => r.toolCoverage.runActions[a] ?? 0)])), "");
  const types = [...new Set(results.flatMap((r) => Object.keys(r.toolCoverage.commandTypes)))].sort();
  const routes = (entry) => (entry ? Object.entries(entry).map(([route, n]) => `${n} ${route.replaceAll("_", " ")}`).join(", ") : "0");
  out.push("`garderobe_command` types and the route each took (direct, confirmed by the owner in the app, rejected by the owner, refused; `owner app` marks the few commands only the signed-in owner can send):", "", table(["Command type", ...results.map((r) => `Seed ${r.seed}`)], types.map((t) => [`\`${t}\``, ...results.map((r) => routes(r.toolCoverage.commandTypes[t]))])), "");
  out.push(table(["OAuth and the owner's part", ...results.map((r) => `Seed ${r.seed}`)], [["Connections authorized through consent", ...results.map((r) => r.toolCoverage.oauth.authorizations)], ["Access tokens renewed with the refresh token", ...results.map((r) => r.toolCoverage.oauth.tokenRefreshes)], ["Requests made as the signed-in owner (consent, decisions, setup)", ...results.map((r) => r.toolCoverage.ownerRequestsInTheApp)], ["Test-door requests (clock, scheduled sweep, scripted conditions)", ...results.map((r) => r.toolCoverage.testDoorRequests)], ["MCP resources read", ...results.map((r) => Object.keys(r.toolCoverage.resourcesRead).length)]]), "");

  out.push("## Conditions in the timelines", "", "Planned by the seed:", "");
  for (const group of ["weather", "calendar", "availability", "circumstance"]) {
    const keys = Object.keys(results[0].conditions.planned[group]);
    out.push(table([`${group[0].toUpperCase()}${group.slice(1)}`, ...results.map((r) => `Seed ${r.seed}`)], keys.map((k) => [k.replaceAll("_", " "), ...results.map((r) => r.conditions.planned[group][k])])), "");
  }
  const observed = [...new Set(results.flatMap((r) => Object.keys(r.conditions.observed)))].sort();
  out.push("Counted while running (what actually happened on the target):", "", table(["Condition", ...results.map((r) => `Seed ${r.seed}`)], observed.map((k) => [k, ...results.map((r) => r.conditions.observed[k] ?? 0)])), "");

  out.push("## Invariant checks", "", "Passed / failed / not applicable, per check and seed. Every check listed under \"after every step\" in the README ran after each step.", "");
  const checks = [...new Set(results.flatMap((r) => Object.keys(r.invariantChecks.byCheck)))].sort();
  out.push(table(["Check", ...results.map((r) => `Seed ${r.seed}`)], checks.map((c) => [`\`${c}\``, ...results.map((r) => { const e = r.invariantChecks.byCheck[c]; return e ? `${e.passed} / ${e.failed}${e.failed > 0 ? " FAILED" : ""} / ${e.notApplicable}` : "-"; })])), "");

  out.push("## Failed checks", "");
  if (failed === 0) out.push("None.", "");
  for (const r of results) {
    if (r.failures.length === 0) continue;
    out.push(`### Seed ${r.seed}`, "");
    const groups = new Map();
    for (const f of r.failures) groups.set(f.check, [...(groups.get(f.check) ?? []), f]);
    for (const [check, list] of groups) {
      const first = list[0];
      out.push(`- \`${check}\`: ${r.invariantChecks.byCheck[check].failed} time(s). First at step ${first.step} (${first.stepKind}, day ${first.day === null ? "setup" : first.day + 1}, ${first.date ?? ""}, target time ${first.at}): ${first.message}${first.evidence?.commandId ? ` Receipt: command \`${first.evidence.commandId}\`${first.evidence.summary ? `, "${first.evidence.summary}"` : ""}.` : ""}`);
    }
    out.push("");
  }
  const errors = results.flatMap((r) => r.steps.errors.map((e) => ({ seed: r.seed, ...e })));
  if (errors.length > 0) out.push("## Steps that did not run to their end", "", ...errors.map((e) => `- seed ${e.seed}, step ${e.step} (${e.kind}, day ${e.day + 1}, ${e.at}): ${e.message}`), "");
  const fatal = results.filter((r) => r.fatal);
  if (fatal.length > 0) out.push("## Runs that stopped", "", ...fatal.map((r) => `- seed ${r.seed}: ${r.fatal.split("\n")[0]}`), "");
  return out.join("\n");
}
