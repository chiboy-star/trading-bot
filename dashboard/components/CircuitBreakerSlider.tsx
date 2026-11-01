'use client';

import React, { useState, useEffect } from 'react';
import { getOperatorAuthHeaders } from '@/lib/clientAuth';

interface CircuitBreakerSliderProps {
    currentLimit?: number; // In percent, e.g. 5.0
    onLimitChange?: (newLimitPct: number) => void;
    className?: string;
}

export default function CircuitBreakerSlider({
    currentLimit = 5.0,
    onLimitChange,
    className = ''
}: CircuitBreakerSliderProps) {
    const [sliderValue, setSliderValue] = useState<number>(currentLimit);
    const [isSyncing, setIsSyncing] = useState<boolean>(false);
    const [lastSyncedValue, setLastSyncedValue] = useState<number | null>(null);

    // Synchronize external prop changes if not actively dragging
    useEffect(() => {
        if (!isSyncing) {
            setSliderValue(currentLimit);
        }
    }, [currentLimit, isSyncing]);

    const handleCommit = async (val: number) => {
        setIsSyncing(true);
        try {
            const res = await fetch('/api/control', {
                method: 'POST',
                headers: getOperatorAuthHeaders(),
                body: JSON.stringify({
                    action: 'SET_CIRCUIT_BREAKER',
                    limitPct: val,
                    limit: val / 100
                })
            });

            if (res.ok) {
                setLastSyncedValue(val);
                onLimitChange?.(val);
            }
        } catch (err) {
            console.error('Failed to update circuit breaker threshold', err);
        } finally {
            setIsSyncing(false);
        }
    };

    return (
        <div
            className={`border border-[#E5E7EB] bg-[#FFFFFF] rounded-lg p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 transition-all ${className}`}
        >
            {/* Label and Explanatory Context */}
            <div className="flex flex-col">
                <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-[#111315]" />
                    <span className="text-xs font-semibold text-[#111315] uppercase tracking-wider">
                        24H Circuit Breaker Threshold
                    </span>
                    <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded border border-[#E5E7EB] bg-[#FAF9F6] text-[#525866]">
                        Risk Control
                    </span>
                </div>
                <div className="text-[11px] text-[#525866] mt-0.5">
                    Dynamically halts new position entries if rolling 24h losses exceed this percentage of equity.
                </div>
            </div>

            {/* Institutional Slider & Value Badge */}
            <div className="flex items-center gap-3 self-end md:self-auto w-full md:w-auto justify-between md:justify-end">
                <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[#525866] font-medium tabular-nums">1.0%</span>
                    <input
                        type="range"
                        min="1.0"
                        max="10.0"
                        step="0.5"
                        value={sliderValue}
                        onChange={(e) => setSliderValue(parseFloat(e.target.value))}
                        onMouseUp={() => handleCommit(sliderValue)}
                        onTouchEnd={() => handleCommit(sliderValue)}
                        onKeyUp={() => handleCommit(sliderValue)}
                        className="w-36 sm:w-48 h-1.5 bg-[#E5E7EB] rounded-lg appearance-none cursor-pointer accent-[#111315] focus:outline-none"
                        aria-label="24-hour circuit breaker threshold slider"
                    />
                    <span className="text-[11px] text-[#525866] font-medium tabular-nums">10.0%</span>
                </div>

                {/* Value Display Badge with Sync Feedback */}
                <div className="flex items-center gap-2 min-w-[95px] justify-end">
                    <span className="px-2.5 py-1 rounded bg-[#111315] text-[#FAF9F6] font-semibold tabular-nums text-xs shadow-xs tracking-tight">
                        {sliderValue.toFixed(1)}%
                    </span>
                    {isSyncing ? (
                        <span className="text-[10px] text-[#525866] font-medium animate-pulse">Syncing...</span>
                    ) : lastSyncedValue !== null ? (
                        <span className="text-[10px] text-[#2D6A4F] font-medium">Saved</span>
                    ) : (
                        <span className="text-[10px] text-[#525866] font-medium">Active</span>
                    )}
                </div>
            </div>
        </div>
    );
}
