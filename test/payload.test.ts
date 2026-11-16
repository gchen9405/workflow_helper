/**
 * The pure payload helpers the browser bundle ships: byte-level image
 * sniffing on a plain Uint8Array, and `inputFromBytes`, whose base64 must
 * match what Node's Buffer produces for the same bytes (the CLI's
 * `loadInputFromBuffer` delegates to it, so the two paths must agree).
 */
import { describe, expect, it } from "vitest";
import { inputFromBytes, sniffImageMediaType, textInput } from "../src/io/payload.js";
import { loadInputFromBuffer } from "../src/io/input.js";
import { PIXEL_PNG_BASE64 } from "../src/llm/probe.js";

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));
const bytes = (...parts: (number[] | Uint8Array)[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const PNG = new Uint8Array(Buffer.from(PIXEL_PNG_BASE64, "base64"));
const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0], new Uint8Array(16));
const GIF = bytes(ascii("GIF89a"), new Uint8Array(16));
const WEBP = bytes(ascii("RIFF"), new Uint8Array(4), ascii("WEBP"), new Uint8Array(8));

/** Deterministic pseudo-random bytes, so every byte value and alignment occurs. */
function pattern(length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = 12345;
  for (let i = 0; i < length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = x & 0xff;
  }
  return out;
}

describe("sniffImageMediaType on a Uint8Array", () => {
  it("identifies each supported format from its signature", () => {
    expect(sniffImageMediaType(PNG)).toBe("image/png");
    expect(sniffImageMediaType(JPEG)).toBe("image/jpeg");
    expect(sniffImageMediaType(GIF)).toBe("image/gif");
    expect(sniffImageMediaType(WEBP)).toBe("image/webp");
  });

  it("returns undefined for text, truncated data, and a non-WebP RIFF", () => {
    expect(sniffImageMediaType(new TextEncoder().encode("An order comes in..."))).toBeUndefined();
    expect(sniffImageMediaType(new Uint8Array([0x89, 0x50]))).toBeUndefined();
    expect(sniffImageMediaType(new Uint8Array(0))).toBeUndefined();
    const wav = bytes(ascii("RIFF"), new Uint8Array(4), ascii("WAVE"), new Uint8Array(8));
    expect(sniffImageMediaType(wav)).toBeUndefined();
  });

  it("accepts a Node Buffer unchanged (it is a Uint8Array)", () => {
    expect(sniffImageMediaType(Buffer.from(PNG))).toBe("image/png");
  });
});

describe("inputFromBytes", () => {
  it("builds an image payload whose base64 matches Buffer's, at every chunk boundary", () => {
    for (const size of [0, 1, 2, 3, 32_767, 32_768, 32_769, 100_001]) {
      // Prefix the PNG signature so the bytes sniff as an image whatever the size.
      const data = bytes(PNG.subarray(0, 8), pattern(size));
      const payload = inputFromBytes(data, "chart.png");
      expect(payload.kind).toBe("image");
      if (payload.kind !== "image") return;
      expect(payload.mediaType).toBe("image/png");
      expect(payload.fileName).toBe("chart.png");
      expect(payload.base64).toBe(Buffer.from(data).toString("base64"));
    }
  });

  it("decodes non-image bytes as UTF-8 text, multi-byte characters included", () => {
    const text = "Bestellung prüfen → Lager fragen — 発注 ✔";
    expect(inputFromBytes(new TextEncoder().encode(`  ${text}\n`))).toEqual({
      kind: "text",
      text,
    });
  });

  it("rejects empty text up front, like textInput", () => {
    expect(() => inputFromBytes(new TextEncoder().encode("  \n\t"))).toThrow(/empty/);
    expect(() => textInput("")).toThrow(/empty/);
  });

  it("produces exactly what the CLI's loadInputFromBuffer produces", () => {
    const image = bytes(PNG.subarray(0, 8), pattern(5000));
    expect(inputFromBytes(image, "a.png")).toEqual(loadInputFromBuffer(Buffer.from(image), "a.png"));
    const text = new TextEncoder().encode("First A, then B.");
    expect(inputFromBytes(text)).toEqual(loadInputFromBuffer(Buffer.from(text)));
  });
});
