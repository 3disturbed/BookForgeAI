import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// .env must be loaded before anything reads configuration.
const envFile = resolve(process.cwd(), '.env');
if (existsSync(envFile)) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // A malformed .env should not stop the service from starting on defaults.
  }
}

const { env } = await import('./domain/env.js');
const { BookForgeError } = await import('./domain/errors.js');
const { api } = await import('./http/routes.js');
const { confirmPayment, verifyWebhook } = await import('./billing/checkout.js');
const { advanceProject, startWorker } = await import('./queue/orchestrator.js');
const { getBlob, verifySignedUrl } = await import('./storage/blobs.js');
const { database } = await import('./store/db.js');
const repo = await import('./store/repo.js');

const config = env();
const app = express();

app.disable('x-powered-by');

/* --------------------------- stripe webhook ------------------------- */

/**
 * Mounted before the JSON parser: signature verification needs the raw body.
 * SECURITY.md — only a verified webhook unlocks publication.
 */
app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  (req: Request, res: Response) => {
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string') {
      res.status(400).json({ error: 'Missing stripe-signature header' });
      return;
    }

    let event;
    try {
      event = verifyWebhook(req.body as Buffer, signature);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid signature';
      res.status(400).json({ error: message });
      return;
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as { id: string };
      const project = confirmPayment(session.id);
      if (project) {
        repo.setApproval({
          projectId: project.id, gate: 'publication_payment',
          approved: true, actor: 'stripe', note: event.id,
        });
        repo.updateProject(project.id, {
          publicationState: 'PUBLISHING', status: 'publishing',
        });
        repo.recordEvent({
          projectId: project.id, type: 'PUBLICATION_STARTED', actor: 'stripe',
        });
        advanceProject(project.id);
      }
    }

    // Acknowledge every verified event so Stripe stops retrying.
    res.json({ received: true });
  },
);

app.use(express.json({ limit: '1mb' }));

/* ------------------------------ files ------------------------------- */

/** Serves a blob only against an unexpired signature (SECURITY.md). */
app.get('/files', async (req: Request, res: Response) => {
  const { key, exp, sig } = req.query;
  if (typeof key !== 'string' || typeof exp !== 'string' || typeof sig !== 'string') {
    res.status(400).json({ error: 'key, exp and sig are required' });
    return;
  }
  if (!verifySignedUrl(key, exp, sig)) {
    res.status(403).json({ error: 'Invalid or expired link' });
    return;
  }

  try {
    const data = await getBlob(key);
    res.type(key.endsWith('.pdf') ? 'application/pdf' : 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(data);
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

/* ------------------------------- api -------------------------------- */

// Registered before the router: everything under /api/projects is auth-guarded.
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, version: '0.1.0' });
});

app.use('/api', api);

/* ---------------------------- static UI ----------------------------- */

const publicDir = resolve(process.cwd(), 'public');
app.use(express.static(publicDir, { index: 'index.html', extensions: ['html'] }));

// Dev checkout confirmation page, and the SPA fallback.
app.get(/^\/(?!api|files).*/, (_req: Request, res: Response) => {
  res.sendFile(resolve(publicDir, 'index.html'));
});

/* --------------------------- error handler -------------------------- */

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof BookForgeError) {
    res.status(error.status).json({
      error: error.message,
      code: error.code,
      details: error.details,
    });
    return;
  }
  const message = error instanceof Error ? error.message : 'Unexpected error';
  if (config.NODE_ENV !== 'test') console.error('[bookforge]', error);
  res.status(500).json({ error: message, code: 'INTERNAL' });
});

/* ------------------------------ start ------------------------------- */

database();

// Anything left `running` by a previous process has no worker behind it.
const requeued = repo.requeueStaleJobs();
if (requeued > 0) console.log(`Requeued ${requeued} job(s) interrupted by a restart.`);

startWorker();

// Projects interrupted by a restart pick up where they left off.
for (const project of repo.allActiveProjectIds()) {
  try {
    advanceProject(project);
  } catch {
    // A single bad project must not stop the service from starting.
  }
}

const server = app.listen(config.PORT, () => {
  console.log(`BookForgeAI listening on ${config.APP_BASE_URL}`);
  if (!config.OPENAI_API_KEY) {
    console.warn('  OPENAI_API_KEY is not set — agent jobs will fail until it is.');
  }
  if (!config.STRIPE_SECRET_KEY) {
    console.warn('  STRIPE_SECRET_KEY is not set — using dev checkout.');
  }
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { app };
