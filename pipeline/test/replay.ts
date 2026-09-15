/**
 * Record and replay, for testing the browser path without a network.
 *
 * `FakeLlm` picks its canned output by `taskLabel`, which never appears in
 * an HTTP request, so a fake `fetch` cannot tell the pipeline's calls apart.
 * Instead a fixture is run ONCE through `FakeLlm` with a recorder around it
 * that keeps each call's validated output in order; a second run then goes
 * through a real `InternalLlmClient` whose `fetch` replays those outputs as
 * chat completions, in the same order. The two results must be identical,
 * and every request body must match the proxy's allow-list.
 */
import type { LlmClient, StructuredCallOptions } from "workflow-preprocessor";

/** Wraps a client and keeps every validated output, in call order. */
export class RecordingLlm implements LlmClient {
  readonly outputs: unknown[] = [];
  constructor(private readonly inner: LlmClient) {}

  async structured<T>(options: StructuredCallOptions<T>): Promise<T> {
    const value = await this.inner.structured(options);
    this.outputs.push(value);
    return value;
  }
}

export interface ReplayedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** A fetch that answers each POST with the next recorded output as a chat completion. */
export function replayFetch(outputs: readonly unknown[]): {
  fetchImpl: typeof fetch;
  requests: ReplayedRequest[];
} {
  const requests: ReplayedRequest[] = [];
  let next = 0;
  const fetchImpl = (async (input: any, init?: any) => {
    requests.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    if (next >= outputs.length) throw new Error("replay exhausted: more calls than were recorded");
    const content = JSON.stringify(outputs[next++]);
    return new Response(
      JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, requests };
}

/** The request-body keys the proxy accepts (§7.2b of the integration plan). */
export const PROXY_ALLOWED_KEYS = ["max_tokens", "messages", "model", "response_format"] as const;

/** The image URL shape the proxy accepts: a data URL, never http(s). */
export const DATA_IMAGE_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
