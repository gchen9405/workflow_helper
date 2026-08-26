#!/usr/bin/env node
/**
 * CLI for the workflow preprocessor.
 *
 *   workflow-preprocessor <file|folder> [options]   # modality detected from content
 *   workflow-preprocessor --text "<description>" [options]
 *   workflow-preprocessor --clipboard [options]     # image or text from the clipboard
 *   … | workflow-preprocessor                       # piped stdin
 *
 * Getting input in should never be the hard part, so all four routes above
 * converge on the same `InputPayload` and the same pipeline. Configuration
 * comes from a `.env` file when one is present (real env vars still win), and
 * `--check` verifies that configuration with one trivial round trip before a
 * real run spends anything.
 *
 * Clarification stays interactive: questions are asked round by round, and
 * when stdin is a pipe the prompts are read from the console device
 * (/dev/tty, or CONIN$ on Windows) so piping input does not silently cost you
 * the clarification loop.
 *
 * Exit codes: 0 validated · 2 partial · 3 rejected · 1 error.
 * In folder mode the worst status across all inputs is returned.
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { LlmHttpError } from "./llm/internalClient.js";
import { openClarificationIO, silentIO } from "./io/clarification.js";
import { createLlmClient } from "./llm/routingClient.js";
import { probeLlm } from "./llm/probe.js";
import type { LlmClient } from "./llm/client.js";
import { loadEnvFile } from "./io/env.js";
import {
  discoverInputs,
  isDirectory,
  loadInputFromClipboard,
  loadInputFromFile,
  loadInputFromStdin,
  normalizeInputPath,
  resolveInputPath,
  textInput,
  type InputPayload,
} from "./io/input.js";
import {
  runPreprocessor,
  type ClarificationIO,
  type PreprocessResult,
} from "./pipeline/run.js";
import type { Workflow } from "./schema/workflow.js";

/**
 * The package root, resolved from this module rather than the working
 * directory: `--inbox` and the double-clickable launcher must find the same
 * folders no matter where they are invoked from. Both `src/cli.ts` and
 * `dist/cli.js` sit one level below the root.
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INBOX_DIR = join(PACKAGE_ROOT, "inbox");
const RESULTS_DIR = join(PACKAGE_ROOT, "results");
const PROCESSED_DIR = join(INBOX_DIR, "processed");

/** The inbox's own instruction file is not something a user dropped there. */
const INBOX_INSTRUCTIONS = ["README.txt", "README.md"];

const USAGE = `workflow-preprocessor — turn a flowchart image or free-text process description into a validated workflow schema.

Usage:
  workflow-preprocessor --inbox                everything dropped in inbox/ (see below)
  workflow-preprocessor <file>                 image or text; modality detected from content
  workflow-preprocessor <folder> --out-dir <d> every input in the folder
  workflow-preprocessor --text "<description>" inline text
  workflow-preprocessor --clipboard            image or text from the clipboard
  cat notes.md | workflow-preprocessor         piped stdin (or an explicit "-")

Inbox mode is the no-typing route: drag flowchart images or .txt/.md
descriptions into inbox/, then run it (or double-click "Process workflows"
in Finder). Results are written to results/ and each consumed input is moved
to inbox/processed/ so the folder is a queue, not a pile. --keep leaves the
inputs where they are.

Options:
  --inbox                 Process everything in inbox/ into results/
  --keep                  In inbox mode, do not move inputs to inbox/processed/
  --text <s>              Inline workflow description instead of a file
  --clipboard             Read the input from the system clipboard
  --out <file>            Write the result JSON to a file (single input only)
  --out-dir <dir>         Write one <name>.json per input (required for folders)
  --check                 Verify the LLM configuration and exit; makes no other calls
  --max-rounds <n>        Clarification round cap (default 10)
  --endpoint <url>        LLM endpoint override (else LLM_ENDPOINT)
  --model <id>            Model override (else LLM_MODEL)
  --vision-model <id>     Vision model override (else LLM_VISION_MODEL)
  --vision-endpoint <url> Vision endpoint override (else LLM_VISION_ENDPOINT)
  --env <file>            Load this env file instead of searching for .env
  --no-env                Do not load any .env file
  --no-interactive        Skip clarification; thin input yields a partial result
  -h, --help              Show this help

Configuration is read from the environment, and from the nearest .env file
(searching upward from the current directory) for anything not already set:

  LLM_ENDPOINT    required   base URL, e.g. https://llm.internal.example/v1
                             ("/chat/completions" is appended when absent)
  LLM_API_KEY     optional   sent as "Authorization: Bearer <key>"
  LLM_MODEL       required   model / deployment name (unless --model)
  LLM_MAX_TOKENS  optional   max output tokens per call (default 8192)
  LLM_JSON_MODE   optional   set to "off" if the endpoint rejects response_format

Optional vision/text split — routes the calls that include an image (triage +
normalization of flowchart images) to a VLM and everything else to the cheaper
main model. Activates when any of these is set; unset values fall back to the
main setting above:
  LLM_VISION_MODEL     model / deployment for image-processing calls
  LLM_VISION_ENDPOINT  endpoint for those calls (default: LLM_ENDPOINT)
  LLM_VISION_API_KEY   key for those calls (default: LLM_API_KEY)

A starting .env:
  LLM_ENDPOINT=https://llm.internal.example/v1
  LLM_API_KEY=…
  LLM_MODEL=your-deployment-name`;

interface CliArgs {
  file?: string;
  text?: string;
  clipboard: boolean;
  stdin: boolean;
  inbox: boolean;
  keep: boolean;
  out?: string;
  outDir?: string;
  check: boolean;
  maxRounds?: number;
  endpoint?: string;
  model?: string;
  visionEndpoint?: string;
  visionModel?: string;
  envFile?: string;
  loadEnv: boolean;
  interactive: boolean;
}

/** Read the value that follows a flag, failing clearly when it is missing. */
function value(argv: string[], i: number, flag: string): string {
  const next = argv[i];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${flag} expects a value`);
  }
  return next;
}

/** Parse argv. Returns null when help was requested — main prints the usage. */
function parseArgs(argv: string[]): CliArgs | null {
  const args: CliArgs = {
    clipboard: false,
    stdin: false,
    inbox: false,
    keep: false,
    check: false,
    loadEnv: true,
    interactive: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        return null;
      case "--text":
        args.text = value(argv, ++i, "--text");
        break;
      case "--clipboard":
        args.clipboard = true;
        break;
      case "--inbox":
        args.inbox = true;
        break;
      case "--keep":
        args.keep = true;
        break;
      case "--out":
        args.out = value(argv, ++i, "--out");
        break;
      case "--out-dir":
        args.outDir = value(argv, ++i, "--out-dir");
        break;
      case "--check":
        args.check = true;
        break;
      case "--max-rounds": {
        const raw = value(argv, ++i, "--max-rounds");
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`--max-rounds expects a non-negative integer, got "${raw}"`);
        }
        args.maxRounds = n;
        break;
      }
      case "--endpoint":
        args.endpoint = value(argv, ++i, "--endpoint");
        break;
      case "--model":
        args.model = value(argv, ++i, "--model");
        break;
      case "--vision-endpoint":
        args.visionEndpoint = value(argv, ++i, "--vision-endpoint");
        break;
      case "--vision-model":
        args.visionModel = value(argv, ++i, "--vision-model");
        break;
      case "--env":
        args.envFile = value(argv, ++i, "--env");
        break;
      case "--no-env":
        args.loadEnv = false;
        break;
      case "--no-interactive":
        args.interactive = false;
        break;
      case "-":
        args.stdin = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option "${arg}"`);
        if (args.file) throw new Error("only one input file or folder may be given");
        args.file = arg;
    }
  }
  return args;
}

/** One resolved input, ready to run. */
interface NamedInput {
  /** What to show the user and what to name the output file. */
  label: string;
  payload: InputPayload;
  /** Source file, when the input came from one. Inbox mode archives it. */
  path?: string;
}

/**
 * Turn the arguments into the list of inputs to process. Exactly one source
 * must be selected; when none is given explicitly and stdin is a pipe, stdin
 * is used, which is what makes `cat notes.md | workflow-preprocessor` work.
 */
async function resolveInputs(args: CliArgs): Promise<NamedInput[]> {
  const sources = [
    args.file !== undefined,
    args.text !== undefined,
    args.clipboard,
    args.stdin,
    args.inbox,
  ].filter(Boolean).length;

  if (sources > 1) {
    throw new Error(
      "give exactly one input source — --inbox, a file/folder, --text, --clipboard, or piped stdin",
    );
  }

  if (args.inbox) {
    mkdirSync(INBOX_DIR, { recursive: true });
    // An empty inbox is a normal state, not an error — main() explains it.
    // Discovered paths are exact filesystem paths; do not re-clean them.
    return discoverInputs(INBOX_DIR, {
      exclude: INBOX_INSTRUCTIONS,
      normalize: false,
    }).map((file) => ({
      label: basename(file),
      payload: loadInputFromFile(file, { normalize: false }),
      path: file,
    }));
  }

  if (args.text !== undefined) {
    return [{ label: "inline text", payload: textInput(args.text) }];
  }
  if (args.clipboard) {
    return [{ label: "clipboard", payload: loadInputFromClipboard() }];
  }
  if (args.stdin) {
    return [{ label: "stdin", payload: await loadInputFromStdin() }];
  }

  if (args.file !== undefined) {
    // Normalized exactly once here; loadInputFromFile must not clean it again.
    const path = normalizeInputPath(args.file);
    if (!isDirectory(path)) {
      return [
        { label: basename(path), payload: loadInputFromFile(path, { normalize: false }) },
      ];
    }
    const files = discoverInputs(path, { normalize: false });
    if (files.length === 0) {
      throw new Error(
        `no images or text files found in ${resolveInputPath(path)} — supported: .png .jpg .jpeg .webp .gif .txt .md`,
      );
    }
    return files.map((file) => ({
      label: basename(file),
      payload: loadInputFromFile(file, { normalize: false }),
      path: file,
    }));
  }

  // Nothing named: a pipe is an input, an interactive terminal is not.
  if (!process.stdin.isTTY) {
    return [{ label: "stdin", payload: await loadInputFromStdin() }];
  }

  throw new Error("no input given");
}

function printSchemaSummary(schema: Workflow, indent = "  "): void {
  const elicited = Object.values(schema.provenance).filter(
    (p) => p === "user_elicited",
  ).length;
  console.log(`${indent}Name:       ${schema.name ?? "(unnamed)"}`);
  console.log(`${indent}Nodes:      ${schema.nodes.length}`);
  console.log(`${indent}Edges:      ${schema.edges.length}`);
  console.log(
    `${indent}Provenance: ${Object.keys(schema.provenance).length} recorded fields, ${elicited} user-elicited`,
  );
}

function printResult(result: PreprocessResult): void {
  console.log("");
  switch (result.status) {
    case "validated":
      console.log("✔ Validated workflow schema (no open gaps).");
      printSchemaSummary(result.schema);
      break;
    case "partial":
      console.log(`◐ Partial workflow schema — ${result.reason}.`);
      printSchemaSummary(result.schema);
      if (result.openQuestions.length > 0) {
        console.log(`  Open questions (${result.openQuestions.length}):`);
        for (const q of result.openQuestions) {
          console.log(`   - [${q.id}] ${q.text}`);
        }
      }
      break;
    case "rejected":
      console.log(`✘ Input rejected: ${result.reason}`);
      break;
  }
}

/**
 * Output filename for an input, unique within the run. In inbox mode
 * `existingDir` is also given, so a result from an earlier run is never
 * clobbered — the inbox consumes each input exactly once, and its archived
 * copy is preserved the same way. Explicit `--out-dir` runs deliberately do
 * overwrite: re-running over a fixed folder should refresh it, not pile up.
 */
function outputNameFor(
  label: string,
  taken: Set<string>,
  existingDir?: string,
): string {
  const stem = basename(label, extname(label)) || "input";
  const clashes = (name: string): boolean =>
    taken.has(name) || (existingDir !== undefined && existsSync(join(existingDir, name)));

  let name = `${stem}.json`;
  for (let n = 2; clashes(name); n++) name = `${stem}-${n}.json`;
  taken.add(name);
  return name;
}

/**
 * Move a consumed input out of the inbox, so the folder always shows what is
 * still waiting. Never overwrites: dropping the same filename twice keeps both
 * copies. A failure here is reported but does not fail the run — the result
 * JSON is already written and is the thing that matters.
 */
function archiveInput(path: string): string | undefined {
  mkdirSync(PROCESSED_DIR, { recursive: true });
  const ext = extname(path);
  const stem = basename(path, ext);
  let target = join(PROCESSED_DIR, `${stem}${ext}`);
  for (let n = 2; existsSync(target); n++) {
    target = join(PROCESSED_DIR, `${stem}-${n}${ext}`);
  }
  try {
    renameSync(path, target);
    return target;
  } catch (err) {
    console.error(
      `  (could not move ${basename(path)} to inbox/processed/: ${err instanceof Error ? err.message : err})`,
    );
    return undefined;
  }
}

/** Blank values count as unset, mirroring createLlmClient's resolution. */
function configured(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? undefined : trimmed;
}

/** `--check`: report the resolved configuration, then probe each route. */
async function runCheck(args: CliArgs): Promise<number> {
  const endpoint = configured(args.endpoint) ?? configured(process.env.LLM_ENDPOINT);
  const model = configured(args.model) ?? configured(process.env.LLM_MODEL);
  const key = configured(process.env.LLM_API_KEY);
  const visionModel =
    configured(args.visionModel) ?? configured(process.env.LLM_VISION_MODEL);
  const visionEndpoint =
    configured(args.visionEndpoint) ?? configured(process.env.LLM_VISION_ENDPOINT);
  const visionKey = configured(process.env.LLM_VISION_API_KEY);
  // Routing activates when ANY vision setting is present (createLlmClient),
  // so the probe must key off the same condition — a setup with only
  // LLM_VISION_ENDPOINT set still routes images there and must be checked.
  const visionConfigured = Boolean(visionModel || visionEndpoint || visionKey);

  console.log("Configuration");
  console.log(`  endpoint:  ${endpoint ?? "(not set)"}`);
  console.log(`  model:     ${model ?? "(not set)"}`);
  console.log(`  api key:   ${key ? `set (…${key.slice(-4)})` : "(not set)"}`);
  console.log(
    `  vision:    ${
      visionConfigured
        ? `${visionModel ?? model ?? "(not set)"} @ ${visionEndpoint ?? endpoint ?? "(not set)"}${visionKey ? " (separate key)" : ""}`
        : "(not configured — images go to the main model)"
    }`,
  );

  let llm: LlmClient;
  try {
    llm = createLlmClient({
      endpoint: args.endpoint,
      model: args.model,
      visionEndpoint: args.visionEndpoint,
      visionModel: args.visionModel,
    });
  } catch (err) {
    console.error(`\n✘ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  console.log("\nProbing…");
  const text = await probeLlm(llm);
  console.log(`  ${text.ok ? "✔" : "✘"} text model — ${text.detail}`);
  if (text.hint) console.log(`      → ${text.hint}`);

  let visionOk = true;
  if (visionConfigured) {
    const vision = await probeLlm(llm, { withImage: true });
    visionOk = vision.ok;
    console.log(`  ${vision.ok ? "✔" : "✘"} vision model — ${vision.detail}`);
    if (vision.hint) console.log(`      → ${vision.hint}`);
  }

  const ok = text.ok && visionOk;
  console.log(ok ? "\n✔ Ready to run." : "\n✘ Configuration is not usable yet.");
  return ok ? 0 : 1;
}

async function main(): Promise<number> {
  let args: CliArgs | null;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : err}\n`);
    console.error("Run with --help for usage.");
    return 1;
  }
  if (args === null) {
    console.log(USAGE);
    return 0;
  }

  if (args.loadEnv) {
    try {
      const loaded = loadEnvFile(args.envFile);
      if (loaded && loaded.applied.length > 0) {
        console.log(
          `Loaded ${loaded.applied.length} variable(s) from ${loaded.path}` +
            (loaded.skipped.length > 0
              ? ` (${loaded.skipped.join(", ")} already set in the environment — using those)`
              : ""),
        );
      }
    } catch (err) {
      console.error(`${err instanceof Error ? err.message : err}`);
      return 1;
    }
  }

  if (args.check) return runCheck(args);

  const noSourceGiven =
    args.file === undefined &&
    args.text === undefined &&
    !args.clipboard &&
    !args.stdin &&
    !args.inbox;
  if (noSourceGiven && process.stdin.isTTY) {
    console.error(USAGE);
    return 1;
  }

  // Inbox mode names its own destination, so the folder is the whole interface.
  if (args.inbox && !args.outDir && !args.out) args.outDir = RESULTS_DIR;

  let inputs: NamedInput[];
  try {
    inputs = await resolveInputs(args);
  } catch (err) {
    console.error(`Could not read input: ${err instanceof Error ? err.message : err}`);
    return 1;
  }

  if (args.inbox && inputs.length === 0) {
    console.log(
      [
        "The inbox is empty.",
        "",
        `Drag flowchart images (.png .jpg .jpeg .webp .gif) or descriptions (.txt .md) into:`,
        `  ${INBOX_DIR}`,
        "",
        "then run this again.",
      ].join("\n"),
    );
    return 0;
  }

  if (args.out && inputs.length > 1) {
    console.error(
      `--out writes a single file but ${inputs.length} inputs were found; use --out-dir instead.`,
    );
    return 1;
  }
  if (inputs.length > 1 && !args.outDir) {
    console.error(
      `${inputs.length} inputs found — pass --out-dir <dir> to say where the results should go.`,
    );
    return 1;
  }

  if (args.inbox) {
    console.log(
      `Found ${inputs.length} input(s) in the inbox: ${inputs.map((i) => i.label).join(", ")}`,
    );
  }

  let llm: LlmClient;
  try {
    llm = createLlmClient({
      endpoint: args.endpoint,
      model: args.model,
      visionEndpoint: args.visionEndpoint,
      visionModel: args.visionModel,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(
      "Set LLM_ENDPOINT and LLM_MODEL (a .env file works too), then re-run with --check to verify.",
    );
    return 1;
  }

  const interactive = args.interactive ? openClarificationIO() : null;
  if (args.interactive && !interactive) {
    console.log(
      "No terminal available for questions — continuing non-interactively; thin input will come back partial.",
    );
  }
  const io = interactive?.io ?? silentIO;

  if (args.outDir) mkdirSync(args.outDir, { recursive: true });
  const takenNames = new Set<string>();
  const statuses: PreprocessResult["status"][] = [];

  try {
    for (const [index, input] of inputs.entries()) {
      const kind = input.payload.kind === "image" ? "image" : "text";
      if (inputs.length > 1) {
        console.log(
          `\n${"─".repeat(60)}\n[${index + 1}/${inputs.length}] ${input.label} (${kind})`,
        );
      } else {
        console.log(`Preprocessing ${kind} input from ${input.label}…`);
      }

      let result: PreprocessResult;
      try {
        result = await runPreprocessor(llm, input.payload, io, {
          maxRounds: args.maxRounds,
        });
      } catch (err) {
        // One bad input should not abandon the rest of a folder.
        reportRunError(err);
        if (inputs.length === 1) return 1;
        statuses.push("rejected");
        continue;
      }

      printResult(result);
      statuses.push(result.status);

      const json = JSON.stringify(result, null, 2);
      const target = args.outDir
        ? join(
            args.outDir,
            outputNameFor(input.label, takenNames, args.inbox ? args.outDir : undefined),
          )
        : args.out;

      if (target) {
        writeFileSync(target, json + "\n", "utf8");
        console.log(`\nResult written to ${target}`);
      } else if (result.status !== "rejected") {
        console.log("\nFull result JSON:\n");
        console.log(json);
      }

      // Archive only after a terminal state was reached and written. An input
      // whose run threw took the `continue` above and stays in the inbox to be
      // retried once the cause (usually the endpoint) is fixed.
      if (args.inbox && !args.keep && input.path) {
        const moved = archiveInput(input.path);
        if (moved) console.log(`Moved ${input.label} to inbox/processed/`);
      }
    }
  } finally {
    interactive?.close();
  }

  if (inputs.length > 1) printBatchSummary(inputs, statuses);

  if (statuses.includes("rejected")) return 3;
  if (statuses.includes("partial")) return 2;
  return 0;
}

function printBatchSummary(
  inputs: NamedInput[],
  statuses: PreprocessResult["status"][],
): void {
  const mark = { validated: "✔", partial: "◐", rejected: "✘" } as const;
  const width = Math.max(...inputs.map((i) => i.label.length));
  console.log(`\n${"─".repeat(60)}\nSummary`);
  for (const [i, input] of inputs.entries()) {
    console.log(`  ${mark[statuses[i]]} ${input.label.padEnd(width)}  ${statuses[i]}`);
  }
  const counts = statuses.reduce<Record<string, number>>(
    (acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }),
    {},
  );
  console.log(
    `  ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(" · ")}`,
  );
}

function reportRunError(err: unknown): void {
  if (err instanceof LlmHttpError && (err.status === 401 || err.status === 403)) {
    console.error(
      `\nAuthentication with the LLM endpoint failed (HTTP ${err.status}). Check LLM_API_KEY, or run --check.`,
    );
  } else if (err instanceof LlmHttpError) {
    console.error(`\n${err.message}`);
  } else {
    console.error(`\nUnexpected error: ${err instanceof Error ? err.stack : err}`);
  }
}

// Set the exit code instead of calling process.exit(): on Windows, stdout
// writes to the console and to pipes are asynchronous, and process.exit()
// can truncate output that has not flushed yet (the result JSON, the usage
// text). Everything main() opens is closed by the time it resolves, so the
// process exits on its own with this code.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
