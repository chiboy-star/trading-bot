import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { RiskManager } from '../src/core/risk';

describe('Rolling 24h Circuit Breaker & Loss Management', () => {
    let testDb: Database.Database;

    beforeEach(() => {
        testDb = new Database(':memory:');
        testDb.exec(`
            CREATE TABLE daily_losses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                amount REAL NOT NULL
            );
        `);
    });

    afterEach(() => {
        testDb.close();
    });

    it('returns unhalted state when no losses exist', () => {
        const now = Date.now();
        const capital = 10000;
        const status = RiskManager.checkCircuitBreaker(testDb, capital, now, 0, { maxDrawdownPct: 0.05 });

        expect(status.isHalted).toBe(false);
        expect(status.isLockedOut).toBe(false);
        expect(status.totalLoss24h).toBe(0);
        expect(status.lossThreshold).toBe(500); // 5% of 10,000
    });

    it('stays active when losses are below 5% drawdown threshold', () => {
        const now = Date.now();
        const capital = 10000;

        RiskManager.recordDailyLoss(testDb, now - 3600000, 150);
        RiskManager.recordDailyLoss(testDb, now - 1800000, 200);
        // Total losses = $350 < $500 threshold

        const status = RiskManager.checkCircuitBreaker(testDb, capital, now, 0, { maxDrawdownPct: 0.05 });

        expect(status.isHalted).toBe(false);
        expect(status.totalLoss24h).toBe(350);
    });

    it('triggers circuit breaker and initiates lockout when 24h losses reach or exceed 5%', () => {
        const now = Date.now();
        const capital = 10000;

        RiskManager.recordDailyLoss(testDb, now - 7200000, 300);
        RiskManager.recordDailyLoss(testDb, now - 3600000, 250);
        // Total losses = $550 >= $500 threshold

        const status = RiskManager.checkCircuitBreaker(testDb, capital, now, 0, {
            maxDrawdownPct: 0.05,
            lockoutMs: 24 * 60 * 60 * 1000,
        });

        expect(status.isHalted).toBe(true);
        expect(status.isLockedOut).toBe(true);
        expect(status.totalLoss24h).toBe(550);
        expect(status.lockoutUntil).toBe(now + 24 * 60 * 60 * 1000);
        expect(status.reason).toContain('Lost $550.00 in the last 24h');
    });

    it('enforces lockout while current timestamp is before lockoutUntil', () => {
        const now = Date.now();
        const capital = 10000;
        const futureLockout = now + 12 * 60 * 60 * 1000; // 12 hours remaining

        const status = RiskManager.checkCircuitBreaker(testDb, capital, now, futureLockout);

        expect(status.isHalted).toBe(true);
        expect(status.isLockedOut).toBe(true);
        expect(status.lockoutUntil).toBe(futureLockout);
    });

    it('prunes losses older than 24h and ignores them during evaluation', () => {
        const now = Date.now();
        const capital = 10000;
        const twentyFiveHoursAgo = now - (25 * 60 * 60 * 1000);
        const twoHoursAgo = now - (2 * 60 * 60 * 1000);

        // Record a huge loss from 25 hours ago
        RiskManager.recordDailyLoss(testDb, twentyFiveHoursAgo, 1000);
        // Record a small loss from 2 hours ago
        RiskManager.recordDailyLoss(testDb, twoHoursAgo, 100);

        const status = RiskManager.checkCircuitBreaker(testDb, capital, now, 0, { maxDrawdownPct: 0.05 });

        // The 25h old loss must be pruned; only $100 is in the 24h window
        expect(status.isHalted).toBe(false);
        expect(status.totalLoss24h).toBe(100);

        // Verify the old loss was deleted from DB
        const remaining = testDb.prepare('SELECT count(*) as count FROM daily_losses').get() as { count: number };
        expect(remaining.count).toBe(1);
    });

    it('respects dynamically adjusted circuit breaker threshold (e.g., 2% vs 8%)', () => {
        const now = Date.now();
        const capital = 10000;

        // Losses = $300 (3% of $10,000)
        RiskManager.recordDailyLoss(testDb, now - 3600000, 300);

        // At 2% limit ($200 threshold), $300 triggers halt
        const strictStatus = RiskManager.checkCircuitBreaker(testDb, capital, now, 0, { maxDrawdownPct: 0.02 });
        expect(strictStatus.isHalted).toBe(true);
        expect(strictStatus.lossThreshold).toBe(200);

        // At 8% limit ($800 threshold), $300 does NOT trigger halt
        const relaxedStatus = RiskManager.checkCircuitBreaker(testDb, capital, now, 0, { maxDrawdownPct: 0.08 });
        expect(relaxedStatus.isHalted).toBe(false);
        expect(relaxedStatus.lossThreshold).toBe(800);
    });

    it('clears drawdown and disengages circuit breaker when daily_losses are wiped and capital restored', () => {
        const now = Date.now();
        const capital = 10000;

        // Simulate legacy 5.95% loss that triggered lockout
        RiskManager.recordDailyLoss(testDb, now - 3600000, 595.16);
        const haltedStatus = RiskManager.checkCircuitBreaker(testDb, capital, now, 0, { maxDrawdownPct: 0.05 });
        expect(haltedStatus.isHalted).toBe(true);

        // Operator resets: delete from daily_losses and clear lockout
        testDb.prepare('DELETE FROM daily_losses').run();

        const resetStatus = RiskManager.checkCircuitBreaker(testDb, capital, now, 0, { maxDrawdownPct: 0.05 });
        expect(resetStatus.isHalted).toBe(false);
        expect(resetStatus.totalLoss24h).toBe(0);
    });
});
