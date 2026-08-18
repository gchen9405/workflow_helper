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
