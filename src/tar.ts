/** Minimal streaming tar reader for the two pinned package formats we install.
 * It never creates paths itself: the consumer decides, per regular file, whether
 * to receive its bytes. Links, devices and every other entry type are skipped. */

export interface TarSink {
  write(chunk: Buffer): void;
  end(): void;
}
/** Return a sink to receive a regular file's bytes, or undefined to skip it. */
export type TarEntryHandler = (name: string, size: number) => TarSink | undefined;

const BLOCK = 512;

function field(block: Buffer, start: number, length: number): string {
  let end = start;
  const limit = start + length;
  while (end < limit && block[end] !== 0) end++;
  return block.toString("utf8", start, end);
}
function size(block: Buffer): number {
  const first = block[124]!;
  if (first & 0x80) {
    // GNU base-256 encoding for sizes that do not fit eleven octal digits.
    let value = 0;
    for (let index = 125; index < 136; index++) value = value * 256 + block[index]!;
    if (!Number.isSafeInteger(value)) throw new Error("Tar entry is too large.");
    return value;
  }
  const text = field(block, 124, 12).trim();
  if (!/^[0-7]*$/.test(text)) throw new Error("Tar entry has an invalid size.");
  return text ? parseInt(text, 8) : 0;
}
function checksumMatches(block: Buffer): boolean {
  const stored = parseInt(field(block, 148, 8).trim() || "0", 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 32 : block[index]!;
  return sum === stored;
}
/** Extract `path=` from a pax extended header: records are "<len> key=value\n". */
function paxPath(data: Buffer): string | undefined {
  let offset = 0;
  let found: string | undefined;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0) break;
    const length = Number(data.toString("ascii", offset, space));
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) break;
    const record = data.toString("utf8", space + 1, offset + length - 1);
    if (record.startsWith("path=")) found = record.slice(5);
    offset += length;
  }
  return found;
}

export class TarReader {
  private pending: Buffer = Buffer.alloc(0);
  /** Bytes of the current entry's data still to arrive, then its block padding. */
  private remaining = 0;
  private padding = 0;
  private sink: TarSink | undefined;
  /** Collects the body of a long-name or pax header that describes the next entry. */
  private meta: { kind: "L" | "x"; parts: Buffer[] } | undefined;
  private overrideName: string | undefined;
  private zeroBlocks = 0;
  private finished = false;

  constructor(private readonly onEntry: TarEntryHandler) {}

  get ended(): boolean { return this.finished; }

  push(chunk: Buffer): void {
    if (this.finished) return; // trailing padding after the end-of-archive marker
    let data = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    this.pending = Buffer.alloc(0);
    while (data.length) {
      if (this.remaining > 0) {
        const take = Math.min(this.remaining, data.length);
        const piece = data.subarray(0, take);
        if (this.meta) this.meta.parts.push(Buffer.from(piece));
        else this.sink?.write(piece);
        this.remaining -= take;
        data = data.subarray(take);
        if (this.remaining === 0) this.finishEntry();
        continue;
      }
      if (this.padding > 0) {
        const skip = Math.min(this.padding, data.length);
        this.padding -= skip;
        data = data.subarray(skip);
        continue;
      }
      if (data.length < BLOCK) break;
      const block = data.subarray(0, BLOCK);
      data = data.subarray(BLOCK);
      if (block.every(byte => byte === 0)) {
        if (++this.zeroBlocks >= 2) { this.finished = true; return; }
        continue;
      }
      this.zeroBlocks = 0;
      this.header(block);
    }
    if (data.length) this.pending = Buffer.from(data);
  }

  /** Call once the input is exhausted; a truncated archive is an error. */
  end(): void {
    if (this.remaining > 0 || this.padding > 0 || this.pending.length) throw new Error("Tar archive is truncated.");
  }

  private header(block: Buffer): void {
    if (!checksumMatches(block)) throw new Error("Tar header checksum mismatch.");
    const bytes = size(block);
    const type = String.fromCharCode(block[156]!);
    this.remaining = bytes;
    this.padding = (BLOCK - (bytes % BLOCK)) % BLOCK;
    if (type === "L" || type === "x") {
      if (bytes > 1 << 20) throw new Error("Tar metadata entry is too large.");
      this.meta = { kind: type, parts: [] };
    } else if (type === "g") {
      this.sink = undefined; // global pax header: irrelevant here
    } else {
      const prefix = field(block, 257, 5) === "ustar" ? field(block, 345, 155) : "";
      const plain = field(block, 0, 100);
      const name = this.overrideName ?? (prefix ? `${prefix}/${plain}` : plain);
      this.overrideName = undefined;
      this.sink = type === "0" || type === "\0" ? this.onEntry(name, bytes) : undefined;
    }
    if (bytes === 0) this.finishEntry();
  }

  private finishEntry(): void {
    if (this.meta) {
      const body = Buffer.concat(this.meta.parts);
      if (this.meta.kind === "L") {
        let end = body.indexOf(0);
        if (end < 0) end = body.length;
        this.overrideName = body.toString("utf8", 0, end);
      } else {
        this.overrideName = paxPath(body) ?? this.overrideName;
      }
      this.meta = undefined;
      return;
    }
    const sink = this.sink;
    this.sink = undefined;
    sink?.end();
  }
}
