import { NextResponse } from 'next/server';
import { getDashboardOverview } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
    try {
        const data = getDashboardOverview();
        return NextResponse.json(data, {
            status: 200,
            headers: {
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            },
        });
    } catch (err: any) {
        return NextResponse.json(
            { error: err?.message || 'Failed to retrieve dashboard overview' },
            { status: 500 }
        );
    }
}
