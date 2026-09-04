# BookForgeAI — Software Design Document

## 1. Purpose

BookForgeAI is an agentic publishing system that takes a raw idea and produces a finished illustrated book as a PDF.

## 2. Goals

- Turn an idea into a complete book.
- Use specialised agents for research, structure, writing, illustration and editorial QA.
- Pre-design recurring characters, objects and locations as a Visual Canon.
- Maintain continuity across the entire project.
- Provide human approval gates.
- Produce a publication-ready PDF.
- Charge $100 USD to publish a completed book.

## 3. User Journey

```text
Create Book → Idea → Research/Map → Visual Canon → Architecture → Design → Outline
→ Write → Illustrate → Critique → Diagnose → Rewrite → Edit → Layout → Proof
→ $100 Publish → Final PDF
```

## 4. Agent Pipeline

Discover → Research → Map → Visual Canon → Asset Designer → Architect → Design → Outline → Author → Scene Composer → Image Director → Image Generator → Visual QA → Critics → Diagnosis → Rewrite → Editor → Copy Editor → Continuity → Layout → Proof → Publisher.

## 5. Visual Canon

Before normal illustration begins, the system identifies recurring characters, creatures, animals, objects, vehicles, buildings, locations, clothing and props. Each receives a canonical specification and reference artwork. Approved assets can be locked. Changes create a new version.

## 6. Human approval gates

Default gates: brief, architecture, visual canon, outline, final manuscript, key illustrations, final PDF, publication payment.

## 7. Revision loop

```text
MANUSCRIPT → CRITICS → DIAGNOSIS → REVISION TASKS → REWRITE → CRITICS
                                      ↓
                                  PASS? → EDIT
```

Maximum default revision cycles: 3.

## 8. Technical architecture

Recommended MVP:

- Next.js + TypeScript frontend
- Node.js + TypeScript backend
- PostgreSQL
- Redis + BullMQ
- S3-compatible object storage
- OpenAI API
- Stripe
- Server-side PDF renderer

## 9. Agent reliability

Every job records job ID, project ID, agent, input versions, prompt version, model, output versions, status, usage, retries, timestamps and errors. Output is schema-validated before commit.

## 10. Publication state

```text
DRAFT → READY_FOR_PUBLISH → PAYMENT_REQUIRED → PAID → PUBLISHING → PUBLISHED
```

A published edition is immutable; corrections create a new edition.

## 11. Publish acceptance criteria

- Required content exists.
- No unresolved critical editorial issues.
- Required artwork exists and passes visual QA.
- Continuity QA passes.
- PDF renders and proof passes.
- User approves final edition.
- $100 payment is confirmed.

## 12. Cost accounting

Track text usage, image generations, image/reference usage, storage, compute, payment fees and other costs. Calculate contribution margin separately from the fixed $100 publishing charge.
