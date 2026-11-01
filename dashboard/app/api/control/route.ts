import { NextRequest, NextResponse } from 'next/server';
import { handleOperatorAction } from '@/lib/db';
import { verifyOperatorAuth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
    try {
        const auth = verifyOperatorAuth(req);
        if (!auth.authorized) {
            return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
        }

        const body = await req.json();
        const { action, alertId, limit, limitPct } = body;

        const validActions = ['PAUSE', 'RESUME', 'KILL_SWITCH', 'DISMISS_ALERT', 'SET_CIRCUIT_BREAKER', 'RESET_CIRCUIT_BREAKER'];
        if (!action || !validActions.includes(action)) {
            return NextResponse.json(
                { error: 'Invalid action. Must be PAUSE, RESUME, KILL_SWITCH, DISMISS_ALERT, SET_CIRCUIT_BREAKER, or RESET_CIRCUIT_BREAKER.' },
                { status: 400 }
            );
        }

        if (action === 'DISMISS_ALERT' && typeof alertId !== 'number') {
            return NextResponse.json(
                { error: 'alertId must be a number for DISMISS_ALERT action.' },
                { status: 400 }
            );
        }

        const payload = limit ?? limitPct;
        const result = handleOperatorAction(action as any, alertId, payload);
        return NextResponse.json(result, { status: 200 });
    } catch (err: any) {
        return NextResponse.json(
            { error: err?.message || 'Failed to execute control action' },
            { status: 500 }
        );
    }
}
