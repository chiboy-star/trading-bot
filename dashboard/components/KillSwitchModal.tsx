import React, { useEffect, useRef } from 'react';
import { useCurrency } from '@/context/CurrencyContext';
import type { PositionItem } from '@/lib/db';

interface KillSwitchModalProps {
    isOpen: boolean;
    positions: PositionItem[];
    onConfirm: () => void;
    onCancel: () => void;
    isSubmitting: boolean;
}

export default function KillSwitchModal({
    isOpen,
    positions,
    onConfirm,
    onCancel,
    isSubmitting,
}: KillSwitchModalProps) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const { formatMoney } = useCurrency();

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

    const count = positions.length;
    const totalNotional = positions.reduce((acc, p) => acc + p.notional, 0);
    const symbolsList = Array.from(new Set(positions.map(p => p.symbol))).join(', ');

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-[#111315]/40 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="kill-switch-title"
        >
            <div
                ref={dialogRef}
                className="w-full max-w-md bg-[#FFFFFF] border border-[#E5E7EB] rounded-lg shadow-xl p-6 space-y-4"
            >
                <div className="space-y-1">
                    <h2
                        id="kill-switch-title"
                        className="text-base font-semibold text-[#B91C1C]"
                    >
                        Confirm Emergency Kill Switch
                    </h2>
                    <p className="text-xs text-[#525866]">
                        Step 2 of 2 · Irreversible operational command
                    </p>
                </div>

                <div className="text-sm text-[#111315] space-y-2 border-t border-b border-[#E5E7EB] py-3">
                    {count > 0 ? (
                        <p>
                            This will immediately market-close{' '}
                            <strong className="font-semibold">{count} open position{count > 1 ? 's' : ''}</strong>{' '}
                            (totaling{' '}
                            <span className="tabular-nums font-semibold">
                                {formatMoney(totalNotional)}
                            </span>{' '}
                            notional across {symbolsList}) and pause the trading engine.
                        </p>
                    ) : (
                        <p>
                            There are currently no open positions. This will immediately pause the trading engine and prevent any new orders.
                        </p>
                    )}
                </div>

                <div className="flex items-center justify-end gap-3 pt-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        disabled={isSubmitting}
                        className="px-4 py-2 text-sm font-medium text-[#111315] border border-[#E5E7EB] rounded hover:bg-[#F3F4F6] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#111315]"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={isSubmitting}
                        className="px-4 py-2 text-sm font-medium text-white bg-[#B91C1C] rounded hover:bg-[#991B1B] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B91C1C] disabled:opacity-50"
                    >
                        {isSubmitting ? 'Closing...' : 'Yes, Execute Kill Switch'}
                    </button>
                </div>
            </div>
        </div>
    );
}
