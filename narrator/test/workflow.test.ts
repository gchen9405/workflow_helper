/** Finding the preprocessor result that names the steps. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkflow, siblingWorkflowPath, workflowFromPreprocessResult } from "../src/io/workflow.js";
import { claimsIntake, reKnowledgePipeline, validatedResult } from "./fixtures.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "narrator-"));
}

function write(path: string, value: unknown): string {
  writeFileSync(path, JSON.stringify(value), "utf8");
  return path;
}

describe("siblingWorkflowPath", () => {
  it("maps <stem>.recommendations.json to <stem>.json next to it", () => {
    expect(siblingWorkflowPath("/x/re.recommendations.json")).toBe("/x/re.json");
  });
  it("is null for any other name", () => {
    expect(siblingWorkflowPath("/x/re.json")).toBeNull();
  });
});

describe("workflowFromPreprocessResult", () => {
  it("returns the workflow for validated results and null for rejected ones", () => {
    const wf = workflowFromPreprocessResult(validatedResult(reKnowledgePipeline()));
    expect(wf?.name).toBe("RE knowledge pipeline");
    expect(workflowFromPreprocessResult({ status: "rejected", reason: "nope" })).toBeNull();
  });
});

describe("resolveWorkflow", () => {
  const nodeIds = ["collect", "distill", "expose", "agent_assist", "verify"];

  it("an explicit file that is missing is an error", () => {
    expect(() => resolveWorkflow({ explicitPath: join(dir(), "missing.json") })).toThrow(/not found/);
  });

  it("an explicit file that is not a preprocessor result is an error", () => {
    const path = write(join(dir(), "junk.json"), { hello: 1 });
    expect(() => resolveWorkflow({ explicitPath: path })).toThrow(/could not read the workflow file/);
  });

  it("an explicit rejected result is an error", () => {
    const path = write(join(dir(), "rejected.json"), { status: "rejected", reason: "x" });
    expect(() => resolveWorkflow({ explicitPath: path })).toThrow(/rejected/);
  });

  it("an explicit file that lacks the profiled steps is an error naming them", () => {
    const path = write(join(dir(), "other.json"), validatedResult(claimsIntake()));
    expect(() => resolveWorkflow({ explicitPath: path, requiredNodeIds: nodeIds })).toThrow(
      /not the one this result was produced from — it has no steps "collect", "distill"/,
    );
  });

  it("an explicit file wins over every hint", () => {
    const d = dir();
    const explicit = write(join(d, "explicit.json"), validatedResult(reKnowledgePipeline()));
    write(join(d, "re.json"), validatedResult(claimsIntake()));
    const resolved = resolveWorkflow({
      explicitPath: explicit,
      inputPath: join(d, "re.recommendations.json"),
      sourcePath: join(d, "re.json"),
    });
    expect(resolved?.path).toBe(explicit);
    expect(resolved?.workflow.name).toBe("RE knowledge pipeline");
  });

  it("uses source.path when it exists and covers the profiled nodes", () => {
    const d = dir();
    const source = write(join(d, "from-source.json"), validatedResult(reKnowledgePipeline()));
    const resolved = resolveWorkflow({ sourcePath: source, requiredNodeIds: nodeIds });
    expect(resolved?.path).toBe(source);
  });

  it("falls back to the sibling <stem>.json when source.path is gone", () => {
    const d = dir();
    const sibling = write(join(d, "re.json"), validatedResult(reKnowledgePipeline()));
    const resolved = resolveWorkflow({
      sourcePath: join(d, "moved-away.json"),
      inputPath: join(d, "re.recommendations.json"),
      requiredNodeIds: nodeIds,
    });
    expect(resolved?.path).toBe(sibling);
  });

  it("discards a candidate that does not contain the profiled nodes", () => {
    const d = dir();
    write(join(d, "re.json"), validatedResult(claimsIntake())); // a different workflow
    const resolved = resolveWorkflow({
      inputPath: join(d, "re.recommendations.json"),
      requiredNodeIds: nodeIds,
    });
    expect(resolved).toBeNull();
  });

  it("skips unreadable and rejected candidates without throwing", () => {
    const d = dir();
    writeFileSync(join(d, "re.json"), "{ not json", "utf8");
    const rejected = write(join(d, "src.json"), { status: "rejected", reason: "x" });
    const resolved = resolveWorkflow({
      sourcePath: rejected,
      inputPath: join(d, "re.recommendations.json"),
      requiredNodeIds: nodeIds,
    });
    expect(resolved).toBeNull();
  });

  it("is null when there are no hints at all", () => {
    expect(resolveWorkflow({})).toBeNull();
  });
});
