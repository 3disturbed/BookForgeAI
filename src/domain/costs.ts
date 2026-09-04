/**
 * BILLING.md — the $100 is the BookForgeAI publishing charge, not a claim about
 * underlying costs. Usage is metered separately so contribution margin can be
 * computed per book.
 */
export interface UsageRecord {
  textInputTokens: number;
  textOutputTokens: number;
  imageGenerations: number;
  imageInputImages: number;
  storageGbMonths: number;
  computeSeconds: number;
}

export const EMPTY_USAGE: UsageRecord = {
  textInputTokens: 0,
  textOutputTokens: 0,
  imageGenerations: 0,
  imageInputImages: 0,
  storageGbMonths: 0,
  computeSeconds: 0,
};

/**
 * Unit costs in USD. Operator-supplied rates, not published vendor prices —
 * keep them in config and revise as contracts change.
 */
export interface CostRates {
  textInputPerMillionTokens: number;
  textOutputPerMillionTokens: number;
  perImageGeneration: number;
  perImageInput: number;
  storagePerGbMonth: number;
  computePerHour: number;
  /** Payment processing: a fraction of revenue plus a fixed fee. */
  paymentPercent: number;
  paymentFixed: number;
}

/** Placeholder rates so the margin view renders before rates are configured. */
export const DEFAULT_RATES: CostRates = {
  textInputPerMillionTokens: 0,
  textOutputPerMillionTokens: 0,
  perImageGeneration: 0,
  perImageInput: 0,
  storagePerGbMonth: 0,
  computePerHour: 0,
  paymentPercent: 0.029,
  paymentFixed: 0.3,
};

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
}

export function addUsage(a: UsageRecord, b: Partial<UsageRecord>): UsageRecord {
  return {
    textInputTokens: a.textInputTokens + (b.textInputTokens ?? 0),
    textOutputTokens: a.textOutputTokens + (b.textOutputTokens ?? 0),
    imageGenerations: a.imageGenerations + (b.imageGenerations ?? 0),
    imageInputImages: a.imageInputImages + (b.imageInputImages ?? 0),
    storageGbMonths: a.storageGbMonths + (b.storageGbMonths ?? 0),
    computeSeconds: a.computeSeconds + (b.computeSeconds ?? 0),
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function computeMargin(
  usage: UsageRecord,
  rates: CostRates,
  revenue: number,
): CostBreakdown {
  const textCost =
    (usage.textInputTokens / 1_000_000) * rates.textInputPerMillionTokens +
    (usage.textOutputTokens / 1_000_000) * rates.textOutputPerMillionTokens;

  const imageCost =
    usage.imageGenerations * rates.perImageGeneration +
    usage.imageInputImages * rates.perImageInput;

  const storageCost = usage.storageGbMonths * rates.storagePerGbMonth;
  const computeCost = (usage.computeSeconds / 3600) * rates.computePerHour;
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
  };
}
