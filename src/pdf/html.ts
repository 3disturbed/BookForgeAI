import type { z } from 'zod';
import type { PageModelSchema } from '../domain/schemas.js';
import { blobExists, getBlob } from '../storage/blobs.js';

export type PageModel = z.infer<typeof PageModelSchema>;
type Page = PageModel['pages'][number];
type Block = Page['blocks'][number];

/** Trim sizes in millimetres. */
const TRIM: Record<PageModel['pageSize'], { w: number; h: number }> = {
  a4: { w: 210, h: 297 },
  letter: { w: 216, h: 279 },
  digest: { w: 140, h: 216 }, // 5.5in x 8.5in
};

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const ptToMm = (pt: number): number => Math.round((pt / 72) * 25.4 * 100) / 100;

export interface HtmlResult {
  html: string;
  missingImages: string[];
}

/**
 * Renders the page model to print-ready HTML.
 *
 * Structural pages — cover, front matter, plates — keep their own leaf. Body
 * content is allowed to flow, so the browser paginates prose the way a
 * typesetter would instead of honouring the model's estimated page breaks and
 * leaving pages half empty. Chapter openings still force a break.
 */
export async function pageModelToHtml(model: PageModel): Promise<HtmlResult> {
  const missingImages: string[] = [];
  const images = await loadImages(model, missingImages);
  const trim = TRIM[model.pageSize] ?? TRIM.digest;

  const pages = [...model.pages].sort((a, b) => a.index - b.index);
  const sections: string[] = [];

  let flowing: string[] = [];
  const flushFlow = (): void => {
    if (!flowing.length) return;
    sections.push(`<section class="flow">${flowing.join('\n')}</section>`);
    flowing = [];
  };

  for (const page of pages) {
    const body = page.blocks.map((b) => renderBlock(b, images)).join('\n');

    if (page.kind === 'body') {
      // A body page that opens with a level-1/2 heading starts a new chapter.
      const opensChapter = page.blocks[0]?.type === 'heading' && (page.blocks[0]?.level ?? 1) <= 2;
      flowing.push(`<div class="chunk${opensChapter ? ' chapter-open' : ''}">${body}</div>`);
      continue;
    }

    flushFlow();
    sections.push(`<section class="leaf ${page.kind}">${body}</section>`);
  }
  flushFlow();

  return { html: document(sections.join('\n'), trim, model), missingImages };
}

async function loadImages(model: PageModel, missing: string[]): Promise<Map<string, string>> {
  const keys = new Set<string>();
  for (const page of model.pages) {
    for (const block of page.blocks) {
      if (block.type === 'image' && block.storageKey) keys.add(block.storageKey);
    }
  }

  const out = new Map<string, string>();
  await Promise.all(
    [...keys].map(async (key) => {
      if (!(await blobExists(key))) {
        missing.push(key);
        return;
      }
      try {
        // The page is loaded from a string, so images must be inlined.
        out.set(key, `data:image/png;base64,${(await getBlob(key)).toString('base64')}`);
      } catch {
        missing.push(key);
      }
    }),
  );
  return out;
}

function renderBlock(block: Block, images: Map<string, string>): string {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(block.level ?? 1, 1), 6);
      return `<h${level}>${escape(block.text)}</h${level}>`;
    }
    case 'text':
      return escape(block.text)
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
        .join('\n');

    case 'image': {
      const src = block.storageKey ? images.get(block.storageKey) : undefined;
      return src
        ? `<figure><img src="${src}" alt=""></figure>`
        : `<figure class="missing"><span>illustration unavailable</span></figure>`;
    }
    case 'caption':
      return `<p class="caption">${escape(block.text)}</p>`;
    case 'footnote':
      return `<p class="footnote">${escape(block.text)}</p>`;
    case 'decoration':
      return `<p class="ornament">&#10087;</p>`;
    case 'table': {
      const rows = block.rows ?? [];
      if (!rows.length) return '';
      const [head, ...body] = rows;
      return [
        '<table>',
        `<thead><tr>${(head ?? []).map((c) => `<th>${escape(c)}</th>`).join('')}</tr></thead>`,
        '<tbody>',
        ...body.map((r) => `<tr>${r.map((c) => `<td>${escape(c)}</td>`).join('')}</tr>`),
        '</tbody></table>',
      ].join('\n');
    }
    // Page numbers come from the @page rule, not from model blocks.
    case 'page_number':
      return '';
    default:
      return '';
  }
}

function document(body: string, trim: { w: number; h: number }, model: PageModel): string {
  const m = model.margins;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Edition</title>
<style>
  @page {
    size: ${trim.w}mm ${trim.h}mm;
    margin: ${ptToMm(m.top)}mm ${ptToMm(m.outer)}mm ${ptToMm(m.bottom)}mm ${ptToMm(m.inner)}mm;
  }
  /* The cover and plates carry no running head or folio. */
  @page :first { margin: 0; }

  * { box-sizing: border-box; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    margin: 0;
    font: 10.5pt/1.58 "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif;
    color: #111;
    hyphens: auto;
    -webkit-hyphens: auto;
    orphans: 2;
    widows: 2;
  }

  section.leaf { break-after: page; }
  section.leaf:last-child { break-after: auto; }
  .chunk.chapter-open { break-before: page; }
  .chunk:first-child.chapter-open { break-before: auto; }

  h1, h2, h3, h4, h5, h6 {
    font-weight: 600; line-height: 1.2; break-after: avoid; margin: 0 0 .6em;
  }
  h1 { font-size: 22pt; text-align: center; margin-top: 0; letter-spacing: .01em; }
  h2 { font-size: 15pt; text-align: center; margin: 0 0 1.6em; }
  h3 { font-size: 11.5pt; }

  p { margin: 0; text-align: justify; text-indent: 1.2em; }
  p + p { margin-top: 0; }
  /* No indent on the first paragraph of a section — standard book setting. */
  h1 + p, h2 + p, h3 + p, .ornament + p, figure + p, .chunk > p:first-child { text-indent: 0; }

  /* Opening line of a chapter set in small caps. */
  .chapter-open h2 + p::first-line { font-variant-caps: small-caps; letter-spacing: .04em; }

  .ornament { text-align: center; text-indent: 0; margin: 1.3em 0; color: #777; font-size: 9pt; }
  .caption {
    text-align: center; text-indent: 0; font-style: italic;
    font-size: 8.5pt; color: #444; margin: .5em 0 1em;
  }
  .footnote { font-size: 8pt; text-indent: 0; color: #333; margin: .4em 0; }

  figure { margin: 1.2em 0; text-align: center; break-inside: avoid; }
  figure img { max-width: 100%; max-height: 78vh; }
  figure.missing {
    border: 1px dashed #bbb; padding: 3em 1em; color: #999;
    font-style: italic; font-size: 8.5pt;
  }

  table { width: 100%; border-collapse: collapse; font-size: 9pt; margin: 1em 0; break-inside: avoid; }
  th, td { border-bottom: .5pt solid #ccc; padding: .35em .5em; text-align: left; }
  th { font-weight: 600; }

  /* Cover fills the trim; plates centre their image. */
  section.cover {
    display: flex; flex-direction: column; justify-content: center; align-items: center;
    height: ${trim.h}mm; padding: 0 18mm; text-align: center;
  }
  section.cover h1 { font-size: 30pt; }
  section.front_matter { text-align: center; padding-top: 25%; }
  section.front_matter p { text-align: center; text-indent: 0; }
  section.plate {
    display: flex; flex-direction: column; justify-content: center;
    height: 100%;
  }
  section.blank { break-after: page; }
</style></head>
<body>
${body}
</body></html>`;
}
