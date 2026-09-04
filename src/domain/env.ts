import { z } from 'zod';
import type { CostRates } from './costs.js';

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
  /** Falls back to OPENAI_TEXT_MODEL when blank. */
  OPENAI_REASONING_MODEL: z.string().default(''),
  /**
   * Mechanical agents — restating a spec, applying style rules, filling a
   * template — do not need the frontier model. Routing them here is the single
   * largest cost lever in the pipeline.
   */
  OPENAI_LIGHT_MODEL: z.string().default('gpt-5-mini'),
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-2'),

  /** Reasoning effort per tier. Lower effort means fewer billed thinking tokens. */
  OPENAI_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('medium'),
  OPENAI_TEXT_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('low'),
  OPENAI_LIGHT_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('minimal'),

  /** Image fidelity. `low` is the draft setting and costs a fraction of `high`. */
  OPENAI_IMAGE_QUALITY: z.enum(['low', 'medium', 'high', 'auto']).default('medium'),

  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),

  BOOK_PUBLISHING_PRICE_USD: z.coerce.number().positive().default(100),
  BOOK_PUBLISHING_CURRENCY: z.string().default('usd'),
  MAX_REVISION_CYCLES: z.coerce.number().int().min(1).max(10).default(3),

  /** Concurrent agent jobs per worker loop. */
  AGENT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(3),
  /** Automatic attempts before a job is left for a human to retry. */
  AGENT_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(4),
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

  /**
   * Unit prices, USD per million tokens unless stated. Copied by the operator
   * from the vendor's pricing page for the models actually configured. All
   * default to zero so an unconfigured install reports payment fees only.
   */
  RATE_TEXT_INPUT_PER_M: z.coerce.number().min(0).default(0),
  RATE_TEXT_CACHED_INPUT_PER_M: z.coerce.number().min(0).default(0),
  RATE_TEXT_OUTPUT_PER_M: z.coerce.number().min(0).default(0),
  RATE_LIGHT_INPUT_PER_M: z.coerce.number().min(0).default(0),
  RATE_LIGHT_CACHED_INPUT_PER_M: z.coerce.number().min(0).default(0),
  RATE_LIGHT_OUTPUT_PER_M: z.coerce.number().min(0).default(0),
  RATE_IMAGE_INPUT_PER_M: z.coerce.number().min(0).default(0),
  /** Text-prompt input to the image model; zero falls back to RATE_IMAGE_INPUT_PER_M. */
  RATE_IMAGE_TEXT_INPUT_PER_M: z.coerce.number().min(0).default(0),
  RATE_IMAGE_OUTPUT_PER_M: z.coerce.number().min(0).default(0),
  /** Flat per-image fallback for models that report no image tokens. */
  RATE_PER_IMAGE: z.coerce.number().min(0).default(0),
  /** Multiplier for tokens sent through the Batch API; 1 until measured. */
  RATE_BATCH_MULTIPLIER: z.coerce.number().min(0).max(1).default(1),
  RATE_STORAGE_PER_GB_MONTH: z.coerce.number().min(0).default(0),
  RATE_COMPUTE_PER_HOUR: z.coerce.number().min(0).default(0),
  RATE_PAYMENT_PERCENT: z.coerce.number().min(0).max(1).default(0.029),
  RATE_PAYMENT_FIXED: z.coerce.number().min(0).default(0.3),
});

export type Env = z.infer<typeof EnvSchema>;

/** The operator's price list, from RATE_* variables. */
export function ratesFromEnv(config: Env = env()): CostRates {
  return {
    textInputPerMillionTokens: config.RATE_TEXT_INPUT_PER_M,
    textCachedInputPerMillionTokens: config.RATE_TEXT_CACHED_INPUT_PER_M,
    textOutputPerMillionTokens: config.RATE_TEXT_OUTPUT_PER_M,
    lightInputPerMillionTokens: config.RATE_LIGHT_INPUT_PER_M,
    lightCachedInputPerMillionTokens: config.RATE_LIGHT_CACHED_INPUT_PER_M,
    lightOutputPerMillionTokens: config.RATE_LIGHT_OUTPUT_PER_M,
    imageInputPerMillionTokens: config.RATE_IMAGE_INPUT_PER_M,
    imageTextInputPerMillionTokens: config.RATE_IMAGE_TEXT_INPUT_PER_M,
    imageOutputPerMillionTokens: config.RATE_IMAGE_OUTPUT_PER_M,
    perImageGeneration: config.RATE_PER_IMAGE,
    batchMultiplier: config.RATE_BATCH_MULTIPLIER,
    storagePerGbMonth: config.RATE_STORAGE_PER_GB_MONTH,
    computePerHour: config.RATE_COMPUTE_PER_HOUR,
    paymentPercent: config.RATE_PAYMENT_PERCENT,
    paymentFixed: config.RATE_PAYMENT_FIXED,
  };
}

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
  if (!value.OPENAI_LIGHT_MODEL) value.OPENAI_LIGHT_MODEL = 'gpt-5-mini';
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
export type ModelCapability = 'text' | 'reasoning' | 'light' | 'image';

export function resolveModel(capability: ModelCapability, config: Env = env()): string {
  const model = {
    text: config.OPENAI_TEXT_MODEL,
    reasoning: config.OPENAI_REASONING_MODEL || config.OPENAI_TEXT_MODEL,
    light: config.OPENAI_LIGHT_MODEL,
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

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/** Thinking budget for a tier. Not every model honours it; it is sent best-effort. */
export function resolveEffort(
  capability: ModelCapability,
  config: Env = env(),
): ReasoningEffort | null {
  switch (capability) {
    case 'reasoning': return config.OPENAI_REASONING_EFFORT;
    case 'text': return config.OPENAI_TEXT_EFFORT;
    case 'light': return config.OPENAI_LIGHT_EFFORT;
    default: return null;
  }
}
