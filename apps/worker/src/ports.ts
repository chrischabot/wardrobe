/**
 * Ports to the other workstreams' modules, expressed in the API's own contract terms.
 *
 * The Worker's routes and MCP tools depend only on these interfaces; `lanes/*.ts` adapt each
 * workstream's real exports to them. Nothing here contains behaviour: domain logic, composition,
 * conversation and media processing all live in their own packages.
 */
import type { CommandReceipt } from "@garderobe/contracts";
import type { Run, RunEvent, RunState } from "@garderobe/contracts/ext/api";
import type { ComfortFeedback, Connection, InferenceOverview, LifecycleProject, Order, RecallQuery, RecallResult, ReturnCase, TranscriptPage } from "@garderobe/contracts/ext/assistant";
import type { BoardDocument, BoardOption, PackingProposal, PauseState, TemperaturePreview, TodayView, Trip, WeatherSnapshot } from "@garderobe/contracts/ext/daily";
import type {
  Composition,
  GarmentImageRef,
  GarmentMedia,
  MediaAsset,
  MediaReview,
  PhotosNeededItem,
  StudioCombination,
  StudioDayPlan,
  StudioSelectors,
  StudioSlot,
  StudioSuggestion,
  StudioValidation,
  UploadAuthorization,
  UploadStatus,
} from "@garderobe/contracts/ext/media";
import type { CommandRegistry, Principal } from "@garderobe/domain";
import type { z } from "zod";

export interface ExportedTables {
  version: string | number;
  tables: Record<string, unknown[]>;
}

export interface DailyPort {
  register(registry: CommandRegistry): void;
  today(principal: Principal, query: { date?: string; scope?: string }): Promise<TodayView>;
  recommend(
    principal: Principal,
    input: { clientRequestId: string; date?: string; brief?: string; count?: number; lockedGarmentIds: string[]; occasionOnly: boolean; mode: "preview" | "board" },
  ): Promise<{ options: BoardOption[]; board: BoardDocument | null; insufficient: boolean; note: string | null }>;
  trips(principal: Principal): Promise<Trip[]>;
  trip(principal: Principal, tripId: string): Promise<Trip>;
  pause(principal: Principal): Promise<PauseState | null>;
  proposePacking(principal: Principal, input: { tripId: string; clientRequestId: string }): Promise<PackingProposal>;
  /** Swap one slot of a board option; the weather service is consulted first when the board's forecast is old. */
  swapSlot(principal: Principal, input: { boardId: string; optionId: string; role: string; garmentId?: string; clientRequestId: string; expectedRevision?: number }): Promise<{ board: BoardDocument; receipt: CommandReceipt }>;
  /** Mandatory context for an ad hoc outfit question (what is eligible for one slot of this outfit today). */
  decisionContext(principal: Principal, input: { localDate?: string; outfit: { role: string; garmentId: string }[]; role: string; tripId?: string }): Promise<Record<string, unknown>>;
  temperaturePreview(principal: Principal, temperatureC: number): Promise<TemperaturePreview>;
  weather(principal: Principal, date: string | undefined): Promise<WeatherSnapshot>;
  boardHtml(principal: Principal, input: { date?: string; baseUrl: string }): Promise<string>;
  /** Background refill after a committed command (never blocks the response). */
  afterCommit(principal: Principal): Promise<void>;
  /** Cron entry: every owner's due phases and calendar projections. */
  scheduled(nowMs: number): Promise<unknown>;
  exportData(principal: Principal): Promise<ExportedTables>;
  importData(principal: Principal, data: ExportedTables): Promise<unknown>;
}

export interface TurnSubmission {
  submissionId: string;
  text: string;
  attachments: { kind: "pasted_text" | "web_page" | "image_description" | "other"; source: string | null; text: string }[];
  attachedRefs: string[];
}

export type ApiRun = z.infer<typeof Run>;
export type ApiRunEvent = z.infer<typeof RunEvent>;
export type ApiRunState = z.infer<typeof RunState>;

export interface AssistantPort {
  register(registry: CommandRegistry): void;
  /** Durable acceptance; the same submission ID and body returns the same turn. */
  submitTurn(principal: Principal, input: TurnSubmission): Promise<{ runId: string; state: ApiRunState; replayed: boolean }>;
  /** Submit and wait for the settled turn (MCP `garderobe_ask` in `wait` mode). */
  runTurn(principal: Principal, input: TurnSubmission): Promise<ApiRun>;
  getRun(principal: Principal, runId: string): Promise<ApiRun | null>;
  runEvents(principal: Principal, runId: string, afterEventId: number): Promise<{ events: ApiRunEvent[]; expired: boolean }>;
  cancelRun(principal: Principal, runId: string): Promise<{ run: ApiRun; stopped: string[] }>;
  answerInput(principal: Principal, runId: string, input: { inputId: string; choiceId?: string; text?: string }): Promise<ApiRun>;
  /** Run again a turn that stopped for a resumable reason (budget, no usable model, provider outage). */
  resumeRun(principal: Principal, runId: string): Promise<ApiRun>;
  /** Background duties: deliver finished jobs, complete erasures, catch up the recall and search indexes. */
  maintenance(nowMs: number): Promise<unknown>;
  transcript(principal: Principal, query: { before?: string; after?: string; around?: string; limit: number }): Promise<TranscriptPage>;
  recall(principal: Principal, query: RecallQuery): Promise<RecallResult>;
  startResearch(principal: Principal, input: { submissionId: string; topic: string; kind: "product" | "history" | "purchases" | "general"; url?: string }): Promise<{ runId: string; state: ApiRunState; replayed: boolean }>;
  orders(principal: Principal): Promise<Order[]>;
  returns(principal: Principal): Promise<ReturnCase[]>;
  projects(principal: Principal): Promise<LifecycleProject[]>;
  feedback(principal: Principal, garmentId?: string): Promise<ComfortFeedback[]>;
  inference(principal: Principal): Promise<InferenceOverview>;
  connections(principal: Principal): Promise<Connection[]>;
  /** `operational`: the backup form of the conversation (compaction overlays and pending turns included). */
  exportData(principal: Principal, opts?: { operational?: boolean }): Promise<{ records: unknown; conversation: unknown }>;
  /** Where the conversation and its derived indexes stand (recorded in a restore manifest). */
  conversationWatermarks(principal: Principal): Promise<Record<string, unknown>>;
  /** Account erasure: wipe the conversation actor, its task actors and the owner's search instance. Runs before the rows are deleted. */
  eraseOwner(principal: Principal): Promise<Record<string, unknown>>;
  importData(principal: Principal, data: { records: unknown; conversation: unknown }): Promise<unknown>;
}

export interface MediaBody {
  body: ReadableStream | ArrayBuffer;
  contentType: string;
  etag: string | null;
  byteLength: number | null;
}

export interface MediaExport {
  records: unknown;
  assets: { assetId: string; renditionId: string | null; kind: string; r2Key: string; contentType: string; byteLength: number; sha256: string }[];
}

export interface MediaPort {
  register(registry: CommandRegistry): void;
  authorizeUpload(
    principal: Principal,
    input: { clientUploadId: string; intent: "garment_photo" | "selfie" | "attachment"; contentType: string; byteLength: number; garmentId?: string; wearingDate?: string },
  ): Promise<{ authorization: UploadAuthorization; replayed: boolean }>;
  /** Authenticated by the token inside the authorization URL (bound to owner, upload, type and size). */
  receiveUpload(input: { uploadId: string; token: string; body: ReadableStream; contentLength: number; contentType: string }): Promise<{ receivedBytes: number; sha256: string }>;
  finalizeUpload(principal: Principal, uploadId: string): Promise<{ receipt: CommandReceipt; asset: MediaAsset | null; rejected: string | null; jobId: string | null }>;
  uploadStatus(principal: Principal, uploadId: string): Promise<UploadStatus>;
  garmentMedia(principal: Principal, garmentId: string): Promise<GarmentMedia>;
  garmentImage(principal: Principal, garmentId: string): Promise<GarmentImageRef | null>;
  openRendition(principal: Principal, renditionId: string, width?: number): Promise<MediaBody>;
  openAsset(principal: Principal, assetId: string, opts: { variant?: "display" | "original" | "cutout" | "catalogue"; width?: number }): Promise<MediaBody>;
  /** Raw stored object of an asset, for the portable export. */
  readExportAsset(principal: Principal, r2Key: string): Promise<ArrayBuffer | null>;
  photosNeeded(principal: Principal): Promise<PhotosNeededItem[]>;
  review(principal: Principal): Promise<MediaReview>;
  studio(principal: Principal, query: { mode: "for_today" | "explore"; date?: string }): Promise<StudioSelectors>;
  combinations(principal: Principal): Promise<StudioCombination[]>;
  combinationsForGarment(principal: Principal, garmentId: string): Promise<StudioCombination[]>;
  dayPlans(principal: Principal): Promise<StudioDayPlan[]>;
  validate(principal: Principal, input: { slots: StudioSlot[]; mode: "for_today" | "explore"; date?: string }): Promise<StudioValidation>;
  suggest(principal: Principal, input: { slots: StudioSlot[]; mode: "for_today" | "explore"; date?: string; limit?: number }): Promise<StudioSuggestion[]>;
  compose(principal: Principal, slots: StudioSlot[]): Promise<Composition>;
  afterCommit(): Promise<void>;
  scheduled(nowMs: number): Promise<unknown>;
  queue(batch: MessageBatch<unknown>): Promise<void>;
  exportData(principal: Principal): Promise<MediaExport>;
  /** Account erasure: purge cached thumbnails, then delete every object under the owner's prefix. Runs before the rows are deleted. */
  eraseOwner(userId: string): Promise<{ objects: number; cachedThumbnails: number }>;
  importData(principal: Principal, records: unknown, readAsset: (exportedKey: string) => Promise<ArrayBuffer | null>): Promise<unknown>;
}
