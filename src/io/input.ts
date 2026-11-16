/**
 * Input loading. Both modalities normalize to one `InputPayload` union so the
 * rest of the pipeline is modality-agnostic (the only place the difference
 * matters is which content blocks are sent to triage/normalization).
 *
 * Everything below exists to make "give the tool your input" a single obvious
 * step regardless of where the input lives — a file or a pipe. The union at
 * the end is always the same, so none of this reaches the pipeline.
 *
 * Modality is decided by CONTENT, not by filename: the extension is a hint,
 * magic bytes are the authority. A screenshot saved without an extension, or
 * an image arriving over a pipe with no name at all, is still an image.
 *
 * This module is Node-only (files, stdin). The payload type and the pure
 * helpers it builds on live in `payload.ts`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  inputFromBytes,
  sniffImageMediaType,
  textInput,
  type ImageMediaType,
  type InputPayload,
} from "./payload.js";

// The payload type and the pure helpers (text, sniffing, bytes → payload)
// live in `payload.ts` so the browser bundle can use them; they are
// re-exported here so Node callers see one module, as before.
export {
  inputFromBytes,
  sniffImageMediaType,
  textInput,
  type ImageMediaType,
  type InputPayload,
} from "./payload.js";

const IMAGE_EXTENSIONS: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Text extensions picked up when a whole folder is given as the input. */
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".text", ".rst"]);

/**
 * Clean up a path as a human is likely to have produced it: dragged from
 * Finder or Explorer (surrounding quotes, backslash-escaped spaces, or a
 * `file://` URL) or typed with a `~`.
 *
 * The backslash unescaping is POSIX-only and deliberately so: on Windows the
 * backslash IS the path separator, so `C:\$Recycle.Bin` or `C:\ tmp` would be
 * corrupted by it. Windows shells quote dragged paths instead, which the quote
 * stripping above already handles.
 *
 * On POSIX, only backslashes escaping a shell metacharacter are unescaped, so
 * a path that legitimately contains a backslash survives.
 */
export function normalizeInputPath(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let path = raw.trim();

  const quote = path[0];
  if ((quote === '"' || quote === "'") && path.length >= 2 && path.endsWith(quote)) {
    path = path.slice(1, -1);
  }

  if (/^file:\/\//i.test(path)) {
    try {
      return fileURLToPath(path);
    } catch {
      // Not a well-formed file URL — fall through and treat it as a path.
    }
  }

  if (platform !== "win32") {
    path = path.replace(/\\([ ()&'"`!$;])/g, "$1");
  }

  if (path === "~") return homedir();
  if (path === "~/" || path === "~\\") return homedir();
  if (path.startsWith("~/") || (platform === "win32" && path.startsWith("~\\"))) {
    return join(homedir(), path.slice(2));
  }

  return path;
}

/**
 * Build a payload from raw bytes. Magic bytes decide the modality; when they
 * match nothing the bytes are read as UTF-8 text.
 */
export function loadInputFromBuffer(buffer: Buffer, fileName?: string): InputPayload {
  return inputFromBytes(buffer, fileName);
}

export interface LoadFileOptions {
  /**
   * Apply the human-path cleanup of `normalizeInputPath` first (the default).
   * Pass false when the path is already exact — normalized once, or produced
   * by `readdirSync`/`discoverInputs` — so a filename that legitimately
   * contains a backslash escape sequence is not mangled by a second cleanup.
   */
  normalize?: boolean;
}

/**
 * Load a file as input. The extension picks the media type when it is a known
 * image extension; otherwise the bytes are sniffed, so an extension-less or
 * mislabelled image is still handled correctly and everything else is text.
 */
export function loadInputFromFile(
  filePath: string,
  options: LoadFileOptions = {},
): InputPayload {
  const path = options.normalize === false ? filePath : normalizeInputPath(filePath);
  const declared = IMAGE_EXTENSIONS[extname(path).toLowerCase()];
  const buffer = readFileSync(path);
  const fileName = basename(path);

  const mediaType = declared ?? sniffImageMediaType(buffer);
  if (mediaType) {
    return { kind: "image", mediaType, base64: buffer.toString("base64"), fileName };
  }
  return textInput(buffer.toString("utf8"));
}

/** Read a stream to completion. Used for piped stdin. */
export async function readStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Read piped stdin as input. Handles both `cat notes.md |` and `< image.png`. */
export async function loadInputFromStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<InputPayload> {
  const buffer = await readStream(stream);
  if (buffer.length === 0) {
    throw new Error("nothing was piped in on stdin");
  }
  return loadInputFromBuffer(buffer, "stdin");
}

/** Absolute path, with the human-friendly cleanups applied. */
export function resolveInputPath(path: string): string {
  return resolve(normalizeInputPath(path));
}
