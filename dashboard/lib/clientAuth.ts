/**
 * Returns HTTP headers required for authorized operator control requests.
 */
export function getOperatorAuthHeaders(): HeadersInit {
    const token = process.env.NEXT_PUBLIC_CONTROL_API_KEY || 'dev_operator_key_change_in_production';
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
    };
}
