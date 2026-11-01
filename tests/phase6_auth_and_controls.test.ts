import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import path from 'path';
import { verifyOperatorAuth } from '../dashboard/lib/auth';
import { handleOperatorAction, setCircuitBreakerLimit, getDatabase } from '../dashboard/lib/db';

describe('Phase 6: Auth & Operator Controls Hardening', () => {
    describe('verifyOperatorAuth', () => {
        const originalEnv = { ...process.env };

        beforeEach(() => {
            process.env.CONTROL_API_KEY = 'test_secret_key_12345';
        });

        afterEach(() => {
            process.env = { ...originalEnv };
        });

        it('rejects requests with no authorization or x-api-key headers', () => {
            const req = {
                headers: new Headers()
            } as any;

            const res = verifyOperatorAuth(req);
            expect(res.authorized).toBe(false);
            expect(res.error).toMatch(/Unauthorized/);
        });

        it('rejects requests with an incorrect Bearer token', () => {
            const headers = new Headers();
            headers.set('authorization', 'Bearer wrong_key');
            const req = { headers } as any;

            const res = verifyOperatorAuth(req);
            expect(res.authorized).toBe(false);
            expect(res.error).toMatch(/Unauthorized/);
        });

        it('rejects requests with an incorrect x-api-key header', () => {
            const headers = new Headers();
            headers.set('x-api-key', 'wrong_key');
            const req = { headers } as any;

            const res = verifyOperatorAuth(req);
            expect(res.authorized).toBe(false);
        });

        it('authorizes requests with matching Bearer token', () => {
            const headers = new Headers();
            headers.set('authorization', 'Bearer test_secret_key_12345');
            const req = { headers } as any;

            const res = verifyOperatorAuth(req);
            expect(res.authorized).toBe(true);
            expect(res.error).toBeUndefined();
        });

        it('authorizes requests with matching x-api-key header', () => {
            const headers = new Headers();
            headers.set('x-api-key', 'test_secret_key_12345');
            const req = { headers } as any;

            const res = verifyOperatorAuth(req);
            expect(res.authorized).toBe(true);
            expect(res.error).toBeUndefined();
        });

        it('falls back to default development key when env variable is unset', () => {
            delete process.env.CONTROL_API_KEY;
            delete process.env.NEXT_PUBLIC_CONTROL_API_KEY;

            const headers = new Headers();
            headers.set('authorization', 'Bearer dev_operator_key_change_in_production');
            const req = { headers } as any;

            const res = verifyOperatorAuth(req);
            expect(res.authorized).toBe(true);
        });
    });

    describe('Circuit Breaker Reset & Operator Actions', () => {
        let db: Database.Database;

        beforeEach(() => {
            db = getDatabase();
            // Seed a halted state with active lockout and daily losses
            db.prepare('DELETE FROM daily_losses').run();
            db.prepare(`
                INSERT INTO daily_losses (timestamp, amount) VALUES (?, ?), (?, ?)
            `).run(Date.now() - 1000, 300, Date.now() - 500, 250);

            db.prepare(`
                UPDATE bot_state
                SET circuit_breaker_halted = 1,
                    lockout_until = ?,
                    circuit_breaker_limit = 0.05
                WHERE id = 1
            `).run(Date.now() + 86400000);

            db.prepare(`
                UPDATE system_state
                SET status = 'PAUSED',
                    pending_command = 'CIRCUIT_BREAKER_HALT'
                WHERE id = 1
            `).run();

            // Insert sample paper_trades to verify preservation
            db.exec(`
                INSERT OR IGNORE INTO paper_trades (
                    id, order_id, symbol, broker, side, direction, type, price, amount, fee, pnl, pnl_percent, timestamp
                ) VALUES (
                    99999, 'ORD-TEST-999', 'BTCUSDT', 'BYBIT', 'BUY', 'LONG', 'ENTRY', 50000, 0.01, 0.3, 0, 0, ${Date.now()}
                );
            `);
        });

        it('RESET_CIRCUIT_BREAKER clears 24h losses, resets lockout and halts, while preserving trade history', () => {
            const initialTradeCount = (db.prepare('SELECT COUNT(*) as count FROM paper_trades WHERE id = 99999').get() as any).count;
            expect(initialTradeCount).toBe(1);

            const result = handleOperatorAction('RESET_CIRCUIT_BREAKER');
            expect(result.success).toBe(true);
            expect(result.message).toMatch(/strictly preserved/i);

            // 1. Verify daily_losses are wiped
            const remainingLosses = (db.prepare('SELECT COUNT(*) as count FROM daily_losses').get() as any).count;
            expect(remainingLosses).toBe(0);

            // 2. Verify bot_state lockout and halt are cleared
            const botState = db.prepare('SELECT circuit_breaker_halted, lockout_until FROM bot_state WHERE id = 1').get() as any;
            expect(botState.circuit_breaker_halted).toBe(0);
            expect(botState.lockout_until).toBe(0);

            // 3. Verify system_state is RUNNING
            const sysState = db.prepare('SELECT status, pending_command FROM system_state WHERE id = 1').get() as any;
            expect(sysState.status).toBe('RUNNING');
            expect(sysState.pending_command).toBe('NONE');

            // 4. Verify paper_trades were NEVER deleted
            const tradeCountAfter = (db.prepare('SELECT COUNT(*) as count FROM paper_trades WHERE id = 99999').get() as any).count;
            expect(tradeCountAfter).toBe(1);

            // Clean up test trade
            db.prepare('DELETE FROM paper_trades WHERE id = 99999').run();
        });

        it('SET_CIRCUIT_BREAKER updates limit without clearing or modifying active lockout', () => {
            const futureLockout = Date.now() + 3600000;
            db.prepare('UPDATE bot_state SET lockout_until = ? WHERE id = 1').run(futureLockout);

            const result = setCircuitBreakerLimit(7.5);
            expect(result.success).toBe(true);
            expect(result.limit).toBe(0.075);
            expect(result.limitPct).toBe(7.5);

            const botState = db.prepare('SELECT circuit_breaker_limit, lockout_until FROM bot_state WHERE id = 1').get() as any;
            expect(botState.circuit_breaker_limit).toBe(0.075);
            expect(botState.lockout_until).toBe(futureLockout); // Lockout is strictly unchanged

            // Reset back to 5.0%
            setCircuitBreakerLimit(5.0);
        });
    });

    describe('CLI reset script safety confirmation', () => {
        it('refuses to execute and exits with code 1 if --confirm is not supplied', () => {
            const scriptPath = path.resolve(__dirname, '../scripts/reset_circuit_breaker.js');
            const proc = spawnSync(process.execPath, [scriptPath], {
                encoding: 'utf8'
            });

            expect(proc.status).toBe(1);
            expect(proc.stderr).toContain('--confirm');
            expect(proc.stderr).toContain('WARNING: Resetting the circuit breaker clears 24h rolling loss records');
        });
    });
});
