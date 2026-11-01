import { NextResponse } from 'next/server';
import { openReadOnlyRecorderDb, getRecorderDashboardStatus } from '@/lib/recorder_db';

export const dynamic = 'force-dynamic';

export async function GET() {
    let db: any = null;
    try {
        db = openReadOnlyRecorderDb();
        const data = getRecorderDashboardStatus(db);
        return NextResponse.json(data, { status: 200 });
    } catch (err: any) {
        return NextResponse.json(
            { error: err?.message || 'Failed to read recorder database' },
            { status: 500 }
        );
    } finally {
        if (db) {
            try {
                db.close();
            } catch {
                // Ignore close error on read-only
            }
        }
    }
}
