import { NextRequest } from 'next/server';

/**
 * Validates operator authentication token on protected control & settings endpoints.
 * Requires Authorization: Bearer <CONTROL_API_KEY> or x-api-key: <CONTROL_API_KEY>.
 */
export function verifyOperatorAuth(req: NextRequest): { authorized: boolean; error?: string } {
    const configuredKey = process.env.CONTROL_API_KEY || process.env.NEXT_PUBLIC_CONTROL_API_KEY;
    const requiredKey = configuredKey || 'dev_operator_key_change_in_production';

    const authHeader = req.headers.get('authorization');
    const xApiKey = req.headers.get('x-api-key');

    let token: string | null = null;
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
        token = authHeader.substring(7).trim();
    } else if (xApiKey) {
        token = xApiKey.trim();
    }

    if (!token || token !== requiredKey) {
        return {
            authorized: false,
            error: 'Unauthorized: Missing or invalid operator control token'
        };
    }

    return { authorized: true };
}
