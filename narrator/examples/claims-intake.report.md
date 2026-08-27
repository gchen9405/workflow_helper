# Improvement report — Claims intake

Changes worth making to this workflow, ranked — with what each would take and how sure we are. Everything here comes from the workflow description you provided; the appendix shows the workings.

**This analysis is partial** — the user ended clarification, so 1 question is still open. Unknown facts were assumed to be the least favourable, which pushes some ratings down. See “Open questions”.

## Summary

_Written deterministically — no model summary was requested._

**10 improvement opportunities for "Claims intake" — start with Automate the evaluation harness.**

We looked at 4 steps of "Claims intake" and 2 shapes spanning several steps, and found 10 changes worth considering. The strongest is Automate the evaluation harness for the rework loop across 3 steps (Promising, 20/100, medium confidence). Next come Standardize the inputs for "Extract claim details from the submitted forms" (Promising, 20/100, medium confidence) and AI quality pre-check for the rework loop across 3 steps (Worth a look, 17/100, medium confidence).

The result is partial — the user ended clarification, leaving 1 question unanswered. Anything unknown was assumed to be the least favourable value, so these ratings are floors, not estimates.

**Key takeaways**

- Start with Automate the evaluation harness for the rework loop across 3 steps — Promising (20/100), medium effort, no AI — a script does it.
- 6 of the 10 need no AI at all; the other 4 bring AI in.
- The rework loop across 3 steps is the single biggest lever — 2 of the top 3 changes target it.
- 1 pattern is ruled out by data sensitivity — if that classification is too strict, correcting it brings it back.
- 2 of the 10 rest on facts we had to infer, and are marked low confidence.

**Suggested first step.** Automate the evaluation harness for the rework loop across 3 steps — the top-rated change — using Scripted benchmark suite (medium effort). You will need: ground truth or reference outputs for the benchmark set.

**Caveats**

- On the top recommendation: 18 value(s) inferred from the step text rather than stated.
- 1 attribute question remains open; answering it would sharpen every rating.

## Where to start

All 10, best first — begin at the top. “How sure” is how much of a rating rests on facts you stated rather than facts we inferred; the appendix explains both columns.

| # | What to change | Where | How promising | Effort | How sure |
|---|---|---|---|---|---|
| 1 | Automate the evaluation harness | the rework loop across 3 steps | Promising (20/100) | Medium | Medium |
| 2 | Standardize the inputs | "Extract claim details from the submitted forms" | Promising (20/100) | Medium | Medium |
| 3 | AI quality pre-check | the rework loop across 3 steps | Worth a look (17/100) | High | Medium |
| 4 | AI-assisted extraction and review | "Extract claim details from the submitted forms" | Worth a look (14/100) | High | Medium |
| 5 | Automate source monitoring | "Watch the shared inbox for new claims" | Worth a look (13/100) | Low | Medium |
| 6 | Eliminate the step | the notification tail across 2 steps | Worth a look (13/100) | Low | Medium |
| 7 | Batch the work | "Notify the claimant of the outcome" | Worth a look (13/100) | Low | Medium |
| 8 | Standardize the inputs, then Automate extraction with AI | "Extract claim details from the submitted forms" | Worth a look (12/100) | High | Medium |
| 9 | Batch the work | "Is the claim complete?" | Worth a look (11/100) | Low | Low |
| 10 | AI quality pre-check | "Is the claim complete?" | Low priority (7/100) | High | Low |

## The recommendations

The top 5 in full. The remaining 5 are in the table above; re-run with `--top 10` to write them all up.

### 1. Automate the evaluation harness — for the rework loop across 3 steps

**Promising (20/100)** · medium effort · no AI — a script does it · reasonably confident

**Where.** A loop of 3 step(s) sends work back through "Is the claim complete?". Steps involved: "Is the claim complete?", "Extract claim details from the submitted forms" and "Watch the shared inbox for new claims".

**Why it helps.** Verification done by hand every iteration is the bottleneck of any build-measure loop — automate the benchmark portion so every change is scored mechanically, and spend human review on a sample.

**What to do.** *Scripted benchmark suite* — a fixed test/benchmark set run automatically on every iteration, with tracked scores. Medium effort, with no AI involved.

**Before starting.** You will need: ground truth or reference outputs for the benchmark set. Watch out: benchmarks drift from reality — refresh the set on a schedule.

<details>
<summary>How this was rated, and how sure we are</summary>

**The rating.** Automate the evaluation harness for a loop of 3 step(s) sends work back through "Is the claim complete?". Runs many times a day (aggregated across the steps) at 5–30 minutes per run (aggregated across the steps) and goes wrong occasionally → impact 0.44. Structure: guidelines with exceptions (aggregated across the steps); judgment: routine judgment (aggregated across the steps) → feasibility 0.683. regulated (e.g. PII, health, financial) data (aggregated across the steps) allows 1 deployment option(s); best: Scripted benchmark suite (medium effort) → constraint 0.68. Total 20/100.

**Confidence: medium**, because:

- 18 value(s) inferred from the step text rather than stated

</details>

### 2. Standardize the inputs — for "Extract claim details from the submitted forms"

**Promising (20/100)** · medium effort · no AI — fix the inputs · reasonably confident

**Why it helps.** Work that arrives in inconsistent shapes forces case-by-case handling — fixed forms, required fields, and checklists make the step rule-like (and unlock automation).

**What to do.** *Standard forms and checklists* — define the canonical input format and the checklist the step follows. Medium effort, with no AI involved.

**Before starting.** You will need: authority to require the new format from upstream senders. Watch out: expect a transition period with both formats in flight.

<details>
<summary>How this was rated, and how sure we are</summary>

**The rating.** Standardize the inputs for "Extract claim details from the submitted forms" (extract). Runs daily (inferred) at 5–30 minutes per run (inferred) and goes wrong occasionally → impact 0.36. Structure: guidelines with exceptions (inferred); judgment: routine judgment (inferred) → feasibility 0.8. regulated (e.g. PII, health, financial) data (inferred) allows 1 deployment option(s); best: Standard forms and checklists (medium effort) → constraint 0.68. Total 20/100.

**Confidence: medium**, because:

- 7 value(s) inferred from the step text rather than stated

</details>

### 3. AI quality pre-check — for the rework loop across 3 steps

**Worth a look (17/100)** · high effort · AI helps, a person still decides · reasonably confident

**Where.** A loop of 3 step(s) sends work back through "Is the claim complete?". Steps involved: "Is the claim complete?", "Extract claim details from the submitted forms" and "Watch the shared inbox for new claims".

**Why it helps.** An AI checks the work before (or instead of the first pass of) human review — catching the mechanical defects so humans review exceptions, and breaking rework loops closer to the source.

**What to do.** *On-prem model* — the same, cleared for regulated data. High effort, on hardware you control.

**Before starting.** You will need: cleared hosting environment; the review checklist written down. Watch out: AI review supplements, not replaces, accountable sign-off.

<details>
<summary>How this was rated, and how sure we are</summary>

**The rating.** AI quality pre-check for a loop of 3 step(s) sends work back through "Is the claim complete?". Runs many times a day (aggregated across the steps) at 5–30 minutes per run (aggregated across the steps) and goes wrong occasionally → impact 0.44. Structure: guidelines with exceptions (aggregated across the steps); judgment: routine judgment (aggregated across the steps) → feasibility 0.683. regulated (e.g. PII, health, financial) data (aggregated across the steps) allows 1 deployment option(s); best: On-prem model (high effort) → constraint 0.56. Total 17/100.

**Confidence: medium**, because:

- 18 value(s) inferred from the step text rather than stated

</details>

### 4. AI-assisted extraction and review — for "Extract claim details from the submitted forms"

**Worth a look (14/100)** · high effort · AI helps, a person still decides · reasonably confident

**Why it helps.** An AI pre-reads the documents and proposes the extracted values or review findings; the human confirms instead of reading cold.

**What to do.** *On-prem / dedicated model* — a model deployed in a controlled environment cleared for regulated data. High effort, on hardware you control.

**Before starting.** You will need: cleared hosting environment; model ops capacity.

<details>
<summary>How this was rated, and how sure we are</summary>

**The rating.** AI-assisted extraction and review for "Extract claim details from the submitted forms" (extract). Runs daily (inferred) at 5–30 minutes per run (inferred) and goes wrong occasionally → impact 0.36. Structure: guidelines with exceptions (inferred); judgment: routine judgment (inferred) → feasibility 0.683. regulated (e.g. PII, health, financial) data (inferred) allows 1 deployment option(s); best: On-prem / dedicated model (high effort) → constraint 0.56. Total 14/100.

**Confidence: medium**, because:

- 7 value(s) inferred from the step text rather than stated

</details>

### 5. Automate source monitoring — for "Watch the shared inbox for new claims"

**Worth a look (13/100)** · low effort · no AI — a script does it · reasonably confident

**Why it helps.** Recurring collection of papers, tools, or datasets is a standing query — feeds, alerts, and scheduled searches do the sweeping; humans (or an AI triager) only read what arrives.

**What to do.** *Feeds, alerts, and saved searches* — RSS/arXiv alerts, repo watches, and scheduled queries deliver candidates automatically. Low effort, with no AI involved.

**Before starting.** Watch out: alert fatigue — curate the query set.

<details>
<summary>How this was rated, and how sure we are</summary>

**The rating.** Automate source monitoring for "Watch the shared inbox for new claims" (watch). Runs many times a day (inferred) at under 5 minutes per run (inferred) → impact 0.2. Structure: mostly fixed rules (inferred); judgment: routine judgment (inferred) → feasibility 0.8. regulated (e.g. PII, health, financial) data (inferred) allows 1 deployment option(s); best: Feeds, alerts, and saved searches (low effort) → constraint 0.8. Total 13/100.

**Confidence: medium**, because:

- 6 value(s) inferred from the step text rather than stated

</details>

## How the workflow runs today

"Claims intake" has 4 steps we could analyse (6 nodes including start and end). In flow order:

1. **Watch the shared inbox for new claims** (actor: claims clerk) — monitoring watching*, done by a person*. Runs many times a day*, under 5 minutes each time*. Notable: touches regulated data*.
2. **Extract claim details from the submitted forms** (actor: claims clerk) — data extraction*, done by a person*. Runs daily*, 5–30 minutes each time*. Notable: touches regulated data* and occasionally goes wrong*.
3. **Is the claim complete?** (actor: claims clerk) — verification check*, done by a person*. Runs daily*. Notable: touches regulated data*. Not yet known: how long it takes.
4. **Notify the claimant of the outcome** (actor: claims clerk) — communication notification*, done by a person*. Runs daily*, under 5 minutes each time*. Notable: touches regulated data*.

Values marked * were inferred by the model from the wording rather than stated in the input; values marked † were confirmed by the user during clarification; unmarked values were stated in the input. Each step's full profile is in the appendix.

Branches and loops:

- From "Is the claim complete?" the flow branches: (yes) → "Notify the claimant of the outcome"; (no — wait for more documents) → "Watch the shared inbox for new claims".
- "Is the claim complete?" loops back to "Watch the shared inbox for new claims" (no — wait for more documents).

## Shapes worth attention

Patterns spanning several steps. Each can be improved as a unit — which is why some recommendations above target a shape rather than one step.

- **Notification tail** — a notification after which the flow only notifies, files, or ends. Here: after "Notify the claimant of the outcome" the workflow only notifies, files, or ends. Steps: "Notify the claimant of the outcome" and "End".
- **Rework loop** — a cycle that keeps sending work back through a review or verification step. Here: a loop of 3 step(s) sends work back through "Is the claim complete?". Steps: "Is the claim complete?", "Extract claim details from the submitted forms" and "Watch the shared inbox for new claims".

## Ruled out by data sensitivity

These would otherwise apply, but no way of running them may touch data this sensitive — so they are ruled out, not rated low. Correcting an over-strict classification brings them back:

- **AI-summarized monitoring** for "Watch the shared inbox for new claims" — all variants exceed data sensitivity regulated.

## Open questions

The analysis stopped because the user ended clarification. 1 question about the steps is still open, and each unknown was assumed to be the least favourable value — which lowers both the ratings and the confidence. Answering these (re-run `workflow-recommender` interactively) would sharpen the ranking:

1. How long does one run of "Is the claim complete?" (complete) typically take?
   1) under 5 minutes  2) 5–30 minutes  3) 30 minutes – 2 hours  4) 2 hours – 1 day  5) multiple days

## Appendix

### How this report was made

- Generated from `claims-intake.recommendations.json`, the result of running `workflow-recommender` over this workflow.
- Recommender status: **partial** — the user ended clarification.
- Preprocessor status: validated.
- Step names came from `claims-intake.json`.
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
| Watch the shared inbox for new claims | monitoring watching* | many times a day* | under 5 minutes* | mostly fixed rules* | routine judgment* | regulated (e.g. PII, health, financial)* | a person* | — |
| Extract claim details from the submitted forms | data extraction* | daily* | 5–30 minutes* | guidelines with exceptions* | routine judgment* | regulated (e.g. PII, health, financial)* | a person* | occasional* |
| Is the claim complete? | verification check* | daily* | — | mostly fixed rules* | routine judgment* | regulated (e.g. PII, health, financial)* | a person* | — |
| Notify the claimant of the outcome | communication notification* | daily* | under 5 minutes* | fully rule-based* | no real judgment* | regulated (e.g. PII, health, financial)* | a person* | — |

Values marked * were inferred by the model from the wording rather than stated in the input; values marked † were confirmed by the user during clarification; unmarked values were stated in the input. "—" means the value is unknown.

</details>
