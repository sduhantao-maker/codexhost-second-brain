/**
 * Sends a file the user picked, pasted or dropped on the hover card to the backend: one
 * `attach.begin`, then its pieces of ATTACH_CHUNK_BYTES in base64 through `attach.chunk`, a few at
 * a time. A backend call carries at most a couple of MiB, hence the pieces.
 */
import { ATTACH_CHUNK_BYTES } from "../../core/attachments.js";
import type { AttachBeginParams, AttachChunkParams } from "../../core/rpc.js";

export type Invoke = (method: string, params?: unknown) => unknown;

/** Pieces on their way at the same time. */
export const UPLOAD_PARALLEL = 3;

/** Bytes as base64, in slices small enough to pass as arguments. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function bytesOf(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * Sends one file and returns its upload id. `sent` hears the size of every piece that arrived; it
 * may throw to stop the upload (the card was closed meanwhile).
 */
export async function uploadFile(invoke: Invoke, file: Blob, name: string, sent: (bytes: number) => void): Promise<string> {
  const begin: AttachBeginParams = { name, size: file.size, ...(file.type ? { type: file.type } : {}) };
  const begun = (await invoke("attach.begin", begin)) as { id?: unknown } | null;
  const id = begun?.id;
  if (typeof id !== "string" || !id) throw new Error("the backend did not take the file");
  const offsets: number[] = [];
  for (let offset = 0; offset < file.size; offset += ATTACH_CHUNK_BYTES) offsets.push(offset);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < offsets.length) {
      const offset = offsets[next++]!;
      try {
        const piece = file.slice(offset, offset + ATTACH_CHUNK_BYTES);
        const chunk: AttachChunkParams = { id, offset, data: base64(new Uint8Array(await bytesOf(piece))) };
        await invoke("attach.chunk", chunk);
        if (!failed) sent(piece.size);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_PARALLEL, offsets.length) }, worker));
  return id;
}
