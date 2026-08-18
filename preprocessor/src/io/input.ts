/**
 * Input loading. Both modalities normalize to one `InputPayload` union so the
 * rest of the pipeline is modality-agnostic (the only place the difference
 * matters is which content blocks are sent to triage/normalization).
 *
 * Everything below exists to make "give the tool your input" a single obvious
 * step regardless of where the input lives — a file, a folder, a pipe, or the
 * system clipboard. The union at the end is always the same, so none of this
 * reaches the pipeline.
 *
 * Modality is decided by CONTENT, not by filename: the extension is a hint,
 * magic bytes are the authority. A screenshot saved without an extension, or
 * an image arriving over a pipe with no name at all, is still an image.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readClipboard, type ClipboardDeps } from "./clipboard.js";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type InputPayload =
  | { kind: "text"; text: string }
  | { kind: "image"; mediaType: ImageMediaType; base64: string; fileName?: string };

const IMAGE_EXTENSIONS: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Text extensions picked up when a whole folder is given as the input. */
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".text", ".rst"]);

/** Wrap raw text as an input payload. Rejects empty input up front. */
export function textInput(text: string): InputPayload {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error("input text is empty");
  }
  return { kind: "text", text: trimmed };
}

/**
 * Identify an image from its leading bytes. Signatures:
 * PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF `GIF87a`/`GIF89a`,
 * WebP `RIFF….WEBP`.
 */
export function sniffImageMediaType(buffer: Buffer): ImageMediaType | undefined {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString("latin1") === "PNG" &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const head = buffer.subarray(0, 6).toString("latin1");
    if (head === "GIF87a" || head === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

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
  const mediaType = sniffImageMediaType(buffer);
  if (mediaType) {
    return { kind: "image", mediaType, base64: buffer.toString("base64"), fileName };
  }
  return textInput(buffer.toString("utf8"));
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

/**
 * Read the system clipboard on any supported platform (see `./clipboard.ts`).
 * An image is preferred when one is present — screenshotting a flowchart and
 * running `--clipboard` should just work — otherwise the clipboard text is used.
 */
export function loadInputFromClipboard(deps: Partial<ClipboardDeps> = {}): InputPayload {
  const content = readClipboard(deps);

  if (content.kind === "image") {
    if (content.data.length === 0) {
      throw new Error("the clipboard image could not be read");
    }
    return loadInputFromBuffer(content.data, "clipboard.png");
  }

  if (content.text.trim() === "") {
    throw new Error("the clipboard is empty — copy an image or a process description first");
  }
  return textInput(content.text);
}

/** True when the path is a directory (false when it does not exist). */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export interface DiscoverOptions {
  /**
   * Filenames to skip, compared case-insensitively. Used for instruction
   * files that live in a drop folder — `inbox/README.txt` explains the folder,
   * it is not a workflow someone dropped there.
   */
  exclude?: string[];
  /**
   * Apply the human-path cleanup of `normalizeInputPath` to the directory
   * path first (the default). Pass false when the path is already exact.
   */
  normalize?: boolean;
}

/**
 * List the inputs inside a folder: known image and text extensions, dotfiles
 * and subdirectories skipped, sorted for a stable run order. Files with no
 * extension are included only when their bytes look like an image, so stray
 * `Makefile`-ish files don't silently become "workflows".
 */
export function discoverInputs(dirPath: string, options: DiscoverOptions = {}): string[] {
  const dir = options.normalize === false ? dirPath : normalizeInputPath(dirPath);
  const excluded = new Set((options.exclude ?? []).map((n) => n.toLowerCase()));
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && !excluded.has(name.toLowerCase()))
    .map((name) => join(dir, name))
    .filter((path) => {
      if (isDirectory(path)) return false;
      const ext = extname(path).toLowerCase();
      if (ext in IMAGE_EXTENSIONS || TEXT_EXTENSIONS.has(ext)) return true;
      if (ext !== "") return false;
      try {
        return sniffImageMediaType(readFileSync(path)) !== undefined;
      } catch {
        return false;
      }
    })
    .sort();
}

/** Absolute path, with the human-friendly cleanups applied. */
export function resolveInputPath(path: string): string {
  return resolve(normalizeInputPath(path));
}
