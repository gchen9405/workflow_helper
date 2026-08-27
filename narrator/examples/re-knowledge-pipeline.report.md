# Improvement report — RE knowledge pipeline

Source: `re-knowledge-pipeline.recommendations.json` · recommender status **recommended** (every attribute question was answered) · preprocessor status validated · step names from `re-knowledge-pipeline.json`

## Summary

_Written deterministically — no model summary was requested._

**6 improvement opportunities for "RE knowledge pipeline" — start with AI quality pre-check for the rework loop across 4 steps.**

The recommender matched 6 improvement opportunities across 5 analysed steps and 2 multi-step shapes. The strongest is AI quality pre-check for the rework loop across 4 steps (30/100, medium confidence). Next come Automate the evaluation harness for the rework loop across 4 steps (30/100, medium confidence) and Standardize the inputs for "Agent assists with RE / software-understanding task" (30/100, high confidence). 4 of the 6 are non-AI changes; 2 bring in AI.

**Key takeaways**

- AI quality pre-check for the rework loop across 4 steps: 30/100, medium confidence, AI assists, a person stays in the loop; medium effort.
- Automate the evaluation harness for the rework loop across 4 steps: 30/100, medium confidence, non-AI change (rule-based automation); medium effort.
- Standardize the inputs for "Agent assists with RE / software-understanding task": 30/100, high confidence, non-AI change (standardize); medium effort.

**Suggested first step.** AI quality pre-check for the rework loop across 4 steps — the top-ranked opportunity — using its best deployment option, Internal LLM endpoint (medium effort). Before starting: the review checklist written down.

**Caveats**

- Top recommendation: 19 value(s) inferred from the step text rather than stated.

## The workflow at a glance

"RE knowledge pipeline" has 5 steps the recommender could analyse (7 nodes including start and end). In flow order:

1. **Collect RE knowledge sources: papers and existing tools** — research gathering*; done by a person*; runs weekly*; takes 30 minutes – 2 hours per run*; follows guidelines with exceptions*; needs experienced judgment*; touches internal data*.
2. **Distill RE knowledge for AI-agent consumption** — knowledge distillation*; done by a person*; runs weekly*; takes 2 hours – 1 day per run*; follows guidelines with exceptions*; needs expert judgment*; touches internal data*.
3. **Expose distilled knowledge to AI agent or custom harness** — tool integration*; done by a person*; runs monthly*; takes 30 minutes – 2 hours per run*; follows mostly fixed rules*; needs experienced judgment*; touches internal data*.
4. **Agent assists with RE / software-understanding task** (actor: AI agent) — document review; done by an AI agent; runs daily; takes 30 minutes – 2 hours per run; follows guidelines with exceptions; needs experienced judgment; touches internal data.
5. **Verify with humans and/or benchmarks** — evaluation benchmarking*; done by a person*; runs daily*; takes 30 minutes – 2 hours per run*; follows guidelines with exceptions*; needs experienced judgment*; touches internal data*; occasionally goes wrong*.

Values marked * were inferred by the model from the wording rather than stated in the input; values marked † were confirmed by the user during clarification; unmarked values were stated in the input.

Branches and loops:

- From "Verify with humans and/or benchmarks" the flow branches: (accepted) → "Actionable software-understanding output"; (needs iteration) → "Distill RE knowledge for AI-agent consumption".
- "Verify with humans and/or benchmarks" loops back to "Distill RE knowledge for AI-agent consumption" (needs iteration).

## Shapes worth attention

Multi-step patterns detected in the graph. Each is a recommendation target in its own right, with attributes aggregated conservatively across its steps.

- **Long manual chain** (an unbroken run of manual steps by the same actor) — 3 manual steps in an unbroken run by the same person. Steps: "Collect RE knowledge sources: papers and existing tools", "Distill RE knowledge for AI-agent consumption" and "Expose distilled knowledge to AI agent or custom harness".
- **Rework loop** (a cycle that keeps sending work back through a review or verification step) — a loop of 4 step(s) sends work back through "Agent assists with RE / software-understanding task". Steps: "Agent assists with RE / software-understanding task", "Distill RE knowledge for AI-agent consumption", "Expose distilled knowledge to AI agent or custom harness" and "Verify with humans and/or benchmarks".

## Recommendations

6 opportunities, ranked best-first. Scores run 0–100 and multiply impact (how much time the step consumes) by feasibility (how automatable it is for this pattern) by constraint (effort and data-sensitivity friction); the appendix explains every figure.

### 1. AI quality pre-check — for the rework loop across 4 steps

**Score 30/100** · medium confidence · AI assists, a person stays in the loop · medium effort

**Where.** A loop of 4 step(s) sends work back through "Agent assists with RE / software-understanding task". Steps involved: "Agent assists with RE / software-understanding task", "Distill RE knowledge for AI-agent consumption", "Expose distilled knowledge to AI agent or custom harness" and "Verify with humans and/or benchmarks".

An AI checks the work before (or instead of the first pass of) human review — catching the mechanical defects so humans review exceptions, and breaking rework loops closer to the source.

**What to do.** *Internal LLM endpoint* — Checklist-grounded AI review on the internal endpoint. Deployment: the company's internal LLM endpoint; medium effort. Other deployment options that fit this data: *On-prem model* (on-premises infrastructure, high effort).

**Why it ranks here.** AI quality pre-check for a loop of 4 step(s) sends work back through "Agent assists with RE / software-understanding task". Runs daily (aggregated across the steps) at 2 hours – 1 day per run (aggregated across the steps) and goes wrong occasionally → impact 0.68. Structure: guidelines with exceptions (aggregated across the steps); judgment: deep expert judgment (aggregated across the steps) → feasibility 0.517. internal data (aggregated across the steps) allows 2 deployment option(s); best: Internal LLM endpoint (medium effort) → constraint 0.85. Total 30/100.

**Before starting.** Prerequisites: the review checklist written down. Caveats: AI review supplements, not replaces, accountable sign-off.

**Confidence: medium**, because:

- 19 value(s) inferred from the step text rather than stated

### 2. Automate the evaluation harness — for the rework loop across 4 steps

**Score 30/100** · medium confidence · non-AI change (rule-based automation) · medium effort

**Where.** A loop of 4 step(s) sends work back through "Agent assists with RE / software-understanding task". Steps involved: "Agent assists with RE / software-understanding task", "Distill RE knowledge for AI-agent consumption", "Expose distilled knowledge to AI agent or custom harness" and "Verify with humans and/or benchmarks".

Verification done by hand every iteration is the bottleneck of any build-measure loop — automate the benchmark portion so every change is scored mechanically, and spend human review on a sample.

**What to do.** *Scripted benchmark suite* — A fixed test/benchmark set run automatically on every iteration, with tracked scores. Deployment: no AI involved; medium effort. Other deployment options that fit this data: *AI-graded evaluations* (the company's internal LLM endpoint, medium effort).

**Why it ranks here.** Automate the evaluation harness for a loop of 4 step(s) sends work back through "Agent assists with RE / software-understanding task". Runs daily (aggregated across the steps) at 2 hours – 1 day per run (aggregated across the steps) and goes wrong occasionally → impact 0.68. Structure: guidelines with exceptions (aggregated across the steps); judgment: deep expert judgment (aggregated across the steps) → feasibility 0.517. internal data (aggregated across the steps) allows 2 deployment option(s); best: Scripted benchmark suite (medium effort) → constraint 0.85. Total 30/100.

**Before starting.** Prerequisites: ground truth or reference outputs for the benchmark set. Caveats: benchmarks drift from reality — refresh the set on a schedule.

**Confidence: medium**, because:

- 19 value(s) inferred from the step text rather than stated

### 3. Standardize the inputs — for "Agent assists with RE / software-understanding task"

**Score 30/100** · high confidence · non-AI change (standardize) · medium effort

Work that arrives in inconsistent shapes forces case-by-case handling — fixed forms, required fields, and checklists make the step rule-like (and unlock automation).

**What to do.** *Standard forms and checklists* — Define the canonical input format and the checklist the step follows. Deployment: no AI involved; medium effort.

**Why it ranks here.** Standardize the inputs for "Agent assists with RE / software-understanding task" (agent_assist). Runs daily (from the input) at 30 minutes – 2 hours per run (from the input) → impact 0.48. Structure: guidelines with exceptions (from the input); judgment: experienced judgment (from the input) → feasibility 0.733. internal data (from the input) allows 1 deployment option(s); best: Standard forms and checklists (medium effort) → constraint 0.85. Total 30/100.

**Before starting.** Prerequisites: authority to require the new format from upstream senders. Caveats: expect a transition period with both formats in flight.

**Confidence: high** — every value behind this score was stated in the input or confirmed by the user.

### 4. Automate the evaluation harness — for "Verify with humans and/or benchmarks"

**Score 27/100** · medium confidence · non-AI change (rule-based automation) · medium effort

Verification done by hand every iteration is the bottleneck of any build-measure loop — automate the benchmark portion so every change is scored mechanically, and spend human review on a sample.

**What to do.** *Scripted benchmark suite* — A fixed test/benchmark set run automatically on every iteration, with tracked scores. Deployment: no AI involved; medium effort. Other deployment options that fit this data: *AI-graded evaluations* (the company's internal LLM endpoint, medium effort).

**Why it ranks here.** Automate the evaluation harness for "Verify with humans and/or benchmarks" (verify). Runs daily (inferred) at 30 minutes – 2 hours per run (inferred) and goes wrong occasionally → impact 0.52. Structure: guidelines with exceptions (inferred); judgment: experienced judgment (inferred) → feasibility 0.6. internal data (inferred) allows 2 deployment option(s); best: Scripted benchmark suite (medium effort) → constraint 0.85. Total 27/100.

**Before starting.** Prerequisites: ground truth or reference outputs for the benchmark set. Caveats: benchmarks drift from reality — refresh the set on a schedule.

**Confidence: medium**, because:

- 7 value(s) inferred from the step text rather than stated

### 5. Automate source monitoring — for "Collect RE knowledge sources: papers and existing tools"

**Score 22/100** · medium confidence · non-AI change (rule-based automation) · low effort

Recurring collection of papers, tools, or datasets is a standing query — feeds, alerts, and scheduled searches do the sweeping; humans (or an AI triager) only read what arrives.

**What to do.** *Feeds, alerts, and saved searches* — RSS/arXiv alerts, repo watches, and scheduled queries deliver candidates automatically. Deployment: no AI involved; low effort. Other deployment options that fit this data: *AI-triaged alerts* (the company's internal LLM endpoint, medium effort).

**Why it ranks here.** Automate source monitoring for "Collect RE knowledge sources: papers and existing tools" (collect). Runs weekly (inferred) at 30 minutes – 2 hours per run (inferred) → impact 0.36. Structure: guidelines with exceptions (inferred); judgment: experienced judgment (inferred) → feasibility 0.6. internal data (inferred) allows 2 deployment option(s); best: Feeds, alerts, and saved searches (low effort) → constraint 1. Total 22/100.

**Before starting.** Caveats: alert fatigue — curate the query set.

**Confidence: medium**, because:

- 6 value(s) inferred from the step text rather than stated

### 6. Build a retrievable knowledge base — for "Distill RE knowledge for AI-agent consumption"

**Score 17/100** · medium confidence · AI assists, a person stays in the loop · high effort

Distilled knowledge that lives in documents gets re-derived every time it is needed — index it into a retrievable store that both humans and AI agents/harnesses query.

**What to do.** *RAG store on the internal endpoint* — Chunked, indexed corpus with retrieval feeding the internal LLM (and any agent harness). Deployment: the company's internal LLM endpoint; high effort. Other deployment options that fit this data: *On-prem RAG store* (on-premises infrastructure, high effort).

**Why it ranks here.** Build a retrievable knowledge base for "Distill RE knowledge for AI-agent consumption" (distill). Runs weekly (inferred) at 2 hours – 1 day per run (inferred) → impact 0.48. Structure: guidelines with exceptions (inferred); judgment: deep expert judgment (inferred) → feasibility 0.517. internal data (inferred) allows 2 deployment option(s); best: RAG store on the internal endpoint (high effort) → constraint 0.7. Total 17/100.

**Before starting.** Prerequisites: the corpus collected in one place; an owner for index freshness. Caveats: stale indexes quietly poison downstream answers — automate re-indexing.

**Confidence: medium**, because:

- 6 value(s) inferred from the step text rather than stated

## Appendix

### How to read the scores

- **Impact** — frequency × duration on 1–5 scales (plus a bonus of up to 2 when the step is known to go wrong), scaled to 0–1. Unknown values take the lowest scale point.
- **Feasibility** — how automatable the target is for this pattern: a pattern-specific base plus weighted contributions from how rule-like the work is (structure) and how little judgment it needs. 0–1.
- **Constraint** — the effort of the best deployment option (low 1.0 · medium 0.85 · high 0.7) × data-sensitivity friction (public/internal 1.0 · confidential 0.9 · regulated 0.8) × 0.9 for two-step sequences. 0–1.
- **Total** — round(100 × impact × feasibility × constraint).
- **Confidence** — *high*: every score-relevant value was stated in the input or confirmed by the user; *medium*: some values were inferred from the wording, or the preprocessor result was partial; *low*: an unknown value was substituted conservatively, or an open preprocessor question touches the target.
- **Data sensitivity is a hard filter** — a deployment option whose ceiling is below the target's sensitivity is dropped, not down-scored; a pattern that loses every option is listed under exclusions.

### Step profiles

| Step | Class | Frequency | Duration | Structure | Judgment | Data | Actor | Errors |
|---|---|---|---|---|---|---|---|---|
| Collect RE knowledge sources: papers and existing tools | research gathering* | weekly* | 30 minutes – 2 hours* | guidelines with exceptions* | experienced judgment* | internal* | a person* | — |
| Distill RE knowledge for AI-agent consumption | knowledge distillation* | weekly* | 2 hours – 1 day* | guidelines with exceptions* | deep expert judgment* | internal* | a person* | — |
| Expose distilled knowledge to AI agent or custom harness | tool integration* | monthly* | 30 minutes – 2 hours* | mostly fixed rules* | experienced judgment* | internal* | a person* | — |
| Agent assists with RE / software-understanding task | document review | daily | 30 minutes – 2 hours | guidelines with exceptions | experienced judgment | internal | an AI agent | — |
| Verify with humans and/or benchmarks | evaluation benchmarking* | daily* | 30 minutes – 2 hours* | guidelines with exceptions* | experienced judgment* | internal* | a person* | occasional* |

Values marked * were inferred by the model from the wording rather than stated in the input; values marked † were confirmed by the user during clarification; unmarked values were stated in the input. "—" means the value is unknown.

### Clarification history

No clarification rounds were run.
