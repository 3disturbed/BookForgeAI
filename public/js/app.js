/* BookForgeAI — SaaS console. Vanilla ES modules, no build step. */

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = new Error(data?.error ?? `Request failed (${res.status})`);
    error.code = data?.code;
    error.details = data?.details;
    throw error;
  }
  return data;
}

const state = {
  user: null,
  config: null,
  projects: [],
  current: null,   // snapshot
  tab: 'pipeline',
  cache: {},       // per-tab lazily fetched data
  poll: null,
};

/* ------------------------------ session ----------------------------- */

async function boot() {
  state.config = await api('/config');
  state.user = await api('/session');

  $('#signin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    state.user = await api('/session', { method: 'POST', body: { email: $('#email').value } });
    await enterApp();
  });

  $('#logout').addEventListener('click', async () => {
    await api('/session/logout', { method: 'POST' });
    location.reload();
  });

  $('#new-project').addEventListener('click', () => $('#new-dialog').showModal());
  $('#np-cancel').addEventListener('click', () => $('#new-dialog').close());
  $('#new-form').addEventListener('submit', createProject);

  if (state.user) await enterApp();
  else { $('#signin').hidden = false; }
}

async function enterApp() {
  $('#signin').hidden = true;
  $('#app').hidden = false;
  $('#logout').hidden = false;
  $('#who').textContent = state.config.openaiConfigured ? '' : 'OPENAI_API_KEY not set';
  if (!state.config.openaiConfigured) $('#who').className = 'who tag warn';
  await loadProjects();
}

async function loadProjects() {
  state.projects = await api('/projects');
  renderProjectList();
  if (!state.current && state.projects.length) await openProject(state.projects[0].id);
}

async function createProject(e) {
  e.preventDefault();
  const button = $('#np-submit');
  button.disabled = true;
  try {
    const snap = await api('/projects', {
      method: 'POST',
      body: {
        title: $('#np-title').value,
        idea: $('#np-idea').value,
        genre: $('#np-genre').value,
        audience: $('#np-audience').value,
      },
    });
    $('#new-dialog').close();
    $('#new-form').reset();
    state.current = snap;
    state.tab = 'pipeline';
    await loadProjects();
    render();
    startPolling();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
}

/* ---------------------------- navigation ---------------------------- */

function renderProjectList() {
  const list = $('#project-list');
  list.replaceChildren(
    ...(state.projects.length
      ? state.projects.map((p) =>
          el('div', {
            class: `project-item${state.current?.project.id === p.id ? ' active' : ''}`,
            onclick: () => openProject(p.id),
          },
            el('div', { class: 't' }, p.title),
            el('div', { class: 'm' },
              el('span', {}, p.status.replace(/_/g, ' ')),
              el('span', {}, `${p.progress}%`)),
            el('div', { class: 'bar' }, el('i', { style: `width:${p.progress}%` })),
          ))
      : [el('p', { class: 'muted' }, 'No books yet.')]),
  );
}

async function openProject(id) {
  state.current = await api(`/projects/${id}`);
  state.cache = {};
  renderProjectList();
  render();
  startPolling();
}

function startPolling() {
  clearInterval(state.poll);
  state.poll = setInterval(async () => {
    if (!state.current) return;
    const id = state.current.project.id;
    const busy = state.current.jobCounts.queued + state.current.jobCounts.running > 0;
    if (!busy && document.visibilityState !== 'visible') return;

    try {
      const next = await api(`/projects/${id}`);
      const changed = JSON.stringify(next) !== JSON.stringify(state.current);
      state.current = next;
      if (changed) {
        state.cache = {};
        renderProjectList();
        render();
      }
    } catch { /* transient */ }
  }, 3000);
}

/* ------------------------------ render ------------------------------ */

const TABS = [
  ['pipeline', 'Pipeline'],
  ['brief', 'Brief'],
  ['outline', 'Outline'],
  ['manuscript', 'Manuscript'],
  ['canon', 'Visual canon'],
  ['plates', 'Illustrations'],
  ['publish', 'Publish'],
  ['jobs', 'Jobs'],
];

function render() {
  const main = $('#main');
  if (!state.current) {
    main.replaceChildren(el('div', { class: 'empty' }, 'Select a book, or start a new one.'));
    return;
  }

  const { project } = state.current;
  main.replaceChildren(
    el('div', { class: 'row', style: 'margin-bottom:14px' },
      el('h1', { style: 'margin:0' }, project.title),
      el('span', { class: `tag ${project.status === 'published' ? 'ok' : ''}` },
        project.status.replace(/_/g, ' ')),
      project.revisionCycle > 0 &&
        el('span', { class: 'tag' }, `revision ${project.revisionCycle}`),
    ),
    el('div', { class: 'tabs' },
      TABS.map(([id, label]) =>
        el('button', {
          class: state.tab === id ? 'active' : '',
          onclick: () => { state.tab = id; render(); },
        }, label))),
    el('div', { id: 'tab-body' }, renderTab()),
  );
}

function renderTab() {
  switch (state.tab) {
    case 'pipeline': return renderPipeline();
    case 'brief': return renderBrief();
    case 'outline': return renderOutline();
    case 'manuscript': return lazy('manuscript', renderManuscript);
    case 'canon': return lazy('assets', renderCanon);
    case 'plates': return lazy('illustrations', renderPlates);
    case 'publish': return renderPublish();
    case 'jobs': return renderJobs();
    default: return el('div');
  }
}

/** Fetches a tab's data on first view, then renders it. */
function lazy(resource, renderer) {
  if (state.cache[resource]) return renderer(state.cache[resource]);

  const host = el('div', { class: 'empty' }, el('span', { class: 'spin' }));
  api(`/projects/${state.current.project.id}/${resource}`)
    .then((data) => {
      state.cache[resource] = data;
      if (state.tab === tabForResource(resource)) {
        $('#tab-body')?.replaceChildren(renderer(data));
      }
    })
    .catch((error) => host.replaceChildren(el('div', { class: 'notice err' }, error.message)));
  return host;
}

const tabForResource = (r) =>
  ({ manuscript: 'manuscript', assets: 'canon', illustrations: 'plates' })[r];

/* ----------------------------- pipeline ----------------------------- */

function renderPipeline() {
  const { stages, jobCounts, project } = state.current;
  const done = stages.filter((s) => s.state === 'complete' || s.state === 'degraded').length;

  return el('div', {},
    !state.config.openaiConfigured &&
      el('div', { class: 'notice warn' },
        'OPENAI_API_KEY is not set, so agent jobs will fail. Add it to .env and restart the service.'),

    el('div', { class: 'card' },
      el('div', { class: 'row', style: 'justify-content:space-between' },
        el('h2', {}, 'Pipeline'),
        el('span', { class: 'muted' }, `${done}/${stages.length} stages`)),
      el('div', { class: 'bar', style: 'margin:0 0 14px' },
        el('i', { style: `width:${Math.round((done / stages.length) * 100)}%` })),

      el('div', { class: 'stages' }, stages.map(renderStage)),

      el('div', { class: 'row', style: 'margin-top:14px' },
        el('span', { class: 'muted' },
          `${jobCounts.completed} done · ${jobCounts.running} running · ` +
          `${jobCounts.queued} queued · ${jobCounts.failed} failed`),
        el('div', { style: 'flex:1' }),
        el('button', { class: 'small', onclick: advance }, 'Advance now')),
    ),

    project.publicationState !== 'DRAFT' &&
      el('div', { class: 'notice ok' }, `Publication state: ${project.publicationState}`),
  );
}

function renderStage(stage) {
  const { approvals } = state.current;
  const needsApproval = stage.state === 'awaiting_approval';

  return el('div', { class: `stage ${stage.state}` },
    el('div', { class: 'n' }, String(stage.step).padStart(2, '0')),
    el('div', { class: 'l' },
      el('span', { class: `dot ${stage.state}` }),
      el('b', {}, stage.label),
      stage.jobs > 0 && el('span', { class: 'muted', style: 'font-size:11px' },
        `${stage.done}/${stage.jobs}`),
      stage.state === 'degraded' &&
        el('span', { class: 'tag warn', title: stage.errors.join('\n') },
          `${stage.degraded} skipped`),
      stage.state === 'failed' && stage.errors.length > 0 &&
        el('span', { class: 'tag err', title: stage.errors.join('\n') }, 'error'),
    ),
    el('div', { class: 'row' },
      stage.gate && approvals[stage.gate] === true && el('span', { class: 'tag ok' }, 'approved'),
      needsApproval && el('button', {
        class: 'small primary',
        onclick: () => approve(stage.gate, true),
      }, 'Approve'),
    ),
  );
}

async function advance() {
  state.current = await api(`/projects/${state.current.project.id}/advance`, { method: 'POST' });
  render();
}

async function approve(gate, approved) {
  state.current = await api(`/projects/${state.current.project.id}/approvals`, {
    method: 'POST',
    body: { gate, approved },
  });
  state.cache = {};
  render();
}

/* ------------------------------ brief ------------------------------- */

function renderBrief() {
  const { brief, design, architecture, project } = state.current;
  if (!brief) return waiting('The Discover agent is still working on the brief.');

  return el('div', { class: 'grid' },
    card('Brief', kv({
      Title: brief.title,
      Premise: brief.premise,
      Genre: brief.genre,
      Audience: brief.audience,
      Tone: (brief.toneKeywords ?? []).join(', '),
      Themes: (brief.themes ?? []).join(', '),
      'Target length': `${brief.targetWordCount?.toLocaleString()} words in ${brief.targetChapterCount} chapters`,
      'Illustration style': brief.illustrationStyle,
    }), (brief.openQuestions ?? []).length > 0 &&
      el('div', { style: 'margin-top:12px' },
        el('h3', {}, 'Open questions'),
        el('ul', { class: 'muted' }, brief.openQuestions.map((q) => el('li', {}, q))))),

    design && card('Design', kv({
      Voice: design.voice, Tone: design.tone, POV: design.pov, Tense: design.tense,
      Pacing: design.pacing, 'Visual language': design.visualLanguage,
      Template: design.template, Palette: design.paletteNotes,
    }), (design.styleRules ?? []).length > 0 &&
      el('div', { style: 'margin-top:12px' },
        el('h3', {}, 'Style rules'),
        el('ul', { class: 'muted' }, design.styleRules.map((r) => el('li', {}, r))))),

    architecture && card('Architecture', kv({
      Structure: architecture.structure,
      Chapters: architecture.chapterCount,
      Arc: architecture.narrativeArc,
      Pacing: architecture.pacingNotes,
    }), (architecture.parts ?? []).length > 0 &&
      el('div', { style: 'margin-top:12px' },
        el('h3', {}, 'Parts'),
        architecture.parts.map((p) =>
          el('div', { style: 'margin-bottom:8px' },
            el('b', {}, p.title), ' ',
            el('span', { class: 'muted' }, p.chapterRange),
            el('div', { class: 'muted' }, p.purpose))))),

    card('Idea as given', el('p', { class: 'muted', style: 'white-space:pre-wrap' }, project.idea)),
  );
}

/* ----------------------------- outline ------------------------------ */

function renderOutline() {
  const { outline } = state.current;
  if (!outline) return waiting('The Outline agent has not produced a plan yet.');

  return el('div', { class: 'card' },
    el('h2', {}, `Outline — ${outline.chapters.length} chapters`),
    outline.chapters.map((c) =>
      el('div', { class: 'chapter' },
        el('h2', {}, `${c.number}. ${c.title}`),
        el('p', { class: 'muted' }, c.summary),
        (c.beats ?? []).length > 0 &&
          el('ul', { class: 'muted', style: 'font-size:13px' }, c.beats.map((b) => el('li', {}, b))),
        el('div', { class: 'row', style: 'font-size:11px' },
          el('span', { class: 'tag' }, `${c.targetWordCount?.toLocaleString()} words`),
          (c.entities ?? []).map((e) => el('span', { class: 'tag' }, e))),
      )),
  );
}

/* ---------------------------- manuscript ---------------------------- */

function renderManuscript(chapters) {
  if (!chapters.length) return waiting('No chapters have been drafted yet.');

  const words = chapters.reduce((n, c) => n + (c.wordCount ?? 0), 0);
  return el('div', { class: 'card' },
    el('div', { class: 'row', style: 'justify-content:space-between' },
      el('h2', {}, 'Manuscript'),
      el('span', { class: 'muted' }, `${chapters.length} chapters · ${words.toLocaleString()} words`)),
    chapters.map((c) =>
      el('div', { class: 'chapter' },
        el('h2', {}, `${c.number}. ${c.title}`),
        el('div', { class: 'prose' }, (c.blocks ?? []).map(renderBlock)),
      )),
  );
}

function renderBlock(block) {
  switch (block.type) {
    case 'heading':
      return el(`h${Math.min(block.level ?? 3, 6)}`, {}, block.text);
    case 'quote':
      return el('blockquote', {}, block.text);
    case 'break':
      return el('div', { class: 'divider' }, '···');
    case 'list':
      return el('ul', {}, block.text.split('\n').filter(Boolean).map((t) => el('li', {}, t)));
    case 'dialogue':
      return el('p', { class: 'dialogue' }, block.text);
    default:
      return el('p', {}, block.text);
  }
}

/* ---------------------------- visual canon --------------------------- */

function renderCanon(assets) {
  if (!assets.length) return waiting('The Visual Canon agent has not registered any assets yet.');

  return el('div', { class: 'card' },
    el('h2', {}, `Visual canon — ${assets.length} assets`),
    el('p', { class: 'muted' },
      'Recurring entities are designed before illustration to reduce visual drift. ' +
      'Approving the canon gate locks these assets.'),
    assets.map((a) =>
      el('div', { class: 'asset' },
        a.referenceImages[0]
          ? el('img', { src: a.referenceImages[0], alt: `${a.name} reference`, loading: 'lazy' })
          : el('div', { class: 'ph' }, 'no reference'),
        el('div', { style: 'min-width:0' },
          el('div', { class: 'row' },
            el('b', {}, a.name),
            el('span', { class: 'tag' }, a.type),
            el('span', { class: `tag ${a.status === 'locked' ? 'ok' : ''}` }, a.status),
            el('span', { class: 'tag' }, a.importance)),
          el('div', { class: 'muted', style: 'font-size:12.5px;margin-top:6px' },
            describe(a.referencePackage?.bible ?? a.canonicalDescription)),
        )),
    ),
  );
}

function describe(source) {
  if (!source) return '';
  return Object.entries(source)
    .filter(([, v]) => v && (typeof v === 'string' ? v.trim() : Array.isArray(v) ? v.length : true))
    .slice(0, 8)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
    .join(' · ');
}

/* --------------------------- illustrations --------------------------- */

function renderPlates(plates) {
  if (!plates.length) return waiting('No illustrations have been rendered yet.');

  return el('div', { class: 'card' },
    el('h2', {}, `Illustrations — ${plates.length}`),
    el('div', { class: 'plates' },
      plates.map((p) =>
        el('div', { class: 'plate' },
          el('img', { src: p.url, alt: p.sceneKey, loading: 'lazy' }),
          el('div', { class: 'row', style: 'margin-top:7px' },
            el('span', { class: 'muted', style: 'font-size:11px' }, p.sceneKey),
            p.qa && el('span', { class: `tag ${p.qa.passed ? 'ok' : 'err'}` },
              p.qa.passed ? 'QA pass' : 'QA fail')),
          p.qa && !p.qa.passed && (p.qa.criticalFailures ?? []).length > 0 &&
            el('div', { class: 'muted', style: 'font-size:11px' },
              p.qa.criticalFailures.join('; ')),
        ))),
  );
}

/* ------------------------------ publish ------------------------------ */

function renderPublish() {
  const { acceptance, continuity, proof, economics, usage, project, edition } = state.current;
  const price = state.config.priceUsd;

  return el('div', { class: 'grid' },
    card('Acceptance criteria',
      el('ul', { class: 'checks' },
        acceptance.checks.map((c) =>
          el('li', {},
            el('span', { class: `m ${c.passed ? 'pass' : 'fail'}` }, c.passed ? '✓' : '✗'),
            el('span', { class: c.passed ? '' : 'muted' }, c.criterion)))),
      el('div', { style: 'margin-top:14px' },
        state.current.stages.find((s) => s.id === 'proof')?.state === 'awaiting_approval' &&
          el('button', { class: 'primary', onclick: () => approve('final_pdf', true) },
            'Approve final PDF'),
      ),
    ),

    card(`Publish — $${price}`,
      el('p', { class: 'muted' },
        `The BookForgeAI publishing charge is $${price} per completed book. ` +
        'It is not a claim about underlying AI, printing or payment-processing costs.'),
      project.publicationState === 'PUBLISHED'
        ? el('div', { class: 'notice ok' },
            `Published as edition ${edition?.editionNumber ?? 1}.`)
        : el('div', { class: 'row' },
            el('button', {
              class: 'primary',
              disabled: acceptance.blockers.filter(
                (b) => b !== 'Payment confirmed' && b !== 'User approves final edition').length > 0,
              onclick: checkout,
            }, `Publish for $${price}`),
            !state.config.stripeConfigured &&
              el('span', { class: 'tag warn' }, 'dev checkout')),
      el('div', { class: 'row', style: 'margin-top:12px' },
        el('button', { class: 'small', onclick: openPdf }, 'Open PDF')),
    ),

    proof && card('Proof report',
      el('div', { class: 'row' },
        el('span', { class: `tag ${proof.passed ? 'ok' : 'err'}` }, proof.passed ? 'pass' : 'fail'),
        el('span', { class: 'muted' }, `${proof.pageCount} pages`)),
      el('ul', { class: 'checks' },
        (proof.checks ?? []).map((c) =>
          el('li', {},
            el('span', { class: `m ${c.result === 'pass' ? 'pass' : 'fail'}` },
              c.result === 'pass' ? '✓' : c.result === 'warn' ? '!' : '✗'),
            el('span', {}, c.check, c.note ? ` — ${c.note}` : ''))))),

    continuity && card('Continuity',
      el('span', { class: `tag ${continuity.passed ? 'ok' : 'err'}` },
        continuity.passed ? 'pass' : 'issues found'),
      el('ul', { class: 'checks' },
        (continuity.findings ?? []).map((f) =>
          el('li', {},
            el('span', { class: 'm fail' }, f.severity === 'critical' ? '✗' : '!'),
            el('span', {}, `${f.kind}: ${f.description}`))))),

    card('Unit economics',
      el('div', { class: 'row', style: 'gap:24px;margin-bottom:12px' },
        el('div', { class: 'stat' }, `$${economics.revenue}`, el('small', {}, 'revenue')),
        el('div', { class: 'stat' }, `$${economics.totalCost}`, el('small', {}, 'cost')),
        el('div', { class: 'stat' }, `$${economics.contributionMargin}`,
          el('small', {}, 'contribution'))),
      kv({
        'Text tokens in': usage.textInputTokens.toLocaleString(),
        'Text tokens out': usage.textOutputTokens.toLocaleString(),
        'Images generated': usage.imageGenerations,
        'Reference images used': usage.imageInputImages,
        'Compute seconds': Math.round(usage.computeSeconds),
        'Payment fees': `$${economics.paymentFees}`,
      }),
      el('p', { class: 'muted', style: 'font-size:11.5px;margin-top:10px' },
        'Model and infrastructure rates default to zero until they are configured, ' +
        'so cost here reflects payment fees only.')),
  );
}

async function checkout() {
  try {
    const session = await api(`/projects/${state.current.project.id}/checkout`, { method: 'POST' });
    if (session.provider === 'stripe') {
      location.href = session.url;
      return;
    }
    const ok = await confirmDialog(
      'Development checkout',
      `Stripe is not configured. Confirm a $${session.amountCents / 100} payment without it? ` +
      'This path is refused in production.',
      `Confirm $${session.amountCents / 100}`,
    );
    if (!ok) return;
    state.current = await api('/checkout/dev/confirm', {
      method: 'POST', body: { sessionId: session.sessionId },
    });
    render();
  } catch (error) {
    alert(`${error.message}${error.details?.blockers ? `\n\n${error.details.blockers.join('\n')}` : ''}`);
  }
}

async function openPdf() {
  try {
    const { url } = await api(`/projects/${state.current.project.id}/pdf`);
    window.open(url, '_blank', 'noopener');
  } catch (error) {
    alert(error.message);
  }
}

/* -------------------------------- jobs ------------------------------- */

function renderJobs() {
  const { recentJobs } = state.current;
  return el('div', { class: 'card' },
    el('h2', {}, 'Recent agent jobs'),
    el('p', { class: 'muted' },
      'Every job records its agent, model and prompt version so a run is auditable.'),
    el('div', { class: 'joblist' },
      recentJobs.map((j) =>
        el('div', {},
          el('span', { class: `s ${j.status}` }, j.status),
          el('span', { class: 'a' },
            `${j.agent}${j.persona ? `:${j.persona}` : ''}${j.scopeKey ? ` [${j.scopeKey}]` : ''}` +
            `${j.error ? ` — ${j.error}` : ''}`),
          el('span', { class: 'muted' }, j.promptVersion ?? ''))))
  );
}

/* ------------------------------ helpers ------------------------------ */

/** In-page confirmation; native confirm() is blocked in some embedded views. */
function confirmDialog(title, body, confirmLabel = 'Confirm') {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-body').textContent = body;
  $('#confirm-yes').textContent = confirmLabel;

  return new Promise((resolve) => {
    const done = (answer) => {
      $('#confirm-yes').removeEventListener('click', yes);
      $('#confirm-no').removeEventListener('click', no);
      dialog.close();
      resolve(answer);
    };
    const yes = () => done(true);
    const no = () => done(false);
    $('#confirm-yes').addEventListener('click', yes);
    $('#confirm-no').addEventListener('click', no);
    dialog.showModal();
  });
}

function card(title, ...body) {
  return el('div', { class: 'card' }, el('h2', {}, title), ...body);
}

function kv(pairs) {
  const list = el('dl', { class: 'kv' });
  for (const [k, v] of Object.entries(pairs)) {
    if (v === undefined || v === null || v === '') continue;
    list.append(el('dt', {}, k), el('dd', {}, String(v)));
  }
  return list;
}

function waiting(message) {
  const busy = state.current.jobCounts.queued + state.current.jobCounts.running > 0;
  return el('div', { class: 'empty' },
    busy ? el('div', {}, el('span', { class: 'spin' }), ' ', message) : message);
}

boot().catch((error) => {
  document.body.prepend(el('div', { class: 'notice err' }, `Startup failed: ${error.message}`));
});
