/**
 * Cryptographic helpers. Everything here is WebCrypto (the platform's established implementation):
 * no hand-written primitives.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function toHex(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < view.length; i++) out += view[i]!.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** A URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Crockford base32 (no padding), readable and unambiguous when written down. */
export function toBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

async function hmacKey(secret: string, usage: ("sign" | "verify")[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usage);
}

/**
 * Keyed hash of a high-entropy one-time code (invitation, link code, ticket, OAuth state). The database
 * stores only this value; the purpose string separates the domains.
 */
export async function codeHash(secret: string, purpose: string, code: string): Promise<string> {
  const key = await hmacKey(secret, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${purpose}\u0000${code}`)));
}

/** Constant-time comparison of two hex/base64 strings of equal length. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

export const RECOVERY_KDF = "pbkdf2-sha256-100000";

/** PBKDF2-SHA-256 verifier of the recovery credential (per-credential random salt). */
export async function recoveryVerifier(code: string, saltB64: string): Promise<string> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(code), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(saltB64) as BufferSource, iterations: 100_000 }, material, 256);
  return toBase64Url(bits);
}

/* ------------------------------------------------------------------ */
/* AES-256-GCM sealing of third-party credentials                       */
/* ------------------------------------------------------------------ */

async function aesKey(keyB64: string): Promise<CryptoKey> {
  const raw = fromBase64Url(keyB64.trim());
  if (raw.length !== 32) throw new Error("configuration error: CREDENTIAL_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface Sealed {
  ciphertext: string;
  iv: string;
  keyVersion: string;
}

/** Encrypt a JSON value. `aad` binds the ciphertext to its row (owner and reference) so it cannot be moved. */
export async function seal(keyB64: string, value: unknown, aad: string): Promise<Sealed> {
  const iv = randomBytes(12);
  const key = await aesKey(keyB64);
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: encoder.encode(aad) }, key, encoder.encode(JSON.stringify(value)));
  return { ciphertext: toBase64Url(data), iv: toBase64Url(iv), keyVersion: (await sha256Hex(`key-id\u0000${keyB64.trim()}`)).slice(0, 12) };
}

export async function unseal<T>(keyB64: string, sealed: { ciphertext: string; iv: string }, aad: string): Promise<T> {
  const key = await aesKey(keyB64);
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(sealed.iv) as BufferSource, additionalData: encoder.encode(aad) }, key, fromBase64Url(sealed.ciphertext) as BufferSource);
  return JSON.parse(decoder.decode(data)) as T;
}

/* ------------------------------------------------------------------ */
/* Passphrase encryption of an export package (framed, streamable)      */
/* ------------------------------------------------------------------ */

/*
 * Layout: magic (14 ASCII bytes) | salt (16) | nonce prefix (8) | frames.
 * Frame: ciphertext length (uint32 BE) | final flag (1 byte) | AES-256-GCM ciphertext with tag.
 * Frame i uses nonce = prefix || uint32(i) and authenticates (magic, i, final flag), so frames cannot be
 * reordered, dropped or truncated without detection. Key: PBKDF2-SHA-256, 100,000 iterations.
 */
export const PACKAGE_MAGIC = "GARDEROBE-ENC1";
const PACKAGE_ITERATIONS = 100_000;
export const PACKAGE_FRAME_BYTES = 1024 * 1024;
const MAGIC_BYTES = encoder.encode(PACKAGE_MAGIC);

async function passphraseKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PACKAGE_ITERATIONS }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

function frameNonce(prefix: Uint8Array, index: number): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setUint32(8, index, false);
  return nonce;
}

function frameAad(index: number, final: boolean): Uint8Array {
  const aad = new Uint8Array(MAGIC_BYTES.length + 5);
  aad.set(MAGIC_BYTES, 0);
  new DataView(aad.buffer).setUint32(MAGIC_BYTES.length, index, false);
  aad[MAGIC_BYTES.length + 4] = final ? 1 : 0;
  return aad;
}

/** Incremental encryptor: feed plaintext, receive header and frames. The passphrase is used once to derive the key. */
export class PackageEncryptor {
  private index = 0;
  private constructor(
    private readonly key: CryptoKey,
    private readonly prefix: Uint8Array,
    readonly header: Uint8Array,
  ) {}

  static async create(passphrase: string): Promise<PackageEncryptor> {
    const salt = randomBytes(16);
    const prefix = randomBytes(8);
    const header = new Uint8Array(MAGIC_BYTES.length + 24);
    header.set(MAGIC_BYTES, 0);
    header.set(salt, MAGIC_BYTES.length);
    header.set(prefix, MAGIC_BYTES.length + 16);
    return new PackageEncryptor(await passphraseKey(passphrase, salt), prefix, header);
  }

  async frame(plain: Uint8Array, final: boolean): Promise<Uint8Array> {
    const index = this.index++;
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: frameNonce(this.prefix, index) as BufferSource, additionalData: frameAad(index, final) as BufferSource }, this.key, plain as BufferSource));
    const out = new Uint8Array(5 + cipher.length);
    new DataView(out.buffer).setUint32(0, cipher.length, false);
    out[4] = final ? 1 : 0;
    out.set(cipher, 5);
    return out;
  }
}

export function isEncryptedPackage(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC_BYTES.length + 24) return false;
  for (let i = 0; i < MAGIC_BYTES.length; i++) if (bytes[i] !== MAGIC_BYTES[i]) return false;
  return true;
}

/** Throws when the passphrase is wrong or the package was modified, truncated or reordered. */
export async function decryptPackage(passphrase: string, bytes: Uint8Array): Promise<Uint8Array> {
  const salt = bytes.slice(MAGIC_BYTES.length, MAGIC_BYTES.length + 16);
  const prefix = bytes.slice(MAGIC_BYTES.length + 16, MAGIC_BYTES.length + 24);
  const key = await passphraseKey(passphrase, salt);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let offset = MAGIC_BYTES.length + 24;
  let index = 0;
  let sawFinal = false;
  while (offset < bytes.length) {
    if (sawFinal || offset + 5 > bytes.length) throw new Error("malformed encrypted package");
    const length = view.getUint32(offset, false);
    const final = bytes[offset + 4] === 1;
    const start = offset + 5;
    if (start + length > bytes.length) throw new Error("truncated encrypted package");
    parts.push(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: frameNonce(prefix, index) as BufferSource, additionalData: frameAad(index, final) as BufferSource }, key, bytes.subarray(start, start + length) as BufferSource)));
    sawFinal = final;
    offset = start + length;
    index++;
  }
  if (!sawFinal) throw new Error("truncated encrypted package");
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
