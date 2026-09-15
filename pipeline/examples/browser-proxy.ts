/**
 * The reference proxy behind the browser demo — the contract the website's
 * backend implements (Phase 2 of the integration plan, §7.2). A
 * dependency-free `node:http` server:
 *
 *   GET  /                                          the demo page
 *   GET  /workflow-helper.js  (.js.map)             the bundle from dist-browser/
 *   GET  /api/workflow-helper/config                { enabled, maxTokens, jsonMode, maxImageBytes, imageInput }
 *   POST /api/workflow-helper/llm/chat/completions  the forwarded chat completion
 *   GET  /api/workflow-helper/health                one trivial call per configured target
 *
 * The POST is the point. In order, it
 *   1. requires `application/json` (415) and a Content-Length within the
 *      cap (413, checked before the body is read);
 *   2. REBUILDS the upstream body from an allow-list — `messages` (1–12,
 *      roles system/user/assistant, content a string or text/image_url
 *      parts whose url is a base64 `data:image/…` URL), `max_tokens`
 *      clamped to the cap, `response_format` only `{type:"json_object"}`
 *      and only when JSON mode is on — and drops everything else. Anything
 *      malformed is 400 `invalid_request`. The client's `model` is ignored;
 *   3. picks the target on the server — vision when an image part is
 *      present, main otherwise — and sets the model;
 *   4. forwards with the key and a timeout, and maps the answer: 2xx passes
 *      through unchanged; upstream 401/403 → 502 `llm_auth` (never passed
 *      through, or the browser would take it for its own session ending);
 *      429 → 429 with Retry-After; other 4xx → same status `llm_rejected`;
 *      5xx → same status `llm_error`; timeout → 504 `llm_timeout`; a TLS
 *      failure → 502 `llm_tls`; anything else → 502 `llm_unreachable`;
 *   5. logs one line — target, bytes, status, latency, finish_reason,
 *      usage — and never the message content or the key.
 *
 * Login, the per-user rate limit and the concurrency cap are the website's
 * job and are left out here: this binds to 127.0.0.1 and is a local tool.
 *
 * Configuration is the CLI's `LLM_*` variables (from the environment or
 * the nearest `.env`), so an existing setup works unchanged; the website
 * uses its own `KAIJU_*` names for the same values:
 *
 *   LLM_ENDPOINT / LLM_MODEL / LLM_API_KEY             main target
 *   LLM_VISION_ENDPOINT / _MODEL / _API_KEY            vision target (each falls back to main)
 *   LLM_MAX_TOKENS (8192)   LLM_JSON_MODE (on)
 *   LLM_TIMEOUT_SECONDS (120)   LLM_MAX_REQUEST_BYTES (10000000)   LLM_MAX_IMAGE_BYTES (5000000)
 *   LLM_IMAGE_INPUT             "true" / "false"; default: true when a vision model is set
 *   PORT (8788)
 *
 *   npm run serve:browser              # http://127.0.0.1:8788
 *   npm run serve:browser -- --mock    # no LLM needed: examples/mock-llm.ts answers instead
 */
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "workflow-preprocessor";
import { startMockLlm } from "./mock-llm.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_PAGE = join(HERE, "browser-demo", "index.html");
const BUNDLE_DIR = join(HERE, "..", "dist-browser");
const API = "/api/workflow-helper";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface Target {
  name: "main" | "vision";
  url: string;
  model: string;
  apiKey: string | undefined;
}

interface ProxyConfig {
  main: Target;
  vision: Target | null;
  maxTokens: number;
  jsonMode: boolean;
  timeoutMs: number;
  maxRequestBytes: number;
  maxImageBytes: number;
  imageInput: boolean;
}

const env = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};
const envInt = (name: string, fallback: number): number => {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
};

/** Same rule as the TS client: append /chat/completions unless already present. */
function chatUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

function loadConfig(override: { endpoint?: string; model?: string } = {}): ProxyConfig {
  const endpoint = override.endpoint ?? env("LLM_ENDPOINT");
  const model = override.model ?? env("LLM_MODEL");
  if (!endpoint || !model) {
    throw new Error("set LLM_ENDPOINT and LLM_MODEL (a .env file works too), or run with --mock");
  }
  const main: Target = { name: "main", url: chatUrl(endpoint), model, apiKey: env("LLM_API_KEY") };
  const visionModel = env("LLM_VISION_MODEL");
  const visionEndpoint = env("LLM_VISION_ENDPOINT");
  const visionKey = env("LLM_VISION_API_KEY");
  const vision: Target | null =
    visionModel || visionEndpoint || visionKey
      ? {
          name: "vision",
          url: chatUrl(visionEndpoint ?? endpoint),
          model: visionModel ?? model,
          apiKey: visionKey ?? main.apiKey,
        }
      : null;
  const imageInputRaw = (env("LLM_IMAGE_INPUT") ?? "").toLowerCase();
  return {
    main,
    vision,
    maxTokens: envInt("LLM_MAX_TOKENS", 8192),
    jsonMode: !["off", "false", "0", "no"].includes((env("LLM_JSON_MODE") ?? "").toLowerCase()),
    timeoutMs: envInt("LLM_TIMEOUT_SECONDS", 120) * 1000,
    maxRequestBytes: envInt("LLM_MAX_REQUEST_BYTES", 10_000_000),
    maxImageBytes: envInt("LLM_MAX_IMAGE_BYTES", 5_000_000),
    imageInput: imageInputRaw === "" ? vision !== null || override.endpoint !== undefined : ["true", "1", "yes", "on"].includes(imageInputRaw),
  };
}

// ---------------------------------------------------------------------------
// The allow-list: rebuild the upstream body, never forward the client's dict
// ---------------------------------------------------------------------------

const DATA_IMAGE_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const ROLES = new Set(["system", "user", "assistant"]);
const MAX_MESSAGES = 12;

class InvalidRequest extends Error {}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
interface Message {
  role: string;
  content: string | Part[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rebuildPart(raw: unknown, index: number, at: string): { part: Part; image: boolean } {
  if (!isRecord(raw)) throw new InvalidRequest(`${at}.content[${index}] must be an object`);
  if (raw.type === "text") {
    if (typeof raw.text !== "string") throw new InvalidRequest(`${at}.content[${index}].text must be a string`);
    return { part: { type: "text", text: raw.text }, image: false };
  }
  if (raw.type === "image_url") {
    const url = isRecord(raw.image_url) ? raw.image_url.url : undefined;
    if (typeof url !== "string" || !DATA_IMAGE_URL.test(url)) {
      throw new InvalidRequest(`${at}.content[${index}].image_url.url must be a base64 data:image/… URL`);
    }
    return { part: { type: "image_url", image_url: { url } }, image: true };
  }
  throw new InvalidRequest(`${at}.content[${index}].type must be "text" or "image_url"`);
}

/** The forwarded body and whether it carries an image, or an InvalidRequest. */
export function rebuildRequest(
  input: unknown,
  config: Pick<ProxyConfig, "maxTokens" | "jsonMode">,
): { body: Record<string, unknown>; hasImage: boolean } {
  if (!isRecord(input)) throw new InvalidRequest("the body must be a JSON object");
  const rawMessages = input.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length < 1 || rawMessages.length > MAX_MESSAGES) {
    throw new InvalidRequest(`messages must be a list of 1 to ${MAX_MESSAGES} items`);
  }
  let hasImage = false;
  const messages: Message[] = rawMessages.map((raw, i) => {
    const at = `messages[${i}]`;
    if (!isRecord(raw)) throw new InvalidRequest(`${at} must be an object`);
    if (typeof raw.role !== "string" || !ROLES.has(raw.role)) {
      throw new InvalidRequest(`${at}.role must be system, user or assistant`);
    }
    if (typeof raw.content === "string") return { role: raw.role, content: raw.content };
    if (!Array.isArray(raw.content)) throw new InvalidRequest(`${at}.content must be a string or a list of parts`);
    const parts = raw.content.map((p, j) => {
      const { part, image } = rebuildPart(p, j, at);
      hasImage ||= image;
      return part;
    });
    return { role: raw.role, content: parts };
  });

  const requested = input.max_tokens;
  const maxTokens =
    typeof requested === "number" && Number.isInteger(requested)
      ? Math.min(Math.max(requested, 1), config.maxTokens)
      : config.maxTokens;

  const body: Record<string, unknown> = { messages, max_tokens: maxTokens };
  if (config.jsonMode && isRecord(input.response_format) && input.response_format.type === "json_object") {
    body.response_format = { type: "json_object" };
  }
  // Everything else — model, stream, tools, temperature, n, user, … — is dropped.
  return { body, hasImage };
}

// ---------------------------------------------------------------------------
// Forwarding and error mapping
// ---------------------------------------------------------------------------

interface Reply {
  status: number;
  headers?: Record<string, string>;
  /** A JSON-encoded string is sent as-is; anything else is stringified. */
  payload: unknown;
  raw?: boolean;
}

interface Forwarded extends Reply {
  latencyMs: number;
  finishReason?: string;
  usage?: string;
}

function isTlsError(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? "";
  return /CERT|TLS|SSL/i.test(code) || /certificate/i.test(cause?.message ?? "");
}

async function forward(target: Target, body: Record<string, unknown>, config: ProxyConfig): Promise<Forwarded> {
  const started = Date.now();
  const latency = () => Date.now() - started;
  let upstream: Response;
  try {
    upstream = await fetch(target.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify({ ...body, model: target.model }),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      return { status: 504, payload: { error: "llm_timeout" }, latencyMs: latency() };
    }
    if (isTlsError(err)) return { status: 502, payload: { error: "llm_tls" }, latencyMs: latency() };
    return { status: 502, payload: { error: "llm_unreachable" }, latencyMs: latency() };
  }

  const text = await upstream.text();
  const detail = text.slice(0, 2048);
  if (upstream.ok) {
    let finishReason: string | undefined;
    let usage: string | undefined;
    try {
      const parsed = JSON.parse(text) as { choices?: { finish_reason?: string }[]; usage?: Record<string, number> };
      finishReason = parsed.choices?.[0]?.finish_reason ?? undefined;
      if (parsed.usage) usage = `${parsed.usage.prompt_tokens ?? "?"}/${parsed.usage.completion_tokens ?? "?"}`;
    } catch {
      // Passed through unchanged either way; the client validates the shape.
    }
    return { status: 200, payload: text, raw: true, latencyMs: latency(), finishReason, usage };
  }
  if (upstream.status === 401 || upstream.status === 403) {
    return { status: 502, payload: { error: "llm_auth" }, latencyMs: latency() };
  }
  if (upstream.status === 429) {
    const retryAfter = upstream.headers.get("retry-after");
    return {
      status: 429,
      headers: retryAfter ? { "retry-after": retryAfter } : undefined,
      payload: { error: "llm_rate_limited", detail },
      latencyMs: latency(),
    };
  }
  if (upstream.status < 500) {
    return { status: upstream.status, payload: { error: "llm_rejected", detail }, latencyMs: latency() };
  }
  return { status: upstream.status, payload: { error: "llm_error", detail }, latencyMs: latency() };
}

/** One trivial call per target, as the website's admin-only health endpoint does. */
async function health(config: ProxyConfig): Promise<Record<string, unknown>> {
  const ping = async (target: Target) => {
    const body: Record<string, unknown> = {
      messages: [{ role: "user", content: 'Reply with the JSON object {"ok": true} and nothing else.' }],
      max_tokens: 20,
      ...(config.jsonMode ? { response_format: { type: "json_object" } } : {}),
    };
    const reply = await forward(target, body, config);
    const code = reply.raw ? "ok" : (reply.payload as { error: string }).error;
    return { status: code, httpStatus: reply.status, latencyMs: reply.latencyMs, model: target.model };
  };
  const result: Record<string, unknown> = { main: await ping(config.main) };
  if (config.vision) result.vision = await ping(config.vision);
  return result;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        reject(new Error("body exceeds the declared length"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, reply: Reply): void {
  res.writeHead(reply.status, { "content-type": "application/json; charset=utf-8", ...(reply.headers ?? {}) });
  res.end(reply.raw ? (reply.payload as string) : JSON.stringify(reply.payload));
}

function sendFile(res: ServerResponse, path: string, type: string): void {
  if (!existsSync(path)) {
    send(res, { status: 503, payload: { error: `missing ${path} — run \`npm run build:browser\` first` } });
    return;
  }
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(path));
}

async function chatCompletions(config: ProxyConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return send(res, { status: 415, payload: { error: "unsupported_media_type", detail: "send application/json" } });
  }
  const length = Number(req.headers["content-length"]);
  if (!Number.isFinite(length) || length > config.maxRequestBytes) {
    return send(res, { status: 413, payload: { error: "payload_too_large", limit: config.maxRequestBytes } });
  }

  let json: unknown;
  let requestBytes = 0;
  try {
    const raw = await readBody(req, config.maxRequestBytes);
    requestBytes = raw.length;
    json = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    return send(res, { status: 400, payload: { error: "invalid_request", detail: `not JSON: ${err instanceof Error ? err.message : err}` } });
  }

  let rebuilt: ReturnType<typeof rebuildRequest>;
  try {
    rebuilt = rebuildRequest(json, config);
  } catch (err) {
    if (err instanceof InvalidRequest) return send(res, { status: 400, payload: { error: "invalid_request", detail: err.message } });
    throw err;
  }

  const target = rebuilt.hasImage && config.vision ? config.vision : config.main;
  const reply = await forward(target, rebuilt.body, config);
  console.log(
    `${new Date().toISOString()} llm target=${target.name} bytes=${requestBytes} status=${reply.status}` +
      ` latency=${reply.latencyMs}ms finish=${reply.finishReason ?? "-"} tokens=${reply.usage ?? "-"}`,
  );
  send(res, reply);
}

async function handle(config: ProxyConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";
  const route = `${method} ${url.pathname}`;

  if (route === "GET /" || route === "GET /index.html") return sendFile(res, DEMO_PAGE, "text/html; charset=utf-8");
  if (route === "GET /favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (route === "GET /workflow-helper.js") return sendFile(res, join(BUNDLE_DIR, "workflow-helper.js"), "text/javascript; charset=utf-8");
  if (route === "GET /workflow-helper.js.map") return sendFile(res, join(BUNDLE_DIR, "workflow-helper.js.map"), "application/json");

  if (route === `GET ${API}/config`) {
    return send(res, {
      status: 200,
      payload: {
        enabled: true,
        maxTokens: config.maxTokens,
        jsonMode: config.jsonMode,
        maxImageBytes: config.maxImageBytes,
        imageInput: config.imageInput,
      },
    });
  }
  if (route === `POST ${API}/llm/chat/completions`) return chatCompletions(config, req, res);
  if (route === `GET ${API}/health`) return send(res, { status: 200, payload: await health(config) });

  send(res, { status: 404, payload: { error: "no such route" } });
}

// ---------------------------------------------------------------------------

loadEnvFile();
const useMock = process.argv.includes("--mock");
let config: ProxyConfig;
try {
  const override = useMock ? { endpoint: (await startMockLlm()).url, model: "mock" } : {};
  config = loadConfig(override);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 8788);
createServer((req, res) => {
  handle(config, req, res).catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) send(res, { status: 500, payload: { error: "internal error" } });
  });
}).listen(PORT, "127.0.0.1", () => {
  console.log(`workflow-helper browser demo at http://127.0.0.1:${PORT}`);
  console.log(`  main target: ${config.main.url} (${config.main.model})${useMock ? "  [mock]" : ""}`);
  if (config.vision) console.log(`  vision target: ${config.vision.url} (${config.vision.model})`);
  console.log(`  POST ${API}/llm/chat/completions · GET ${API}/config · GET ${API}/health`);
});
