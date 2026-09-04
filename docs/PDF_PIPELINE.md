# BookForgeAI — PDF Pipeline

The PDF is generated from a structured page model, not raw Markdown. Layout
places body prose by reference to clean-manuscript blocks; the text is filled
in from the manuscript when the page model is committed, so no paragraph the
copy editor approved is retyped by a model on its way to the page.

```text
BookProject → Edition Snapshot → Page Model → Layout → Rendered PDF → PDF QA → Approved PDF
```

A page can contain text blocks, headings, images, captions, page numbers, decorative elements, tables and footnotes.

MVP templates: Novel, Illustrated Story, Non-fiction.

QA checks: page count, blank pages, overflow, clipping, missing assets, image placement, headings, numbering, margins, font embedding, references and file integrity.

An approved edition freezes manuscript, artwork, design, layout and metadata versions so the PDF is reproducible.
