/**
 * The recommender CLI (loaded by `./cli.ts`).
 *
 *   workflow-recommender <result.json> [options]     # one preprocessor result
 *   workflow-recommender <folder> [options]          # every *.json in a folder
 *
 * The input is the JSON the preprocessor wrote (`validated` or `partial`;
 * `rejected` maps to `unsuitable` here). By default the result is written
 * next to the input as `<stem>.recommendations.json`; those files are
 * excluded from folder discovery so re-runs never consume their own output.
 *
 * Clarification is interactive round by round through the exact same
 * terminal IO the preprocessor uses (imported from it) — including the
 * console-device fallback when stdin is a pipe.
 *
 * Exit codes: 0 recommended · 2 partial · 3 unsuitable · 1 error.
 * In folder mode the worst status across all inputs is returned.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import process from "node:process";
import {
  createLlmClient,
  loadEnvFile,
  openClarificationIO,
  probeLlm,
  silentIO,
  LlmHttpError,
  type LlmClient,
} from "workflow-preprocessor";
import { runRecommender, type RecommenderClarificationIO } from "./pipeline/run.js";
import type { RecommendationResult } from "./schema/result.js";

const RESULT_SUFFIX = ".recommendations.json";

const USAGE = `workflow-recommender — turn a preprocessed workflow schema into a ranked, explainable list of AI and non-AI improvement opportunities.

Usage:
  workflow-recommender <result.json>           one preprocessor result JSON
  workflow-recommender <folder>                every *.json in the folder
                                               (excluding *${RESULT_SUFFIX})

Options:
  --out <file>            Write the result JSON here (single input only)
  --out-dir <dir>         Write one <name>${RESULT_SUFFIX} per input
                          (default: next to each input)
  --check                 Verify the LLM configuration and exit
  --max-rounds <n>        Clarification round cap (default 10)
  --endpoint <url>        LLM endpoint override (else LLM_ENDPOINT)
  --model <id>            Model override (else LLM_MODEL)
  --env <file>            Load this env file instead of searching for .env
  --no-env                Do not load any .env file
  --no-interactive        Skip clarification; unknown attributes are scored
                          conservatively and the result comes back partial
  -h, --help              Show this help

Configuration is read from the environment, and from the nearest .env file
(searching upward from the current directory) for anything not already set:

  LLM_ENDPOINT    required   base URL, e.g. https://llm.internal.example/v1
  LLM_API_KEY     optional   sent as "Authorization: Bearer <key>"
  LLM_MODEL       required   model / deployment name (unless --model)`;

interface CliArgs {
  input?: string;
  out?: string;
  outDir?: string;
  check: boolean;
  maxRounds?: number;
  endpoint?: string;
  model?: string;
  envFile?: string;
  loadEnv: boolean;
  interactive: boolean;
}

function value(argv: string[], i: number, flag: string): string {
  const next = argv[i];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${flag} expects a value`);
  }
  return next;
}

function parseArgs(argv: string[]): CliArgs | null {
  const args: CliArgs = { check: false, loadEnv: true, interactive: true };
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
      case "--env":
        args.envFile = value(argv, ++i, "--env");
        break;
      case "--no-env":
        args.loadEnv = false;
        break;
      case "--no-interactive":
        args.interactive = false;
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

/** Input files in a folder: *.json minus our own outputs, sorted. */
function discoverResultJsons(folder: string): string[] {
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json") && !name.endsWith(RESULT_SUFFIX))
    .sort()
    .map((name) => join(folder, name));
}

function outputPathFor(inputPath: string, args: CliArgs): string {
  if (args.out) return args.out;
  const stem = basename(inputPath, extname(inputPath));
  const dir = args.outDir ?? dirname(inputPath);
  return join(dir, `${stem}${RESULT_SUFFIX}`);
}

function printResult(result: RecommendationResult): void {
  console.log("");
  switch (result.status) {
    case "recommended":
    case "partial": {
      const mark = result.status === "recommended" ? "✔" : "◐";
      const note =
        result.status === "partial" ? ` — ${result.reason}` : " (no open questions)";
      console.log(
        `${mark} ${result.opportunities.length} opportunity(ies) for "${result.workflowName ?? "(unnamed workflow)"}"${note}.`,
      );
      console.log(
        `  Profiles: ${result.profiles.length} · Motifs: ${result.motifs.length} · Excluded by sensitivity: ${result.excluded.length}`,
      );
      for (const [i, opp] of result.opportunities.slice(0, 5).entries()) {
        const seq = opp.sequence.length > 1 ? " (two-step sequence)" : "";
        console.log(
          `   ${i + 1}. [${String(opp.score.total).padStart(3)}] ${opp.id}${seq} — confidence ${opp.confidence}`,
        );
      }
      if (result.opportunities.length > 5) {
        console.log(`   … ${result.opportunities.length - 5} more in the result JSON`);
      }
      if (result.status === "partial" && result.openQuestions.length > 0) {
        console.log(
          `  Open questions (${result.openQuestions.length}) would sharpen these — re-run interactively to answer them.`,
        );
      }
      break;
    }
    case "unsuitable":
      console.log(`✘ Unsuitable: ${result.reason}`);
      break;
  }
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
  console.log(probe.ok ? "\n✔ Ready to run." : "\n✘ Configuration is not usable yet.");
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

  if (!args.input) {
    console.error(USAGE);
    return 1;
  }

  const inputPath = resolve(args.input);
  let inputs: string[];
  if (isDirectory(inputPath)) {
    inputs = discoverResultJsons(inputPath);
    if (inputs.length === 0) {
      console.error(`no preprocessor result *.json files found in ${inputPath}`);
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

  let llm: LlmClient;
  try {
    llm = createLlmClient({ endpoint: args.endpoint, model: args.model });
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
      "No terminal available for questions — continuing non-interactively; unknown attributes will be scored conservatively.",
    );
  }
  const io: RecommenderClarificationIO = interactive?.io ?? silentIO;

  if (args.outDir) mkdirSync(args.outDir, { recursive: true });
  const statuses: RecommendationResult["status"][] = [];
  const labels: string[] = [];

  try {
    for (const [index, path] of inputs.entries()) {
      const label = basename(path);
      if (inputs.length > 1) {
        console.log(`\n${"─".repeat(60)}\n[${index + 1}/${inputs.length}] ${label}`);
      } else {
        console.log(`Recommending over ${label}…`);
      }

      let json: unknown;
      try {
        json = JSON.parse(readFileSync(path, "utf8"));
      } catch (err) {
        console.error(
          `  Skipping ${label}: not readable JSON (${err instanceof Error ? err.message : err})`,
        );
        if (inputs.length === 1) return 1;
        continue;
      }

      let result: RecommendationResult;
      try {
        result = await runRecommender(llm, json, io, {
          maxRounds: args.maxRounds,
          sourcePath: path,
        });
      } catch (err) {
        if (err instanceof Error && /not a preprocessor result/.test(err.message)) {
          console.error(`  Skipping ${label}: ${err.message}`);
          if (inputs.length === 1) return 1;
          continue;
        }
        // One bad input should not abandon the rest of a folder.
        reportRunError(err);
        if (inputs.length === 1) return 1;
        statuses.push("unsuitable");
        labels.push(label);
        continue;
      }

      printResult(result);
      statuses.push(result.status);
      labels.push(label);

      const target = outputPathFor(path, args);
      writeFileSync(target, JSON.stringify(result, null, 2) + "\n", "utf8");
      console.log(`\nResult written to ${target}`);
    }
  } finally {
    interactive?.close();
  }

  if (statuses.length === 0) return 1; // every folder entry was skipped
  if (labels.length > 1) {
    const mark = { recommended: "✔", partial: "◐", unsuitable: "✘" } as const;
    const width = Math.max(...labels.map((l) => l.length));
    console.log(`\n${"─".repeat(60)}\nSummary`);
    for (const [i, label] of labels.entries()) {
      console.log(`  ${mark[statuses[i]]} ${label.padEnd(width)}  ${statuses[i]}`);
    }
  }

  if (statuses.includes("unsuitable")) return 3;
  if (statuses.includes("partial")) return 2;
  return 0;
}
