import { z } from 'zod';

/**
 * Runtime configuration (config/example.env).
 *
 * The MVP runs with zero external infrastructure: SQLite on disk, blobs on the
 * local filesystem, an in-process queue. Postgres / Redis / S3 / Stripe are
 * opt-in by setting their variables.
 *
 * SECURITY.md: OpenAI and payment keys stay server-side. This module must never
 * be imported by anything served to a browser.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().default(''),

  /** Root for SQLite plus local blob storage. */
  DATA_DIR: z.string().default('./data'),

  /** Optional Postgres / Redis / S3 upgrades. Empty means "use the local default". */
  DATABASE_URL: z.string().default(''),
  REDIS_URL: z.string().default(''),
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('bookforgeai'),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),

  OPENAI_API_KEY: z.string().default(''),
  OPENAI_BASE_URL: z.string().default(''),
  OPENAI_TEXT_MODEL: z.string().default('gpt-5'),
  OPENAI_REASONING_MODEL: z.string().default(''),
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-2'),

  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),

  BOOK_PUBLISHING_PRICE_USD: z.coerce.number().positive().default(100),
  BOOK_PUBLISHING_CURRENCY: z.string().default('usd'),
  MAX_REVISION_CYCLES: z.coerce.number().int().min(1).max(10).default(3),

  /** Concurrent agent jobs per worker loop. */
  AGENT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(3),
  /** Signed download URLs are short lived (SECURITY.md). */
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),

  /**
   * Generate illustrations. Image generation dominates cost, so it can be
   * turned off while exercising the text pipeline.
   */
  ENABLE_ILLUSTRATIONS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  const value = parsed.data;
  if (!value.APP_BASE_URL) value.APP_BASE_URL = `http://localhost:${value.PORT}`;
  // A variable present but blank in .env should fall back to the default rather
  // than override it with an empty string.
  if (!value.OPENAI_TEXT_MODEL) value.OPENAI_TEXT_MODEL = 'gpt-5';
  if (!value.OPENAI_IMAGE_MODEL) value.OPENAI_IMAGE_MODEL = 'gpt-image-2';
  return value;
}

/** Process-wide config, parsed once. */
export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test seam. */
export function resetEnvCache(): void {
  cached = null;
}

export function isStripeConfigured(config: Env = env()): boolean {
  return Boolean(config.STRIPE_SECRET_KEY);
}

export function isOpenAiConfigured(config: Env = env()): boolean {
  return Boolean(config.OPENAI_API_KEY);
}

/**
 * Model routing. AGENTS.md: "Do not hard-code a model name into business logic."
 * Agents declare a capability; the concrete model comes from config.
 */
export type ModelCapability = 'text' | 'reasoning' | 'image';

export function resolveModel(capability: ModelCapability, config: Env = env()): string {
  const model = {
    text: config.OPENAI_TEXT_MODEL,
    reasoning: config.OPENAI_REASONING_MODEL || config.OPENAI_TEXT_MODEL,
    image: config.OPENAI_IMAGE_MODEL,
  }[capability];

  if (!model) {
    throw new Error(
      `No model configured for capability "${capability}". ` +
        `Set OPENAI_${capability.toUpperCase()}_MODEL in the environment.`,
    );
  }
  return model;
}
