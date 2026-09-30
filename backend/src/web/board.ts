import type { TodayResponse } from '@garderobe/contracts';
import { escapeHtml } from '../api/http.js';

/**
 * The private web board: today's board rendered from the same semantic outfit document the app and
 * the Calendar description use (BoardDocument, profile section 11 order). Read-only HTML; no script.
 */

const STYLE = `:root{color-scheme:light dark}body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:46rem;margin:1.5rem auto;padding:0 1rem;color:#1c1c1e;background:#fafafa}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.card{background:#1c1c1e!important;border-color:#333!important}.muted{color:#aaa!important}}
h1{font-size:1.5rem;margin:.2rem 0}.dayline{font-size:1.15rem;margin:.4rem 0}.muted{color:#666;font-size:.9rem}
.card{background:#fff;border:1px solid #ddd;border-radius:.8rem;padding:1rem 1.1rem;margin:1rem 0}.why{font-style:italic;margin:0 0 .6rem}
.line{margin:.25rem 0}.label{font-weight:600;display:inline-block;min-width:7.5rem}.flourish{color:#666}
.thumbs{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.6rem}.thumbs img{width:72px;height:72px;object-fit:contain;background:#fff;border:1px solid #ddd;border-radius:.4rem}
.chosen{border-color:#1c1c1e;border-width:2px}.badge{font-size:.8rem;border:1px solid #999;border-radius:1rem;padding:0 .5rem;margin-left:.4rem}`;

export function renderBoardPage(today: TodayResponse, ownerName: string): string {
  const doc = today.board?.document ?? null;
  const media = new Map((today.garments ?? []).map((g) => [g.garmentId, g.media]));
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Garderobe · ${escapeHtml(today.date)}</title><style>${STYLE}</style></head><body>`;
  if (!today.board || !doc) {
    return `${head}<h1>${escapeHtml(today.date)}</h1><p>No board has been prepared for this day yet.</p><p class="muted">Signed in as ${escapeHtml(ownerName)}.</p></body></html>`;
  }
  const selected = today.selection?.status === 'active' ? today.selection.optionId : null;
  const worn = new Set(today.recordedWears.map((w) => w.garmentId));
  const freshness = today.sources.find((s) => s.source === 'weather');
  const weather = `${escapeHtml(doc.weather.line)}${freshness && freshness.status !== 'fresh' ? ` <span class="badge">${escapeHtml(freshness.status === 'stale' ? 'forecast not refreshed' : 'no forecast')}</span>` : ''}`;
  const calendar = doc.calendar.status === 'not_connected' ? 'Calendar not connected.' : doc.calendar.status === 'unavailable' ? 'Calendar could not be read.' : '';
  const options = doc.options
    .filter((o) => o.status === 'offerable')
    .map((o) => {
      const lines = o.lines
        .map((l) => `<div class="line"><span class="label">${escapeHtml(l.label)}</span>${escapeHtml(l.text)}${l.flourish ? ` <span class="flourish">· ${escapeHtml(l.flourish.text)}</span>` : ''}</div>`)
        .join('');
      const thumbs = o.garments
        .map((g) => {
          const m = media.get(g.garmentId);
          const url = m?.thumbnailUrl ?? m?.catalogueImageUrl ?? null;
          return url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(g.name)}" loading="lazy">` : '';
        })
        .join('');
      const wornAll = o.garments.filter((g) => !g.optional && !g.alternativeGroup).every((g) => worn.has(g.garmentId)) && worn.size > 0;
      return `<section class="card${o.optionId === selected ? ' chosen' : ''}" id="${escapeHtml(o.optionId)}"><p class="why">${escapeHtml(o.why)}${o.optionId === selected ? '<span class="badge">Chosen</span>' : ''}${wornAll ? '<span class="badge">Worn</span>' : ''}</p>${lines}${o.qualification ? `<p class="muted">${escapeHtml(o.qualification)}</p>` : ''}${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}</section>`;
    })
    .join('');
  return `${head}<header><p class="muted">${escapeHtml(today.date)} · revision ${escapeHtml(today.board.currentRevision)}</p><p class="dayline">${escapeHtml(doc.dayLine)}</p><p class="muted">${weather}${calendar ? ` ${escapeHtml(calendar)}` : ''}</p>${doc.suitabilityNote ? `<p>${escapeHtml(doc.suitabilityNote)}</p>` : ''}</header>
<main>${options}</main>${doc.shortfall ? `<p class="muted">${escapeHtml(doc.shortfall)}</p>` : ''}
<footer class="muted">Signed in as ${escapeHtml(ownerName)}. The same board as the Garderobe app.</footer></body></html>`;
}
