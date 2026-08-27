# Improvement report — Claims intake

Source: `claims-intake.recommendations.json` · recommender status **partial** — the user ended clarification · preprocessor status validated · step names from `claims-intake.json`

## Summary

_Written deterministically — no model summary was requested._

**10 improvement opportunities for "Claims intake" — start with Automate the evaluation harness for the rework loop across 3 steps.**

The recommender matched 10 improvement opportunities across 4 analysed steps and 2 multi-step shapes. The strongest is Automate the evaluation harness for the rework loop across 3 steps (20/100, medium confidence). Next come Standardize the inputs for "Extract claim details from the submitted forms" (20/100, medium confidence) and AI quality pre-check for the rework loop across 3 steps (17/100, medium confidence). 6 of the 10 are non-AI changes; 4 bring in AI. 1 pattern was ruled out because no deployment option may touch the data involved. The result is partial (the user ended clarification): 1 attribute question remains open, so unknown values were scored at their most conservative and confidence is lowered. 2 opportunities carry low confidence.

**Key takeaways**

- Automate the evaluation harness for the rework loop across 3 steps: 20/100, medium confidence, non-AI change (rule-based automation); medium effort.
- Standardize the inputs for "Extract claim details from the submitted forms": 20/100, medium confidence, non-AI change (standardize); medium effort.
- AI quality pre-check for the rework loop across 3 steps: 17/100, medium confidence, AI assists, a person stays in the loop; high effort.
- 1 pattern is excluded by data sensitivity — a lower sensitivity classification, if accurate, would bring it back.

**Suggested first step.** Automate the evaluation harness for the rework loop across 3 steps — the top-ranked opportunity — using its best deployment option, Scripted benchmark suite (medium effort). Before starting: ground truth or reference outputs for the benchmark set.

**Caveats**

- Top recommendation: 18 value(s) inferred from the step text rather than stated.
- 1 attribute question remains open; answering it would sharpen every score.

## The workflow at a glance

"Claims intake" has 4 steps the recommender could analyse (6 nodes including start and end). In flow order:

1. **Watch the shared inbox for new claims** (actor: claims clerk) — monitoring watching*; done by a person*; runs many times a day*; takes under 5 minutes per run*; follows mostly fixed rules*; needs only routine judgment*; touches regulated data*.
2. **Extract claim details from the submitted forms** (actor: claims clerk) — data extraction*; done by a person*; runs daily*; takes 5–30 minutes per run*; follows guidelines with exceptions*; needs only routine judgment*; touches regulated data*; occasionally goes wrong*.
3. **Is the claim complete?** (actor: claims clerk) — verification check*; done by a person*; runs daily*; follows mostly fixed rules*; needs only routine judgment*; touches regulated data*; not yet known: duration.
4. **Notify the claimant of the outcome** (actor: claims clerk) — communication notification*; done by a person*; runs daily*; takes under 5 minutes per run*; is fully rule-based*; needs no human judgment*; touches regulated data*.

Values marked * were inferred by the model from the wording rather than stated in the input; values marked † were confirmed by the user during clarification; unmarked values were stated in the input.

Branches and loops:

- From "Is the claim complete?" the flow branches: (yes) → "Notify the claimant of the outcome"; (no — wait for more documents) → "Watch the shared inbox for new claims".
- "Is the claim complete?" loops back to "Watch the shared inbox for new claims" (no — wait for more documents).

## Shapes worth attention

Multi-step patterns detected in the graph. Each is a recommendation target in its own right, with attributes aggregated conservatively across its steps.

- **Notification tail** (a notification after which the flow only notifies, files, or ends) — after "Notify the claimant of the outcome" the workflow only notifies, files, or ends. Steps: "Notify the claimant of the outcome" and "End".
- **Rework loop** (a cycle that keeps sending work back through a review or verification step) — a loop of 3 step(s) sends work back through "Is the claim complete?". Steps: "Is the claim complete?", "Extract claim details from the submitted forms" and "Watch the shared inbox for new claims".

## Recommendations

10 opportunities, ranked best-first. Scores run 0–100 and multiply impact (how much time the step consumes) by feasibility (how automatable it is for this pattern) by constraint (effort and data-sensitivity friction); the appendix explains every figure. The top 5 are written up in full; the remaining 5 are listed in the table that follows.

### 1. Automate the evaluation harness — for the rework loop across 3 steps

**Score 20/100** · medium confidence · non-AI change (rule-based automation) · medium effort

**Where.** A loop of 3 step(s) sends work back through "Is the claim complete?". Steps involved: "Is the claim complete?", "Extract claim details from the submitted forms" and "Watch the shared inbox for new claims".

Verification done by hand every iteration is the bottleneck of any build-measure loop — automate the benchmark portion so every change is scored mechanically, and spend human review on a sample.

**What to do.** *Scripted benchmark suite* — A fixed test/benchmark set run automatically on every iteration, with tracked scores. Deployment: no AI involved; medium effort.

**Why it ranks here.** Automate the evaluation harness for a loop of 3 step(s) sends work back through "Is the claim complete?". Runs many times a day (aggregated across the steps) at 5–30 minutes per run (aggregated across the steps) and goes wrong occasionally → impact 0.44. Structure: guidelines with exceptions (aggregated across the steps); judgment: routine judgment (aggregated across the steps) → feasibility 0.683. regulated (e.g. PII, health, financial) data (aggregated across the steps) allows 1 deployment option(s); best: Scripted benchmark suite (medium effort) → constraint 0.68. Total 20/100.

**Before starting.** Prerequisites: ground truth or reference outputs for the benchmark set. Caveats: benchmarks drift from reality — refresh the set on a schedule.

**Confidence: medium**, because:

- 18 value(s) inferred from the step text rather than stated

### 2. Standardize the inputs — for "Extract claim details from the submitted forms"

**Score 20/100** · medium confidence · non-AI change (standardize) · medium effort

Work that arrives in inconsistent shapes forces case-by-case handling — fixed forms, required fields, and checklists make the step rule-like (and unlock automation).

**What to do.** *Standard forms and checklists* — Define the canonical input format and the checklist the step follows. Deployment: no AI involved; medium effort.

**Why it ranks here.** Standardize the inputs for "Extract claim details from the submitted forms" (extract). Runs daily (inferred) at 5–30 minutes per run (inferred) and goes wrong occasionally → impact 0.36. Structure: guidelines with exceptions (inferred); judgment: routine judgment (inferred) → feasibility 0.8. regulated (e.g. PII, health, financial) data (inferred) allows 1 deployment option(s); best: Standard forms and checklists (medium effort) → constraint 0.68. Total 20/100.

**Before starting.** Prerequisites: authority to require the new format from upstream senders. Caveats: expect a transition period with both formats in flight.

**Confidence: medium**, because:

- 7 value(s) inferred from the step text rather than stated

### 3. AI quality pre-check — for the rework loop across 3 steps

**Score 17/100** · medium confidence · AI assists, a person stays in the loop · high effort

**Where.** A loop of 3 step(s) sends work back through "Is the claim complete?". Steps involved: "Is the claim complete?", "Extract claim details from the submitted forms" and "Watch the shared inbox for new claims".

An AI checks the work before (or instead of the first pass of) human review — catching the mechanical defects so humans review exceptions, and breaking rework loops closer to the source.

**What to do.** *On-prem model* — The same, cleared for regulated data. Deployment: on-premises infrastructure; high effort.

**Why it ranks here.** AI quality pre-check for a loop of 3 step(s) sends work back through "Is the claim complete?". Runs many times a day (aggregated across the steps) at 5–30 minutes per run (aggregated across the steps) and goes wrong occasionally → impact 0.44. Structure: guidelines with exceptions (aggregated across the steps); judgment: routine judgment (aggregated across the steps) → feasibility 0.683. regulated (e.g. PII, health, financial) data (aggregated across the steps) allows 1 deployment option(s); best: On-prem model (high effort) → constraint 0.56. Total 17/100.

**Before starting.** Prerequisites: cleared hosting environment; the review checklist written down. Caveats: AI review supplements, not replaces, accountable sign-off.

**Confidence: medium**, because:

- 18 value(s) inferred from the step text rather than stated

### 4. AI-assisted extraction and review — for "Extract claim details from the submitted forms"

**Score 14/100** · medium confidence · AI assists, a person stays in the loop · high effort

An AI pre-reads the documents and proposes the extracted values or review findings; the human confirms instead of reading cold.

**What to do.** *On-prem / dedicated model* — A model deployed in a controlled environment cleared for regulated data. Deployment: on-premises infrastructure; high effort.

**Why it ranks here.** AI-assisted extraction and review for "Extract claim details from the submitted forms" (extract). Runs daily (inferred) at 5–30 minutes per run (inferred) and goes wrong occasionally → impact 0.36. Structure: guidelines with exceptions (inferred); judgment: routine judgment (inferred) → feasibility 0.683. regulated (e.g. PII, health, financial) data (inferred) allows 1 deployment option(s); best: On-prem / dedicated model (high effort) → constraint 0.56. Total 14/100.

**Before starting.** Prerequisites: cleared hosting environment; model ops capacity.

**Confidence: medium**, because:

- 7 value(s) inferred from the step text rather than stated

### 5. Automate source monitoring — for "Watch the shared inbox for new claims"

**Score 13/100** · medium confidence · non-AI change (rule-based automation) · low effort

Recurring collection of papers, tools, or datasets is a standing query — feeds, alerts, and scheduled searches do the sweeping; humans (or an AI triager) only read what arrives.

**What to do.** *Feeds, alerts, and saved searches* — RSS/arXiv alerts, repo watches, and scheduled queries deliver candidates automatically. Deployment: no AI involved; low effort.

**Why it ranks here.** Automate source monitoring for "Watch the shared inbox for new claims" (watch). Runs many times a day (inferred) at under 5 minutes per run (inferred) → impact 0.2. Structure: mostly fixed rules (inferred); judgment: routine judgment (inferred) → feasibility 0.8. regulated (e.g. PII, health, financial) data (inferred) allows 1 deployment option(s); best: Feeds, alerts, and saved searches (low effort) → constraint 0.8. Total 13/100.

**Before starting.** Caveats: alert fatigue — curate the query set.

**Confidence: medium**, because:

- 6 value(s) inferred from the step text rather than stated

### Further opportunities

| # | Recommendation | Where | Score | Confidence | Effort |
|---|---|---|---|---|---|
| 6 | Eliminate the step | the notification tail across 2 steps | 13/100 | medium | low |
| 7 | Batch the work | "Notify the claimant of the outcome" | 13/100 | medium | low |
| 8 | Standardize the inputs, then Automate extraction with AI | "Extract claim details from the submitted forms" | 12/100 | medium | high |
| 9 | Batch the work | "Is the claim complete?" | 11/100 | low | low |
| 10 | AI quality pre-check | "Is the claim complete?" | 7/100 | low | high |

## Ruled out by data sensitivity

These patterns matched, but none of their deployment options may touch the data involved, so they are excluded rather than down-scored:

- **AI-summarized monitoring** for "Watch the shared inbox for new claims" — all variants exceed data sensitivity regulated.

## Open questions

The recommender stopped because the user ended clarification. 1 attribute question remains open; each unknown value was scored at its most conservative and lowers confidence. Answering them (re-run workflow-recommender interactively) would sharpen the ranking:

1. How long does one run of "Is the claim complete?" (complete) typically take?
   1) under 5 minutes  2) 5–30 minutes  3) 30 minutes – 2 hours  4) 2 hours – 1 day  5) multiple days

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
| Watch the shared inbox for new claims | monitoring watching* | many times a day* | under 5 minutes* | mostly fixed rules* | routine judgment* | regulated (e.g. PII, health, financial)* | a person* | — |
| Extract claim details from the submitted forms | data extraction* | daily* | 5–30 minutes* | guidelines with exceptions* | routine judgment* | regulated (e.g. PII, health, financial)* | a person* | occasional* |
| Is the claim complete? | verification check* | daily* | — | mostly fixed rules* | routine judgment* | regulated (e.g. PII, health, financial)* | a person* | — |
| Notify the claimant of the outcome | communication notification* | daily* | under 5 minutes* | fully rule-based* | no real judgment* | regulated (e.g. PII, health, financial)* | a person* | — |

Values marked * were inferred by the model from the wording rather than stated in the input; values marked † were confirmed by the user during clarification; unmarked values were stated in the input. "—" means the value is unknown.

### Clarification history

No clarification rounds were run.
