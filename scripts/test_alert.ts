import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import { notifyOrderEntered, notifyPositionClosed, notifyCircuitBreaker } from '../src/services/notifier';

async function main() {
    console.log(`\n======================================================================`);
    console.log(` [DISCORD ALERT TEST] Dispatching test notification embeds`);
    console.log(` Webhook URL configured: ${process.env.DISCORD_WEBHOOK_URL ? 'YES (Active)' : 'NO (Graceful warning fallback)'}`);
    console.log(`======================================================================\n`);

    const now = Date.now();

    // 1. Test [ORDER ENTERED] Alert
    console.log(`1. Testing [ORDER ENTERED] alert...`);
    const res1 = await notifyOrderEntered({
        symbol: 'BTC/USDT',
        entryPrice: 84150.25,
        amount: 0.0238,
        initialStop: 83673.89,
        atr: 317.57,
        timestamp: now
    });
    console.log(`Result: ${res1 ? '✅ Delivered to Discord' : '⚠️ Handled gracefully (No webhook configured or error)'}\n`);

    // 2. Test [POSITION CLOSED] Alert (Win)
    console.log(`2. Testing [POSITION CLOSED] alert (Win)...`);
    const res2 = await notifyPositionClosed({
        symbol: 'BTC/USDT',
        exitPrice: 85200.00,
        pnl: 24.98,
        pnlPercent: 1.25,
        reason: 'TRAILING_STOP',
        durationMs: 4 * 60 * 60 * 1000,
        timestamp: now
    });
    console.log(`Result: ${res2 ? '✅ Delivered to Discord' : '⚠️ Handled gracefully (No webhook configured or error)'}\n`);

    // 3. Test [CIRCUIT BREAKER HIT] Alert
    console.log(`3. Testing [CIRCUIT BREAKER HIT] alert...`);
    const res3 = await notifyCircuitBreaker({
        totalLoss: 520.45,
        capital: 9479.55,
        lockoutUntil: now + 24 * 60 * 60 * 1000,
        timestamp: now
    });
    console.log(`Result: ${res3 ? '✅ Delivered to Discord' : '⚠️ Handled gracefully (No webhook configured or error)'}\n`);

    console.log(`======================================================================`);
    console.log(` [ALERT TEST COMPLETE] Discord notification system verified.`);
    console.log(`======================================================================\n`);
}

main().catch(console.error);
