/**
 * Reference HTTP embedding — Node's built-in `http` module, no framework,
 * no dependencies. It shows how a website drives the conversation across
 * requests; it is not the website. Everything below the routing is the same
 * `intake` / `openConversation` / `sendMessage` / `resultFromConversation`
 * sequence `runSession` performs in one call.
 *
 *   POST /conversations                 ← { "text": "<problem and ideas>" }, or raw text/image bytes
 *                                       → 201 { id, state: "open", message, openGaps, schema }
 *                                       |  201 { id, state: "done", result }      (rejected, or nothing to ask)
 *   GET  /conversations/:id             → the same view, at any time
 *   POST /conversations/:id/messages    ← { "text": "…" }
 *                                       → { id, state: "open", message, openGaps, schema }
 *                                       |  { id, state: "done", result }          (the turn ended it)
 *   POST /conversations/:id/finish      → { id, state: "done", result }
 *
 * `message` is the agent's latest message — what to show the person. The
 * session state is plain JSON, so a real deployment keeps it in a store
 * instead of this in-memory map, adds auth, limits and cleanup, and expires
 * idle conversations (IDLE_MS here) so the terminal-state guarantee survives
 * an abandoned browser tab. A conversation accepts one message at a time
 * (409 while a turn is in flight): the state functions are pure, so two
 * concurrent turns would fork the state rather than corrupt it, but only one
 * of them could be kept.
 *
 *   npm run serve
 *   curl -s localhost:8787/conversations -H 'content-type: application/json' \
 *        -d '{"text":"We keep losing track of bug reports from our users"}'
 *   curl -s localhost:8787/conversations/<id>/messages -H 'content-type: application/json' \
 *        -d '{"text":"Success would be: every report gets an owner within a day"}'
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";
import {
  createLlmClient,
  closeConversation,
  intake,
  lastAssistantMessage,
  loadEnvFile,
  loadInputFromBuffer,
  openConversation,
  resultFromConversation,
  resultFromIntake,
  sendMessage,
  textInput,
  type InputPayload,
  type LlmClient,
  type SessionResult,
  type SessionState,
} from "../src/index.js";

const PORT = Number(process.env.PORT ?? 8787);
/** How long an open conversation waits for the next message before it is finished as partial. */
const IDLE_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const MAX_TURNS = 40;

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

type Entry =
  | { kind: "open"; state: SessionState; intermediate: string; busy: boolean; timer: NodeJS.Timeout }
  | { kind: "done"; result: SessionResult };

const entries = new Map<string, Entry>();

function finish(id: string, entry: Entry & { kind: "open" }): Entry {
  clearTimeout(entry.timer);
  const done: Entry = { kind: "done", result: resultFromConversation(closeConversation(entry.state), entry.intermediate) };
  entries.set(id, done);
  return done;
}

function idleTimer(id: string): NodeJS.Timeout {
  return setTimeout(() => {
    const entry = entries.get(id);
    if (entry?.kind === "open" && !entry.busy) finish(id, entry);
  }, IDLE_MS);
}

function view(id: string, entry: Entry): unknown {
  if (entry.kind === "done") return { id, state: "done", result: entry.result };
  return {
    id,
    state: "open",
    message: lastAssistantMessage(entry.state),
    turns: entry.state.turns,
    openGaps: entry.state.openGaps.map(({ id, description }) => ({ id, description })),
    schema: entry.state.workflow,
  };
}

async function start(llm: LlmClient, input: InputPayload): Promise<{ id: string; entry: Entry }> {
  const id = randomUUID();
  const accepted = await intake(llm, input);
  if (accepted.status === "rejected") {
    const entry: Entry = { kind: "done", result: accepted };
    entries.set(id, entry);
    return { id, entry };
  }
  const { workflow, intermediate } = accepted;
  const state = await openConversation(llm, workflow);
  if (state.status === "closed") {
    // The agent could not open; the schema stands on its own.
    const entry: Entry = { kind: "done", result: resultFromIntake(workflow, intermediate, "the assistant could not start the conversation") };
    entries.set(id, entry);
    return { id, entry };
  }
  const entry: Entry = { kind: "open", state, intermediate, busy: false, timer: idleTimer(id) };
  entries.set(id, entry);
  return { id, entry };
}

async function message(
  llm: LlmClient,
  id: string,
  text: string,
): Promise<{ status: number; payload: unknown }> {
  const entry = entries.get(id);
  if (!entry) return { status: 404, payload: { error: "no such conversation" } };
  if (entry.kind === "done") return { status: 409, payload: { error: "the conversation is finished", ...(view(id, entry) as object) } };
  if (entry.busy) return { status: 409, payload: { error: "a turn is already in progress" } };
  if (text.trim() === "") return { status: 400, payload: { error: "the message is empty" } };

  entry.busy = true;
  clearTimeout(entry.timer);
  let next: SessionState;
  try {
    next = await sendMessage(llm, entry.state, text, { maxTurns: MAX_TURNS });
  } catch (err) {
    // Transport failure: the previous state is intact, the client may retry.
    entry.busy = false;
    entry.timer = idleTimer(id);
    return { status: 502, payload: { error: err instanceof Error ? err.message : String(err) } };
  }
  entry.state = next;
  entry.busy = false;
  if (next.status === "closed") return { status: 200, payload: view(id, finish(id, entry)) };
  entry.timer = idleTimer(id);
  return { status: 200, payload: view(id, entry) };
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

function jsonText(req: IncomingMessage, body: Buffer): string | null {
  const type = (req.headers["content-type"] ?? "").toLowerCase();
  if (!type.includes("application/json")) return null;
  const json: unknown = JSON.parse(body.toString("utf8"));
  const text = typeof json === "object" && json !== null ? (json as { text?: unknown }).text : undefined;
  if (typeof text !== "string") throw new Error('expected a JSON body of the form { "text": "…" }');
  return text;
}

/** The request body as an input: JSON { text }, or raw text/image bytes (modality sniffed). */
function toInput(req: IncomingMessage, body: Buffer): InputPayload {
  const text = jsonText(req, body);
  if (text !== null) return textInput(text);
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

async function handle(llm: LlmClient, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  if (method === "OPTIONS") return send(res, 204, null);

  if (method === "POST" && url.pathname === "/conversations") {
    try {
      const input = toInput(req, await readBody(req));
      const { id, entry } = await start(llm, input);
      return send(res, 201, view(id, entry));
    } catch (err) {
      return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const match = /^\/conversations\/([^/]+)(\/messages|\/finish)?$/.exec(url.pathname);
  if (match) {
    const [, id, action] = match;
    const entry = entries.get(id);
    if (method === "GET" && !action) {
      return entry ? send(res, 200, view(id, entry)) : send(res, 404, { error: "no such conversation" });
    }
    if (method === "POST" && action === "/messages") {
      let text: string | null;
      try {
        text = jsonText(req, await readBody(req));
        if (text === null) throw new Error("send application/json");
      } catch (err) {
        return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      const { status, payload } = await message(llm, id, text);
      return send(res, status, payload);
    }
    if (method === "POST" && action === "/finish") {
      if (!entry) return send(res, 404, { error: "no such conversation" });
      if (entry.kind === "open" && entry.busy) return send(res, 409, { error: "a turn is already in progress" });
      return send(res, 200, view(id, entry.kind === "open" ? finish(id, entry) : entry));
    }
  }

  send(res, 404, {
    error: "no such route",
    routes: ["POST /conversations", "GET /conversations/:id", "POST /conversations/:id/messages", "POST /conversations/:id/finish"],
  });
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
  console.log(`workflow-helper reference server listening on http://localhost:${PORT}`);
  console.log("  POST /conversations                start: intake, then the agent's opening message");
  console.log("  POST /conversations/:id/messages   one turn: your message in, the agent's reply out");
  console.log("  POST /conversations/:id/finish     end it and get the result");
});
