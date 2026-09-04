import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let html: typeof import('../pdf/html.js');
let render: typeof import('../pdf/render.js');
let blobs: typeof import('../storage/blobs.js');
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'bookforge-pdf-'));
  Object.assign(process.env, {
    NODE_ENV: 'test', DATA_DIR: dataDir, DATABASE_URL: '',
    APP_BASE_URL: 'http://localhost:3000',
  });
  html = await import('../pdf/html.js');
  render = await import('../pdf/render.js');
  blobs = await import('../storage/blobs.js');
});

after(() => rmSync(dataDir, { recursive: true, force: true }));

const base = {
  template: 'non_fiction' as const,
  pageSize: 'digest' as const,
  margins: { top: 54, bottom: 54, inner: 54, outer: 54 },
};

test('structural pages get their own leaf, body prose flows', async () => {
  const { html: doc } = await html.pageModelToHtml({
    ...base,
    pages: [
      { index: 1, kind: 'cover', blocks: [{ type: 'heading', text: 'Title', level: 1 }] },
      { index: 2, kind: 'body', blocks: [{ type: 'text', text: 'One.' }] },
      { index: 3, kind: 'body', blocks: [{ type: 'text', text: 'Two.' }] },
      { index: 4, kind: 'plate', blocks: [{ type: 'caption', text: 'A plate.' }] },
    ],
  });

  // Cover and plate are forced leaves; the two body pages share one flow.
  assert.equal((doc.match(/section class="leaf/g) ?? []).length, 2);
  assert.equal((doc.match(/section class="flow"/g) ?? []).length, 1);
  assert.ok(doc.includes('break-after: page'), 'leaves force a page break');
});

test('a chapter opening forces a break, a continuation does not', async () => {
  const { html: doc } = await html.pageModelToHtml({
    ...base,
    pages: [
      { index: 1, kind: 'body', blocks: [
        { type: 'heading', text: 'Chapter One', level: 2 }, { type: 'text', text: 'x' }] },
      { index: 2, kind: 'body', blocks: [{ type: 'text', text: 'continues' }] },
      { index: 3, kind: 'body', blocks: [
        { type: 'heading', text: 'Chapter Two', level: 2 }, { type: 'text', text: 'y' }] },
    ],
  });
  assert.equal((doc.match(/chunk chapter-open/g) ?? []).length, 2, 'two chapters open');
  assert.equal((doc.match(/class="chunk"/g) ?? []).length, 1, 'the continuation does not');
});

test('page-model text cannot inject markup', async () => {
  const { html: doc } = await html.pageModelToHtml({
    ...base,
    pages: [{ index: 1, kind: 'body', blocks: [
      { type: 'heading', text: '<script>alert(1)</script>', level: 2 },
      { type: 'text', text: 'Tom & Jerry said "hi" <b>bold</b>' },
    ]}],
  });
  assert.ok(!doc.includes('<script>alert'), 'script tags are escaped');
  assert.ok(!doc.includes('<b>bold</b>'), 'inline markup is escaped');
  assert.ok(doc.includes('&amp;') && doc.includes('&quot;'), 'entities are encoded');
});

test('a missing illustration is reported and drawn as a placeholder', async () => {
  const model = {
    ...base,
    pages: [{ index: 1, kind: 'plate' as const, blocks: [
      { type: 'image' as const, text: '', storageKey: 'projects/x/illustrations/gone.png' },
    ]}],
  };

  const { html: doc, missingImages } = await html.pageModelToHtml(model);
  assert.deepEqual(missingImages, ['projects/x/illustrations/gone.png']);
  assert.ok(doc.includes('figure class="missing"'), 'a placeholder stands in for it');

  // The render still succeeds; Proof sees the gap in its report.
  const result = await render.renderPdf(model);
  assert.equal(result.pdf.subarray(0, 5).toString(), '%PDF-');
  assert.deepEqual(result.missingImages, ['projects/x/illustrations/gone.png']);
});

test('an embedded illustration is inlined, not fetched', async () => {
  // A 1x1 PNG is enough to prove the data: URI path.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const key = 'projects/y/illustrations/plate.png';
  await blobs.putBlob(key, png);

  const { html: doc, missingImages } = await html.pageModelToHtml({
    ...base,
    pages: [{ index: 1, kind: 'plate', blocks: [{ type: 'image', text: '', storageKey: key }] }],
  });
  assert.equal(missingImages.length, 0);
  assert.ok(doc.includes('src="data:image/png;base64,'), 'the image is inlined');
});

test('prose flows past the model page count instead of under-filling', async () => {
  const para = 'The lot is a piece of the living world, marked by a moment of a life. ';
  const result = await render.renderPdf({
    ...base,
    pages: [{ index: 1, kind: 'body', blocks: [
      { type: 'heading', text: 'A Long Chapter', level: 2 },
      { type: 'text', text: para.repeat(220) },
    ]}],
  });

  assert.equal(result.pdf.subarray(0, 5).toString(), '%PDF-');
  if (result.engine === 'puppeteer') {
    assert.ok(
      result.pageCount > 1,
      `one model page of long prose should paginate, got ${result.pageCount}`,
    );
  }
});
