/** A stand-in for the LearnHarness server side of the plugin API: just enough to
 * activate the built backend and call its handlers the way the bridge would. */
import { createRequire } from "node:module";
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";

const require = createRequire(import.meta.url);

export interface FakeHost {
  call<T = unknown>(operation: string, input?: unknown): Promise<T>;
  events: { topic: string; data?: unknown }[];
  dispose(): Promise<void>;
}

export function activateBackend(dist: string, dataDirectory: string): FakeHost {
  const handlers = new Map<string, (input: unknown) => unknown>();
  const events: FakeHost["events"] = [];
  const controller = new AbortController();
  const cleanups: (() => void | Promise<void>)[] = [];
  const ctx = {
    manifest: require(path.join(dist, "manifest.json")),
    directory: dist,
    dataDirectory,
    signal: controller.signal,
    cleanup(dispose: () => void) { cleanups.push(dispose); },
    handle(name: string, handler: (input: unknown) => unknown) {
      if (handlers.has(name)) throw new Error(`Duplicate handler ${name}`);
      handlers.set(name, handler);
      return () => { handlers.delete(name); };
    },
    events: { on: () => () => undefined, emit(topic: string, data?: unknown) { events.push({ topic, data }); } },
  } as unknown as PluginBackendContext;
  const backend = require(path.join(dist, "backend.cjs")) as { activate(ctx: PluginBackendContext): () => void };
  const cleanup = backend.activate(ctx);
  return {
    events,
    async call<T>(operation: string, input?: unknown): Promise<T> {
      const handler = handlers.get(operation);
      if (!handler) throw new Error(`No handler ${operation}`);
      // The real bridge is JSON in both directions.
      const result = await handler(input === undefined ? undefined : JSON.parse(JSON.stringify(input)));
      return (result === undefined ? undefined : JSON.parse(JSON.stringify(result))) as T;
    },
    async dispose() {
      controller.abort();
      cleanup();
      for (const dispose of cleanups) await dispose();
    },
  };
}
