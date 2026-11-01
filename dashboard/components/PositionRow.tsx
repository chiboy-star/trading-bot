import React from 'react';
import { useCurrency } from '@/context/CurrencyContext';
import type { PositionItem } from '@/lib/db';

interface PositionRowProps {
    position: PositionItem;
}

export default function PositionRow({ position }: PositionRowProps) {
    const { symbol, broker, side, amount, entryPrice, currentPrice, unrealizedPnl, unrealizedPnlPercent, notional } = position;
    const { formatMoney } = useCurrency();

    const isPositive = unrealizedPnl >= 0;
    const sign = isPositive ? '+' : '-';
    const absPct = Math.abs(unrealizedPnlPercent);

    // Format PnL via universal CurrencyContext hook with sign
    const formattedPnlStr = formatMoney(unrealizedPnl, { signed: true });
    const formattedPctStr = `${sign}${absPct.toFixed(2)}%`;

    // Strict color rule: ONLY the P&L value is colored (Sage for +, Muted Red for -)
    const pnlColorClass = isPositive ? 'text-[#2D6A4F]' : 'text-[#B91C1C]';

    return (
        <div className="py-3 px-4 flex items-center justify-between border-b border-[#E5E7EB] hover:bg-[#FAF9F6] transition-colors text-sm">
            {/* Symbol & Broker */}
            <div className="flex flex-col">
                <div className="flex items-center gap-2">
                    <span className="font-semibold text-[#111315]">{symbol}</span>
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded border border-[#E5E7EB] bg-[#F3F4F6] text-[#4B5563] uppercase">
                        {broker}
                    </span>
                </div>
                <div className="text-xs text-[#525866] tabular-nums mt-0.5">
                    {side} · {amount} units ({formatMoney(notional)} notional)
                </div>
            </div>

            {/* Pricing Details (Rendered in Ink/Graphite with smart precision) */}
            <div className="hidden sm:flex flex-col text-right tabular-nums text-xs">
                <span className="text-[#111315]">
                    Entry: {formatMoney(entryPrice, { precision: 'auto' })}
                </span>
                <span className="text-[#525866]">
                    Mark: {formatMoney(currentPrice, { precision: 'auto' })}
                </span>
            </div>

            {/* Unrealized P&L (Strict Color Rule: ONLY colored text in entire row) */}
            <div className="flex flex-col text-right tabular-nums">
                <span className={`font-semibold ${pnlColorClass}`}>
                    {formattedPnlStr}
                </span>
                <span className={`text-xs ${pnlColorClass}`}>
                    {formattedPctStr}
                </span>
            </div>
        </div>
    );
}
