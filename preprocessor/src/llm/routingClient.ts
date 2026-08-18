/**
 * Vision/text model routing.
 *
 * Only calls whose content includes an image part need a vision-capable
 * model — in this pipeline that is exactly triage and normalization, and only
 * when the input is a flowchart image (extraction and every clarification
 * round run on text by construction). That makes the routing signal intrinsic
 * to each call: no stage names, no configuration on the pipeline side.
 *
 * `RoutingLlmClient` dispatches each call to a vision client or a text
 * client based on that signal. `createLlmClient` builds the right client
 * from options/environment:
 *
 *   - no LLM_VISION_* configuration  -> a single `InternalLlmClient`
 *     (exactly the previous behavior);
 *   - any LLM_VISION_* value set     -> a `RoutingLlmClient` whose vision
 *     side uses the LLM_VISION_* values, falling back to the main
 *     endpoint/key/model for anything unset.
 *
 * Cost profile with routing enabled: a text input never touches the VLM; an
 * image input costs exactly two VLM calls (triage + normalization), with
 * extraction and all clarification rounds on the cheaper text model.
 */
import type { LlmClient, StructuredCallOptions } from "./client.js";
import {
  InternalLlmClient,
  type InternalLlmClientOptions,
} from "./internalClient.js";

export interface RoutingClients {
  /** Handles every call whose content is text-only. */
  text: LlmClient;
  /** Handles every call whose content includes an image part. */
  vision: LlmClient;
}

export class RoutingLlmClient implements LlmClient {
  constructor(private readonly clients: RoutingClients) {}

  structured<T>(options: StructuredCallOptions<T>): Promise<T> {
    const needsVision = options.user.some((part) => part.type === "image");
    return (needsVision ? this.clients.vision : this.clients.text).structured(
      options,
    );
  }
}

export interface CreateLlmClientOptions {
  /** Main endpoint. Default: LLM_ENDPOINT. */
  endpoint?: string;
  /** Main API key. Default: LLM_API_KEY. */
  apiKey?: string;
  /** Main (text) model. Default: LLM_MODEL. */
  model?: string;
  /** Vision endpoint. Default: LLM_VISION_ENDPOINT, falling back to the main endpoint. */
  visionEndpoint?: string;
  /** Vision API key. Default: LLM_VISION_API_KEY, falling back to the main key. */
  visionApiKey?: string;
  /** Vision model. Default: LLM_VISION_MODEL, falling back to the main model. */
  visionModel?: string;
  /** Injectable fetch for tests (used by both clients). */
  fetchImpl?: InternalLlmClientOptions["fetchImpl"];
}

/** Explicit option wins over the env var; blank values count as unset. */
function resolve(value: string | undefined, envName: string): string | undefined {
  const resolved = (value ?? process.env[envName] ?? "").trim();
  return resolved === "" ? undefined : resolved;
}

/**
 * Build the LLM client the pipeline should use, from options and environment.
 * Routing activates when any vision-specific value (option or LLM_VISION_*
 * env var) is set; otherwise this returns a single client and behaves exactly
 * as before the routing feature existed.
 */
export function createLlmClient(options: CreateLlmClientOptions = {}): LlmClient {
  const base: InternalLlmClientOptions = {
    endpoint: options.endpoint,
    apiKey: options.apiKey,
    model: options.model,
    fetchImpl: options.fetchImpl,
  };
  const text = new InternalLlmClient(base);

  const visionModel = resolve(options.visionModel, "LLM_VISION_MODEL");
  const visionEndpoint = resolve(options.visionEndpoint, "LLM_VISION_ENDPOINT");
  const visionApiKey = resolve(options.visionApiKey, "LLM_VISION_API_KEY");
  if (!visionModel && !visionEndpoint && !visionApiKey) {
    return text;
  }

  // Unset vision values fall back to the main settings — passing undefined
  // lets InternalLlmClient resolve LLM_ENDPOINT / LLM_API_KEY / LLM_MODEL
  // itself, so option-vs-env precedence stays in one place.
  const vision = new InternalLlmClient({
    ...base,
    endpoint: visionEndpoint ?? options.endpoint,
    apiKey: visionApiKey ?? options.apiKey,
    model: visionModel ?? options.model,
  });

  return new RoutingLlmClient({ text, vision });
}
