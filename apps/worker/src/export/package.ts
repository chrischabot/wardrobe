import { Zip, ZipDeflate, ZipPassThrough, unzipSync } from "fflate";
import { PACKAGE_FRAME_BYTES, PackageEncryptor, sha256Hex, toHex } from "../crypto.ts";

/**
 * The portable package: one ZIP file (optionally passphrase-encrypted), written as a stream so a
 * wardrobe with many photographs never has to fit in memory. Bytes go to R2 through a multipart
 * upload; the package's own SHA-256 is computed over exactly the bytes stored.
 */
const PART_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

export interface PackageFile {
  path: string;
  bytes: number;
  sha256: string;
}

class ChunkBuffer {
  private chunks: Uint8Array[] = [];
  size = 0;
  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.size += chunk.length;
  }
  /** Remove and return exactly `n` bytes (n <= size). */
  take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const head = this.chunks[0]!;
      const need = n - at;
      if (head.length <= need) {
        out.set(head, at);
        at += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), at);
        this.chunks[0] = head.subarray(need);
        at += need;
      }
    }
    this.size -= n;
    return out;
  }
}

/** Uniform-part multipart upload to R2 with a running digest of everything written. */
class R2Sink {
  private readonly buffer = new ChunkBuffer();
  private readonly parts: R2UploadedPart[] = [];
  private readonly digest = new crypto.DigestStream("SHA-256");
  private readonly digestWriter = this.digest.getWriter();
  private total = 0;

  private constructor(private readonly upload: R2MultipartUpload) {}

  static async open(bucket: R2Bucket, key: string, contentType: string, metadata: Record<string, string>): Promise<R2Sink> {
    return new R2Sink(await bucket.createMultipartUpload(key, { httpMetadata: { contentType }, customMetadata: metadata }));
  }

  async write(chunk: Uint8Array): Promise<void> {
    this.buffer.push(chunk);
    while (this.buffer.size >= PART_BYTES) await this.flush(this.buffer.take(PART_BYTES));
  }

  private async flush(part: Uint8Array): Promise<void> {
    await this.digestWriter.write(part);
    this.total += part.length;
    this.parts.push(await this.upload.uploadPart(this.parts.length + 1, part));
  }

  async close(): Promise<{ bytes: number; sha256: string }> {
    if (this.buffer.size > 0 || this.parts.length === 0) await this.flush(this.buffer.take(this.buffer.size));
    await this.upload.complete(this.parts);
    await this.digestWriter.close();
    return { bytes: this.total, sha256: toHex(await this.digest.digest) };
  }

  async abort(): Promise<void> {
    await this.upload.abort().catch(() => undefined);
  }
}

/** Frames plaintext into authenticated encrypted frames before it reaches the sink. */
class EncryptingSink {
  private readonly buffer = new ChunkBuffer();
  private headerWritten = false;
  constructor(
    private readonly inner: R2Sink,
    private readonly encryptor: PackageEncryptor,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.headerWritten) {
      await this.inner.write(this.encryptor.header);
      this.headerWritten = true;
    }
    this.buffer.push(chunk);
    // Always keep at least one byte back so the last frame can carry the final flag.
    while (this.buffer.size > PACKAGE_FRAME_BYTES) await this.inner.write(await this.encryptor.frame(this.buffer.take(PACKAGE_FRAME_BYTES), false));
  }

  async close(): Promise<{ bytes: number; sha256: string }> {
    if (!this.headerWritten) await this.inner.write(this.encryptor.header);
    await this.inner.write(await this.encryptor.frame(this.buffer.take(this.buffer.size), true));
    return this.inner.close();
  }

  abort(): Promise<void> {
    return this.inner.abort();
  }
}

export class PackageWriter {
  private readonly zip: Zip;
  private pending: Uint8Array[] = [];
  private failure: Error | null = null;
  readonly files: PackageFile[] = [];

  private constructor(private readonly sink: R2Sink | EncryptingSink) {
    this.zip = new Zip((error, chunk) => {
      if (error) this.failure = error;
      else this.pending.push(chunk);
    });
  }

  static async open(bucket: R2Bucket, key: string, opts: { passphrase?: string; metadata: Record<string, string> }): Promise<PackageWriter> {
    const r2 = await R2Sink.open(bucket, key, opts.passphrase ? "application/octet-stream" : "application/zip", opts.metadata);
    return new PackageWriter(opts.passphrase ? new EncryptingSink(r2, await PackageEncryptor.create(opts.passphrase)) : r2);
  }

  private async drain(): Promise<void> {
    if (this.failure) throw this.failure;
    const chunks = this.pending;
    this.pending = [];
    for (const chunk of chunks) await this.sink.write(chunk);
  }

  /** Add one file. Text is compressed; already-compressed media is stored as is. Returns its checksum entry. */
  async add(path: string, data: Uint8Array | string, opts: { store?: boolean } = {}): Promise<PackageFile> {
    if (this.files.some((f) => f.path === path)) throw new Error(`duplicate package path ${path}`);
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    const entry = opts.store ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
    this.zip.add(entry);
    entry.push(bytes, true);
    await this.drain();
    const file = { path, bytes: bytes.length, sha256: await sha256Hex(bytes) };
    this.files.push(file);
    return file;
  }

  async close(): Promise<{ bytes: number; sha256: string }> {
    this.zip.end();
    await this.drain();
    return this.sink.close();
  }

  abort(): Promise<void> {
    return this.sink.abort();
  }
}

/** Read a (decrypted) package into its files. Paths are checked: no absolute paths, no traversal. */
export function readPackage(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = unzipSync(bytes);
  const files = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(entries)) {
    if (path.endsWith("/")) continue;
    if (path.startsWith("/") || path.includes("\\") || path.split("/").some((s) => s === ".." || s === "." || s === "")) throw new Error(`unsafe path in package: ${path.slice(0, 80)}`);
    files.set(path, data);
  }
  return files;
}
