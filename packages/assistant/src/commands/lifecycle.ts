import { ASSISTANT_COMMANDS as C } from "@garderobe/contracts/ext/assistant";
import { CommandError, all, define, first, json, stmt, type CommandContext, type Stmt } from "@garderobe/domain";
import { NO_UNDO, money, plural, requireGarments, named } from "./common.ts";

interface ProjectRow {
  project_id: string;
  version: number;
  kind: string;
  state: string;
  title: string;
  destination: string | null;
  next_action: string | null;
  details_json: string;
  authorizations_json: string;
}

async function loadProject(ctx: CommandContext, projectId: string): Promise<ProjectRow> {
  const row = await first<ProjectRow>(ctx.db, "SELECT * FROM lifecycle_projects WHERE user_id = ? AND project_id = ?", ctx.userId, projectId);
  if (!row) throw new CommandError("not_found", `no project '${projectId}'; nothing was written`);
  return row;
}

const unchanged = (ctx: CommandContext, row: ProjectRow) => ({
  label: `project ${row.project_id} unchanged since read`,
  sql: "(SELECT version FROM lifecycle_projects WHERE user_id = ? AND project_id = ?) = ?",
  params: [ctx.userId, row.project_id, row.version],
  class: "internal" as const,
});

const STILL_HERE: Record<string, string> = {
  consignment: "Nothing has left: the pieces stay owned until pickup is recorded",
  sale: "Nothing has left: a drafted listing does not mean an item has gone",
  donation: "Nothing has left until you say it has",
  disposal: "Nothing has been discarded yet",
  tailoring: "The piece is still at home until you say it went to the tailor",
  seasonal_storage: "Nothing has moved yet",
  repair: "The piece is still at home until you say it went for repair",
  other: "No stock has changed",
};

/** A durable project. Opening one changes no stock and no location. */
export const lifecycleOpenProject = define({
  type: "lifecycle.open_project",
  schema: C["lifecycle.open_project"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const ids = p.items.map((i) => i.garmentId);
    if (new Set(ids).size !== ids.length) throw new CommandError("invalid_command", "a garment is listed twice in this project");
    // All-or-nothing: one unresolvable piece stops the whole batch; nothing is invented to make it pass.
    const garments = await requireGarments(ctx, ids);
    for (const g of garments.values()) {
      if (g.acquisition !== "owned") throw new CommandError("precondition_failed", `${g.name} is not in your possession (${g.acquisition}); it cannot join this project`);
    }
    const projectId = p.projectId ?? ctx.newId("lcp");
    const statements: Stmt[] = [
      stmt(
        "INSERT INTO lifecycle_projects (user_id, project_id, version, kind, state, title, destination, next_action, details_json, authorizations_json, created_at, updated_at) VALUES (?, ?, 1, ?, 'open', ?, ?, ?, ?, '[]', ?, ?)",
        ctx.userId, projectId, p.kind, p.title, p.destination, p.nextAction, JSON.stringify(p.details), ctx.now, ctx.now,
      ),
      ...p.items.map((i) => stmt("INSERT INTO lifecycle_project_items (user_id, project_id, garment_id, quantity, state) VALUES (?, ?, ?, ?, 'included')", ctx.userId, projectId, i.garmentId, i.quantity)),
      stmt("INSERT INTO lifecycle_events (user_id, event_id, project_id, kind, detail_json, occurred_at, command_id) VALUES (?, ?, ?, 'opened', '{}', ?, ?)", ctx.userId, ctx.newId("lce"), projectId, ctx.occurredAt, ctx.commandId),
    ];
    return {
      summary: `${named(p.title)}: ${p.kind.replace(/_/g, " ")} project opened with ${plural(p.items.length, "piece")}${p.nextAction ? `. Next: ${named(p.nextAction)}` : ""}. ${STILL_HERE[p.kind]}`,
      statements,
      affected: [{ kind: "lifecycle_project", id: projectId, version: 1 }],
      result: { projectId, garmentIds: ids },
      undo: { data: { projectId } },
    };
  },
  async planUndo(ctx, _o, data) {
    return {
      summary: "Project cancelled; no stock had changed",
      statements: [stmt("UPDATE lifecycle_projects SET state = 'cancelled', version = version + 1, updated_at = ? WHERE user_id = ? AND project_id = ?", ctx.now, ctx.userId, data.projectId)],
      undo: NO_UNDO("already an undo"),
    };
  },
});

const EVENT_LABEL: Record<string, string> = {
  photos_matched: "Photographs matched",
  copy_drafted: "Listing copy drafted",
  form_prepared: "Form prepared, not submitted",
  submission_attempted: "Submission attempted",
  submission_confirmed: "Submission confirmed",
  submission_uncertain: "Submission outcome unknown; it will be reconciled before any second attempt",
  pickup_scheduled: "Pickup scheduled",
  pickup_completed: "Pickup recorded",
  proceeds_recorded: "Proceeds recorded",
  sent_to_tailor: "Sent to the tailor",
  returned_from_tailor: "Back from the tailor",
  stored: "Put into storage",
  retrieved: "Taken out of storage",
  discarded: "Discarded",
  handoff_prepared: "Ready for you at the prepared step",
  note: "Note added",
};

const EXTERNAL_ACTION_FOR_EVENT: Record<string, string> = { submission_attempted: "submit_listing", submission_confirmed: "submit_listing" };

export const lifecycleRecordEvent = define({
  type: "lifecycle.record_event",
  schema: C["lifecycle.record_event"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement", "standing_policy", "system_schedule"],
  async plan(ctx, p) {
    const project = await loadProject(ctx, p.projectId);
    if (project.state === "cancelled") throw new CommandError("precondition_failed", "this project was cancelled");
    const items = await all<{ garment_id: string }>(ctx.db, "SELECT garment_id FROM lifecycle_project_items WHERE user_id = ? AND project_id = ?", ctx.userId, p.projectId);
    const member = new Set(items.map((i) => i.garment_id));
    const strangers = p.garmentIds.filter((g) => !member.has(g));
    if (strangers.length > 0) throw new CommandError("not_found", `these pieces are not part of this project: ${strangers.join(", ")}; nothing was written`, { garmentIds: strangers });

    // An external submission needs the owner's retained authorization for that concrete action.
    const needed = EXTERNAL_ACTION_FOR_EVENT[p.kind];
    if (needed) {
      const granted = json<{ action: string }[]>(project.authorizations_json, []).some((a) => a.action === needed);
      if (!granted) throw new CommandError("forbidden", `submitting needs your authorization for this project first; the form stays prepared`, { requiredAuthorization: needed });
    }
    if (p.externalOperationKey) {
      const prior = await first<{ kind: string }>(ctx.db, "SELECT kind FROM lifecycle_events WHERE user_id = ? AND project_id = ? AND external_operation_key = ? ORDER BY occurred_at DESC", ctx.userId, p.projectId, p.externalOperationKey);
      if (prior && prior.kind === p.kind) {
        return { outcome: "noop", summary: `${named(project.title)}: that step was already recorded`, result: { projectId: p.projectId }, undo: NO_UNDO("nothing changed") };
      }
      // An ambiguous outcome must be reconciled before another attempt.
      if (p.kind === "submission_attempted") {
        const uncertain = await first(ctx.db, "SELECT 1 AS x FROM lifecycle_events e WHERE e.user_id = ? AND e.project_id = ? AND e.kind = 'submission_uncertain' AND NOT EXISTS (SELECT 1 FROM lifecycle_events c WHERE c.user_id = e.user_id AND c.project_id = e.project_id AND c.kind = 'submission_confirmed' AND c.occurred_at >= e.occurred_at)", ctx.userId, p.projectId);
        if (uncertain) throw new CommandError("precondition_failed", "an earlier submission has an unknown outcome; it is reconciled before another attempt");
      }
    }
    const targets = p.garmentIds.length > 0 ? p.garmentIds : items.map((i) => i.garment_id);
    const statements: Stmt[] = [
      stmt(
        "INSERT INTO lifecycle_events (user_id, event_id, project_id, kind, detail_json, external_operation_key, occurred_at, command_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ctx.userId, ctx.newId("lce"), p.projectId, p.kind, JSON.stringify({ ...p.detail, garmentIds: targets }), p.externalOperationKey ?? null, ctx.occurredAt, ctx.commandId,
      ),
    ];
    const itemState: Record<string, string> = { pickup_completed: "left", discarded: "left", sent_to_tailor: "at_tailor", returned_from_tailor: "returned", stored: "stored", retrieved: "included" };
    if (itemState[p.kind]) {
      for (const g of targets) statements.push(stmt("UPDATE lifecycle_project_items SET state = ? WHERE user_id = ? AND project_id = ? AND garment_id = ?", itemState[p.kind], ctx.userId, p.projectId, g));
    }
    if (p.kind === "proceeds_recorded") {
      if (p.proceedsMinor === undefined) throw new CommandError("invalid_command", "recording proceeds needs the amount");
      if (targets.length !== 1) throw new CommandError("invalid_command", "record proceeds for one piece at a time so each amount stays with its item");
      statements.push(stmt("UPDATE lifecycle_project_items SET proceeds_minor = COALESCE(proceeds_minor, 0) + ?, currency = ? WHERE user_id = ? AND project_id = ? AND garment_id = ?", p.proceedsMinor, p.currency ?? null, ctx.userId, p.projectId, targets[0]));
    }
    const state = p.state ?? (project.state === "open" ? "in_progress" : project.state);
    statements.push(
      stmt(
        "UPDATE lifecycle_projects SET version = version + 1, state = ?, next_action = ?, updated_at = ? WHERE user_id = ? AND project_id = ?",
        state, p.nextAction === undefined ? project.next_action : p.nextAction, ctx.now, ctx.userId, p.projectId,
      ),
    );
    const proceeds = p.kind === "proceeds_recorded" ? ` ${money(p.proceedsMinor, p.currency)}` : "";
    const next = p.nextAction ? ` Next: ${p.nextAction}` : "";
    return {
      summary: `${named(project.title)}: ${EVENT_LABEL[p.kind]}${proceeds}.${next}`,
      statements,
      preconditions: [unchanged(ctx, project)],
      affected: [{ kind: "lifecycle_project", id: p.projectId, version: project.version + 1 }],
      result: { projectId: p.projectId, kind: p.kind, garmentIds: targets, state },
      undo: NO_UNDO("project history is corrected with a further note"),
    };
  },
});

export const lifecycleUpdateProject = define({
  type: "lifecycle.update_project",
  schema: C["lifecycle.update_project"],
  class: "edit",
  requiredScope: "write",
  async plan(ctx, p) {
    const project = await loadProject(ctx, p.projectId);
    const details = p.details ? { ...json<Record<string, unknown>>(project.details_json, {}), ...p.details } : json<Record<string, unknown>>(project.details_json, {});
    const title = p.title ?? project.title;
    const state = p.state ?? project.state;
    return {
      summary: `${named(title)} updated${state !== project.state ? `: now ${state.replace(/_/g, " ")}` : ""}${p.nextAction ? `. Next: ${named(p.nextAction)}` : ""}`,
      statements: [
        stmt(
          "UPDATE lifecycle_projects SET version = version + 1, title = ?, destination = ?, next_action = ?, details_json = ?, state = ?, updated_at = ? WHERE user_id = ? AND project_id = ?",
          title, p.destination === undefined ? project.destination : p.destination, p.nextAction === undefined ? project.next_action : p.nextAction, JSON.stringify(details), state, ctx.now, ctx.userId, p.projectId,
        ),
      ],
      preconditions: [unchanged(ctx, project)],
      affected: [{ kind: "lifecycle_project", id: p.projectId, version: project.version + 1 }],
      result: { projectId: p.projectId, state },
      undo: NO_UNDO("update the project again to correct it"),
    };
  },
});

/** The owner's retained authorization for one concrete kind of external action; never implied by a tool result. */
export const lifecycleAuthorizeAction = define({
  type: "lifecycle.authorize_action",
  schema: C["lifecycle.authorize_action"],
  class: "edit",
  requiredScope: "write",
  allowedAuthorizations: ["owner_tap", "owner_statement"],
  async plan(ctx, p) {
    const project = await loadProject(ctx, p.projectId);
    const list = json<{ action: string; scope: string; grantedAt: string; ownerQuote: string }[]>(project.authorizations_json, []);
    if (list.some((a) => a.action === p.action && a.scope === p.scope)) {
      return { outcome: "noop", summary: `${named(project.title)}: that authorization is already on record`, result: { projectId: p.projectId }, undo: NO_UNDO("nothing changed") };
    }
    list.push({ action: p.action, scope: p.scope, grantedAt: ctx.now, ownerQuote: p.ownerQuote });
    return {
      summary: `${named(project.title)}: you authorized ${p.action.replace(/_/g, " ")} (${named(p.scope)}). It will not be asked again for this project`,
      statements: [stmt("UPDATE lifecycle_projects SET version = version + 1, authorizations_json = ?, updated_at = ? WHERE user_id = ? AND project_id = ?", JSON.stringify(list), ctx.now, ctx.userId, p.projectId)],
      preconditions: [unchanged(ctx, project)],
      affected: [{ kind: "lifecycle_project", id: p.projectId, version: project.version + 1 }],
      result: { projectId: p.projectId, action: p.action },
      undo: { data: { projectId: p.projectId, action: p.action, scope: p.scope } },
    };
  },
  async planUndo(ctx, _o, data) {
    const project = await loadProject(ctx, data.projectId);
    const list = json<{ action: string; scope: string }[]>(project.authorizations_json, []).filter((a) => !(a.action === data.action && a.scope === data.scope));
    return {
      summary: `${named(project.title)}: authorization withdrawn`,
      statements: [stmt("UPDATE lifecycle_projects SET version = version + 1, authorizations_json = ?, updated_at = ? WHERE user_id = ? AND project_id = ?", JSON.stringify(list), ctx.now, ctx.userId, data.projectId)],
      undo: NO_UNDO("already an undo"),
    };
  },
});

export const lifecycleHandlers = [lifecycleOpenProject, lifecycleRecordEvent, lifecycleUpdateProject, lifecycleAuthorizeAction];
