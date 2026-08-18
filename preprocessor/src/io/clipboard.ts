/**
 * Cross-platform clipboard reading.
 *
 * Every platform prefers an image when one is on the clipboard — screenshotting
 * a flowchart and running `--clipboard` is the whole point — and falls back to
 * clipboard text. There is no portable API for this in Node, so each platform
 * shells out to whatever it ships with:
 *
 *   macOS    osascript (raw PNG data) then pbpaste
 *   Windows  one PowerShell call using System.Windows.Forms.Clipboard
 *   Linux    wl-paste (Wayland) then xclip (X11), image target first
 *
 * The command runner is injectable so the per-platform dispatch is unit-tested
 * without a clipboard, a display server, or the platform itself.
 */
import { execFileSync } from "node:child_process";

/** Runs a command and returns its stdout. Throws if it fails or is missing. */
export type ClipboardRunner = (command: string, args: string[]) => Buffer;

export interface ClipboardDeps {
  platform: NodeJS.Platform;
  run: ClipboardRunner;
}

/** Raw clipboard content, before it becomes an `InputPayload`. */
export type ClipboardContent =
  | { kind: "image"; data: Buffer }
  | { kind: "text"; text: string };

const MAX_BUFFER = 64 * 1024 * 1024;

const defaultRun: ClipboardRunner = (command, args) =>
  execFileSync(command, args, {
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Hex payload osascript prints for raw clipboard data: «data PNGf89504E47…». */
const OSASCRIPT_DATA = /«data \w{4}([0-9A-Fa-f]+)»/;

/**
 * PowerShell reads the clipboard through WinForms, which needs an STA thread —
 * hence `-STA`. The command is passed base64-encoded UTF-16LE via
 * `-EncodedCommand` so no quoting survives the trip through argv, and the
 * output is tagged with its kind on the first line.
 */
const POWERSHELL_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -ne $null) {
  $ms = New-Object System.IO.MemoryStream
  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  [Console]::Out.Write("IMAGE\`n")
  [Console]::Out.Write([Convert]::ToBase64String($ms.ToArray()))
} else {
  [Console]::Out.Write("TEXT\`n")
  [Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText())
}
`;

function readMacOs(run: ClipboardRunner): ClipboardContent | undefined {
  try {
    const raw = run("osascript", ["-e", "the clipboard as «class PNGf»"]).toString("utf8");
    const hex = OSASCRIPT_DATA.exec(raw)?.[1];
    if (hex) return { kind: "image", data: Buffer.from(hex, "hex") };
  } catch {
    // No image on the clipboard — fall through to text.
  }
  return { kind: "text", text: run("pbpaste", []).toString("utf8") };
}

function readWindows(run: ClipboardRunner): ClipboardContent | undefined {
  const encoded = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
  const out = run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-EncodedCommand",
    encoded,
  ]).toString("utf8");

  const newline = out.indexOf("\n");
  const kind = (newline === -1 ? out : out.slice(0, newline)).trim();
  const body = newline === -1 ? "" : out.slice(newline + 1);

  if (kind === "IMAGE") return { kind: "image", data: Buffer.from(body.trim(), "base64") };
  return { kind: "text", text: body };
}

/** Try Wayland first, then X11; both check for an image target before text. */
function readLinux(run: ClipboardRunner): ClipboardContent | undefined {
  try {
    const types = run("wl-paste", ["--list-types"]).toString("utf8");
    if (types.includes("image/png")) {
      return { kind: "image", data: run("wl-paste", ["--type", "image/png"]) };
    }
    return { kind: "text", text: run("wl-paste", ["--no-newline"]).toString("utf8") };
  } catch {
    // wl-paste missing or not a Wayland session — try X11.
  }

  const selection = ["-selection", "clipboard"];
  try {
    const targets = run("xclip", [...selection, "-t", "TARGETS", "-o"]).toString("utf8");
    if (targets.includes("image/png")) {
      return { kind: "image", data: run("xclip", [...selection, "-t", "image/png", "-o"]) };
    }
    return { kind: "text", text: run("xclip", [...selection, "-o"]).toString("utf8") };
  } catch {
    throw new Error(
      "could not read the clipboard — install wl-clipboard (Wayland) or xclip (X11), or pipe the input instead: `… | workflow-preprocessor -`",
    );
  }
}

/**
 * Read the system clipboard. Throws with an actionable message when the
 * platform has no supported mechanism or the tooling is missing.
 */
export function readClipboard(deps: Partial<ClipboardDeps> = {}): ClipboardContent {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultRun;

  let content: ClipboardContent | undefined;
  try {
    switch (platform) {
      case "darwin":
        content = readMacOs(run);
        break;
      case "win32":
        content = readWindows(run);
        break;
      case "linux":
      case "freebsd":
      case "openbsd":
        content = readLinux(run);
        break;
      default:
        throw new Error(
          `--clipboard is not supported on ${platform}; pipe the input instead: \`… | workflow-preprocessor -\``,
        );
    }
  } catch (err) {
    throw new Error(
      `could not read the clipboard: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!content) {
    throw new Error("could not read the clipboard");
  }
  return content;
}
