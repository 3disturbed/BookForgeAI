import type { z } from 'zod';
import type { PageModelSchema } from '../domain/schemas.js';
import { pageModelToHtml } from './html.js';

export type PageModel = z.infer<typeof PageModelSchema>;

export interface RenderResult {
  pdf: Buffer;
  pageCount: number;
  /** Image keys the page model referenced but storage could not supply. */
  missingImages: string[];
  /** Which engine produced this PDF, for the proof report and job log. */
  engine: 'puppeteer' | 'pdfkit';
}

/**
 * PDF_PIPELINE.md: the PDF is rendered from the structured page model, never
 * from raw markdown.
 *
 * Chromium is the primary engine — it gives real book typography (justification
 * with hyphenation, orphan and widow control, small caps) and paginates prose
 * properly rather than trusting the model's estimated page breaks. PDFKit
 * remains as a fallback for environments without a browser.
 */
export async function renderPdf(model: PageModel): Promise<RenderResult> {
  const preferred = process.env.PDF_RENDERER ?? 'puppeteer';

  if (preferred !== 'pdfkit') {
    try {
      return await renderWithPuppeteer(model);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[bookforge] Chromium render failed, falling back to PDFKit: ${reason}`);
    }
  }

  const { renderWithPdfKit } = await import('./pdfkit-renderer.js');
  return renderWithPdfKit(model);
}

async function renderWithPuppeteer(model: PageModel): Promise<RenderResult> {
  // Imported lazily so the service still starts where Chromium is absent.
  const puppeteer = (await import('puppeteer')).default;
  const { html, missingImages } = await pageModelToHtml(model);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });

  try {
    const page = await browser.newPage();
    // The document inlines its images, so nothing is fetched over the network.
    await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
    await page.emulateMediaType('print');

    const pdf = Buffer.from(
      await page.pdf({
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        timeout: 60_000,
      }),
    );

    return { pdf, pageCount: countPages(pdf), missingImages, engine: 'puppeteer' };
  } finally {
    await browser.close();
  }
}

/**
 * Page count read back from the produced file rather than from the model's
 * estimate, so the proof report reflects the document that actually exists.
 */
function countPages(pdf: Buffer): number {
  const matches = pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches?.length ?? 1;
}
