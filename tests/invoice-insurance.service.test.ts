import { DataSource } from "typeorm";
import { TtlCache } from "../src/lib/ttl-cache";
import {
  InvoiceInsuranceService,
  isPolicyEffectivelyActive,
  normalizeUnixSeconds,
} from "../src/services/invoice-insurance.service";

describe("InvoiceInsuranceService (#777)", () => {
  const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV";
  const BASE_SECONDS = 1_760_000_000;
  const BASE_MS = BASE_SECONDS * 1000;

  let queryMock: jest.Mock;
  let dataSource: DataSource;

  beforeEach(() => {
    queryMock = jest.fn();
    dataSource = { query: queryMock } as unknown as DataSource;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("normalizeUnixSeconds and isPolicyEffectivelyActive", () => {
    it("normalizes numbers, numeric strings, and bigints to Unix epoch seconds", () => {
      expect(normalizeUnixSeconds(1_760_000_120)).toBe(1_760_000_120);
      expect(normalizeUnixSeconds("1760000120")).toBe(1_760_000_120);
      expect(normalizeUnixSeconds(1_760_000_120n)).toBe(1_760_000_120);
      expect(normalizeUnixSeconds(1_760_000_120.9)).toBe(1_760_000_120);
    });

    it("treats zero, negative, missing, and non-numeric expiry values as 0 and inactive", () => {
      for (const invalid of [0, "0", -1, "-100", null, undefined, "", "not-a-number", NaN]) {
        expect(normalizeUnixSeconds(invalid)).toBe(0);
        expect(isPolicyEffectivelyActive(true, invalid, BASE_MS)).toBe(false);
      }
    });

    it("evaluates active status before, at exact boundary, and after expiry", () => {
      const expiry = BASE_SECONDS + 30;
      expect(isPolicyEffectivelyActive(true, expiry, expiry * 1000 - 1)).toBe(true);
      expect(isPolicyEffectivelyActive(true, expiry, expiry * 1000)).toBe(false);
      expect(isPolicyEffectivelyActive(true, expiry, expiry * 1000 + 1)).toBe(false);
      expect(isPolicyEffectivelyActive(false, expiry, expiry * 1000 - 10_000)).toBe(false);
    });
  });

  describe("getInvoiceInsurance", () => {
    it("returns null when no policy exists for the invoice and wallet", async () => {
      queryMock.mockResolvedValueOnce([]);
      const service = new InvoiceInsuranceService(dataSource, { now: () => BASE_MS });

      await expect(service.getInvoiceInsurance("inv-missing", WALLET)).resolves.toBeNull();
    });

    it("preserves active coverageBps, premiumPaid, and expiry for valid future policies", async () => {
      const futureExpiry = BASE_SECONDS + 300;
      queryMock.mockResolvedValueOnce([
        {
          is_active: true,
          coverage_bps: 8500,
          premium_paid: "125.50",
          expiry: String(futureExpiry),
        },
      ]);

      const service = new InvoiceInsuranceService(dataSource, { now: () => BASE_MS });
      const result = await service.getInvoiceInsurance("inv-1", WALLET);

      expect(result).toEqual({
        isActive: true,
        coverageBps: 8500,
        premiumPaid: "125.50",
        expiry: futureExpiry,
      });
    });

    it("marks single-policy views inactive at the exact expiry boundary and after expiration", async () => {
      const expiry = BASE_SECONDS + 60;
      queryMock
        .mockResolvedValueOnce([
          { is_active: true, coverage_bps: 5000, premium_paid: "40.00", expiry },
        ])
        .mockResolvedValueOnce([
          { is_active: true, coverage_bps: 5000, premium_paid: "40.00", expiry },
        ]);

      let clockMs = expiry * 1000;
      const service = new InvoiceInsuranceService(dataSource, { now: () => clockMs });

      const atBoundary = await service.getInvoiceInsurance("inv-boundary", WALLET);
      expect(atBoundary).toEqual({
        isActive: false,
        coverageBps: 5000,
        premiumPaid: "40.00",
        expiry,
      });

      clockMs = expiry * 1000 + 5_000;
      const pastBoundary = await service.getInvoiceInsurance("inv-past", WALLET);
      expect(pastBoundary).toEqual({
        isActive: false,
        coverageBps: 5000,
        premiumPaid: "40.00",
        expiry,
      });
    });

    it("treats zero or missing expiry as inactive in single-policy views", async () => {
      queryMock
        .mockResolvedValueOnce([
          { is_active: true, coverage_bps: 7500, premium_paid: "55.00", expiry: 0 },
        ])
        .mockResolvedValueOnce([
          { is_active: true, coverage_bps: 7500, premium_paid: "55.00", expiry: null },
        ]);

      const service = new InvoiceInsuranceService(dataSource, { now: () => BASE_MS });

      await expect(service.getInvoiceInsurance("inv-zero", WALLET)).resolves.toEqual({
        isActive: false,
        coverageBps: 7500,
        premiumPaid: "55.00",
        expiry: 0,
      });

      await expect(service.getInvoiceInsurance("inv-null", WALLET)).resolves.toEqual({
        isActive: false,
        coverageBps: 7500,
        premiumPaid: "55.00",
        expiry: 0,
      });
    });

    it("recomputes cached single-policy views across before, exact, and after expiry with fake clock", async () => {
      jest.useFakeTimers();
      jest.setSystemTime(BASE_MS);

      const expiry = BASE_SECONDS + 20; // Expires in 20s, inside the default 60s cache TTL
      queryMock.mockResolvedValue([
        {
          is_active: true,
          coverage_bps: 9000,
          premium_paid: "210.00",
          expiry,
        },
      ]);

      const cache = new TtlCache({
        ttlSeconds: 60,
        namespace: "insurance-test",
        sweepIntervalMs: 0,
      });
      const service = new InvoiceInsuranceService(dataSource, { cache });

      // 1. Before expiry (t = BASE_MS): fetched from DB and cached as active
      const beforeFirst = await service.getInvoiceInsurance("inv-cache", WALLET);
      expect(beforeFirst?.isActive).toBe(true);
      expect(beforeFirst?.coverageBps).toBe(9000);
      expect(queryMock).toHaveBeenCalledTimes(1);

      // 2. Still before expiry (t = expiry - 1ms): served from cache, still active
      jest.setSystemTime(expiry * 1000 - 1);
      const beforeBoundary = await service.getInvoiceInsurance("inv-cache", WALLET);
      expect(beforeBoundary).toEqual({
        isActive: true,
        coverageBps: 9000,
        premiumPaid: "210.00",
        expiry,
      });
      expect(queryMock).toHaveBeenCalledTimes(1);

      // 3. Exact expiry boundary (t = expiry * 1000): cached entry must NOT stay active
      jest.setSystemTime(expiry * 1000);
      const exactBoundary = await service.getInvoiceInsurance("inv-cache", WALLET);
      expect(exactBoundary).toEqual({
        isActive: false,
        coverageBps: 9000,
        premiumPaid: "210.00",
        expiry,
      });

      // 4. After expiry (t = expiry * 1000 + 15_000): remains inactive
      jest.setSystemTime(expiry * 1000 + 15_000);
      const afterExpiry = await service.getInvoiceInsurance("inv-cache", WALLET);
      expect(afterExpiry).toEqual({
        isActive: false,
        coverageBps: 9000,
        premiumPaid: "210.00",
        expiry,
      });
    });
  });

  describe("getWalletActivePolicies", () => {
    it("excludes past-expiry, exact-expiry, zero, and missing expiry policies while keeping future policies", async () => {
      queryMock.mockResolvedValueOnce([
        {
          invoice_id: "inv-valid",
          wallet: WALLET,
          is_active: true,
          coverage_bps: 8000,
          premium_paid: "100.00",
          expiry: String(BASE_SECONDS + 120),
          purchased_at: String(BASE_SECONDS - 60),
        },
        {
          invoice_id: "inv-exact-expired",
          wallet: WALLET,
          is_active: true,
          coverage_bps: 8000,
          premium_paid: "100.00",
          expiry: BASE_SECONDS,
          purchased_at: BASE_SECONDS - 300,
        },
        {
          invoice_id: "inv-past-expired",
          wallet: WALLET,
          is_active: true,
          coverage_bps: 8000,
          premium_paid: "100.00",
          expiry: BASE_SECONDS - 10,
          purchased_at: BASE_SECONDS - 400,
        },
        {
          invoice_id: "inv-zero-expiry",
          wallet: WALLET,
          is_active: true,
          coverage_bps: 8000,
          premium_paid: "100.00",
          expiry: 0,
          purchased_at: BASE_SECONDS - 500,
        },
        {
          invoice_id: "inv-missing-expiry",
          wallet: WALLET,
          is_active: true,
          coverage_bps: 8000,
          premium_paid: "100.00",
          expiry: null,
          purchased_at: BASE_SECONDS - 500,
        },
      ]);

      const service = new InvoiceInsuranceService(dataSource, { now: () => BASE_MS });
      const active = await service.getWalletActivePolicies(WALLET);

      expect(active).toEqual([
        {
          invoiceId: "inv-valid",
          wallet: WALLET,
          isActive: true,
          coverageBps: 8000,
          premiumPaid: "100.00",
          expiry: BASE_SECONDS + 120,
          purchasedAt: BASE_SECONDS - 60,
        },
      ]);
    });

    it("filters out expiring policies across cached wallet reads before, exact, and after expiry", async () => {
      jest.useFakeTimers();
      jest.setSystemTime(BASE_MS);

      const expirySoon = BASE_SECONDS + 15;
      const expiryLater = BASE_SECONDS + 45;

      queryMock.mockResolvedValue([
        {
          invoice_id: "inv-soon",
          wallet: WALLET,
          is_active: true,
          coverage_bps: 6000,
          premium_paid: "50.00",
          expiry: expirySoon,
          purchased_at: BASE_SECONDS - 100,
        },
        {
          invoice_id: "inv-later",
          wallet: WALLET,
          is_active: true,
          coverage_bps: 9500,
          premium_paid: "150.00",
          expiry: expiryLater,
          purchased_at: BASE_SECONDS - 50,
        },
      ]);

      const cache = new TtlCache({
        ttlSeconds: 60,
        namespace: "wallet-insurance-test",
        sweepIntervalMs: 0,
      });
      const service = new InvoiceInsuranceService(dataSource, { cache });

      // Before either expires
      const initial = await service.getWalletActivePolicies(WALLET);
      expect(initial.map((p) => p.invoiceId)).toEqual(["inv-soon", "inv-later"]);
      expect(queryMock).toHaveBeenCalledTimes(1);

      // Just before first policy expires (served from cache)
      jest.setSystemTime(expirySoon * 1000 - 1);
      const justBeforeFirst = await service.getWalletActivePolicies(WALLET);
      expect(justBeforeFirst.map((p) => p.invoiceId)).toEqual(["inv-soon", "inv-later"]);
      expect(queryMock).toHaveBeenCalledTimes(1);

      // Exact boundary of first policy (t = expirySoon * 1000)
      jest.setSystemTime(expirySoon * 1000);
      const atFirstBoundary = await service.getWalletActivePolicies(WALLET);
      expect(atFirstBoundary.map((p) => p.invoiceId)).toEqual(["inv-later"]);

      // Exact boundary of second policy (t = expiryLater * 1000)
      jest.setSystemTime(expiryLater * 1000);
      const atSecondBoundary = await service.getWalletActivePolicies(WALLET);
      expect(atSecondBoundary).toEqual([]);

      // After both policies expired
      jest.setSystemTime(expiryLater * 1000 + 10_000);
      const afterBoth = await service.getWalletActivePolicies(WALLET);
      expect(afterBoth).toEqual([]);
    });
  });

  describe("getWalletPayoutHistory and invalidate", () => {
    it("caches payout history and invalidates invoice, wallet, and payout cache keys", async () => {
      queryMock
        .mockResolvedValueOnce([
          {
            invoice_id: "inv-1",
            wallet: WALLET,
            amount: "500.00",
            trigger_date: String(BASE_SECONDS - 10),
            tx_hash: "tx_abc",
          },
        ])
        .mockResolvedValueOnce([
          {
            invoice_id: "inv-2",
            wallet: WALLET,
            amount: "750.00",
            trigger_date: BASE_SECONDS,
            tx_hash: "tx_def",
          },
        ]);

      const cache = new TtlCache({
        ttlSeconds: 60,
        namespace: "payout-insurance-test",
        sweepIntervalMs: 0,
      });
      const service = new InvoiceInsuranceService(dataSource, { cache, now: () => BASE_MS });

      const first = await service.getWalletPayoutHistory(WALLET);
      expect(first).toEqual([
        {
          invoiceId: "inv-1",
          wallet: WALLET,
          amount: "500.00",
          triggerDate: BASE_SECONDS - 10,
          txHash: "tx_abc",
        },
      ]);

      // Cached read
      const second = await service.getWalletPayoutHistory(WALLET);
      expect(second).toEqual(first);
      expect(queryMock).toHaveBeenCalledTimes(1);

      // Invalidate forces fresh read
      await service.invalidate("inv-1", WALLET);
      const afterInvalidate = await service.getWalletPayoutHistory(WALLET);
      expect(afterInvalidate[0].txHash).toBe("tx_def");
      expect(queryMock).toHaveBeenCalledTimes(2);
    });
  });
});
