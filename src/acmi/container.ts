import { Inflate } from "fflate";

/**
 * Detect the container (zip / 7z / plain text) from magic bytes, never from the file name,
 * and stream the decompressed ACMI text bytes to `sink`.
 *
 * Zip handling reads the first entry's local header and inflates its data directly, without
 * relying on the sizes in the header or on the central directory at the end of the archive.
 * That matters because real recordings exist where the zip write was interrupted: the local header
 * says size 0, the central directory is missing, but the compressed data is there (14 files in
 * the sample corpus). Those are recovered and flagged as `incomplete`.
 */

export type ContainerKind = "zip" | "plain" | "7z" | "gzip" | "empty" | "unknown";

export interface ContainerInfo {
  kind: ContainerKind;
  /** Name of the zip entry that was read, if any. */
  entryName?: string;
  /**
   * The zip archive was not finished: sizes missing from the header, and/or the compressed
   * stream ends early. Everything that could be decompressed was delivered.
   */
  incomplete?: boolean;
}

export class UnsupportedContainerError extends Error {}

export function detectContainer(head: Uint8Array): ContainerKind {
  if (head.length === 0) return "empty";
  const b = (i: number) => head[i] ?? -1;
  if (b(0) === 0x50 && b(1) === 0x4b && b(2) === 0x03 && b(3) === 0x04) return "zip";
  if (b(0) === 0x37 && b(1) === 0x7a && b(2) === 0xbc && b(3) === 0xaf && b(4) === 0x27 && b(5) === 0x1c)
    return "7z";
  if (b(0) === 0x1f && b(1) === 0x8b) return "gzip";
  // Plain text: optional UTF-8 BOM, then "FileType=".
  const off = b(0) === 0xef && b(1) === 0xbb && b(2) === 0xbf ? 3 : 0;
  const sig = "FileType=";
  let ok = head.length >= off + 1;
  for (let i = 0; i < sig.length && off + i < head.length; i++) {
    if (head[off + i] !== sig.charCodeAt(i)) ok = false;
  }
  return ok ? "plain" : "unknown";
}

/** Pulls bytes from an async iterable, with a small look-ahead buffer for header parsing. */
class ByteReader {
  private readonly iter: AsyncIterator<Uint8Array>;
  private buf = new Uint8Array(0);
  done = false;
  consumed = 0;
  private readonly onRead?: (rawBytes: number) => void;

  constructor(source: AsyncIterable<Uint8Array>, onRead?: (rawBytes: number) => void) {
    this.iter = source[Symbol.asyncIterator]();
    this.onRead = onRead;
  }

  /** Ensure at least n bytes are buffered (fewer only at end of input). */
  async fill(n: number): Promise<Uint8Array> {
    while (this.buf.length < n && !this.done) {
      const r = await this.iter.next();
      if (r.done) {
        this.done = true;
        break;
      }
      this.consumed += r.value.length;
      this.onRead?.(this.consumed);
      if (r.value.length === 0) continue;
      const next = new Uint8Array(this.buf.length + r.value.length);
      next.set(this.buf);
      next.set(r.value, this.buf.length);
      this.buf = next;
    }
    return this.buf;
  }

  /** Drop n bytes from the front of the buffer. */
  skip(n: number): void {
    this.buf = this.buf.subarray(n);
  }

  /** Yield the buffered bytes, then the rest of the input, chunk by chunk. */
  async *rest(): AsyncIterable<Uint8Array> {
    if (this.buf.length) {
      const b = this.buf;
      this.buf = new Uint8Array(0);
      yield b;
    }
    while (!this.done) {
      const r = await this.iter.next();
      if (r.done) {
        this.done = true;
        return;
      }
      this.consumed += r.value.length;
      this.onRead?.(this.consumed);
      if (r.value.length) yield r.value;
    }
  }
}

const HEAD_BYTES = 16;
const u16 = (b: Uint8Array, o: number) => (b[o] as number) | ((b[o + 1] as number) << 8);
const u32 = (b: Uint8Array, o: number) => (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0;

/**
 * Read `source` and forward decompressed text bytes to `sink`.
 * `onRead` reports how many raw (compressed) bytes have been consumed, for progress display.
 */
export async function streamAcmiBytes(
  source: AsyncIterable<Uint8Array>,
  sink: (bytes: Uint8Array) => void,
  onRead?: (rawBytes: number) => void,
): Promise<ContainerInfo> {
  const reader = new ByteReader(source, onRead);
  const kind = detectContainer(await reader.fill(HEAD_BYTES));

  if (kind === "empty") throw new UnsupportedContainerError("The file is empty (0 bytes).");
  if (kind === "7z")
    throw new UnsupportedContainerError("7z-compressed ACMI files are not supported yet. Unzip it first.");
  if (kind === "gzip") throw new UnsupportedContainerError("gzip-compressed files are not supported yet.");
  if (kind === "unknown")
    throw new UnsupportedContainerError(
      "This does not look like an ACMI file (no zip signature and no 'FileType=' header).",
    );

  if (kind === "plain") {
    for await (const chunk of reader.rest()) sink(chunk);
    return { kind };
  }
  return readZipFirstEntry(reader, sink);
}

async function readZipFirstEntry(
  reader: ByteReader,
  sink: (bytes: Uint8Array) => void,
): Promise<ContainerInfo> {
  // Local file header: see APPNOTE.TXT 4.3.7.
  let h = await reader.fill(30);
  if (h.length < 30)
    throw new UnsupportedContainerError("The zip archive is cut off inside its first header.");
  const flags = u16(h, 6);
  const method = u16(h, 8);
  const compSize = u32(h, 18);
  const rawSize = u32(h, 22);
  const nameLen = u16(h, 26);
  const extraLen = u16(h, 28);
  h = await reader.fill(30 + nameLen + extraLen);
  if (h.length < 30 + nameLen + extraLen)
    throw new UnsupportedContainerError("The zip archive is cut off inside its first header.");
  const entryName = decodeZipName(h.subarray(30, 30 + nameLen), (flags & 0x800) !== 0);
  reader.skip(30 + nameLen + extraLen);

  if (flags & 0x1) throw new UnsupportedContainerError("Encrypted zip archives are not supported.");
  const hasDescriptor = (flags & 0x8) !== 0;
  // Sizes are legitimately 0 when a data descriptor follows; otherwise 0 means the write was interrupted.
  const sizesMissing = !hasDescriptor && compSize === 0 && rawSize === 0;

  if (method === 0) {
    if (hasDescriptor || compSize === 0xffffffff)
      throw new UnsupportedContainerError("This uncompressed (stored) zip layout is not supported.");
    let left = compSize;
    for await (const chunk of reader.rest()) {
      if (left <= 0) break;
      const part = chunk.length > left ? chunk.subarray(0, left) : chunk;
      sink(part);
      left -= part.length;
    }
    return { kind: "zip", entryName, incomplete: left > 0 || undefined };
  }
  if (method !== 8)
    throw new UnsupportedContainerError(`Zip compression method ${method} is not supported (only deflate).`);

  // Raw deflate. fflate ignores bytes after the end of the deflate stream (data descriptor,
  // central directory), and only throws "unexpected EOF" on the final push if the stream was cut off.
  let produced = 0;
  const inflate = new Inflate((data) => {
    if (data.length) {
      produced += data.length;
      sink(data);
    }
  });
  for await (const chunk of reader.rest()) inflate.push(chunk, false);
  let streamCutOff = false;
  try {
    inflate.push(new Uint8Array(0), true);
  } catch (err) {
    if (err instanceof Error && err.message === "unexpected EOF") streamCutOff = true;
    else throw new UnsupportedContainerError(`The zip data is corrupt (${String(err)}).`);
  }
  if (produced === 0)
    throw new UnsupportedContainerError(
      sizesMissing || streamCutOff
        ? "The zip archive is incomplete and contains no recoverable data."
        : "The zip archive's first entry is empty.",
    );
  const incomplete = sizesMissing || streamCutOff;
  return incomplete ? { kind: "zip", entryName, incomplete } : { kind: "zip", entryName };
}

function decodeZipName(bytes: Uint8Array, utf8Flag: boolean): string {
  // Tacview writes UTF-8 names without setting the UTF-8 flag, so try UTF-8 first either way.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    if (utf8Flag) return new TextDecoder("utf-8").decode(bytes);
    return String.fromCharCode(...bytes); // Latin-1 approximation of the legacy CP437 encoding
  }
}

/** Adapt a web ReadableStream to an async iterable (not all browsers support async iteration natively). */
export async function* readableToIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
