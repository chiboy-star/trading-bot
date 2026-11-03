import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GlobalRestRateLimiter } from '../src/recorder/rate_limiter';
import { BybitPublicClient } from '../src/recorder/bybit_client';
import { GapFiller } from '../src/recorder/gap_filler';
import { RecorderDB } from '../src/recorder/db';

describe('GlobalRestRateLimiter Suite', () => {
    it('should initialize with burst capacity 40 and 20 tokens/sec refill rate', () => {
        const limiter = new GlobalRestRateLimiter(40, 20);
        expect(limiter.getCapacity()).toBe(40);
        expect(limiter.getFillRate()).toBe(20);
        expect(limiter.getAvailableTokens()).toBe(40);
    });

    it('should allow an immediate burst of up to 40 requests without delay', async () => {
        const limiter = new GlobalRestRateLimiter(40, 20);
        const start = Date.now();
        const promises: Promise<void>[] = [];
        for (let i = 0; i < 40; i++) {
            promises.push(limiter.acquire(1));
        }
        await Promise.all(promises);
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(100); // 40 instantaneous tokens
        expect(limiter.getAvailableTokens()).toBeLessThan(1);
    });

    it('should queue and throttle requests exceeding burst capacity at ~20 req/s', async () => {
        const limiter = new GlobalRestRateLimiter(5, 20); // 5 tokens burst, 20 tokens/s (1 token every 50ms)
        // Drain initial burst
        for (let i = 0; i < 5; i++) {
            await limiter.acquire(1);
        }

        const start = Date.now();
        // Request 10 more tokens (should take ~500ms at 20 tokens/sec)
        const promises: Promise<void>[] = [];
        for (let i = 0; i < 10; i++) {
            promises.push(limiter.acquire(1));
        }
        await Promise.all(promises);
        const elapsed = Date.now() - start;
        // 10 tokens / 20 tokens/sec = 0.5s = 500ms
        expect(elapsed).toBeGreaterThanOrEqual(400);
        expect(elapsed).toBeLessThan(750);
    });
});

describe('HTTP 403 Ban Circuit Breaker Suite', () => {
    let client: BybitPublicClient;

    beforeEach(() => {
        client = new BybitPublicClient({ rateLimitDelayMs: 0 });
        client.clearBanLockout();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        client.clearBanLockout();
        vi.restoreAllMocks();
    });

    it('should treat 403 as an IP ban: NO retries, NO host switching, trip circuit breaker for 30+ minutes', async () => {
        let banCallbackLockout = 0;
        let banCallbackCause = '';
        client.onBanDetected = (lockout, cause) => {
            banCallbackLockout = lockout;
            banCallbackCause = cause;
        };

        let fetchCallCount = 0;
        const mockFetch = vi.fn().mockImplementation((url: string) => {
            fetchCallCount++;
            return Promise.resolve({
                ok: false,
                status: 403,
                statusText: 'Forbidden'
            });
        });
        global.fetch = mockFetch;

        const before = Date.now();
        await expect(client.fetchAllLinearContracts()).rejects.toThrow(/HTTP 403 Forbidden: Bybit IP ban detected/);

        // Assert: NO retries, NO host switching! Only 1 single request was sent before circuit breaker tripped
        expect(fetchCallCount).toBe(1);

        // Assert: circuit breaker is tripped for 30 minutes
        expect(client.isBanActive()).toBe(true);
        expect(client.getBanLockoutUntil()).toBeGreaterThanOrEqual(before + 29 * 60 * 1000);
        expect(banCallbackCause).toBe('HTTP_403_BAN');
        expect(banCallbackLockout).toBe(client.getBanLockoutUntil());

        // Subsequent call must reject immediately without ANY network fetch
        const networkCallsBefore = fetchCallCount;
        await expect(client.fetchAllTickers()).rejects.toThrow(/HTTP_403_BAN: All Bybit REST calls are paused/);
        expect(fetchCallCount).toBe(networkCallsBefore);
    });

    it('should probe with exactly ONE request to /v5/market/time when 30-min lockout expires', async () => {
        // Set ban lockout to expired timestamp
        client.setBanLockout(Date.now() - 1000);
        expect(client.isBanActive()).toBe(false);

        let probeUrl = '';
        let probeCalls = 0;
        global.fetch = vi.fn().mockImplementation((url: string) => {
            probeCalls++;
            probeUrl = url;
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ retCode: 0, retMsg: 'OK', result: { timeSecond: '1700000000' } })
            });
        });

        const unbanned = await client.probeBanRecovery();
        expect(unbanned).toBe(true);
        expect(probeCalls).toBe(1);
        expect(probeUrl).toContain('/v5/market/time');
        expect(client.getBanLockoutUntil()).toBe(0);
        expect(client.isBanActive()).toBe(false);
    });

    it('should re-trip for 30 minutes if probe returns 403', async () => {
        client.setBanLockout(Date.now() - 1000);

        let probeCalls = 0;
        global.fetch = vi.fn().mockImplementation((url: string) => {
            probeCalls++;
            return Promise.resolve({
                ok: false,
                status: 403,
                statusText: 'Forbidden'
            });
        });

        const unbanned = await client.probeBanRecovery();
        expect(unbanned).toBe(false);
        expect(probeCalls).toBe(1);
        expect(client.isBanActive()).toBe(true);
        expect(client.getBanLockoutUntil()).toBeGreaterThan(Date.now() + 29 * 60 * 1000);
    });
});

describe('Bybit Kline Limit Verification Suite', () => {
    it('supports up to 1000 klines per request in fetch1mKlines', async () => {
        const client = new BybitPublicClient({ rateLimitDelayMs: 0 });
        let requestedLimit: string | null = null;

        global.fetch = vi.fn().mockImplementation((url: string) => {
            const parsed = new URL(url);
            requestedLimit = parsed.searchParams.get('limit');
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({
                    retCode: 0,
                    retMsg: 'OK',
                    result: {
                        list: [
                            ['1700000000000', '100', '101', '99', '100.5', '10', '1000']
                        ]
                    }
                })
            });
        });

        const klines = await client.fetch1mKlines('BTCUSDT', 1000);
        expect(requestedLimit).toBe('1000');
        expect(klines.length).toBe(1);
    });
});

