/**
 * The deterministic renderer — the recommender's result JSON becomes a
 * Markdown report by templates alone. No LLM anywhere in this file.
 *
 * Every sentence here is traceable to a field of the result (or of the
 * pattern catalog it was produced against): the report re-states the
 * recommender's figures, it never re-derives or re-ranks them. That is what
 * makes the body the GROUND TRUTH the model summary is checked against —
 * see `../llm/summary.ts`.
 *
 * TWO LAYERS, ONE DOCUMENT. The report is ordered for the person who owns
 * the workflow — decisions first, evidence after — without dropping any of
 * the evidence:
 *
 *   - the DECISION layer (title line, "Where to start", the plain half of
 *     each recommendation, the trimmed step list) says what to change,
 *     where, how big it is, and how sure the analysis is, in the reader's
 *     words;
 *   - the AUDIT layer (the `<details>` block under each recommendation and
 *     the appendix) keeps every figure the recommender produced — the score
 *     arithmetic verbatim, the confidence reasons, the complete step
 *     profiles with per-value provenance, and how the report was produced.
 *
 * Nothing is summarized away: every value shortened in the decision layer
 * appears in full in the audit layer, and every value that IS quoted still
 * carries its provenance mark. Collapsing, not deleting, is what keeps the
 * body a faithful restatement of the result.
 *
 * Layout (recommended / partial):
 *   title line                      what was analysed, what was found
 *   [summary — rendered separately, see `./summary.ts`]
 *   Where to start                  the one first action, then every
 *                                   opportunity as a scannable table
 *   The recommendations             top N in full, audit trail collapsed
 *   How the workflow runs today     steps in flow order, salient facts only
 *   Shapes worth attention          motifs, glossed
 *   Ruled out by data sensitivity   the excluded list, with reasons
 *   Open questions                  partial only (+ inherited ones)
 *   Appendix                        how the report was made · rating legend ·
 *                                   full step profiles
 *
 * `unsuitable` results render a short notice with next steps instead.
 */
import type { Workflow, WorkflowNode } from "workflow-preprocessor";
import { displayToken, profilePath, type PatternDef, type PatternVariant } from "workflow-recommender";
import type {
  LoadedMotif,
  LoadedOpportunity,
  LoadedProfile,
  LoadedRecommendation,
  LoadedTarget,
  NarratableRecommendation,
} from "../schema/input.js";
import {
  ACTOR_PHRASE,
  AUTOMATION_CLASS_SHORT,
  CONFIDENCE_PLAIN,
  CONFIDENCE_WORD,
  DEPLOYMENT_SHORT,
  DURATION_SHORT,
  EFFORT_PHRASE,
  EFFORT_WORD,
  ERROR_PHRASE,
  FREQUENCY_SHORT,
  JUDGMENT_PHRASE,
  MOTIF_GLOSS,
  MOTIF_PHRASE,
  PROVENANCE_LEGEND,
  PROVENANCE_MARK,
  SCORE_BAND_LEGEND,
  SENSITIVITY_PHRASE,
  STRUCTURE_PHRASE,
  cell,
  listPhrase,
  lowerFirst,
  plural,
  quote,
  scoreLabel,
} from "./phrases.js";

export interface ReportContext {
  result: LoadedRecommendation;
  /** The preprocessor result's graph, when found — names, order, branches. */
  workflow: Workflow | null;
  workflowPath: string | null;
  /** The catalog the result was produced against (descriptions, prerequisites). */
  catalog: PatternDef[];
  /** How many opportunities are written up in full; the rest are tabulated. */
  top: number;
  /** How the input is referred to in the title line. */
  inputLabel: string;
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function patternOf(ctx: ReportContext, id: string): PatternDef | undefined {
  return ctx.catalog.find((p) => p.id === id);
}

function patternName(ctx: ReportContext, id: string): string {
  return patternOf(ctx, id)?.name ?? id;
}

function nodeOf(ctx: ReportContext, nodeId: string): WorkflowNode | undefined {
  return ctx.workflow?.nodes.find((n) => n.id === nodeId);
}

/** A step's name for prose: its quoted label, or its id when no label is known. */
export function stepRef(ctx: ReportContext, nodeId: string): string {
  const label = nodeOf(ctx, nodeId)?.label;
  return label ? quote(label) : `step \`${nodeId}\``;
}

function motifOf(ctx: ReportContext, motifId: string): LoadedMotif | undefined {
  if (!hasBody(ctx.result)) return undefined;
  return ctx.result.motifs.find((m) => m.id === motifId);
}

function hasBody(result: LoadedRecommendation): result is NarratableRecommendation {
  return result.status !== "unsuitable";
}

/** Short target wording for headings and table cells. */
export function targetRef(ctx: ReportContext, target: LoadedTarget): string {
  if (target.kind === "node") return stepRef(ctx, target.nodeId);
  const motif = motifOf(ctx, target.motifId);
  if (!motif) return `the shape \`${target.motifId}\``;
  return `the ${MOTIF_PHRASE[motif.kind]} across ${plural(motif.nodeIds.length, "step")}`;
}

/** Fuller target wording for the body of a recommendation. */
function targetDetail(ctx: ReportContext, target: LoadedTarget): string | null {
  if (target.kind === "node") return null;
  const motif = motifOf(ctx, target.motifId);
  if (!motif) return null;
  const steps = motif.nodeIds.map((id) => stepRef(ctx, id));
  return `${capitalize(motif.evidence)}. Steps involved: ${listPhrase(steps)}.`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

function provenanceMark(ctx: ReportContext, key: string): string {
  if (!hasBody(ctx.result)) return "";
  const p = ctx.result.provenance[key];
  return p ? PROVENANCE_MARK[p] : "";
}

function basenameOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}

// ---------------------------------------------------------------------------
// Flow order
// ---------------------------------------------------------------------------

/**
 * Nodes in reading order: depth-first from the start node(s), cycle-safe,
 * unreached nodes appended in input order. Each id appears exactly once.
 */
export function flowOrder(workflow: Workflow): string[] {
  const outgoing = new Map<string, string[]>();
  const hasIncoming = new Set<string>();
  for (const edge of workflow.edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)!.push(edge.to);
    hasIncoming.add(edge.to);
  }
  let roots = workflow.nodes.filter((n) => n.type === "start").map((n) => n.id);
  if (roots.length === 0) roots = workflow.nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id);
  if (roots.length === 0 && workflow.nodes.length > 0) roots = [workflow.nodes[0].id];

  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const next of [...(outgoing.get(id) ?? [])].reverse()) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  for (const node of workflow.nodes) {
    if (!seen.has(node.id)) {
      seen.add(node.id);
      order.push(node.id);
    }
  }
  return order;
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

/**
 * The title line answers the reader's two questions — what was looked at,
 * what came out — and flags only the two facts that change how the WHOLE
 * report should be read: that the analysis is partial, and that step names
 * were unavailable. The file names, the upstream statuses, and the
 * clarification history move to the appendix, where the auditing reader
 * looks for them.
 */
export function renderTitle(ctx: ReportContext): string {
  const result = ctx.result;
  const name = hasBody(result) ? result.workflowName : null;
  const heading = `# Improvement report — ${name ?? "(unnamed workflow)"}`;

  if (!hasBody(result)) {
    return `${heading}\n\nNo recommendations could be produced for this input. What to do about it is below; how the report was produced is in the appendix.`;
  }

  const sentences = [
    "Changes worth making to this workflow, ranked — with what each would take and how sure we are. Everything here comes from the workflow description you provided; the appendix shows the workings.",
  ];
  if (result.status === "partial") {
    sentences.push(
      `**This analysis is partial** — ${result.reason}, so ${plural(result.openQuestions.length, "question")} ` +
        `${result.openQuestions.length === 1 ? "is" : "are"} still open. Unknown facts were assumed to be the least favourable, ` +
        "which pushes some ratings down. See “Open questions”.",
    );
  }
  if (!ctx.workflow) {
    sentences.push(
      "**Step names were unavailable** — the preprocessor result was not found next to the input, so steps appear " +
        "as internal ids below (pass `--workflow <file>` to fix this).",
    );
  }
  return `${heading}\n\n${sentences.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Where to start — the decision table
// ---------------------------------------------------------------------------

function opportunityName(ctx: ReportContext, opp: LoadedOpportunity): string {
  return opp.sequence.map((s) => patternName(ctx, s.patternId)).join(", then ");
}

function bestVariantDef(ctx: ReportContext, opp: LoadedOpportunity): PatternVariant | undefined {
  return patternOf(ctx, opp.patternId)?.variants.find((v) => v.id === opp.variants[0].variantId);
}

function kindOf(ctx: ReportContext, opp: LoadedOpportunity): string | undefined {
  const pattern = patternOf(ctx, opp.patternId);
  return pattern ? AUTOMATION_CLASS_SHORT[pattern.automationClass] : undefined;
}

/**
 * The whole ranking on one screen, plus the single action to take first.
 * Every column is a value the recommender produced; the only derived cell is
 * the rating band, whose thresholds the appendix prints.
 */
function renderWhereToStart(ctx: ReportContext, result: NarratableRecommendation): string {
  const lines = ["## Where to start", ""];
  const opps = result.opportunities;

  if (opps.length === 0) {
    lines.push(
      "Nothing in the catalog matched this workflow's steps or shapes" +
        (result.excluded.length > 0
          ? ", once the data involved ruled out the deployment options — see “Ruled out by data sensitivity”."
          : "."),
      "",
      "The likeliest fix is more detail: who does each step, how often it runs, how long it takes, and how much of it follows fixed rules. Add that and re-run the analysis.",
    );
    return lines.join("\n");
  }

  lines.push(
    `All ${opps.length}, best first — begin at the top. “How sure” is how much of a rating rests on facts you stated rather than facts we inferred; the appendix explains both columns.`,
    "",
    "| # | What to change | Where | How promising | Effort | How sure |",
    "|---|---|---|---|---|---|",
  );
  opps.forEach((opp, i) => {
    lines.push(
      `| ${i + 1} | ${cell(opportunityName(ctx, opp))} | ${cell(targetRef(ctx, opp.target))} | ` +
        `${cell(scoreLabel(opp.score.total))} | ${EFFORT_WORD[opp.variants[0].effort]} | ${CONFIDENCE_WORD[opp.confidence]} |`,
    );
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The recommendations
// ---------------------------------------------------------------------------

function opportunityTitle(ctx: ReportContext, opp: LoadedOpportunity): string {
  return `${opportunityName(ctx, opp)} — for ${targetRef(ctx, opp.target)}`;
}

/** Wrap audit content in a collapsed block, with a blank line so Markdown renders inside it. */
function collapsed(summaryLine: string, content: string[]): string[] {
  return ["<details>", `<summary>${summaryLine}</summary>`, "", ...content, "", "</details>"];
}

/**
 * The scoring audit trail, collapsed. Holds the recommender's own
 * explanation verbatim (the arithmetic behind the rating), the confidence
 * reasons, and any preprocessor question touching the target — everything a
 * reader who wants to CHECK the rating needs, kept out of the way of a
 * reader who wants to ACT on it.
 */
function renderScoringDetail(ctx: ReportContext, result: NarratableRecommendation, opp: LoadedOpportunity): string[] {
  const lines = [`**The rating.** ${opp.explanation}`, ""];
  if (opp.confidenceReasons.length === 0) {
    lines.push(
      `**Confidence: ${opp.confidence}** — every value behind this rating was stated in the input or confirmed by the user.`,
    );
  } else {
    lines.push(`**Confidence: ${opp.confidence}**, because:`, "");
    for (const reason of opp.confidenceReasons) lines.push(`- ${reason}`);
  }
  if (opp.affectedBy.length > 0) {
    const texts = opp.affectedBy.map((id) => {
      const q = result.inheritedOpenQuestions.find((x) => x.id === id);
      return q ? `${quote(q.text)} (\`${id}\`)` : `\`${id}\``;
    });
    lines.push("", `**Open questions from the preprocessor touch this target:** ${listPhrase(texts)}.`);
  }
  return collapsed("How this was rated, and how sure we are", lines);
}

function renderOpportunity(
  ctx: ReportContext,
  result: NarratableRecommendation,
  rank: number,
  opp: LoadedOpportunity,
): string {
  const pattern = patternOf(ctx, opp.patternId);
  const best = opp.variants[0];
  const bestDef = bestVariantDef(ctx, opp);
  const lines: string[] = [`### ${rank}. ${opportunityTitle(ctx, opp)}`, ""];

  const kind = kindOf(ctx, opp);
  lines.push(
    [
      `**${scoreLabel(opp.score.total)}**`,
      EFFORT_PHRASE[best.effort],
      ...(kind ? [kind] : []),
      CONFIDENCE_PLAIN[opp.confidence],
    ].join(" · "),
    "",
  );

  const detail = targetDetail(ctx, opp.target);
  if (detail) lines.push(`**Where.** ${detail}`, "");

  if (pattern) lines.push(`**Why it helps.** ${pattern.description}`, "");

  if (opp.sequence.length > 1) {
    const steps = opp.sequence.map((s, i) => {
      const p = patternOf(ctx, s.patternId);
      const name = p?.name ?? s.patternId;
      const desc = p ? ` — ${lowerFirst(p.description)}` : "";
      return `${i === 0 ? "First" : "then"} *${name}*${desc}`;
    });
    lines.push(
      `**Do this in two steps.** ${steps.join("; ")}. The first change makes the work rule-like enough for the second to apply; the rating already allows for making two changes instead of one.`,
      "",
    );
  }

  const bestDesc = bestDef ? ` — ${lowerFirst(bestDef.description)}` : "";
  lines.push(
    `**What to do.** *${best.name}*${bestDesc} ${EFFORT_WORD[best.effort]} effort, ${DEPLOYMENT_SHORT[best.deployment]}.`,
    "",
  );

  const others = opp.variants.slice(1);
  if (others.length > 0) {
    lines.push(
      `**Other options that fit this data.** ${listPhrase(
        others.map((v) => `*${v.name}* (${DEPLOYMENT_SHORT[v.deployment]}, ${EFFORT_PHRASE[v.effort]})`),
      )}.`,
      "",
    );
  }

  if (bestDef && (bestDef.prerequisites.length > 0 || bestDef.caveats.length > 0)) {
    const pre = bestDef.prerequisites.length > 0 ? `You will need: ${bestDef.prerequisites.join("; ")}.` : "";
    const cav = bestDef.caveats.length > 0 ? `Watch out: ${bestDef.caveats.join("; ")}.` : "";
    lines.push(`**Before starting.** ${[pre, cav].filter(Boolean).join(" ")}`, "");
  }

  lines.push(...renderScoringDetail(ctx, result, opp));
  return lines.join("\n");
}

/** How many opportunities get a full write-up (the rest are tabulated). */
export function detailCount(total: number, top: number): number {
  let n = Math.min(top, total);
  // A table of one or two rows reads worse than two more write-ups.
  if (top > 0 && total - n <= 2) n = total;
  return n;
}

function renderRecommendations(ctx: ReportContext, result: NarratableRecommendation): string {
  const opps = result.opportunities;
  const lines = ["## The recommendations", ""];
  if (opps.length === 0) {
    lines.push(
      "No pattern in the catalog matched this workflow's steps or shapes" +
        (result.excluded.length > 0
          ? " with a deployment option allowed for its data — see the exclusions below."
          : "."),
    );
    return lines.join("\n");
  }

  const detailed = detailCount(opps.length, ctx.top);
  const rest = opps.length - detailed;
  lines.push(
    rest > 0
      ? `The top ${detailed} in full. The remaining ${rest} are in the table above; re-run with \`--top ${opps.length}\` to write them all up.`
      : `All ${opps.length}, in full.`,
    "",
  );
  opps.slice(0, detailed).forEach((opp, i) => {
    lines.push(renderOpportunity(ctx, result, i + 1, opp), "");
  });
  return lines.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// How the workflow runs today
// ---------------------------------------------------------------------------

/**
 * One line per step: what kind of work it is, who does it, and how much time
 * it takes — the four facts that drive the ratings — followed only by what is
 * NOTABLE about the rest (sensitive data, known errors, expert judgment,
 * case-by-case handling). The other attributes are not dropped: the appendix
 * prints every one of them, per step, with its provenance mark. Values quoted
 * here keep their marks too, so nothing shown is unattributed.
 */
function profileSentence(ctx: ReportContext, profile: LoadedProfile): string {
  const id = profile.nodeId;
  const a = profile.attributes;
  const mark = (key: string): string => provenanceMark(ctx, key);
  const unknown: string[] = [];
  const sentences: string[] = [];

  const what: string[] = [];
  if (profile.taskClass.value) {
    what.push(`${displayToken(profile.taskClass.value)}${mark(profilePath.taskClass(id))}`);
  } else {
    unknown.push("what kind of work it is");
  }
  if (a.actorKind.value) {
    what.push(`${ACTOR_PHRASE[a.actorKind.value]}${mark(profilePath.attr(id, "actorKind"))}`);
  } else {
    unknown.push("who does it");
  }
  if (what.length > 0) sentences.push(`${what.join(", ")}.`);

  const when: string[] = [];
  if (a.frequency.value) {
    when.push(`Runs ${FREQUENCY_SHORT[a.frequency.value]}${mark(profilePath.attr(id, "frequency"))}`);
  } else {
    unknown.push("how often it runs");
  }
  if (a.duration.value) {
    when.push(`${when.length === 0 ? "Takes " : ""}${DURATION_SHORT[a.duration.value]}${mark(profilePath.attr(id, "duration"))}`);
  } else {
    unknown.push("how long it takes");
  }
  if (when.length > 0) sentences.push(`${when.join(", ")}.`);

  // Only attributes that should change a reader's mind are surfaced here.
  const notable: string[] = [];
  if (a.dataSensitivity.value === "confidential" || a.dataSensitivity.value === "regulated") {
    notable.push(`${SENSITIVITY_PHRASE[a.dataSensitivity.value]}${mark(profilePath.attr(id, "dataSensitivity"))}`);
  } else if (a.dataSensitivity.value === null) {
    unknown.push("how sensitive the data is");
  }
  if (a.errorProneness.value === "occasional" || a.errorProneness.value === "frequent") {
    notable.push(`${ERROR_PHRASE[a.errorProneness.value]}${mark(profilePath.attr(id, "errorProneness"))}`);
  }
  if (a.judgment.value === "expert") {
    notable.push(`${JUDGMENT_PHRASE.expert}${mark(profilePath.attr(id, "judgment"))}`);
  } else if (a.judgment.value === null) {
    unknown.push("how much judgment it needs");
  }
  if (a.structure.value === "case_by_case") {
    notable.push(`${STRUCTURE_PHRASE.case_by_case}${mark(profilePath.attr(id, "structure"))}`);
  } else if (a.structure.value === null) {
    unknown.push("how rule-like it is");
  }
  if (notable.length > 0) sentences.push(`Notable: ${listPhrase(notable)}.`);
  if (unknown.length > 0) sentences.push(`Not yet known: ${listPhrase(unknown)}.`);

  return sentences.join(" ");
}

function renderHowItRunsToday(ctx: ReportContext, result: NarratableRecommendation): string {
  const lines: string[] = ["## How the workflow runs today", ""];
  const name = result.workflowName ? quote(result.workflowName) : "The workflow";
  const profiled = new Map(result.profiles.map((p) => [p.nodeId, p]));

  const wf = ctx.workflow;
  const order = wf ? flowOrder(wf).filter((id) => profiled.has(id)) : [];
  const ordered = [
    ...order.map((id) => profiled.get(id)!),
    ...result.profiles.filter((p) => !order.includes(p.nodeId)),
  ];

  const nodeCount = wf ? ` (${plural(wf.nodes.length, "node")} including start and end)` : "";
  lines.push(
    `${name} has ${plural(result.profiles.length, "step")} we could analyse${nodeCount}. ` +
      (wf ? "In flow order:" : "In the order they were profiled:"),
    "",
  );
  for (const [i, profile] of ordered.entries()) {
    const label = nodeOf(ctx, profile.nodeId)?.label;
    const title = label ? `**${label}**` : `**\`${profile.nodeId}\`**`;
    const actor = nodeOf(ctx, profile.nodeId)?.actor;
    const actorNote = actor ? ` (actor: ${actor})` : "";
    lines.push(`${i + 1}. ${title}${actorNote} — ${profileSentence(ctx, profile)}`);
  }
  lines.push(
    "",
    `${PROVENANCE_LEGEND} Each step's full profile is in the appendix.`,
  );

  if (result.skippedNodes.length > 0) {
    const ids = result.skippedNodes.map((s) => `\`${s.nodeId}\``);
    lines.push(
      "",
      `${plural(result.skippedNodes.length, "node")} could not be analysed because the preprocessor left ` +
        `${result.skippedNodes.length === 1 ? "its type" : "their types"} unknown: ${listPhrase(ids)}.`,
    );
  }

  if (wf) {
    const structure = renderBranchesAndLoops(ctx, wf);
    if (structure.length > 0) lines.push("", "Branches and loops:", "", ...structure);
  }
  return lines.join("\n");
}

/** Decision branches and back edges, from the graph alone. */
function renderBranchesAndLoops(ctx: ReportContext, wf: Workflow): string[] {
  const position = new Map(flowOrder(wf).map((id, i) => [id, i]));
  const out: string[] = [];
  const byFrom = new Map<string, typeof wf.edges>();
  for (const edge of wf.edges) {
    if (!byFrom.has(edge.from)) byFrom.set(edge.from, []);
    byFrom.get(edge.from)!.push(edge);
  }
  for (const [from, edges] of byFrom) {
    if (edges.length < 2) continue;
    const branches = edges.map(
      (e) => `${e.label ? `(${e.label}) ` : ""}→ ${stepRef(ctx, e.to)}`,
    );
    out.push(`- From ${stepRef(ctx, from)} the flow branches: ${branches.join("; ")}.`);
  }
  for (const edge of wf.edges) {
    const from = position.get(edge.from) ?? -1;
    const to = position.get(edge.to) ?? -1;
    if (to <= from) {
      const label = edge.label ? ` (${edge.label})` : "";
      out.push(`- ${stepRef(ctx, edge.from)} loops back to ${stepRef(ctx, edge.to)}${label}.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shapes, exclusions, open questions
// ---------------------------------------------------------------------------

function renderShapes(ctx: ReportContext, result: NarratableRecommendation): string {
  const lines = ["## Shapes worth attention", ""];
  if (result.motifs.length === 0) {
    lines.push(
      "No multi-step shapes (approval chains, rework loops, manual hand-off chains, repeated steps) were detected; every recommendation above targets a single step.",
    );
    return lines.join("\n");
  }
  lines.push("Patterns spanning several steps. Each can be improved as a unit — which is why some recommendations above target a shape rather than one step.", "");
  for (const motif of result.motifs) {
    const steps = motif.nodeIds.map((id) => stepRef(ctx, id));
    lines.push(
      `- **${capitalize(MOTIF_PHRASE[motif.kind])}** — ${MOTIF_GLOSS[motif.kind]}. Here: ${lowerFirst(motif.evidence)}. Steps: ${listPhrase(steps)}.`,
    );
  }
  return lines.join("\n");
}

function renderExcluded(ctx: ReportContext, result: NarratableRecommendation): string | null {
  if (result.excluded.length === 0) return null;
  const lines = [
    "## Ruled out by data sensitivity",
    "",
    "These would otherwise apply, but no way of running them may touch data this sensitive — so they are ruled out, not rated low. Correcting an over-strict classification brings them back:",
    "",
  ];
  for (const ex of result.excluded) {
    lines.push(`- **${patternName(ctx, ex.patternId)}** for ${targetRef(ctx, ex.target)} — ${ex.reason}.`);
  }
  return lines.join("\n");
}

function renderOpenQuestions(result: NarratableRecommendation): string | null {
  const own = result.status === "partial" ? result.openQuestions : [];
  const inherited = result.inheritedOpenQuestions;
  if (own.length === 0 && inherited.length === 0) return null;
  const lines = ["## Open questions", ""];
  if (result.status === "partial") {
    lines.push(
      `The analysis stopped because ${result.reason}. ` +
        `${plural(own.length, "question")} about the steps ${own.length === 1 ? "is" : "are"} still open, and each unknown was assumed to be the least favourable value — which lowers both the ratings and the confidence. ` +
        "Answering these (re-run `workflow-recommender` interactively) would sharpen the ranking:",
      "",
    );
    own.forEach((q, i) => lines.push(`${i + 1}. ${q.text}`));
  }
  if (inherited.length > 0) {
    if (own.length > 0) lines.push("");
    lines.push(
      "Questions still open about the workflow description itself. Every recommendation touching these steps is held at low confidence:",
      "",
    );
    for (const q of inherited) lines.push(`- ${q.text} (\`${q.id}\`)`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Appendix — the audit layer
// ---------------------------------------------------------------------------

function statusPhrase(result: LoadedRecommendation): string {
  switch (result.status) {
    case "recommended":
      return "**recommended** (every attribute question was answered)";
    case "partial":
      return `**partial** — ${result.reason}`;
    case "unsuitable":
      return "**unsuitable**";
  }
}

/** Where the report came from — the provenance the title line no longer carries. */
function renderProvenanceSection(ctx: ReportContext, result: NarratableRecommendation): string[] {
  const lines = ["### How this report was made", ""];
  lines.push(
    `- Generated from \`${ctx.inputLabel}\`, the result of running \`workflow-recommender\` over this workflow.`,
    `- Recommender status: ${statusPhrase(result)}.`,
    `- Preprocessor status: ${result.source.preprocessStatus}.`,
    // A workflow can arrive from a file (the CLI) or in memory (library use,
    // e.g. the end-to-end pipeline): only the first has a file to name.
    !ctx.workflow
      ? "- Step names were unavailable, so steps are referred to by their internal ids."
      : ctx.workflowPath
        ? `- Step names came from \`${basenameOf(ctx.workflowPath)}\`.`
        : "- Step names came from the preprocessor result, passed in directly rather than read from a file.",
  );
  if (result.rounds.length === 0) {
    lines.push("- No clarification rounds were run.");
  } else {
    for (const round of result.rounds) {
      lines.push(
        `- Clarification round ${round.round}: ${plural(round.questions.length, "question")} asked, ${round.answers.length} answered, ${round.applied.length} applied.`,
      );
    }
  }
  lines.push(
    "",
    "Every figure in this report is templated from that result — nothing here is re-derived, re-ranked, or estimated at report time.",
  );
  return lines;
}

/**
 * The audit layer, in full and out of the way. Everything here is reference
 * material — how the report was made, how to re-derive any rating, and the
 * complete step profiles the decision layer summarizes — so the two blocks a
 * reader consults rather than reads are collapsed. Nothing is abridged: the
 * profile table still carries every attribute of every step with its
 * provenance mark, which is what lets the sections above show only the
 * salient ones.
 */
function renderAppendix(ctx: ReportContext, result: NarratableRecommendation): string {
  const lines = ["## Appendix", "", ...renderProvenanceSection(ctx, result), ""];

  lines.push(
    ...collapsed("How to read the ratings", [
      `**Rating bands** are a fixed reading of the 0–100 score, the same in every report: ${SCORE_BAND_LEGEND}. The score itself is always printed alongside.`,
      "",
      "The score is impact × feasibility × constraint, rounded to 0–100:",
      "",
      "- **Impact** — frequency × duration on 1–5 scales (plus a bonus of up to 2 when the step is known to go wrong), scaled to 0–1. Unknown values take the lowest scale point.",
      "- **Feasibility** — how automatable the target is for this pattern: a pattern-specific base plus weighted contributions from how rule-like the work is (structure) and how little judgment it needs. 0–1.",
      "- **Constraint** — the effort of the best deployment option (low 1.0 · medium 0.85 · high 0.7) × data-sensitivity friction (public/internal 1.0 · confidential 0.9 · regulated 0.8) × 0.9 for two-step sequences. 0–1.",
      "- **Total** — round(100 × impact × feasibility × constraint).",
      "- **Confidence** — *high*: every score-relevant value was stated in the input or confirmed by the user; *medium*: some values were inferred from the wording, or the preprocessor result was partial; *low*: an unknown value was substituted conservatively, or an open preprocessor question touches the target.",
      "- **Data sensitivity is a hard filter** — a deployment option whose ceiling is below the target's sensitivity is dropped, not down-scored; a pattern that loses every option is listed under exclusions.",
    ]),
    "",
  );

  const profiles: string[] = [
    "Every attribute of every step, including the ones “How the workflow runs today” leaves out.",
    "",
    "| Step | Class | Frequency | Duration | Structure | Judgment | Data | Actor | Errors |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const p of result.profiles) {
    const id = p.nodeId;
    const label = nodeOf(ctx, id)?.label ?? `\`${id}\``;
    const v = (
      value: string | null,
      key: string,
    ): string => (value === null ? "—" : `${displayToken(value)}${provenanceMark(ctx, key)}`);
    const a = p.attributes;
    profiles.push(
      `| ${cell(label)} | ${v(p.taskClass.value, profilePath.taskClass(id))} | ${v(a.frequency.value, profilePath.attr(id, "frequency"))} | ${v(a.duration.value, profilePath.attr(id, "duration"))} | ${v(a.structure.value, profilePath.attr(id, "structure"))} | ${v(a.judgment.value, profilePath.attr(id, "judgment"))} | ${v(a.dataSensitivity.value, profilePath.attr(id, "dataSensitivity"))} | ${v(a.actorKind.value, profilePath.attr(id, "actorKind"))} | ${v(a.errorProneness.value, profilePath.attr(id, "errorProneness"))} |`,
    );
  }
  profiles.push("", `${PROVENANCE_LEGEND} "—" means the value is unknown.`);
  lines.push(...collapsed("The full step profiles", profiles));

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function renderNotice(ctx: ReportContext, reason: string): string {
  let advice: string;
  if (/preprocessor rejected/i.test(reason)) {
    advice =
      "The preprocessor did not accept the input as a workflow. Check that the source text or image describes a process — steps and the order between them — fix it, and run workflow-preprocessor again before the recommender.";
  } else if (/no task or decision/i.test(reason)) {
    advice =
      "The workflow graph has no task or decision steps, only start/end nodes. Add the actual steps to the description (or answer the preprocessor's clarification questions) and re-run both stages.";
  } else if (/could not profile/i.test(reason)) {
    advice =
      "The model could not classify the workflow's steps. Run `workflow-recommender --check` to verify the LLM configuration and re-run; if it persists, the step labels may be too thin to classify — add short descriptions.";
  } else {
    advice = "Review the reason above, fix the input, and re-run the recommender.";
  }
  return [
    "## Nothing to recommend on",
    "",
    `The recommender could not produce recommendations for this input: ${reason}.`,
    "",
    `**What to do next.** ${advice}`,
    "",
    "## Appendix",
    "",
    "### How this report was made",
    "",
    `- Generated from \`${ctx.inputLabel}\`, the result of running \`workflow-recommender\` over this input.`,
    `- Recommender status: ${statusPhrase(ctx.result)} — ${reason}.`,
  ].join("\n");
}

/**
 * The deterministic body — every section except the title and the summary.
 * This exact text is what the model is shown to summarize.
 */
export function renderBody(ctx: ReportContext): string {
  const result = ctx.result;
  if (!hasBody(result)) return renderNotice(ctx, result.reason);
  const sections = [
    renderWhereToStart(ctx, result),
    renderRecommendations(ctx, result),
    renderHowItRunsToday(ctx, result),
    renderShapes(ctx, result),
    renderExcluded(ctx, result),
    renderOpenQuestions(result),
    renderAppendix(ctx, result),
  ];
  return sections.filter((s): s is string => s !== null).join("\n\n");
}

/** Title + optional summary section + body, as one Markdown document. */
export function assembleReport(ctx: ReportContext, summarySection: string | null, body: string): string {
  return [renderTitle(ctx), summarySection, body].filter((s) => s !== null).join("\n\n") + "\n";
}
