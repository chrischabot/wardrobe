/**
 * Step handlers, part 1: the setup of a run and the steps of every day (the scheduled sweep, the
 * morning decision, the wear report, the evening look at tomorrow with the repair probe, the nightly
 * inventory view and the isolation check).
 */
import { addDays } from "./dates.mjs";
import { checkOptions } from "./invariants.mjs";
import { isSynthetic } from "./profile-check.mjs";
import { byDraw, stream } from "./rng.mjs";
import { composition, quantityIn, stableJson } from "./sim.mjs";

export const INVENTORY_VIEWS = ["items", "snapshot", "item", "availability", "history", "laundry", "style", "resolve", "selection", "receipts", "command_types", "trips", "returns", "orders"];
export const TOOL_NAMES = ["garderobe_ask", "garderobe_command", "garderobe_inventory", "garderobe_recommend", "garderobe_research", "garderobe_run", "garderobe_today"];

const byName = (a, b) => a.garment.name.localeCompare(b.garment.name) || a.garment.garmentId.localeCompare(b.garment.garmentId);

/** Garments of a role the simulated owner could take from the wardrobe right now, in a stable order. */
export function candidates(sim, snapshot, role, { singleUnit = false, allowSynthetic = false, exclude = new Set(), where = () => true } = {}) {
  return snapshot.items
    .filter((i) => i.garment.roles.includes(role) && i.garment.acquisition === "owned" && i.availability && !i.availability.hardExcluded && i.availability.restrictionIds.length === 0)
    .filter((i) => i.garment.planningPolicy === "normal" && (allowSynthetic || !isSynthetic(i.garment.name)) && !exclude.has(i.garment.garmentId) && !sim.unavailable.has(i.garment.garmentId))
    .filter((i) => (!singleUnit || i.totalOwnedUnits === 1) && quantityIn(i, "clean") > 0 && where(i))
    .sort(byName);
}

export const pickGarment = (sim, snapshot, role, draw, options) => byDraw(candidates(sim, snapshot, role, options), draw);

/* ------------------------------------------------------------------ */
/* Setup                                                                */
/* ------------------------------------------------------------------ */

export async function setup(sim) {
  const { target, plan } = sim;
  const primary = await target.claim("primary");
  sim.userId = primary.userId ?? (await target.apiOk("primary", "GET", "/v1/me")).userId;
  const second = await target.claim("second");
  sim.secondUserId = second.userId ?? (await target.apiOk("second", "GET", "/v1/me")).userId;
  sim.check("isolation.two_distinct_owners", Boolean(sim.userId) && Boolean(sim.secondUserId) && sim.userId !== sim.secondUserId, "the two sign-ins map to the same owner");

  sim.sessions.writer = await target.connect("primary", { write: true, clientName: `Simulation assistant, seed ${plan.seed} (read and write)`, redirectUri: "https://simulation-writer.invalid/oauth/callback" });
  sim.sessions.reader = await target.connect("primary", { write: false, clientName: `Simulation assistant, seed ${plan.seed} (read only)`, redirectUri: "https://simulation-reader.invalid/oauth/callback" });
  sim.sessions.second = await target.connect("second", { write: true, clientName: `Simulation assistant of the SYNTHETIC second owner, seed ${plan.seed}`, redirectUri: "https://simulation-second.invalid/oauth/callback" });

  const writerTools = (await sim.sessions.writer.listTools()).map((t) => t.name).sort();
  const readerTools = (await sim.sessions.reader.listTools()).map((t) => t.name).sort();
  sim.check("mcp.write_connection_offers_all_seven_tools", JSON.stringify(writerTools) === JSON.stringify(TOOL_NAMES), `offered: ${writerTools.join(", ")}`);
  sim.check("mcp.read_only_connection_is_not_offered_the_write_tool", readerTools.length === 6 && !readerTools.includes("garderobe_command"), `offered: ${readerTools.join(", ")}`);
  await forcedReadOnlyWrite(sim);

  const resources = (await sim.sessions.reader.listResources()).map((r) => r.uri).sort();
  sim.check("mcp.resources_listed", ["garderobe://commands", "garderobe://guide", "garderobe://style/profile"].every((uri) => resources.includes(uri)), `listed: ${resources.join(", ")}`);
  for (const uri of resources) {
    const contents = await sim.sessions.reader.readResource(uri);
    sim.check("mcp.resource_readable", contents.length > 0 && typeof contents[0].text === "string" && contents[0].text.length > 0, `${uri} is empty`);
  }

  // Scripted conditions (only where the target has that door; a deployment uses its real adapters).
  if (target.doors.weather) {
    const home = {};
    for (const { day, script } of plan.weather.baseline) {
      home[sim.dateOf(day)] = script;
      sim.scriptedWeather.set(sim.dateOf(day), script);
    }
    const away = {};
    for (const { day, script } of plan.weather.trip) away[sim.dateOf(day)] = script;
    const { label, latitude, longitude, timezone } = plan.trip.place;
    await target.scriptWeather({ places: [plan.home, { label, latitude, longitude, timezone }], days: { [plan.home.label]: home, [label]: away } });
    sim.count("days with a scripted forecast (SIMULATED weather)", plan.dayCount);
  } else sim.notes.push({ check: "conditions", step: 0, why: "the target has no weather door: the forecast is whatever its real weather adapter returns, and thermal checks do not run" });

  // Where he lives, sent by the connected assistant like any other change: under the 2026-10-05 contract it applies at once.
  const home = await sim.mustCommit("settings.update", { patch: { timezone: plan.timezone, homeLocation: { label: plan.home.label, latitude: plan.home.latitude, longitude: plan.home.longitude } } }, { label: "home location" });
  sim.expectContractRoute("settings.update", home);

  if (target.doors.calendar) {
    const started = await target.apiOk("primary", "POST", "/v1/connections", { clientRequestId: sim.key("connection"), kind: "google_workspace", name: "Google (SIMULATED stand-in)", auth: { type: "oauth" }, capabilities: ["calendar.read", "calendar.write_outfit_calendar"] });
    const state = new URL(started.authorizationUrl).searchParams.get("state");
    // Through the owner's sign-in (behind Cloudflare Access on a deployment). The product answers a completed
    // callback with its own page, status 200 (apps/worker/src/routes/connections.ts); a redirect is a sign-in
    // page in front of it, never a completion.
    const callback = await target.appGet("primary", `/connections/callback?state=${encodeURIComponent(state)}&code=simulation-code`);
    if (callback.status !== 200) throw new Error(`the connection callback answered ${callback.status}${callback.location ? ` (redirect to ${callback.location})` : ""}: ${callback.text.slice(0, 300)}`);
    sim.calendar.connectionId = started.connection.connectionId;
    const created = await target.apiOk("primary", "POST", `/v1/connections/${sim.calendar.connectionId}/outfit-calendar`, { clientRequestId: sim.key("outfit-calendar"), name: "Outfits (simulation)" });
    sim.calendar.outfitCalendarId = created.calendar.calendarId;
  } else sim.notes.push({ check: "conditions", step: 0, why: "the target has no calendar door: calendar entries are not scripted and the Calendar event is checked only through the board's own projection state" });

  // The wardrobe as imported: every garment, no invented wear, the profile's restriction in force.
  const snapshot = await sim.snapshot();
  const expected = target.description.owners.primary.importedGarments;
  if (expected) sim.check("import.every_garment_present", snapshot.total === expected && snapshot.items.length === expected, `the snapshot holds ${snapshot.items.length} of ${expected} imported garments`);
  sim.check("import.no_invented_wear_history", snapshot.items.every((i) => i.recordedWearCount === 0 && i.lastRecordedWear === null), "a garment carries a recorded wear before the simulation reported any");
  for (const item of snapshot.items) if ((item.availability?.restrictionIds ?? []).length > 0) sim.restrictedAtStart.set(item.garment.garmentId, [...item.availability.restrictionIds]);
  sim.check("restriction.profile_restriction_in_force_at_start", sim.restrictedAtStart.size > 0, "no garment is restricted although the profile puts the welted fleet and the 990v6 out of play");
  for (const ids of sim.restrictedAtStart.values()) for (const id of ids) sim.healingRestrictionIds.add(id);
  sim.count("garments restricted by the profile at the start", sim.restrictedAtStart.size);

  // The second owner is SYNTHETIC and owns only labelled synthetic garments, created through its own connection.
  for (const [name, category, role] of [["SYNTHETIC second-owner shirt (isolation check)", "shirt", "top"], ["SYNTHETIC second-owner trousers (isolation check)", "trousers", "bottom"]]) {
    const created = await sim.mustCommit("garment.create", { name, category, roles: [role], careChannel: "service", acquisition: "owned", quantity: 1, isSynthetic: true, source: { kind: "system", note: "synthetic garment of the simulation's second owner" } }, { session: sim.sessions.second, ownerKey: "second", label: "second owner's synthetic garment" });
    const id = created.receipt.affected.find((a) => a.kind === "garment")?.id;
    if (id) sim.synthetic.second.push(id);
  }

  for (const view of INVENTORY_VIEWS) await exerciseView(sim, view, 0.5);
}

/**
 * A read-only connection forces the write tool with a valid change to a real, owned garment (one clean unit
 * marked as needing a wash). The MCP endpoint must deny it for scope (HTTP 403 with an `insufficient_scope`
 * challenge naming the write permission), the SDK client must not get a result, and nothing may change.
 */
async function forcedReadOnlyWrite(sim) {
  const id = "mcp.read_only_connection_cannot_write";
  const before = await sim.inventory({ view: "snapshot" });
  const victim = [...(before.data.items ?? [])].sort(byName).find((i) => i.garment.acquisition === "owned" && !isSynthetic(i.garment.name) && quantityIn(i, "clean") > 0);
  if (!victim) return sim.notApplicable(id, "no owned garment with a clean unit to aim the forced write at");
  const args = { type: "care.mark_dirty", payload: { items: [{ garmentId: victim.garment.garmentId, quantity: 1 }] }, idempotencyKey: sim.key("forced") };
  const reader = sim.sessions.reader;
  const raw = await fetch(reader.url, { method: "POST", headers: { authorization: `Bearer ${reader.oauth.tokens()?.access_token ?? ""}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "garderobe_command", arguments: args } }) });
  const challenge = raw.headers.get("www-authenticate") ?? "";
  await raw.text().catch(() => "");
  sim.check("mcp.read_only_write_is_denied_for_scope", raw.status === 403 && /insufficient_scope/.test(challenge) && /wardrobe\.write/.test(challenge), `a read-only connection's garderobe_command answered HTTP ${raw.status} with challenge "${challenge.slice(0, 200)}"`, { status: raw.status, challenge: challenge.slice(0, 300) });
  const viaClient = await reader.client.callTool({ name: "garderobe_command", arguments: { ...args, idempotencyKey: sim.key("forced") } }).then((r) => ({ ran: !r.isError, message: null }), (error) => ({ ran: false, message: String(error?.message ?? error).slice(0, 300) }));
  const after = await sim.inventory({ view: "snapshot" });
  const victimAfter = (after.data.items ?? []).find((i) => i.garment.garmentId === victim.garment.garmentId);
  const unchanged = after.wardrobeRevision === before.wardrobeRevision && quantityIn(victimAfter, "clean") === quantityIn(victim, "clean") && quantityIn(victimAfter, "dirty") === quantityIn(victim, "dirty");
  sim.check(id, !viaClient.ran && unchanged, `a read-only connection's forced write on ${victim.garment.name}: ${viaClient.ran ? "ran" : "was refused"}; ledger revision ${before.wardrobeRevision} -> ${after.wardrobeRevision}, clean ${quantityIn(victim, "clean")} -> ${quantityIn(victimAfter, "clean")}`, { garment: victim.garment.name, clientError: viaClient.message });
}

/* ------------------------------------------------------------------ */
/* Inventory views                                                      */
/* ------------------------------------------------------------------ */

/** Read one inventory view in depth and check what it says about itself. */
export async function exerciseView(sim, view, draw) {
  const snapshot = await sim.snapshot();
  const any = byDraw([...snapshot.items].sort(byName), draw);
  const today = sim.today();
  const args = { view };
  if (view === "items") args.limit = 40;
  if (view === "item") args.garmentId = any.garment.garmentId;
  if (view === "availability") args.date = today;
  if (view === "history") args.date = today;
  if (view === "resolve") args.phrase = any.garment.name;
  if (view === "selection") args.selector = { category: any.garment.category };
  if (view === "receipts") args.limit = 10;
  const envelope = await sim.inventory(args);
  sim.check("inventory.view_describes_itself", envelope.view === view && typeof envelope.complete === "boolean" && !Number.isNaN(Date.parse(envelope.readAt)) && Number.isInteger(envelope.wardrobeRevision), `view ${view}: ${JSON.stringify({ view: envelope.view, complete: envelope.complete, readAt: envelope.readAt })}`);
  const data = envelope.data;
  if (view === "items") {
    const seen = [...(data.items ?? []).map((i) => i.garment.garmentId)];
    let cursor = envelope.nextCursor;
    let honest = cursor ? envelope.complete === false : true;
    for (let page = 0; cursor && page < 50; page++) {
      const next = await sim.inventory({ view: "items", limit: 40, cursor });
      seen.push(...(next.data.items ?? []).map((i) => i.garment.garmentId));
      cursor = next.nextCursor;
      if (cursor && next.complete !== false) honest = false;
    }
    sim.check("inventory.pages_reach_everything_exactly_once", honest && seen.length === envelope.total && new Set(seen).size === seen.length && envelope.total === snapshot.total, `paging saw ${seen.length} (${new Set(seen).size} distinct) of ${envelope.total}; the snapshot has ${snapshot.total}`);
  }
  if (view === "snapshot") sim.check("inventory.snapshot_is_complete", envelope.complete === true && envelope.nextCursor === null && envelope.total === (data.items ?? []).length, `snapshot: complete ${envelope.complete}, total ${envelope.total}, items ${(data.items ?? []).length}`);
  if (view === "item") sim.check("inventory.item_matches_the_snapshot", data.detail?.garment?.garmentId === any.garment.garmentId && data.detail.garment.name === any.garment.name && data.detail.recordedWearCount === any.recordedWearCount, `item view of ${any.garment.name} disagrees with the snapshot`);
  if (view === "availability") {
    sim.check("availability.parameters_are_stated_as_hypotheses", data.parameters?.parameterStatus === "hypothesis", `parameter status: ${data.parameters?.parameterStatus}`);
    const viewFlags = new Map((data.garments ?? []).map((g) => [g.garmentId, `${g.status}:${g.hardExcluded}`]));
    const snapFlags = new Map(snapshot.items.filter((i) => i.availability).map((i) => [i.garment.garmentId, `${i.availability.status}:${i.availability.hardExcluded}`]));
    // A garment the snapshot does not list as wearable (retired, disposed, merged: absent, or listed without availability)
    // may appear in the view only as unavailable and hard-excluded.
    const differing = [...new Set([...viewFlags.keys(), ...snapFlags.keys()])]
      .filter((id) => !(!snapFlags.has(id) && viewFlags.get(id) === "unavailable:true"))
      .filter((id) => viewFlags.get(id) !== snapFlags.get(id))
      .sort()
      .map((id) => ({ garmentId: id, name: snapshot.byId.get(id)?.garment.name ?? null, view: viewFlags.get(id) ?? null, snapshot: snapFlags.get(id) ?? null }));
    sim.check("inventory.availability_view_matches_the_snapshot", differing.length === 0, `the availability view and the snapshot disagree on ${differing.length} garment(s): ${differing.slice(0, 5).map((d) => `${d.name ?? d.garmentId} (view ${d.view}, snapshot ${d.snapshot})`).join("; ")}`, { date: today, differing: differing.slice(0, 20) });
  }
  if (view === "history") {
    const mine = [...(sim.wears.get(today) ?? new Map()).keys()].sort().join(",");
    sim.check("inventory.day_record_is_what_was_reported", (data.garments ?? []).map((g) => g.garmentId).sort().join(",") === mine, `the record of ${today} differs from what the simulation reported`);
  }
  if (view === "resolve") sim.check("inventory.resolve_finds_a_garment_by_its_own_name", (data.matches ?? []).some((m) => m.garmentId === any.garment.garmentId), `"${any.garment.name}" does not resolve to itself`);
  if (view === "selection") sim.check("inventory.selection_counts_what_it_lists", data.count === (data.garments ?? []).length && data.count > 0, `selection of category ${any.garment.category}: count ${data.count}, listed ${(data.garments ?? []).length}`);
  if (view === "style") sim.check("inventory.style_is_the_owner_s_profile", typeof data.document?.content === "string" && data.document.content.includes("Hard constraints") && Array.isArray(data.rules) && data.rules.length > 0, "the style view does not carry the profile and its rules");
  if (view === "command_types") {
    const types = new Map((data.types ?? []).map((t) => [t.type, t]));
    sim.commandTypes = types;
    sim.check("inventory.command_types_mark_only_section_3_as_waiting", types.get("wear.record")?.consequential === false && types.get("restriction.add")?.consequential === false && types.get("garment.retire")?.consequential === false && types.get("garment.merge")?.consequential === true, `command_types marks wear.record ${types.get("wear.record")?.consequential}, restriction.add ${types.get("restriction.add")?.consequential}, garment.retire ${types.get("garment.retire")?.consequential}, garment.merge ${types.get("garment.merge")?.consequential} as consequential; the contract expects only section 3 types (garment.merge) to be`);
  }
  if (view === "trips" && sim.trip.tripId) sim.check("inventory.trips_show_the_simulated_trip", (data.trips ?? []).some((t) => t.tripId === sim.trip.tripId), "the trip the simulation created is not listed");
  return envelope;
}

/* ------------------------------------------------------------------ */
/* The scheduled sweep                                                  */
/* ------------------------------------------------------------------ */

export async function sweep(sim) {
  if (!sim.target.doors.scheduled) {
    sim.count("sweeps left to the deployment's own cron (no scheduled door)");
    return;
  }
  await sim.target.runScheduled();
  sim.count("scheduled sweeps run (the product's own scheduled handler)");
}

/* ------------------------------------------------------------------ */
/* The morning                                                          */
/* ------------------------------------------------------------------ */

const ORDINARY_BRIEFS = ["something for the office", "a long walk and then lunch out", "dinner out tonight", "errands on foot, nothing formal"];

function briefFor(sim, day) {
  if (day.circumstance === "work_from_home") return "(SIMULATED circumstance) Working from home today; nobody will see me.";
  if (day.circumstance === "ill") return "(SIMULATED circumstance) Unwell and staying in; comfort only.";
  return byDraw(ORDINARY_BRIEFS, day.secondOptionDraw);
}

async function select(sim, board, option, label) {
  const outcome = await sim.command("board.select", { boardId: board.boardId, optionId: option ? option.optionId : null }, { expectedVersions: { [`board:${board.boardId}`]: board.revision }, label });
  if (!outcome.receipt) {
    sim.check("choice.accepted_on_the_published_board", false, `choosing on the board of ${board.localDate} was refused: ${outcome.error?.code} ${outcome.error?.message}`, { boardId: board.boardId, revision: board.revision, error: outcome.error });
    return null;
  }
  sim.check("choice.accepted_on_the_published_board", true);
  sim.check("choice.runs_without_a_tap", outcome.route === "direct", `board.select took the route ${outcome.route}`, { commandId: outcome.receipt.commandId });
  const after = (await sim.todayBoard(board.localDate)).board;
  sim.check("choice.is_shown_on_the_board", option ? after?.selection?.optionId === option.optionId : !after?.selection, `after choosing, the board of ${board.localDate} shows ${after?.selection?.optionId ?? "no selection"}`, { commandId: outcome.receipt.commandId });
  return after;
}

/** Ask for other options; the answer must be valid, publish nothing and be the same when asked again with the same request. */
export async function recommend(sim, date, { count, brief, tripPacked = null } = {}) {
  const before = (await sim.todayBoard(date)).board;
  const args = { date, ...(count ? { count } : {}), ...(brief ? { brief } : {}), clientRequestId: sim.key("recommend") };
  let result = await sim.sessions.reader.callTool("garderobe_recommend", args);
  if (!result.ok) {
    sim.check("recommend.answers", false, `garderobe_recommend for ${date} was refused: ${result.error.code} ${result.error.message}`, { args, error: result.error });
    return null;
  }
  for (let i = 0; result.ok && result.data.state === "running" && i < 60; i++) {
    const run = await sim.sessions.reader.callTool("garderobe_run", { runId: result.data.runId });
    if (run.ok && run.data.run.state !== "running" && run.data.run.state !== "queued") result = await sim.sessions.reader.callTool("garderobe_recommend", args);
    else await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!result.ok) {
    sim.check("recommend.answers", false, `garderobe_recommend for ${date} was refused while its run was followed: ${result.error.code} ${result.error.message}`, { args, error: result.error });
    return null;
  }
  sim.check("recommend.answers", result.ok && result.data.state === "completed", `the recommendation for ${date} is ${result.data?.state}`, { args });
  if (!result.ok || result.data.state !== "completed") return null;
  const options = result.data.options;
  sim.check("recommend.no_more_than_asked", !count || options.length <= count, `asked for ${count}, got ${options.length}`);
  sim.check("recommend.says_so_when_it_has_too_few", (count ? options.length >= count : options.length > 0) || result.data.insufficient === true || Boolean(result.data.note), count ? `asked for ${count} options for ${date}, got ${options.length}, with no shortfall flag and no note` : `no option for ${date} and no explanation`);
  if (options.length > 0) checkOptions(sim, await sim.snapshot(), options, { date, source: "recommendation", freshness: null, tripPacked });
  const again = await sim.sessions.reader.callTool("garderobe_recommend", args);
  // Compare the whole answer (every option field and offered line, the board, the shortfall flag and the note);
  // only the run ID, the read time and the ledger revision it was read at describe the response, not the answer.
  // The repeat must itself be a completed answer.
  const stable = (data) => {
    const { runId: _runId, readAt: _readAt, wardrobeRevision: _revision, state: _state, ...answer } = data ?? {};
    return stableJson(answer);
  };
  sim.check("recommend.same_request_same_answer", again.ok && again.data.state === "completed" && stable(again.data) === stable(result.data), again.ok ? `the same request ID answered ${again.data.state === "completed" ? "with different content" : `with state ${again.data.state}`}` : `the repeat was refused: ${again.error.code}`);
  const after = (await sim.todayBoard(date)).board;
  sim.check("recommend.publishes_nothing", (before?.revision ?? 0) === (after?.revision ?? 0) && (before?.selection?.optionId ?? null) === (after?.selection?.optionId ?? null), `the board of ${date} moved from revision ${before?.revision ?? 0} to ${after?.revision ?? 0} after a recommendation`);
  sim.trace.push(["recommend", date, options.map(composition)]);
  return { options, note: result.data.note, insufficient: result.data.insufficient };
}

export async function morning(sim, step) {
  const day = sim.plan.days[step.day];
  const date = day.date;
  if (day.circumstance === "trip") return tripMorning(sim, day);
  const view = await sim.todayBoard(date);
  if (day.circumstance === "paused") {
    sim.count("mornings while the service was paused");
    return;
  }
  sim.check("board.prepared_for_the_morning", Boolean(view.board), `no board for ${date} at 07:15: ${view.emptyReason ?? view.status}`, { date, status: view.status });
  if (!view.board) return;
  let board = view.board;
  sim.count(`morning boards: ${board.validity}`);
  sim.count(`morning boards, forecast ${board.freshness.weather}`);
  sim.count(`morning boards, calendar ${board.freshness.calendar}`);
  if (board.options.some((o) => (o.suitsEventIds ?? []).length > 0)) sim.count("morning boards with options marked as suiting a calendar entry");
  sim.check("board.offers_at_least_one_option_or_says_why", board.options.length > 0 || Boolean(board.notice), `the board of ${date} is empty and gives no notice`, { boardId: board.boardId });
  sim.check("board.limited_when_the_forecast_is_not_fresh", board.freshness.weather === "fresh" || board.validity !== "current" || Boolean(board.notice), `the board of ${date} reads as current although its forecast is ${board.freshness.weather}`, { boardId: board.boardId, validity: board.validity });
  const options = [...board.options].sort((a, b) => a.number - b.number);
  if (options.length === 0) return;
  const wearsBefore = new Set((view.dayRecord ?? []).map((g) => g.garmentId));
  const decision = day.circumstance === "ill" ? "no_choice" : day.morning;
  sim.count(`morning decision: ${decision}`);
  sim.trace.push(["morning", date, decision, options.map(composition)]);
  if (decision === "choose" || decision === "choose_then_change") {
    const first = byDraw(options, day.optionDraw);
    board = (await select(sim, board, first, "morning choice")) ?? board;
    let settled = first;
    if (decision === "choose_then_change" && options.length > 1) {
      const others = options.filter((o) => o.optionId !== first.optionId);
      settled = byDraw(others, day.secondOptionDraw);
      board = (await select(sim, board, settled, "changed his mind")) ?? board;
    }
    sim.chosen.set(date, { option: settled, source: "board" });
    sim.trace.push(["chosen", date, composition(settled)]);
    const record = (await sim.todayBoard(date)).dayRecord ?? [];
    sim.check("choice.is_an_intention_not_a_wear", record.every((g) => wearsBefore.has(g.garmentId)), `choosing an option put ${record.filter((g) => !wearsBefore.has(g.garmentId)).map((g) => g.name).join(", ")} on the day's record`, { date });
  } else if (decision === "reject_and_ask_again") {
    if (board.selection) await select(sim, board, null, "cleared last night's choice");
    const answer = await recommend(sim, date, { count: day.requestedCount, brief: briefFor(sim, day) });
    if (answer && answer.options.length > 0) {
      const picked = byDraw(answer.options, day.optionDraw);
      sim.chosen.set(date, { option: picked, source: "recommendation" });
      sim.trace.push(["chosen", date, composition(picked)]);
    } else sim.chosen.delete(date);
  } else if (!sim.chosen.has(date)) {
    // No choice: he dresses from the board anyway, here from its first option.
    sim.chosen.set(date, { option: options[0], source: "board, not chosen" });
  }
}

async function tripMorning(sim, day) {
  const date = day.date;
  sim.count("mornings away on the trip");
  if (!sim.trip.tripId || sim.trip.packed.size === 0) {
    sim.notApplicable("recommended.trip_day_uses_packed_pieces_only", "nothing was packed for the trip");
    return;
  }
  const answer = await recommend(sim, date, { count: 3, tripPacked: sim.trip.packed });
  if (!answer || answer.options.length === 0) {
    // When he packed exactly what the proposal asked for, an undressable trip day is the product's failure. When
    // he left proposed pieces at home (they were not clean that evening), the suitcase is his, not the proposal's.
    const leftBehind = sim.trip.leftBehind ?? [];
    if (leftBehind.length > 0) {
      sim.notApplicable("trip.a_trip_day_is_answered_from_the_suitcase", `no option for ${date} (${answer?.note ?? "no answer"}), but the simulated owner left ${leftBehind.length} proposed piece(s) at home: ${leftBehind.map((i) => `${i.name} (${i.role})`).join(", ")}`);
      sim.count("trip days undressable because proposed pieces were left at home (SIMULATED owner's packing)");
      return;
    }
    sim.check("trip.a_trip_day_is_answered_from_the_suitcase", false, `no option for the trip day ${date}, packed exactly to the proposal: ${answer?.note ?? "no answer"}`, { date, packed: [...sim.trip.packed.keys()].length });
    return;
  }
  sim.check("trip.a_trip_day_is_answered_from_the_suitcase", true);
  const option = byDraw(answer.options, day.optionDraw);
  const ids = [...new Set(option.garments.map((g) => g.garmentId))];
  sim.trace.push(["trip_wear", date, composition(option)]);
  const outcome = await sim.command("wear.record", { wearingDate: date, garmentIds: ids, tripId: sim.trip.tripId }, { label: "worn on the trip" });
  if (outcome.receipt) {
    sim.recordWear(date, ids);
    sim.count("wear reports from the suitcase");
  } else sim.check("wear.report_accepted", false, `the wear report from the trip was refused: ${outcome.error?.code} ${outcome.error?.message}`, { date, error: outcome.error });
}

/* ------------------------------------------------------------------ */
/* The wear report                                                      */
/* ------------------------------------------------------------------ */

/** What he actually wore, relative to what he settled on in the morning. */
async function wornSet(sim, day) {
  const snapshot = await sim.snapshot();
  const rng = stream(sim.plan.seed, `wear-${day.index}`);
  const wearable = (id) => {
    const item = snapshot.byId.get(id);
    // He never wears what the profile's restriction puts out of play, and cannot wear what is gone or away.
    return item && item.garment.acquisition === "owned" && (item.availability?.restrictionIds ?? []).length === 0 && !sim.unavailable.has(id) && quantityIn(item, "clean") + quantityIn(item, "dirty") > 0;
  };
  const free = (role, exclude = new Set()) => pickGarment(sim, snapshot, role, rng.next(), { exclude });
  const freeOutfit = () => ["top", "bottom", "socks", "footwear"].map((role) => free(role)).filter(Boolean).map((i) => i.garment.garmentId);
  const settled = sim.chosen.get(day.date)?.option ?? null;
  const paused = day.circumstance === "paused";
  let mode = paused || !settled ? "something_else" : day.wear;
  let ids;
  if (mode === "something_else") ids = freeOutfit();
  else {
    const lines = settled.garments.filter((g) => wearable(g.garmentId));
    ids = lines.map((g) => g.garmentId);
    if (mode === "one_piece_differs") {
      const role = byDraw(["top", "bottom"], day.pieceDraw);
      const current = lines.find((g) => g.role === role);
      const other = free(role, new Set(ids));
      if (current && other) ids = ids.map((id) => (id === current.garmentId ? other.garment.garmentId : id));
      else mode = "as_chosen";
    }
  }
  sim.count(`worn: ${mode.replaceAll("_", " ")}`);
  return { ids: [...new Set(ids)], snapshot, mode };
}

async function reportWear(sim, day, date, ids, snapshot, { late = false } = {}) {
  if (ids.length === 0) {
    sim.notApplicable("wear.report_accepted", `nothing wearable could be chosen for ${date}`);
    return;
  }
  const payload = { wearingDate: date, garmentIds: ids };
  if (day.secondSockPair) {
    const sock = ids.map((id) => snapshot.byId.get(id)).find((i) => i && i.garment.roles.includes("socks") && quantityIn(i, "clean") >= 2);
    if (sock) {
      payload.additionalUnits = [{ garmentId: sock.garment.garmentId, quantity: 1 }];
      sim.count("wear reports with a second pair of socks used");
    }
  }
  const outcome = await sim.command("wear.record", payload, { label: late ? "reported the next morning" : "wear report" });
  sim.check("wear.report_accepted", Boolean(outcome.receipt), `the wear report for ${date} was refused: ${outcome.error?.code} ${outcome.error?.message}`, { date, garments: ids.map((id) => snapshot.byId.get(id)?.garment.name), error: outcome.error });
  if (!outcome.receipt) return;
  sim.check("wear.report_runs_without_a_tap", outcome.route === "direct", `a wear report for ${date} took the route ${outcome.route}`, { commandId: outcome.receipt.commandId });
  sim.recordWear(date, ids);
  sim.count(late ? "wear reports made the next morning" : "wear reports made the same evening");
  sim.lastDirect.push({ commandId: outcome.receipt.commandId, date, ids, undone: false });
  if (day.reportedTwice) {
    // The same thing said again, as a new report: it must merge, never count twice.
    const second = await sim.command("wear.record", { wearingDate: date, garmentIds: ids }, { label: "the same report again" });
    sim.check("wear.duplicate_report_is_not_a_new_wear", Boolean(second.receipt) && ["merged", "noop"].includes(second.receipt.outcome), `the repeated report answered ${second.receipt ? second.receipt.outcome : second.error?.code}`, { first: outcome.receipt.commandId, second: second.receipt?.commandId ?? null, summary: second.receipt?.summary });
    sim.count("wear reports repeated as a new report");
  }
  if (day.alsoReportedInApp) {
    const viaApp = await sim.ownerCommand("wear.record", { wearingDate: date, garmentIds: ids });
    sim.check("wear.duplicate_report_is_not_a_new_wear", Boolean(viaApp.receipt) && ["merged", "noop"].includes(viaApp.receipt.outcome), `the same report from the app answered ${viaApp.receipt ? viaApp.receipt.outcome : viaApp.error?.code}`, { first: outcome.receipt.commandId, second: viaApp.receipt?.commandId ?? null });
    sim.count("wear reports repeated from the owner's app");
  }
  if (day.comfortNote) {
    const note = await sim.command("feedback.record", { text: `(SIMULATED note) ${day.comfortNote.replace("_", " ")} today.`, kind: day.comfortNote, garmentIds: [ids[0]], wearingDate: date }, { label: "comfort note" });
    sim.check("feedback.optional_note_recorded", Boolean(note.receipt), `the comfort note was refused: ${note.error?.code} ${note.error?.message}`, { error: note.error });
    sim.count(`comfort notes: ${day.comfortNote}`);
  }
}

export async function eveningReport(sim, step) {
  const day = sim.plan.days[step.day];
  if (day.circumstance === "trip") return; // reported in the morning, from the suitcase
  if (day.wear === "no_report") {
    sim.count("days with no wear report");
    sim.trace.push(["wear", day.date, "none"]);
    return;
  }
  const { ids, snapshot, mode } = await wornSet(sim, day);
  sim.trace.push(["wear", day.date, mode, ids.map((id) => snapshot.byId.get(id)?.garment.name ?? "unknown garment").sort()]);
  if (day.reportedLate && step.day + 1 < sim.plan.dayCount) {
    sim.deferredWear = { forDay: step.day, ids };
    return;
  }
  await reportWear(sim, day, day.date, ids, snapshot);
}

export async function lateWearReport(sim, step) {
  const deferred = sim.deferredWear;
  if (!deferred || deferred.forDay !== step.forDay) return;
  sim.deferredWear = null;
  const day = sim.plan.days[step.forDay];
  await reportWear(sim, day, day.date, deferred.ids, await sim.snapshot(), { late: true });
}

/* ------------------------------------------------------------------ */
/* Tomorrow's board and the repair probe                                */
/* ------------------------------------------------------------------ */

export async function planTomorrow(sim, step) {
  const tomorrowIndex = step.day + 1;
  if (tomorrowIndex >= sim.plan.dayCount) return;
  const tomorrow = sim.plan.days[tomorrowIndex];
  const view = await sim.todayBoard(tomorrow.date);
  if (tomorrow.circumstance === "paused" || tomorrow.circumstance === "trip") return;
  // Paused until further notice and not yet resumed (the owner resumes the next morning): the service is
  // still paused tonight, so nothing may be prepared for tomorrow yet.
  if (sim.pause?.active && !sim.pause.resumeOn) {
    sim.check("pause.nothing_prepared_until_the_owner_resumes", !view.board, `a board for ${tomorrow.date} was prepared while the service is paused until the owner resumes`, { date: tomorrow.date, status: view.status });
    return;
  }
  sim.check("board.prepared_the_evening_before", Boolean(view.board), `no board for ${tomorrow.date} at 21:20 the evening before: ${view.emptyReason ?? view.status}`, { date: tomorrow.date, status: view.status });
  if (!view.board || view.board.options.length === 0) {
    if (step.probe) sim.notApplicable("repair.planned_piece_made_unavailable_is_replaced", "no board to plan on");
    return;
  }
  const today = step.day >= 0 ? sim.plan.days[step.day] : null;
  if (!step.probe && !(today?.chooseTomorrowTonight)) return;
  let board = view.board;
  const options = [...board.options].sort((a, b) => a.number - b.number);
  const option = byDraw(options, step.probe ? step.probe.optionDraw : tomorrow.optionDraw);
  board = await select(sim, board, option, "chosen the evening before");
  if (!board) return;
  sim.chosen.set(tomorrow.date, { option, source: "board, the evening before" });
  sim.trace.push(["chosen_the_evening_before", tomorrow.date, composition(option)]);
  sim.count("outfits chosen the evening before");
  if (step.probe) await repairProbe(sim, step.probe, tomorrow.date, board, option);
}

/**
 * A planned piece becomes unavailable after tomorrow's outfit was chosen. The chosen outfit must be
 * repaired by itself: the piece is no longer on tomorrow's board, the choice is kept, the board has a
 * newer revision, and nobody asked for a new board.
 */
async function repairProbe(sim, probe, date, board, option) {
  const id = "repair.planned_piece_made_unavailable_is_replaced";
  const snapshot = await sim.snapshot();
  const single = option.garments.filter((g) => ["top", "bottom"].includes(g.role)).filter((g) => {
    const item = snapshot.byId.get(g.garmentId);
    return item && item.totalOwnedUnits === 1 && quantityIn(item, "clean") === 1 && !isSynthetic(item.garment.name);
  });
  const piece = byDraw(single, probe.pieceDraw);
  if (!piece) return sim.notApplicable(id, "the chosen outfit has no single-unit shirt or trousers");
  const today = sim.today();
  let outcome;
  if (probe.method === "worn_today_late_report") {
    outcome = await sim.command("wear.record", { wearingDate: today, garmentIds: [piece.garmentId] }, { label: "repair probe: he wore tomorrow's planned piece today" });
    if (outcome.receipt) sim.recordWear(today, [piece.garmentId]);
  } else if (probe.method === "marked_dirty") outcome = await sim.command("care.mark_dirty", { items: [{ garmentId: piece.garmentId, quantity: 1 }] }, { label: "repair probe: a spill on tomorrow's planned piece" });
  else if (probe.method === "lost") {
    outcome = await sim.command("garment.retire", { garmentId: piece.garmentId, quantity: 1, disposition: "lost", note: "SIMULATED event: lost" }, { label: "repair probe: tomorrow's planned piece is lost" });
    if (outcome.receipt) sim.unavailable.set(piece.garmentId, { kind: "lost", reason: "lost (SIMULATED event)", since: today });
  } else {
    outcome = await sim.command("garment.move", { garmentId: piece.garmentId, to: "tailor", note: "SIMULATED event: sent to the cleaner" }, { label: "repair probe: tomorrow's planned piece went to the cleaner" });
    if (outcome.receipt) sim.unavailable.set(piece.garmentId, { kind: "cleaner", reason: "at the cleaner (SIMULATED event)", since: today, permanentForRun: true });
  }
  sim.count(`repair probes: ${probe.method.replaceAll("_", " ")}`);
  if (!outcome.receipt) return sim.check(id, false, `the probe's own change (${probe.method}) was refused: ${outcome.error?.code} ${outcome.error?.message}`, { piece: piece.name, error: outcome.error });
  const after = await sim.target.eventually(async () => {
    const now = (await sim.todayBoard(date)).board;
    return now && now.revision > board.revision ? now : null;
  });
  const current = after ?? (await sim.todayBoard(date)).board;
  const stillThere = (current?.options ?? []).filter((o) => [...o.garments, ...o.footwearAlternatives].some((g) => g.garmentId === piece.garmentId)).map((o) => o.name);
  const evidence = { date, piece: piece.name, method: probe.method, commandId: outcome.receipt.commandId, receiptSummary: outcome.receipt.summary, receiptRepairs: outcome.receipt.repairs, revisionBefore: board.revision, revisionAfter: current?.revision ?? null, boardReason: current?.reason ?? null, changes: current?.changes ?? null };
  sim.check(id, Boolean(current) && stillThere.length === 0, `${piece.name} is unavailable (${probe.method}) but still on tomorrow's board in: ${stillThere.join(", ")}`, evidence);
  sim.check("repair.makes_a_new_board_revision", Boolean(current) && current.revision > board.revision, `tomorrow's board is still at revision ${current?.revision} after its planned piece became unavailable`, evidence);
  sim.check("repair.keeps_the_chosen_outfit", Boolean(current?.selection) && current.selection.optionId === option.optionId && current.options.some((o) => o.optionId === option.optionId), `the choice for ${date} was ${option.optionId}; after the repair the board shows ${current?.selection?.optionId ?? "no selection"}`, evidence);
  const repaired = current?.options.find((o) => o.optionId === option.optionId);
  if (repaired) {
    sim.chosen.set(date, { option: repaired, source: "board, repaired" });
    const kept = option.garments.filter((g) => g.garmentId !== piece.garmentId && repaired.garments.some((r) => r.garmentId === g.garmentId)).length;
    sim.check("repair.changes_only_what_it_must", kept >= option.garments.length - 2, `the repair kept ${kept} of the ${option.garments.length - 1} other pieces of the chosen outfit`, evidence);
    // The removed piece's role is filled again, by a piece that is wearable tomorrow in the wardrobe as it
    // stands after the probe's own change, and the repaired option as a whole passes every offer check.
    const post = await sim.snapshot(date);
    const fillers = repaired.garments.filter((g) => g.role === piece.role && g.garmentId !== piece.garmentId);
    const eligible = fillers.filter((g) => {
      const item = post.byId.get(g.garmentId);
      // The replacement must really be a garment of that role (its recorded roles), not merely labelled so.
      return item && item.garment.name === g.name && (item.garment.roles ?? []).includes(piece.role) && item.garment.acquisition === "owned" && item.totalOwnedUnits > 0 && item.availability && !item.availability.hardExcluded && (item.availability.restrictionIds ?? []).length === 0 && !sim.unavailable.has(g.garmentId);
    });
    sim.check("repair.replacement_is_wearable_in_the_removed_role", eligible.length > 0, `the repaired option has ${fillers.length} piece(s) in the role ${piece.role} of ${piece.name} and none is wearable on ${date}: ${fillers.map((g) => g.name).join(", ") || "none"}`, { ...evidence, role: piece.role, fillers: fillers.map((g) => g.name) });
    checkOptions(sim, post, [repaired], { date, source: `repaired board revision ${current.revision}`, freshness: current.freshness ?? null });
  } else sim.check("repair.replacement_is_wearable_in_the_removed_role", false, `the chosen option is no longer on tomorrow's board after the repair`, evidence);
  sim.trace.push(["repair_probe", date, probe.method, piece.role, piece.name, repaired ? composition(repaired) : null, stillThere.length]);
}

/* ------------------------------------------------------------------ */
/* The night: one inventory view, and the isolation check               */
/* ------------------------------------------------------------------ */

export async function night(sim, step) {
  const day = sim.plan.days[step.day];
  await exerciseView(sim, byDraw(INVENTORY_VIEWS, day.inventoryViewDraw), day.pieceDraw);
  if (step.isolation) await isolation(sim);
}

/** The SYNTHETIC second owner sees nothing of the first, and cannot touch it. */
export async function isolation(sim) {
  const mine = await sim.snapshot();
  const theirs = await sim.inventory({ view: "snapshot" }, sim.sessions.second);
  const theirIds = (theirs.data.items ?? []).map((i) => i.garment.garmentId);
  sim.check("isolation.second_owner_sees_only_its_own_garments", theirIds.length === sim.synthetic.second.length && theirIds.every((id) => sim.synthetic.second.includes(id)), `the second owner's snapshot holds ${theirIds.length} garments; it owns ${sim.synthetic.second.length}`);
  sim.check("isolation.first_owner_does_not_see_the_second_s", sim.synthetic.second.every((id) => !mine.byId.has(id)), "a garment of the second owner is in the first owner's wardrobe");
  const victim = [...mine.items].sort(byName)[0];
  const peek = await sim.sessions.second.callTool("garderobe_inventory", { view: "item", garmentId: victim.garment.garmentId });
  sim.check("isolation.second_owner_cannot_read_a_garment_of_the_first", !peek.ok && peek.error.code === "not_found", `reading the first owner's ${victim.garment.name} answered ${peek.ok ? "with the item" : peek.error.code}`);
  const date = sim.today();
  const before = (await sim.inventory({ view: "history", date })).data.garments?.length ?? 0;
  const write = await sim.sessions.second.callTool("garderobe_command", { type: "wear.record", payload: { wearingDate: date, garmentIds: [victim.garment.garmentId] }, idempotencyKey: sim.key("isolation-write") });
  const after = (await sim.inventory({ view: "history", date })).data.garments?.length ?? 0;
  sim.check("isolation.second_owner_cannot_report_on_a_garment_of_the_first", !write.ok && write.error.code === "not_found" && before === after, `a wear report by the second owner on the first owner's garment answered ${write.ok ? "with a receipt" : write.error.code}`);
  const receipts = await sim.inventory({ view: "receipts", limit: 200 }, sim.sessions.second);
  const leaked = (receipts.data.receipts ?? []).filter((r) => sim.primaryCommandIds.includes(r.commandId));
  sim.check("isolation.second_owner_sees_no_receipt_of_the_first", leaked.length === 0, `${leaked.length} receipts of the first owner are listed to the second`);
  const board = await sim.sessions.second.callTool("garderobe_today", { date });
  const firstBoard = (await sim.todayBoard(date)).board;
  sim.check("isolation.second_owner_does_not_get_the_first_owner_s_board", board.ok && (!board.data.board || !firstBoard || board.data.board.boardId !== firstBoard.boardId), "the second owner was shown the first owner's board");
  sim.count("isolation checks against the SYNTHETIC second owner");
}

/** A day's brief said the evening before (working from home), sent like any other change. */
export async function dayBrief(sim, step) {
  const date = sim.dateOf(step.forDay);
  const outcome = await sim.command("style.set_brief", { localDate: date, text: "(SIMULATED circumstance) Working from home; nobody will see me.", source: { kind: "owner_statement" } }, { label: "brief for a day at home" });
  sim.check("circumstance.day_brief_recorded", Boolean(outcome.receipt), `the brief for ${date} was refused: ${outcome.error?.code} ${outcome.error?.message}`, { error: outcome.error });
  sim.count("day briefs set (working from home)");
}

export { addDays };
