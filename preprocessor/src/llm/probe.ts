/**
 * Configuration probe behind `--check`.
 *
 * Every failure mode this catches — wrong base URL, missing/expired key, a
 * model name the gateway doesn't recognise, a gateway that rejects
 * `response_format: json_object`, a "vision" deployment that is not actually
 * multimodal — otherwise surfaces halfway through a real run, after the input
 * has already been read and one or more calls have been paid for. Probing is
 * one trivial round trip per configured route.
 *
 * The vision probe deliberately sends a 1x1 image: routing is decided by
 * whether the content includes an image part (`routingClient.ts`), so this is
 * the only way to exercise the vision route end to end rather than assuming it.
 */
import { z } from "zod";
import { LlmHttpError } from "./internalClient.js";
import { LlmRefusalError, LlmRepairExhaustedError, type LlmClient } from "./client.js";
import type { ImageMediaType } from "../io/input.js";

/** A valid 1x1 PNG — the smallest thing that forces the vision route. */
export const PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";

const ProbeSchema = z.object({ ok: z.boolean() });

export interface ProbeOutcome {
  ok: boolean;
  /** One-line explanation shown to the user when `ok` is false. */
  detail: string;
  /** Actionable next step, when we can name one. */
  hint?: string;
}

/**
 * Send the smallest possible structured call. Success means the endpoint is
 * reachable, authenticated, serving the requested model, and capable of
 * returning schema-conforming JSON — the four things the pipeline relies on.
 */
export async function probeLlm(
  llm: LlmClient,
  options: { withImage?: boolean } = {},
): Promise<ProbeOutcome> {
  const image = options.withImage ?? false;
  try {
    const result = await llm.structured({
      system: "You are a connectivity check. Reply with the JSON object {\"ok\": true} and nothing else.",
      user: image
        ? [
            { type: "text", text: "Reply with {\"ok\": true}." },
            {
              type: "image",
              mediaType: "image/png" as ImageMediaType,
              base64: PIXEL_PNG_BASE64,
            },
          ]
        : [{ type: "text", text: "Reply with {\"ok\": true}." }],
      schema: ProbeSchema,
      taskLabel: image ? "vision check" : "connectivity check",
      maxRepairAttempts: 1,
    });
    return result.ok
      ? { ok: true, detail: "reachable, authenticated, returning valid JSON" }
      : {
          ok: true,
          detail: "reachable and returning valid JSON (the model answered ok:false, which is harmless here)",
        };
  } catch (err) {
    return explain(err, image);
  }
}

function explain(err: unknown, image: boolean): ProbeOutcome {
  if (err instanceof LlmHttpError) {
    if (err.status === 401 || err.status === 403) {
      return {
        ok: false,
        detail: `HTTP ${err.status} — authentication rejected`,
        hint: image
          ? "check LLM_VISION_API_KEY (it falls back to LLM_API_KEY when unset)"
          : "check LLM_API_KEY",
      };
    }
    if (err.status === 404) {
      return {
        ok: false,
        detail: "HTTP 404 — no such endpoint or model",
        hint: `check the base URL (it should be the part before /chat/completions) and the ${image ? "LLM_VISION_MODEL" : "LLM_MODEL"} deployment name`,
      };
    }
    if (err.status === 400) {
      return {
        ok: false,
        detail: `HTTP 400 — the gateway rejected the request: ${(err.body ?? "").slice(0, 200)}`,
        hint: image
          ? "this deployment may not accept images — point LLM_VISION_MODEL at a vision-capable model"
          : "if the message mentions response_format, set LLM_JSON_MODE=off",
      };
    }
    return { ok: false, detail: err.message };
  }

  if (err instanceof LlmRefusalError) {
    return { ok: false, detail: "the endpoint's safety layer declined a trivial request" };
  }

  if (err instanceof LlmRepairExhaustedError) {
    return {
      ok: false,
      detail: "the model could not return a valid JSON object",
      hint: image
        ? "the vision deployment answered, but not with usable JSON — try a different LLM_VISION_MODEL"
        : "try LLM_JSON_MODE=off, or a model that supports JSON output",
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    detail: message,
    hint: message.includes("could not reach")
      ? "check LLM_ENDPOINT and whether you need to be on the VPN"
      : undefined,
  };
}
