import { NextRequest, NextResponse } from 'next/server';
import { getDatabase, setCircuitBreakerLimit } from '@/lib/db';
import { verifyOperatorAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
    try {
        const auth = verifyOperatorAuth(req);
        if (!auth.authorized) {
            return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
        }

        const db = getDatabase();
        const row = db.prepare('SELECT circuit_breaker_limit FROM bot_state WHERE id = 1').get() as any;
        const limitDecimal = row?.circuit_breaker_limit ?? 0.05;
        const limitPct = Number((limitDecimal * 100).toFixed(1));

        return NextResponse.json({
            circuitBreakerLimit: limitDecimal,
            circuitBreakerLimitPct: limitPct,
        }, { status: 200 });
    } catch (err: any) {
        return NextResponse.json(
            { error: err?.message || 'Failed to fetch settings' },
            { status: 500 }
        );
    }
}

export async function POST(req: NextRequest) {
    try {
        const auth = verifyOperatorAuth(req);
        if (!auth.authorized) {
            return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const limit = body.limit ?? body.limitPct ?? body.circuitBreakerLimit;

        if (typeof limit !== 'number' || limit <= 0) {
            return NextResponse.json(
                { error: 'Valid numeric limit or limitPct required (e.g. 5.0 for 5%).' },
                { status: 400 }
            );
        }

        const result = setCircuitBreakerLimit(limit);
        return NextResponse.json(result, { status: 200 });
    } catch (err: any) {
        return NextResponse.json(
            { error: err?.message || 'Failed to update settings' },
            { status: 500 }
        );
    }
}
