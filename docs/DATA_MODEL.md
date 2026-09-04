# BookForgeAI — Data Model

Core entities:

User, Project, BookBrief, ResearchSource, KnowledgeMap, VisualAsset, VisualAssetVersion, BookArchitecture, DesignSpec, Outline, Chapter, ChapterVersion, Illustration, IllustrationVersion, Critique, RevisionTask, Edition, Payment, Publication, AgentJob.

Public IDs should use UUIDs. Published editions reference immutable artifact versions.

Large binary assets belong in object storage; database records contain metadata and references.
