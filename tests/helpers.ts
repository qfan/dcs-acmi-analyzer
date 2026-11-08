import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

export const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
export const sample = (name: string) => fileURLToPath(new URL(`../public/samples/${name}`, import.meta.url));

/** Stream a file in small chunks so chunk-boundary handling is exercised. */
export async function* fileChunks(path: string, chunkSize = 4096): AsyncIterable<Uint8Array> {
  for await (const chunk of createReadStream(path, { highWaterMark: chunkSize })) {
    yield new Uint8Array(chunk as Buffer);
  }
}

export async function* bytesChunks(bytes: Uint8Array, chunkSize: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize);
}
