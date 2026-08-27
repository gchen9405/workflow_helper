/**
 * Reference HTTP embedding — Node's built-in `http` module, no framework,
 * no dependencies. It exists to show the two ways a website can drive the
 * pipeline, not to be the website. Everything below the routing is the
 * same `runPipeline` call the CLI makes.
 *
 *   ONE-SHOT     POST /report
 *     Input in, PipelineResult JSON out. No questions are asked (the
 *     default, silent IO): thin input yields a partial analysis — still a
 *     complete report that says what is uncertain. One request, one
 *     response; the simplest possible integration. Expect it to take as
 *     long as five or six model calls.
 *
 *   INTERACTIVE  POST /runs               → 202 { id }
 *                GET  /runs/:id           → { state: "running" }
 *                                         | { state: "waiting", stage, round, questions }
 *                                         | { state: "done", result }
 *                                         | { state: "failed", error, stage? }
 *                POST /runs/:id/answers   ← { stopped?, answers: [{ questionId, answer }] }
 *     The pipeline's `askBatch` parks on a promise that the answers request
 *     resolves — which is all the PipelineClarificationIO seam needs from a
 *     transport (polling here; WebSocket or SSE would push instead). A run
 *     nobody answers within IDLE_MS is finished as partial, so the
 *     terminal-state guarantee survives an abandoned browser tab. Runs live
 *     in memory; a real deployment keeps them in a store and adds auth,
 *     limits and cleanup.
 *
 * Input, for both routes: JSON `{ "text": "…" }`, or the raw bytes of a
 * text file or flowchart image with a matching Content-Type — modality is
 * sniffed from the bytes, exactly as the CLI does, so an uploaded PNG and
 * a pasted description take the same path.
 *
 *   npm run serve
 *   curl -s localhost:8787/report -H 'content-type: application/json' \
 *        -d '{"text":"A new order comes in. Sales validates it, …"}' | jq -r .report
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";
import {
  createLlmClient,
  loadEnvFile,
  loadInputFromBuffer,
  textInput,
  type BatchAnswers,
  type InputPayload,
  type LlmClient,
} from "workflow-preprocessor";
import {
  PipelineStageError,
  runPipeline,
  type ClarificationStage,
  type PipelineQuestion,
  type PipelineResult,
} from "../src/index.js";

const PORT = Number(process.env.PORT ?? 8787);
/** How long a waiting run keeps its questions open before finishing as partial. */
const IDLE_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Interactive runs
// ---------------------------------------------------------------------------

interface PendingBatch {
  stage: ClarificationStage;
  round: number;
  questions: readonly PipelineQuestion[];
  resolve: (answers: BatchAnswers) => void;
  timer: NodeJS.Timeout;
}

type Run =
  | { state: "running"; pending: null }
  | { state: "waiting"; pending: PendingBatch }
  | { state: "done"; pending: null; result: PipelineResult }
  | { state: "failed"; pending: null; error: string; stage?: string };

const runs = new Map<string, Run>();

function startRun(llm: LlmClient, input: InputPayload): string {
  const id = randomUUID();
  runs.set(id, { state: "running", pending: null });

  const io = {
    askBatch(questions: readonly PipelineQuestion[], round: number, stage: ClarificationStage) {
      return new Promise<BatchAnswers>((resolve) => {
        const timer = setTimeout(() => {
          // Nobody answered: finish with what we have rather than hang forever.
          runs.set(id, { state: "running", pending: null });
          resolve({ stopped: true, answers: [] });
        }, IDLE_MS);
        runs.set(id, { state: "waiting", pending: { stage, round, questions, resolve, timer } });
      });
    },
  };

  runPipeline(llm, input, { io, inputLabel: "request body" }).then(
    (result) => runs.set(id, { state: "done", pending: null, result }),
    (err: unknown) =>
      runs.set(id, {
        state: "failed",
        pending: null,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof PipelineStageError ? { stage: err.stage } : {}),
      }),
  );
  return id;
}

function answerRun(id: string, body: unknown): { status: number; payload: unknown } {
  const run = runs.get(id);
  if (!run) return { status: 404, payload: { error: "no such run" } };
  if (run.state !== "waiting") {
    return { status: 409, payload: { error: `the run is ${run.state}, not waiting for answers` } };
  }
  const answers = parseAnswers(body);
  if (!answers) {
    return {
      status: 400,
      payload: { error: 'expected { "stopped"?: boolean, "answers": [{ "questionId", "answer" }] }' },
    };
  }
  clearTimeout(run.pending.timer);
  runs.set(id, { state: "running", pending: null });
  run.pending.resolve(answers);
  return { status: 202, payload: { state: "running" } };
}

function parseAnswers(body: unknown): BatchAnswers | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const stopped = record.stopped === undefined ? false : record.stopped;
  if (typeof stopped !== "boolean") return null;
  const raw = record.answers === undefined ? [] : record.answers;
  if (!Array.isArray(raw)) return null;
  const answers: BatchAnswers["answers"] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const { questionId, answer } = entry as Record<string, unknown>;
    if (typeof questionId !== "string" || typeof answer !== "string") return null;
    answers.push({ questionId, answer });
  }
  return { stopped, answers };
}

/** What a client sees when it polls. */
function runView(run: Run): unknown {
  switch (run.state) {
    case "running":
      return { state: "running" };
    case "waiting":
      return {
        state: "waiting",
        stage: run.pending.stage,
        round: run.pending.round,
        // Questions are plain data; recommender ones carry `options`.
        questions: run.pending.questions,
      };
    case "done":
      return { state: "done", result: run.result };
    case "failed":
      return { state: "failed", error: run.error, ...(run.stage ? { stage: run.stage } : {}) };
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** The request body as a pipeline input: JSON { text }, or raw text/image bytes. */
function toInput(req: IncomingMessage, body: Buffer): InputPayload {
  const type = (req.headers["content-type"] ?? "").toLowerCase();
  if (type.includes("application/json")) {
    const json: unknown = JSON.parse(body.toString("utf8"));
    const text = typeof json === "object" && json !== null ? (json as { text?: unknown }).text : undefined;
    if (typeof text !== "string") throw new Error('expected a JSON body of the form { "text": "…" }');
    return textInput(text);
  }
  if (body.length === 0) throw new Error("the request body is empty");
  return loadInputFromBuffer(body);
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    // A browser front end on another origin needs this; tighten for production.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function failure(err: unknown): { status: number; payload: unknown } {
  if (err instanceof PipelineStageError) {
    // Transport or programming failure inside a stage: the pipeline never
    // fabricates a report, so neither does the server.
    return {
      status: 502,
      payload: {
        error: err.message,
        stage: err.stage,
        // What was learned before the failure, for a UI that wants to show it.
        preprocess: err.preprocess,
      },
    };
  }
  return { status: 400, payload: { error: err instanceof Error ? err.message : String(err) } };
}

async function handle(llm: LlmClient, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  if (method === "OPTIONS") return send(res, 204, null);

  // One-shot: input in, result out.
  if (method === "POST" && url.pathname === "/report") {
    try {
      const input = toInput(req, await readBody(req));
      const result = await runPipeline(llm, input, { inputLabel: "request body" });
      return send(res, 200, result);
    } catch (err) {
      const { status, payload } = failure(err);
      return send(res, status, payload);
    }
  }

  // Interactive: start, poll, answer.
  if (method === "POST" && url.pathname === "/runs") {
    try {
      const input = toInput(req, await readBody(req));
      return send(res, 202, { id: startRun(llm, input) });
    } catch (err) {
      const { status, payload } = failure(err);
      return send(res, status, payload);
    }
  }
  const runMatch = /^\/runs\/([^/]+)(\/answers)?$/.exec(url.pathname);
  if (runMatch) {
    const [, id, answers] = runMatch;
    if (method === "GET" && !answers) {
      const run = runs.get(id);
      return run ? send(res, 200, runView(run)) : send(res, 404, { error: "no such run" });
    }
    if (method === "POST" && answers) {
      let body: unknown;
      try {
        body = JSON.parse((await readBody(req)).toString("utf8"));
      } catch (err) {
        return send(res, 400, { error: `not JSON: ${err instanceof Error ? err.message : err}` });
      }
      const { status, payload } = answerRun(id, body);
      return send(res, status, payload);
    }
  }

  send(res, 404, { error: "no such route", routes: ["POST /report", "POST /runs", "GET /runs/:id", "POST /runs/:id/answers"] });
}

// ---------------------------------------------------------------------------

loadEnvFile();
let llm: LlmClient;
try {
  llm = createLlmClient();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error("Set LLM_ENDPOINT and LLM_MODEL (a .env file works too).");
  process.exit(1);
}

createServer((req, res) => {
  handle(llm, req, res).catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: "internal error" });
  });
}).listen(PORT, () => {
  console.log(`workflow-pipeline reference server listening on http://localhost:${PORT}`);
  console.log("  POST /report            one-shot: input in, result out");
  console.log("  POST /runs              interactive: start a run, then GET /runs/:id and POST /runs/:id/answers");
});
