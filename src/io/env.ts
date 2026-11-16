/**
 * Minimal `.env` support, no dependency.
 *
 * The configuration surface is small (LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL
 * and the optional LLM_VISION_* split), but re-exporting it in every new shell
 * is the single biggest source of friction when running the CLI. A `.env` file
 * next to the project removes that without changing how anything resolves:
 * values land in `process.env` before any client is constructed, so
 * `InternalLlmClient` / `createLlmClient` keep reading exactly the same vars.
 *
 * Precedence is the conventional one — a variable already present in the
 * real environment WINS over the file. An `export LLM_MODEL=…` in the current
 * shell is an explicit, immediate act; the file is a stored default. Reporting
 * which keys were overridden this way (`skipped`) makes that visible instead
 * of mysterious.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface EnvFileLoad {
  /** Absolute path of the file that was read. */
  path: string;
  /** Keys taken from the file. */
  applied: string[];
  /** Keys present in the file but already set in the environment (env wins). */
  skipped: string[];
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse `.env` text into key/value pairs.
 *
 * Supported: `KEY=value`, a leading `export `, `#` comments (whole-line and
 * trailing on unquoted values), blank lines, and single- or double-quoted
 * values. Double-quoted values honour `\n`, `\t`, `\"` and `\\`; single-quoted
 * values are literal. Malformed lines are ignored rather than fatal — a typo
 * in an optional variable should not stop the run.
 */
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;

    const eq = withoutExport.indexOf("=");
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) continue;

    out.set(key, parseValue(withoutExport.slice(eq + 1).trim()));
  }

  return out;
}

function parseValue(raw: string): string {
  const quote = raw[0];
  if (quote === '"' || quote === "'") {
    // Take everything up to the matching close quote; anything after it (a
    // trailing comment, stray whitespace) is not part of the value.
    const close = raw.indexOf(quote, 1);
    if (close !== -1) {
      const inner = raw.slice(1, close);
      return quote === '"'
        ? inner.replace(/\\([nrt"\\])/g, (_, ch: string) =>
            ch === "n" ? "\n" : ch === "r" ? "\r" : ch === "t" ? "\t" : ch,
          )
        : inner;
    }
    // Unterminated quote: treat the rest literally rather than dropping it.
  }
  // Unquoted: a ` #` starts a trailing comment.
  const comment = raw.search(/\s#/);
  return (comment === -1 ? raw : raw.slice(0, comment)).trim();
}

/**
 * Walk up from `startDir` looking for a `.env` file. Running the CLI from the
 * repo root or from `preprocessor/` should both work.
 */
export function findEnvFile(startDir: string = process.cwd()): string | undefined {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 12; depth++) {
    const candidate = resolve(dir, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * Load a `.env` into `process.env` without overwriting variables that are
 * already set. Returns what happened, or `undefined` when no file was found
 * (which is not an error — env vars alone are a perfectly good setup).
 *
 * An explicitly requested path that does not exist IS an error: the user
 * asked for that file specifically.
 */
export function loadEnvFile(
  explicitPath?: string,
  startDir: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): EnvFileLoad | undefined {
  const path = explicitPath ? resolve(explicitPath) : findEnvFile(startDir);
  if (!path) return undefined;
  if (explicitPath && !existsSync(path)) {
    throw new Error(`env file not found: ${path}`);
  }

  const parsed = parseEnvFile(readFileSync(path, "utf8"));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of parsed) {
    if (env[key] !== undefined && env[key] !== "") {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }

  return { path, applied, skipped };
}
