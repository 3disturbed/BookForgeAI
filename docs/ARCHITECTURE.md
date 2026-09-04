# BookForgeAI — Architecture

```text
WEB UI
  ↓
API SERVER
  ↓
ORCHESTRATOR
  ├── PostgreSQL (canonical project state)
  ├── Redis/BullMQ (agent jobs)
  └── S3 (images, PDFs, files)
       ↓
Research | Writing | Visual | Critic | Layout agents
       ↓
OpenAI APIs / GPT-Image-2
```

Agents communicate through structured jobs and artifacts, not uncontrolled agent-to-agent conversation.

## Core events

PROJECT_CREATED, BRIEF_CREATED, RESEARCH_COMPLETE, MAP_COMPLETE, VISUAL_CANON_CREATED, VISUAL_ASSET_APPROVED, ARCHITECTURE_APPROVED, OUTLINE_APPROVED, CHAPTER_DRAFTED, ILLUSTRATION_GENERATED, ILLUSTRATION_APPROVED, CRITIQUE_COMPLETE, REVISION_REQUIRED, REVISION_COMPLETE, MANUSCRIPT_APPROVED, PDF_RENDERED, PDF_PROOFED, PAYMENT_CONFIRMED, PUBLICATION_STARTED, PUBLICATION_COMPLETE.

## Storage

```text
/projects/{projectId}/
  manuscript/
  research/
  assets/
  illustrations/
  covers/
  renders/
  exports/
```

Jobs and payment webhooks must be idempotent.
