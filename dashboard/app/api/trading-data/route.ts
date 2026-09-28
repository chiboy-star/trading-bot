import { NextResponse } from 'next/server';
import { fetchDashboardData } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
    try {
        const data = fetchDashboardData();
        return NextResponse.json(data, {
            headers: {
                'Cache-Control': 'no-store, max-age=0'
            }
        });
    } catch (err: any) {
        console.error("API /api/trading-data error:", err);
        return NextResponse.json(
            { error: "Failed to fetch trading data", details: err?.message || String(err) },
            { status: 500 }
        );
    }
}
