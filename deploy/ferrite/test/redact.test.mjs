import assert from "node:assert/strict";
import { test } from "node:test";
import { deployedOrigin, localOrigin, originForEvidence } from "../lib/origin.mjs";
import { isCredentialKey, redact, redactError, redactText } from "../lib/redact.mjs";

// Credential-like literals are built by concatenation so no tool or scanner mistakes a fixture for a real secret.
const PW = "pass" + "word";

test("redaction stays linear: long colon-free runs, many scheme-like words and long dot runs", () => {
  // Linear work grows about 4x when the input grows 4x; the quadratic paths this guards against grow about 16x.
  // Measured with a monotonic clock; the bound tolerates scheduling noise (10x plus a fixed allowance).
  const time = (text) => {
    const t0 = performance.now();
    redactText(text, [], 50);
    return performance.now() - t0;
  };
  const shapes = [(n) => "a".repeat(n), (n) => "a:".repeat(n / 2), (n) => `${"ab:".repeat(n / 3)}x@y`, (n) => ".".repeat(n), (n) => "a.".repeat(n / 2), (n) => `x${".".repeat(n)}password=v`];
  for (const shape of shapes) {
    const n = 1 << 18;
    time(shape(n)); // warm up
    const small = time(shape(n));
    const large = time(shape(4 * n));
    assert.ok(large < 10 * small + 250, `${shape(12).slice(0, 12)}…: ${small.toFixed(0)} ms at ${n}, ${large.toFixed(0)} ms at ${4 * n}`);
  }
  assert.equal(redactText(`x${".".repeat(1000)}password=hunter2`).includes("hunter2"), false, "a name after a dot run is still found");
  // Behaviour is unchanged: userinfo is still removed, ordinary URLs and times are kept.
  assert.equal(redactText("see https://user:pw-value@host.example/x").includes("pw-value"), false);
  assert.equal(redactText("at 10:30 see https://host.example/a"), "at 10:30 see https://host.example/a");
  // A scheme glued to a preceding digit, dot, plus or hyphen is still a scheme a parser may read.
  for (const prefix of ["1", "x.", "a-", "+", "9.9-"]) {
    const out = redactText(`see ${prefix}https://shortsecret@host.example/`);
    assert.equal(out.includes("shortsecret"), false, out);
  }
  assert.equal(redactText("time 12:30@noon").includes("30"), true, "a colon after digits only is no scheme");
});

test("redaction: credential names in strings and keys alike, whatever case or separator", () => {
  const s = "short-secret";
  const inputs = [
    `X-Auth-Key: ${s}`, `x-auth-token: "${s}" more`, `Authorization: Basic ${s}`, `Proxy-Authorization: ${s}`, `PASSPHRASE=${s}`, `clientPassphrase=${s}`,
    `client-secret=${s}`, `WARDROBE_OWNER_TOKEN='${s} x'`, `{"refresh_` + `token":"${s}"}`, `api_key: ${s}`, `invitation_code=${s}`, `authCode=${s}`, `Bearer ${s}`,
  ];
  for (const input of inputs) assert.equal(redactText(input).includes(s), false, input);
  // A credential header is redacted to the end of its line, whatever it holds.
  for (const line of [`Authorization: Bearer "${s}"`, `X-Api-Key: "a" ${s}`, `Cookie: a=1; sid=${s}`]) assert.equal(redactText(`${line}\nnext line kept`).includes(s), false, line);
  assert.ok(redactText(`Authorization: x\nnext line kept`).includes("next line kept"));
  for (const key of ["Authorization", "x-auth-key", "client-secret", "clientPassphrase", "WARDROBE_OWNER_TOKEN", "googleRefreshToken", "service-api-key", "authCode", "invitation_code", "proxy-authorization", "x-api-key"]) assert.ok(isCredentialKey(key), key);
  for (const key of ["code", "commandId", "inputTokens", "garments", "status"]) assert.equal(isCredentialKey(key), false, key);
  assert.deepEqual(redact({ error: { code: "unauthenticated", message: "that token is not valid for this wardrobe" }, garments: 127 }), { error: { code: "unauthenticated", message: "that token is not valid for this wardrobe" }, garments: 127 });
});

test("redaction: JSON embedded in strings at any escaping depth", () => {
  const cases = [
    `body {"${PW}":"short-value"}`,
    `body {"${PW}": "short-value", "ok": 1}`,
    String.raw`outer {"a":"{\"password\":\"short-value\"}"}`,
    String.raw`deeper {\\\"clientSecret\\\":\\\"short-value\\\"}`,
    String.raw`{"token":short-value}`,
    `{"Authorization":"Basic short-value"}`,
  ];
  for (const c of cases) {
    const out = redactText(c);
    assert.equal(/short[- ]value/.test(out), false, `${c} -> ${out}`);
  }
  assert.ok(redactText(String.raw`{"ok":"kept"}`).includes("kept"));
  // An escaped quote or backslash INSIDE an embedded credential value does not end it early.
  const quoteInside = redactText(String.raw`outer {"a":"{\"password\":\"sh\\\"ort tail-part\"}"}`);
  assert.equal(/ort tail-part|tail-part/.test(quoteInside), false, quoteInside);
  const slashInside = redactText(String.raw`outer {"a":"{\"password\":\"a\\\\b tail-part\"}", "ok":"kept"}`);
  assert.equal(slashInside.includes("tail-part"), false, slashInside);
  assert.ok(slashInside.includes("kept"), slashInside);
  const unterminated = redactText(String.raw`cut {\"password\":\"tail-part`);
  assert.equal(unterminated.includes("tail-part"), false, unterminated);
  const cut = `cut {"${PW}":"tail-part\\`;
  assert.equal(redactText(cut).includes("tail-part"), false, cut);
});

test("redaction: known secrets of any length, digests kept only under digest keys, shortened after redaction", () => {
  assert.equal(redactText("login failed for hunter2 today", ["hunter2"]).includes("hunter2"), false);
  assert.equal(redactText("x", ["", undefined, null]), "x");
  const hex = "a".repeat(64);
  assert.equal(redact({ sha256: hex }).sha256, hex);
  assert.equal(redact({ reason: hex }).reason, "[redacted]");
  assert.equal(redact({ sha256: hex }, [hex]).sha256, "[redacted]");
  const straddle = redactText(`${"y".repeat(45)}abcdefghij`, ["abcdefghij"], 50);
  assert.equal(straddle.includes("abcde"), false);
  assert.equal(redactError(new Error("token=abc123 failed")).includes("abc123"), false);
  // Unquoted values that begin with or contain a backslash are redacted whole.
  for (const text of [String.raw`password=\hunter2`, String.raw`api_key: \\hunter2`, String.raw`client.secret=a\hunter2`, String.raw`token=\x\hunter2 rest`]) {
    assert.equal(redactText(text).includes("hunter2"), false, text);
  }
  // A short known secret neither cuts a credential value short nor hides a credential name.
  for (const [text, known, leaked] of [["password=abcXYZ", ["abc"], "XYZ"], ["password=XYZabc", ["abc"], "XYZ"], ["password=tail-value", ["pass"], "tail-value"], ["Bearer abcXYZ", ["abc"], "XYZ"], ["api_key: \"aXYZ\"", ["a"], "XYZ"]]) {
    const out = redactText(text, known);
    assert.equal(out.includes(leaked), false, `${text} with ${known} -> ${out}`);
  }
});

test("redaction: URL credentials (user:password@) are stripped wherever a URL appears", () => {
  const secret = "hunter" + "22-x";
  const inputs = [
    `fetch failed for http://user:${secret}@localhost:8790/v1/wardrobe`,
    `origin "https://chris:${secret}@wardrobe.example.app" refused`,
    `{"origin":"http://${secret}@127.0.0.1:8790"}`,
    `postgres://svc:${secret}@db.internal:5432/x and more`,
    `HTTPS://user:${secret}@example.com`,
    `Https://user:${secret}@example.com/x`,
    `https:/user:${secret}@example.com/x`,
    `https:///user:${secret}@example.com/x`,
    `https:\\user:${secret}@example.com/x`,
    `https:user:${secret}@example.com/x`,
    `https:\t//user:${secret}@host.example/x`,
    `https:/\n/user:${secret}@host.example/x`,
    `https: //user:${secret}@host.example/x`,
    `HTTP:\\\\user:${secret}@host.example`,
    `wss://${secret}@socket.example`,
    `error: GET https:///user:${secret}@example.com failed`,
  ];
  for (const input of inputs) {
    const out = redactText(input);
    assert.equal(out.includes(secret), false, out);
    assert.ok(out.includes("[redacted]"), out);
  }
  // The host (after the last @ of the authority) is kept for diagnosis.
  assert.ok(redactText(`https:/user:${secret}@example.com/x`).includes("@example.com/x"));
  // Every credential-carrying form the URL parser accepts is covered: the parser reads a password, redaction removes it.
  for (const form of [`https:/u:${secret}@h.example`, `https:///u:${secret}@h.example`, `https:\t//u:${secret}@h.example`, `https:u:${secret}@h.example`, `https\t://123:${secret}@host.example`, `ht\ntps://u:${secret}@host.example`, `postgres://u:abc\\${secret}@db.example/x`, `error_https://u:${secret}@h.example`]) {
    assert.ok(new URL(form.replace(/^error_/, "")).password.includes(secret), `the parser reads a password in ${JSON.stringify(form)}`);
    assert.equal(redactText(form).includes(secret), false, form);
  }
  assert.equal(JSON.stringify(redact({ origin: `http://u:${secret}@localhost:8790` })).includes(secret), false, "in evidence objects too");
  // A URL without credentials, and an e-mail address, are left alone.
  assert.equal(redactText("see http://127.0.0.1:8790/health"), "see http://127.0.0.1:8790/health");
  assert.equal(redactText("mail chris@example.com"), "mail chris@example.com");
  // Passwords holding a quote, another @, or whitespace (a URL parser accepts them) are removed whole.
  for (const tricky of ["abc'def", "abc@def", 'ab"c', "abc def", "abc\tdef", "abc\ndef"]) {
    const out = redactText(`go http://u:${tricky}@host.example/x`);
    assert.equal(out.includes("abc") || out.includes("def") || out.includes('ab"c'), false, out);
    assert.ok(out.includes("host.example/x"), out);
  }
});

test("redaction: JWTs are removed whole, even with an empty-object payload", () => {
  const header = "eyJhbGciOiJub25lIn0";
  for (const jwt of [`${header}.e30.`, `${header}.e30.c2ln`, `eyJ0eXAiOiJKV1Qi.eyJzdWIiOiJ4In0.sig-part`, Buffer.from('{ "alg": "none" }').toString("base64url") + ".e30."]) {
    const out = redactText(`token ${jwt} end`);
    assert.equal(out.includes("e30") || out.includes(header) || out.includes("sig-part") || out.includes(jwt), false, out);
  }
  // Dotted names that are not JWTs are kept.
  for (const kept of ["api.example.com", "contract 1.1.0", "wardrobe.example.app"]) assert.equal(redactText(kept), kept);
});

test("redaction: credential names with any separator, dots included", () => {
  const s = "short-secret";
  for (const key of ["client.secret", "api.key", "proxy_authorization", "x.api.key", "x_auth_token", "set_cookie", "one.time.code"]) {
    assert.ok(isCredentialKey(key), key);
    assert.equal(redact({ [key]: s })[key], "[redacted]", key);
    assert.equal(redactText(`${key}=${s}`).includes(s), false, key);
  }
});

test("origins: the deployed origin must be a bare https origin", () => {
  assert.equal(deployedOrigin("https://wardrobe.example.app"), "https://wardrobe.example.app");
  assert.equal(deployedOrigin("https://wardrobe.example.app/"), "https://wardrobe.example.app");
  assert.equal(deployedOrigin("https://[::1]"), "https://[::1]");
  assert.equal(deployedOrigin("https://example.com."), "https://example.com.");
  assert.equal(deployedOrigin("https://wardrobe.example.app:8443"), "https://wardrobe.example.app:8443");
  for (const bad of ["https://wardrobe.example.app\n", "https://wardrobe.example.app\t", "HTTPS://wardrobe.example.app", "https://Wardrobe.example.app", "https://wardrobe.example.app:443"]) {
    assert.throws(() => deployedOrigin(bad), /canonical form/, JSON.stringify(bad));
  }
  for (const bad of ["http://wardrobe.example.app", "https://u:p@wardrobe.example.app", "https://tok@wardrobe.example.app", "https://wardrobe.example.app/?token=abc", "https://wardrobe.example.app/x", "https://wardrobe.example.app/#t", "https://@wardrobe.example.app", "https://wardrobe.example.app/?", "https://wardrobe.example.app/#", "https://wardrobe.example.app/private/..", "https://wardrobe.example.app//", " https://wardrobe.example.app", "", null]) {
    assert.throws(() => deployedOrigin(bad), (e) => !String(e.message).includes("abc") && !String(e.message).includes("u:p"), String(bad));
  }
});

test("origins: a local origin must be a bare loopback origin with no userinfo, and evidence never holds URL credentials", () => {
  assert.equal(localOrigin("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(localOrigin("http://localhost:8790/"), "http://localhost:8790");
  assert.equal(localOrigin("http://[::1]:8790"), "http://[::1]:8790");
  assert.equal(localOrigin("http://127.0.0.2:8790"), "http://127.0.0.2:8790");
  assert.equal(localOrigin("http://localhost.:8790"), "http://localhost.:8790");
  for (const bad of ["http://localhost\n", "http://localhost:8790\r\n", "http://[0:0:0:0:0:0:0:1]:8790", "http://LOCALHOST:8790"]) {
    assert.throws(() => localOrigin(bad), /canonical form/, JSON.stringify(bad));
  }
  const pw = PW + "123";
  for (const bad of [`http://user:${pw}@localhost:8790`, `http://${pw}@127.0.0.1:8790`, "http://wardrobe.example.app", "http://127.0.0.1:8790/?k=abc", "http://127.0.0.1:8790/x", "ftp://127.0.0.1", "http://@127.0.0.1:8790", "http://127.0.0.1:8790/?", "http://127.0.0.1:8790#", "http://127.0.0.1:8790/x/..", "", null]) {
    assert.throws(() => localOrigin(bad), (e) => !String(e.message).includes(pw) && !String(e.message).includes("abc"), String(bad));
  }
  assert.equal(originForEvidence(`http://user:${pw}@localhost:8790`), "unrecognised");
  assert.equal(originForEvidence("http://@localhost:8790"), "unrecognised");
  assert.equal(originForEvidence(`https:/user:${pw}@example.com`), "unrecognised");
  assert.equal(originForEvidence(`https:user:${pw}@example.com`), "unrecognised");
  assert.deepEqual(originForEvidence("http://127.0.0.1:8790"), { scheme: "http", host: "127.0.0.1", port: 8790 });
  assert.deepEqual(originForEvidence("https://wardrobe.example.app"), { scheme: "https", host: "wardrobe.example.app", port: null });
  for (const form of [`https:/user:${pw}@example.com`, `https:///user:${pw}@example.com`, `https:user:${pw}@example.com`, `https:\t//user:${pw}@example.com`]) {
    assert.equal(originForEvidence(form), "unrecognised", form);
    assert.throws(() => deployedOrigin(form), /canonical form/, form);
    assert.throws(() => localOrigin(form.replace("example.com", "localhost")), /canonical form/, form);
  }
  assert.equal(originForEvidence("not a url"), "unrecognised");
});
