/** The ordinal score maps are the ground the whole scorer stands on. */
import { describe, expect, it } from "vitest";
import {
  DURATIONS,
  DURATION_SCORE,
  ERROR_BONUS,
  ERROR_PRONENESS,
  FREQUENCIES,
  FREQUENCY_SCORE,
  JUDGMENTS,
  JUDGMENT_SCORE,
  SENSITIVITIES,
  SENSITIVITY_SCORE,
  STRUCTURES,
  STRUCTURE_SCORE,
  TASK_CLASSES,
  TASK_CLASS_DEFINITIONS,
} from "../src/schema/taxonomy.js";

function strictlyIncreasing(values: readonly string[], scores: Record<string, number>): void {
  for (let i = 1; i < values.length; i++) {
    expect(scores[values[i]]).toBeGreaterThan(scores[values[i - 1]]);
  }
}

describe("taxonomy", () => {
  it("every task class has a definition (prompt and enum cannot drift)", () => {
    for (const cls of TASK_CLASSES) {
      expect(TASK_CLASS_DEFINITIONS[cls]).toBeTruthy();
    }
  });

  it("ordinal scores are strictly increasing in scale order", () => {
    strictlyIncreasing(FREQUENCIES, FREQUENCY_SCORE);
    strictlyIncreasing(DURATIONS, DURATION_SCORE);
    strictlyIncreasing(STRUCTURES, STRUCTURE_SCORE);
    strictlyIncreasing(JUDGMENTS, JUDGMENT_SCORE);
    strictlyIncreasing(SENSITIVITIES, SENSITIVITY_SCORE);
    strictlyIncreasing(ERROR_PRONENESS, ERROR_BONUS);
  });

  it("scales used in feasibility start at 1 and impact bonus starts at 0", () => {
    expect(FREQUENCY_SCORE[FREQUENCIES[0]]).toBe(1);
    expect(DURATION_SCORE[DURATIONS[0]]).toBe(1);
    expect(STRUCTURE_SCORE[STRUCTURES[0]]).toBe(1);
    expect(JUDGMENT_SCORE[JUDGMENTS[0]]).toBe(1);
    expect(ERROR_BONUS[ERROR_PRONENESS[0]]).toBe(0);
  });
});
