/**
 * Tests for vision/text routing: RoutingLlmClient dispatch, and the
 * createLlmClient factory's env/option resolution and fallbacks.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LlmClient, StructuredCallOptions } from "../src/llm/client.js";
import { InternalLlmClient } from "../src/llm/internalClient.js";
import { RoutingLlmClient, createLlmClient } from "../src/llm/routingClient.js";

const AnswerSchema = z.object({ answer: z.string() });

function recordingClient(name: string, log: string[]): LlmClient {
  return {
    async structured<T>(options: StructuredCallOptions<T>): Promise<T> {
      log.push(name);
      return options.schema.parse({ answer: name });
    },
  };
}

const textCall: StructuredCallOptions<{ answer: string }> = {
  system: "sys",
  user: [{ type: "text", text: "hello" }],
  schema: AnswerSchema,
  taskLabel: "test",
};

const imageCall: StructuredCallOptions<{ answer: string }> = {
  system: "sys",
  user: [
    { type: "image", mediaType: "image/png", base64: "QUJD" },
    { type: "text", text: "describe" },
  ],
  schema: AnswerSchema,
  taskLabel: "test",
};

interface RecordedCall {
  url: string;
  body: any;
}

/** Fetch stub that always returns a valid completion and records requests. */
function fetchStub(): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: any, init?: any) => {
    calls.push({ url: String(input), body: JSON.parse(init?.body as string) });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"answer":"ok"}' }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("RoutingLlmClient", () => {
  it("routes image-bearing calls to the vision client and text-only calls to the text client", async () => {
    const log: string[] = [];
    const router = new RoutingLlmClient({
      text: recordingClient("text", log),
      vision: recordingClient("vision", log),
    });
    await router.structured(textCall);
    await router.structured(imageCall);
    await router.structured(textCall);
    expect(log).toEqual(["text", "vision", "text"]);
  });
});

describe("createLlmClient", () => {
  it("returns a single InternalLlmClient when no vision configuration exists", () => {
    vi.stubEnv("LLM_VISION_MODEL", "");
    vi.stubEnv("LLM_VISION_ENDPOINT", "");
    vi.stubEnv("LLM_VISION_API_KEY", "");
    const client = createLlmClient({
      endpoint: "https://llm.internal.example/v1",
      model: "corp-model-1",
    });
    expect(client).toBeInstanceOf(InternalLlmClient);
  });

  it("activates routing from LLM_VISION_MODEL, falling back to the main endpoint", async () => {
    vi.stubEnv("LLM_VISION_MODEL", "corp-vlm-1");
    vi.stubEnv("LLM_VISION_ENDPOINT", "");
    vi.stubEnv("LLM_VISION_API_KEY", "");
    const { fetchImpl, calls } = fetchStub();
    const client = createLlmClient({
      endpoint: "https://llm.internal.example/v1",
      model: "corp-model-1",
      fetchImpl,
    });
    expect(client).toBeInstanceOf(RoutingLlmClient);

    await client.structured(textCall);
    await client.structured(imageCall);

    expect(calls[0].body.model).toBe("corp-model-1");
    expect(calls[1].body.model).toBe("corp-vlm-1");
    // Same gateway for both — vision endpoint fell back to the main one.
    expect(calls[0].url).toBe("https://llm.internal.example/v1/chat/completions");
    expect(calls[1].url).toBe("https://llm.internal.example/v1/chat/completions");
  });

  it("supports a separate vision endpoint with the model falling back to the main one", async () => {
    vi.stubEnv("LLM_VISION_MODEL", "");
    vi.stubEnv("LLM_VISION_API_KEY", "");
    const { fetchImpl, calls } = fetchStub();
    const client = createLlmClient({
      endpoint: "https://llm.internal.example/v1",
      model: "corp-model-1",
      visionEndpoint: "https://vlm.internal.example/v1",
      fetchImpl,
    });
    expect(client).toBeInstanceOf(RoutingLlmClient);

    await client.structured(imageCall);
    await client.structured(textCall);

    expect(calls[0].url).toBe("https://vlm.internal.example/v1/chat/completions");
    expect(calls[0].body.model).toBe("corp-model-1");
    expect(calls[1].url).toBe("https://llm.internal.example/v1/chat/completions");
  });

  it("prefers explicit options over LLM_VISION_* env vars", async () => {
    vi.stubEnv("LLM_VISION_MODEL", "env-vlm");
    const { fetchImpl, calls } = fetchStub();
    const client = createLlmClient({
      endpoint: "https://llm.internal.example/v1",
      model: "corp-model-1",
      visionModel: "flag-vlm",
      fetchImpl,
    });
    await client.structured(imageCall);
    expect(calls[0].body.model).toBe("flag-vlm");
  });
});
