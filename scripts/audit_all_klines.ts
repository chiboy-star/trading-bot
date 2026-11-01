import { BybitPublicClient } from '../src/recorder/bybit_client';
import * as fs from 'fs';
import * as path from 'path';

async function auditAllContracts() {
    console.log('Fetching all active linear contracts from Bybit...');
    const client = new BybitPublicClient({ rateLimitDelayMs: 65 }); // ~15 req/sec

    const contracts = await client.fetchAllLinearContracts();
    console.log(`Retrieved ${contracts.length} linear contracts.`);

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const expectedBars = 60;

    let auditedCount = 0;
    let perfectCount = 0; // >= 59 bars (>= 98.3%)
    const below98Pct: { symbol: string; count: number; pct: number; reason?: string }[] = [];
    const launchTimeCheck: { symbol: string; launchTime: number; launchIso: string; valid: boolean }[] = [];

    console.log(`Auditing 1m klines across ALL ${contracts.length} contracts for the last 60 minutes...`);
    const startTime = Date.now();

    for (let i = 0; i < contracts.length; i++) {
        const contract = contracts[i];
        const sym = contract.symbol;

        // Verify launchTime
        const lt = contract.launchTime;
        const isValidLt = typeof lt === 'number' && lt > 0 && lt <= now;
        if (i < 10 || i >= contracts.length - 5) {
            launchTimeCheck.push({
                symbol: sym,
                launchTime: lt,
                launchIso: lt > 0 ? new Date(lt).toISOString() : 'NONE',
                valid: isValidLt
            });
        }

        try {
            // Check if contract was listed less than 1 hour ago
            if (lt > oneHourAgo) {
                // If listed < 1 hour ago, expected bars is elapsed minutes since launch
                const elapsedMinutes = Math.max(1, Math.floor((now - lt) / 60000));
                const klines = await client.fetch1mKlines(sym, 60, lt, now);
                auditedCount++;
                const count = klines.length;
                const pct = (count / elapsedMinutes) * 100;
                if (pct >= 98.0) {
                    perfectCount++;
                } else {
                    below98Pct.push({ symbol: sym, count, pct: parseFloat(pct.toFixed(1)), reason: `Recent listing (${elapsedMinutes}m old)` });
                }
            } else {
                const klines = await client.fetch1mKlines(sym, 60, oneHourAgo, now);
                auditedCount++;
                const count = klines.length;
                const pct = (count / expectedBars) * 100;
                if (count >= 59) {
                    perfectCount++;
                } else {
                    below98Pct.push({ symbol: sym, count, pct: parseFloat(pct.toFixed(1)) });
                }
            }
        } catch (err: any) {
            below98Pct.push({ symbol: sym, count: 0, pct: 0, reason: err.message });
        }

        if ((i + 1) % 100 === 0 || i === contracts.length - 1) {
            const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`Progress: ${i + 1}/${contracts.length} audited (${elapsedSec}s elapsed)...`);
        }
    }

    const elapsedTotal = ((Date.now() - startTime) / 1000).toFixed(1);

    const report = {
        totalContracts: contracts.length,
        auditedCount,
        perfectCount,
        perfectPct: parseFloat(((perfectCount / auditedCount) * 100).toFixed(2)),
        below98Count: below98Pct.length,
        below98Symbols: below98Pct,
        launchTimeCheckSample: launchTimeCheck,
        elapsedSeconds: elapsedTotal
    };

    console.log('\n=============================================================');
    console.log(`AUDIT RESULTS FOR ALL ${contracts.length} CONTRACTS:`);
    console.log(`Audited: ${auditedCount}/${contracts.length}`);
    console.log(`>= 98% Completeness: ${perfectCount} (${report.perfectPct}%)`);
    console.log(`< 98% Completeness: ${below98Pct.length}`);
    if (below98Pct.length > 0) {
        console.log('List of symbols below 98%:');
        for (const item of below98Pct) {
            console.log(` - ${item.symbol}: ${item.count} bars (${item.pct}%) ${item.reason ? `[${item.reason}]` : ''}`);
        }
    } else {
        console.log('Zero symbols below 98% across all contracts!');
    }
    console.log('=============================================================\n');

    const outPath = path.resolve(process.cwd(), 'research/data_quality_full_audit.json');
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Wrote full audit report to: ${outPath}`);
}

auditAllContracts().catch(console.error);
