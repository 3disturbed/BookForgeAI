# BookForgeAI

**Idea → Forge → Review → Publish**

BookForgeAI is an agentic book-production platform that turns a user's idea into a structured, illustrated, publication-ready book.

## Core pipeline

Discover → Research → Map → Visual Canon → Architect → Design → Outline → Author → Illustrate → Verify → Criticise → Diagnose → Rewrite → Edit → Layout → Proof → Publish

## Core product

- Book brief
- Research library
- Knowledge/story map
- Character and item visual canon
- Book architecture
- Detailed outline
- Manuscript
- Illustrations and cover
- Editorial revision loop
- Publication-ready PDF

## AI

Designed for OpenAI APIs. Text/reasoning and image models are configurable by environment variables. Illustration generation uses GPT-Image-2.

## Publishing

**$100 USD per completed book publication.**

Default configuration:

`BOOK_PUBLISHING_PRICE_USD=100`

This is the BookForgeAI publishing charge, not a claim about underlying AI, printing, or payment-processing costs. Internal usage is metered separately for margin analysis.

## MVP

1. Project creation
2. Idea / Research / Map agents
3. Visual Canon and asset reference generation
4. Architecture / Design / Outline
5. Chapter Author
6. Image Director + GPT-Image-2
7. Critic / Diagnosis / Rewrite loop
8. Editing
9. PDF layout and proofing
10. $100 publishing checkout
11. Final PDF delivery

## Repository

```text
BookForgeAI/
├── README.md
├── docs/
│   ├── SDD.md
│   ├── ARCHITECTURE.md
│   ├── AGENTS.md
│   ├── VISUAL_CANON.md
│   ├── BOOK_PIPELINE.md
│   ├── BILLING.md
│   ├── PDF_PIPELINE.md
│   ├── DATA_MODEL.md
│   ├── SECURITY.md
│   └── ROADMAP.md
├── schemas/
│   ├── book-project.schema.json
│   ├── visual-asset.schema.json
│   └── agent-job.schema.json
├── config/example.env
└── prompts/README.md
```

The Book Project—not the manuscript—is the source of truth. Canonical facts, characters, items, locations, timelines, style rules and approved artwork are structured and versioned.
