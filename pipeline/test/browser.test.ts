/**
 * The browser entry point, exercised the way the website will use it: a
 * real `InternalLlmClient` pointed at a proxy path, with `fetch` replaying
 * the outputs a `FakeLlm` run recorded (see ./replay.ts). Proves that the
 * browser-safe entry resolves, that the HTTP path produces exactly the
 * result the in-process path does, and that every request the client
 * sends fits the proxy's allow-list — including the data-URL image part.
 */
import { describe, expect, it } from "vitest";
import { PIXEL_PNG_BASE64, textInput } from "workflow-preprocessor";
import {
  InternalLlmClient,
  inputFromBytes,
  isChoiceQuestion,
  runPipeline,
  type PipelineClarificationIO,
  type PipelineResult,
} from "../src/browser.js";
import { runPipeline as runPipelineNode } from "../src/pipeline/run.js";
import { FakeLlm } from "./fakeLlm.js";
import { fillLabel, happyHandlers, profileOrderThin, thinDraft } from "./fixtures.js";
import { DATA_IMAGE_URL, PROXY_ALLOWED_KEYS, RecordingLlm, replayFetch } from "./replay.js";

/** Both stages get a batch: the preprocess one is answered, the recommend one answered-and-stopped. */
const script: PipelineClarificationIO = {
  async askBatch(questions, _round, stage) {
    if (stage === "preprocess") {
      return {
        stopped: false,
        answers: questions.map((q) => ({ questionId: q.id, answer: "That step validates the order" })),
      };
    }
    return {
      stopped: true,
      answers: questions.filter(isChoiceQuestion).map((q) => ({ questionId: q.id, answer: "2" })),
    };
  },
};

function browserClient(fetchImpl: typeof fetch): InternalLlmClient {
  return new InternalLlmClient({
    endpoint: "/api/workflow-helper/llm",
    model: "server-managed",
    maxTokens: 4096,
    maxNetworkRetries: 1,
    retryableStatuses: [429, 502, 503],
    timeoutMs: 150_000,
    fetchImpl,
  });
}

const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("the browser entry point — record and replay", () => {
  it("produces the same result over HTTP as in-process, through both question stages", async () => {
    const recorder = new RecordingLlm(
      new FakeLlm({
        ...happyHandlers(),
        extraction: () => thinDraft(),
        "answer application": fillLabel,
        profiling: profileOrderThin,
      }),
    );
    const recorded = await runPipelineNode(recorder, textInput("thin process"), {
      io: script,
      inputLabel: "thin.txt",
    });
    expect(recorded.preprocess.status).toBe("validated");
    if (recorded.preprocess.status !== "rejected") {
      expect(recorded.preprocess.rounds).toHaveLength(1);
    }
    expect(recorded.recommendation.status).toBe("recommended");
    if (recorded.recommendation.status === "recommended") {
      expect(recorded.recommendation.rounds).toHaveLength(1);
    }
    // triage, normalization, extraction, answer application, profiling, summary
    expect(recorder.outputs).toHaveLength(6);

    const { fetchImpl, requests } = replayFetch(recorder.outputs);
    const replayed: PipelineResult = await runPipeline(browserClient(fetchImpl), textInput("thin process"), {
      io: script,
      inputLabel: "thin.txt",
    });

    expect(json(replayed)).toEqual(json(recorded));
    expect(replayed.status).toBe("complete");
    expect(requests).toHaveLength(6);

    for (const request of requests) {
      expect(request.url).toBe("/api/workflow-helper/llm/chat/completions");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.headers.authorization).toBeUndefined();
      // The proxy's allow-list: nothing else may be sent.
      expect(Object.keys(request.body).sort()).toEqual([...PROXY_ALLOWED_KEYS]);
      expect(request.body.model).toBe("server-managed");
      expect(request.body.max_tokens).toBe(4096);
      expect(request.body.response_format).toEqual({ type: "json_object" });
      const messages = request.body.messages as { role: string; content: unknown }[];
      expect(messages.length).toBeGreaterThanOrEqual(2);
      expect(messages.length).toBeLessThanOrEqual(12);
      for (const m of messages) expect(["system", "user", "assistant"]).toContain(m.role);
    }
  });

  it("sends an image input as a data-URL image_url part, and nothing else", async () => {
    const recorder = new RecordingLlm(new FakeLlm(happyHandlers()));
    const png = new Uint8Array(Buffer.from(PIXEL_PNG_BASE64, "base64"));
    const input = inputFromBytes(png, "flow.png");
    expect(input).toMatchObject({ kind: "image", mediaType: "image/png", fileName: "flow.png" });

    const recorded = await runPipelineNode(recorder, input, { inputLabel: "flow.png" });
    const { fetchImpl, requests } = replayFetch(recorder.outputs);
    const replayed = await runPipeline(browserClient(fetchImpl), input, { inputLabel: "flow.png" });
    expect(json(replayed)).toEqual(json(recorded));

    const imageParts = requests.flatMap((r) =>
      (r.body.messages as { content: unknown }[]).flatMap((m) =>
        Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image_url") : [],
      ),
    );
    // Exactly the preprocessor's two image-bearing calls: triage and normalization.
    expect(imageParts).toHaveLength(2);
    for (const part of imageParts) {
      expect(part.image_url.url).toMatch(DATA_IMAGE_URL);
      expect(part.image_url.url).toBe(`data:image/png;base64,${PIXEL_PNG_BASE64}`);
    }
    // Every other part is text; no other part types exist.
    for (const r of requests) {
      for (const m of r.body.messages as { content: unknown }[]) {
        if (Array.isArray(m.content)) {
          for (const p of m.content) expect(["text", "image_url"]).toContain(p.type);
        } else {
          expect(typeof m.content).toBe("string");
        }
      }
    }
  });
});
