import { NextResponse } from 'next/server';
import { getDashboardOverview } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
    try {
        const data = getDashboardOverview();
        return NextResponse.json(data, {
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
            },
        });
    } catch (err: any) {
        console.error('API /api/dashboard/state error:', err);
        return NextResponse.json(
            { error: 'Failed to fetch dashboard state', details: err?.message || String(err) },
            { status: 500 }
        );
    }
}
