/**
 * Tests for cross-platform clipboard dispatch. The command runner is injected,
 * so each platform's behaviour is verified on any host — including the Windows
 * and Linux paths, which cannot otherwise be exercised from macOS.
 */
import { describe, expect, it, vi } from "vitest";
import { readClipboard, type ClipboardRunner } from "../src/io/clipboard.js";
import { PIXEL_PNG_BASE64 } from "../src/llm/probe.js";

const PNG = Buffer.from(PIXEL_PNG_BASE64, "base64");

/** A runner backed by a lookup of command -> stdout; unknown commands throw. */
function runner(table: Record<string, Buffer | string>): ClipboardRunner {
  return vi.fn((command: string, args: string[]) => {
    for (const [key, out] of Object.entries(table)) {
      if (`${command} ${args.join(" ")}`.startsWith(key)) {
        return Buffer.isBuffer(out) ? out : Buffer.from(out);
      }
    }
    throw new Error(`command not available: ${command}`);
  });
}

describe("readClipboard — macOS", () => {
  it("prefers an image, decoding osascript's hex payload", () => {
    const run = runner({
      osascript: `«data PNGf${PNG.toString("hex").toUpperCase()}»`,
    });
    const content = readClipboard({ platform: "darwin", run });
    expect(content).toEqual({ kind: "image", data: PNG });
  });

  it("falls back to pbpaste when no image is on the clipboard", () => {
    const run = runner({ pbpaste: "First A, then B." });
    expect(readClipboard({ platform: "darwin", run })).toEqual({
      kind: "text",
      text: "First A, then B.",
    });
  });
});

describe("readClipboard — Windows", () => {
  it("decodes the base64 image PowerShell reports", () => {
    const run = runner({ "powershell.exe": `IMAGE\n${PNG.toString("base64")}` });
    expect(readClipboard({ platform: "win32", run })).toEqual({ kind: "image", data: PNG });
  });

  it("reads text, preserving internal newlines", () => {
    const run = runner({ "powershell.exe": "TEXT\nfirst line\nsecond line" });
    expect(readClipboard({ platform: "win32", run })).toEqual({
      kind: "text",
      text: "first line\nsecond line",
    });
  });

  it("passes an STA, base64-encoded command so quoting cannot break it", () => {
    const run = runner({ "powershell.exe": "TEXT\nx" });
    readClipboard({ platform: "win32", run });

    const [command, args] = (run as any).mock.calls[0];
    expect(command).toBe("powershell.exe");
    expect(args).toContain("-STA");
    const encoded = args[args.indexOf("-EncodedCommand") + 1];
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toContain(
      "System.Windows.Forms.Clipboard",
    );
  });
});

describe("readClipboard — Linux", () => {
  it("uses wl-paste's image target when Wayland reports one", () => {
    const run = runner({
      "wl-paste --list-types": "image/png\ntext/plain",
      "wl-paste --type image/png": PNG,
    });
    expect(readClipboard({ platform: "linux", run })).toEqual({ kind: "image", data: PNG });
  });

  it("uses wl-paste text when Wayland has no image", () => {
    const run = runner({
      "wl-paste --list-types": "text/plain",
      "wl-paste --no-newline": "A then B",
    });
    expect(readClipboard({ platform: "linux", run })).toEqual({
      kind: "text",
      text: "A then B",
    });
  });

  it("falls back to xclip when wl-paste is missing", () => {
    const run = runner({
      "xclip -selection clipboard -t TARGETS -o": "TARGETS\nimage/png",
      "xclip -selection clipboard -t image/png -o": PNG,
    });
    expect(readClipboard({ platform: "linux", run })).toEqual({ kind: "image", data: PNG });
  });

  it("names both tools when neither is installed", () => {
    expect(() => readClipboard({ platform: "linux", run: runner({}) })).toThrow(
      /wl-clipboard.*xclip|xclip.*wl-clipboard/s,
    );
  });
});

describe("readClipboard — unsupported platform", () => {
  it("points at piping instead", () => {
    expect(() => readClipboard({ platform: "aix" as NodeJS.Platform, run: runner({}) })).toThrow(
      /not supported on aix/,
    );
  });
});
