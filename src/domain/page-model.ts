/**
 * The page model as structure. Layout decides pages, order, plates and
 * captions; the prose is filled in from the clean manuscript when the model is
 * committed, byte for byte, so nothing the copy editor approved is retyped by
 * a model. On the measured runs 225 of 227 layout blocks were near-verbatim
 * copies of the manuscript, billed as output, and Chromium reflowed them anyway.
 */
export interface ManuscriptBlock {
  type: string;
  text: string;
  level?: number;
}

export interface ChapterLike {
  number: number;
  title: string;
  blocks: ManuscriptBlock[];
}

/** Manuscript blocks `from` to `to` inclusive of one chapter. */
export interface BlockRef {
  chapter: number;
  from: number;
  to: number;
}

export interface PageBlock {
  type: string;
  text?: string;
  level?: number;
  storageKey?: string;
  rows?: string[][];
  ref?: BlockRef;
}

export interface PageLike {
  index: number;
  kind: string;
  blocks?: PageBlock[];
}

export const wordCount = (text: string | undefined): number =>
  (String(text ?? '').match(/\S+/g) ?? []).length;

/** "3. The Crossing", "Chapter 3: The Crossing" and "the crossing" are one title. */
export function normaliseHeading(text: string): string {
  const lower = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const stripped = lower
    .replace(/^(?:chapter\s+\d+\s*[:.)\-]?\s*|\d+\s*[:.)\-]\s*)/, '')
    .replace(/[\s.:!?]+$/, '')
    .trim();
  // A title that is only a number ("Chapter 12") keeps its text.
  return stripped || lower;
}

/** Whitespace-insensitive identity for prose, so a retyped block is recognised. */
const normaliseText = (text: string | undefined): string => String(text ?? '').replace(/\s+/g, ' ').trim();

/**
 * The chapter's opening heading, when it repeats the title: layout writes its
 * own. A section heading that repeats the title after prose has begun is an
 * ordinary block.
 */
function isOpeningTitle(chapter: ChapterLike, i: number): boolean {
  const block = chapter.blocks[i];
  if (!block || block.type !== 'heading') return false;
  if (normaliseHeading(block.text) !== normaliseHeading(chapter.title)) return false;
  return chapter.blocks.slice(0, i).every((b) => b.type === 'heading' || b.type === 'break');
}

/** What layout needs to plan pages: block types and lengths, headings verbatim, no prose. */
export function manuscriptDigest(chapters: ChapterLike[]) {
  return chapters.map((c) => ({
    number: c.number,
    title: c.title,
    wordCount: c.blocks.reduce((n, b) => n + wordCount(b.text), 0),
    blocks: c.blocks.map((b, i) => ({
      i,
      type: b.type,
      words: wordCount(b.text),
      ...(b.type === 'heading' ? { text: b.text, level: b.level ?? 3 } : {}),
      // The opening heading, when it repeats the chapter title: layout writes its own.
      ...(isOpeningTitle(c, i) ? { isTitle: true } : {}),
    })),
  }));
}

function pageBlockFor(block: ManuscriptBlock): PageBlock {
  switch (block.type) {
    case 'heading':
      return { type: 'heading', text: block.text, level: Math.min(Math.max(block.level ?? 3, 1), 6) };
    case 'break':
      return { type: 'decoration', text: '' };
    default:
      return { type: 'text', text: block.text };
  }
}

/** A block on an assembled page; `origin` marks prose, by chapter position and block index. */
interface Entry {
  block: PageBlock;
  origin?: { chapter: number; i: number };
}

interface Draft {
  page: PageLike;
  entries: Entry[];
}

export interface AssembledPageModel {
  data: unknown;
  /** Manuscript blocks the layout did not refer to and that were put back in place. */
  relocated: number;
}

/** Where each placed block of a chapter sits, by block index. */
function locate(pages: Draft[], chapter: number): Map<number, { page: number; entry: number }> {
  const placed = new Map<number, { page: number; entry: number }>();
  pages.forEach((draft, page) => {
    draft.entries.forEach((entry, index) => {
      if (entry.origin?.chapter === chapter) placed.set(entry.origin.i, { page, entry: index });
    });
  });
  return placed;
}

/** A page the layout opened for this chapter: its first entry is a layout heading naming it. */
function headsChapter(draft: Draft, chapter: ChapterLike): boolean {
  const first = draft.entries[0];
  return (
    first !== undefined &&
    first.origin === undefined &&
    first.block.type === 'heading' &&
    normaliseHeading(first.block.text ?? '') === normaliseHeading(chapter.title)
  );
}

/** Contiguous runs of block indexes. */
function runs(indexes: number[]): number[][] {
  const out: number[][] = [];
  for (const i of indexes) {
    const last = out[out.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else out.push([i]);
  }
  return out;
}

/**
 * Resolves every block reference against the manuscript. Chapters are found by
 * number but coverage is tracked by position, so two chapters claiming one
 * number cannot hide each other's prose. A block referred to twice is placed
 * once; a reversed or overlong range is read in manuscript order and clamped;
 * a page emptied by that is dropped. Prose the layout never referred to goes
 * back where the manuscript has it, and a chapter it never referred to at all
 * gets a page of its own after the chapter before it. A manuscript heading
 * that repeats the chapter title is neither set twice nor put back: the
 * chapter heading is layout's to write.
 */
export function assemblePageModel(data: unknown, chapters: ChapterLike[]): AssembledPageModel {
  if (typeof data !== 'object' || data === null) return { data, relocated: 0 };
  const model = data as { pages?: unknown };
  if (!Array.isArray(model.pages)) return { data, relocated: 0 };

  const covered = chapters.map(() => new Set<number>());
  const byNumber = (n: number): number => chapters.findIndex((c) => c.number === n);

  // Prose the layout typed out instead of referring to is recognised as the
  // block it copies, placed once and in the manuscript's own bytes, rather
  // than printed and then printed again by the repair below.
  const byText = new Map<string, { chapter: number; i: number }>();
  chapters.forEach((chapter, ci) => {
    chapter.blocks.forEach((b, i) => {
      const key = normaliseText(b.text);
      if (key && !byText.has(key)) byText.set(key, { chapter: ci, i });
    });
  });

  let pages: Draft[] = (model.pages as PageLike[])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((page) => ({ page, entries: [] }));

  for (const draft of pages) {
    for (const block of draft.page.blocks ?? []) {
      if (!block.ref) {
        const copied = block.type === 'text' || block.type === 'heading'
          ? byText.get(normaliseText(block.text))
          : undefined;
        if (copied) {
          if (covered[copied.chapter]!.has(copied.i)) continue;
          covered[copied.chapter]!.add(copied.i);
          draft.entries.push({
            block: pageBlockFor(chapters[copied.chapter]!.blocks[copied.i]!),
            origin: copied,
          });
          continue;
        }
        draft.entries.push({ block });
        continue;
      }
      const ci = byNumber(block.ref.chapter);
      const chapter = chapters[ci];
      if (!chapter || chapter.blocks.length === 0) continue;
      const last = chapter.blocks.length - 1;
      const from = Math.min(Math.max(Math.min(block.ref.from, block.ref.to), 0), last);
      const to = Math.min(Math.max(Math.max(block.ref.from, block.ref.to), 0), last);
      for (let i = from; i <= to; i++) {
        if (covered[ci]!.has(i)) continue;
        covered[ci]!.add(i);
        const source = chapter.blocks[i]!;
        const previous = draft.entries[draft.entries.length - 1];
        const repeatsHeading =
          isOpeningTitle(chapter, i) &&
          previous !== undefined &&
          previous.origin === undefined &&
          previous.block.type === 'heading' &&
          normaliseHeading(previous.block.text ?? '') === normaliseHeading(source.text);
        if (repeatsHeading) continue;
        draft.entries.push({ block: pageBlockFor(source), origin: { chapter: ci, i } });
      }
    }
  }

  let relocated = 0;
  chapters.forEach((chapter, ci) => {
    const missing = chapter.blocks
      .map((_, i) => i)
      .filter((i) => !covered[ci]!.has(i) && !isOpeningTitle(chapter, i));
    if (missing.length === 0) return;
    relocated += missing.length;
    const prose = (i: number): Entry => ({ block: pageBlockFor(chapter.blocks[i]!), origin: { chapter: ci, i } });

    if (locate(pages, ci).size === 0) {
      // Nothing of this chapter was placed. A page the layout opened for it,
      // whose references all failed, is filled rather than doubled.
      const opened = pages.find(
        (d) => headsChapter(d, chapter) && !d.entries.some((e) => e.origin !== undefined),
      );
      if (opened) {
        opened.entries.splice(1, 0, ...missing.map(prose));
        return;
      }
      // Otherwise a page of its own, before the first page that belongs to a
      // later chapter (its prose or its heading), so a trailing plate stays
      // with the chapter before it; else before the back matter; else last.
      let at = pages.findIndex(
        (d) =>
          d.entries.some((e) => e.origin !== undefined && e.origin.chapter > ci) ||
          chapters.some((later, j) => j > ci && headsChapter(d, later)),
      );
      if (at === -1) at = pages.findIndex((d) => d.page.kind === 'back_matter');
      if (at === -1) at = pages.length;
      pages.splice(at, 0, {
        page: { index: 0, kind: 'body' },
        entries: [
          { block: { type: 'heading', text: `${chapter.number}. ${chapter.title}`, level: 2 } },
          ...missing.map(prose),
        ],
      });
      return;
    }

    // Each run goes after the nearest placed block before it, else before the
    // nearest placed block after it.
    for (const run of runs(missing)) {
      const placed = locate(pages, ci);
      let target: { page: number; entry: number } | undefined;
      let after = true;
      for (let i = run[0]! - 1; i >= 0 && !target; i--) target = placed.get(i);
      if (!target) {
        after = false;
        for (let i = run[run.length - 1]! + 1; i < chapter.blocks.length && !target; i++) target = placed.get(i);
      }
      if (!target) continue;
      pages[target.page]!.entries.splice(target.entry + (after ? 1 : 0), 0, ...run.map(prose));
    }
  });

  // A page planned to carry prose that holds none, or holding nothing but a
  // folio or an ornament, would print blank.
  pages = pages.filter((draft) => {
    const planned = draft.page.blocks ?? [];
    if (planned.length === 0 || draft.page.kind === 'blank') return true;
    const prose = draft.entries.some((e) => e.origin !== undefined);
    if (planned.some((b) => b.ref !== undefined)) return prose;
    return draft.entries.some(
      (e) => e.origin !== undefined || (e.block.type !== 'page_number' && e.block.type !== 'decoration'),
    );
  });

  return {
    data: {
      ...model,
      pages: pages.map((draft, i) => ({
        ...draft.page,
        index: i + 1,
        blocks: draft.entries.map((e) =>
          // Folios follow the final page order.
          e.block.type === 'page_number' ? { ...e.block, text: String(i + 1) } : e.block,
        ),
      })),
    },
    relocated,
  };
}

/**
 * What proof needs: kinds, headings, image presence and lengths. Body prose is
 * reduced to word counts; the text layout itself wrote on other pages (title
 * page, copyright, plates, back matter) and the folios are kept, since proof
 * checks those.
 */
export function pageDigest(model: {
  template?: unknown;
  pageSize?: unknown;
  margins?: unknown;
  pages?: PageLike[];
}) {
  return {
    template: model.template,
    pageSize: model.pageSize,
    margins: model.margins,
    pages: (model.pages ?? []).map((p) => ({
      index: p.index,
      kind: p.kind,
      blocks: (p.blocks ?? []).map((b) => {
        switch (b.type) {
          case 'heading':
            return { type: 'heading', level: b.level ?? 1, text: b.text ?? '' };
          case 'caption':
          case 'page_number':
            return { type: b.type, text: b.text ?? '' };
          case 'image':
            return { type: 'image', hasAsset: Boolean(b.storageKey) };
          case 'table':
            return { type: 'table', rows: (b.rows ?? []).length };
          default:
            return p.kind === 'body'
              ? { type: b.type, words: wordCount(b.text) }
              : { type: b.type, text: b.text ?? '' };
        }
      }),
    })),
  };
}
