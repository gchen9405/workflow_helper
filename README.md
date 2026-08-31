# workflow_helper

Turns a description of a business workflow — a flowchart image or free text
— into a ranked, explainable list of improvement opportunities (AI and
non-AI), written up as a human-readable report.

Four sibling components, each self-contained with its own README, tests,
and CLI:

| Folder           | Does                                                                          | In → out |
|------------------|-------------------------------------------------------------------------------|----------|
| `pipeline/`      | **Start here.** The end-to-end entry point: runs the three stages in one call and returns the report (plus every stage's result). Designed for embedding in a website. | image / text → report |
| `preprocessor/`  | Extracts a validated workflow graph, asking clarifying questions when the input is thin. | image / text → schema JSON |
| `recommender/`   | Matches the schema against a pattern catalog; scores and ranks opportunities.  | schema → recommendations JSON |
| `narrator/`      | Renders the recommendations as a layered Markdown report with a model-written summary. | recommendations → report |

```sh
cd pipeline && npm run setup && cp .env.example .env    # fill in LLM_ENDPOINT / LLM_MODEL
npx tsx src/cli.ts --text "A new order comes in, then …"
```

No terminal needed for day-to-day use: drag files into `pipeline/inbox/`
and double-click `Make improvement reports` — one report per file lands in
`pipeline/reports/`.

All four talk to one internal OpenAI-compatible endpoint, configured once
in a `.env` at this root (or in the environment).
