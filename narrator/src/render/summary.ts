/**
 * The summary layer's two deterministic halves:
 *
 * - `deterministicSummary()` fills the same five slots the model fills
 *   (`SummaryContent`), from the result alone. It is what the report leads
 *   with when no model was requested, and the fallback when the model's
 *   summary was unavailable — so a report NEVER ships without a summary.
 * - `renderSummarySection()` renders either kind into the "## Summary"
 *   section, labelled honestly with which kind it is.
 */
import type { PatternDef, PatternVariant } from "workflow-recommender";
import type { LoadedOpportunity, NarratableRecommendation } from "../schema/input.js";
import type { SummaryBlock, SummaryContent } from "../schema/narration.js";
import { targetRef, type ReportContext } from "./report.js";
import { AUTOMATION_CLASS_PHRASE, EFFORT_PHRASE, isAiClass, listPhrase, plural, quote } from "./phrases.js";

function patternOf(ctx: ReportContext, id: string): PatternDef | undefined {
  return ctx.catalog.find((p) => p.id === id);
}

function nameOf(ctx: ReportContext, opp: LoadedOpportunity): string {
  return opp.sequence.map((s) => patternOf(ctx, s.patternId)?.name ?? s.patternId).join(", then ");
}

function bestVariantDef(ctx: ReportContext, opp: LoadedOpportunity): PatternVariant | undefined {
  return patternOf(ctx, opp.patternId)?.variants.find((v) => v.id === opp.variants[0].variantId);
}

function mention(ctx: ReportContext, opp: LoadedOpportunity): string {
  return `${nameOf(ctx, opp)} for ${targetRef(ctx, opp.target)} (${opp.score.total}/100, ${opp.confidence} confidence)`;
}

/** A summary assembled by rules from the result — no model involved. */
export function deterministicSummary(ctx: ReportContext, result: NarratableRecommendation): SummaryContent {
  const name = result.workflowName ? quote(result.workflowName) : "this workflow";
  const opps = result.opportunities;
  const top = opps[0];
  const openCount = result.status === "partial" ? result.openQuestions.length : 0;

  if (!top) {
    const why =
      result.excluded.length > 0
        ? ` ${plural(result.excluded.length, "pattern")} matched but every deployment option exceeded the data sensitivity involved.`
        : "";
    return {
      headline: `No improvement opportunities matched ${name}.`,
      overview: `The recommender analysed ${plural(result.profiles.length, "step")} and found no pattern in its catalog that applies.${why}`,
      takeaways: [`Nothing in the catalog applies to ${name} as described.`],
      firstStep:
        result.excluded.length > 0
          ? "Review the exclusions: if the data sensitivity was over-estimated, correct it and re-run."
          : "Add detail to the step descriptions (who does what, how often, how rule-like) and re-run the recommender.",
      caveats: openCount > 0 ? [`${plural(openCount, "attribute question")} remain open.`] : [],
    };
  }

  const classes = opps.map((o) => patternOf(ctx, o.patternId)?.automationClass);
  const aiCount = classes.filter((c) => c !== undefined && isAiClass(c)).length;
  const nonAiCount = classes.filter((c) => c !== undefined && !isAiClass(c)).length;
  const lowCount = opps.filter((o) => o.confidence === "low").length;

  const sentences: string[] = [];
  sentences.push(
    `The recommender matched ${plural(opps.length, "improvement opportunity", "improvement opportunities")} across ` +
      `${plural(result.profiles.length, "analysed step")}` +
      (result.motifs.length > 0 ? ` and ${plural(result.motifs.length, "multi-step shape")}` : "") +
      ".",
  );
  sentences.push(
    `The strongest is ${mention(ctx, top)}` +
      (top.sequence.length > 1 ? ", as a two-step sequence" : "") +
      ".",
  );
  const runnersUp = opps.slice(1, 3);
  if (runnersUp.length > 0) {
    sentences.push(`Next come ${listPhrase(runnersUp.map((o) => mention(ctx, o)))}.`);
  }
  if (nonAiCount + aiCount > 0) {
    sentences.push(
      `${nonAiCount} of the ${opps.length} ${opps.length === 1 ? "is a" : "are"} non-AI change${nonAiCount === 1 ? "" : "s"}; ${aiCount} bring${aiCount === 1 ? "s" : ""} in AI.`,
    );
  }
  if (result.excluded.length > 0) {
    sentences.push(
      `${plural(result.excluded.length, "pattern")} ${result.excluded.length === 1 ? "was" : "were"} ruled out because no deployment option may touch the data involved.`,
    );
  }
  if (result.status === "partial") {
    sentences.push(
      `The result is partial (${result.reason}): ${plural(openCount, "attribute question")} remain${openCount === 1 ? "s" : ""} open, so unknown values were scored at their most conservative and confidence is lowered.`,
    );
  }
  if (lowCount > 0) {
    sentences.push(`${plural(lowCount, "opportunity", "opportunities")} carr${lowCount === 1 ? "ies" : "y"} low confidence.`);
  }

  const takeaways = opps.slice(0, 3).map((o) => {
    const pattern = patternOf(ctx, o.patternId);
    const kind = pattern ? `${AUTOMATION_CLASS_PHRASE[pattern.automationClass]}; ` : "";
    return `${nameOf(ctx, o)} for ${targetRef(ctx, o.target)}: ${o.score.total}/100, ${o.confidence} confidence, ${kind}${EFFORT_PHRASE[o.variants[0].effort]}.`;
  });
  if (result.excluded.length > 0) {
    takeaways.push(
      `${plural(result.excluded.length, "pattern")} ${result.excluded.length === 1 ? "is" : "are"} excluded by data sensitivity — a lower sensitivity classification, if accurate, would bring ${result.excluded.length === 1 ? "it" : "them"} back.`,
    );
  }

  const bestDef = bestVariantDef(ctx, top);
  const prereqs = bestDef && bestDef.prerequisites.length > 0 ? ` Before starting: ${bestDef.prerequisites.join("; ")}.` : "";
  const firstStep = `${nameOf(ctx, top)} for ${targetRef(ctx, top.target)} — the top-ranked opportunity — using its best deployment option, ${top.variants[0].name} (${EFFORT_PHRASE[top.variants[0].effort]}).${prereqs}`;

  const caveats: string[] = top.confidenceReasons.slice(0, 3).map((r) => `Top recommendation: ${r}.`);
  if (openCount > 0) {
    caveats.push(
      `${plural(openCount, "attribute question")} remain${openCount === 1 ? "s" : ""} open; answering ${openCount === 1 ? "it" : "them"} would sharpen every score.`,
    );
  }
  if (result.inheritedOpenQuestions.length > 0) {
    caveats.push(
      `${plural(result.inheritedOpenQuestions.length, "question")} about the workflow itself ${result.inheritedOpenQuestions.length === 1 ? "is" : "are"} still open from the preprocessor.`,
    );
  }

  return {
    headline: `${plural(opps.length, "improvement opportunity", "improvement opportunities")} for ${name} — start with ${nameOf(ctx, top)} for ${targetRef(ctx, top.target)}.`,
    overview: sentences.join(" "),
    takeaways,
    firstStep,
    caveats,
  };
}

/** Strip a leading list marker or heading hashes the model may have added. */
function cleanLine(text: string): string {
  return text.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/, "").trim();
}

function cleanParagraphs(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#{1,6}\s+/, ""))
    .join("\n")
    .trim();
}

export function renderSummarySection(summary: SummaryBlock): string {
  const provenance =
    summary.kind === "model"
      ? "_Written by the model from the sections below; every score it cites was checked against them._"
      : `_Written deterministically — ${summary.reason}._`;
  const lines = ["## Summary", "", provenance, "", `**${cleanLine(summary.headline)}**`, "", cleanParagraphs(summary.overview)];
  if (summary.takeaways.length > 0) {
    lines.push("", "**Key takeaways**", "");
    for (const t of summary.takeaways) lines.push(`- ${cleanLine(t)}`);
  }
  lines.push("", `**Suggested first step.** ${cleanLine(summary.firstStep)}`);
  if (summary.caveats.length > 0) {
    lines.push("", "**Caveats**", "");
    for (const c of summary.caveats) lines.push(`- ${cleanLine(c)}`);
  }
  return lines.join("\n");
}
