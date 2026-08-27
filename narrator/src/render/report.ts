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
 * Layout (recommended / partial):
 *   title line
 *   [summary — rendered separately, see `./summary.ts`]
 *   The workflow at a glance        steps in flow order, one sentence each
 *   Shapes worth attention          motifs, glossed
 *   Recommendations                 top N in full, the rest in a table
 *   Ruled out by data sensitivity   the excluded list, with reasons
 *   Open questions                  partial only (+ inherited ones)
 *   Appendix                        score legend, profile table, rounds
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
  AUTOMATION_CLASS_PHRASE,
  CONFIDENCE_PHRASE,
  DEPLOYMENT_PHRASE,
  DURATION_PHRASE,
  EFFORT_PHRASE,
  ERROR_PHRASE,
  FREQUENCY_PHRASE,
  JUDGMENT_PHRASE,
  MOTIF_GLOSS,
  MOTIF_PHRASE,
  PROVENANCE_LEGEND,
  PROVENANCE_MARK,
  SENSITIVITY_PHRASE,
  STRUCTURE_PHRASE,
  cell,
  listPhrase,
  plural,
  quote,
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
// Sections
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

export function renderTitle(ctx: ReportContext): string {
  const name = hasBody(ctx.result) ? ctx.result.workflowName : null;
  const heading = `# Improvement report — ${name ?? "(unnamed workflow)"}`;
  const parts = [`Source: \`${ctx.inputLabel}\``, `recommender status ${statusPhrase(ctx.result)}`];
  if (hasBody(ctx.result)) {
    parts.push(`preprocessor status ${ctx.result.source.preprocessStatus}`);
    parts.push(
      ctx.workflowPath
        ? `step names from \`${basenameOf(ctx.workflowPath)}\``
        : "step names unavailable — the preprocessor result was not found next to the input, so steps are referred to by id (pass `--workflow <file>` to fix this)",
    );
  }
  return `${heading}\n\n${parts.join(" · ")}`;
}

function basenameOf(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i === -1 ? path : path.slice(i + 1);
}

/** One sentence per profiled step: class, actor, and every known attribute. */
function profileSentence(ctx: ReportContext, profile: LoadedProfile): string {
  const id = profile.nodeId;
  const a = profile.attributes;
  const parts: string[] = [];
  const unknown: string[] = [];
  const mark = (key: string): string => provenanceMark(ctx, key);

  if (profile.taskClass.value) {
    parts.push(`${displayToken(profile.taskClass.value)}${mark(profilePath.taskClass(id))}`);
  } else {
    unknown.push("task class");
  }
  const known = <T extends string>(
    name: keyof LoadedProfile["attributes"],
    value: T | null,
    phrases: Record<T, string>,
    label: string,
  ): void => {
    if (value === null) {
      if (name !== "errorProneness") unknown.push(label);
      return;
    }
    parts.push(`${phrases[value]}${mark(profilePath.attr(id, name))}`);
  };
  known("actorKind", a.actorKind.value, ACTOR_PHRASE, "who does it");
  known("frequency", a.frequency.value, FREQUENCY_PHRASE, "frequency");
  known("duration", a.duration.value, DURATION_PHRASE, "duration");
  known("structure", a.structure.value, STRUCTURE_PHRASE, "how rule-like it is");
  known("judgment", a.judgment.value, JUDGMENT_PHRASE, "judgment needed");
  known("dataSensitivity", a.dataSensitivity.value, SENSITIVITY_PHRASE, "data sensitivity");
  known("errorProneness", a.errorProneness.value, ERROR_PHRASE, "error rate");

  const tail = unknown.length > 0 ? `; not yet known: ${unknown.join(", ")}` : "";
  return `${parts.join("; ")}${tail}.`;
}

function renderAtAGlance(ctx: ReportContext, result: NarratableRecommendation): string {
  const lines: string[] = ["## The workflow at a glance", ""];
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
    `${name} has ${plural(result.profiles.length, "step")} the recommender could analyse${nodeCount}. ` +
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
  lines.push("", PROVENANCE_LEGEND);

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

function renderShapes(ctx: ReportContext, result: NarratableRecommendation): string {
  const lines = ["## Shapes worth attention", ""];
  if (result.motifs.length === 0) {
    lines.push(
      "No multi-step shapes (approval chains, rework loops, manual hand-off chains, repeated steps) were detected; every recommendation below targets a single step.",
    );
    return lines.join("\n");
  }
  lines.push(
    "Multi-step patterns detected in the graph. Each is a recommendation target in its own right, with attributes aggregated conservatively across its steps.",
    "",
  );
  for (const motif of result.motifs) {
    const steps = motif.nodeIds.map((id) => stepRef(ctx, id));
    lines.push(
      `- **${capitalize(MOTIF_PHRASE[motif.kind])}** (${MOTIF_GLOSS[motif.kind]}) — ${motif.evidence}. Steps: ${listPhrase(steps)}.`,
    );
  }
  return lines.join("\n");
}

function opportunityTitle(ctx: ReportContext, opp: LoadedOpportunity): string {
  const names = opp.sequence.map((s) => patternName(ctx, s.patternId));
  return `${names.join(", then ")} — for ${targetRef(ctx, opp.target)}`;
}

function bestVariantDef(ctx: ReportContext, opp: LoadedOpportunity): PatternVariant | undefined {
  return patternOf(ctx, opp.patternId)?.variants.find((v) => v.id === opp.variants[0].variantId);
}

function renderOpportunity(ctx: ReportContext, result: NarratableRecommendation, rank: number, opp: LoadedOpportunity): string {
  const pattern = patternOf(ctx, opp.patternId);
  const best = opp.variants[0];
  const bestDef = bestVariantDef(ctx, opp);
  const lines: string[] = [`### ${rank}. ${opportunityTitle(ctx, opp)}`, ""];

  const kind = pattern ? AUTOMATION_CLASS_PHRASE[pattern.automationClass] : undefined;
  lines.push(
    [
      `**Score ${opp.score.total}/100**`,
      CONFIDENCE_PHRASE[opp.confidence],
      ...(kind ? [kind] : []),
      EFFORT_PHRASE[best.effort],
    ].join(" · "),
    "",
  );

  const detail = targetDetail(ctx, opp.target);
  if (detail) lines.push(`**Where.** ${detail}`, "");

  if (pattern) lines.push(pattern.description, "");

  if (opp.sequence.length > 1) {
    const steps = opp.sequence.map((s, i) => {
      const p = patternOf(ctx, s.patternId);
      const name = p?.name ?? s.patternId;
      const desc = p ? ` — ${lowerFirst(p.description)}` : "";
      return `${i === 0 ? "First" : "then"} *${name}*${desc}`;
    });
    lines.push(
      `**Do this in two steps.** ${steps.join("; ")}. The first step raises how rule-like the work is far enough for the second to apply; the score already discounts for making two changes instead of one.`,
      "",
    );
  }

  const others = opp.variants.slice(1);
  const bestDesc = bestDef ? ` — ${bestDef.description}` : "";
  const otherNote =
    others.length > 0
      ? ` Other deployment options that fit this data: ${listPhrase(
          others.map((v) => `*${v.name}* (${DEPLOYMENT_PHRASE[v.deployment]}, ${EFFORT_PHRASE[v.effort]})`),
        )}.`
      : "";
  lines.push(
    `**What to do.** *${best.name}*${bestDesc} Deployment: ${DEPLOYMENT_PHRASE[best.deployment]}; ${EFFORT_PHRASE[best.effort]}.${otherNote}`,
    "",
  );

  lines.push(`**Why it ranks here.** ${opp.explanation}`, "");

  if (bestDef && (bestDef.prerequisites.length > 0 || bestDef.caveats.length > 0)) {
    const pre = bestDef.prerequisites.length > 0 ? `Prerequisites: ${bestDef.prerequisites.join("; ")}.` : "";
    const cav = bestDef.caveats.length > 0 ? `Caveats: ${bestDef.caveats.join("; ")}.` : "";
    lines.push(`**Before starting.** ${[pre, cav].filter(Boolean).join(" ")}`, "");
  }

  if (opp.confidenceReasons.length === 0) {
    lines.push(
      `**Confidence: ${opp.confidence}** — every value behind this score was stated in the input or confirmed by the user.`,
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
  return lines.join("\n");
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0].toLowerCase() + text.slice(1);
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
  const lines = ["## Recommendations", ""];
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
  const rest = opps.slice(detailed);
  lines.push(
    `${plural(opps.length, "opportunity", "opportunities")}, ranked best-first. Scores run 0–100 and multiply ` +
      "impact (how much time the step consumes) by feasibility (how automatable it is for this pattern) by " +
      "constraint (effort and data-sensitivity friction); the appendix explains every figure." +
      (rest.length > 0
        ? ` The top ${detailed} are written up in full; the remaining ${rest.length} are listed in the table that follows.`
        : ""),
    "",
  );
  opps.slice(0, detailed).forEach((opp, i) => {
    lines.push(renderOpportunity(ctx, result, i + 1, opp), "");
  });

  if (rest.length > 0) {
    lines.push("### Further opportunities", "");
    lines.push("| # | Recommendation | Where | Score | Confidence | Effort |", "|---|---|---|---|---|---|");
    rest.forEach((opp, i) => {
      const names = opp.sequence.map((s) => patternName(ctx, s.patternId)).join(", then ");
      lines.push(
        `| ${detailed + i + 1} | ${cell(names)} | ${cell(targetRef(ctx, opp.target))} | ${opp.score.total}/100 | ${opp.confidence} | ${opp.variants[0].effort} |`,
      );
    });
  }
  return lines.join("\n").trimEnd();
}

function renderExcluded(ctx: ReportContext, result: NarratableRecommendation): string | null {
  if (result.excluded.length === 0) return null;
  const lines = [
    "## Ruled out by data sensitivity",
    "",
    "These patterns matched, but none of their deployment options may touch the data involved, so they are excluded rather than down-scored:",
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
      `The recommender stopped because ${result.reason}. ` +
        `${plural(own.length, "attribute question")} remain${own.length === 1 ? "s" : ""} open; each unknown value was scored at its most conservative and lowers confidence. ` +
        "Answering them (re-run workflow-recommender interactively) would sharpen the ranking:",
      "",
    );
    own.forEach((q, i) => lines.push(`${i + 1}. ${q.text}`));
  }
  if (inherited.length > 0) {
    if (own.length > 0) lines.push("");
    lines.push(
      "Questions still open from the preprocessor — the workflow description itself is incomplete, and every recommendation touching these steps is held at low confidence:",
      "",
    );
    for (const q of inherited) lines.push(`- ${q.text} (\`${q.id}\`)`);
  }
  return lines.join("\n");
}

function renderAppendix(ctx: ReportContext, result: NarratableRecommendation): string {
  const lines = ["## Appendix", "", "### How to read the scores", ""];
  lines.push(
    "- **Impact** — frequency × duration on 1–5 scales (plus a bonus of up to 2 when the step is known to go wrong), scaled to 0–1. Unknown values take the lowest scale point.",
    "- **Feasibility** — how automatable the target is for this pattern: a pattern-specific base plus weighted contributions from how rule-like the work is (structure) and how little judgment it needs. 0–1.",
    "- **Constraint** — the effort of the best deployment option (low 1.0 · medium 0.85 · high 0.7) × data-sensitivity friction (public/internal 1.0 · confidential 0.9 · regulated 0.8) × 0.9 for two-step sequences. 0–1.",
    "- **Total** — round(100 × impact × feasibility × constraint).",
    "- **Confidence** — *high*: every score-relevant value was stated in the input or confirmed by the user; *medium*: some values were inferred from the wording, or the preprocessor result was partial; *low*: an unknown value was substituted conservatively, or an open preprocessor question touches the target.",
    "- **Data sensitivity is a hard filter** — a deployment option whose ceiling is below the target's sensitivity is dropped, not down-scored; a pattern that loses every option is listed under exclusions.",
    "",
    "### Step profiles",
    "",
    "| Step | Class | Frequency | Duration | Structure | Judgment | Data | Actor | Errors |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const p of result.profiles) {
    const id = p.nodeId;
    const label = nodeOf(ctx, id)?.label ?? `\`${id}\``;
    const v = (
      value: string | null,
      key: string,
    ): string => (value === null ? "—" : `${displayToken(value)}${provenanceMark(ctx, key)}`);
    const a = p.attributes;
    lines.push(
      `| ${cell(label)} | ${v(p.taskClass.value, profilePath.taskClass(id))} | ${v(a.frequency.value, profilePath.attr(id, "frequency"))} | ${v(a.duration.value, profilePath.attr(id, "duration"))} | ${v(a.structure.value, profilePath.attr(id, "structure"))} | ${v(a.judgment.value, profilePath.attr(id, "judgment"))} | ${v(a.dataSensitivity.value, profilePath.attr(id, "dataSensitivity"))} | ${v(a.actorKind.value, profilePath.attr(id, "actorKind"))} | ${v(a.errorProneness.value, profilePath.attr(id, "errorProneness"))} |`,
    );
  }
  lines.push("", `${PROVENANCE_LEGEND} "—" means the value is unknown.`, "", "### Clarification history", "");
  if (result.rounds.length === 0) {
    lines.push("No clarification rounds were run.");
  } else {
    for (const round of result.rounds) {
      lines.push(
        `- Round ${round.round}: ${plural(round.questions.length, "question")} asked, ${round.answers.length} answered, ${round.applied.length} applied.`,
      );
    }
  }
  return lines.join("\n");
}

function renderNotice(reason: string): string {
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
  ].join("\n");
}

/**
 * The deterministic body — every section except the title and the summary.
 * This exact text is what the model is shown to summarize.
 */
export function renderBody(ctx: ReportContext): string {
  const result = ctx.result;
  if (!hasBody(result)) return renderNotice(result.reason);
  const sections = [
    renderAtAGlance(ctx, result),
    renderShapes(ctx, result),
    renderRecommendations(ctx, result),
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
