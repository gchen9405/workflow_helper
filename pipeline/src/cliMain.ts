/**
 * The pipeline CLI (loaded by `./cli.ts`).
 *
 *   workflow-pipeline <file> [options]              # image or text; modality from content
 *   workflow-pipeline --text "<description>"
 *   workflow-pipeline --clipboard
 *   … | workflow-pipeline                            # piped stdin
 *
 * One input in, the report out. The three stages run back to back; the two
 * clarification loops stay interactive through the same terminal IO the
 * siblings use (including the console-device fallback when stdin is a
 * pipe), with a banner when the questions change subject.
 *
 * The report goes to `<stem>.report.md` next to a file input, and to stdout
 * for inline text, the clipboard and stdin; `--out` overrides either, and
 * `--json` additionally writes the whole result — report, schema,
 * recommendations, every stage's status — as one JSON document, which is
 * exactly what a web backend would return.
 *
 * Exit codes: 0 complete · 2 fallback (model summary unavailable) ·
 * 3 notice (nothing to recommend on) · 1 error.
 */
import { writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import process from "node:process";
import {
  createLlmClient,
  isDirectory,
  loadEnvFile,
  loadInputFromClipboard,
  loadInputFromFile,
  loadInputFromStdin,
  normalizeInputPath,
  openClarificationIO,
  probeLlm,
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

const USAGE = `workflow-pipeline — a flowchart image or free-text process description in, an improvement report out: preprocessor → recommender → narrator in one run.

Usage:
  workflow-pipeline <file>                     image or text; modality detected from content
  workflow-pipeline --text "<description>"     inline text
  workflow-pipeline --clipboard                image or text from the clipboard
  cat notes.md | workflow-pipeline             piped stdin (or an explicit "-")

Options:
  --out <file>            Write the report here ("-" for stdout). Default: <stem>${REPORT_SUFFIX}
                          next to a file input; stdout for --text, --clipboard and stdin
  --json <file>           Also write the full result — report, workflow schema,
                          recommendations, every stage's status — as JSON
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
  out?: string;
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
      case "--out":
        args.out = value(argv, ++i, "--out");
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
        if (args.file) throw new Error("only one input may be given — the pipeline runs one workflow at a time");
        args.file = arg;
    }
  }
  return args;
}

/** The one input to run, however it arrived. */
interface NamedInput {
  /** What to show the user and how the report's appendix refers to it. */
  label: string;
  payload: InputPayload;
  /** Source file, when there was one — the default report goes next to it. */
  path?: string;
}

/**
 * Exactly one source. When none is named and stdin is a pipe, stdin is the
 * input — what makes `cat notes.md | workflow-pipeline` work.
 */
async function resolveInput(args: CliArgs): Promise<NamedInput> {
  const sources = [
    args.file !== undefined,
    args.text !== undefined,
    args.clipboard,
    args.stdin,
  ].filter(Boolean).length;
  if (sources > 1) {
    throw new Error("give exactly one input source — a file, --text, --clipboard, or piped stdin");
  }

  if (args.text !== undefined) return { label: "inline text", payload: textInput(args.text) };
  if (args.clipboard) return { label: "clipboard", payload: loadInputFromClipboard() };
  if (args.stdin) return { label: "stdin", payload: await loadInputFromStdin() };

  if (args.file !== undefined) {
    // Normalized exactly once here; loadInputFromFile must not clean it again.
    const path = normalizeInputPath(args.file);
    if (isDirectory(path)) {
      throw new Error(
        `${path} is a folder — the pipeline takes one input at a time (for batches, run the stages' own CLIs over the folder)`,
      );
    }
    return { label: basename(path), payload: loadInputFromFile(path, { normalize: false }), path };
  }

  // Nothing named: a pipe is an input, an interactive terminal is not.
  if (!process.stdin.isTTY) return { label: "stdin", payload: await loadInputFromStdin() };
  throw new Error("no input given");
}

/** Where the report goes: null means stdout. */
function reportTarget(input: NamedInput, args: CliArgs): string | null {
  if (args.out === "-") return null;
  if (args.out) return args.out;
  if (input.path) {
    return join(dirname(input.path), `${basename(input.path, extname(input.path))}${REPORT_SUFFIX}`);
  }
  return null;
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
    args.file === undefined && args.text === undefined && !args.clipboard && !args.stdin;
  if (noSourceGiven && process.stdin.isTTY) {
    console.error(USAGE);
    return 1;
  }

  let input: NamedInput;
  try {
    input = await resolveInput(args);
  } catch (err) {
    console.error(`Could not read input: ${err instanceof Error ? err.message : err}`);
    return 1;
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
  const io: PipelineClarificationIO = interactive ? stagedIO(interactive.io) : silentIO;

  const kind = input.payload.kind === "image" ? "image" : "text";
  console.log(`Running the pipeline over ${kind} input from ${input.label}…`);

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
    reportRunError(err);
    return 1;
  } finally {
    interactive?.close();
  }

  printResult(result);

  const target = reportTarget(input, args);
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

  switch (result.status) {
    case "complete":
      return 0;
    case "fallback":
      return 2;
    case "notice":
      return 3;
  }
}
