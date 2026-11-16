/**
 * Machine-facing repair message. This text is only ever exchanged between the
 * validator and the model inside the internal retry loop — it is never shown
 * to the user, and it must never be confused with the user-facing
 * conversation, which deals with missing information in the input, not with
 * malformed model output.
 */
export function repairMessage(errors: string[]): string {
  return [
    "AUTOMATED VALIDATION FAILURE (this message is from the validating program, not from the end user).",
    "Your previous output was rejected for these reasons:",
    ...errors.map((e) => `- ${e}`),
    "Produce a corrected output that fixes every problem, changing nothing else. Respond only via the required structure.",
  ].join("\n");
}
