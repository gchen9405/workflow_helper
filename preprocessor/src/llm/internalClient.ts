/**
 * LLM client for an internal, OpenAI-compatible chat-completions endpoint.
 *
 * Protocol assumption: the endpoint accepts
 * `POST <endpoint>/chat/completions` with the OpenAI request/response shape
 * (`model`, `messages`, `max_tokens`, optional `response_format`;
 * `choices[0].message.content` in the reply) and Bearer authentication.
 * This is the de facto standard exposed by internal gateways (vLLM, LiteLLM,
 * corporate proxies, Azure-style deployments behind a proxy). If your
 * endpoint speaks a different protocol, implement the one-method `LlmClient`
 * interface instead — nothing else in the pipeline needs to change.
 *
 * Structured output strategy (no server-side schema enforcement is assumed):
 *  1. the stage's Zod schema is converted to JSON Schema and embedded in the
 *     system prompt, with an instruction to answer with a single JSON object;
 *  2. JSON mode (`response_format: {type: "json_object"}`) is requested when
 *     enabled (default on; disable via LLM_JSON_MODE=off for gateways that
 *     reject the parameter);
 *  3. the reply is parsed and validated client-side with the same Zod schema
 *     plus the stage's semantic check, and invalid output goes through the
 *     machine-facing repair loop — errors are echoed back to the model and
 *     the call retried a bounded number of times.
 *
 * Configuration (constructor options override environment):
 *
 *   LLM_ENDPOINT    required   base URL, e.g. https://llm.internal.corp/v1
 *                              ("/chat/completions" is appended when absent)
 *   LLM_API_KEY     optional   sent as "Authorization: Bearer <key>"
 *   LLM_MODEL       required   model / deployment name to request
 *   LLM_MAX_TOKENS  optional   max output tokens per call (default 8192)
 *   LLM_JSON_MODE   optional   "off" disables response_format json_object
 *
 * Network errors, 429s, and 5xx responses are retried with backoff; other
 * HTTP errors surface as `LlmHttpError` with the status code, so the CLI can
 * give targeted hints (401/403 -> check LLM_API_KEY).
 *
 * The client also runs in a browser, where it talks to a same-origin proxy
 * that adds the key and picks the model: the environment is read through
 * `envVar` (undefined when there is no `process`), the default `fetch` is
 * called unbound (calling the browser's `fetch` as a method of this object
 * throws "Illegal invocation"), and a host can set a per-attempt `timeoutMs`,
 * pass an `AbortSignal`, and narrow `retryableStatuses` so a proxy's own
 * timeout answer is not retried.
 */
import { z, type ZodType } from "zod";
import {
  LlmRefusalError,
  LlmRepairExhaustedError,
  type LlmClient,
  type LlmContentPart,
  type StructuredCallOptions,
} from "./client.js";
import { envVar } from "./envVar.js";
import { repairMessage } from "./prompts.js";

export class LlmHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = "LlmHttpError";
  }
}

export interface InternalLlmClientOptions {
  /** Base URL or full chat-completions URL. Default: LLM_ENDPOINT. */
  endpoint?: string;
  /** Bearer token. Default: LLM_API_KEY. Omitted from the request when unset. */
  apiKey?: string;
  /** Model / deployment name. Default: LLM_MODEL. */
  model?: string;
  /** Max output tokens per call. Default: LLM_MAX_TOKENS or 8192. */
  maxTokens?: number;
  /** Request response_format json_object. Default: true unless LLM_JSON_MODE=off. */
  jsonMode?: boolean;
  /** Retries for network errors and retryable HTTP statuses. Default 2. */
  maxNetworkRetries?: number;
  /** Base backoff delay in ms (multiplied by the attempt number). Default 500. */
  retryDelayMs?: number;
  /**
   * HTTP statuses that are retried. Default: 429 and every status >= 500.
   * A browser behind a proxy that answers 504 on its own upstream timeout
   * passes `[429, 502, 503]`, so a two-minute wait is not doubled.
   */
  retryableStatuses?: readonly number[];
  /**
   * Timeout per HTTP attempt, in ms. A timed-out attempt fails at once with
   * "could not reach the LLM endpoint at <url>: timed out after Ns" and is
   * NOT retried. Default: no timeout (the previous behavior).
   */
  timeoutMs?: number;
  /**
   * Caller cancellation. An aborted call rejects immediately with the
   * signal's reason (an `AbortError` by default) and is not retried; the
   * backoff sleep between retries is cut short too.
   */
  signal?: AbortSignal;
  /** Injectable fetch for tests. Default: the global fetch. */
  fetchImpl?: typeof fetch;
}

/** OpenAI-style chat message. Content is a string or multimodal parts. */
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

/**
 * Tolerant response schema: only the fields we read are validated; anything
 * else the gateway adds passes through.
 */
const ChatCompletionResponseSchema = z.looseObject({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({
          content: z.string().nullish(),
          refusal: z.string().nullish(),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
});

/** Models often wrap JSON in markdown fences despite instructions — strip them. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function toChatContent(parts: LlmContentPart[]): ChatMessage["content"] {
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => p.text).join("\n\n");
  }
  return parts.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : {
          type: "image_url" as const,
          image_url: { url: `data:${part.mediaType};base64,${part.base64}` },
        },
  );
}

/** The signal's reason, or a standard AbortError when the host gave none. */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The LLM call was aborted", "AbortError");
}

/** Sleep that ends early when `signal` aborts (the caller checks it afterwards). */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function seconds(ms: number): string {
  return `${ms / 1000}s`;
}

/**
 * One attempt's abort signal: fires when the caller's signal fires, or when
 * the per-attempt timeout elapses — and remembers which. A plain
 * `AbortController` plus `setTimeout` rather than `AbortSignal.timeout` /
 * `AbortSignal.any`: one code path in every browser, and one that fake
 * timers can drive in tests.
 */
class AttemptGuard {
  readonly signal: AbortSignal;
  timedOut = false;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly onCallerAbort: (() => void) | undefined;

  constructor(
    private readonly caller: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ) {
    this.signal = this.controller.signal;
    if (caller) {
      if (caller.aborted) {
        this.controller.abort(abortReason(caller));
      } else {
        this.onCallerAbort = () => this.controller.abort(abortReason(caller));
        caller.addEventListener("abort", this.onCallerAbort, { once: true });
      }
    }
    if (timeoutMs !== undefined) {
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.controller.abort();
      }, timeoutMs);
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    if (this.onCallerAbort) this.caller?.removeEventListener("abort", this.onCallerAbort);
  }
}

type AttemptOutcome =
  | { kind: "ok"; data: unknown }
  | { kind: "http"; status: number; text: string }
  | { kind: "network"; error: unknown }
  | { kind: "timeout" }
  | { kind: "aborted"; reason: unknown };

export class InternalLlmClient implements LlmClient {
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly jsonMode: boolean;
  private readonly maxNetworkRetries: number;
  private readonly retryDelayMs: number;
  private readonly retryableStatuses: readonly number[] | undefined;
  private readonly timeoutMs: number | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: InternalLlmClientOptions = {}) {
    const endpoint = (options.endpoint ?? envVar("LLM_ENDPOINT") ?? "").trim();
    if (endpoint === "") {
      throw new Error(
        "no LLM endpoint configured — set the LLM_ENDPOINT environment variable (or pass `endpoint`)",
      );
    }
    const base = endpoint.replace(/\/+$/, "");
    this.url = base.endsWith("/chat/completions")
      ? base
      : `${base}/chat/completions`;

    const model = (options.model ?? envVar("LLM_MODEL") ?? "").trim();
    if (model === "") {
      throw new Error(
        "no model configured — set the LLM_MODEL environment variable (or pass `model` / --model)",
      );
    }
    this.model = model;

    this.apiKey = options.apiKey ?? envVar("LLM_API_KEY") ?? undefined;

    const rawMaxTokens = envVar("LLM_MAX_TOKENS");
    const envMaxTokens = rawMaxTokens ? Number(rawMaxTokens) : undefined;
    if (envMaxTokens !== undefined && (!Number.isInteger(envMaxTokens) || envMaxTokens <= 0)) {
      throw new Error(`LLM_MAX_TOKENS must be a positive integer, got "${rawMaxTokens}"`);
    }
    this.maxTokens = options.maxTokens ?? envMaxTokens ?? 8192;

    const envJsonMode = (envVar("LLM_JSON_MODE") ?? "").toLowerCase();
    this.jsonMode =
      options.jsonMode ?? !["off", "false", "0", "no"].includes(envJsonMode);

    this.maxNetworkRetries = options.maxNetworkRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.retryableStatuses = options.retryableStatuses;
    this.timeoutMs = options.timeoutMs;
    this.signal = options.signal;
    // Wrapped, not assigned: a browser's `fetch` must be called with `this`
    // unset (or the window), never as a method of another object.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async structured<T>(options: StructuredCallOptions<T>): Promise<T> {
    const maxAttempts = 1 + (options.maxRepairAttempts ?? 2);
    const schemaJson = JSON.stringify(z.toJSONSchema(options.schema), null, 2);

    const system = [
      options.system,
      "",
      "Respond with a single JSON object and nothing else — no prose before or after, no markdown fences.",
      "The JSON object must conform exactly to this JSON Schema:",
      schemaJson,
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: toChatContent(options.user) },
    ];

    let lastErrors: string[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const data = await this.post({
        model: this.model,
        max_tokens: this.maxTokens,
        ...(this.jsonMode ? { response_format: { type: "json_object" } } : {}),
        messages,
      });

      const response = ChatCompletionResponseSchema.safeParse(data);
      if (!response.success) {
        throw new Error(
          `the LLM endpoint returned an unrecognized response shape (expected an OpenAI-style chat completion): ${response.error.issues[0]?.message ?? "unknown"}`,
        );
      }
      const choice = response.data.choices[0];

      // Content-filter decline: not repairable, maps to graceful rejection.
      if (choice.finish_reason === "content_filter" || choice.message.refusal) {
        throw new LlmRefusalError(options.taskLabel);
      }
      if (choice.finish_reason === "length") {
        throw new Error(
          `the model's output was truncated during ${options.taskLabel} — raise LLM_MAX_TOKENS (currently ${this.maxTokens})`,
        );
      }

      const raw = choice.message.content ?? "";
      const outcome = validateOutput(raw, options);
      if (outcome.ok) return outcome.value;
      lastErrors = outcome.errors;

      // Machine-facing repair: echo the model's own output back with the
      // validator's errors and retry.
      messages.push({ role: "assistant", content: raw || "(empty output)" });
      messages.push({ role: "user", content: repairMessage(lastErrors) });
    }

    throw new LlmRepairExhaustedError(options.taskLabel, maxAttempts, lastErrors);
  }

  private isRetryable(status: number): boolean {
    return this.retryableStatuses
      ? this.retryableStatuses.includes(status)
      : status === 429 || status >= 500;
  }

  /** POST with retries for network errors and retryable statuses; never for a timeout or an abort. */
  private async post(body: unknown): Promise<unknown> {
    const payload = JSON.stringify(body);
    for (let attempt = 0; ; attempt++) {
      if (this.signal?.aborted) throw abortReason(this.signal);

      const outcome = await this.attempt(payload);
      switch (outcome.kind) {
        case "ok":
          return outcome.data;
        case "aborted":
          throw outcome.reason;
        case "timeout":
          throw new Error(
            `could not reach the LLM endpoint at ${this.url}: timed out after ${seconds(this.timeoutMs ?? 0)}`,
          );
        case "network": {
          if (attempt < this.maxNetworkRetries) break;
          const cause = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          throw new Error(`could not reach the LLM endpoint at ${this.url}: ${cause}`);
        }
        case "http":
          if (this.isRetryable(outcome.status) && attempt < this.maxNetworkRetries) break;
          throw new LlmHttpError(
            outcome.status,
            `the LLM endpoint returned HTTP ${outcome.status}${outcome.text ? `: ${outcome.text.slice(0, 500)}` : ""}`,
            outcome.text,
          );
      }
      await sleep(this.retryDelayMs * (attempt + 1), this.signal);
    }
  }

  /** One HTTP attempt, classified. The body is read inside the guarded window, so a stalled body read times out too. */
  private async attempt(payload: string): Promise<AttemptOutcome> {
    const guard = new AttemptGuard(this.signal, this.timeoutMs);
    let response: Response | undefined;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: payload,
        signal: guard.signal,
      });
      if (response.ok) return { kind: "ok", data: await response.json() };
      return { kind: "http", status: response.status, text: await response.text().catch(() => "") };
    } catch (err) {
      if (this.signal?.aborted) return { kind: "aborted", reason: abortReason(this.signal) };
      if (guard.timedOut) return { kind: "timeout" };
      // The endpoint answered 2xx with a body that is not JSON: not a
      // transport failure, so not retried — surface it as it is.
      if (response !== undefined) throw err;
      return { kind: "network", error: err };
    } finally {
      guard.dispose();
    }
  }
}

type ValidationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

/** Parse -> Zod-validate -> semantic-check; failures become repair errors. */
function validateOutput<T>(
  raw: string,
  options: { schema: ZodType<T>; semanticCheck?: (value: T) => string[] },
): ValidationOutcome<T> {
  const text = stripFences(raw);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { ok: false, errors: [`the output was not valid JSON: ${cause}`] };
  }
  const parsed = options.schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) =>
          `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`,
      ),
    };
  }
  const semanticErrors = options.semanticCheck?.(parsed.data) ?? [];
  if (semanticErrors.length > 0) return { ok: false, errors: semanticErrors };
  return { ok: true, value: parsed.data };
}
