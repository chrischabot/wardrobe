// Scoped, paginated email investigation. The query set is fixed when the
// investigation is constructed; message content is returned as data and is
// never interpreted, so nothing in an email body can change what is searched.

export interface MailSearchHit { id: string; threadId: string; sentAt: string }
export interface MailMessage { id: string; threadId: string; sentAt: string; from: string; subject: string; body: string }

export interface MailSource {
  search(query: string, pageToken?: string): Promise<{ messages: MailSearchHit[]; nextPageToken?: string }>;
  open(id: string): Promise<MailMessage>;
}

export interface InvestigationResume { queryIndex: number; pageToken?: string }

export interface InvestigationRunInput {
  /** Continue from where a previous partial run stopped. */
  resume?: InvestigationResume;
  /** Message ids already opened by earlier runs; they are not opened again. */
  skipIds?: string[];
}

export interface InvestigationResult {
  /** Messages opened in this run, each exactly once, in discovery order. */
  messages: MailMessage[];
  /** Earliest and latest sent time among the messages found in this run; null when none were found. */
  searchedRange: { from: string | null; to: string | null };
  pagesRead: number;
  /** `complete` only when every query was followed until no next page token remained. */
  completion: "complete" | "partial";
  resume: InvestigationResume | null;
}

export class EmailInvestigation {
  readonly queries: readonly string[];
  readonly maxPages: number;
  readonly #source: MailSource;

  constructor(options: { source: MailSource; queries: string[]; maxPages: number }) {
    if (!Number.isInteger(options.maxPages) || options.maxPages < 1) throw new RangeError("maxPages must be a positive integer");
    this.#source = options.source;
    this.queries = Object.freeze([...options.queries]);
    this.maxPages = options.maxPages;
  }

  async run(input: InvestigationRunInput = {}): Promise<InvestigationResult> {
    let queryIndex = input.resume?.queryIndex ?? 0;
    let pageToken: string | undefined = input.resume?.pageToken || undefined;
    if (!Number.isInteger(queryIndex) || queryIndex < 0) throw new RangeError("resume.queryIndex must be a non-negative integer");
    const seen = new Set<string>(input.skipIds ?? []);
    const messages: MailMessage[] = [];
    let pagesRead = 0;
    let fromMs: number | null = null;
    let toMs: number | null = null;

    const finish = (completion: "complete" | "partial", resume: InvestigationResume | null): InvestigationResult => ({
      messages,
      searchedRange: {
        from: fromMs === null ? null : new Date(fromMs).toISOString(),
        to: toMs === null ? null : new Date(toMs).toISOString(),
      },
      pagesRead,
      completion,
      resume,
    });

    while (queryIndex < this.queries.length) {
      if (pagesRead >= this.maxPages) {
        // Work remains (another page or another query), so this is never reported as complete.
        return finish("partial", pageToken === undefined ? { queryIndex } : { queryIndex, pageToken });
      }
      const query = this.queries[queryIndex];
      if (query === undefined) break;
      const page = await this.#source.search(query, pageToken);
      pagesRead += 1;
      for (const hit of page.messages) {
        const ms = Date.parse(hit.sentAt);
        if (!Number.isNaN(ms)) {
          if (fromMs === null || ms < fromMs) fromMs = ms;
          if (toMs === null || ms > toMs) toMs = ms;
        }
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        messages.push(await this.#source.open(hit.id));
      }
      if (page.nextPageToken) {
        pageToken = page.nextPageToken;
      } else {
        pageToken = undefined;
        queryIndex += 1;
      }
    }
    return finish("complete", null);
  }
}
