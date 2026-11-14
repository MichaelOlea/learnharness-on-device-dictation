/** Audio-thread half of microphone capture: forward mono samples in small
 * batches. Runs in an AudioWorkletGlobalScope, so it imports nothing. */
declare const registerProcessor: (name: string, processor: unknown) => void;
declare class AudioWorkletProcessor { readonly port: MessagePort; }

const BATCH = 1024;

class PcmCapture extends AudioWorkletProcessor {
  private buffer = new Float32Array(BATCH);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(BATCH - this.filled, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === BATCH) {
        const full = this.buffer;
        this.port.postMessage(full, [full.buffer]);
        this.buffer = new Float32Array(BATCH);
        this.filled = 0;
      }
    }
    return true;
  }
}
registerProcessor("on-device-dictation-pcm", PcmCapture);
