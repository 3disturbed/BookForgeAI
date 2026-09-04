import Stripe from 'stripe';
import { env, isStripeConfigured } from '../domain/env.js';
import { BookForgeError, PreconditionError } from '../domain/errors.js';
import { newId } from '../domain/ids.js';
import * as repo from '../store/repo.js';

let stripe: Stripe | null = null;

function client(): Stripe {
  if (!stripe) stripe = new Stripe(env().STRIPE_SECRET_KEY);
  return stripe;
}

export interface CheckoutSession {
  sessionId: string;
  url: string;
  amountCents: number;
  currency: string;
  provider: 'stripe' | 'dev';
}

/**
 * BILLING.md: the session is created server-side and the amount comes from
 * configuration. A client-supplied amount is never trusted.
 */
export async function createCheckoutSession(projectId: string): Promise<CheckoutSession> {
  const project = repo.getProject(projectId);
  if (!project) throw new BookForgeError('NOT_FOUND', 'Project not found', 404);

  if (project.publicationState !== 'READY_FOR_PUBLISH' &&
      project.publicationState !== 'PAYMENT_REQUIRED') {
    throw new PreconditionError('Project is not ready for publication', {
      publicationState: project.publicationState,
    });
  }

  const config = env();
  const amountCents = Math.round(config.BOOK_PUBLISHING_PRICE_USD * 100);
  const currency = config.BOOK_PUBLISHING_CURRENCY;

  repo.updateProject(projectId, {
    publicationState: 'PAYMENT_REQUIRED',
    status: 'payment_required',
  });

  if (!isStripeConfigured(config)) {
    // Without Stripe keys the service still exercises the publication flow.
    // The confirm endpoint stands in for the webhook; it is refused in production.
    const sessionId = `dev_${newId()}`;
    repo.createPayment({
      projectId, provider: 'dev', sessionId, amountCents, currency,
    });
    return {
      sessionId,
      url: `${config.APP_BASE_URL}/checkout/dev?session=${sessionId}`,
      amountCents,
      currency,
      provider: 'dev',
    };
  }

  const session = await client().checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency,
          unit_amount: amountCents,
          product_data: {
            name: `BookForgeAI publication — ${project.title}`,
            description: 'Publication of one completed book, delivered as a print-ready PDF.',
          },
        },
      },
    ],
    metadata: { projectId },
    success_url: `${config.APP_BASE_URL}/?published=${projectId}`,
    cancel_url: `${config.APP_BASE_URL}/?cancelled=${projectId}`,
  });

  repo.createPayment({
    projectId, provider: 'stripe', sessionId: session.id, amountCents, currency,
  });

  if (!session.url) {
    throw new BookForgeError('CHECKOUT_FAILED', 'Stripe returned no checkout URL', 502);
  }
  return { sessionId: session.id, url: session.url, amountCents, currency, provider: 'stripe' };
}

/**
 * SECURITY.md: only a verified webhook unlocks publication. The signature is
 * checked against the raw request body before anything is trusted.
 */
export function verifyWebhook(rawBody: Buffer, signature: string): Stripe.Event {
  const config = env();
  if (!config.STRIPE_WEBHOOK_SECRET) {
    throw new BookForgeError('WEBHOOK_NOT_CONFIGURED', 'STRIPE_WEBHOOK_SECRET is not set', 503);
  }
  try {
    return client().webhooks.constructEvent(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    throw new BookForgeError(
      'WEBHOOK_INVALID',
      `Webhook signature verification failed: ${error instanceof Error ? error.message : ''}`,
      400,
    );
  }
}

/** Idempotent: replaying a webhook confirms the payment exactly once. */
export function confirmPayment(sessionId: string): repo.ProjectRow | null {
  const payment = repo.confirmPaymentBySession(sessionId);
  if (!payment) return null;

  const project = repo.getProject(payment.projectId);
  if (!project) return null;

  if (project.publicationState === 'PAYMENT_REQUIRED') {
    repo.updateProject(project.id, { publicationState: 'PAID' });
    repo.recordEvent({
      projectId: project.id,
      type: 'PAYMENT_CONFIRMED',
      actor: 'system',
      payload: { sessionId, amountCents: payment.amountCents },
    });
  }
  return repo.getProject(project.id);
}
