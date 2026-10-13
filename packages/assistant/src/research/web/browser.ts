/**
 * Typed Browser Run service policy: an action must refer to the latest
 * observation of the same session, expired sessions are reconstructed without
 * assuming any page state survived, unused sessions are closed while the task
 * record is kept, and external commitments need a retained authorization.
 */
import { assertPublicHttpsUrl, redactSecretsInUrl } from "./url.ts";

export * from "./browser-capabilities.ts";

export type ReadOnlyActionKind =
  | "navigate" | "back" | "reload" | "select_tab" | "scroll" | "wait_for" | "screenshot" | "read_content";
export type FormPreparationActionKind =
  | "click" | "type" | "select_option" | "keyboard" | "drag" | "handle_dialog" | "upload_file" | "download_file";
export type ExternalCommitmentKind = "send_message" | "submit_listing" | "purchase" | "commit_service" | "paid_booking";
export type BrowserActionKind = ReadOnlyActionKind | FormPreparationActionKind | ExternalCommitmentKind;

export interface BrowserAction {
  kind: BrowserActionKind;
  /** Token of the observation this action was decided on. */
  pageStateToken: string;
  /** Semantic target, for example an accessibility reference. */
  target?: string;
  /** Text, option, key or URL (for `navigate`). */
  value?: string;
  /** What an external commitment applies to; matched against retained authorizations. */
  scope?: string;
}

export type ActionClass = "read_only" | "form_preparation" | "external_commitment";

const READ_ONLY: readonly string[] = ["navigate", "back", "reload", "select_tab", "scroll", "wait_for", "screenshot", "read_content"];
const FORM_PREPARATION: readonly string[] = [
  "click", "type", "select_option", "keyboard", "drag", "handle_dialog", "upload_file", "download_file",
];

/** Unknown action kinds are treated as external commitments (fail closed). */
export function classifyAction(action: { kind: string }): ActionClass {
  if (READ_ONLY.includes(action.kind)) return "read_only";
  if (FORM_PREPARATION.includes(action.kind)) return "form_preparation";
  return "external_commitment";
}

export interface RetainedAuthorization {
  action: ExternalCommitmentKind;
  scope: string;
}

export type AccessWall = "challenge" | "login";

export interface BackendObservation {
  pageStateToken: string;
  url: string;
  snapshot: string;
  /** Set when the page shows a bot challenge or a login wall. */
  wall?: AccessWall | null;
}

export type BackendActResult = { outcome: "done"; detail?: string } | { outcome: "blocked"; wall: AccessWall; detail?: string };

/** Thrown by a backend when the remote browser session no longer exists. */
export class BrowserSessionExpiredError extends Error {
  constructor(sessionId: string) {
    super(`Browser session ${sessionId} has expired`);
    this.name = "BrowserSessionExpiredError";
  }
}

export interface BrowserBackend {
  createSession(req: { url: string }): Promise<{ sessionId: string }>;
  observe(sessionId: string): Promise<BackendObservation>;
  act(sessionId: string, action: BrowserAction): Promise<BackendActResult>;
  closeSession(sessionId: string): Promise<void>;
}

export type BrowserPolicyErrorCode = "stale_page_state" | "unknown_session" | "session_expired" | "unknown_task";

export class BrowserPolicyError extends Error {
  readonly code: BrowserPolicyErrorCode;

  constructor(code: BrowserPolicyErrorCode, message: string) {
    super(message);
    this.name = "BrowserPolicyError";
    this.code = code;
  }
}

/** Kept independently of the browser process; survives session expiry and idle closing. */
export interface BrowserTaskRecord {
  taskId: string;
  /** Visited URLs in order, secret-redacted; the last one is used for reconstruction. */
  urls: string[];
  /** References to retained evidence artifacts. */
  evidence: string[];
  sessionId: string | null;
}

export interface PreparedStep {
  taskId: string;
  sessionId: string;
  url: string;
  wall: AccessWall;
  /** The step that was prepared but not completed; null when the wall was met while observing. */
  action: BrowserAction | null;
  resume: string;
}

export type ObserveResult =
  | { status: "observed"; pageStateToken: string; url: string; snapshot: string }
  | { status: "handoff_required"; preparedStep: PreparedStep };

export type ActResult =
  | { status: "done"; detail: string | null; mustObserveAgain: true }
  | { status: "needs_authorization"; action: BrowserAction }
  | { status: "handoff_required"; preparedStep: PreparedStep };

export const MUST_RECHECK_AFTER_RECONSTRUCTION = ["size", "colour", "login", "cart", "region"] as const;

export interface ReconstructResult {
  sessionId: string;
  url: string;
  /** Restoring a URL never restores its selection. */
  variantRestored: false;
  mustRecheck: (typeof MUST_RECHECK_AFTER_RECONSTRUCTION)[number][];
}

interface SessionState {
  taskId: string;
  url: string;
  latestToken: string | null;
  lastUsedAt: number;
}

const RESUME = "Owner completes the blocked step in Live View, then explicitly returns the task to the agent; observe again before acting.";

export class BrowserService {
  private readonly sessions = new Map<string, SessionState>();
  private readonly tasks = new Map<string, BrowserTaskRecord>();
  private readonly authorizations: RetainedAuthorization[] = [];
  private readonly backend: BrowserBackend;
  private readonly clock: () => number;

  constructor(deps: { backend: BrowserBackend; clock: () => number }) {
    this.backend = deps.backend;
    this.clock = deps.clock;
  }

  retainAuthorization(authorization: RetainedAuthorization): void {
    this.authorizations.push({ action: authorization.action, scope: authorization.scope });
  }

  revokeAuthorization(authorization: RetainedAuthorization): void {
    const index = this.authorizations.findIndex((held) => held.action === authorization.action && held.scope === authorization.scope);
    if (index >= 0) this.authorizations.splice(index, 1);
  }

  getTask(taskId: string): BrowserTaskRecord | null {
    const task = this.tasks.get(taskId);
    return task ? { ...task, urls: [...task.urls], evidence: [...task.evidence] } : null;
  }

  addEvidence(taskId: string, evidenceRef: string): void {
    this.requireTask(taskId).evidence.push(evidenceRef);
  }

  /** Opens a bounded session for a task at a public HTTPS URL. */
  async openSession(req: { taskId: string; url: string }): Promise<{ sessionId: string }> {
    const url = assertPublicHttpsUrl(req.url);
    const { sessionId } = await this.backend.createSession({ url });
    const task = this.tasks.get(req.taskId) ?? { taskId: req.taskId, urls: [], evidence: [], sessionId: null };
    this.rememberUrl(task, url);
    task.sessionId = sessionId;
    this.tasks.set(req.taskId, task);
    this.sessions.set(sessionId, { taskId: req.taskId, url, latestToken: null, lastUsedAt: this.clock() });
    return { sessionId };
  }

  async observe(sessionId: string): Promise<ObserveResult> {
    const session = this.requireSession(sessionId);
    const seen = await this.guardExpiry(sessionId, () => this.backend.observe(sessionId));
    session.latestToken = seen.pageStateToken;
    session.url = seen.url;
    session.lastUsedAt = this.clock();
    if (!seen.wall) this.rememberUrl(this.requireTask(session.taskId), seen.url); // A login or challenge URL is not a place to resume from.
    if (seen.wall) return { status: "handoff_required", preparedStep: this.prepared(sessionId, session, seen.wall, null) };
    return { status: "observed", pageStateToken: seen.pageStateToken, url: redactSecretsInUrl(seen.url), snapshot: seen.snapshot };
  }

  async act(sessionId: string, action: BrowserAction): Promise<ActResult> {
    const session = this.requireSession(sessionId);
    if (session.latestToken === null || action.pageStateToken !== session.latestToken) {
      throw new BrowserPolicyError("stale_page_state", "The action does not refer to the latest observation of this session");
    }
    if (classifyAction(action) === "external_commitment") {
      const held = this.authorizations.some((auth) => auth.action === action.kind && action.scope !== undefined && auth.scope === action.scope);
      if (!held) return { status: "needs_authorization", action };
    }
    if (action.kind === "navigate") assertPublicHttpsUrl(action.value ?? "");
    const result = await this.guardExpiry(sessionId, () => this.backend.act(sessionId, action));
    session.latestToken = null; // The page may have changed: a fresh observation is required.
    session.lastUsedAt = this.clock();
    if (result.outcome === "blocked") {
      return { status: "handoff_required", preparedStep: this.prepared(sessionId, session, result.wall, action) };
    }
    return { status: "done", detail: result.detail ?? null, mustObserveAgain: true };
  }

  /** Re-navigates the task's last saved URL in a new session. Nothing else is assumed to survive. */
  async reconstruct(taskId: string): Promise<ReconstructResult> {
    const task = this.requireTask(taskId);
    const url = task.urls[task.urls.length - 1];
    if (url === undefined) throw new BrowserPolicyError("unknown_task", `Task ${taskId} has no saved URL to reconstruct from`);
    if (task.sessionId !== null) this.sessions.delete(task.sessionId);
    const { sessionId } = await this.openSession({ taskId, url });
    return { sessionId, url, variantRestored: false, mustRecheck: [...MUST_RECHECK_AFTER_RECONSTRUCTION] };
  }

  /** Closes sessions unused for `idleMs`; task records (URLs, evidence) are kept. Returns the closed session ids. */
  async closeIdle(nowMs: number, idleMs: number): Promise<string[]> {
    const closed: string[] = [];
    for (const [sessionId, session] of [...this.sessions]) {
      if (nowMs - session.lastUsedAt < idleMs) continue;
      this.forget(sessionId);
      closed.push(sessionId);
      await this.backend.closeSession(sessionId).catch(() => undefined); // Already gone is as good as closed.
    }
    return closed;
  }

  private prepared(sessionId: string, session: SessionState, wall: AccessWall, action: BrowserAction | null): PreparedStep {
    return { taskId: session.taskId, sessionId, url: redactSecretsInUrl(session.url), wall, action, resume: RESUME };
  }

  private rememberUrl(task: BrowserTaskRecord, url: string): void {
    const safe = redactSecretsInUrl(url);
    if (task.urls[task.urls.length - 1] !== safe) task.urls.push(safe);
  }

  private forget(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    const task = session ? this.tasks.get(session.taskId) : undefined;
    if (task && task.sessionId === sessionId) task.sessionId = null;
  }

  private async guardExpiry<T>(sessionId: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof BrowserSessionExpiredError)) throw error;
      this.forget(sessionId);
      throw new BrowserPolicyError("session_expired", `Session ${sessionId} expired; reconstruct the task and recheck the variant`);
    }
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new BrowserPolicyError("unknown_session", `No open session ${sessionId}; reconstruct the task`);
    return session;
  }

  private requireTask(taskId: string): BrowserTaskRecord {
    const task = this.tasks.get(taskId);
    if (!task) throw new BrowserPolicyError("unknown_task", `No task ${taskId}`);
    return task;
  }
}
