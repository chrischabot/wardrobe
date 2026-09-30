import type { RecoveryKit } from '../lifecycle/recovery.js';
import { escapeHtml } from '../api/http.js';
import { STYLE } from './consent.js';

/**
 * Private pages for collecting a recovery code that an assistant asked for. The code appears only on
 * the page the signed-in owner receives after pressing the button (a same-origin POST), never in an
 * assistant's transcript, a run event or a log.
 */

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}
code.kit{display:block;font-size:1.2rem;padding:.8rem;border:1px solid #d1d1d6;border-radius:.5rem;word-break:break-all;user-select:all}</style></head><body>${body}</body></html>`;
}

/** The owner's own confirmation of a request an assistant made (used by the 2025-11-25 adapter, or any time in a browser). */
export function confirmPage(ownerName: string, prompt: string, expiresAt: string): string {
  return page(
    'Confirm in Garderobe',
    `<h1>Confirm in Garderobe</h1>
<p class="meta">Signed in as ${escapeHtml(ownerName)}. This request waits until ${escapeHtml(expiresAt)}.</p>
<p>${escapeHtml(prompt)}</p>
<form method="post"><p><button class="primary" name="decision" value="confirm">Yes, do it</button><button name="decision" value="decline">No</button></p></form>`,
  );
}

export function confirmDonePage(status: string, link: { href: string; label: string } | null): string {
  const title = status === 'executed' ? 'Done' : status === 'declined' ? 'Not done' : 'This request has expired';
  const body = status === 'executed' ? 'Done. Your assistant gets the result when it asks again.' : status === 'declined' ? 'Nothing was changed.' : 'Nothing was changed; ask your assistant again.';
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>` : ''}`);
}

export function recoveryCollectPage(ownerName: string, expiresAt: string): string {
  return page(
    'Collect your new recovery code',
    `<h1>Collect your new recovery code</h1>
<p class="meta">Signed in as ${escapeHtml(ownerName)}. This link works once, until ${escapeHtml(expiresAt)}.</p>
<p>Your assistant asked Garderobe to prepare a new recovery code. It is shown on the next page only, and it replaces your current code as soon as it is shown.</p>
<p class="warn">Have somewhere offline ready to keep it: printed, or in a password manager. Do not paste it into a chat.</p>
<form method="post"><p><button class="primary" type="submit">Show my new recovery code</button></p></form>`,
  );
}

export function recoveryCodePage(kit: Pick<RecoveryKit, 'credential' | 'issuedAt' | 'instructions'>): string {
  return page(
    'Your new recovery code',
    `<h1>Your new recovery code</h1>
<code class="kit">${escapeHtml(kit.credential)}</code>
<p>${escapeHtml(kit.instructions)}</p>
<p class="meta">Issued ${escapeHtml(kit.issuedAt)}. Your previous code no longer works. This page is not stored; if you lose the code, create a new one in Garderobe.</p>`,
  );
}
