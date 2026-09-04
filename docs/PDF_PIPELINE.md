# BookForgeAI — PDF Pipeline

The PDF is generated from a structured page model, not raw Markdown.

```text
BookProject → Edition Snapshot → Page Model → Layout → Rendered PDF → PDF QA → Approved PDF
```

A page can contain text blocks, headings, images, captions, page numbers, decorative elements, tables and footnotes.

MVP templates: Novel, Illustrated Story, Non-fiction.

QA checks: page count, blank pages, overflow, clipping, missing assets, image placement, headings, numbering, margins, font embedding, references and file integrity.

An approved edition freezes manuscript, artwork, design, layout and metadata versions so the PDF is reproducible.
