/**
 * Google adapters: Gmail (read), Drive (selected and app-created files; whole-Drive search as a separate
 * capability) and Sheets. Specification section 10 and 15.
 *
 * Contracts verified against Google's published discovery documents on the day this was written:
 *   Gmail v1   https://gmail.googleapis.com/$discovery/rest?version=v1      (revision 20260928)
 *   Drive v3   https://www.googleapis.com/discovery/v1/apis/drive/v3/rest   (revision 20260927)
 *   Sheets v4  https://sheets.googleapis.com/$discovery/rest?version=v4     (revision 20260923)
 * Nothing here was exercised against a live Google account: that needs the owner's OAuth grant, which the
 * Worker's credential store holds. This module never sees a refresh token or a client secret; it is handed
 * a function that returns a current access token.
 *
 * Everything read from Google is DATA. A message body, a file or a cell cannot instruct the assistant and
 * cannot authorize a change; callers wrap it as untrusted before a model sees it.
 */
import { ConnectionError } from "./mcp.ts";
import type { MailMessage, MailSearchHit, MailSource } from "../research/commerce/investigation.ts";

export const GOOGLE_SCOPES = {
  gmailRead: "https://www.googleapis.com/auth/gmail.readonly",
  calendarRead: "https://www.googleapis.com/auth/calendar.readonly",
  /** Files the owner picked or the application created. */
  driveFile: "https://www.googleapis.com/auth/drive.file",
  /** Whole-Drive search: a distinct capability the owner enables separately. */
  driveReadonly: "https://www.googleapis.com/auth/drive.readonly",
  sheets: "https://www.googleapis.com/auth/spreadsheets",
} as const;

const HOSTS = new Set(["gmail.googleapis.com", "www.googleapis.com", "sheets.googleapis.com"]);
const MAX_JSON_BYTES = 4_000_000;
const MAX_MEDIA_BYTES = 25_000_000;

export interface GoogleApiOptions {
  /** A current access token for this owner's grant. Called per request; refresh is the credential store's job. */
  accessToken: () => Promise<string>;
  /** Scopes the owner granted. A call that needs a scope outside this list is refused before any request. */
  grantedScopes: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Upper bound on requests through this instance (one job or one turn). */
  maxCalls?: number;
}

export class GoogleApi {
  private calls = 0;
  constructor(private readonly options: GoogleApiOptions) {}

  get callsMade(): number {
    return this.calls;
  }

  requireScope(...anyOf: string[]): void {
    if (!anyOf.some((s) => this.options.grantedScopes.includes(s))) throw new ConnectionError("scope_not_granted", `the owner has not granted ${anyOf.join(" or ")}`);
  }

  private async send(url: URL, init: RequestInit, maxBytes: number): Promise<Response> {
    if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) throw new ConnectionError("endpoint_not_allowed", "not a Google API endpoint");
    if (this.options.maxCalls !== undefined && this.calls >= this.options.maxCalls) throw new ConnectionError("call_limit", "the call limit for this run was reached");
    this.calls++;
    const token = await this.options.accessToken();
    const doFetch = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(url.toString(), { ...init, redirect: "manual", headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000) });
    } catch (e) {
      throw new ConnectionError("transport", `Google could not be reached: ${(e as Error).name}`);
    }
    // The bearer token is never followed to another host.
    if (response.status >= 300 && response.status < 400) throw new ConnectionError("redirect_refused", "Google answered with a redirect; it was not followed");
    if (response.status === 401) throw new ConnectionError("auth", "the Google grant was rejected; the owner needs to reconnect");
    if (response.status === 403) throw new ConnectionError("forbidden", "Google refused this request (missing permission or scope)");
    if (response.status === 404) throw new ConnectionError("not_found", "Google has no such resource for this account");
    if (response.status === 429) throw new ConnectionError("rate_limited", "Google rate limit reached; try again later");
    if (!response.ok) throw new ConnectionError("upstream", `Google answered ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) throw new ConnectionError("too_large", "the response is larger than this connection accepts");
    return response;
  }

  async json<T>(base: string, path: string, query: Record<string, string | number | boolean | string[] | undefined> = {}, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, String(v));
    }
    const response = await this.send(url, init, MAX_JSON_BYTES);
    const text = await response.text();
    if (text.length > MAX_JSON_BYTES) throw new ConnectionError("too_large", "the response is larger than this connection accepts");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ConnectionError("upstream", "Google answered with something that is not JSON");
    }
  }

  async bytes(base: string, path: string, query: Record<string, string> = {}): Promise<{ bytes: Uint8Array; contentType: string }> {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const response = await this.send(url, {}, MAX_MEDIA_BYTES);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_MEDIA_BYTES) throw new ConnectionError("too_large", "the file is larger than this connection accepts");
    return { bytes, contentType: response.headers.get("content-type") ?? "application/octet-stream" };
  }
}

/* ------------------------------------------------------------------ */
/* Gmail                                                                */
/* ------------------------------------------------------------------ */

const GMAIL = "https://gmail.googleapis.com/";

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  historyId?: string;
  snippet?: string;
  payload?: GmailPart;
}

export function decodeBase64Url(data: string): Uint8Array {
  const padded = data.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(data.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Visible text of an HTML body: scripts, styles and hidden comment text are dropped, never interpreted. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&pound;/g, "£")
    .replace(/&euro;/g, "€")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function bodyOf(part: GmailPart | undefined): string {
  if (!part) return "";
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: GmailPart) => {
    if (p.filename) return; // attachments are opened explicitly, never inlined
    if (p.body?.data && p.mimeType === "text/plain") plain.push(new TextDecoder().decode(decodeBase64Url(p.body.data)));
    else if (p.body?.data && p.mimeType === "text/html") html.push(htmlToText(new TextDecoder().decode(decodeBase64Url(p.body.data))));
    for (const child of p.parts ?? []) walk(child);
  };
  walk(part);
  return (plain.length > 0 ? plain : html).join("\n").slice(0, 200_000);
}

function attachmentsOf(part: GmailPart | undefined): { attachmentId: string; filename: string; mimeType: string; size: number }[] {
  const out: { attachmentId: string; filename: string; mimeType: string; size: number }[] = [];
  const walk = (p: GmailPart) => {
    if (p.filename && p.body?.attachmentId) out.push({ attachmentId: p.body.attachmentId, filename: p.filename, mimeType: p.mimeType ?? "application/octet-stream", size: p.body.size ?? 0 });
    for (const child of p.parts ?? []) walk(child);
  };
  if (part) walk(part);
  return out;
}

const header = (m: GmailMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
const sentAt = (m: GmailMessage) => (m.internalDate ? new Date(Number(m.internalDate)).toISOString() : new Date(0).toISOString());

export interface GmailSource extends MailSource {
  /** Attachments of a message (names and sizes); bytes are fetched one at a time with `attachment`. */
  attachments(messageId: string): Promise<{ attachmentId: string; filename: string; mimeType: string; size: number }[]>;
  attachment(messageId: string, attachmentId: string): Promise<Uint8Array>;
  /** The mailbox's current history ID: the watermark for incremental synchronization. */
  profile(): Promise<{ emailAddress: string; historyId: string }>;
  /** Message IDs added since a watermark, so a later run does not reread the mailbox. */
  addedSince(startHistoryId: string): Promise<{ messageIds: string[]; historyId: string; complete: boolean }>;
}

export function createGmailSource(api: GoogleApi, opts: { pageSize?: number; maxHistoryPages?: number } = {}): GmailSource {
  api.requireScope(GOOGLE_SCOPES.gmailRead);
  const user = "gmail/v1/users/me";
  const open = async (id: string): Promise<{ raw: GmailMessage; message: MailMessage }> => {
    const raw = await api.json<GmailMessage>(GMAIL, `${user}/messages/${encodeURIComponent(id)}`, { format: "full" });
    return { raw, message: { id: raw.id, threadId: raw.threadId, sentAt: sentAt(raw), from: header(raw, "from"), subject: header(raw, "subject"), body: bodyOf(raw.payload) } };
  };
  return {
    async search(query: string, pageToken?: string) {
      const page = await api.json<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(GMAIL, `${user}/messages`, { q: query, maxResults: opts.pageSize ?? 25, includeSpamTrash: false, ...(pageToken ? { pageToken } : {}) });
      const hits: MailSearchHit[] = [];
      for (const m of page.messages ?? []) {
        // The list call returns IDs only; the date comes from a metadata read, never from guessing.
        const meta = await api.json<GmailMessage>(GMAIL, `${user}/messages/${encodeURIComponent(m.id)}`, { format: "metadata", metadataHeaders: ["Date"] });
        hits.push({ id: m.id, threadId: m.threadId, sentAt: sentAt(meta) });
      }
      return { messages: hits, ...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}) };
    },
    open: async (id: string) => (await open(id)).message,
    attachments: async (messageId: string) => attachmentsOf((await open(messageId)).raw.payload),
    async attachment(messageId: string, attachmentId: string) {
      const body = await api.json<{ data?: string; size?: number }>(GMAIL, `${user}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`);
      return decodeBase64Url(body.data ?? "");
    },
    profile: async () => api.json<{ emailAddress: string; historyId: string }>(GMAIL, `${user}/profile`),
    async addedSince(startHistoryId: string) {
      const ids = new Set<string>();
      let pageToken: string | undefined;
      let historyId = startHistoryId;
      const maxPages = opts.maxHistoryPages ?? 20;
      for (let page = 0; page < maxPages; page++) {
        const res = await api.json<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; nextPageToken?: string; historyId?: string }>(GMAIL, `${user}/history`, { startHistoryId, historyTypes: ["messageAdded"], ...(pageToken ? { pageToken } : {}) });
        for (const h of res.history ?? []) for (const added of h.messagesAdded ?? []) ids.add(added.message.id);
        if (res.historyId) historyId = res.historyId;
        if (!res.nextPageToken) return { messageIds: [...ids], historyId, complete: true };
        pageToken = res.nextPageToken;
      }
      // The watermark is not advanced past pages that were not read.
      return { messageIds: [...ids], historyId: startHistoryId, complete: false };
    },
  };
}

/** Gmail search queries for purchases in a period. Built by trusted code; no message content can change them. */
export function purchaseQueries(input: { from: string; to: string; merchants?: string[] }): string[] {
  const day = (d: string) => d.replace(/-/g, "/");
  const range = `after:${day(input.from)} before:${day(input.to)}`;
  const base = [`${range} subject:(order OR receipt OR confirmation OR invoice)`, `${range} subject:(dispatched OR shipped OR delivered OR refund OR return)`];
  const merchants = (input.merchants ?? []).map((m) => m.replace(/[^\p{L}\p{N} .&'-]/gu, " ").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 10);
  return [...merchants.map((m) => `${range} from:("${m}")`), ...base];
}

/* ------------------------------------------------------------------ */
/* Drive                                                                */
/* ------------------------------------------------------------------ */

const DRIVE = "https://www.googleapis.com/";
const FILE_FIELDS = "id,name,mimeType,modifiedTime,size,md5Checksum,version,webViewLink";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
  version?: string;
  webViewLink?: string;
}

export interface DriveClient {
  /** Whole-Drive search. Needs the separately granted read-only Drive scope; refused otherwise. */
  search(query: string, pageToken?: string): Promise<{ files: DriveFile[]; nextPageToken: string | null }>;
  /** Metadata of a file the owner selected or the application created. */
  metadata(fileId: string): Promise<DriveFile>;
  download(fileId: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Export a Google-native document (a Sheet as CSV, a Doc as text). */
  exportAs(fileId: string, mimeType: string): Promise<{ bytes: Uint8Array; contentType: string }>;
  /** Create a file owned by the application (an export). Returns the file with its Drive version. */
  create(input: { name: string; mimeType: string; content: Uint8Array | string; parents?: string[] }): Promise<DriveFile>;
}

export function createDriveClient(api: GoogleApi): DriveClient {
  api.requireScope(GOOGLE_SCOPES.driveFile, GOOGLE_SCOPES.driveReadonly);
  return {
    async search(query, pageToken) {
      api.requireScope(GOOGLE_SCOPES.driveReadonly);
      const res = await api.json<{ files?: DriveFile[]; nextPageToken?: string }>(DRIVE, "drive/v3/files", { q: query, pageSize: 25, spaces: "drive", fields: `nextPageToken,files(${FILE_FIELDS})`, ...(pageToken ? { pageToken } : {}) });
      return { files: res.files ?? [], nextPageToken: res.nextPageToken ?? null };
    },
    metadata: (fileId) => api.json<DriveFile>(DRIVE, `drive/v3/files/${encodeURIComponent(fileId)}`, { fields: FILE_FIELDS }),
    download: (fileId) => api.bytes(DRIVE, `drive/v3/files/${encodeURIComponent(fileId)}`, { alt: "media" }),
    exportAs: (fileId, mimeType) => api.bytes(DRIVE, `drive/v3/files/${encodeURIComponent(fileId)}/export`, { mimeType }),
    async create(input) {
      api.requireScope(GOOGLE_SCOPES.driveFile);
      const boundary = `garderobe-${crypto.randomUUID()}`;
      const meta = JSON.stringify({ name: input.name, mimeType: input.mimeType, ...(input.parents ? { parents: input.parents } : {}) });
      const enc = new TextEncoder();
      const content = typeof input.content === "string" ? enc.encode(input.content) : input.content;
      const head = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`);
      const tail = enc.encode(`\r\n--${boundary}--`);
      const body = new Uint8Array(head.length + content.length + tail.length);
      body.set(head, 0);
      body.set(content, head.length);
      body.set(tail, head.length + content.length);
      return api.json<DriveFile>(DRIVE, "upload/drive/v3/files", { uploadType: "multipart", fields: FILE_FIELDS }, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Sheets                                                               */
/* ------------------------------------------------------------------ */

const SHEETS = "https://sheets.googleapis.com/";

export interface SheetsClient {
  /** Cell values of a range, formatted as shown. Formulas are returned as their displayed value, never evaluated here. */
  read(spreadsheetId: string, range: string): Promise<{ range: string; rows: string[][] }>;
  /** Rows keyed by the header row, for the import preview. Cells are data: a cell that looks like an instruction stays a cell. */
  readRecords(spreadsheetId: string, range: string): Promise<Record<string, string>[]>;
  /** Overwrite a range with literal values (RAW: nothing is parsed as a formula). */
  write(spreadsheetId: string, range: string, rows: (string | number)[][]): Promise<{ updatedRange: string; updatedRows: number }>;
  create(title: string): Promise<{ spreadsheetId: string; url: string }>;
}

export function createSheetsClient(api: GoogleApi): SheetsClient {
  api.requireScope(GOOGLE_SCOPES.sheets, GOOGLE_SCOPES.driveFile);
  const read: SheetsClient["read"] = async (spreadsheetId, range) => {
    const res = await api.json<{ range?: string; values?: unknown[][] }>(SHEETS, `v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`, { majorDimension: "ROWS", valueRenderOption: "FORMATTED_VALUE" });
    return { range: res.range ?? range, rows: (res.values ?? []).map((row) => row.map((cell) => String(cell ?? ""))) };
  };
  return {
    read,
    async readRecords(spreadsheetId, range) {
      const { rows } = await read(spreadsheetId, range);
      const [head, ...body] = rows;
      if (!head) return [];
      return body.filter((row) => row.some((c) => c.trim() !== "")).map((row) => Object.fromEntries(head.map((h, i) => [h.trim(), row[i] ?? ""])));
    },
    async write(spreadsheetId, range, rows) {
      const res = await api.json<{ updatedRange?: string; updatedRows?: number }>(SHEETS, `v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`, { valueInputOption: "RAW" }, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ range, majorDimension: "ROWS", values: rows }) });
      return { updatedRange: res.updatedRange ?? range, updatedRows: res.updatedRows ?? 0 };
    },
    async create(title) {
      const res = await api.json<{ spreadsheetId: string; spreadsheetUrl?: string }>(SHEETS, "v4/spreadsheets", {}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ properties: { title } }) });
      return { spreadsheetId: res.spreadsheetId, url: res.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${res.spreadsheetId}` };
    },
  };
}
