/**
 * The narrator CLI (loaded by `./cli.ts`).
 *
 *   workflow-narrator <recommendations.json> [options]   # one recommender result
 *   workflow-narrator <folder> [options]                 # every *.recommendations.json
 *
 * The input is the JSON the recommender wrote. By default the report is
 * written next to the input as `<stem>.report.md` (`re.recommendations.json`
 * → `re.report.md`). Step names come from the preprocessor result the
 * recommender consumed, found via `--workflow`, the result's `source.path`,
 * or the sibling `<stem>.json` — and ids are used honestly when none is
 * found.
 *
 * Exit codes: 0 complete · 2 model summary fell back to deterministic ·
 * 3 the input was unsuitable (a notice was written) · 1 error.
 * In folder mode the worst status across all inputs is returned.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  createLlmClient,
  loadEnvFile,
  probeLlm,
  LlmHttpError,
  type LlmClient,
} from "workflow-preprocessor";
import { hasBody, loadRecommendation } from "./schema/input.js";
import { RECOMMENDATIONS_SUFFIX, resolveWorkflow } from "./io/workflow.js";
import { narrate, DEFAULT_TOP } from "./pipeline/run.js";
import type { Narration } from "./schema/narration.js";

const REPORT_SUFFIX = ".report.md";

const USAGE = `workflow-narrator — turn a recommender result JSON into a coherent, human-readable report: a deterministic body with a model-written summary on top.

Usage:
  workflow-narrator <recommendations.json>     one recommender result JSON
  workflow-narrator <folder>                   every *${RECOMMENDATIONS_SUFFIX} in the folder

Options:
  --out <file>            Write the report here (single input only)
  --out-dir <dir>         Write one <stem>${REPORT_SUFFIX} per input
                          (default: next to each input)
  --workflow <file>       The preprocessor result JSON with the step names
                          (default: the input's source.path, else <stem>.json
                          next to it; ids are used when neither is found)
  --top <n>               Opportunities written up in full (default ${DEFAULT_TOP});
                          the rest are listed in a table
  --no-llm                Deterministic report only — no model summary
  --check                 Verify the LLM configuration and exit
  --endpoint <url>        LLM endpoint override (else LLM_ENDPOINT)
  --model <id>            Model override (else LLM_MODEL)
  --env <file>            Load this env file instead of searching for .env
  --no-env                Do not load any .env file
  -h, --help              Show this help

Configuration is read from the environment, and from the nearest .env file
(searching upward from the current directory) for anything not already set:

  LLM_ENDPOINT    required   base URL, e.g. https://llm.internal.example/v1
  LLM_API_KEY     optional   sent as "Authorization: Bearer <key>"
  LLM_MODEL       required   model / deployment name (unless --model)

With --no-llm no configuration is needed at all.`;

interface CliArgs {
  input?: string;
  out?: string;
  outDir?: string;
  workflow?: string;
  top?: number;
  useLlm: boolean;
  check: boolean;
  endpoint?: string;
  model?: string;
  envFile?: string;
  loadEnv: boolean;
}

function value(argv: string[], i: number, flag: string): string {
  const next = argv[i];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${flag} expects a value`);
  }
  return next;
}

function parseArgs(argv: string[]): CliArgs | null {
  const args: CliArgs = { useLlm: true, check: false, loadEnv: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        return null;
      case "--out":
        args.out = value(argv, ++i, "--out");
        break;
      case "--out-dir":
        args.outDir = value(argv, ++i, "--out-dir");
        break;
      case "--workflow":
        args.workflow = value(argv, ++i, "--workflow");
        break;
      case "--top": {
        const raw = value(argv, ++i, "--top");
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`--top expects a non-negative integer, got "${raw}"`);
        }
        args.top = n;
        break;
      }
      case "--no-llm":
        args.useLlm = false;
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
      case "--env":
        args.envFile = value(argv, ++i, "--env");
        break;
      case "--no-env":
        args.loadEnv = false;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option "${arg}"`);
        if (args.input) throw new Error("only one input file or folder may be given");
        args.input = arg;
    }
  }
  return args;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Input files in a folder: the recommender's outputs, sorted. */
function discoverRecommendations(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.endsWith(RECOMMENDATIONS_SUFFIX))
    .sort()
    .map((name) => join(folder, name));
}

/** `re.recommendations.json` → `re`; `other.json` → `other`. */
function stemOf(inputPath: string): string {
  const name = basename(inputPath);
  if (name.endsWith(RECOMMENDATIONS_SUFFIX)) return name.slice(0, -RECOMMENDATIONS_SUFFIX.length);
  return name.replace(/\.json$/i, "");
}

function outputPathFor(inputPath: string, args: CliArgs): string {
  if (args.out) return args.out;
  const dir = args.outDir ?? dirname(inputPath);
  return join(dir, `${stemOf(inputPath)}${REPORT_SUFFIX}`);
}

function printResult(narration: Narration): void {
  console.log("");
  const name = narration.source.workflowName ?? "(unnamed workflow)";
  switch (narration.status) {
    case "complete":
      console.log(
        narration.summary?.kind === "model"
          ? `✔ Report for "${name}" — model summary on top of the deterministic body.`
          : `✔ Report for "${name}" — deterministic body and summary (no model summary requested).`,
      );
      break;
    case "fallback":
      console.log(
        `◐ Report for "${name}" — the deterministic body is complete, but ${narration.summary?.kind === "deterministic" ? narration.summary.reason : "the model summary was unavailable"}.`,
      );
      break;
    case "notice":
      console.log(`✘ Nothing to narrate: the recommender result was unsuitable. A notice explaining why was written.`);
      return;
  }
  console.log(
    narration.source.workflowPath
      ? `  Step names from ${basename(narration.source.workflowPath)}`
      : "  Step names: not found — steps are referred to by id (pass --workflow <file> to fix this)",
  );
}

async function runCheck(args: CliArgs): Promise<number> {
  const configured = (v: string | undefined): string | undefined => {
    const trimmed = (v ?? "").trim();
    return trimmed === "" ? undefined : trimmed;
  };
  const endpoint = configured(args.endpoint) ?? configured(process.env.LLM_ENDPOINT);
  const model = configured(args.model) ?? configured(process.env.LLM_MODEL);
  const key = configured(process.env.LLM_API_KEY);

  console.log("Configuration");
  console.log(`  endpoint:  ${endpoint ?? "(not set)"}`);
  console.log(`  model:     ${model ?? "(not set)"}`);
  console.log(`  api key:   ${key ? `set (…${key.slice(-4)})` : "(not set)"}`);

  let llm: LlmClient;
  try {
    llm = createLlmClient({ endpoint: args.endpoint, model: args.model });
  } catch (err) {
    console.error(`\n✘ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  console.log("\nProbing…");
  const probe = await probeLlm(llm);
  console.log(`  ${probe.ok ? "✔" : "✘"} text model — ${probe.detail}`);
  if (probe.hint) console.log(`      → ${probe.hint}`);
  console.log(probe.ok ? "\n✔ Ready to run." : "\n✘ Configuration is not usable yet (the deterministic report still works with --no-llm).");
  return probe.ok ? 0 : 1;
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

  if (args.loadEnv && (args.useLlm || args.check)) {
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

  if (!args.input) {
    console.error(USAGE);
    return 1;
  }

  const inputPath = resolve(args.input);
  let inputs: string[];
  if (isDirectory(inputPath)) {
    inputs = discoverRecommendations(inputPath);
    if (inputs.length === 0) {
      console.error(`no recommender result *${RECOMMENDATIONS_SUFFIX} files found in ${inputPath}`);
      return 1;
    }
  } else {
    inputs = [inputPath];
  }
  if (args.out && inputs.length > 1) {
    console.error(
      `--out writes a single file but ${inputs.length} inputs were found; use --out-dir instead.`,
    );
    return 1;
  }
  if (args.workflow && inputs.length > 1) {
    console.error(
      `--workflow names a single preprocessor result but ${inputs.length} inputs were found; rely on source.path or the sibling <stem>.json instead.`,
    );
    return 1;
  }

  let llm: LlmClient | null = null;
  if (args.useLlm) {
    try {
      llm = createLlmClient({ endpoint: args.endpoint, model: args.model });
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      console.error(
        "Set LLM_ENDPOINT and LLM_MODEL (a .env file works too), then re-run with --check to verify — or pass --no-llm for the deterministic report alone.",
      );
      return 1;
    }
  }

  if (args.outDir) mkdirSync(args.outDir, { recursive: true });
  const statuses: Narration["status"][] = [];
  const labels: string[] = [];

  for (const [index, path] of inputs.entries()) {
    const label = basename(path);
    if (inputs.length > 1) {
      console.log(`\n${"─".repeat(60)}\n[${index + 1}/${inputs.length}] ${label}`);
    } else {
      console.log(`Narrating ${label}…`);
    }

    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`  Skipping ${label}: not readable JSON (${err instanceof Error ? err.message : err})`);
      if (inputs.length === 1) return 1;
      continue;
    }

    let narration: Narration;
    try {
      // Validate first so the workflow lookup can use the result's own hints.
      const loaded = loadRecommendation(json);
      const resolved = resolveWorkflow({
        explicitPath: args.workflow,
        inputPath: path,
        sourcePath: hasBody(loaded) ? loaded.source.path : undefined,
        requiredNodeIds: hasBody(loaded) ? loaded.profiles.map((p) => p.nodeId) : [],
      });
      narration = await narrate(llm, json, {
        workflow: resolved?.workflow ?? null,
        workflowPath: resolved?.path ?? null,
        top: args.top,
        inputLabel: label,
      });
    } catch (err) {
      if (err instanceof Error && /not a recommender result|workflow file/.test(err.message)) {
        console.error(`  Skipping ${label}: ${err.message}`);
        if (inputs.length === 1) return 1;
        continue;
      }
      // One bad input should not abandon the rest of a folder.
      reportRunError(err);
      if (inputs.length === 1) return 1;
      statuses.push("fallback");
      labels.push(label);
      continue;
    }

    printResult(narration);
    if (narration.status === "fallback" && llm !== null) {
      console.log("  Re-run once the endpoint is reachable to add the model summary; the deterministic report is complete as written.");
    }
    statuses.push(narration.status);
    labels.push(label);

    const target = outputPathFor(path, args);
    writeFileSync(target, narration.report, "utf8");
    console.log(`\nReport written to ${target}`);
  }

  if (statuses.length === 0) return 1; // every folder entry was skipped
  if (labels.length > 1) {
    const mark = { complete: "✔", fallback: "◐", notice: "✘" } as const;
    const width = Math.max(...labels.map((l) => l.length));
    console.log(`\n${"─".repeat(60)}\nSummary`);
    for (const [i, label] of labels.entries()) {
      console.log(`  ${mark[statuses[i]]} ${label.padEnd(width)}  ${statuses[i]}`);
    }
  }

  if (statuses.includes("notice")) return 3;
  if (statuses.includes("fallback")) return 2;
  return 0;
}
