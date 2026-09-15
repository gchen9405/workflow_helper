/**
 * A stand-in for the LLM endpoint, so the browser demo and the reference
 * proxy can be exercised end to end with no network access and no key.
 *
 * It speaks just enough of the chat-completions protocol: any `POST` whose
 * path ends in `/chat/completions` gets `{ choices: [{ message: { content },
 * finish_reason: "stop" }] }` back, plus a `GET …/models` for reachability
 * checks. The stage is recognized from the JSON Schema the client embeds in
 * its system prompt, and the answer is the pipeline's own test fixture for
 * one small order-fulfillment workflow — parsed through every stage's real
 * schema in the test suite, so it is shaped like legal model output.
 *
 * Whatever text or image is submitted, that is the workflow it "sees"; the
 * point is to drive every UI path, not to analyze anything. Words in the
 * submitted TEXT steer the run:
 *
 *   thin    the extraction leaves a step unlabeled and profiling leaves a
 *           duration unknown, so both question stages run
 *   reject  triage says it is not a workflow (the `notice` report)
 *   fail    the summary call answers HTTP 500 (the `fallback` report)
 *   boom    the triage call answers HTTP 500 (a `PipelineStageError` in preprocess)
 *   slow    every answer takes three seconds (progress, elapsed time)
 *   hang    every answer takes sixty seconds (the client's timeout)
 *
 *   npx tsx examples/mock-llm.ts            # standalone, on MOCK_LLM_PORT or 8790
 *   npm run serve:browser -- --mock         # the proxy starts one for itself
 */
import { createServer, type Server } from "node:http";
import process from "node:process";
import type { StructuredCallOptions } from "workflow-preprocessor";
import type { Handler } from "../test/fakeLlm.js";
import { fillLabel, happyHandlers, profileOrderThin, rejectTriage, thinDraft } from "../test/fixtures.js";

const HINTS = ["thin", "reject", "fail", "boom", "slow", "hang"] as const;
type Hint = (typeof HINTS)[number];

/** Steering words seen in the latest raw input; profiling and summary calls carry the schema, not the input. */
let hints = new Set<Hint>();

interface ChatRequest {
  messages: { role: string; content: string | { type: string; text?: string }[] }[];
}

function textOf(content: ChatRequest["messages"][number]["content"]): string {
  return typeof content === "string"
    ? content
    : content.map((part) => (part.type === "text" ? part.text ?? "" : "")).join("\n");
}

/** Which stage is calling, from the schema (and wording) in the prompts. */
function stageOf(system: string, user: string): string {
  if (system.includes('"isWorkflow"')) return "triage";
  if (system.includes('"intermediate"')) return "normalization";
  if (system.includes('"patches"')) return "answer application";
  if (system.includes('"profiles"')) return "profiling";
  if (system.includes('"headline"')) return "summary";
  if (system.includes('"nodes"') && system.includes('"edges"')) return "extraction";
  if (system.includes('"ok"') || user.includes('{"ok": true}')) return "connectivity check";
  return "unknown";
}

function handlerFor(stage: string): Handler | undefined {
  const base = happyHandlers();
  const handlers: Record<string, Handler> = {
    ...base,
    triage: hints.has("reject") ? rejectTriage : base.triage,
    extraction: hints.has("thin") ? () => thinDraft() : base.extraction,
    profiling: hints.has("thin") ? profileOrderThin : base.profiling,
    "answer application": fillLabel,
    "connectivity check": () => ({ ok: true }),
  };
  return handlers[stage];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The completion for one request, or an HTTP status to answer instead. */
export async function mockCompletion(body: ChatRequest): Promise<{ status: number; payload: unknown }> {
  const system = body.messages.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n");
  const users = body.messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const user = users[0] ?? "";
  const stage = stageOf(system, user);

  if (stage === "triage") {
    const lower = user.toLowerCase();
    hints = new Set(HINTS.filter((h) => lower.includes(h)));
  }
  if (hints.has("hang")) await sleep(60_000);
  else if (hints.has("slow")) await sleep(3_000);

  if (stage === "summary" && hints.has("fail")) {
    return { status: 500, payload: { error: { message: "mock: the summary call was told to fail" } } };
  }
  if (stage === "triage" && hints.has("boom")) {
    return { status: 500, payload: { error: { message: "mock: the triage call was told to fail" } } };
  }
  const handler = handlerFor(stage);
  if (!handler) {
    return { status: 400, payload: { error: { message: `mock: could not tell which stage is calling (${stage})` } } };
  }
  const output = handler({ user: [{ type: "text", text: user }] } as StructuredCallOptions<unknown>);
  return {
    status: 200,
    payload: {
      id: "mock",
      object: "chat.completion",
      model: "mock",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
      usage: { prompt_tokens: Math.ceil((system.length + user.length) / 4), completion_tokens: 50 },
    },
  };
}

function readJson(req: import("node:http").IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** Start the mock on 127.0.0.1. Port 0 picks a free one. Returns the base URL (`…/v1`). */
export function startMockLlm(port = 0): Promise<{ url: string; server: Server; close(): void }> {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && path.endsWith("/models")) {
      return reply(200, { object: "list", data: [{ id: "mock", object: "model" }] });
    }
    if (req.method === "POST" && path.endsWith("/chat/completions")) {
      try {
        const body = (await readJson(req)) as ChatRequest;
        const { status, payload } = await mockCompletion(body);
        return reply(status, payload);
      } catch (err) {
        return reply(400, { error: { message: err instanceof Error ? err.message : String(err) } });
      }
    }
    reply(404, { error: { message: `mock: no such route ${req.method} ${path}` } });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({ url: `http://127.0.0.1:${actual}/v1`, server, close: () => server.close() });
    });
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && /mock-llm\.[cm]?[jt]s$/.test(process.argv[1]);
if (invokedDirectly) {
  const { url } = await startMockLlm(Number(process.env.MOCK_LLM_PORT ?? 8790));
  console.log(`mock LLM listening at ${url}  (LLM_ENDPOINT=${url} LLM_MODEL=mock)`);
}
