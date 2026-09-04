import { createServer, type Server } from 'node:http';

/**
 * A stand-in for the OpenAI API, used to exercise the whole pipeline without
 * network access or a key. It answers chat completions with a schema-valid
 * fixture chosen from the agent's system prompt, and images with a 1x1 PNG.
 */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const CHAPTER_BLOCKS = [
  { type: 'heading', text: 'The Light Answers', level: 2 },
  { type: 'paragraph', text: 'The lamp turned all night, and all night something turned with it.' },
  { type: 'dialogue', text: '"You saw it too," she said.' },
  { type: 'break', text: '' },
  { type: 'paragraph', text: 'By morning the water had gone the colour of old tin.' },
];

/** Distinct prose per chapter, so a test can tell whose text landed where. */
function chapterBlocks(n: number): typeof CHAPTER_BLOCKS {
  if (n === 1) return CHAPTER_BLOCKS;
  return [
    { type: 'heading', text: `Signals, Night ${n}`, level: 2 },
    { type: 'paragraph', text: `On night ${n} a second light answered from the water.` },
    { type: 'dialogue', text: '"It knows the pattern," Mara said.' },
    { type: 'break', text: '' },
    { type: 'paragraph', text: `She signalled back: ${n} long, one short.` },
  ];
}

const FIXTURES: { match: string; body: (user: string) => unknown }[] = [
  {
    match: 'You are the Discover agent',
    body: () => ({
      title: 'The Lantern Keeper',
      premise: 'A keeper discovers the light is answering something at sea.',
      genre: 'Literary fantasy',
      audience: 'Adult',
      toneKeywords: ['elegiac', 'salt-bitten'],
      themes: ['isolation', 'duty'],
      targetWordCount: 4000,
      targetChapterCount: 2,
      illustrationStyle: 'Muted ink wash with cold blues',
      openQuestions: ['Is the sea sentient?'],
    }),
  },
  {
    match: 'You are the Research agent',
    body: () => ({
      sources: [
        {
          title: 'Lighthouse keeping practice',
          kind: 'fact',
          summary: 'Keepers logged the lamp hourly.',
          claims: ['Watches ran four hours.'],
          citation: 'General maritime practice',
          confidence: 'medium',
        },
      ],
      gaps: ['Regional dialect detail'],
    }),
  },
  {
    match: 'You are the Map agent',
    body: () => ({
      entities: [
        { name: 'Mara Vell', kind: 'character', description: 'The keeper.', aliases: ['Mara'] },
        { name: 'The Lantern', kind: 'object', description: 'A brass lamp.', aliases: [] },
      ],
      relationships: [{ from: 'Mara Vell', to: 'The Lantern', relation: 'tends' }],
      timeline: [{ label: 'Arrival', when: 'Autumn', summary: 'Mara takes the post.' }],
      locations: [{ name: 'Kell Point', description: 'A shale headland.' }],
    }),
  },
  {
    match: 'You are the Visual Canon agent',
    body: () => ({
      assets: [
        {
          name: 'Mara Vell',
          type: 'character',
          importance: 'primary',
          firstAppearance: 'Chapter 1',
          canonicalDescription: { build: 'wiry', hair: 'grey, cropped', coat: 'oilskin' },
        },
        {
          name: 'The Lantern',
          type: 'object',
          importance: 'primary',
          firstAppearance: 'Chapter 1',
          canonicalDescription: { material: 'brass', state: 'salt-pitted' },
        },
        {
          name: 'Tin Cup',
          type: 'object',
          importance: 'background',
          firstAppearance: 'Chapter 1',
          canonicalDescription: { material: 'dented tin' },
        },
      ],
    }),
  },
  {
    match: 'You are the Asset Designer',
    body: () => ({
      assetName: 'Mara Vell',
      bible: {
        identity: 'Keeper of Kell Point', ageOrScale: 'sixties', species: 'human',
        proportions: 'wiry', face: 'weathered', hairFurScales: 'grey, cropped',
        eyes: 'pale grey', clothing: 'oilskin coat', accessories: 'brass key',
        distinguishingMarks: 'burn scar, left hand', material: '', markings: '',
        damage: '', uniqueFeatures: '', palette: ['#3a4a55', '#c9a227'],
        personality: 'watchful', style: 'muted ink wash',
      },
      referencePrompts: ['Character reference sheet, neutral background, even lighting.'],
      negativePrompts: ['modern clothing'],
    }),
  },
  {
    match: 'You are the Architect',
    body: () => ({
      structure: 'Two-part descent',
      parts: [{ title: 'The Watch', purpose: 'Establish the ritual.', chapterRange: '1-2' }],
      chapterCount: 2,
      narrativeArc: 'Duty hardens into obsession.',
      pacingNotes: 'Slow, tidal.',
    }),
  },
  {
    match: 'You are the Design agent',
    body: () => ({
      voice: 'Close third, restrained.', tone: 'Elegiac', pov: 'Third limited',
      tense: 'Past', pacing: 'Tidal', visualLanguage: 'Muted ink wash, cold blues',
      paletteNotes: 'Slate, brass, bone', typographyNotes: 'Old-style serif',
      template: 'illustrated_story', styleRules: ['No semicolons in dialogue.'],
    }),
  },
  {
    match: 'You are the Outline agent',
    body: () => ({
      chapters: [
        {
          number: 1, title: 'The Watch', summary: 'Mara keeps the lamp.',
          beats: ['Mara climbs the tower.', 'The light stutters.'],
          targetWordCount: 2000, entities: ['Mara Vell', 'The Lantern'],
          illustrationHints: ['Mara at the lamp'],
        },
        {
          number: 2, title: 'The Answer', summary: 'Something answers.',
          beats: ['A second light appears.', 'Mara signals back.'],
          targetWordCount: 2000, entities: ['Mara Vell'],
          illustrationHints: ['Two lights across black water'],
        },
      ],
    }),
  },
  {
    match: 'You are the Author agent',
    body: (user) => ({
      number: chapterNumberFrom(user),
      title: 'The Watch',
      blocks: chapterBlocks(chapterNumberFrom(user)),
      wordCount: 1900,
      notes: [],
    }),
  },
  {
    match: 'You are the Scene Composer',
    body: (user) => {
      const n = chapterNumberFrom(user);
      // Extra scenes spell asset names loosely and name one that does not exist.
      const extra = Array.from({ length: state.extraScenes }, (_, i) => ({
        key: `ch${n}-extra-${i + 1}`, chapterNumber: state.misnumberChapters ? 1 : n,
        assets: ['mara vell', 'Lantern', 'Nobody'], location: 'Kell Point',
        time: 'Dusk', weather: '', action: 'Mara waits on the shale.',
        emotion: '', camera: '', composition: '', lighting: '', style: '',
        requiredReferences: ['mara vell'],
      }));
      return {
        scenes: [
          {
            key: `ch${n}-the-lamp`, chapterNumber: state.misnumberChapters ? 1 : n,
            assets: ['Mara Vell', 'The Lantern', 'Tin Cup'], location: 'Kell Point',
            time: 'Night', weather: 'Fog', action: 'Mara trims the lamp.',
            emotion: 'Wary', camera: 'Low three-quarter', composition: 'Off-centre',
            lighting: 'Single warm source', style: 'Muted ink wash',
            requiredReferences: ['Mara Vell'],
          },
          ...extra,
        ],
      };
    },
  },
  {
    match: 'You are the Image Director',
    body: (user) => ({
      sceneKey: sceneKeyFrom(user),
      prompt: 'A wiry grey-haired keeper in an oilskin coat trims a salt-pitted brass lamp.',
      negativePrompt: 'modern clothing',
      aspectRatio: '2:3',
      referenceAssetNames: ['Mara Vell'],
      qaChecklist: ['Keeper is grey-haired', 'Lamp is brass', 'Style is ink wash'],
    }),
  },
  {
    match: 'You are Visual QA',
    body: (user) => {
      const sceneKey = sceneKeyFrom(user);
      if (state.failVisualQa > 0) {
        state.failVisualQa--;
        return {
          sceneKey, passed: false,
          checks: [{ check: 'Keeper has a burn scar', result: 'fail', note: 'No scar visible.' }],
          criticalFailures: ['Keeper has no burn scar'],
          recommendation: 'regenerate',
        };
      }
      if (state.failCheckOnce) {
        state.failCheckOnce = false;
        return {
          sceneKey, passed: false,
          checks: [{ check: 'Lamp is brass', result: 'fail', note: 'Reads as bronze.' }],
          criticalFailures: [],
          recommendation: 'regenerate',
        };
      }
      if (state.softRegenerateOnce) {
        state.softRegenerateOnce = false;
        return {
          sceneKey, passed: false,
          checks: [{ check: 'Lamp is brass', result: 'warn', note: 'Reads as bronze.' }],
          criticalFailures: [],
          recommendation: 'regenerate',
        };
      }
      return {
        sceneKey,
        passed: true,
        checks: [{ check: 'Keeper is grey-haired', result: 'pass', note: '' }],
        criticalFailures: [],
        recommendation: 'accept',
      };
    },
  },
  {
    match: 'You are an independent critic',
    body: (user) => {
      // Raises the issue diagnosis is about to act on, so the commit-time
      // severity clamp sees a critique that supports the demanded task.
      const severity = demandedSeverity();
      return {
        persona: 'literary',
        chapterNumber: chapterNumberFrom(user),
        verdict: severity ? 'revise' : 'pass',
        issues: severity
          ? [{
              severity, area: 'fact',
              description: 'The claim in paragraph two is unsupported.',
              evidence: 'Paragraph two.',
            }]
          : [],
        strengths: ['Controlled imagery'],
      };
    },
  },
  {
    match: 'You are the Diagnosis agent',
    body: (user) => {
      // Demands a rewrite for the first `demandRewrites` diagnoses (critical),
      // then for the first `demandMajorRewrites` (major), so a test can drive
      // the editorial loop round more than once, or once without a re-read.
      // `inflateDiagnosis` instead claims a critical task the critics never
      // raised, which the runner's severity clamp has to undo.
      const inflated = state.inflateDiagnosis > 0;
      if (inflated) state.inflateDiagnosis--;
      const severity = inflated ? 'critical' : demandedSeverity();
      if (!inflated && severity === 'critical') state.demandRewrites--;
      if (!inflated && severity === 'major') state.demandMajorRewrites--;
      return {
        chapterNumber: chapterNumberFrom(user),
        tasks: severity
          ? [{
              id: 't1', severity,
              instruction: 'Fix the unsupported claim in paragraph two.',
              rationale: 'Flagged by the factual critic.', sourceCritiques: ['factual'],
            }]
          : [],
        verdict: severity ? 'revise' : 'pass',
      };
    },
  },
  {
    match: 'You are the Rewriter',
    body: (user) => ({
      number: chapterNumberFrom(user), title: 'The Watch',
      blocks: chapterBlocks(chapterNumberFrom(user)), wordCount: 1900, notes: [],
    }),
  },
  {
    match: 'You are the Editor',
    body: (user) => ({
      number: chapterNumberFrom(user), title: 'The Watch',
      blocks: chapterBlocks(chapterNumberFrom(user)), wordCount: 1880, notes: [],
    }),
  },
  {
    match: 'You are the Copy Editor',
    body: (user) => ({
      // The number a model writes is not trusted; a test can make it wrong.
      number: state.misnumberChapters ? 1 : chapterNumberFrom(user), title: 'The Watch',
      blocks: chapterBlocks(chapterNumberFrom(user)), wordCount: 1875, notes: [],
    }),
  },
  {
    match: 'You are the Continuity agent',
    body: () => ({ passed: true, findings: [] }),
  },
  {
    match: 'You are the Layout agent',
    body: () => ({
      template: 'illustrated_story',
      pageSize: 'digest',
      margins: { top: 54, bottom: 54, inner: 54, outer: 54 },
      pages: [
        { index: 1, kind: 'cover', blocks: [{ type: 'heading', text: 'The Lantern Keeper', level: 1 }] },
        { index: 2, kind: 'front_matter', blocks: [{ type: 'text', text: 'BookForgeAI edition' }] },
        {
          index: 3, kind: 'body',
          blocks: [
            { type: 'heading', text: '1. The Watch', level: 2 },
            // Prose is referred to, never retyped; the runner fills it in.
            { type: 'text', ref: { chapter: 1, from: 0, to: 4 } },
            { type: 'page_number', text: '3' },
          ],
        },
        {
          index: 4, kind: 'plate',
          blocks: [
            { type: 'image', text: '', storageKey: 'REPLACED_AT_RUNTIME' },
            { type: 'caption', text: 'Mara at the lamp.' },
          ],
        },
        {
          index: 5, kind: 'body',
          blocks: [
            { type: 'heading', text: '2. The Answer', level: 2 },
            { type: 'text', ref: { chapter: 2, from: 0, to: 4 } },
          ],
        },
      ],
    }),
  },
  {
    match: 'You are the Proof agent',
    body: () => ({
      passed: true,
      pageCount: 4,
      checks: [{ check: 'No blank pages', result: 'pass', note: '' }],
    }),
  },
  {
    match: 'You are the Publisher',
    body: () => ({
      editionNumber: 1,
      title: 'The Lantern Keeper',
      isbn: '',
      blurb: 'A keeper, a light, and something answering from the water.',
      frozenArtifactIds: [],
      pdfStorageKey: '',
    }),
  },
];

/** Severity the demand knobs currently ask for: critical first, then major, else none. */
function demandedSeverity(): 'critical' | 'major' | null {
  if (state.demandRewrites > 0) return 'critical';
  if (state.demandMajorRewrites > 0) return 'major';
  return null;
}

function chapterNumberFrom(user: string): number {
  // A scope key when the context carries one; otherwise the first numbered
  // artifact in the context (the chapter outline, or the chapter itself).
  const scope = /ch(\d+)/.exec(user) ?? /"number":\s*(\d+)/.exec(user);
  return scope ? Number(scope[1]) : 1;
}

function sceneKeyFrom(user: string): string {
  return /"key":\s*"([^"]+)"/.exec(user)?.[1] ?? 'ch1-the-lamp';
}

/** Mutable stub state, so a test can steer the pipeline down a branch. */
export const state = {
  demandRewrites: 0,
  /** Like demandRewrites, but the issue and task raised are `major`, not `critical`. */
  demandMajorRewrites: 0,
  /** Diagnoses that emit a critical task whatever the critics raised; the runner must clamp it. */
  inflateDiagnosis: 0,
  /** When true, the copy editor and scene composer write chapter 1's number on every chapter. */
  misnumberChapters: false,
  /** Visual QA verdicts that fail the render on a canon violation before verdicts pass again. */
  failVisualQa: 0,
  /** The next Visual QA verdict fails a check without a canon violation, then passes again. */
  failCheckOnce: false,
  /** The next Visual QA verdict asks for a regeneration with only a warning, then passes again. */
  softRegenerateOnce: false,
  /** Image calls seen so far; `refuseImageAt` refuses the call with this 1-based index. */
  imageCalls: 0,
  refuseImageAt: 0,
  /** Additional scenes the composer offers per chapter, with loosely spelt asset names. */
  extraScenes: 0,
  /** When set, chat calls whose system prompt contains this text return JSON that fails every schema. */
  breakSchemaFor: '' as string,
  /**
   * While `remaining` is positive, chat calls whose system prompt contains
   * `match` fail with a 500. The SDK retries 5xx on its own, so a test that
   * wants the error to surface sets `remaining` above the SDK's retry count.
   */
  failChatFor: { match: '', skip: 0, remaining: 0 } as {
    match: string;
    /** Matching calls to let through normally before the outage begins. */
    skip: number;
    remaining: number;
  },
  /** When true, /images/edits is rejected with a 400 so the client falls back to a fresh render. */
  rejectImageEdits: false,
  /** When true, the next image call fails with a 500, then clears. */
  failImagesOnce: false,
};

/** Every billable detail the real API reports, so the ledger tests can see them. */
export const CHAT_USAGE = {
  prompt_tokens: 400,
  completion_tokens: 250,
  total_tokens: 650,
  prompt_tokens_details: { cached_tokens: 120 },
  completion_tokens_details: { reasoning_tokens: 40 },
};

export const IMAGE_USAGE = {
  input_tokens: 30,
  output_tokens: 1000,
  input_tokens_details: { image_tokens: 20, text_tokens: 10 },
};

export interface FakeOpenAI {
  url: string;
  close: () => Promise<void>;
  calls: { agent: string }[];
  /** The user content of the most recent chat call, for asserting context. */
  lastUserMessage: string;
  /** The most recent user content per fixture, keyed by the fixture's match text. */
  userMessages: Map<string, string>;
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const calls: { agent: string }[] = [];
  let handle: FakeOpenAI;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      res.setHeader('Content-Type', 'application/json');

      if (url.includes('/images/')) {
        // A safety refusal is a 400 the client must not retry; the caller's
        // job fails for a person to look at.
        state.imageCalls += 1;
        if (state.refuseImageAt > 0 && state.imageCalls === state.refuseImageAt) {
          state.refuseImageAt = 0;
          calls.push({ agent: 'image-refused' });
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'Your request was rejected by the safety system (content_policy_violation).' } }));
          return;
        }
        if (state.failImagesOnce) {
          state.failImagesOnce = false;
          res.statusCode = 500;
          res.end(JSON.stringify({ error: { message: 'simulated image outage' } }));
          return;
        }
        // A model that takes no image inputs rejects the edit; the client must
        // fall back to a fresh render and report that it did.
        if (state.rejectImageEdits && url.includes('/images/edits')) {
          calls.push({ agent: 'image-edit-rejected' });
          res.statusCode = 400;
          res.end(JSON.stringify({ error: { message: 'This model does not support image inputs' } }));
          return;
        }
        calls.push({ agent: 'image' });
        res.end(JSON.stringify({ data: [{ b64_json: PNG_1X1 }], usage: IMAGE_USAGE }));
        return;
      }

      // Multipart bodies (images.edit) never reach here; chat is always JSON.
      let payload: { messages?: { role: string; content: unknown }[] } = {};
      try { payload = JSON.parse(raw); } catch { /* handled below */ }

      const system = String(payload.messages?.find((m) => m.role === 'system')?.content ?? '');
      const userMessage = payload.messages?.find((m) => m.role === 'user')?.content;
      // Vision calls send an array of parts; the text parts are what fixtures read.
      const user = typeof userMessage === 'string'
        ? userMessage
        : Array.isArray(userMessage)
          ? userMessage
              .map((part: { type?: string; text?: string }) => (part.type === 'text' ? String(part.text ?? '') : ''))
              .join('\n')
          : JSON.stringify(userMessage ?? '');

      const fixture = FIXTURES.find((f) => system.includes(f.match));

      // A transport failure on a specific agent's call, for tests of what a
      // job keeps when a later attempt dies.
      if (state.failChatFor.match && system.includes(state.failChatFor.match) &&
          state.failChatFor.skip > 0) {
        // Let the first `skip` matching calls through, so an attempt can be
        // billed before the outage begins.
        state.failChatFor.skip -= 1;
      } else if (state.failChatFor.remaining > 0 && state.failChatFor.match &&
          system.includes(state.failChatFor.match)) {
        state.failChatFor.remaining -= 1;
        calls.push({ agent: `outage:${fixture?.match ?? '?'}` });
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { message: 'simulated outage' } }));
        return;
      }

      // Valid JSON that satisfies no artifact schema, so the caller's repair
      // loop runs and then fails — the path a burnt retry's spend travels.
      if (state.breakSchemaFor && system.includes(state.breakSchemaFor)) {
        calls.push({ agent: `broken:${fixture?.match ?? '?'}` });
        handle.lastUserMessage = user;
        res.end(JSON.stringify({
          id: 'chatcmpl-fake',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ unexpected: true }) }, finish_reason: 'stop' }],
          usage: CHAT_USAGE,
        }));
        return;
      }
      if (!fixture) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: { message: `No fixture for prompt: ${system.slice(0, 90)}` } }));
        return;
      }

      calls.push({ agent: fixture.match });
      handle.lastUserMessage = user;
      handle.userMessages.set(fixture.match, user);
      res.end(JSON.stringify({
        id: 'chatcmpl-fake',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(fixture.body(user)) }, finish_reason: 'stop' }],
        usage: CHAT_USAGE,
      }));
    });
  });

  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  handle = {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    lastUserMessage: '',
    userMessages: new Map(),
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };

  return handle;
}
