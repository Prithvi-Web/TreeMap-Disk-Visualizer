/**
 * costIntelligence — what your storage actually costs (§C1).
 *
 * **The table ships with the app and is updated by normal releases. Nothing
 * here ever fetches a price.** TreeMap makes no outbound request at all, and a
 * cost feature is not a good enough reason to break that. The consequence is
 * that prices go stale, so the "as of" date travels with every answer and the
 * UI shows it — a visibly stale price is honest; a silently stale one is not.
 *
 * Every figure below was taken from each provider's public consumer pricing
 * page on the date in `PRICING_AS_OF`. Tiers are the paid consumer plans plus
 * the free allowance, which is what makes "you would need to upgrade" answerable.
 */

export type CostCurrency = 'USD' | 'EUR' | 'GBP' | 'INR' | 'AUD' | 'CAD';

export interface PricingTier {
  /** Storage included, in bytes. */
  bytes: number;
  /** Monthly price in the provider's home currency (USD for all four here). */
  monthlyUsd: number;
  label: string;
}

export interface ProviderPricing {
  id: string;
  name: string;
  /** Where the numbers came from, so a human can check them. */
  source: string;
  tiers: PricingTier[];
}

const GB = 1000 ** 3; // Storage providers sell decimal GB, not GiB.
const TB = 1000 ** 4;

/** The date every price below was read from the provider's own pricing page. */
export const PRICING_AS_OF = '2026-07-01';

export const PROVIDER_PRICING: ProviderPricing[] = [
  {
    id: 'gdrive',
    name: 'Google Drive (Google One)',
    source: 'one.google.com/about/plans',
    tiers: [
      { bytes: 15 * GB, monthlyUsd: 0, label: 'Free — 15 GB' },
      { bytes: 100 * GB, monthlyUsd: 1.99, label: 'Basic — 100 GB' },
      { bytes: 200 * GB, monthlyUsd: 2.99, label: 'Standard — 200 GB' },
      { bytes: 2 * TB, monthlyUsd: 9.99, label: 'Premium — 2 TB' },
      { bytes: 5 * TB, monthlyUsd: 24.99, label: 'Premium — 5 TB' },
      { bytes: 10 * TB, monthlyUsd: 49.99, label: 'Premium — 10 TB' },
    ],
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    source: 'dropbox.com/plans',
    tiers: [
      { bytes: 2 * GB, monthlyUsd: 0, label: 'Basic — 2 GB' },
      { bytes: 2 * TB, monthlyUsd: 11.99, label: 'Plus — 2 TB' },
      { bytes: 3 * TB, monthlyUsd: 19.99, label: 'Essentials — 3 TB' },
      { bytes: 9 * TB, monthlyUsd: 18.0, label: 'Business — 9 TB (per user, 3+ users)' },
    ],
  },
  {
    id: 'onedrive',
    name: 'OneDrive (Microsoft 365)',
    source: 'microsoft.com/microsoft-365/onedrive/compare-onedrive-plans',
    tiers: [
      { bytes: 5 * GB, monthlyUsd: 0, label: 'Free — 5 GB' },
      { bytes: 100 * GB, monthlyUsd: 1.99, label: 'Basic — 100 GB' },
      { bytes: 1 * TB, monthlyUsd: 6.99, label: 'Personal — 1 TB' },
      { bytes: 6 * TB, monthlyUsd: 9.99, label: 'Family — 6 TB (shared by up to 6)' },
    ],
  },
  {
    id: 'icloud',
    name: 'iCloud+',
    source: 'support.apple.com/en-us/HT201238',
    tiers: [
      { bytes: 5 * GB, monthlyUsd: 0, label: 'Free — 5 GB' },
      { bytes: 50 * GB, monthlyUsd: 0.99, label: '50 GB' },
      { bytes: 200 * GB, monthlyUsd: 2.99, label: '200 GB' },
      { bytes: 2 * TB, monthlyUsd: 9.99, label: '2 TB' },
      { bytes: 6 * TB, monthlyUsd: 29.99, label: '6 TB' },
      { bytes: 12 * TB, monthlyUsd: 59.99, label: '12 TB' },
    ],
  },
];

/**
 * Conversion from USD, for display only.
 *
 * These are round approximations, not live rates — the same no-network rule
 * applies. The UI must therefore never present a converted figure as an exact
 * price, and `approximate` is true for every currency but USD so it cannot.
 */
const RATE_FROM_USD: Record<CostCurrency, number> = {
  USD: 1, EUR: 0.92, GBP: 0.79, INR: 83, AUD: 1.52, CAD: 1.36,
};
const SYMBOL: Record<CostCurrency, string> = {
  USD: '$', EUR: '€', GBP: '£', INR: '₹', AUD: 'A$', CAD: 'C$',
};

export interface TierFit {
  /** The cheapest tier that holds `bytes`, or null if none does. */
  tier: PricingTier | null;
  monthly: number;
  annual: number;
  /** True when the data exceeds every tier the provider sells. */
  exceedsLargestTier: boolean;
}

/** The cheapest tier that fits `bytes`. Tiers are searched in ascending size. */
export function fitTier(provider: ProviderPricing, bytes: number): TierFit {
  const sorted = [...provider.tiers].sort((a, b) => a.bytes - b.bytes);
  const tier = sorted.find((t) => t.bytes >= bytes) ?? null;
  return {
    tier,
    monthly: tier ? tier.monthlyUsd : 0,
    annual: tier ? tier.monthlyUsd * 12 : 0,
    exceedsLargestTier: tier === null,
  };
}

export interface ProviderEstimate {
  providerId: string;
  providerName: string;
  source: string;
  bytes: number;
  current: TierFit;
  /** What the same data would cost after removing `freeableBytes`. */
  afterCleanup: TierFit | null;
  /** Monthly saving, in USD, from dropping to a cheaper tier. Never negative. */
  monthlySavingUsd: number;
  annualSavingUsd: number;
  /** True when cleaning up changes nothing, because the tier does not change. */
  sameTierAfterCleanup: boolean;
}

export interface CostEstimate {
  asOf: string;
  currency: CostCurrency;
  symbol: string;
  /** False for every currency but USD: converted figures are approximations. */
  approximate: boolean;
  rateFromUsd: number;
  providers: ProviderEstimate[];
}

/**
 * True only for a currency the shipped rate table actually owns.
 *
 * This must be an OWN-property test, never `in`. `in` walks the prototype
 * chain, so 'constructor', 'toString', 'valueOf', 'hasOwnProperty' and
 * '__proto__' all answer true for a plain object literal — and this guard is
 * the only thing between `?currency=` on /api/cost/estimate and the two tables
 * below. With `in`, `?currency=constructor` was approved, indexed RATE_FROM_USD
 * to the Object constructor *function*, and served 200 with a currency whose
 * symbol and rate vanished from the JSON entirely (stringify drops functions).
 */
export function isCurrency(value: unknown): value is CostCurrency {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RATE_FROM_USD, value);
}

/**
 * Cost for `bytes` of data across every shipped provider, plus what it would
 * cost after freeing `freeableBytes`.
 *
 * The what-if is the useful half: "you would drop from the 2 TB plan to the
 * 200 GB plan and save $7/month" is actionable in a way that "you are using
 * 340 GB" is not.
 */
export function estimateCost(bytes: number, freeableBytes: number, currency: CostCurrency = 'USD'): CostEstimate {
  // Defence in depth behind `isCurrency`. The parameter is typed, but the value
  // arrives from a query string, and a type is not a runtime check: any caller
  // that forgets the guard would otherwise index the two tables below with an
  // arbitrary string and hand back a function (from Object.prototype) or
  // undefined as this answer's symbol and rate. Falling back to the documented
  // USD default keeps the answer internally consistent — the currency named in
  // the response is always the one its symbol and rate belong to.
  const safe: CostCurrency = isCurrency(currency) ? currency : 'USD';
  const after = Math.max(0, bytes - Math.max(0, freeableBytes));
  const providers: ProviderEstimate[] = PROVIDER_PRICING.map((provider) => {
    const current = fitTier(provider, bytes);
    const afterCleanup = freeableBytes > 0 ? fitTier(provider, after) : null;
    // A saving only exists if the TIER changes. Freeing 3 GB inside a 2 TB plan
    // saves nothing, and saying otherwise would be the whole feature lying.
    const monthlySavingUsd = afterCleanup ? Math.max(0, current.monthly - afterCleanup.monthly) : 0;
    return {
      providerId: provider.id,
      providerName: provider.name,
      source: provider.source,
      bytes,
      current,
      afterCleanup,
      monthlySavingUsd,
      annualSavingUsd: monthlySavingUsd * 12,
      sameTierAfterCleanup: Boolean(afterCleanup && afterCleanup.tier?.label === current.tier?.label),
    };
  });

  return {
    asOf: PRICING_AS_OF,
    currency: safe,
    symbol: SYMBOL[safe],
    approximate: safe !== 'USD',
    rateFromUsd: RATE_FROM_USD[safe],
    providers,
  };
}
