import { Unzip, UnzipInflate, UnzipPassThrough, Zip, ZipDeflate, ZipPassThrough, unzipSync } from "fflate";
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
  private uncompressedBytes = 0;
  private compressedBytes = 0;
  readonly files: PackageFile[] = [];

  private constructor(private readonly sink: R2Sink | EncryptingSink) {
    this.zip = new Zip((error, chunk) => {
      if (error) this.failure = error;
      else {
        this.compressedBytes += chunk.length;
        if (this.compressedBytes > PACKAGE_LIMITS.compressedBytes) {
          this.failure = new PackageTooLargeError(`the package archive is larger than ${PACKAGE_LIMITS.compressedBytes / 1024 / 1024} MB`);
        } else {
          this.pending.push(chunk);
        }
      }
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
    if (this.files.length >= PACKAGE_LIMITS.entries) throw new PackageTooLargeError(`the package holds more than ${PACKAGE_LIMITS.entries} files`);
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    if (bytes.length > PACKAGE_LIMITS.entryBytes) throw new PackageTooLargeError(`a file in the package is larger than ${PACKAGE_LIMITS.entryBytes / 1024 / 1024} MB`);
    if (this.uncompressedBytes + bytes.length > PACKAGE_LIMITS.totalBytes) throw new PackageTooLargeError(`the package inflates to more than ${PACKAGE_LIMITS.totalBytes / 1024 / 1024} MB`);
    this.uncompressedBytes += bytes.length;
    const entry = opts.store ? new ZipPassThrough(path) : new ZipDeflate(path, { level: 6 });
    this.zip.add(entry);
    entry.push(bytes, true);
    await this.drain();
    const file = { path, bytes: bytes.length, sha256: await sha256Hex(bytes) };
    this.files.push(file);
    return file;
  }

  async close(): Promise<{ bytes: number; sha256: string }> {
    if (this.files.length > PACKAGE_LIMITS.entries) throw new PackageTooLargeError(`the package holds more than ${PACKAGE_LIMITS.entries} files`);
    this.zip.end();
    await this.drain();
    if (this.compressedBytes > PACKAGE_LIMITS.compressedBytes) {
      throw new PackageTooLargeError(`the package archive is larger than ${PACKAGE_LIMITS.compressedBytes / 1024 / 1024} MB`);
    }
    return this.sink.close();
  }

  abort(): Promise<void> {
    return this.sink.abort();
  }
}

/**
 * Bounds on what a package may inflate to, sized so that the input archive and the decompressed files fit
 * within a Cloudflare Worker's 128 MB isolate memory budget. An export of the largest wardrobe this service
 * holds is far inside them; a package that declares or inflates to more is refused.
 */
export const PACKAGE_LIMITS = { compressedBytes: 48 * 1024 * 1024, entryBytes: 24 * 1024 * 1024, totalBytes: 48 * 1024 * 1024, entries: 10_000 } as const;

export class PackageTooLargeError extends Error {}

/** Read a (decrypted) package into its files. Paths are checked: no absolute paths, no traversal. */
export function readPackage(bytes: Uint8Array): Map<string, Uint8Array> {
  if (bytes.byteLength > PACKAGE_LIMITS.compressedBytes) {
    throw new PackageTooLargeError(`the package archive is larger than ${PACKAGE_LIMITS.compressedBytes / 1024 / 1024} MB`);
  }
  let declaredTotal = 0;
  let count = 0;
  const seen = new Set<string>();
  const declared = new Map<string, number>();
  // First check the Central Directory without inflating: bounds entry count, duplicate names and declared sizes.
  unzipSync(bytes, {
    filter: (file) => {
      count += 1;
      if (seen.has(file.name)) throw new Error(`the package holds the path ${JSON.stringify(file.name)} more than once`);
      seen.add(file.name);
      declared.set(file.name, file.originalSize);
      if (count > PACKAGE_LIMITS.entries) throw new PackageTooLargeError(`the package holds more than ${PACKAGE_LIMITS.entries} files`);
      if (file.originalSize > PACKAGE_LIMITS.entryBytes) throw new PackageTooLargeError(`a file in the package is larger than ${PACKAGE_LIMITS.entryBytes / 1024 / 1024} MB`);
      declaredTotal += file.originalSize;
      if (declaredTotal > PACKAGE_LIMITS.totalBytes) throw new PackageTooLargeError(`the package inflates to more than ${PACKAGE_LIMITS.totalBytes / 1024 / 1024} MB`);
      return false;
    },
  });
  // Then inflate each entry through streaming Unzip + UnzipInflate in bounded compressed slices, writing
  // directly into each entry's single output buffer so chunks and concatenated output are never held together.
  const files = new Map<string, Uint8Array>();
  const seenLocal = new Set<string>();
  const finishedLocal = new Set<string>();
  let actualTotal = 0;
  const unzip = new Unzip((file) => {
    const path = file.name;
    if (seenLocal.has(path)) throw new Error(`the package holds the path ${JSON.stringify(path)} more than once`);
    seenLocal.add(path);
    const expectedSize = declared.get(path);
    if (expectedSize === undefined) throw new Error(`the package holds an entry not listed in its central directory: ${path.slice(0, 80)}`);
    if (!path.endsWith("/")) {
      if (path.startsWith("/") || path.includes("\\") || path.split("/").some((s) => s === ".." || s === "." || s === "")) {
        throw new Error(`unsafe path in package: ${path.slice(0, 80)}`);
      }
    }
    const out = path.endsWith("/" ) ? null : new Uint8Array(expectedSize);
    let entryActual = 0;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      const offset = entryActual;
      entryActual += chunk.length;
      actualTotal += chunk.length;
      if (entryActual > PACKAGE_LIMITS.entryBytes) throw new PackageTooLargeError(`a file in the package is larger than ${PACKAGE_LIMITS.entryBytes / 1024 / 1024} MB`);
      if (actualTotal > PACKAGE_LIMITS.totalBytes) throw new PackageTooLargeError(`the package inflates to more than ${PACKAGE_LIMITS.totalBytes / 1024 / 1024} MB`);
      if (entryActual > expectedSize) throw new PackageTooLargeError(`a file in the package does not have the size it declares: ${path.slice(0, 80)}`);
      if (out && chunk.length > 0) out.set(chunk, offset);
      if (final) {
        if (entryActual !== expectedSize) throw new PackageTooLargeError(`a file in the package does not have the size it declares: ${path.slice(0, 80)}`);
        finishedLocal.add(path);
        if (out) files.set(path, out);
      }
    };
    file.start();
  });
  unzip.register(UnzipPassThrough);
  unzip.register(UnzipInflate);
  const SLICE_BYTES = 4096;
  for (let offset = 0; offset < bytes.length; offset += SLICE_BYTES) {
    const end = Math.min(offset + SLICE_BYTES, bytes.length);
    unzip.push(bytes.subarray(offset, end), end === bytes.length);
  }
  if (bytes.length === 0) unzip.push(bytes, true);
  if (finishedLocal.size !== declared.size) throw new Error("the package ended before every declared file finished decompressing");
  return files;
}
