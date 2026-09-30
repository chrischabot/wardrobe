import { escapeHtml } from '../api/http.js';
import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';

const SCOPE_TEXT: Record<string, { title: string; detail: string }> = {
  'wardrobe:read': {
    title: 'Read your wardrobe',
    detail: 'See your garments, availability, boards, style profile and conversation, and get recommendations. Changes come back as proposals only.',
  },
  'wardrobe:write': {
    title: 'Make changes for you',
    detail: 'Record wears, laundry, arrivals and other changes through the same commands and checks as the Garderobe app, each with a receipt you can undo.',
  },
};

export const STYLE = `body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:34rem;margin:2rem auto;padding:0 1rem;color:#1c1c1e}
h1{font-size:1.4rem}label{display:block;margin:.8rem 0;padding:.8rem;border:1px solid #d1d1d6;border-radius:.6rem}
.detail{display:block;color:#555;font-size:.9rem;margin-left:1.6rem}.warn{background:#fff4e5;border:1px solid #f5c26b;padding:.6rem;border-radius:.5rem}
button{font-size:1rem;padding:.6rem 1.2rem;margin-right:.6rem;border-radius:.5rem;border:1px solid #888;background:#fff}button.primary{background:#1c1c1e;color:#fff;border-color:#1c1c1e}
.meta{color:#555;font-size:.9rem}`;

/** The Access-protected consent page: client identity, where tokens go, and read or write capability. */
export function consentPage(details: ConsentDescription, handle: string, ownerBinding: string, ownerName: string): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const requested = new Set(details.scope.length ? details.scope : ['wardrobe:read']);
  const scopes = ['wardrobe:read', 'wardrobe:write']
    .filter((s) => s === 'wardrobe:read' || requested.has(s))
    .map((s) => {
      const t = SCOPE_TEXT[s]!;
      const required = s === 'wardrobe:read';
      return `<label><input type="checkbox" name="scope" value="${escapeHtml(s)}" checked${required ? ' disabled' : ''}> <strong>${escapeHtml(t.title)}</strong> <code>${escapeHtml(s)}</code><span class="detail">${escapeHtml(t.detail)}${required ? ' Required.' : ''}</span></label>${required ? `<input type="hidden" name="scope" value="${escapeHtml(s)}">` : ''}`;
    })
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Allow ${name} to use Garderobe?</title><style>${STYLE}</style></head>
<body>
<h1>Allow ${name} to use your Garderobe?</h1>
<p class="meta">Signed in as ${escapeHtml(ownerName)}. ${origin}</p>
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<input type="hidden" name="owner" value="${escapeHtml(ownerBinding)}">
${scopes}
<p class="meta">You can disconnect ${name} at any time in Settings &gt; Connected assistants; it stops working immediately.</p>
<p><button class="primary" name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></p>
</form>
</body></html>`;
}

export function messagePage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}
