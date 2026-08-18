/**
 * Tests for .env parsing and loading. The loading rule that matters most is
 * precedence: a variable already set in the real environment must win over the
 * file, so an explicit `export` in the current shell is never silently
 * overridden by a stale stored default.
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findEnvFile, loadEnvFile, parseEnvFile } from "../src/io/env.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "wfp-env-"));
}

describe("parseEnvFile", () => {
  it("reads plain assignments, ignoring comments and blank lines", () => {
    const parsed = parseEnvFile(
      ["# a comment", "", "LLM_MODEL=gpt-x", "LLM_ENDPOINT=https://x/v1", ""].join("\n"),
    );
    expect(Object.fromEntries(parsed)).toEqual({
      LLM_MODEL: "gpt-x",
      LLM_ENDPOINT: "https://x/v1",
    });
  });

  it("accepts a leading `export` so a shell snippet can be pasted verbatim", () => {
    expect(parseEnvFile("export LLM_API_KEY=abc123").get("LLM_API_KEY")).toBe("abc123");
  });

  it("strips matching quotes and honours escapes only inside double quotes", () => {
    const parsed = parseEnvFile(
      ['A="line\\nbreak"', "B='literal\\nbreak'", 'C="  padded  "'].join("\n"),
    );
    expect(parsed.get("A")).toBe("line\nbreak");
    expect(parsed.get("B")).toBe("literal\\nbreak");
    expect(parsed.get("C")).toBe("  padded  ");
  });

  it("treats ` #` as a trailing comment on unquoted values but not inside quotes", () => {
    const parsed = parseEnvFile(['A=value # trailing', 'B="value # kept"'].join("\n"));
    expect(parsed.get("A")).toBe("value");
    expect(parsed.get("B")).toBe("value # kept");
  });

  it("strips a comment that follows a quoted value, without keeping the quotes", () => {
    const parsed = parseEnvFile(['A="secret"  # the key', "B='secret'  # the key"].join("\n"));
    expect(parsed.get("A")).toBe("secret");
    expect(parsed.get("B")).toBe("secret");
  });

  it("keeps an unterminated quote's content instead of dropping the value", () => {
    expect(parseEnvFile('A="unclosed').get("A")).toBe('"unclosed');
  });

  it("keeps `=` and `#` that appear inside a value", () => {
    const parsed = parseEnvFile("LLM_API_KEY=sk-a=b#c");
    expect(parsed.get("LLM_API_KEY")).toBe("sk-a=b#c");
  });

  it("skips malformed lines rather than failing the run", () => {
    const parsed = parseEnvFile(
      ["not an assignment", "=novalue", "1BAD=x", "GOOD=y"].join("\n"),
    );
    expect(Object.fromEntries(parsed)).toEqual({ GOOD: "y" });
  });
});

describe("loadEnvFile", () => {
  it("applies file values and reports them", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "LLM_MODEL=from-file\nLLM_ENDPOINT=https://file/v1\n");
    const env: NodeJS.ProcessEnv = {};

    const result = loadEnvFile(undefined, dir, env);

    expect(result?.applied.sort()).toEqual(["LLM_ENDPOINT", "LLM_MODEL"]);
    expect(env.LLM_MODEL).toBe("from-file");
  });

  it("lets an existing environment variable win over the file", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "LLM_MODEL=from-file\nLLM_API_KEY=from-file\n");
    const env: NodeJS.ProcessEnv = { LLM_MODEL: "from-shell" };

    const result = loadEnvFile(undefined, dir, env);

    expect(env.LLM_MODEL).toBe("from-shell");
    expect(result?.skipped).toEqual(["LLM_MODEL"]);
    expect(result?.applied).toEqual(["LLM_API_KEY"]);
  });

  it("treats an empty existing value as unset", () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "LLM_MODEL=from-file\n");
    const env: NodeJS.ProcessEnv = { LLM_MODEL: "" };

    loadEnvFile(undefined, dir, env);

    expect(env.LLM_MODEL).toBe("from-file");
  });

  it("returns undefined when there is no .env anywhere above the start directory", () => {
    // A temp dir has no .env; the walk stops at the filesystem root.
    expect(loadEnvFile(undefined, tempDir(), {})).toBeUndefined();
  });

  it("throws when an explicitly requested env file is missing", () => {
    expect(() => loadEnvFile(join(tempDir(), "nope.env"), undefined, {})).toThrow(
      /env file not found/,
    );
  });
});

describe("findEnvFile", () => {
  it("walks up from a subdirectory to find the project .env", () => {
    const root = tempDir();
    writeFileSync(join(root, ".env"), "LLM_MODEL=x\n");
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });

    expect(findEnvFile(nested)).toBe(join(root, ".env"));
  });
});
