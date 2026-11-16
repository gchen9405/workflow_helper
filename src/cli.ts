#!/usr/bin/env node
/**
 * CLI for workflow-helper: describe the problem you are facing (and any
 * ideas you have), then talk it through with the assistant, right here in
 * the terminal, until the brief is complete.
 *
 *   workflow-helper --text "<problem and ideas>"
 *   workflow-helper <file>              # notes (.txt/.md) or an image of a sketch
 *   … | workflow-helper                 # piped stdin (or an explicit "-")
 *
 * Configuration comes from a `.env` file when one is present (real env vars
 * still win), and `--check` verifies that configuration with one trivial
 * round trip before a real run spends anything.
 *
 * When stdin is a pipe, your replies are read from the console device
 * (/dev/tty, or CONIN$ on Windows), so piping the input does not cost you
 * the conversation.
 *
 * Exit codes: 0 validated · 2 partial · 3 rejected · 1 error.
 */
import { writeFileSync } from "node:fs";
import process from "node:process";
import { LlmHttpError } from "./llm/internalClient.js";
import { openTerminalConversation } from "./io/terminal.js";
import { createLlmClient } from "./llm/routingClient.js";
import { probeLlm } from "./llm/probe.js";
import type { LlmClient } from "./llm/client.js";
import { loadEnvFile } from "./io/env.js";
import {
  loadInputFromFile,
  loadInputFromStdin,
  normalizeInputPath,
  textInput,
  type InputPayload,
} from "./io/input.js";
import { runSession, type SessionResult } from "./run.js";
import type { GapScope } from "./graph/gaps.js";
import type { Workflow } from "./schema/workflow.js";

const USAGE = `workflow-helper — talk through a problem you are facing with an assistant, so a workflow can be designed for it.

Usage:
  workflow-helper --text "<problem, and any ideas you have>"
  workflow-helper <file>                 notes (.txt/.md) or an image of a sketch
  cat notes.md | workflow-helper         piped stdin (or an explicit "-")

Describe what is going wrong or what you want to achieve, who is involved,
and any ideas you already have. The assistant asks about the problem, what a
good outcome looks like, your background, and the ideas you brought, until
the brief is complete or you type /done. It does not design the workflow —
that comes in a later step.

Options:
  --text <s>              The problem description, inline
  --out <file>            Write the result JSON to a file (else it is printed)
  --check                 Verify the LLM configuration and exit; makes no other calls
  --max-turns <n>         Cap on your messages in the conversation (default 40)
  --no-interactive        Skip the conversation; the input comes back as extracted
  --scope brief|design    What the conversation is for (default brief). "design"
                          builds the whole workflow; reserved for a later step
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

Optional vision/text split — routes the calls that include an image (triage +
normalization of image input) to a VLM and everything else to the cheaper
main model. Activates when any of these is set; unset values fall back to the
main setting above:
  LLM_VISION_MODEL     model / deployment for image-processing calls
  LLM_VISION_ENDPOINT  endpoint for those calls (default: LLM_ENDPOINT)
  LLM_VISION_API_KEY   key for those calls (default: LLM_API_KEY)`;

interface CliArgs {
  file?: string;
  text?: string;
  stdin: boolean;
  out?: string;
  check: boolean;
  maxTurns?: number;
  endpoint?: string;
  model?: string;
  visionEndpoint?: string;
  visionModel?: string;
  envFile?: string;
  loadEnv: boolean;
  interactive: boolean;
  scope?: GapScope;
}

/** Read the value that follows a flag, failing clearly when it is missing. */
function value(argv: string[], i: number, flag: string): string {
  const next = argv[i];
  if (next === undefined || next.startsWith("--")) {
    throw new Error(`${flag} expects a value`);
  }
  return next;
}

/** Returns null for --help. Throws on a malformed command line. */
function parseArgs(argv: string[]): CliArgs | null {
  const args: CliArgs = { stdin: false, check: false, loadEnv: true, interactive: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        return null;
      case "--text":
        args.text = value(argv, ++i, "--text");
        break;
      case "--out":
        args.out = value(argv, ++i, "--out");
        break;
      case "--check":
        args.check = true;
        break;
      case "--max-turns": {
        const raw = value(argv, ++i, "--max-turns");
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0) {
          throw new Error(`--max-turns expects a non-negative integer, got "${raw}"`);
        }
        args.maxTurns = n;
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
      case "--scope": {
        const raw = value(argv, ++i, "--scope");
        if (raw !== "brief" && raw !== "design") {
          throw new Error(`--scope expects "brief" or "design", got "${raw}"`);
        }
        args.scope = raw;
        break;
      }
      case "-":
        args.stdin = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option "${arg}"`);
        if (args.file) throw new Error("only one input file may be given");
        args.file = arg;
    }
  }
  return args;
}

/**
 * The one input, from whichever source was given. With nothing named, a
 * pipe on stdin is the input — `cat notes.md | workflow-helper` — while an
 * interactive terminal with no input is a usage error.
 */
async function resolveInput(args: CliArgs): Promise<{ label: string; payload: InputPayload }> {
  const sources = [args.file !== undefined, args.text !== undefined, args.stdin].filter(Boolean).length;
  if (sources > 1) throw new Error("give exactly one input source — a file, --text, or piped stdin");

  if (args.text !== undefined) return { label: "inline text", payload: textInput(args.text) };
  if (args.stdin) return { label: "stdin", payload: await loadInputFromStdin() };
  if (args.file !== undefined) {
    // Normalized exactly once here; loadInputFromFile must not clean it again.
    const path = normalizeInputPath(args.file);
    return { label: path, payload: loadInputFromFile(path, { normalize: false }) };
  }
  if (!process.stdin.isTTY) return { label: "stdin", payload: await loadInputFromStdin() };
  throw new Error("no input given");
}

function printSchemaSummary(schema: Workflow, indent = "  "): void {
  const counts = { original: 0, user_elicited: 0, agent_proposed: 0 };
  for (const p of Object.values(schema.provenance)) counts[p]++;
  console.log(`${indent}Name:        ${schema.name ?? "(unnamed)"}`);
  console.log(`${indent}Problem:     ${schema.problem ?? "(unknown)"}`);
  console.log(`${indent}Goal:        ${schema.goal ?? "(unknown)"}`);
  if (schema.constraints.length > 0) {
    console.log(`${indent}Constraints: ${schema.constraints.join("; ")}`);
  }
  const { task, profile } = schema;
  const facts = [
    task.inputs && `acts on ${task.inputs}`,
    task.inputShape && `${task.inputShape} input`,
    task.rulesSpecifiable && `rules ${task.rulesSpecifiable} specifiable`,
    task.variability && `${task.variability} variability`,
    task.errorCost && `${task.errorCost} error cost`,
    task.frequency && `runs ${task.frequency}`,
    task.auditability && `auditability ${task.auditability}`,
  ].filter(Boolean);
  if (facts.length > 0) console.log(`${indent}Task:        ${facts.join("; ")}`);
  console.log(`${indent}For:         ${profile.technicalLevel ?? "(level unknown)"}${profile.background ? ` — ${profile.background}` : ""}`);
  if (profile.tools.length > 0) {
    console.log(`${indent}Tools:       ${profile.tools.map((t) => `${t.name} (${t.familiarity})`).join(", ")}`);
  }
  if (profile.notes.length > 0) console.log(`${indent}Notes:       ${profile.notes.join("; ")}`);
  if (schema.ideas.length > 0) {
    console.log(`${indent}Ideas:       ${schema.ideas.map((i) => `${i.summary}${i.rationale ? ` — ${i.rationale}` : ""}`).join("; ")}`);
  }
  console.log(`${indent}Steps:       ${schema.nodes.length} (${schema.edges.length} transitions)`);
  console.log(
    `${indent}Provenance:  ${counts.original} from the input, ${counts.user_elicited} said in conversation, ${counts.agent_proposed} proposed by the assistant and accepted`,
  );
}

function printResult(result: SessionResult): void {
  console.log("");
  switch (result.status) {
    case "validated":
      console.log("✔ Complete (no open gaps).");
      printSchemaSummary(result.schema);
      break;
    case "partial":
      console.log(`◐ Partial — ${result.reason}.`);
      printSchemaSummary(result.schema);
      if (result.openGaps.length > 0) {
        console.log(`  Still open (${result.openGaps.length}):`);
        for (const g of result.openGaps) console.log(`   - [${g.id}] ${g.description}`);
      }
      break;
    case "rejected":
      console.log(`✘ Input rejected: ${result.reason}`);
      break;
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
  const visionEndpoint =
    configured(args.visionEndpoint) ?? configured(process.env.LLM_VISION_ENDPOINT);
  const visionKey = configured(process.env.LLM_VISION_API_KEY);
  // Routing activates when ANY vision setting is present (createLlmClient),
  // so the probe must key off the same condition.
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

  const noSourceGiven = args.file === undefined && args.text === undefined && !args.stdin;
  if (noSourceGiven && process.stdin.isTTY) {
    console.error(USAGE);
    return 1;
  }

  let input: { label: string; payload: InputPayload };
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

  const interactive = args.interactive ? openTerminalConversation() : null;
  if (args.interactive && !interactive) {
    console.log(
      "No terminal available for a conversation — continuing non-interactively; the input comes back as extracted.",
    );
  }

  const kind = input.payload.kind === "image" ? "image" : "text";
  console.log(`Reading ${kind} input from ${input.label}…`);

  let result: SessionResult;
  try {
    result = await runSession(llm, input.payload, {
      io: interactive?.io,
      maxTurns: args.maxTurns,
      scope: args.scope,
    });
  } catch (err) {
    reportRunError(err);
    return 1;
  } finally {
    interactive?.close();
  }

  printResult(result);
  const json = JSON.stringify(result, null, 2);
  if (args.out) {
    writeFileSync(args.out, json + "\n", "utf8");
    console.log(`\nResult written to ${args.out}`);
  } else if (result.status !== "rejected") {
    console.log("\nFull result JSON:\n");
    console.log(json);
  }

  return result.status === "validated" ? 0 : result.status === "partial" ? 2 : 3;
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
