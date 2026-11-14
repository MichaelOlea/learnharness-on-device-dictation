import assert from "node:assert/strict";
import test from "node:test";
import { Downsampler, toPcm16 } from "../src/capture.ts";

function tone(rate: number, hertz: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(rate * seconds));
  for (let index = 0; index < samples.length; index++) samples[index] = 0.5 * Math.sin((2 * Math.PI * hertz * index) / rate);
  return samples;
}
function crossings(samples: Float32Array): number {
  let count = 0;
  for (let index = 1; index < samples.length; index++) if ((samples[index - 1]! < 0) !== (samples[index]! < 0)) count++;
  return count;
}

for (const rate of [48_000, 44_100, 22_050, 96_000]) {
  test(`downsamples ${rate} Hz to 16 kHz with the right length and pitch`, () => {
    const input = tone(rate, 440, 2);
    for (const block of [128, 1024, 4096, 441]) {
      const sampler = new Downsampler(rate);
      const parts: Float32Array[] = [];
      for (let offset = 0; offset < input.length; offset += block) parts.push(sampler.process(input.subarray(offset, offset + block)).slice());
      const output = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) { output.set(part, offset); offset += part.length; }
      assert.ok(Math.abs(output.length - 32_000) <= 2, `${output.length} samples for block ${block}`);
      // 440 Hz for two seconds crosses zero 1760 times regardless of rate.
      assert.ok(Math.abs(crossings(output) - 1760) <= 4, `${crossings(output)} crossings`);
      assert.ok(Math.max(...output) > 0.4 && Math.max(...output) <= 0.5001);
    }
  });
}

test("refuses to upsample", () => {
  assert.throws(() => new Downsampler(8_000));
  assert.throws(() => new Downsampler(16_000));
});

test("converts to 16-bit PCM with clipping and a usable level", () => {
  const { pcm, level } = toPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5]));
  assert.deepEqual([...pcm], [0, 32767, -32768, 32767, -32768, 16383]);
  assert.ok(level > 0.9 && level <= 1);
  assert.equal(toPcm16(new Float32Array(160)).level, 0);
  assert.equal(toPcm16(new Float32Array(0)).pcm.length, 0);
  const quiet = toPcm16(tone(16_000, 300, 0.1).map(value => value * 0.05)).level;
  assert.ok(quiet > 0.1 && quiet < 0.5, `quiet speech still moves the meter (${quiet})`);
});
