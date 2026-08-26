/**
 * The starter pattern catalog — PURE DATA. Growing the catalog means
 * appending literals here; matching, scoring, and ranking never change.
 * A test runs `validateCatalog` over this array, so a malformed entry
 * fails the build, not a user's run.
 *
 * Families:
 * - Non-AI first: eliminate / consolidate / batch / standardize /
 *   rule-based / RPA / delegate. The honest answer to many workflow
 *   problems is not a model.
 * - AI adoption: assist (human stays in the loop) and automate (with
 *   fallback prerequisites). Every ai_assist/ai_automate entry gates on
 *   `actorKinds: [human, mixed]` — never recommend adding AI to a step an
 *   AI agent already performs.
 * - Knowledge-work: source monitoring, RAG/knowledge bases, eval-harness
 *   automation — for research/engineering pipelines, including steps whose
 *   actor is already an AI agent.
 *
 * Feasibility-weight conventions (deviations are commented):
 *   full automation  (0,   0.6,  0.4 ) — lives or dies on structure/judgment
 *   assist           (0.4, 0.35, 0.25) — a human stays in the loop
 *   organizational   (0.6, 0.2,  0.2 ) — barely depends on either
 *
 * Variant `sensitivityCeiling` encodes the deployment posture: external
 * SaaS tops out at `internal` data, the company's internal LLM endpoint at
 * `confidential`, on-prem and non-AI changes at `regulated`. That is what
 * makes sensitivity a hard filter on VARIANTS rather than on patterns: a
 * regulated task can still get AI assistance — only the on-prem variant
 * survives.
 *
 * `advice: []` on every entry is the reserved lessons-learned slot.
 */
import type { PatternDef } from "../schema/catalog.js";

export const STARTER_CATALOG: PatternDef[] = [
  // -------------------------------------------------------------------------
  // Non-AI patterns
  // -------------------------------------------------------------------------
  {
    id: "pat.eliminate_step",
    name: "Eliminate the step",
    description:
      "A notification whose entire onward flow only notifies, files, or ends adds a hop without changing any outcome — fold it into the step before it, or drop it.",
    automationClass: "eliminate",
    applicability: { motifs: ["notification_tail"] },
    feasibilityWeights: { base: 0.6, structure: 0.2, judgment: 0.2 },
    variants: [
      {
        id: "drop_or_merge",
        name: "Drop the step or merge it into its predecessor",
        description: "Remove the standalone notification; let the preceding step send it, or rely on system status.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "low",
        prerequisites: ["confirm no downstream consumer depends on the separate notification"],
        caveats: ["some notifications exist for compliance evidence — check retention duties first"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.consolidate_duplicates",
    name: "Consolidate duplicate work",
    description:
      "The same kind of step, done by the same actor, appears more than once — merge the occurrences into one step or one shared queue.",
    automationClass: "consolidate",
    applicability: { motifs: ["repeated_similar_tasks"] },
    feasibilityWeights: { base: 0.6, structure: 0.2, judgment: 0.2 },
    variants: [
      {
        id: "merge_steps",
        name: "Merge into a single step or queue",
        description: "One combined step (or one worklist) replaces the scattered occurrences.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "medium",
        prerequisites: ["the occurrences genuinely need the same inputs and outputs"],
        caveats: ["occurrences may exist at different points for sequencing reasons — verify order does not matter"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.consolidate_approvals",
    name: "Consolidate approvals",
    description:
      "Back-to-back approvals rarely both change the outcome — combine them into one approval with the right approver, or make the second one exception-only.",
    automationClass: "consolidate",
    applicability: { motifs: ["approval_chain"] },
    feasibilityWeights: { base: 0.6, structure: 0.2, judgment: 0.2 },
    variants: [
      {
        id: "single_approval",
        name: "Single approval with thresholds",
        description: "One approver; the second sign-off becomes exception-only above a threshold.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "medium",
        prerequisites: ["agreement from the approvers' owners on thresholds"],
        caveats: ["separation-of-duties or audit policy may REQUIRE both approvals — check before merging"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.batch_processing",
    name: "Batch the work",
    description:
      "Small, frequent occurrences of the same task cost more in context-switching than in the work itself — collect them and process on a schedule.",
    automationClass: "batch",
    applicability: {
      taskClasses: ["data_entry", "verification_check", "communication_notification", "system_operation"],
      minFrequency: "daily",
      maxDuration: "5_to_30_min",
    },
    feasibilityWeights: { base: 0.6, structure: 0.2, judgment: 0.2 },
    variants: [
      {
        id: "scheduled_batches",
        name: "Fixed processing windows",
        description: "Handle accumulated items once or twice a day instead of on arrival.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "low",
        prerequisites: [],
        caveats: ["unsuitable when items have tight per-item deadlines"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.standardize_inputs",
    name: "Standardize the inputs",
    description:
      "Work that arrives in inconsistent shapes forces case-by-case handling — fixed forms, required fields, and checklists make the step rule-like (and unlock automation).",
    automationClass: "standardize",
    applicability: {
      taskClasses: ["data_entry", "data_extraction", "document_review", "document_generation"],
      maxStructure: "guidelines_with_exceptions",
    },
    feasibilityWeights: { base: 0.6, structure: 0.2, judgment: 0.2 },
    improves: { attribute: "structure", raisesTo: "mostly_rules" },
    variants: [
      {
        id: "forms_and_checklists",
        name: "Standard forms and checklists",
        description: "Define the canonical input format and the checklist the step follows.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "medium",
        prerequisites: ["authority to require the new format from upstream senders"],
        caveats: ["expect a transition period with both formats in flight"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.template_documents",
    name: "Template the documents",
    description:
      "Recurring documents and messages written from scratch every time — a template with fill-in fields removes most of the drafting.",
    automationClass: "standardize",
    applicability: {
      taskClasses: ["document_generation", "communication_drafting"],
      minFrequency: "weekly",
    },
    feasibilityWeights: { base: 0.6, structure: 0.2, judgment: 0.2 },
    improves: { attribute: "structure", raisesTo: "mostly_rules" },
    variants: [
      {
        id: "document_templates",
        name: "Templates with fill-in fields",
        description: "A maintained template set; authors fill variables instead of drafting.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "low",
        prerequisites: [],
        caveats: ["templates drift — assign an owner"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.rule_based_automation",
    name: "Automate with plain rules",
    description:
      "A step that is fully rule-based and needs at most routine judgment does not need AI — a script or workflow engine does it exactly, every time.",
    automationClass: "rule_based_automation",
    applicability: {
      taskClasses: [
        "calculation",
        "verification_check",
        "classification_routing",
        "data_transfer",
        "scheduling_coordination",
        "system_operation",
      ],
      minStructure: "fully_rule_based",
      maxJudgment: "routine",
    },
    feasibilityWeights: { base: 0, structure: 0.6, judgment: 0.4 },
    variants: [
      {
        id: "script_or_workflow_engine",
        name: "Script / workflow engine",
        description: "Encode the rules in a script, cron job, or the team's workflow engine.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "medium",
        prerequisites: ["the rules written down and signed off"],
        caveats: [],
      },
      {
        id: "saas_workflow_tool",
        name: "SaaS workflow tool",
        description: "A no-code automation service (approval flows, connectors).",
        deployment: "external_saas",
        sensitivityCeiling: "confidential",
        effort: "low",
        prerequisites: ["procurement/security review of the tool"],
        caveats: ["per-seat/per-run pricing grows with volume"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.system_integration_api",
    name: "Integrate the systems directly",
    description:
      "Humans re-keying data between systems are acting as a missing integration — connect the systems and the chain disappears.",
    automationClass: "rule_based_automation",
    applicability: { motifs: ["manual_data_transfer_chain"] },
    feasibilityWeights: { base: 0, structure: 0.6, judgment: 0.4 },
    variants: [
      {
        id: "native_api",
        name: "Native API integration",
        description: "Purpose-built integration using the systems' own APIs.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "high",
        prerequisites: ["API access on both systems", "engineering capacity"],
        caveats: [],
      },
      {
        id: "ipaas_connector",
        name: "iPaaS connector",
        description: "An integration platform's prebuilt connectors between the systems.",
        deployment: "external_saas",
        sensitivityCeiling: "confidential",
        effort: "medium",
        prerequisites: ["both systems supported by the platform"],
        caveats: ["platform subscription; data transits the vendor"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.rpa_ui_automation",
    name: "RPA the user interface",
    description:
      "When systems have no usable APIs, a robot driving the same screens a human does removes the re-keying — as long as the steps are truly deterministic.",
    automationClass: "rpa",
    applicability: {
      taskClasses: ["system_operation", "data_entry"],
      motifs: ["manual_data_transfer_chain"],
      minStructure: "mostly_rules",
      maxJudgment: "routine",
    },
    feasibilityWeights: { base: 0, structure: 0.6, judgment: 0.4 },
    variants: [
      {
        id: "on_prem_rpa",
        name: "On-prem RPA",
        description: "RPA robots running inside the company boundary.",
        deployment: "on_prem",
        sensitivityCeiling: "regulated",
        effort: "medium",
        prerequisites: ["stable target UIs", "credentials management for robots"],
        caveats: ["UI changes silently break robots — budget for maintenance"],
      },
      {
        id: "cloud_rpa",
        name: "Cloud RPA",
        description: "Vendor-hosted RPA service.",
        deployment: "external_saas",
        sensitivityCeiling: "confidential",
        effort: "medium",
        prerequisites: ["security review of vendor access paths"],
        caveats: ["UI changes silently break robots — budget for maintenance"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.self_service_intake",
    name: "Move intake to self-service",
    description:
      "A manual transfer chain often starts with someone transcribing what a requester could have entered directly — a structured intake form removes the head of the chain and standardizes what flows in.",
    automationClass: "standardize",
    applicability: { motifs: ["manual_data_transfer_chain"] },
    feasibilityWeights: { base: 0.6, structure: 0.2, judgment: 0.2 },
    improves: { attribute: "structure", raisesTo: "mostly_rules" },
    variants: [
      {
        id: "intake_form",
        name: "Structured intake form / portal",
        description: "Requesters enter validated, structured data at the source.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "medium",
        prerequisites: ["requesters reachable/mandatable to use the form"],
        caveats: ["exceptions still need a manual side door"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.delegate_or_reassign",
    name: "Delegate or reassign",
    description:
      "Long-running work needing only routine judgment may simply be with the wrong person — move it to a junior role, a shared service, or the team whose tooling fits.",
    automationClass: "delegate",
    applicability: {
      taskClasses: [
        "data_entry",
        "data_extraction",
        "data_transfer",
        "document_generation",
        "document_review",
        "classification_routing",
        "verification_check",
        "calculation",
        "scheduling_coordination",
        "communication_notification",
        "communication_drafting",
        "information_lookup",
        "summarization_reporting",
        "archiving_records",
        "monitoring_watching",
        "research_gathering",
      ],
      maxJudgment: "routine",
      minDuration: "2_h_to_1_day",
      actorKinds: ["human"],
    },
    feasibilityWeights: { base: 0.6, structure: 0.2, judgment: 0.2 },
    variants: [
      {
        id: "reassign",
        name: "Reassign to a better-fitting role",
        description: "Hand the work to a role whose cost and skills match it.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "low",
        prerequisites: ["a receiving role actually exists"],
        caveats: ["needs organizational context this tool cannot see — treat as a prompt, not a verdict"],
      },
    ],
    advice: [],
  },

  // -------------------------------------------------------------------------
  // AI adoption patterns (all gated to human/mixed actors)
  // -------------------------------------------------------------------------
  {
    id: "pat.ai_extraction_assist",
    name: "AI-assisted extraction and review",
    description:
      "An AI pre-reads the documents and proposes the extracted values or review findings; the human confirms instead of reading cold.",
    automationClass: "ai_assist",
    applicability: {
      taskClasses: ["data_extraction", "document_review", "information_lookup"],
      actorKinds: ["human", "mixed"],
    },
    feasibilityWeights: { base: 0.4, structure: 0.35, judgment: 0.25 },
    variants: [
      {
        id: "external_llm",
        name: "External LLM service",
        description: "A commercial LLM API or copilot product.",
        deployment: "external_saas",
        sensitivityCeiling: "internal",
        effort: "low",
        prerequisites: [],
        caveats: ["data leaves the company boundary"],
      },
      {
        id: "internal_endpoint_assist",
        name: "Internal LLM endpoint",
        description: "The company's internal OpenAI-compatible endpoint behind the firewall.",
        deployment: "internal_endpoint",
        sensitivityCeiling: "confidential",
        effort: "medium",
        prerequisites: ["access to the internal endpoint"],
        caveats: [],
      },
      {
        id: "on_prem_model",
        name: "On-prem / dedicated model",
        description: "A model deployed in a controlled environment cleared for regulated data.",
        deployment: "on_prem",
        sensitivityCeiling: "regulated",
        effort: "high",
        prerequisites: ["cleared hosting environment", "model ops capacity"],
        caveats: [],
      },
    ],
    advice: [],
  },
  {
    id: "pat.ai_extraction_automate",
    name: "Automate extraction with AI",
    description:
      "For structured-enough inputs, the AI extracts unattended; low-confidence items fall back to a human queue.",
    automationClass: "ai_automate",
    applicability: {
      taskClasses: ["data_extraction", "document_review"],
      minStructure: "mostly_rules",
      maxJudgment: "routine",
      actorKinds: ["human", "mixed"],
    },
    feasibilityWeights: { base: 0, structure: 0.6, judgment: 0.4 },
    variants: [
      {
        id: "internal_endpoint_automate",
        name: "Internal LLM endpoint, unattended",
        description: "Structured-output extraction on the internal endpoint with validation.",
        deployment: "internal_endpoint",
        sensitivityCeiling: "confidential",
        effort: "medium",
        prerequisites: ["confidence thresholds defined", "a human fallback queue"],
        caveats: ["measure accuracy on a sample before going unattended"],
      },
      {
        id: "on_prem_automate",
        name: "On-prem model, unattended",
        description: "The same, on a deployment cleared for regulated data.",
        deployment: "on_prem",
        sensitivityCeiling: "regulated",
        effort: "high",
        prerequisites: ["cleared hosting environment", "confidence thresholds defined", "a human fallback queue"],
        caveats: ["measure accuracy on a sample before going unattended"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.ai_drafting_assist",
    name: "AI-drafted, human-sent",
    description:
      "The AI produces the first draft of messages, documents, or summaries; the human edits and owns what goes out.",
    automationClass: "ai_assist",
    applicability: {
      taskClasses: [
        "communication_drafting",
        "document_generation",
        "summarization_reporting",
        "customer_interaction",
      ],
      actorKinds: ["human", "mixed"],
    },
    feasibilityWeights: { base: 0.4, structure: 0.35, judgment: 0.25 },
    variants: [
      {
        id: "external_llm_drafting",
        name: "External LLM service",
        description: "A commercial LLM or writing copilot.",
        deployment: "external_saas",
        sensitivityCeiling: "internal",
        effort: "low",
        prerequisites: [],
        caveats: ["data leaves the company boundary"],
      },
      {
        id: "internal_endpoint_drafting",
        name: "Internal LLM endpoint",
        description: "Drafting against the internal endpoint, optionally template-grounded.",
        deployment: "internal_endpoint",
        sensitivityCeiling: "confidential",
        effort: "low",
        prerequisites: ["access to the internal endpoint"],
        caveats: [],
      },
    ],
    advice: [],
  },
  {
    id: "pat.ai_classification_routing",
    name: "AI classification and routing",
    description:
      "The AI categorizes incoming items and routes them; anything below the confidence bar goes to a human lane.",
    automationClass: "ai_automate",
    applicability: {
      taskClasses: ["classification_routing"],
      minStructure: "guidelines_with_exceptions",
      maxJudgment: "routine",
      actorKinds: ["human", "mixed"],
    },
    feasibilityWeights: { base: 0, structure: 0.6, judgment: 0.4 },
    variants: [
      {
        id: "internal_endpoint_routing",
        name: "Internal LLM endpoint",
        description: "Closed-taxonomy classification on the internal endpoint.",
        deployment: "internal_endpoint",
        sensitivityCeiling: "confidential",
        effort: "medium",
        prerequisites: ["the category set written down", "a human fallback lane"],
        caveats: [],
      },
      {
        id: "on_prem_routing",
        name: "On-prem model",
        description: "The same, cleared for regulated data.",
        deployment: "on_prem",
        sensitivityCeiling: "regulated",
        effort: "high",
        prerequisites: ["cleared hosting environment", "a human fallback lane"],
        caveats: [],
      },
    ],
    advice: [],
  },
  {
    id: "pat.ai_qa_check",
    name: "AI quality pre-check",
    description:
      "An AI checks the work before (or instead of the first pass of) human review — catching the mechanical defects so humans review exceptions, and breaking rework loops closer to the source.",
    automationClass: "ai_assist",
    applicability: {
      taskClasses: ["verification_check", "document_review", "quality_inspection"],
      motifs: ["rework_loop"],
      actorKinds: ["human", "mixed"],
    },
    feasibilityWeights: { base: 0.4, structure: 0.35, judgment: 0.25 },
    variants: [
      {
        id: "internal_endpoint_qa",
        name: "Internal LLM endpoint",
        description: "Checklist-grounded AI review on the internal endpoint.",
        deployment: "internal_endpoint",
        sensitivityCeiling: "confidential",
        effort: "medium",
        prerequisites: ["the review checklist written down"],
        caveats: ["AI review supplements, not replaces, accountable sign-off"],
      },
      {
        id: "on_prem_qa",
        name: "On-prem model",
        description: "The same, cleared for regulated data.",
        deployment: "on_prem",
        sensitivityCeiling: "regulated",
        effort: "high",
        prerequisites: ["cleared hosting environment", "the review checklist written down"],
        caveats: ["AI review supplements, not replaces, accountable sign-off"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.ai_summarize_monitoring",
    name: "AI-summarized monitoring",
    description:
      "Instead of a human watching a feed, queue, or dashboard, an AI digests it on a schedule and surfaces only what needs attention.",
    automationClass: "ai_assist",
    applicability: {
      taskClasses: ["monitoring_watching", "summarization_reporting", "information_lookup"],
      actorKinds: ["human", "mixed"],
    },
    feasibilityWeights: { base: 0.4, structure: 0.35, judgment: 0.25 },
    variants: [
      {
        id: "external_llm_digest",
        name: "External LLM service",
        description: "Scheduled digests via a commercial LLM.",
        deployment: "external_saas",
        sensitivityCeiling: "internal",
        effort: "low",
        prerequisites: [],
        caveats: ["data leaves the company boundary"],
      },
      {
        id: "internal_endpoint_digest",
        name: "Internal LLM endpoint",
        description: "Scheduled digests on the internal endpoint.",
        deployment: "internal_endpoint",
        sensitivityCeiling: "confidential",
        effort: "medium",
        prerequisites: ["programmatic access to the watched source"],
        caveats: [],
      },
    ],
    advice: [],
  },
  {
    id: "pat.ai_agent_orchestration",
    name: "Agent-run chain",
    description:
      "A long unbroken run of same-actor manual steps that is mostly rule-like can be handed to an AI agent end-to-end, with checkpoints where a human confirms.",
    automationClass: "ai_automate",
    applicability: {
      motifs: ["long_manual_chain"],
      minStructure: "mostly_rules",
    },
    feasibilityWeights: { base: 0, structure: 0.6, judgment: 0.4 },
    variants: [
      {
        id: "internal_endpoint_agent",
        name: "Agent on the internal endpoint",
        description: "An agent harness executing the chain with human checkpoints.",
        deployment: "internal_endpoint",
        sensitivityCeiling: "confidential",
        effort: "high",
        prerequisites: [
          "each step's tools accessible programmatically",
          "checkpoint/rollback design",
          "a human owner monitoring outcomes",
        ],
        caveats: [
          "agents fail in ways scripts do not — start supervised and measure before trusting",
          "the biggest wins here often come from fixing the chain first (integrate, standardize) rather than automating it as-is",
        ],
      },
    ],
    advice: [],
  },

  // -------------------------------------------------------------------------
  // Knowledge-work patterns (apply even when the actor is already an AI agent)
  // -------------------------------------------------------------------------
  {
    id: "pat.automated_source_monitoring",
    name: "Automate source monitoring",
    description:
      "Recurring collection of papers, tools, or datasets is a standing query — feeds, alerts, and scheduled searches do the sweeping; humans (or an AI triager) only read what arrives.",
    automationClass: "rule_based_automation",
    applicability: {
      taskClasses: ["research_gathering", "monitoring_watching"],
      minFrequency: "weekly",
      actorKinds: ["human", "mixed"],
    },
    // Assist-style weights: it automates the sweep, not the reading.
    feasibilityWeights: { base: 0.4, structure: 0.35, judgment: 0.25 },
    variants: [
      {
        id: "feeds_and_alerts",
        name: "Feeds, alerts, and saved searches",
        description: "RSS/arXiv alerts, repo watches, and scheduled queries deliver candidates automatically.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "low",
        prerequisites: [],
        caveats: ["alert fatigue — curate the query set"],
      },
      {
        id: "ai_triaged_alerts",
        name: "AI-triaged alerts",
        description: "An LLM on the internal endpoint scores and summarizes incoming candidates.",
        deployment: "internal_endpoint",
        sensitivityCeiling: "confidential",
        effort: "medium",
        prerequisites: ["relevance criteria written down"],
        caveats: [],
      },
    ],
    advice: [],
  },
  {
    id: "pat.rag_knowledge_base",
    name: "Build a retrievable knowledge base",
    description:
      "Distilled knowledge that lives in documents gets re-derived every time it is needed — index it into a retrievable store that both humans and AI agents/harnesses query.",
    automationClass: "ai_assist",
    applicability: {
      taskClasses: ["knowledge_distillation", "information_lookup"],
      // No actorKinds gate: feeding an existing AI agent better knowledge
      // is precisely the point — this applies to ai_agent steps too.
    },
    feasibilityWeights: { base: 0.4, structure: 0.35, judgment: 0.25 },
    variants: [
      {
        id: "internal_rag",
        name: "RAG store on the internal endpoint",
        description: "Chunked, indexed corpus with retrieval feeding the internal LLM (and any agent harness).",
        deployment: "internal_endpoint",
        sensitivityCeiling: "confidential",
        effort: "high",
        prerequisites: ["the corpus collected in one place", "an owner for index freshness"],
        caveats: ["stale indexes quietly poison downstream answers — automate re-indexing"],
      },
      {
        id: "on_prem_rag",
        name: "On-prem RAG store",
        description: "The same, hosted in an environment cleared for regulated data.",
        deployment: "on_prem",
        sensitivityCeiling: "regulated",
        effort: "high",
        prerequisites: ["cleared hosting environment", "the corpus collected in one place"],
        caveats: ["stale indexes quietly poison downstream answers — automate re-indexing"],
      },
    ],
    advice: [],
  },
  {
    id: "pat.eval_harness_automation",
    name: "Automate the evaluation harness",
    description:
      "Verification done by hand every iteration is the bottleneck of any build-measure loop — automate the benchmark portion so every change is scored mechanically, and spend human review on a sample.",
    automationClass: "rule_based_automation",
    applicability: {
      taskClasses: ["evaluation_benchmarking"],
      motifs: ["rework_loop"],
      // No actorKinds gate: it applies regardless of who produces the work
      // being evaluated — including an AI agent.
    },
    // Assist-style weights: humans stay on the sampled portion.
    feasibilityWeights: { base: 0.4, structure: 0.35, judgment: 0.25 },
    variants: [
      {
        id: "benchmark_suite",
        name: "Scripted benchmark suite",
        description: "A fixed test/benchmark set run automatically on every iteration, with tracked scores.",
        deployment: "non_ai",
        sensitivityCeiling: "regulated",
        effort: "medium",
        prerequisites: ["ground truth or reference outputs for the benchmark set"],
        caveats: ["benchmarks drift from reality — refresh the set on a schedule"],
      },
      {
        id: "ai_graded_evals",
        name: "AI-graded evaluations",
        description: "LLM-as-judge grading on the internal endpoint for outputs without mechanical ground truth.",
        deployment: "internal_endpoint",
        sensitivityCeiling: "confidential",
        effort: "medium",
        prerequisites: ["grading rubric written down", "spot-check agreement between judge and humans"],
        caveats: ["judge bias is real — calibrate against human labels periodically"],
      },
    ],
    advice: [],
  },
];
