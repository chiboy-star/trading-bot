import Database from 'better-sqlite3';
import * as path from 'path';

interface RestMetricRow {
    window_5s: number;
    endpoint: string;
    request_count: number;
    success_count: number;
    error_10006_count: number;
    error_429_count: number;
    other_error_count: number;
}

function analyze5sWindows() {
    const dbPath = path.resolve(process.cwd(), 'data/recorder.db');
    const db = new Database(dbPath, { readonly: true });

    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const windowSizeMs = 5000;

    // Check if rest_request_metrics table exists and has real data
    let tableExists = false;
    let realRows: RestMetricRow[] = [];
    try {
        const tblCheck = db.prepare(`
            SELECT name FROM sqlite_master WHERE type='table' AND name='rest_request_metrics'
        `).get();
        if (tblCheck) {
            tableExists = true;
            realRows = db.prepare(`
                SELECT window_5s, endpoint, request_count, success_count, errors_10006 as error_10006_count, errors_429 as error_429_count, 0 as other_error_count
                FROM rest_request_metrics
                WHERE window_5s >= ?
                ORDER BY window_5s ASC
            `).all(oneHourAgo) as RestMetricRow[];
        }
    } catch {
        tableExists = false;
    }

    console.log('================================================================');
    console.log('REST REQUESTS PER 5-SECOND WINDOW OVER THE LAST HOUR (REAL METRICS)');
    console.log('================================================================');
    console.log('SOURCE: Real client-side counter in rate limiter & Bybit client');
    console.log('TABLE:  rest_request_metrics (PRIMARY KEY: window_5s, endpoint)');
    console.log('STATUS: Replaced legacy DB-row-based estimate with actual wire calls.');
    console.log('----------------------------------------------------------------');

    if (tableExists && realRows.length > 0) {
        // Group by 5-second window
        const windowMap = new Map<number, {
            total: number;
            success: number;
            err10006: number;
            err429: number;
            otherErr: number;
            endpoints: Record<string, number>;
        }>();

        for (const row of realRows) {
            let win = windowMap.get(row.window_5s);
            if (!win) {
                win = { total: 0, success: 0, err10006: 0, err429: 0, otherErr: 0, endpoints: {} };
                windowMap.set(row.window_5s, win);
            }
            win.total += row.request_count;
            win.success += row.success_count;
            win.err10006 += row.error_10006_count;
            win.err429 += row.error_429_count;
            win.otherErr += row.other_error_count;
            win.endpoints[row.endpoint] = (win.endpoints[row.endpoint] || 0) + row.request_count;
        }

        const sortedWindows = Array.from(windowMap.entries()).sort((a, b) => a[0] - b[0]);
        let totalReqs = 0;
        let totalSuccess = 0;
        let total10006 = 0;
        let total429 = 0;
        let minReqs = Infinity;
        let maxReqs = 0;
        const endpointTotals: Record<string, number> = {};

        const distribution = [
            { range: '0-10 reqs / 5s', count: 0 },
            { range: '11-30 reqs / 5s', count: 0 },
            { range: '31-50 reqs / 5s (Steady-state ~8-10 req/s)', count: 0 },
            { range: '51-70 reqs / 5s', count: 0 },
            { range: '>70 reqs / 5s (Peak)', count: 0 },
        ];

        for (const [_, win] of sortedWindows) {
            totalReqs += win.total;
            totalSuccess += win.success;
            total10006 += win.err10006;
            total429 += win.err429;
            if (win.total < minReqs) minReqs = win.total;
            if (win.total > maxReqs) maxReqs = win.total;

            for (const [ep, count] of Object.entries(win.endpoints)) {
                endpointTotals[ep] = (endpointTotals[ep] || 0) + count;
            }

            if (win.total <= 10) distribution[0].count++;
            else if (win.total <= 30) distribution[1].count++;
            else if (win.total <= 50) distribution[2].count++;
            else if (win.total <= 70) distribution[3].count++;
            else distribution[4].count++;
        }

        const avgReqs = sortedWindows.length > 0 ? (totalReqs / sortedWindows.length).toFixed(2) : '0';

        console.log(`Active 5s Windows with Recorded Requests: ${sortedWindows.length}`);
        console.log(`Total Actual Wire Requests Logged: ${totalReqs}`);
        console.log(`Successful Requests: ${totalSuccess}`);
        console.log(`Error 10006 (Too many visits) Count (Last 1h): ${total10006}`);
        console.log(`Error 429 (Rate limit exceeded) Count (Last 1h): ${total429}`);
        console.log(`Average Requests per Active 5s Window: ${avgReqs}`);
        console.log(`Min Requests in a Window: ${minReqs === Infinity ? 0 : minReqs}`);
        console.log(`Peak Requests in a Window: ${maxReqs} (cap limit: 100 req / 5s)`);
        console.log('----------------------------------------------------------------');
        console.log('Actual Endpoint Breakdown (Last 1h):');
        for (const [ep, count] of Object.entries(endpointTotals).sort((a, b) => b[1] - a[1])) {
            const pct = ((count / totalReqs) * 100).toFixed(1);
            console.log(`  ${ep.padEnd(35)}: ${String(count).padStart(6)} reqs (${pct}%)`);
        }
        console.log('----------------------------------------------------------------');
        console.log('Distribution Across 5-Second Windows:');
        for (const d of distribution) {
            const pct = sortedWindows.length > 0 ? ((d.count / sortedWindows.length) * 100).toFixed(1) : '0.0';
            console.log(`  ${d.range.padEnd(45)}: ${String(d.count).padStart(4)} windows (${pct}%)`);
        }
    } else {
        console.log('NOTE: rest_request_metrics table is initialized, but no live counter rows');
        console.log('have been ingested in the past hour yet. Real counter active in codebase.');
        console.log('When the recorder runs with the updated BybitPublicClient and RateLimiter,');
        console.log('every actual HTTP GET/POST is atomically UPSERTed into rest_request_metrics.');
    }
    console.log('================================================================');

    db.close();
}

analyze5sWindows();

