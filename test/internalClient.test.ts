/**
 * Tests for the OpenAI-compatible internal-endpoint client, against a
 * stubbed fetch — no network. Covers URL/auth wiring, JSON parsing and
 * fence-stripping, the machine-facing repair loop, refusal and truncation
 * mapping, retry behavior, and image-part conversion.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LlmRefusalError,
  LlmRepairExhaustedError,
} from "../src/llm/client.js";
import { InternalLlmClient, LlmHttpError } from "../src/llm/internalClient.js";
import { envVar } from "../src/llm/envVar.js";

const AnswerSchema = z.object({ answer: z.string() });

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function completion(content: string, finishReason = "stop"): unknown {
  return { choices: [{ message: { content }, finish_reason: finishReason }] };
}

/** A fetch stub that records requests and replays canned responses in order. */
function fetchStub(responses: Response[]): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(init?.body as string),
    });
    const next = responses.shift();
    if (!next) throw new Error("fetch stub exhausted");
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function client(
  fetchImpl: typeof fetch,
  over: Partial<ConstructorParameters<typeof InternalLlmClient>[0]> = {},
): InternalLlmClient {
  return new InternalLlmClient({
    endpoint: "https://llm.internal.example/v1",
    apiKey: "secret-key",
    model: "corp-model-1",
    retryDelayMs: 1,
    fetchImpl,
    ...over,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("InternalLlmClient — configuration", () => {
  it("appends /chat/completions to a base URL and sends Bearer auth + JSON mode", async () => {
    const { fetchImpl, calls } = fetchStub([jsonResponse(completion('{"answer":"hi"}'))]);
    const result = await client(fetchImpl).structured({
      system: "sys",
      user: [{ type: "text", text: "hello" }],
      schema: AnswerSchema,
      taskLabel: "test",
    });
    expect(result).toEqual({ answer: "hi" });
    expect(calls[0].url).toBe("https://llm.internal.example/v1/chat/completions");
    expect(calls[0].headers.authorization).toBe("Bearer secret-key");
    expect(calls[0].body.model).toBe("corp-model-1");
    expect(calls[0].body.response_format).toEqual({ type: "json_object" });
    // The JSON schema is embedded in the system message.
    expect(calls[0].body.messages[0].role).toBe("system");
    expect(calls[0].body.messages[0].content).toContain("JSON Schema");
    expect(calls[0].body.messages[0].content).toContain('"answer"');
  });

  it("keeps a full /chat/completions URL as-is, omits auth without a key, and can disable JSON mode", async () => {
    const { fetchImpl, calls } = fetchStub([jsonResponse(completion('{"answer":"hi"}'))]);
    await client(fetchImpl, {
      endpoint: "https://llm.internal.example/v1/chat/completions",
      apiKey: undefined,
      jsonMode: false,
    }).structured({
      system: "sys",
      user: [{ type: "text", text: "hello" }],
      schema: AnswerSchema,
      taskLabel: "test",
    });
    expect(calls[0].url).toBe("https://llm.internal.example/v1/chat/completions");
    expect(calls[0].headers.authorization).toBeUndefined();
    expect(calls[0].body.response_format).toBeUndefined();
  });

  it("requires an endpoint and a model", () => {
    vi.stubEnv("LLM_ENDPOINT", "");
    vi.stubEnv("LLM_MODEL", "");
    vi.stubEnv("LLM_API_KEY", "");
    const { fetchImpl } = fetchStub([]);
    expect(() => new InternalLlmClient({ fetchImpl })).toThrow(/LLM_ENDPOINT/);
    expect(
      () => new InternalLlmClient({ endpoint: "https://x/v1", fetchImpl }),
    ).toThrow(/LLM_MODEL/);
  });
});

describe("InternalLlmClient — output handling", () => {
  it("strips markdown fences around the JSON", async () => {
    const { fetchImpl } = fetchStub([
      jsonResponse(completion('```json\n{"answer":"fenced"}\n```')),
    ]);
    const result = await client(fetchImpl).structured({
      system: "sys",
      user: [{ type: "text", text: "hello" }],
      schema: AnswerSchema,
      taskLabel: "test",
    });
    expect(result).toEqual({ answer: "fenced" });
  });

  it("converts image parts to OpenAI image_url data URIs", async () => {
    const { fetchImpl, calls } = fetchStub([jsonResponse(completion('{"answer":"hi"}'))]);
    await client(fetchImpl).structured({
      system: "sys",
      user: [
        { type: "image", mediaType: "image/png", base64: "QUJD" },
        { type: "text", text: "describe" },
      ],
      schema: AnswerSchema,
      taskLabel: "test",
    });
    const content = calls[0].body.messages[1].content;
    expect(content[0]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,QUJD" },
    });
    expect(content[1]).toEqual({ type: "text", text: "describe" });
  });
});

describe("InternalLlmClient — machine repair loop", () => {
  it("repairs invalid JSON by echoing the output and the validator errors", async () => {
    const { fetchImpl, calls } = fetchStub([
      jsonResponse(completion("this is not json")),
      jsonResponse(completion('{"answer":"fixed"}')),
    ]);
    const result = await client(fetchImpl).structured({
      system: "sys",
      user: [{ type: "text", text: "hello" }],
      schema: AnswerSchema,
      taskLabel: "test",
    });
    expect(result).toEqual({ answer: "fixed" });
    expect(calls).toHaveLength(2);
    const retryMessages = calls[1].body.messages;
    expect(retryMessages).toHaveLength(4); // system, user, assistant echo, repair
    expect(retryMessages[2]).toEqual({ role: "assistant", content: "this is not json" });
    expect(retryMessages[3].role).toBe("user");
    expect(retryMessages[3].content).toContain("AUTOMATED VALIDATION FAILURE");
    expect(retryMessages[3].content).toContain("not valid JSON");
  });

  it("repairs schema violations with the field path in the error", async () => {
    const { fetchImpl, calls } = fetchStub([
      jsonResponse(completion('{"answer": 42}')),
      jsonResponse(completion('{"answer":"forty-two"}')),
    ]);
    const result = await client(fetchImpl).structured({
      system: "sys",
      user: [{ type: "text", text: "hello" }],
      schema: AnswerSchema,
      taskLabel: "test",
    });
    expect(result).toEqual({ answer: "forty-two" });
    expect(calls[1].body.messages[3].content).toContain("answer");
  });

  it("throws LlmRepairExhaustedError when semantic checks keep failing", async () => {
    const { fetchImpl, calls } = fetchStub([
      jsonResponse(completion('{"answer":"a"}')),
      jsonResponse(completion('{"answer":"b"}')),
    ]);
    await expect(
      client(fetchImpl).structured({
        system: "sys",
        user: [{ type: "text", text: "hello" }],
        schema: AnswerSchema,
        taskLabel: "test",
        semanticCheck: () => ["always wrong"],
        maxRepairAttempts: 1,
      }),
    ).rejects.toBeInstanceOf(LlmRepairExhaustedError);
    expect(calls).toHaveLength(2);
  });
});

describe("InternalLlmClient — endpoint failure modes", () => {
  it("maps content_filter to LlmRefusalError", async () => {
    const { fetchImpl } = fetchStub([jsonResponse(completion("", "content_filter"))]);
    await expect(
      client(fetchImpl).structured({
        system: "sys",
        user: [{ type: "text", text: "hello" }],
        schema: AnswerSchema,
        taskLabel: "test",
      }),
    ).rejects.toBeInstanceOf(LlmRefusalError);
  });

  it("reports truncation with a pointer to LLM_MAX_TOKENS", async () => {
    const { fetchImpl } = fetchStub([jsonResponse(completion('{"ans', "length"))]);
    await expect(
      client(fetchImpl).structured({
        system: "sys",
        user: [{ type: "text", text: "hello" }],
        schema: AnswerSchema,
        taskLabel: "test",
      }),
    ).rejects.toThrow(/LLM_MAX_TOKENS/);
  });

  it("retries 5xx and then succeeds", async () => {
    const { fetchImpl, calls } = fetchStub([
      jsonResponse({ error: "boom" }, 503),
      jsonResponse(completion('{"answer":"recovered"}')),
    ]);
    const result = await client(fetchImpl).structured({
      system: "sys",
      user: [{ type: "text", text: "hello" }],
      schema: AnswerSchema,
      taskLabel: "test",
    });
    expect(result).toEqual({ answer: "recovered" });
    expect(calls).toHaveLength(2);
  });

  it("surfaces non-retryable HTTP errors as LlmHttpError with the status", async () => {
    const { fetchImpl } = fetchStub([jsonResponse({ error: "bad key" }, 401)]);
    const promise = client(fetchImpl).structured({
      system: "sys",
      user: [{ type: "text", text: "hello" }],
      schema: AnswerSchema,
      taskLabel: "test",
    });
    await expect(promise).rejects.toBeInstanceOf(LlmHttpError);
    await promise.catch((err: LlmHttpError) => {
      expect(err.status).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------
// Browser-host behavior: the bundle runs this client in a browser, against a
// same-origin proxy. None of this needs a browser to test, but the first
// case reproduces the one failure Node never shows.
// ---------------------------------------------------------------------------

/** A fetch that honours `init.signal` and otherwise never settles. */
function hangingFetch(): { fetchImpl: typeof fetch; calls: number } {
  const state = { calls: 0 } as { fetchImpl: typeof fetch; calls: number };
  state.fetchImpl = ((_input: any, init?: any) => {
    state.calls++;
    return new Promise<Response>((_resolve, reject) => {
      const signal: AbortSignal | undefined = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  return state;
}

const call = (c: InternalLlmClient) =>
  c.structured({
    system: "sys",
    user: [{ type: "text", text: "hello" }],
    schema: AnswerSchema,
    taskLabel: "test",
  });

describe("InternalLlmClient — browser host", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("calls the default fetch unbound (a browser's fetch throws 'Illegal invocation' otherwise)", async () => {
    let seen: unknown = "unset";
    vi.stubGlobal("fetch", function (this: unknown) {
      seen = this;
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(jsonResponse(completion('{"answer":"hi"}')));
    });
    const c = new InternalLlmClient({
      endpoint: "https://llm.internal.example/v1",
      model: "m",
      retryDelayMs: 1,
    });
    await expect(call(c)).resolves.toEqual({ answer: "hi" });
    expect(seen === undefined || seen === globalThis).toBe(true);
  });

  it("times out a single attempt and does not retry it", async () => {
    vi.useFakeTimers();
    const hang = hangingFetch();
    const promise = call(client(hang.fetchImpl, { timeoutMs: 1000, maxNetworkRetries: 2 }));
    const outcome = expect(promise).rejects.toThrow(
      /could not reach the LLM endpoint at .*: timed out after 1s/,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
    expect(hang.calls).toBe(1);
  });

  it("rejects at once with the abort reason when the caller's signal fires, with no retry", async () => {
    const hang = hangingFetch();
    const controller = new AbortController();
    const promise = call(client(hang.fetchImpl, { signal: controller.signal, maxNetworkRetries: 2 }));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(hang.calls).toBe(1);
  });

  it("never starts a request on a signal that is already aborted", async () => {
    const hang = hangingFetch();
    const controller = new AbortController();
    controller.abort(new Error("run cancelled"));
    await expect(call(client(hang.fetchImpl, { signal: controller.signal }))).rejects.toThrow(
      "run cancelled",
    );
    expect(hang.calls).toBe(0);
  });

  it("cuts the backoff sleep short when aborted between retries", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new TypeError("network down");
    }) as typeof fetch;
    const promise = call(
      client(fetchImpl, { signal: controller.signal, retryDelayMs: 60_000, maxNetworkRetries: 2 }),
    );
    // The first attempt has failed and the client is sleeping before retry 1.
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("retryableStatuses narrows what is retried: 504 surfaces at once, 503 is retried", async () => {
    const over = { retryableStatuses: [429, 502, 503] as const };

    const gateway = fetchStub([jsonResponse({ error: "upstream timeout" }, 504)]);
    const failed = call(client(gateway.fetchImpl, over));
    await expect(failed).rejects.toBeInstanceOf(LlmHttpError);
    await failed.catch((err: LlmHttpError) => expect(err.status).toBe(504));
    expect(gateway.calls).toHaveLength(1);

    const busy = fetchStub([
      jsonResponse({ error: "busy" }, 503),
      jsonResponse(completion('{"answer":"recovered"}')),
    ]);
    await expect(call(client(busy.fetchImpl, over))).resolves.toEqual({ answer: "recovered" });
    expect(busy.calls).toHaveLength(2);
  });

  it("keeps the default retry rule (429 and every 5xx) when retryableStatuses is unset", async () => {
    const gateway = fetchStub([
      jsonResponse({ error: "upstream timeout" }, 504),
      jsonResponse(completion('{"answer":"recovered"}')),
    ]);
    await expect(call(client(gateway.fetchImpl))).resolves.toEqual({ answer: "recovered" });
    expect(gateway.calls).toHaveLength(2);
  });

  it("passes an abort signal to fetch on every attempt", async () => {
    const seen: unknown[] = [];
    const fetchImpl = (async (_input: any, init?: any) => {
      seen.push(init?.signal);
      return jsonResponse(completion('{"answer":"hi"}'));
    }) as typeof fetch;
    await call(client(fetchImpl));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("envVar", () => {
  it("reads process.env through the host object, and answers undefined without one", () => {
    expect(envVar("LLM_MODEL", { process: { env: { LLM_MODEL: "m1" } } })).toBe("m1");
    expect(envVar("LLM_MODEL", { process: { env: {} } })).toBeUndefined();
    expect(envVar("LLM_MODEL", { process: {} })).toBeUndefined();
    expect(envVar("LLM_MODEL", {})).toBeUndefined();
    expect(envVar("LLM_MODEL", undefined as unknown as object)).toBeUndefined();
  });

  it("defaults to the real global, so the CLI's environment still applies", () => {
    vi.stubEnv("LLM_MODEL", "from-env");
    expect(envVar("LLM_MODEL")).toBe("from-env");
    expect(new InternalLlmClient({ endpoint: "https://x/v1", fetchImpl: fetchStub([]).fetchImpl }))
      .toBeInstanceOf(InternalLlmClient);
  });
});
