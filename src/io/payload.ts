/**
 * The input payload, and the pure helpers that build one from text or raw
 * bytes. No Node imports: this module is what the browser bundle ships.
 * `io/input.ts` layers the file, stdin and clipboard loaders on top of it
 * for the CLI and re-exports everything here, so nothing changes for Node
 * callers.
 *
 * Both modalities normalize to one `InputPayload` union so the rest of the
 * pipeline is modality-agnostic (the only place the difference matters is
 * which content blocks are sent to triage/normalization). Modality is
 * decided by CONTENT, not by a filename: magic bytes are the authority, so a
 * screenshot saved without an extension, or a pasted image with no name at
 * all, is still an image.
 */

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type InputPayload =
  | { kind: "text"; text: string }
  | { kind: "image"; mediaType: ImageMediaType; base64: string; fileName?: string };

/** Wrap raw text as an input payload. Rejects empty input up front. */
export function textInput(text: string): InputPayload {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error("input text is empty");
  }
  return { kind: "text", text: trimmed };
}

/** True when `bytes` holds the ASCII string `ascii` starting at `offset`. */
function bytesAt(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (bytes.length < offset + ascii.length) return false;
  for (let i = 0; i < ascii.length; i++) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Identify an image from its leading bytes. Signatures:
 * PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, GIF `GIF87a`/`GIF89a`,
 * WebP `RIFF….WEBP`. A Node `Buffer` is a `Uint8Array`, so existing callers
 * pass one unchanged.
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytesAt(bytes, 1, "PNG") &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytesAt(bytes, 0, "GIF87a") || bytesAt(bytes, 0, "GIF89a")) {
    return "image/gif";
  }
  if (bytesAt(bytes, 0, "RIFF") && bytesAt(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  return undefined;
}

/**
 * `String.fromCharCode` takes its code units as arguments, and engines cap
 * the argument count (the lowest common limit is around 65k); 32 KiB slices
 * keep every chunk well inside it.
 */
const BASE64_CHUNK = 0x8000;

/**
 * Standard base64 (with padding) of raw bytes, without `Buffer`. The bytes
 * are turned into a binary string chunk by chunk and encoded in ONE `btoa`
 * call — encoding chunks separately would insert padding mid-stream unless
 * every chunk were a multiple of three bytes. `btoa` is a global in every
 * browser and in Node ≥ 16.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

/**
 * Build a payload from raw bytes — a dropped file, a pasted image, a fetch
 * body. Magic bytes decide the modality; when they match nothing the bytes
 * are read as UTF-8 text. Same output as the CLI's `loadInputFromBuffer`.
 */
export function inputFromBytes(bytes: Uint8Array, fileName?: string): InputPayload {
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType) {
    return { kind: "image", mediaType, base64: bytesToBase64(bytes), fileName };
  }
  return textInput(new TextDecoder("utf-8").decode(bytes));
}
