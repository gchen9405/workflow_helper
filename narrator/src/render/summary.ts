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
import {
  AUTOMATION_CLASS_SHORT,
  CONFIDENCE_PHRASE,
  EFFORT_PHRASE,
  isAiClass,
  listPhrase,
  plural,
  quote,
  scoreBand,
  scoreLabel,
} from "./phrases.js";

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

function patternOf(ctx: ReportContext, id: string): PatternDef | undefined {
  return ctx.catalog.find((p) => p.id === id);
}

function nameOf(ctx: ReportContext, opp: LoadedOpportunity): string {
  return opp.sequence.map((s) => patternOf(ctx, s.patternId)?.name ?? s.patternId).join(", then ");
}

function bestVariantDef(ctx: ReportContext, opp: LoadedOpportunity): PatternVariant | undefined {
  return patternOf(ctx, opp.patternId)?.variants.find((v) => v.id === opp.variants[0].variantId);
}

/**
 * One opportunity named in prose. Parenthesised rather than dash-separated:
 * these get joined into "X, Y and Z" lists, where a trailing em-dash clause
 * makes it impossible to see where one item ends and the next begins.
 */
function mention(ctx: ReportContext, opp: LoadedOpportunity): string {
  return `${nameOf(ctx, opp)} for ${targetRef(ctx, opp.target)} (${scoreBand(opp.score.total)}, ${opp.score.total}/100, ${CONFIDENCE_PHRASE[opp.confidence]})`;
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

  // The four slots carry FOUR DIFFERENT things, not one thing four times:
  // the overview narrates, the takeaways describe the shape of the whole set,
  // firstStep is the action, and the caveats are what limits the answer. A
  // deterministic summary has only a handful of facts to work with, so
  // dividing them is the only way to keep it from repeating itself — and
  // from repeating the decision table immediately below it.
  const found: string[] = [
    `We looked at ${plural(result.profiles.length, "step")} of ${name}` +
      (result.motifs.length > 0 ? ` and ${plural(result.motifs.length, "shape")} spanning several steps` : "") +
      `, and found ${plural(opps.length, "change", "changes")} worth considering.`,
    `The strongest is ${mention(ctx, top)}` + (top.sequence.length > 1 ? ", done as two changes in sequence" : "") + ".",
  ];
  const runnersUp = opps.slice(1, 3);
  if (runnersUp.length > 0) {
    found.push(`Next come ${listPhrase(runnersUp.map((o) => mention(ctx, o)))}.`);
  }

  const trust: string[] = [];
  if (result.status === "partial") {
    trust.push(
      `The result is partial — ${result.reason}, leaving ${plural(openCount, "question")} unanswered. ` +
        "Anything unknown was assumed to be the least favourable value, so these ratings are floors, not estimates.",
    );
  }
  const overview = [found.join(" "), trust.join(" ")].filter((para) => para.length > 0).join("\n\n");

  // The takeaways describe the SET — what kind of changes these are, where
  // the leverage sits, what was excluded, how much rests on inference. The
  // ranking itself is in the table; repeating its top rows here would waste
  // the one part of the report a hurried reader always reads.
  const topKind = patternOf(ctx, top.patternId);
  const takeaways: string[] = [
    `Start with ${nameOf(ctx, top)} for ${targetRef(ctx, top.target)} — ${scoreLabel(top.score.total)}, ` +
      `${EFFORT_PHRASE[top.variants[0].effort]}${topKind ? `, ${AUTOMATION_CLASS_SHORT[topKind.automationClass]}` : ""}.`,
  ];
  if (nonAiCount > 0 && aiCount > 0) {
    takeaways.push(
      `${nonAiCount} of the ${opps.length} need no AI at all; the other ${aiCount} bring AI in.`,
    );
  } else if (nonAiCount === opps.length && opps.length > 1) {
    takeaways.push(`None of the ${opps.length} require AI — these are process changes.`);
  }
  // Where the leverage sits: one target carrying more than one of the top three.
  const topThree = opps.slice(0, 3);
  const repeated = topThree.filter((o) => targetRef(ctx, o.target) === targetRef(ctx, top.target)).length;
  if (topThree.length === 3 && repeated > 1) {
    takeaways.push(
      `${capitalize(targetRef(ctx, top.target))} is the single biggest lever — ${repeated} of the top 3 changes target it.`,
    );
  }
  if (result.excluded.length > 0) {
    takeaways.push(
      `${plural(result.excluded.length, "pattern")} ${result.excluded.length === 1 ? "is" : "are"} ruled out by data sensitivity — if that classification is too strict, correcting it brings ${result.excluded.length === 1 ? "it" : "them"} back.`,
    );
  }
  if (lowCount > 0) {
    takeaways.push(
      `${lowCount} of the ${opps.length} rest on facts we had to infer, and ${lowCount === 1 ? "is" : "are"} marked low confidence.`,
    );
  }

  const bestDef = bestVariantDef(ctx, top);
  const prereqs =
    bestDef && bestDef.prerequisites.length > 0
      ? ` You will need: ${bestDef.prerequisites.join("; ")}.`
      : "";
  const firstStep =
    `${nameOf(ctx, top)} for ${targetRef(ctx, top.target)} — the top-rated change — using ` +
    `${top.variants[0].name} (${EFFORT_PHRASE[top.variants[0].effort]}).${prereqs}`;

  const caveats: string[] = top.confidenceReasons.slice(0, 3).map((r) => `On the top recommendation: ${r}.`);
  if (openCount > 0) {
    caveats.push(
      `${plural(openCount, "attribute question")} remain${openCount === 1 ? "s" : ""} open; answering ${openCount === 1 ? "it" : "them"} would sharpen every rating.`,
    );
  }
  if (result.inheritedOpenQuestions.length > 0) {
    caveats.push(
      `${plural(result.inheritedOpenQuestions.length, "question")} about the workflow itself ${result.inheritedOpenQuestions.length === 1 ? "is" : "are"} still unanswered.`,
    );
  }

  return {
    headline:
      `${plural(opps.length, "improvement opportunity", "improvement opportunities")} for ${name} — ` +
      `start with ${nameOf(ctx, top)}.`,
    overview,
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
