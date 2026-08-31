/**
 * The pipeline CLI (loaded by `./cli.ts`).
 *
 *   workflow-pipeline --inbox                        # everything dropped in inbox/ (see below)
 *   workflow-pipeline <file> [options]               # image or text; modality from content
 *   workflow-pipeline <folder> --out-dir <d>         # every input in the folder
 *   workflow-pipeline --text "<description>"
 *   workflow-pipeline --clipboard
 *   … | workflow-pipeline                            # piped stdin
 *
 * One input in, the report out — or a folder of inputs in, one report each.
 * The three stages run back to back; the two clarification loops stay
 * interactive through the same terminal IO the siblings use (including the
 * console-device fallback when stdin is a pipe), with a banner when the
 * questions change subject.
 *
 * Inbox mode is the no-typing route, mirroring the preprocessor's: drag
 * files into inbox/, run this (or double-click "Make improvement reports"),
 * and one <name>.report.md per input lands in reports/ while each consumed
 * input is moved to inbox/processed/ — the folder is a queue, not a pile.
 * --keep leaves the inputs where they are.
 *
 * The report goes to `<stem>.report.md` next to a single file input, and to
 * stdout for inline text, the clipboard and stdin; `--out` overrides either,
 * `--out-dir` collects batch output, and `--json` (single input only)
 * additionally writes the whole result — report, schema, recommendations,
 * every stage's status — as one JSON document, which is exactly what a web
 * backend would return.
 *
 * Exit codes: 0 complete · 2 fallback (model summary unavailable) ·
 * 3 notice (nothing to recommend on) · 1 error.
 * In batch mode the worst outcome across all inputs is returned
 * (error > notice > fallback > complete).
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import {
  createLlmClient,
  discoverInputs,
  isDirectory,
  loadEnvFile,
  loadInputFromClipboard,
  loadInputFromFile,
  loadInputFromStdin,
  normalizeInputPath,
  openClarificationIO,
  probeLlm,
  resolveInputPath,
  silentIO,
  textInput,
  LlmHttpError,
  type InputPayload,
  type LlmClient,
} from "workflow-preprocessor";
import { stagedIO } from "./io/clarification.js";
import {
  PipelineStageError,
  runPipeline,
  type PipelineClarificationIO,
  type PipelineProgress,
  type PipelineResult,
} from "./pipeline/run.js";

const REPORT_SUFFIX = ".report.md";

/**
 * The package root, resolved from this module rather than the working
 * directory: `--inbox` and the double-clickable launchers must find the same
 * folders no matter where they are invoked from. Both `src/cli.ts` and
 * `dist/cli.js` sit one level below the root.
 */
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INBOX_DIR = join(PACKAGE_ROOT, "inbox");
const REPORTS_DIR = join(PACKAGE_ROOT, "reports");
const PROCESSED_DIR = join(INBOX_DIR, "processed");

/** The inbox's own instruction file is not something a user dropped there. */
const INBOX_INSTRUCTIONS = ["README.txt", "README.md"];

const USAGE = `workflow-pipeline — a flowchart image or free-text process description in, an improvement report out: preprocessor → recommender → narrator in one run.

Usage:
  workflow-pipeline --inbox                    everything dropped in inbox/ (see below)
  workflow-pipeline <file>                     image or text; modality detected from content
  workflow-pipeline <folder> --out-dir <d>     every input in the folder
  workflow-pipeline --text "<description>"     inline text
  workflow-pipeline --clipboard                image or text from the clipboard
  cat notes.md | workflow-pipeline             piped stdin (or an explicit "-")

Inbox mode is the no-typing route: drag flowchart images or .txt/.md
descriptions into inbox/, then run it (or double-click "Make improvement
reports" in Finder/Explorer). One <name>.report.md per input is written to
reports/ and each consumed input is moved to inbox/processed/, so the folder
is a queue, not a pile. --keep leaves the inputs where they are.

Options:
  --inbox                 Process everything in inbox/ into reports/
  --keep                  In inbox mode, do not move inputs to inbox/processed/
  --out <file>            Write the report here ("-" for stdout). Default: <stem>${REPORT_SUFFIX}
                          next to a file input; stdout for --text, --clipboard and stdin
  --out-dir <dir>         Write one <name>${REPORT_SUFFIX} per input (required for folders)
  --json <file>           Also write the full result — report, workflow schema,
                          recommendations, every stage's status — as JSON (single input only)
  --top <n>               Opportunities written up in full in the report (default 5)
  --max-rounds <n>        Clarification round cap, per stage (default 10)
  --no-interactive        Ask no questions; thin input yields a partial analysis
                          (the report is still complete, and says what is uncertain)
  --no-summary            Skip the model-written summary; deterministic report only
  --check                 Verify the LLM configuration and exit; makes no other calls
  --endpoint <url>        LLM endpoint override (else LLM_ENDPOINT)
  --model <id>            Model override (else LLM_MODEL)
  --vision-model <id>     Vision model override (else LLM_VISION_MODEL)
  --vision-endpoint <url> Vision endpoint override (else LLM_VISION_ENDPOINT)
  --env <file>            Load this env file instead of searching for .env
  --no-env                Do not load any .env file
  -h, --help              Show this help

Configuration is read from the environment, and from the nearest .env file
(searching upward from the current directory) for anything not already set:

  LLM_ENDPOINT    required   base URL, e.g. https://llm.internal.example/v1
                             ("/chat/completions" is appended when absent)
  LLM_API_KEY     optional   sent as "Authorization: Bearer <key>"
  LLM_MODEL       required   model / deployment name (unless --model)
  LLM_MAX_TOKENS  optional   max output tokens per call (default 8192)
  LLM_JSON_MODE   optional   set to "off" if the endpoint rejects response_format

Optional vision/text split — routes the two preprocessor calls that include
an image to a VLM and everything else to the main model:
  LLM_VISION_MODEL     model / deployment for image-processing calls
  LLM_VISION_ENDPOINT  endpoint for those calls (default: LLM_ENDPOINT)
  LLM_VISION_API_KEY   key for those calls (default: LLM_API_KEY)

Exit codes: 0 complete · 2 fallback · 3 notice · 1 error`;

interface CliArgs {
  file?: string;
  text?: string;
  clipboard: boolean;
  stdin: boolean;
  inbox: boolean;
  keep: boolean;
  out?: string;
  outDir?: string;
  json?: string;
  top?: number;
  maxRounds?: number;
  interactive: boolean;
  summary: boolean;
  check: boolean;
  endpoint?: string;
  model?: string;
  visionEndpoint?: string;
  visionModel?: string;
  envFile?: string;
  loadEnv: boolean;
}

function value(argv: string[], i: number, flag: string): string {
  const next = argv[i];
  if (next === undefined || (next.startsWith("--") && next !== "-")) {
    throw new Error(`${flag} expects a value`);
  }
  return next;
}

function integer(argv: string[], i: number, flag: string): number {
  const raw = value(argv, i, flag);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`${flag} expects a non-negative integer, got "${raw}"`);
  }
  return n;
}

/** Parse argv. Returns null when help was requested — main prints the usage. */
function parseArgs(argv: string[]): CliArgs | null {
  const args: CliArgs = {
    clipboard: false,
    stdin: false,
    inbox: false,
    keep: false,
    interactive: true,
    summary: true,
    check: false,
    loadEnv: true,
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
      case "--json":
        args.json = value(argv, ++i, "--json");
        break;
      case "--top":
        args.top = integer(argv, ++i, "--top");
        break;
      case "--max-rounds":
        args.maxRounds = integer(argv, ++i, "--max-rounds");
        break;
      case "--no-interactive":
        args.interactive = false;
        break;
      case "--no-summary":
        args.summary = false;
        break;
      case "--check":
        args.check = true;
        break;
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
  /** What to show the user and how the report's appendix refers to it. */
  label: string;
  payload: InputPayload;
  /** Source file, when there was one. Inbox mode archives it. */
  path?: string;
}

/**
 * Turn the arguments into the list of inputs to process. Exactly one source
 * must be selected; when none is given explicitly and stdin is a pipe, stdin
 * is used, which is what makes `cat notes.md | workflow-pipeline` work.
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

  if (args.text !== undefined) return [{ label: "inline text", payload: textInput(args.text) }];
  if (args.clipboard) return [{ label: "clipboard", payload: loadInputFromClipboard() }];
  if (args.stdin) return [{ label: "stdin", payload: await loadInputFromStdin() }];

  if (args.file !== undefined) {
    // Normalized exactly once here; loadInputFromFile must not clean it again.
    const path = normalizeInputPath(args.file);
    if (!isDirectory(path)) {
      return [{ label: basename(path), payload: loadInputFromFile(path, { normalize: false }), path }];
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
  if (!process.stdin.isTTY) return [{ label: "stdin", payload: await loadInputFromStdin() }];
  throw new Error("no input given");
}

/** Where a single input's report goes: null means stdout. */
function reportTarget(input: NamedInput, args: CliArgs): string | null {
  if (args.out === "-") return null;
  if (args.out) return args.out;
  if (input.path) {
    return join(dirname(input.path), `${basename(input.path, extname(input.path))}${REPORT_SUFFIX}`);
  }
  return null;
}

/**
 * Report filename for an input, unique within the run. In inbox mode
 * `existingDir` is also given, so a report from an earlier run is never
 * clobbered — the inbox consumes each input exactly once, and its report is
 * preserved the same way. Explicit `--out-dir` runs deliberately do
 * overwrite: re-running over a fixed folder should refresh it, not pile up.
 */
function reportNameFor(label: string, taken: Set<string>, existingDir?: string): string {
  const stem = basename(label, extname(label)) || "input";
  const clashes = (name: string): boolean =>
    taken.has(name) || (existingDir !== undefined && existsSync(join(existingDir, name)));

  let name = `${stem}${REPORT_SUFFIX}`;
  for (let n = 2; clashes(name); n++) name = `${stem}-${n}${REPORT_SUFFIX}`;
  taken.add(name);
  return name;
}

/**
 * Move a consumed input out of the inbox, so the folder always shows what is
 * still waiting. Never overwrites: dropping the same filename twice keeps both
 * copies. A failure here is reported but does not fail the run — the report
 * is already written and is the thing that matters.
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

const STAGE_LINES: Record<PipelineProgress["stage"], string> = {
  preprocess: "Extracting the workflow…",
  recommend: "Finding improvement opportunities…",
  narrate: "Writing the report…",
};

function printProgress(progress: PipelineProgress): void {
  if (progress.phase === "start") console.log(`\n▸ ${STAGE_LINES[progress.stage]}`);
}

function countOpportunities(result: PipelineResult): string {
  const rec = result.recommendation;
  if (rec.status === "unsuitable") return "";
  return ` (${rec.opportunities.length} opportunit${rec.opportunities.length === 1 ? "y" : "ies"})`;
}

function printResult(result: PipelineResult): void {
  console.log("");
  const name = result.narration.source.workflowName ?? "(unnamed workflow)";
  switch (result.status) {
    case "complete":
      console.log(
        result.narration.summary?.kind === "model"
          ? `✔ Report for "${name}" — model summary on top of the deterministic body.`
          : `✔ Report for "${name}" — deterministic body and summary (no model summary requested).`,
      );
      break;
    case "fallback":
      console.log(
        `◐ Report for "${name}" — the deterministic body is complete, but ${
          result.narration.summary?.kind === "deterministic"
            ? result.narration.summary.reason
            : "the model summary was unavailable"
        }.`,
      );
      break;
    case "notice": {
      const reason =
        result.recommendation.status === "unsuitable" ? result.recommendation.reason : "unsuitable input";
      console.log(`✘ Nothing to recommend on: ${reason}. A notice explaining why was written.`);
      break;
    }
  }
  console.log(
    `  Stages: preprocessor ${result.preprocess.status} · recommender ${result.recommendation.status}${countOpportunities(result)} · narrator ${result.status}`,
  );
  if (result.preprocess.status === "partial" || result.recommendation.status === "partial") {
    console.log("  The analysis is partial — the report lists the open questions; answer them interactively to sharpen it.");
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
  const visionModel = configured(args.visionModel) ?? configured(process.env.LLM_VISION_MODEL);
  const visionEndpoint = configured(args.visionEndpoint) ?? configured(process.env.LLM_VISION_ENDPOINT);
  const visionKey = configured(process.env.LLM_VISION_API_KEY);
  // Routing activates when ANY vision setting is present (createLlmClient),
  // so the probe keys off the same condition.
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

function reportRunError(err: unknown): void {
  const cause = err instanceof PipelineStageError ? err.cause : err;
  const where = err instanceof PipelineStageError ? ` (in the ${err.stage} stage)` : "";
  if (cause instanceof LlmHttpError && (cause.status === 401 || cause.status === 403)) {
    console.error(
      `\nAuthentication with the LLM endpoint failed (HTTP ${cause.status})${where}. Check LLM_API_KEY, or run --check.`,
    );
  } else if (cause instanceof LlmHttpError) {
    console.error(`\n${cause.message}${where}`);
  } else if (cause instanceof Error && /could not reach the LLM endpoint/.test(cause.message)) {
    console.error(`\n${cause.message}${where}`);
  } else {
    console.error(`\nUnexpected error${where}: ${cause instanceof Error ? cause.stack : cause}`);
  }
  if (err instanceof PipelineStageError && err.preprocess) {
    console.error(
      `The workflow had already been extracted (${err.preprocess.status}); the run stopped before a report could be written.`,
    );
  }
}

/** A batch entry's outcome: a pipeline status, or a run that threw. */
type RunOutcome = PipelineResult["status"] | "failed";

function printBatchSummary(labels: string[], outcomes: RunOutcome[]): void {
  const mark: Record<RunOutcome, string> = { complete: "✔", fallback: "◐", notice: "✘", failed: "!" };
  const width = Math.max(...labels.map((l) => l.length));
  console.log(`\n${"─".repeat(60)}\nSummary`);
  for (const [i, label] of labels.entries()) {
    console.log(`  ${mark[outcomes[i]]} ${label.padEnd(width)}  ${outcomes[i]}`);
  }
  const counts = outcomes.reduce<Record<string, number>>(
    (acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }),
    {},
  );
  console.log(`  ${Object.entries(counts).map(([s, n]) => `${n} ${s}`).join(" · ")}`);
}

export async function main(): Promise<number> {
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
    args.file === undefined && args.text === undefined && !args.clipboard && !args.stdin && !args.inbox;
  if (noSourceGiven && process.stdin.isTTY) {
    console.error(USAGE);
    return 1;
  }

  // Inbox mode names its own destination, so the folder is the whole interface.
  if (args.inbox && !args.outDir && !args.out) args.outDir = REPORTS_DIR;

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
        "Drag flowchart images (.png .jpg .jpeg .webp .gif) or descriptions (.txt .md) into:",
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
  if (args.json && inputs.length > 1) {
    console.error(
      `--json writes a single file but ${inputs.length} inputs were found; run the inputs one at a time for JSON output.`,
    );
    return 1;
  }
  if (inputs.length > 1 && !args.outDir) {
    console.error(
      `${inputs.length} inputs found — pass --out-dir <dir> to say where the reports should go.`,
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
      "No terminal available for questions — continuing non-interactively; thin input will come back as a partial analysis.",
    );
  }

  if (args.outDir) mkdirSync(args.outDir, { recursive: true });
  const takenNames = new Set<string>();
  const outcomes: RunOutcome[] = [];
  const labels: string[] = [];

  try {
    for (const [index, input] of inputs.entries()) {
      const kind = input.payload.kind === "image" ? "image" : "text";
      if (inputs.length > 1) {
        console.log(`\n${"─".repeat(60)}\n[${index + 1}/${inputs.length}] ${input.label} (${kind})`);
      } else {
        console.log(`Running the pipeline over ${kind} input from ${input.label}…`);
      }

      // A fresh wrapper per input, so each input's first questions get their
      // subject banner again.
      const io: PipelineClarificationIO = interactive ? stagedIO(interactive.io) : silentIO;

      let result: PipelineResult;
      try {
        result = await runPipeline(llm, input.payload, {
          io,
          maxRounds: args.maxRounds,
          top: args.top,
          summary: args.summary,
          inputLabel: input.label,
          onProgress: printProgress,
        });
      } catch (err) {
        // One bad input should not abandon the rest of a batch. A failed
        // inbox input stays in the inbox to be retried once the cause
        // (usually the endpoint) is fixed.
        reportRunError(err);
        if (inputs.length === 1) return 1;
        outcomes.push("failed");
        labels.push(input.label);
        continue;
      }

      printResult(result);
      outcomes.push(result.status);
      labels.push(input.label);

      // Any --out-dir run (inbox included, single input or many) names its
      // reports here, so the inbox's never-overwrite rule holds for a lone
      // input too; --out and the default single-input destinations otherwise.
      const target =
        args.outDir && !args.out
          ? join(
              args.outDir,
              reportNameFor(input.label, takenNames, args.inbox ? args.outDir : undefined),
            )
          : reportTarget(input, args);

      if (target) {
        writeFileSync(target, result.report, "utf8");
        console.log(`\nReport written to ${target}`);
      } else {
        console.log(`\n${"─".repeat(60)}\n`);
        process.stdout.write(result.report);
      }
      if (args.json) {
        writeFileSync(args.json, JSON.stringify(result, null, 2) + "\n", "utf8");
        console.log(`Full result written to ${args.json}`);
      }

      // Archive only after the report was written. An input whose run threw
      // took the `continue` above and stays in the inbox.
      if (args.inbox && !args.keep && input.path) {
        const moved = archiveInput(input.path);
        if (moved) console.log(`Moved ${input.label} to inbox/processed/`);
      }
    }
  } finally {
    interactive?.close();
  }

  if (labels.length > 1) printBatchSummary(labels, outcomes);

  if (outcomes.includes("failed")) return 1;
  if (outcomes.includes("notice")) return 3;
  if (outcomes.includes("fallback")) return 2;
  return 0;
}
