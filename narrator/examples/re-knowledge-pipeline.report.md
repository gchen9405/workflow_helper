# Improvement report — RE knowledge pipeline

Changes worth making to this workflow, ranked — with what each would take and how sure we are. Everything here comes from the workflow description you provided; the appendix shows the workings.

## Summary

_Written deterministically — no model summary was requested._

**6 improvement opportunities for "RE knowledge pipeline" — start with AI quality pre-check.**

We looked at 5 steps of "RE knowledge pipeline" and 2 shapes spanning several steps, and found 6 changes worth considering. The strongest is AI quality pre-check for the rework loop across 4 steps (Promising, 30/100, medium confidence). Next come Automate the evaluation harness for the rework loop across 4 steps (Promising, 30/100, medium confidence) and Standardize the inputs for "Agent assists with RE / software-understanding task" (Promising, 30/100, high confidence).

**Key takeaways**

- Start with AI quality pre-check for the rework loop across 4 steps — Promising (30/100), medium effort, AI helps, a person still decides.
- 4 of the 6 need no AI at all; the other 2 bring AI in.
- The rework loop across 4 steps is the single biggest lever — 2 of the top 3 changes target it.

**Suggested first step.** AI quality pre-check for the rework loop across 4 steps — the top-rated change — using Internal LLM endpoint (medium effort). You will need: the review checklist written down.

**Caveats**

- On the top recommendation: 19 value(s) inferred from the step text rather than stated.

## Where to start

All 6, best first — begin at the top. “How sure” is how much of a rating rests on facts you stated rather than facts we inferred; the appendix explains both columns.

| # | What to change | Where | How promising | Effort | How sure |
|---|---|---|---|---|---|
| 1 | AI quality pre-check | the rework loop across 4 steps | Promising (30/100) | Medium | Medium |
| 2 | Automate the evaluation harness | the rework loop across 4 steps | Promising (30/100) | Medium | Medium |
| 3 | Standardize the inputs | "Agent assists with RE / software-understanding task" | Promising (30/100) | Medium | High |
| 4 | Automate the evaluation harness | "Verify with humans and/or benchmarks" | Promising (27/100) | Medium | Medium |
| 5 | Automate source monitoring | "Collect RE knowledge sources: papers and existing tools" | Promising (22/100) | Low | Medium |
| 6 | Build a retrievable knowledge base | "Distill RE knowledge for AI-agent consumption" | Worth a look (17/100) | High | Medium |

## The recommendations

All 6, in full.

### 1. AI quality pre-check — for the rework loop across 4 steps

**Promising (30/100)** · medium effort · AI helps, a person still decides · reasonably confident

**Where.** A loop of 4 step(s) sends work back through "Agent assists with RE / software-understanding task". Steps involved: "Agent assists with RE / software-understanding task", "Distill RE knowledge for AI-agent consumption", "Expose distilled knowledge to AI agent or custom harness" and "Verify with humans and/or benchmarks".

**Why it helps.** An AI checks the work before (or instead of the first pass of) human review — catching the mechanical defects so humans review exceptions, and breaking rework loops closer to the source.

**What to do.** *Internal LLM endpoint* — checklist-grounded AI review on the internal endpoint. Medium effort, on the company's own LLM service.

**Other options that fit this data.** *On-prem model* (on hardware you control, high effort).

**Before starting.** You will need: the review checklist written down. Watch out: AI review supplements, not replaces, accountable sign-off.

<details>
<summary>How this was rated, and how sure we are</summary>

**The rating.** AI quality pre-check for a loop of 4 step(s) sends work back through "Agent assists with RE / software-understanding task". Runs daily (aggregated across the steps) at 2 hours – 1 day per run (aggregated across the steps) and goes wrong occasionally → impact 0.68. Structure: guidelines with exceptions (aggregated across the steps); judgment: deep expert judgment (aggregated across the steps) → feasibility 0.517. internal data (aggregated across the steps) allows 2 deployment option(s); best: Internal LLM endpoint (medium effort) → constraint 0.85. Total 30/100.

**Confidence: medium**, because:

- 19 value(s) inferred from the step text rather than stated

</details>

### 2. Automate the evaluation harness — for the rework loop across 4 steps

**Promising (30/100)** · medium effort · no AI — a script does it · reasonably confident

**Where.** A loop of 4 step(s) sends work back through "Agent assists with RE / software-understanding task". Steps involved: "Agent assists with RE / software-understanding task", "Distill RE knowledge for AI-agent consumption", "Expose distilled knowledge to AI agent or custom harness" and "Verify with humans and/or benchmarks".

**Why it helps.** Verification done by hand every iteration is the bottleneck of any build-measure loop — automate the benchmark portion so every change is scored mechanically, and spend human review on a sample.

**What to do.** *Scripted benchmark suite* — a fixed test/benchmark set run automatically on every iteration, with tracked scores. Medium effort, with no AI involved.

**Other options that fit this data.** *AI-graded evaluations* (on the company's own LLM service, medium effort).

**Before starting.** You will need: ground truth or reference outputs for the benchmark set. Watch out: benchmarks drift from reality — refresh the set on a schedule.

<details>
<summary>How this was rated, and how sure we are</summary>

**The rating.** Automate the evaluation harness for a loop of 4 step(s) sends work back through "Agent assists with RE / software-understanding task". Runs daily (aggregated across the steps) at 2 hours – 1 day per run (aggregated across the steps) and goes wrong occasionally → impact 0.68. Structure: guidelines with exceptions (aggregated across the steps); judgment: deep expert judgment (aggregated across the steps) → feasibility 0.517. internal data (aggregated across the steps) allows 2 deployment option(s); best: Scripted benchmark suite (medium effort) → constraint 0.85. Total 30/100.

**Confidence: medium**, because:

- 19 value(s) inferred from the step text rather than stated

</details>

### 3. Standardize the inputs — for "Agent assists with RE / software-understanding task"

**Promising (30/100)** · medium effort · no AI — fix the inputs · confident

**Why it helps.** Work that arrives in inconsistent shapes forces case-by-case handling — fixed forms, required fields, and checklists make the step rule-like (and unlock automation).

**What to do.** *Standard forms and checklists* — define the canonical input format and the checklist the step follows. Medium effort, with no AI involved.

**Before starting.** You will need: authority to require the new format from upstream senders. Watch out: expect a transition period with both formats in flight.

<details>
<summary>How this was rated, and how sure we are</summary>

**The rating.** Standardize the inputs for "Agent assists with RE / software-understanding task" (agent_assist). Runs daily (from the input) at 30 minutes – 2 hours per run (from the input) → impact 0.48. Structure: guidelines with exceptions (from the input); judgment: experienced judgment (from the input) → feasibility 0.733. internal data (from the input) allows 1 deployment option(s); best: Standard forms and checklists (medium effort) → constraint 0.85. Total 30/100.

**Confidence: high** — every value behind this rating was stated in the input or confirmed by the user.

</details>

### 4. Automate the evaluation harness — for "Verify with humans and/or benchmarks"

**Promising (27/100)** · medium effort · no AI — a script does it · reasonably confident

**Why it helps.** Verification done by hand every iteration is the bottleneck of any build-measure loop — automate the benchmark portion so every change is scored mechanically, and spend human review on a sample.

**What to do.** *Scripted benchmark suite* — a fixed test/benchmark set run automatically on every iteration, with tracked scores. Medium effort, with no AI involved.

**Other options that fit this data.** *AI-graded evaluations* (on the company's own LLM service, medium effort).

**Before starting.** You will need: ground truth or reference outputs for the benchmark set. Watch out: benchmarks drift from reality — refresh the set on a schedule.

<details>
<summary>How this was rated, and how sure we are</summary>

**The rating.** Automate the evaluation harness for "Verify with humans and/or benchmarks" (verify). Runs daily (inferred) at 30 minutes – 2 hours per run (inferred) and goes wrong occasionally → impact 0.52. Structure: guidelines with exceptions (inferred); judgment: experienced judgment (inferred) → feasibility 0.6. internal data (inferred) allows 2 deployment option(s); best: Scripted benchmark suite (medium effort) → constraint 0.85. Total 27/100.

**Confidence: medium**, because:

- 7 value(s) inferred from the step text rather than stated

</details>

### 5. Automate source monitoring — for "Collect RE knowledge sources: papers and existing tools"

**Promising (22/100)** · low effort · no AI — a script does it · reasonably confident

**Why it helps.** Recurring collection of papers, tools, or datasets is a standing query — feeds, alerts, and scheduled searches do the sweeping; humans (or an AI triager) only read what arrives.

**What to do.** *Feeds, alerts, and saved searches* — RSS/arXiv alerts, repo watches, and scheduled queries deliver candidates automatically. Low effort, with no AI involved.

**Other options that fit this data.** *AI-triaged alerts* (on the company's own LLM service, medium effort).

**Before starting.** Watch out: alert fatigue — curate the query set.

<details>
<summary>How this was rated, and how sure we are</summary>

**The rating.** Automate source monitoring for "Collect RE knowledge sources: papers and existing tools" (collect). Runs weekly (inferred) at 30 minutes – 2 hours per run (inferred) → impact 0.36. Structure: guidelines with exceptions (inferred); judgment: experienced judgment (inferred) → feasibility 0.6. internal data (inferred) allows 2 deployment option(s); best: Feeds, alerts, and saved searches (low effort) → constraint 1. Total 22/100.

**Confidence: medium**, because:

- 6 value(s) inferred from the step text rather than stated

</details>

### 6. Build a retrievable knowledge base — for "Distill RE knowledge for AI-agent consumption"

**Worth a look (17/100)** · high effort · AI helps, a person still decides · reasonably confident

**Why it helps.** Distilled knowledge that lives in documents gets re-derived every time it is needed — index it into a retrievable store that both humans and AI agents/harnesses query.

**What to do.** *RAG store on the internal endpoint* — chunked, indexed corpus with retrieval feeding the internal LLM (and any agent harness). High effort, on the company's own LLM service.

**Other options that fit this data.** *On-prem RAG store* (on hardware you control, high effort).

**Before starting.** You will need: the corpus collected in one place; an owner for index freshness. Watch out: stale indexes quietly poison downstream answers — automate re-indexing.

<details>
<summary>How this was rated, and how sure we are</summary>

**The rating.** Build a retrievable knowledge base for "Distill RE knowledge for AI-agent consumption" (distill). Runs weekly (inferred) at 2 hours – 1 day per run (inferred) → impact 0.48. Structure: guidelines with exceptions (inferred); judgment: deep expert judgment (inferred) → feasibility 0.517. internal data (inferred) allows 2 deployment option(s); best: RAG store on the internal endpoint (high effort) → constraint 0.7. Total 17/100.

**Confidence: medium**, because:

- 6 value(s) inferred from the step text rather than stated

</details>

## How the workflow runs today

"RE knowledge pipeline" has 5 steps we could analyse (7 nodes including start and end). In flow order:

1. **Collect RE knowledge sources: papers and existing tools** — research gathering*, done by a person*. Runs weekly*, 30 minutes – 2 hours each time*.
2. **Distill RE knowledge for AI-agent consumption** — knowledge distillation*, done by a person*. Runs weekly*, 2 hours – 1 day each time*. Notable: needs expert judgment*.
3. **Expose distilled knowledge to AI agent or custom harness** — tool integration*, done by a person*. Runs monthly*, 30 minutes – 2 hours each time*.
4. **Agent assists with RE / software-understanding task** (actor: AI agent) — document review, done by an AI agent. Runs daily, 30 minutes – 2 hours each time.
5. **Verify with humans and/or benchmarks** — evaluation benchmarking*, done by a person*. Runs daily*, 30 minutes – 2 hours each time*. Notable: occasionally goes wrong*.

Values marked * were inferred by the model from the wording rather than stated in the input; values marked † were confirmed by the user during clarification; unmarked values were stated in the input. Each step's full profile is in the appendix.

Branches and loops:

- From "Verify with humans and/or benchmarks" the flow branches: (accepted) → "Actionable software-understanding output"; (needs iteration) → "Distill RE knowledge for AI-agent consumption".
- "Verify with humans and/or benchmarks" loops back to "Distill RE knowledge for AI-agent consumption" (needs iteration).

## Shapes worth attention

Patterns spanning several steps. Each can be improved as a unit — which is why some recommendations above target a shape rather than one step.

- **Long manual chain** — an unbroken run of manual steps by the same actor. Here: 3 manual steps in an unbroken run by the same person. Steps: "Collect RE knowledge sources: papers and existing tools", "Distill RE knowledge for AI-agent consumption" and "Expose distilled knowledge to AI agent or custom harness".
- **Rework loop** — a cycle that keeps sending work back through a review or verification step. Here: a loop of 4 step(s) sends work back through "Agent assists with RE / software-understanding task". Steps: "Agent assists with RE / software-understanding task", "Distill RE knowledge for AI-agent consumption", "Expose distilled knowledge to AI agent or custom harness" and "Verify with humans and/or benchmarks".

## Appendix

### How this report was made

- Generated from `re-knowledge-pipeline.recommendations.json`, the result of running `workflow-recommender` over this workflow.
- Recommender status: **recommended** (every attribute question was answered).
- Preprocessor status: validated.
- Step names came from `re-knowledge-pipeline.json`.
- No clarification rounds were run.

Every figure in this report is templated from that result — nothing here is re-derived, re-ranked, or estimated at report time.

<details>
<summary>How to read the ratings</summary>

**Rating bands** are a fixed reading of the 0–100 score, the same in every report: 35 and above “Strong candidate” · 20–34 “Promising” · 10–19 “Worth a look” · 0–9 “Low priority”. The score itself is always printed alongside.

The score is impact × feasibility × constraint, rounded to 0–100:

- **Impact** — frequency × duration on 1–5 scales (plus a bonus of up to 2 when the step is known to go wrong), scaled to 0–1. Unknown values take the lowest scale point.
- **Feasibility** — how automatable the target is for this pattern: a pattern-specific base plus weighted contributions from how rule-like the work is (structure) and how little judgment it needs. 0–1.
- **Constraint** — the effort of the best deployment option (low 1.0 · medium 0.85 · high 0.7) × data-sensitivity friction (public/internal 1.0 · confidential 0.9 · regulated 0.8) × 0.9 for two-step sequences. 0–1.
- **Total** — round(100 × impact × feasibility × constraint).
- **Confidence** — *high*: every score-relevant value was stated in the input or confirmed by the user; *medium*: some values were inferred from the wording, or the preprocessor result was partial; *low*: an unknown value was substituted conservatively, or an open preprocessor question touches the target.
- **Data sensitivity is a hard filter** — a deployment option whose ceiling is below the target's sensitivity is dropped, not down-scored; a pattern that loses every option is listed under exclusions.

</details>

<details>
<summary>The full step profiles</summary>

Every attribute of every step, including the ones “How the workflow runs today” leaves out.

| Step | Class | Frequency | Duration | Structure | Judgment | Data | Actor | Errors |
|---|---|---|---|---|---|---|---|---|
| Collect RE knowledge sources: papers and existing tools | research gathering* | weekly* | 30 minutes – 2 hours* | guidelines with exceptions* | experienced judgment* | internal* | a person* | — |
| Distill RE knowledge for AI-agent consumption | knowledge distillation* | weekly* | 2 hours – 1 day* | guidelines with exceptions* | deep expert judgment* | internal* | a person* | — |
| Expose distilled knowledge to AI agent or custom harness | tool integration* | monthly* | 30 minutes – 2 hours* | mostly fixed rules* | experienced judgment* | internal* | a person* | — |
| Agent assists with RE / software-understanding task | document review | daily | 30 minutes – 2 hours | guidelines with exceptions | experienced judgment | internal | an AI agent | — |
| Verify with humans and/or benchmarks | evaluation benchmarking* | daily* | 30 minutes – 2 hours* | guidelines with exceptions* | experienced judgment* | internal* | a person* | occasional* |

Values marked * were inferred by the model from the wording rather than stated in the input; values marked † were confirmed by the user during clarification; unmarked values were stated in the input. "—" means the value is unknown.

</details>
