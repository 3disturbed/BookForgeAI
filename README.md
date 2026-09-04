# BookForgeAI

**Idea → Forge → Review → Publish**

BookForgeAI is an agentic book-production platform that turns a user's idea into a
structured, illustrated, publication-ready book.

This repository contains the design specification (`docs/`, `schemas/`) and a
working Phase 1 MVP: a Node.js + TypeScript service that runs the full 22-agent
pipeline against the OpenAI API and serves an HTML5 SaaS console.

## Quick start

```bash
npm install
cp config/example.env .env      # then set OPENAI_API_KEY
npm run build
npm start
```

Open <http://localhost:3000>, sign in with an email, and start a book.

Enable the secret guard once per clone — it refuses any commit that would stage
an env file or a key-shaped value:

```bash
git config core.hooksPath .githooks
```

The MVP runs with **no external infrastructure**: SQLite on disk, blobs on the
local filesystem, and an in-process job queue. Postgres, Redis and S3 are opt-in
by setting their variables — the seams for the targets in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Your API key goes in `.env`, never in `config/example.env` — that template is
tracked by git and every value in it must stay empty. There is no key-entry field
in the UI by design: `SECURITY.md` keeps OpenAI and payment keys server-side, and
`/api/config` reports only whether a key is present, never its value.

Only `OPENAI_API_KEY` is required. Without Stripe keys the service uses a
development checkout stand-in, which is refused when `NODE_ENV=production`.

### Scripts

| Command | Purpose |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the service |
| `npm run dev` | Build, then run with `--watch` |
| `npm test` | Build and run the full test suite |
| `npm run typecheck` | Type-check without emitting |

## Core pipeline

Discover → Research → Map → Visual Canon → Architect → Design → Outline → Author
→ Illustrate → Verify → Criticise → Diagnose → Rewrite → Edit → Layout → Proof →
Publish

The 18 stages and their dependencies live in
[`src/domain/pipeline.ts`](src/domain/pipeline.ts); the 22 agents and their
read/write contracts in [`src/domain/agents.ts`](src/domain/agents.ts).

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

Designed for OpenAI APIs. Text/reasoning and image models are configurable by
environment variable. Illustration generation uses GPT-Image-2.

Agents declare a **capability** (`text`, `reasoning`, `image`) and the model
router resolves it from configuration — no model name is hard-coded in business
logic. Every agent's output is parsed against a schema before it is committed as
an artifact; output that fails validation is retried with the errors fed back,
then rejected.

## Publishing

**$100 USD per completed book publication.**

Default configuration:

`BOOK_PUBLISHING_PRICE_USD=100`

This is the BookForgeAI publishing charge, not a claim about underlying AI,
printing, or payment-processing costs. Internal usage is metered separately for
margin analysis.

The checkout session is created server-side from configuration; a client-supplied
amount is never trusted. In production, only a signature-verified Stripe webhook
unlocks publication.

## How it works

**Artifacts, not conversations.** Agents read and write versioned, immutable
artifacts. Canonical facts live in structured project data, never in hidden
conversational memory. An edition pins exact artifact versions, so its PDF is
reproducible.

**Answering the agents' questions.** Discover ends its brief with the decisions
it could not make from the idea: how pointed a critique should be, which runic
row to reference, how much practical detail a craft section needs. Those
questions are put to the author at the brief gate, and the answers travel with
every later agent, which is told to follow them and not reopen them. A question
the author would rather not settle can be delegated explicitly, so the agents
decide it on the record instead of by default.

**Human approval gates.** Eight gates — brief, architecture, visual canon,
outline, manuscript, key illustrations, final PDF, publication payment — hold the
pipeline until a person approves. Approving the visual canon locks its assets; a
later change needs a new version and a fresh approval.

**The revision loop.** Five independent critics (literary, structural, audience,
factual, continuity) review every chapter. Diagnosis merges their findings into
an ordered revision plan, the Rewriter applies it, and the critics read it again
— bounded by `MAX_REVISION_CYCLES`. Exhausting the budget with critical issues
still open escalates to a human rather than shipping silently.

**Visual continuity.** Recurring characters, objects and locations get a
canonical specification and approved reference art before ordinary illustration
begins. Reference images are passed to the image model as inputs, and Visual QA
checks every render against the canon. Consistency is probabilistic; the system
reduces drift, it does not eliminate it.

**The PDF.** Layout produces a structured page model — pages, blocks, images,
captions — which a headless Chromium renderer turns into a PDF through print
CSS: justified serif with hyphenation, orphan and widow control, small-caps
chapter openings, real tables. Structural pages (cover, front matter, plates)
keep their own leaf; body prose is allowed to flow, so pages fill the way a
typesetter would set them. Rendering happens inside the Proof job, so it is
awaited, retried with the job, and QA'd against the document that actually
exists. PDFKit remains a fallback for environments without a browser
(`PDF_RENDERER=pdfkit`). It is never generated from raw Markdown.

**Cost control.** Because agents declare a *capability* rather than a model,
spend is a configuration decision. Mechanical agents — asset designer, scene
composer, image director, copy editor, publisher — route to `OPENAI_LIGHT_MODEL`;
reasoning effort is set per tier; image fidelity is set per project; and each
critic persona reads only the artifacts its lens can act on rather than all five
receiving the same context. On a live run this moved over half of all calls off
the frontier model.

**Recovering from failure.** Network faults and rate limits are the common case,
so a failed job is requeued behind an exponential backoff rather than
immediately, which stops a brief outage from burning the whole retry budget in
a second. Once the budget is spent the job is left failed, and because the
scheduler will not step past a required agent, the run stops. Retrying from the
console or `POST /projects/:id/retry` returns those jobs to the queue with a
fresh budget, for one stage or the whole project. Work already completed is kept
and never repeated. Jobs left mid-flight by a restart are requeued on startup.

**Degrading rather than failing.** Model safety systems refuse innocuous
subjects — a sloyd carving knife reads as a weapon. A refusal is a permanent
answer for that prompt, so it is never retried, and agents whose output is
enrichment rather than the book itself are marked optional: the scheduler steps
past their failures and the console reports the stage as degraded. A refused
reference image costs an asset its artwork, not its bible.

## Repository

```text
BookForgeAI/
├── src/
│   ├── domain/      pipeline graph, agent registry, schemas, states, costs
│   ├── agents/      the READ → REASON → VALIDATE → WRITE → REPORT runner
│   ├── queue/       stage scheduler, revision loop, in-process worker
│   ├── ai/          OpenAI client, model routing, prompt loader
│   ├── store/       SQLite schema and repositories
│   ├── storage/     blob storage with short-lived signed URLs
│   ├── pdf/         page-model renderer
│   ├── billing/     Stripe checkout and webhook verification
│   ├── http/        REST API and session auth
│   ├── tests/       unit tests and a full-pipeline integration test
│   └── server.js    entry point
├── public/          HTML5 SaaS console (no build step)
├── prompts/         the prompt library, versioned independently of code
├── schemas/         published JSON Schema contracts
├── docs/            SDD, architecture, agents, pipeline, billing, security…
└── config/example.env
```

The Book Project—not the manuscript—is the source of truth. Canonical facts,
characters, items, locations, timelines, style rules and approved artwork are
structured and versioned.

## Testing

```bash
npm test
```

The suite includes a full-pipeline integration test that runs all 22 agents, the
approval gates, the revision loop, illustration generation, PDF rendering and the
$100 publication flow against a stubbed model API — no network access or API key
required.

## Status

Phase 1 (MVP) per [docs/ROADMAP.md](docs/ROADMAP.md) is implemented. Phases 2–4 —
cover generation, EPUB/DOCX, version history, audiobooks, translation,
collaboration, series continuity — are not.

Known limits of the MVP:

- The in-process queue and SQLite suit a single node. Redis/BullMQ and Postgres
  are the documented path to scale out.
- Research citations are model-supplied and unverified; treat `confidence: low`
  sources accordingly.
- A refused image is not always refused on retry, so a degraded stage is worth
  retrying once before accepting the gap.
- Chromium adds roughly 300MB to `npm install`. Set `PDF_RENDERER=pdfkit` to
  skip it, at the cost of typography.
- The editorial loop re-reads every chapter each round, so a book that needs all
  three cycles pays for three full critique passes.
