'use client';

import React, { useEffect, useRef } from 'react';

interface ResetBreakerModalProps {
    isOpen: boolean;
    currentDrawdownPct: number;
    thresholdPct: number;
    onConfirm: () => void;
    onCancel: () => void;
    isSubmitting: boolean;
}

export default function ResetBreakerModal({
    isOpen,
    currentDrawdownPct,
    thresholdPct,
    onConfirm,
    onCancel,
    isSubmitting,
}: ResetBreakerModalProps) {
    const dialogRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onCancel();
        };
        if (isOpen) {
            window.addEventListener('keydown', handleKeyDown);
        }
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onCancel]);

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#111315]/40 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reset-breaker-title"
        >
            <div
                ref={dialogRef}
                className="w-full max-w-md bg-[#FFFFFF] border border-[#E5E7EB] rounded-lg shadow-xl p-6 space-y-4"
            >
                <div className="space-y-1">
                    <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#B91C1C]" />
                        <h2
                            id="reset-breaker-title"
                            className="text-base font-semibold text-[#111315]"
                        >
                            Reset Circuit Breaker & Lockout
                        </h2>
                    </div>
                    <p className="text-xs text-[#525866]">
                        Operator Override · Requires Confirmation
                    </p>
                </div>

                <div className="text-xs text-[#525866] space-y-2 border-t border-b border-[#E5E7EB] py-3 leading-relaxed">
                    <p>
                        The circuit breaker is currently engaged due to 24h rolling losses (<strong className="text-[#111315] tabular-nums">{currentDrawdownPct.toFixed(2)}%</strong> loss vs <strong className="text-[#111315] tabular-nums">{thresholdPct.toFixed(1)}%</strong> threshold).
                    </p>
                    <p>
                        Resetting will immediately clear the 24-hour loss accumulator and lift the entry halt.
                    </p>
                    <div className="p-2.5 rounded bg-[#FAF9F6] border border-[#E5E7EB] text-[11px] text-[#2D6A4F] font-medium">
                        🛡️ Trade history (<code>paper_trades</code>) and active open positions are strictly preserved.
                    </div>
                </div>

                <div className="flex items-center justify-end gap-3 pt-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={isSubmitting}
                        className="px-4 py-2 text-xs font-medium text-[#111315] border border-[#E5E7EB] rounded hover:bg-[#F3F4F6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#111315] cursor-pointer"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={isSubmitting}
                        className="px-4 py-2 text-xs font-semibold text-white bg-[#111315] hover:bg-[#25282C] rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#111315] disabled:opacity-50 cursor-pointer shadow-xs"
                    >
                        {isSubmitting ? 'Resetting...' : 'Confirm Reset Breaker'}
                    </button>
                </div>
            </div>
        </div>
    );
}
