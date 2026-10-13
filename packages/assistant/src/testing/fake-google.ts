/**
 * FAKE GOOGLE API - TEST ONLY.
 *
 * A scripted stand-in for gmail.googleapis.com, www.googleapis.com (Drive) and sheets.googleapis.com, used
 * at the `fetch` boundary of the Google adapters. It follows the request and response shapes of the
 * published discovery documents the adapters were written against, but it is not Google: nothing verified
 * with it is a live verification. Everything above the fetch call (the adapters, the investigation job,
 * the model service, D1, the command service) is the real implementation.
 */
export const FAKE_GOOGLE_LABEL = "FAKE Google API (test double at the fetch boundary)";

export interface FakeMail {
  id: string;
  threadId: string;
  sentAt: string;
  from: string;
  subject: string;
  text?: string;
  html?: string;
  attachment?: { filename: string; mimeType: string; bytes: Uint8Array };
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (text: string) => b64url(new TextEncoder().encode(text));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createFakeGoogle(seed: { mail?: FakeMail[]; pageSize?: number; sheets?: Record<string, string[][]>; files?: Record<string, { name: string; mimeType: string; content: string }> } = {}) {
  const state = {
    mail: [...(seed.mail ?? [])],
    sheets: { ...(seed.sheets ?? {}) } as Record<string, string[][]>,
    files: { ...(seed.files ?? {}) } as Record<string, { name: string; mimeType: string; content: string }>,
    /** Every request the fake received, for assertions about what left the adapter. */
    requests: [] as { method: string; url: string; authorization: string | null; body: string | null }[],
    opened: [] as string[],
    token: "good-token",
    historyId: 1000,
    mode: "ok" as "ok" | "unauthorized" | "redirect" | "rate_limited" | "down",
  };
  const pageSize = seed.pageSize ?? 2;

  const matches = (m: FakeMail, q: string): boolean => {
    const after = /after:(\d{4})\/(\d{2})\/(\d{2})/.exec(q);
    const before = /before:(\d{4})\/(\d{2})\/(\d{2})/.exec(q);
    const day = m.sentAt.slice(0, 10);
    if (after && day < `${after[1]}-${after[2]}-${after[3]}`) return false;
    if (before && day >= `${before[1]}-${before[2]}-${before[3]}`) return false;
    const from = /from:\("([^"]+)"\)/.exec(q);
    if (from) return m.from.toLowerCase().includes(from[1]!.toLowerCase());
    const subject = /subject:\(([^)]+)\)/.exec(q);
    if (subject) return subject[1]!.split(" OR ").some((w) => m.subject.toLowerCase().includes(w.trim().toLowerCase()));
    return true;
  };

  const message = (m: FakeMail, format: string) => {
    const headers = [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "Date", value: new Date(m.sentAt).toUTCString() }];
    const base = { id: m.id, threadId: m.threadId, internalDate: String(Date.parse(m.sentAt)), historyId: String(state.historyId), snippet: (m.text ?? m.html ?? "").slice(0, 80) };
    if (format === "metadata") return { ...base, payload: { mimeType: "multipart/mixed", headers: headers.filter((h) => h.name === "Date") } };
    const parts: unknown[] = [];
    if (m.text !== undefined) parts.push({ mimeType: "text/plain", body: { size: m.text.length, data: enc(m.text) } });
    if (m.html !== undefined) parts.push({ mimeType: "text/html", body: { size: m.html.length, data: enc(m.html) } });
    if (m.attachment) parts.push({ mimeType: m.attachment.mimeType, filename: m.attachment.filename, body: { attachmentId: `att_${m.id}`, size: m.attachment.bytes.length } });
    return { ...base, payload: { mimeType: "multipart/mixed", headers, parts } };
  };

  const fetchFake = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const body = typeof init?.body === "string" ? init.body : init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : null;
    state.requests.push({ method: init?.method ?? "GET", url: url.toString(), authorization, body });
    if (state.mode === "down") throw new TypeError("fetch failed");
    if (state.mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
    if (state.mode === "rate_limited") return json({ error: { code: 429 } }, 429);
    if (state.mode === "unauthorized" || authorization !== `Bearer ${state.token}`) return json({ error: { code: 401, message: "Invalid Credentials" } }, 401);
    const path = url.pathname;
    const method = init?.method ?? "GET";

    if (url.hostname === "gmail.googleapis.com") {
      if (path === "/gmail/v1/users/me/profile") return json({ emailAddress: "owner@example.com", messagesTotal: state.mail.length, historyId: String(state.historyId) });
      if (path === "/gmail/v1/users/me/messages") {
        const found = state.mail.filter((m) => matches(m, url.searchParams.get("q") ?? ""));
        const start = Number(url.searchParams.get("pageToken") ?? "0");
        const page = found.slice(start, start + pageSize);
        return json({ messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), ...(start + pageSize < found.length ? { nextPageToken: String(start + pageSize) } : {}), resultSizeEstimate: found.length });
      }
      if (path === "/gmail/v1/users/me/history") {
        const since = Number(url.searchParams.get("startHistoryId"));
        const added = state.mail.filter((_m, i) => 1000 + i >= since);
        return json({ history: added.map((m) => ({ messagesAdded: [{ message: { id: m.id, threadId: m.threadId } }] })), historyId: String(state.historyId) });
      }
      const attachment = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
      if (attachment) {
        const m = state.mail.find((x) => x.id === attachment[1]);
        return m?.attachment ? json({ size: m.attachment.bytes.length, data: b64url(m.attachment.bytes) }) : json({ error: { code: 404 } }, 404);
      }
      const one = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path);
      if (one) {
        const m = state.mail.find((x) => x.id === decodeURIComponent(one[1]!));
        if (!m) return json({ error: { code: 404 } }, 404);
        const format = url.searchParams.get("format") ?? "full";
        if (format === "full") state.opened.push(m.id);
        return json(message(m, format));
      }
    }

    if (url.hostname === "www.googleapis.com") {
      if (path === "/drive/v3/about") return json({ user: { emailAddress: "owner@example.com" } });
      if (path === "/upload/drive/v3/files" && method === "POST") {
        const id = `file_${Object.keys(state.files).length + 1}`;
        const meta = JSON.parse(/\r\n\r\n(\{.*?\})\r\n--/s.exec(body ?? "")?.[1] ?? "{}") as { name: string; mimeType: string };
        const content = (body ?? "").split(/\r\n\r\n/).slice(2).join("\r\n\r\n").replace(/\r\n--[^\r\n]+--$/, "");
        state.files[id] = { name: meta.name, mimeType: meta.mimeType, content };
        return json({ id, name: meta.name, mimeType: meta.mimeType, version: "1" });
      }
      if (path === "/drive/v3/files") return json({ files: Object.entries(state.files).map(([id, f]) => ({ id, name: f.name, mimeType: f.mimeType })) });
      const exported = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(path);
      if (exported) {
        const f = state.files[exported[1]!];
        return f ? new Response(f.content, { headers: { "content-type": url.searchParams.get("mimeType") ?? "text/plain" } }) : json({ error: { code: 404 } }, 404);
      }
      const file = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
      if (file) {
        const f = state.files[file[1]!];
        if (!f) return json({ error: { code: 404 } }, 404);
        if (url.searchParams.get("alt") === "media") return new Response(f.content, { headers: { "content-type": f.mimeType } });
        return json({ id: file[1], name: f.name, mimeType: f.mimeType, version: "3", modifiedTime: "2026-09-10T10:00:00Z" });
      }
    }

    if (url.hostname === "sheets.googleapis.com") {
      if (path === "/v4/spreadsheets" && method === "POST") {
        const id = `sheet_${Object.keys(state.sheets).length + 1}`;
        state.sheets[id] = [];
        return json({ spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${id}` });
      }
      const values = /^\/v4\/spreadsheets\/([^/]+)\/values\/(.+)$/.exec(path);
      if (values) {
        const id = values[1]!;
        if (!(id in state.sheets)) return json({ error: { code: 404 } }, 404);
        if (method === "PUT") {
          const sent = JSON.parse(body ?? "{}") as { values: (string | number)[][] };
          state.sheets[id] = sent.values.map((row) => row.map(String));
          return json({ spreadsheetId: id, updatedRange: decodeURIComponent(values[2]!), updatedRows: sent.values.length });
        }
        return json({ range: decodeURIComponent(values[2]!), majorDimension: "ROWS", values: state.sheets[id] });
      }
    }
    return json({ error: { code: 404, message: `FAKE Google has no route ${method} ${url.hostname}${path}` } }, 404);
  }) as typeof fetch;

  return { fetch: fetchFake, state };
}
