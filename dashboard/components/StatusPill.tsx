import React, { useState, useEffect } from 'react';
import type { SystemStateInfo } from '@/lib/db';

interface StatusPillProps {
    systemState: SystemStateInfo;
}

export default function StatusPill({ systemState }: StatusPillProps) {
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setMounted(true);
    }, []);

    const { status, errorComponent, isStale, timeSinceStateChange, lastHeartbeatFormatted } = systemState;

    const displayTimeChange = mounted ? timeSinceStateChange : 'just now';
    const displayHeartbeat = mounted ? lastHeartbeatFormatted : '--:--:-- UTC';

    // Stale data takes precedence: screen must NEVER look healthy when data is stale
    if (isStale) {
        return (
            <div
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium tabular-nums border border-[#E5E7EB] bg-[#F3F4F6] text-[#4B5563]"
                role="status"
                aria-live="polite"
            >
                <span className="w-2 h-2 rounded-full bg-[#4B5563]" aria-hidden="true" />
                <span suppressHydrationWarning>Data delayed · Last update {displayHeartbeat}</span>
            </div>
        );
    }

    if (status === 'ERROR') {
        const errorText = errorComponent ? `Error: ${errorComponent}` : 'Error: System fault';
        return (
            <div
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium tabular-nums border border-[#FECACA] bg-[#FEE2E2] text-[#B91C1C]"
                role="status"
                aria-live="assertive"
            >
                <span className="w-2 h-2 rounded-full bg-[#B91C1C]" aria-hidden="true" />
                <span suppressHydrationWarning>{errorText}</span>
            </div>
        );
    }

    if (status === 'PAUSED') {
        return (
            <div
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium tabular-nums border border-[#E5E7EB] bg-[#F3F4F6] text-[#4B5563]"
                role="status"
                aria-live="polite"
            >
                <span className="w-2 h-2 rounded-full bg-[#4B5563]" aria-hidden="true" />
                <span suppressHydrationWarning>Paused · {displayTimeChange}</span>
            </div>
        );
    }

    // Default RUNNING
    return (
        <div
            className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium tabular-nums border border-[#C8E6C9] bg-[#E8F5E9] text-[#2D6A4F]"
            role="status"
            aria-live="polite"
        >
            <span className="w-2 h-2 rounded-full bg-[#2D6A4F]" aria-hidden="true" />
            <span suppressHydrationWarning>Running · {displayTimeChange}</span>
        </div>
    );
}

