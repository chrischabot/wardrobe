/**
 * The owner's consent on the Ferrite Wardrobe app's own consent page (`ferrite/src/oauth.rs`), as a browser would
 * give it: GET the authorization URL Codex printed, take the form's hidden fields (among them the server-issued
 * `issued` and `form_mac`, which POST /oauth/authorize requires and accepts for 10 minutes), and POST them back at
 * once with the owner token and the decision. The answer is the 302 to Codex's loopback callback.
 *
 * The owner token is the app's own sign-in (WARDROBE_OWNER_TOKEN); it is never written to output or errors here.
 */

const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
const unescape = (s) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => HTML_ENTITIES[e]);

/** The hidden fields of a consent page's form, unescaped (the server writes `<input type="hidden" name="…" value="…">`). */
export function hiddenFields(html) {
  const out = {};
  for (const m of String(html ?? "").matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) out[m[1]] = unescape(m[2]);
  return out;
}

/** The consent form's POST target, resolved against the page URL; it must stay on the page's origin. */
export function formAction(html, pageUrl) {
  const m = /<form method="post" action="([^"]*)"/.exec(String(html ?? ""));
  const action = new URL(m ? unescape(m[1]) : pageUrl.pathname, pageUrl);
  if (action.origin !== pageUrl.origin) throw new Error(`the consent form posts to another origin (${action.origin})`);
  return action;
}

/**
 * Allow the connection on the Ferrite consent page and return the callback URL it redirects to.
 * `appOrigin` is the origin of the configured Ferrite app (the plugin's MCP URL) and is required: the authorization
 * URL comes from OAuth discovery, and the owner token is the app's own sign-in, so nothing is fetched or posted unless
 * the authorization page is on that same origin. `fetchImpl` is injectable for tests; each request is bounded by
 * `timeoutMs`.
 */
export async function ferriteConsent(authUrl, { appOrigin, ownerToken, write = true, fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  if (!ownerToken) throw new Error("no owner token: set WARDROBE_OWNER_TOKEN to the Ferrite app's owner token");
  if (!appOrigin) throw new Error("no app origin: the Ferrite app's origin is required before the owner token is sent anywhere");
  const expected = new URL(String(appOrigin)).origin;
  const authOrigin = new URL(String(authUrl)).origin;
  if (authOrigin !== expected) throw new Error(`the authorization page (${authOrigin}) is not on the Ferrite app's origin (${expected}); the owner token is not sent`);
  const page = await fetchImpl(String(authUrl), { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const html = await page.text();
  if (page.status !== 200) throw new Error(`the consent page answered ${page.status}`);
  const fields = hiddenFields(html);
  if (!fields.issued || !fields.form_mac) throw new Error("the consent page carries no issued/form_mac fields (is this the Ferrite app, with an owner token configured?)");
  const body = new URLSearchParams({ ...fields, owner_token: ownerToken, decision: "allow", ...(write ? { write: "on" } : {}) });
  const posted = await fetchImpl(String(formAction(html, new URL(String(authUrl)))), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const location = posted.headers.get("location");
  if (posted.status !== 302 || !location) throw new Error(`the consent was not accepted: ${posted.status}${location ? "" : ", no redirect"}`);
  return new URL(location, String(authUrl));
}
