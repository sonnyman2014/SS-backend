import { DataSource } from "typeorm";
import { TtlCache } from "../lib/ttl-cache";

export const INSURANCE_CACHE_TTL_SECONDS = 60;

export interface InsurancePolicy {
  invoiceId: string;
  wallet: string;
  isActive: boolean;
  coverageBps: number;
  premiumPaid: string;
  /** Policy expiration timestamp in Unix epoch seconds (UTC). */
  expiry: number;
  /** Policy purchase timestamp in Unix epoch seconds (UTC). */
  purchasedAt: number;
}

export interface InsurancePayout {
  invoiceId: string;
  wallet: string;
  amount: string;
  /** Payout trigger timestamp in Unix epoch seconds (UTC). */
  triggerDate: number;
  txHash: string;
}

export interface InvoiceInsuranceResponse {
  isActive: boolean;
  coverageBps: number;
  premiumPaid: string;
  /** Policy expiration timestamp in Unix epoch seconds (UTC). */
  expiry: number;
}

export interface InvoiceInsuranceServiceOptions {
  cache?: TtlCache;
  ttlSeconds?: number;
  /** Injectable clock returning Unix epoch milliseconds (defaults to Date.now). */
  now?: () => number;
}

interface InvoiceInsuranceRow {
  is_active: boolean;
  coverage_bps: number;
  premium_paid: string;
  expiry: number | string | null | undefined;
}

interface InsurancePolicyRow extends InvoiceInsuranceRow {
  invoice_id: string;
  wallet: string;
  purchased_at: number | string | null | undefined;
}

interface InsurancePayoutRow {
  invoice_id: string;
  wallet: string;
  amount: string;
  trigger_date: number | string | null | undefined;
  tx_hash: string;
}

/**
 * Normalizes a stored BIGINT timestamp to integer Unix epoch seconds.
 *
 * Policy on zero or missing values:
 * - Stored `expiry` values represent fixed-term Soroban ledger timestamps in
 *   Unix epoch seconds (`env.ledger().timestamp()`).
 * - Missing (`null` / `undefined`), non-numeric, or non-positive (`<= 0`)
 *   timestamps normalize to `0`, which has no active coverage window and is
 *   always treated as inactive by `isPolicyEffectivelyActive`.
 */
export function normalizeUnixSeconds(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const numeric = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.floor(numeric);
}

/**
 * Evaluates effective insurance policy activity at `nowMs` (Unix epoch ms).
 *
 * Effective activity rule:
 * 1. `storedIsActive` must be `true`.
 * 2. `expiry` (in Unix epoch seconds) must be a positive finite integer (`> 0`);
 *    zero or missing expiry values are treated as inactive (fail-closed).
 * 3. Current time must be strictly before the expiry boundary
 *    (`nowMs < expirySeconds * 1000`). At the exact boundary
 *    (`nowMs === expirySeconds * 1000`) and beyond, the policy is inactive.
 */
export function isPolicyEffectivelyActive(
  storedIsActive: boolean,
  expiry: unknown,
  nowMs: number = Date.now()
): boolean {
  if (!storedIsActive) {
    return false;
  }
  const expirySeconds = normalizeUnixSeconds(expiry);
  if (expirySeconds <= 0) {
    return false;
  }
  return nowMs < expirySeconds * 1000;
}

/**
 * Computes the cache TTL (in whole seconds) so active policy entries never
 * outlive their earliest upcoming expiry window beyond sub-second rounding.
 * Read-time re-evaluation still enforces exact millisecond boundary accuracy.
 */
function computeEffectiveCacheTtlSeconds(
  activeExpiriesSeconds: number[],
  nowMs: number,
  maxTtlSeconds: number
): number {
  if (activeExpiriesSeconds.length === 0) {
    return maxTtlSeconds;
  }
  const earliestExpiryMs = Math.min(...activeExpiriesSeconds) * 1000;
  const remainingMs = earliestExpiryMs - nowMs;
  if (remainingMs <= 0) {
    return 0;
  }
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  return Math.max(1, Math.min(maxTtlSeconds, remainingSeconds));
}

/**
 * #680 / #777 - Invoice insurance indexer and policy status REST API.
 * Indexes InsurancePurchased and InsurancePayoutTriggered events and evaluates
 * time-dependent policy expiration across uncached and cached reads.
 */
export class InvoiceInsuranceService {
  private readonly cache: TtlCache;
  private readonly ttlSeconds: number;
  private readonly now: () => number;

  constructor(
    private readonly dataSource: DataSource,
    options: InvoiceInsuranceServiceOptions = {}
  ) {
    const ttlSeconds = options.ttlSeconds ?? INSURANCE_CACHE_TTL_SECONDS;
    this.ttlSeconds = ttlSeconds;
    this.now = options.now ?? (() => Date.now());
    this.cache =
      options.cache ??
      new TtlCache({
        ttlSeconds,
        namespace: "insurance",
        now: () => this.now(),
      });
  }

  async getInvoiceInsurance(
    invoiceId: string,
    wallet: string
  ): Promise<InvoiceInsuranceResponse | null> {
    const cacheKey = `invoice:${invoiceId}:${wallet}`;
    const nowMs = this.now();
    const cached = await this.cache.get<InvoiceInsuranceResponse>(cacheKey);
    if (cached) {
      const normalizedExpiry = normalizeUnixSeconds(cached.expiry);
      const effectiveActive = isPolicyEffectivelyActive(
        Boolean(cached.isActive),
        normalizedExpiry,
        nowMs
      );
      if (effectiveActive === cached.isActive && normalizedExpiry === cached.expiry) {
        return cached;
      }
      const recomputed: InvoiceInsuranceResponse = {
        ...cached,
        expiry: normalizedExpiry,
        isActive: effectiveActive,
      };
      await this.cache.set(cacheKey, recomputed, this.ttlSeconds);
      return recomputed;
    }

    const row = (await this.dataSource.query(
      `SELECT is_active, coverage_bps, premium_paid, expiry
       FROM invoice_insurance WHERE invoice_id = $1 AND wallet = $2`,
      [invoiceId, wallet]
    )) as InvoiceInsuranceRow[];

    if (!row.length) return null;

    const expiry = normalizeUnixSeconds(row[0].expiry);
    const isActive = isPolicyEffectivelyActive(Boolean(row[0].is_active), expiry, nowMs);

    const result: InvoiceInsuranceResponse = {
      isActive,
      coverageBps: Number(row[0].coverage_bps),
      premiumPaid: String(row[0].premium_paid),
      expiry,
    };

    const ttl = computeEffectiveCacheTtlSeconds(isActive ? [expiry] : [], nowMs, this.ttlSeconds);
    if (ttl > 0) {
      await this.cache.set(cacheKey, result, ttl);
    }
    return result;
  }

  async getWalletActivePolicies(wallet: string): Promise<InsurancePolicy[]> {
    const cacheKey = `wallet:${wallet}`;
    const nowMs = this.now();
    const cached = await this.cache.get<InsurancePolicy[]>(cacheKey);
    if (cached) {
      const activeCached = cached
        .map((policy) => ({
          ...policy,
          expiry: normalizeUnixSeconds(policy.expiry),
          purchasedAt: normalizeUnixSeconds(policy.purchasedAt),
        }))
        .filter((policy) => isPolicyEffectivelyActive(policy.isActive, policy.expiry, nowMs));

      if (activeCached.length !== cached.length) {
        const ttl = computeEffectiveCacheTtlSeconds(
          activeCached.map((p) => p.expiry),
          nowMs,
          this.ttlSeconds
        );
        if (ttl > 0) {
          await this.cache.set(cacheKey, activeCached, ttl);
        } else {
          await this.cache.delete(cacheKey);
        }
      }
      return activeCached;
    }

    const rows = (await this.dataSource.query(
      `SELECT invoice_id, wallet, is_active, coverage_bps, premium_paid, expiry, purchased_at
       FROM invoice_insurance WHERE wallet = $1 AND is_active = true`,
      [wallet]
    )) as InsurancePolicyRow[];

    const policies: InsurancePolicy[] = [];
    for (const row of rows) {
      const expiry = normalizeUnixSeconds(row.expiry);
      if (!isPolicyEffectivelyActive(Boolean(row.is_active), expiry, nowMs)) {
        continue;
      }
      policies.push({
        invoiceId: row.invoice_id,
        wallet: row.wallet,
        isActive: true,
        coverageBps: Number(row.coverage_bps),
        premiumPaid: String(row.premium_paid),
        expiry,
        purchasedAt: normalizeUnixSeconds(row.purchased_at),
      });
    }

    const ttl = computeEffectiveCacheTtlSeconds(
      policies.map((p) => p.expiry),
      nowMs,
      this.ttlSeconds
    );
    if (ttl > 0) {
      await this.cache.set(cacheKey, policies, ttl);
    }
    return policies;
  }

  async getWalletPayoutHistory(wallet: string): Promise<InsurancePayout[]> {
    const cacheKey = `payouts:${wallet}`;
    const cached = await this.cache.get<InsurancePayout[]>(cacheKey);
    if (cached) return cached;

    const rows = (await this.dataSource.query(
      `SELECT invoice_id, wallet, amount, trigger_date, tx_hash
       FROM insurance_payouts WHERE wallet = $1 ORDER BY trigger_date DESC`,
      [wallet]
    )) as InsurancePayoutRow[];

    const payouts = rows.map((row) => ({
      invoiceId: row.invoice_id,
      wallet: row.wallet,
      amount: String(row.amount),
      triggerDate: normalizeUnixSeconds(row.trigger_date),
      txHash: row.tx_hash,
    }));

    await this.cache.set(cacheKey, payouts);
    return payouts;
  }

  /** Invalidate cache for a wallet/invoice pair when an insurance event occurs. */
  async invalidate(invoiceId: string, wallet: string): Promise<void> {
    await Promise.all([
      this.cache.delete(`invoice:${invoiceId}:${wallet}`),
      this.cache.delete(`wallet:${wallet}`),
      this.cache.delete(`payouts:${wallet}`),
    ]);
  }
}
