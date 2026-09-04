import PDFDocument from 'pdfkit';
import { getBlob, blobExists } from '../storage/blobs.js';
import type { PageModel, RenderResult } from './render.js';

type Page = PageModel['pages'][number];
type Block = Page['blocks'][number];

/** Page sizes in points. */
const PAGE_SIZES: Record<PageModel['pageSize'], [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
  digest: [396, 612], // 5.5in x 8.5in
};

/**
 * Fallback renderer. Draws the page model directly, honouring its page
 * boundaries exactly. Used when Chromium is unavailable; the Puppeteer renderer
 * produces better typography and paginates prose properly.
 */
export async function renderWithPdfKit(model: PageModel): Promise<RenderResult> {
  const size = PAGE_SIZES[model.pageSize] ?? PAGE_SIZES.digest;
  const missingImages: string[] = [];

  const doc = new PDFDocument({
    size,
    autoFirstPage: false,
    margins: {
      top: model.margins.top,
      bottom: model.margins.bottom,
      left: model.margins.inner,
      right: model.margins.outer,
    },
    info: { Title: titleOf(model), Producer: 'BookForgeAI' },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolveDone) => doc.on('end', () => resolveDone()));

  const pages = [...model.pages].sort((a, b) => a.index - b.index);

  // Images are fetched up front: PDFKit's document stream is synchronous once
  // writing starts, so awaiting mid-render would interleave pages.
  const images = await loadImages(pages, missingImages);

  let pageCount = 0;
  for (const page of pages) {
    doc.addPage();
    pageCount++;
    renderPage(doc, page, images, model);
  }

  if (pageCount === 0) {
    doc.addPage();
    pageCount = 1;
    doc.fontSize(12).text('This edition has no pages.', { align: 'center' });
  }

  doc.end();
  await done;

  return { pdf: Buffer.concat(chunks), pageCount, missingImages, engine: 'pdfkit' };
}

function titleOf(model: PageModel): string {
  for (const page of model.pages) {
    for (const block of page.blocks) {
      if (block.type === 'heading' && block.text) return block.text;
    }
  }
  return 'Untitled';
}

async function loadImages(pages: Page[], missing: string[]): Promise<Map<string, Buffer>> {
  const keys = new Set<string>();
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.type === 'image' && block.storageKey) keys.add(block.storageKey);
    }
  }

  const images = new Map<string, Buffer>();
  await Promise.all(
    [...keys].map(async (key) => {
      if (!(await blobExists(key))) {
        missing.push(key);
        return;
      }
      try {
        images.set(key, await getBlob(key));
      } catch {
        missing.push(key);
      }
    }),
  );
  return images;
}

function renderPage(
  doc: PDFKit.PDFDocument,
  page: Page,
  images: Map<string, Buffer>,
  model: PageModel,
): void {
  const contentWidth = doc.page.width - model.margins.inner - model.margins.outer;

  for (const block of page.blocks) {
    switch (block.type) {
      case 'heading':
        renderHeading(doc, block, page.kind);
        break;

      case 'text':
        doc.font('Times-Roman').fontSize(11).fillColor('#000');
        doc.text(block.text, { align: page.kind === 'front_matter' ? 'center' : 'justify' });
        doc.moveDown(0.4);
        break;

      case 'image':
        renderImage(doc, block, images, contentWidth);
        break;

      case 'caption':
        doc.font('Times-Italic').fontSize(9).fillColor('#444');
        doc.text(block.text, { align: 'center' });
        doc.fillColor('#000').moveDown(0.6);
        break;

      case 'table':
        renderTable(doc, block, contentWidth);
        break;

      case 'footnote':
        doc.font('Times-Roman').fontSize(8).fillColor('#333');
        doc.text(block.text);
        doc.fillColor('#000').moveDown(0.3);
        break;

      case 'decoration':
        renderDecoration(doc, contentWidth);
        break;

      case 'page_number':
        renderPageNumber(doc, block.text || String(page.index), model);
        break;
    }
  }
}

function renderHeading(doc: PDFKit.PDFDocument, block: Block, pageKind: Page['kind']): void {
  const level = block.level ?? 1;
  const sizes: Record<number, number> = { 1: 24, 2: 18, 3: 14, 4: 12, 5: 11, 6: 10 };

  if (pageKind === 'cover') {
    doc.moveDown(4);
    doc.font('Times-Bold').fontSize(30).fillColor('#000');
    doc.text(block.text, { align: 'center' });
    doc.moveDown(1);
    return;
  }

  doc.font('Times-Bold').fontSize(sizes[level] ?? 12).fillColor('#000');
  doc.text(block.text, { align: level === 1 ? 'center' : 'left' });
  doc.moveDown(level === 1 ? 1 : 0.5);
}

function renderImage(
  doc: PDFKit.PDFDocument,
  block: Block,
  images: Map<string, Buffer>,
  contentWidth: number,
): void {
  const data = block.storageKey ? images.get(block.storageKey) : undefined;

  if (!data) {
    // A missing asset is drawn as an explicit placeholder so Proof sees it
    // rather than the page silently losing its illustration.
    const height = Math.min(contentWidth, doc.page.height / 3);
    const top = doc.y;
    doc.save().rect(doc.x, top, contentWidth, height).stroke('#bbb');
    doc.font('Times-Italic').fontSize(9).fillColor('#999');
    doc.text('[illustration unavailable]', doc.x, top + height / 2 - 6, {
      width: contentWidth,
      align: 'center',
    });
    doc.restore().fillColor('#000');
    doc.y = top + height + 8;
    return;
  }

  try {
    doc.image(data, { fit: [contentWidth, doc.page.height / 2], align: 'center' });
    doc.moveDown(0.5);
  } catch {
    doc.font('Times-Italic').fontSize(9).fillColor('#999');
    doc.text('[illustration could not be embedded]', { align: 'center' });
    doc.fillColor('#000').moveDown(0.5);
  }
}

function renderTable(doc: PDFKit.PDFDocument, block: Block, contentWidth: number): void {
  const rows = block.rows ?? [];
  if (rows.length === 0) return;

  const columns = Math.max(...rows.map((r) => r.length));
  const columnWidth = contentWidth / Math.max(columns, 1);

  doc.fontSize(9);
  for (const [rowIndex, row] of rows.entries()) {
    const top = doc.y;
    doc.font(rowIndex === 0 ? 'Times-Bold' : 'Times-Roman');
    let maxHeight = 0;

    for (const [colIndex, cell] of row.entries()) {
      const x = doc.page.margins.left + colIndex * columnWidth;
      const height = doc.heightOfString(cell, { width: columnWidth - 6 });
      maxHeight = Math.max(maxHeight, height);
      doc.text(cell, x + 3, top, { width: columnWidth - 6 });
    }
    doc.y = top + maxHeight + 4;
  }
  doc.moveDown(0.5);
}

function renderDecoration(doc: PDFKit.PDFDocument, contentWidth: number): void {
  doc.moveDown(0.4);
  const y = doc.y;
  const centre = doc.page.margins.left + contentWidth / 2;
  doc.save().fontSize(10).fillColor('#666');
  doc.text('* * *', doc.page.margins.left, y, { width: contentWidth, align: 'center' });
  doc.restore().fillColor('#000');
  doc.y = y + 16;
  void centre;
}

function renderPageNumber(doc: PDFKit.PDFDocument, label: string, model: PageModel): void {
  const y = doc.page.height - model.margins.bottom + 8;
  doc.save().font('Times-Roman').fontSize(9).fillColor('#555');
  doc.text(label, model.margins.inner, y, {
    width: doc.page.width - model.margins.inner - model.margins.outer,
    align: 'center',
    lineBreak: false,
  });
  doc.restore().fillColor('#000');
}
