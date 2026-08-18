/**
 * Tests for the --check probe. The value of the probe is the diagnosis, so
 * these assert that each failure mode maps to a message that names the thing
 * to fix — and that the vision probe actually sends an image part, since that
 * is the only signal the router uses.
 */
import { describe, expect, it, vi } from "vitest";
import { LlmRefusalError, LlmRepairExhaustedError, type LlmClient } from "../src/llm/client.js";
import { LlmHttpError } from "../src/llm/internalClient.js";
import { probeLlm } from "../src/llm/probe.js";

function failing(err: unknown): LlmClient {
  return { structured: vi.fn().mockRejectedValue(err) };
}

describe("probeLlm — success", () => {
  it("reports ok when the endpoint returns valid structured output", async () => {
    const llm: LlmClient = { structured: vi.fn().mockResolvedValue({ ok: true }) };
    const result = await probeLlm(llm);
    expect(result.ok).toBe(true);
  });

  it("sends a text-only call by default and an image part for the vision probe", async () => {
    const structured = vi.fn().mockResolvedValue({ ok: true });
    const llm: LlmClient = { structured };

    await probeLlm(llm);
    expect(structured.mock.calls[0][0].user.some((p: any) => p.type === "image")).toBe(false);

    await probeLlm(llm, { withImage: true });
    const visionParts = structured.mock.calls[1][0].user;
    expect(visionParts.some((p: any) => p.type === "image")).toBe(true);
    expect(visionParts.find((p: any) => p.type === "image").mediaType).toBe("image/png");
  });

  it("still counts as reachable when the model answers ok:false", async () => {
    const llm: LlmClient = { structured: vi.fn().mockResolvedValue({ ok: false }) };
    expect((await probeLlm(llm)).ok).toBe(true);
  });
});

describe("probeLlm — diagnosis", () => {
  it("points at the API key on 401/403", async () => {
    const result = await probeLlm(failing(new LlmHttpError(401, "unauthorized")));
    expect(result.ok).toBe(false);
    expect(result.hint).toMatch(/LLM_API_KEY/);
  });

  it("points at the vision key when the vision route is the one failing", async () => {
    const result = await probeLlm(failing(new LlmHttpError(403, "forbidden")), {
      withImage: true,
    });
    expect(result.hint).toMatch(/LLM_VISION_API_KEY/);
  });

  it("points at the URL and model name on 404", async () => {
    const result = await probeLlm(failing(new LlmHttpError(404, "not found")));
    expect(result.hint).toMatch(/LLM_MODEL/);
  });

  it("suggests LLM_JSON_MODE=off when a 400 mentions response_format", async () => {
    const result = await probeLlm(
      failing(new LlmHttpError(400, "bad request", "response_format not supported")),
    );
    expect(result.detail).toMatch(/response_format not supported/);
    expect(result.hint).toMatch(/LLM_JSON_MODE=off/);
  });

  it("suggests a vision-capable deployment when the image call 400s", async () => {
    const result = await probeLlm(failing(new LlmHttpError(400, "bad", "no image support")), {
      withImage: true,
    });
    expect(result.hint).toMatch(/LLM_VISION_MODEL/);
  });

  it("suggests the VPN when the endpoint is unreachable", async () => {
    const result = await probeLlm(
      failing(new Error("could not reach the LLM endpoint at https://x: ENOTFOUND")),
    );
    expect(result.hint).toMatch(/VPN/);
  });

  it("maps a refusal and an exhausted repair loop to actionable messages", async () => {
    expect((await probeLlm(failing(new LlmRefusalError("connectivity check")))).ok).toBe(false);

    const exhausted = await probeLlm(
      failing(new LlmRepairExhaustedError("connectivity check", 2, ["not JSON"])),
    );
    expect(exhausted.ok).toBe(false);
    expect(exhausted.hint).toMatch(/LLM_JSON_MODE=off/);
  });
});
