/** Microphone capture to 16 kHz mono 16-bit PCM, entirely inside this window. */
import { SAMPLE_RATE } from "./contract.ts";

export interface Capture {
  /** Release the microphone. Idempotent. */
  stop(): void;
}
export interface CaptureEvents {
  /** A block of 16 kHz samples and its loudness from 0 to 1. */
  samples(pcm: Int16Array, level: number): void;
  /** The microphone went away (unplugged, permission revoked). */
  lost(message: string): void;
}

/** Box-filtered decimation for audio stacks that will not open a 16 kHz context.
 * Each output sample averages the input samples it spans, which is enough
 * anti-aliasing for speech recognition. State carries across blocks. */
export class Downsampler {
  private readonly ratio: number;
  /** Position of the next output sample's window start, in input samples,
   * relative to the first sample of the next block. */
  private position = 0;
  private sum = 0;
  private count = 0;

  constructor(from: number, to: number = SAMPLE_RATE) {
    if (!(from > to)) throw new Error("Downsampler needs a source rate above the target rate.");
    this.ratio = from / to;
  }

  process(input: Float32Array): Float32Array {
    const output = new Float32Array(Math.ceil((input.length + 1) / this.ratio) + 1);
    let written = 0;
    for (let index = 0; index < input.length; index++) {
      this.sum += input[index]!;
      this.count++;
      // The window [position, position + ratio) is complete once the next
      // input sample would start at or beyond its end.
      if (index + 1 >= this.position + this.ratio) {
        output[written++] = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        this.position += this.ratio;
      }
    }
    this.position -= input.length;
    return output.subarray(0, written);
  }
}

export function toPcm16(samples: Float32Array): { pcm: Int16Array; level: number } {
  const pcm = new Int16Array(samples.length);
  let energy = 0;
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index]!));
    energy += value * value;
    pcm[index] = value < 0 ? value * 32768 : value * 32767;
  }
  // Perceptual-ish meter: quiet speech should still visibly move it.
  const rms = samples.length ? Math.sqrt(energy / samples.length) : 0;
  return { pcm, level: Math.min(1, Math.sqrt(rms) * 1.8) };
}

function describe(error: unknown): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was denied. Allow microphone access for LearnHarness in your system settings and try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found.";
  if (name === "NotReadableError") return "The microphone is in use by another application or could not be opened.";
  return `The microphone could not be started: ${error instanceof Error ? error.message : String(error)}`;
}

export async function startCapture(workletUrl: URL, events: CaptureEvents): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This window does not provide microphone access.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (error) { throw new Error(describe(error)); }

  let context: AudioContext | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
    void context?.close().catch(() => undefined);
  };
  try {
    // Chromium resamples the device to the requested rate with a good filter.
    try { context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" }); }
    catch { context = new AudioContext({ latencyHint: "interactive" }); }
    if (context.state === "suspended") await context.resume();
    const rate = context.sampleRate;
    if (rate < SAMPLE_RATE) throw new Error(`Unsupported audio sample rate (${rate} Hz).`);
    const downsampler = rate > SAMPLE_RATE ? new Downsampler(rate) : undefined;
    const deliver = (block: Float32Array) => {
      if (stopped) return;
      const { pcm, level } = toPcm16(downsampler ? downsampler.process(block) : block);
      if (pcm.length) events.samples(pcm, level);
    };
    const source = context.createMediaStreamSource(stream);
    try {
      await context.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(context, "on-device-dictation-pcm", {
        numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers",
      });
      node.port.onmessage = event => deliver(event.data as Float32Array);
      source.connect(node);
    } catch {
      // Older or locked-down audio stacks: the deprecated main-thread node still works.
      const node = context.createScriptProcessor(4096, 1, 1);
      const mute = context.createGain();
      mute.gain.value = 0;
      node.onaudioprocess = event => deliver(new Float32Array(event.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
    }
    for (const track of stream.getAudioTracks()) {
      track.onended = () => { if (!stopped) { stop(); events.lost("The microphone was disconnected."); } };
    }
    if (stopped) throw new Error("Dictation was cancelled.");
  } catch (error) {
    stop();
    throw error instanceof Error ? error : new Error(String(error));
  }
  return { stop };
}
