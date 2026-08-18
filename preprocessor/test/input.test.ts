/**
 * Tests for input loading: content-based modality detection, path cleanup for
 * paths a human produced (drag-and-drop, quotes, `~`), stdin, and folder
 * discovery. No network and no LLM — this is all deterministic I/O.
 */
import { Readable } from "node:stream";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverInputs,
  loadInputFromBuffer,
  loadInputFromFile,
  loadInputFromStdin,
  normalizeInputPath,
  sniffImageMediaType,
  textInput,
} from "../src/io/input.js";
import { PIXEL_PNG_BASE64 } from "../src/llm/probe.js";

const PNG = Buffer.from(PIXEL_PNG_BASE64, "base64");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.alloc(16)]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.alloc(4),
  Buffer.from("WEBP", "latin1"),
  Buffer.alloc(8),
]);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "wfp-input-"));
}

describe("sniffImageMediaType", () => {
  it("identifies each supported format from its signature", () => {
    expect(sniffImageMediaType(PNG)).toBe("image/png");
    expect(sniffImageMediaType(JPEG)).toBe("image/jpeg");
    expect(sniffImageMediaType(GIF)).toBe("image/gif");
    expect(sniffImageMediaType(WEBP)).toBe("image/webp");
  });

  it("returns undefined for text and for truncated data", () => {
    expect(sniffImageMediaType(Buffer.from("An order comes in..."))).toBeUndefined();
    expect(sniffImageMediaType(Buffer.from([0x89, 0x50]))).toBeUndefined();
    expect(sniffImageMediaType(Buffer.alloc(0))).toBeUndefined();
  });

  it("does not mistake a RIFF container that is not WebP for an image", () => {
    const wav = Buffer.concat([
      Buffer.from("RIFF", "latin1"),
      Buffer.alloc(4),
      Buffer.from("WAVE", "latin1"),
      Buffer.alloc(8),
    ]);
    expect(sniffImageMediaType(wav)).toBeUndefined();
  });
});

describe("normalizeInputPath", () => {
  it("strips surrounding quotes", () => {
    expect(normalizeInputPath('"/tmp/my chart.png"')).toBe("/tmp/my chart.png");
    expect(normalizeInputPath("'/tmp/my chart.png'")).toBe("/tmp/my chart.png");
  });

  it("unescapes shell-escaped characters from a dragged path", () => {
    expect(normalizeInputPath("/tmp/my\\ chart\\ \\(1\\).png", "darwin")).toBe(
      "/tmp/my chart (1).png",
    );
  });

  it("leaves a lone backslash that is not an escape alone", () => {
    expect(normalizeInputPath("/tmp/a\\b.png", "darwin")).toBe("/tmp/a\\b.png");
  });

  it("converts a file:// URL, decoding percent escapes", () => {
    expect(normalizeInputPath("file:///tmp/my%20chart.png")).toBe("/tmp/my chart.png");
  });

  it("expands a leading ~", () => {
    expect(normalizeInputPath("~/charts/a.png")).toBe(join(homedir(), "charts", "a.png"));
    expect(normalizeInputPath("~")).toBe(homedir());
  });

  it("leaves an ordinary path untouched", () => {
    expect(normalizeInputPath("  examples/thin.txt  ")).toBe("examples/thin.txt");
  });
});

describe("normalizeInputPath — Windows", () => {
  // The backslash is the path separator on Windows, so the POSIX unescaping
  // must not run: these paths would otherwise be silently corrupted.
  it("never unescapes backslashes, even before a metacharacter", () => {
    expect(normalizeInputPath("C:\\$Recycle.Bin\\chart.png", "win32")).toBe(
      "C:\\$Recycle.Bin\\chart.png",
    );
    expect(normalizeInputPath("C:\\Users\\gc\\ chart (1).png", "win32")).toBe(
      "C:\\Users\\gc\\ chart (1).png",
    );
    expect(normalizeInputPath("C:\\temp\\'quoted'\\a&b.png", "win32")).toBe(
      "C:\\temp\\'quoted'\\a&b.png",
    );
  });

  it("strips the quotes Explorer adds when a path is dragged into a console", () => {
    expect(normalizeInputPath('"C:\\Users\\gc\\order flow.png"', "win32")).toBe(
      "C:\\Users\\gc\\order flow.png",
    );
  });

  it("converts a Windows file:// URL", () => {
    expect(normalizeInputPath("file:///C:/Users/gc/my%20chart.png", "win32")).toMatch(
      /my chart\.png$/,
    );
  });

  it("expands ~ with a backslash separator too", () => {
    expect(normalizeInputPath("~\\charts\\a.png", "win32")).toBe(
      join(homedir(), "charts\\a.png"),
    );
  });
});

describe("loadInputFromBuffer", () => {
  it("detects an image regardless of any filename", () => {
    const payload = loadInputFromBuffer(PNG, "whatever");
    expect(payload).toMatchObject({ kind: "image", mediaType: "image/png" });
  });

  it("falls back to text", () => {
    expect(loadInputFromBuffer(Buffer.from("  a process  "))).toEqual({
      kind: "text",
      text: "a process",
    });
  });

  it("rejects empty text up front", () => {
    expect(() => loadInputFromBuffer(Buffer.from("   "))).toThrow(/empty/);
  });
});

describe("loadInputFromFile", () => {
  it("reads a text file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "process.txt"), "First A, then B.\n");
    expect(loadInputFromFile(join(dir, "process.txt"))).toEqual({
      kind: "text",
      text: "First A, then B.",
    });
  });

  it("reads an image by extension", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "chart.png"), PNG);
    expect(loadInputFromFile(join(dir, "chart.png"))).toMatchObject({
      kind: "image",
      mediaType: "image/png",
      fileName: "chart.png",
    });
  });

  it("reads an image with no extension, by content", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "screenshot"), PNG);
    expect(loadInputFromFile(join(dir, "screenshot"))).toMatchObject({
      kind: "image",
      mediaType: "image/png",
    });
  });

  it("applies path cleanup, so a quoted dragged path loads", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "my chart.png"), PNG);
    expect(loadInputFromFile(`"${join(dir, "my chart.png")}"`)).toMatchObject({
      kind: "image",
    });
  });

  // Backslash unescaping is POSIX-only by design (see normalizeInputPath), so
  // this asserts the shell-escaped form only where that form can occur.
  it.skipIf(process.platform === "win32")(
    "loads a path with shell-escaped spaces",
    () => {
      const dir = tempDir();
      writeFileSync(join(dir, "my chart.png"), PNG);
      expect(loadInputFromFile(join(dir, "my\\ chart.png"))).toMatchObject({
        kind: "image",
      });
    },
  );

  // An exact path (from readdirSync / discoverInputs, or normalized once
  // already) must load verbatim: a POSIX filename that legitimately contains
  // a backslash escape sequence would be mangled by a second cleanup.
  it.skipIf(process.platform === "win32")(
    "loads an exact path verbatim with normalize: false",
    () => {
      const dir = tempDir();
      writeFileSync(join(dir, "flow\\ (draft).png"), PNG);

      const [found] = discoverInputs(dir, { normalize: false });
      expect(loadInputFromFile(found, { normalize: false })).toMatchObject({
        kind: "image",
      });
      // The default cleanup would strip the backslash and miss the file.
      expect(() => loadInputFromFile(found)).toThrow();
    },
  );
});

describe("loadInputFromStdin", () => {
  it("reads piped text", async () => {
    const payload = await loadInputFromStdin(Readable.from([Buffer.from("A then B")]));
    expect(payload).toEqual({ kind: "text", text: "A then B" });
  });

  it("reads a piped image across multiple chunks", async () => {
    const chunks = [PNG.subarray(0, 20), PNG.subarray(20)];
    const payload = await loadInputFromStdin(Readable.from(chunks));
    expect(payload).toMatchObject({ kind: "image", mediaType: "image/png" });
  });

  it("gives a clear error for an empty pipe", async () => {
    await expect(loadInputFromStdin(Readable.from([]))).rejects.toThrow(/nothing was piped/);
  });
});

describe("discoverInputs", () => {
  it("lists supported files in a stable order, skipping dotfiles and folders", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "b.txt"), "b");
    writeFileSync(join(dir, "a.png"), PNG);
    writeFileSync(join(dir, "c.md"), "c");
    writeFileSync(join(dir, ".hidden.txt"), "x");
    writeFileSync(join(dir, "notes.pdf"), "x");
    mkdirSync(join(dir, "sub"));

    expect(discoverInputs(dir).map((p) => basename(p))).toEqual([
      "a.png",
      "b.txt",
      "c.md",
    ]);
  });

  it("skips excluded filenames case-insensitively, so a drop folder can document itself", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "README.txt"), "drop your workflows here");
    writeFileSync(join(dir, "process.txt"), "First A, then B.");

    const found = discoverInputs(dir, { exclude: ["readme.txt"] });
    expect(found.map((p) => basename(p))).toEqual(["process.txt"]);
  });

  it("includes an extension-less file only when its bytes are an image", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "Makefile"), "all:\n\techo hi\n");
    writeFileSync(join(dir, "screenshot"), PNG);

    expect(discoverInputs(dir).map((p) => basename(p))).toEqual([
      "screenshot",
    ]);
  });
});

describe("textInput", () => {
  it("trims and rejects empty input", () => {
    expect(textInput("  hello  ")).toEqual({ kind: "text", text: "hello" });
    expect(() => textInput("\n \t")).toThrow(/empty/);
  });
});
