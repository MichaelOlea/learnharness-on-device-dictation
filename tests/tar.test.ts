import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TarReader, type TarSink } from "../src/tar.ts";

function archive(build: (root: string) => void, args: string[] = []): Buffer {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "odd-tar-"));
  try {
    build(root);
    return execFileSync("tar", ["-cf", "-", ...args, "-C", root, "."], { maxBuffer: 1 << 28 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function read(data: Buffer, chunk: number, wanted?: (name: string) => boolean): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const reader = new TarReader((name, size): TarSink | undefined => {
    if (wanted && !wanted(name)) return undefined;
    const parts: Buffer[] = [];
    return { write: piece => parts.push(Buffer.from(piece)), end: () => { const body = Buffer.concat(parts); assert.equal(body.length, size); files.set(name, body); } };
  });
  for (let offset = 0; offset < data.length; offset += chunk) reader.push(data.subarray(offset, offset + chunk));
  reader.end();
  return files;
}

test("reads regular files at any chunking, including long names", () => {
  const long = `${"deep/".repeat(30)}${"n".repeat(120)}.bin`;
  const big = Buffer.alloc(70_001, 7);
  const data = archive(root => {
    fs.mkdirSync(path.join(root, "pkg"));
    fs.writeFileSync(path.join(root, "pkg/a.txt"), "alpha");
    fs.writeFileSync(path.join(root, "pkg/empty"), "");
    fs.writeFileSync(path.join(root, "pkg/big.bin"), big);
    fs.mkdirSync(path.dirname(path.join(root, long)), { recursive: true });
    fs.writeFileSync(path.join(root, long), "long");
    fs.symlinkSync("/etc/passwd", path.join(root, "pkg/link"));
  });
  for (const chunk of [1, 7, 511, 512, 513, 4096, data.length]) {
    const files = read(data, chunk);
    assert.equal(files.get("./pkg/a.txt")?.toString(), "alpha");
    assert.equal(files.get("./pkg/empty")?.length, 0);
    assert.ok(files.get("./pkg/big.bin")?.equals(big));
    assert.equal(files.get(`./${long}`)?.toString(), "long");
    assert.equal(files.has("./pkg/link"), false, "links are never offered to the consumer");
  }
});

test("understands pax path records", () => {
  const long = `${"p".repeat(180)}/file.txt`;
  const data = archive(root => {
    fs.mkdirSync(path.dirname(path.join(root, long)), { recursive: true });
    fs.writeFileSync(path.join(root, long), "pax");
  }, ["--format=pax"]);
  assert.equal(read(data, 1000).get(`./${long}`)?.toString(), "pax");
});

test("skipped entries cost nothing and the consumer picks by name", () => {
  const data = archive(root => { fs.writeFileSync(path.join(root, "keep"), "k"); fs.writeFileSync(path.join(root, "drop"), "d".repeat(5000)); });
  assert.deepEqual([...read(data, 300, name => name === "./keep").keys()], ["./keep"]);
});

test("rejects damaged and truncated archives", () => {
  const data = archive(root => fs.writeFileSync(path.join(root, "file"), "x".repeat(3000)));
  const damaged = Buffer.from(data);
  damaged[0] = damaged[0]! ^ 0xff;
  assert.throws(() => read(damaged, 512), /checksum/);
  assert.throws(() => read(data.subarray(0, 1024), 512), /truncated/);
});
