/**
 * BILLING.md — the $100 is the BookForgeAI publishing charge, not a claim about
 * underlying costs. Usage is metered separately so contribution margin can be
 * computed per book.
 *
 * Everything the vendor bills differently is recorded separately: cached
 * input is discounted, reasoning tokens sit inside output, images bill by
 * token on gpt-image models (image and text input at different rates), and
 * batched requests carry their own multiplier. Rates are operator-supplied
 * from the vendor's pricing page and default to zero, so an unconfigured
 * install reports payment fees and nothing else rather than a number that
 * looks real and is not.
 */
export interface UsageRecord {
  textInputTokens: number;
  /** Subset of textInputTokens served from the prompt cache. */
  cachedInputTokens: number;
  textOutputTokens: number;
  /** Subset of textOutputTokens spent thinking; recorded for visibility, not priced separately. */
  reasoningTokens: number;
  /** Chat completions actually sent, including schema-repair retries. */
  modelCalls: number;
  /** Images actually delivered. */
  imageGenerations: number;
  /** Image API calls made, including an edit that failed before a fallback render. */
  imageCalls: number;
  /** Reference images actually accepted by the image model as inputs (a count, billed via tokens). */
  imageInputImages: number;
  /** Image-input tokens (reference images) on gpt-image models. */
  imageInputTokens: number;
  /** Text-input tokens (the prompt) on gpt-image models; billed at a different rate. */
  imageTextInputTokens: number;
  imageOutputTokens: number;
  /** Subsets of the text tokens that went through the Batch API. */
  batchedInputTokens: number;
  batchedOutputTokens: number;
  storageGbMonths: number;
  /** Wall-clock seconds the job occupied a worker slot. */
  computeSeconds: number;
  /** Seconds of that spent waiting on the model vendor. */
  modelLatencySeconds: number;
}

export const EMPTY_USAGE: UsageRecord = {
  textInputTokens: 0,
  cachedInputTokens: 0,
  textOutputTokens: 0,
  reasoningTokens: 0,
  modelCalls: 0,
  imageGenerations: 0,
  imageCalls: 0,
  imageInputImages: 0,
  imageInputTokens: 0,
  imageTextInputTokens: 0,
  imageOutputTokens: 0,
  batchedInputTokens: 0,
  batchedOutputTokens: 0,
  storageGbMonths: 0,
  computeSeconds: 0,
  modelLatencySeconds: 0,
};

export function addUsage(a: UsageRecord, b: Partial<UsageRecord>): UsageRecord {
  const out = { ...a };
  for (const key of Object.keys(EMPTY_USAGE) as (keyof UsageRecord)[]) {
    out[key] = a[key] + (b[key] ?? 0);
  }
  return out;
}

/** True when any field is non-zero — i.e. the record represents real spend. */
export function hasSpend(usage: Partial<UsageRecord>): boolean {
  return (Object.keys(EMPTY_USAGE) as (keyof UsageRecord)[]).some((k) => (usage[k] ?? 0) > 0);
}

/** Which price list a line is billed against. */
export type PriceTier = 'text' | 'light' | 'image' | 'unknown';

/**
 * A ledger line: usage attributed to one agent on one model in one mode.
 * `calls` counts jobs; `failedCalls` those whose spend bought no artifact.
 */
export interface UsageLine extends UsageRecord {
  agent: string;
  capability: string | null;
  model: string | null;
  mode: 'sync' | 'batch';
  calls: number;
  failedCalls: number;
}

/**
 * Unit prices in USD per million tokens, or per image. Operator-supplied from
 * the vendor's pricing page; never hard-coded here.
 */
export interface CostRates {
  textInputPerMillionTokens: number;
  /** Zero means "not entered": cached tokens then bill at the full input rate rather than free. */
  textCachedInputPerMillionTokens: number;
  textOutputPerMillionTokens: number;
  lightInputPerMillionTokens: number;
  lightCachedInputPerMillionTokens: number;
  lightOutputPerMillionTokens: number;
  imageInputPerMillionTokens: number;
  /** Zero means "not entered": text input to the image model then bills at the image-input rate. */
  imageTextInputPerMillionTokens: number;
  imageOutputPerMillionTokens: number;
  /** Flat per-delivered-image fallback for models that do not report image tokens. */
  perImageGeneration: number;
  /** Multiplier applied to batched tokens, e.g. 0.5 for a 50% batch discount. */
  batchMultiplier: number;
  storagePerGbMonth: number;
  computePerHour: number;
  /** Payment processing: a fraction of revenue plus a fixed fee. */
  paymentPercent: number;
  paymentFixed: number;
}

/** All zero except payment fees, so the margin view is honest before configuration. */
export const DEFAULT_RATES: CostRates = {
  textInputPerMillionTokens: 0,
  textCachedInputPerMillionTokens: 0,
  textOutputPerMillionTokens: 0,
  lightInputPerMillionTokens: 0,
  lightCachedInputPerMillionTokens: 0,
  lightOutputPerMillionTokens: 0,
  imageInputPerMillionTokens: 0,
  imageTextInputPerMillionTokens: 0,
  imageOutputPerMillionTokens: 0,
  perImageGeneration: 0,
  batchMultiplier: 1,
  storagePerGbMonth: 0,
  computePerHour: 0,
  paymentPercent: 0.029,
  paymentFixed: 0.3,
};

/** True once any rate other than payment fees is non-zero; the UI says so either way. */
export function ratesConfigured(rates: CostRates): boolean {
  return (
    rates.textInputPerMillionTokens > 0 ||
    rates.textCachedInputPerMillionTokens > 0 ||
    rates.textOutputPerMillionTokens > 0 ||
    rates.lightInputPerMillionTokens > 0 ||
    rates.lightCachedInputPerMillionTokens > 0 ||
    rates.lightOutputPerMillionTokens > 0 ||
    rates.imageInputPerMillionTokens > 0 ||
    rates.imageTextInputPerMillionTokens > 0 ||
    rates.imageOutputPerMillionTokens > 0 ||
    rates.perImageGeneration > 0 ||
    rates.storagePerGbMonth > 0 ||
    rates.computePerHour > 0
  );
}

export function tierOf(capability: string | null | undefined): PriceTier {
  switch (capability) {
    case 'reasoning':
    case 'text':
      return 'text';
    case 'light':
      return 'light';
    case 'image':
      return 'image';
    default:
      return 'unknown';
  }
}

export interface LineCost {
  textCost: number;
  imageCost: number;
}

const PER_M = 1 / 1_000_000;

/**
 * Prices one ledger line.
 *
 * - Cached input bills at the cached rate; when no cached rate has been entered
 *   it bills at the full input rate, so an unentered discount is never a free
 *   token.
 * - Batched tokens are a subset of the uncached tokens and carry the batch
 *   multiplier. A token that is both cached and batched is priced once, at the
 *   cached rate: the two discounts are assumed not to stack until measured.
 * - Image tokens bill at the image rates when the model reported them and a
 *   token rate exists; otherwise each *delivered* image bills the flat rate.
 *   Failed calls that delivered nothing are counted in imageCalls, not billed.
 * - Reasoning tokens are inside textOutputTokens and are never priced again.
 * - An `unknown` tier bills at the text rates, the conservative choice.
 */
export function priceLine(line: UsageLine, rates: CostRates): LineCost {
  const tier = tierOf(line.capability);

  const [inRate, cachedEntered, outRate] = tier === 'light'
    ? [rates.lightInputPerMillionTokens, rates.lightCachedInputPerMillionTokens, rates.lightOutputPerMillionTokens]
    : [rates.textInputPerMillionTokens, rates.textCachedInputPerMillionTokens, rates.textOutputPerMillionTokens];
  const cachedRate = cachedEntered > 0 ? cachedEntered : inRate;

  const cached = Math.min(line.cachedInputTokens, line.textInputTokens);
  const uncached = line.textInputTokens - cached;
  const batchedIn = Math.min(line.batchedInputTokens, uncached);
  const batchedOut = Math.min(line.batchedOutputTokens, line.textOutputTokens);

  const inputCost =
    (uncached - batchedIn) * inRate * PER_M +
    batchedIn * inRate * PER_M * rates.batchMultiplier +
    cached * cachedRate * PER_M;
  const outputCost =
    (line.textOutputTokens - batchedOut) * outRate * PER_M +
    batchedOut * outRate * PER_M * rates.batchMultiplier;

  const imageTextRate = rates.imageTextInputPerMillionTokens > 0
    ? rates.imageTextInputPerMillionTokens
    : rates.imageInputPerMillionTokens;
  const tokenRatesEntered =
    rates.imageInputPerMillionTokens > 0 || rates.imageOutputPerMillionTokens > 0;
  const tokensReported =
    line.imageInputTokens > 0 || line.imageTextInputTokens > 0 || line.imageOutputTokens > 0;

  const imageCost = tokensReported && tokenRatesEntered
    ? line.imageInputTokens * rates.imageInputPerMillionTokens * PER_M +
      line.imageTextInputTokens * imageTextRate * PER_M +
      line.imageOutputTokens * rates.imageOutputPerMillionTokens * PER_M
    : line.imageGenerations * rates.perImageGeneration;

  return { textCost: inputCost + outputCost, imageCost };
}

export interface CostBreakdown {
  textCost: number;
  imageCost: number;
  storageCost: number;
  computeCost: number;
  paymentFees: number;
  totalCost: number;
  revenue: number;
  contributionMargin: number;
  marginPercent: number;
  /** False until the operator has entered rates; the UI must say so. */
  ratesConfigured: boolean;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Margin from priced ledger lines — the accurate path once rates exist. */
export function marginFromLines(
  lines: readonly UsageLine[],
  rates: CostRates,
  revenue: number,
): CostBreakdown {
  let textCost = 0;
  let imageCost = 0;
  let storageGbMonths = 0;
  let computeSeconds = 0;
  for (const line of lines) {
    const cost = priceLine(line, rates);
    textCost += cost.textCost;
    imageCost += cost.imageCost;
    storageGbMonths += line.storageGbMonths;
    computeSeconds += line.computeSeconds;
  }
  return finish(textCost, imageCost, storageGbMonths, computeSeconds, rates, revenue);
}

/**
 * Margin from an aggregate record. Everything is priced at the text tier
 * because an aggregate cannot say which model produced which token; use
 * marginFromLines for a mixed fleet.
 */
export function computeMargin(
  usage: UsageRecord,
  rates: CostRates,
  revenue: number,
): CostBreakdown {
  const line: UsageLine = {
    ...usage, agent: 'all', capability: 'text', model: null, mode: 'sync', calls: 0, failedCalls: 0,
  };
  const cost = priceLine(line, rates);
  return finish(cost.textCost, cost.imageCost, usage.storageGbMonths, usage.computeSeconds, rates, revenue);
}

function finish(
  textCost: number,
  imageCost: number,
  storageGbMonths: number,
  computeSeconds: number,
  rates: CostRates,
  revenue: number,
): CostBreakdown {
  const storageCost = storageGbMonths * rates.storagePerGbMonth;
  const computeCost = (computeSeconds / 3600) * rates.computePerHour;
  const paymentFees = revenue > 0 ? revenue * rates.paymentPercent + rates.paymentFixed : 0;
  const totalCost = textCost + imageCost + storageCost + computeCost + paymentFees;
  const contributionMargin = revenue - totalCost;

  return {
    textCost: round2(textCost),
    imageCost: round2(imageCost),
    storageCost: round2(storageCost),
    computeCost: round2(computeCost),
    paymentFees: round2(paymentFees),
    totalCost: round2(totalCost),
    revenue: round2(revenue),
    contributionMargin: round2(contributionMargin),
    marginPercent: revenue > 0 ? round2((contributionMargin / revenue) * 100) : 0,
    ratesConfigured: ratesConfigured(rates),
  };
}
