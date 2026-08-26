/** Gap detection is the loop's termination condition — test it exhaustively. */
import { describe, expect, it } from "vitest";
import { detectProfileGaps, profileGapId } from "../src/pipeline/gaps.js";
import { profile } from "./helpers.js";

describe("detectProfileGaps", () => {
  it("a fully known profile has no gaps — the definition of complete", () => {
    expect(detectProfileGaps([profile("a")])).toEqual([]);
  });

  it("null taskClass and null required attributes each fire one gap", () => {
    const gaps = detectProfileGaps([
      profile("a", { taskClass: null, frequency: null, dataSensitivity: null }),
    ]);
    expect(gaps).toEqual([
      { kind: "missing_task_class", nodeId: "a" },
      { kind: "missing_attribute", nodeId: "a", attribute: "frequency" },
      { kind: "missing_attribute", nodeId: "a", attribute: "dataSensitivity" },
    ]);
  });

  it("errorProneness is optional enrichment — never a gap", () => {
    expect(detectProfileGaps([profile("a", { errorProneness: null })])).toEqual([]);
  });

  it("covers every required attribute", () => {
    const gaps = detectProfileGaps([
      profile("a", {
        frequency: null,
        duration: null,
        structure: null,
        judgment: null,
        dataSensitivity: null,
        actorKind: null,
      }),
    ]);
    expect(gaps.map((g) => (g.kind === "missing_attribute" ? g.attribute : g.kind))).toEqual([
      "frequency",
      "duration",
      "structure",
      "judgment",
      "dataSensitivity",
      "actorKind",
    ]);
  });

  it("gap ids are stable and unique across nodes and attributes", () => {
    const gaps = detectProfileGaps([
      profile("a", { taskClass: null, frequency: null }),
      profile("b", { frequency: null }),
    ]);
    expect(gaps.map(profileGapId)).toEqual([
      "missing_task_class:a",
      "missing_attribute:a:frequency",
      "missing_attribute:b:frequency",
    ]);
  });
});
