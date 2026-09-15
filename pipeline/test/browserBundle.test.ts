/**
 * The bundle itself: builds `src/browser.ts` for the browser with the same
 * script `npm run build:browser` uses, then loads the output and runs the
 * pipeline through it. The build's own guards do most of the work — a
 * `node:` import or a second copy of zod fails the build — and loading the
 * result proves the output is a working ES module, not just a green build.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { textInput } from "workflow-preprocessor";
import { buildBrowserBundle } from "../scripts/build-browser.mjs";
import { runPipeline } from "../src/pipeline/run.js";
import { FakeLlm } from "./fakeLlm.js";
import { happyHandlers } from "./fixtures.js";
import { RecordingLlm, replayFetch } from "./replay.js";

const NODE_SPECIFIER = /\bfrom\s*["']node:|\bimport\s*\(\s*["']node:|\brequire\s*\(\s*["']node:|^\s*import\s*["']node:/m;

/** The runtime exports the website relies on (types do not exist at runtime). */
const EXPECTED_EXPORTS = [
  "DEFAULT_INPUT_LABEL",
  "InternalLlmClient",
  "LlmHttpError",
  "LlmRefusalError",
  "LlmRepairExhaustedError",
  "PipelineStageError",
  "STAGE_BANNERS",
  "displayToken",
  "inputFromBytes",
  "isChoiceQuestion",
  "runPipeline",
  "sniffImageMediaType",
  "textInput",
];

describe("the browser bundle", () => {
  it("builds for the browser — one zod, no node: specifiers, a banner — and loads with the documented exports", async () => {
    const out = await buildBrowserBundle({ write: false });
    const js = out.js.toString("utf8");

    expect(out.warnings).toEqual([]);
    expect(js.startsWith("/* workflow-helper ")).toBe(true);
    expect(js).toContain("do not edit */");
    expect(js).not.toMatch(NODE_SPECIFIER);
    expect(out.zodDir).toMatch(/preprocessor[\\/]node_modules[\\/]zod$/);
    expect(out.bytes).toBeGreaterThan(50_000);
    expect(out.gzipBytes).toBeLessThan(out.bytes);
    expect(out.outputFiles?.some((f) => f.path.endsWith(".js.map"))).toBe(true);

    // Written as the pair esbuild produced, so the sourcemap comment resolves.
    const dir = mkdtempSync(join(tmpdir(), "wfh-bundle-"));
    const file = join(dir, "workflow-helper.js");
    writeFileSync(file, js);
    const map = out.outputFiles?.find((f) => f.path.endsWith(".js.map"));
    if (map) writeFileSync(join(dir, "workflow-helper.js.map"), map.contents);
    const bundle = await import(pathToFileURL(file).href);
    expect(Object.keys(bundle).sort()).toEqual(EXPECTED_EXPORTS);

    // The bundle's own client and pipeline, end to end, against a replay of
    // what the source pipeline produced for the same fixture.
    const recorder = new RecordingLlm(new FakeLlm(happyHandlers()));
    const recorded = await runPipeline(recorder, textInput("order"), { inputLabel: "order.txt" });
    const { fetchImpl, requests } = replayFetch(recorder.outputs);
    const llm = new bundle.InternalLlmClient({
      endpoint: "/api/workflow-helper/llm",
      model: "server-managed",
      retryableStatuses: [429, 502, 503],
      fetchImpl,
    });
    const result = await bundle.runPipeline(llm, bundle.textInput("order"), { inputLabel: "order.txt" });
    expect(JSON.parse(JSON.stringify(result))).toEqual(JSON.parse(JSON.stringify(recorded)));
    expect(requests.every((r) => r.url === "/api/workflow-helper/llm/chat/completions")).toBe(true);
  }, 60_000);
});
