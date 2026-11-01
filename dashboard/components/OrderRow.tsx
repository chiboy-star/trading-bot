import React from 'react';
import { useCurrency } from '@/context/CurrencyContext';
import type { OrderItem } from '@/lib/db';

interface OrderRowProps {
    order: OrderItem;
}

export default function OrderRow({ order }: OrderRowProps) {
    const { timeFormatted, side, orderSide, type, price, amount, pnl, status, reason, broker } = order;
    const { formatMoney } = useCurrency();

    const isExit = type !== 'ENTRY';
    const hasPnl = isExit && pnl !== 0;
    const isPnlPositive = pnl > 0;

    return (
        <div className="py-2.5 px-4 flex flex-col border-b border-[#E5E7EB] hover:bg-[#FAF9F6] transition-colors text-xs">
            <div className="flex items-center justify-between">
                {/* Time & Side */}
                <div className="flex items-center gap-2">
                    <span className="text-[#525866] tabular-nums font-normal" suppressHydrationWarning>
                        {timeFormatted}
                    </span>
                    <span className="font-medium text-[#111315]">
                        {order.symbol}
                    </span>
                    <span className="text-[10px] px-1 py-0.5 rounded border border-[#E5E7EB] bg-[#F3F4F6] text-[#4B5563] uppercase">
                        {broker}
                    </span>
                </div>

                {/* Fill Status & Side */}
                <div className="flex items-center gap-2 tabular-nums">
                    <span className="text-[#525866]">
                        {orderSide} {side} · {amount} @ {formatMoney(price, { precision: 'auto' })}
                    </span>
                    <span className="font-semibold text-[#111315] uppercase tracking-wider text-[10px] px-1.5 py-0.5 rounded bg-[#F3F4F6] border border-[#E5E7EB]">
                        {status}
                    </span>
                </div>
            </div>

            {/* PnL or Exit/Rejection Reason */}
            <div className="flex items-center justify-between mt-1 text-[11px] tabular-nums">
                <span className="text-[#525866]">
                    Type: {type}
                    {reason ? ` · ${reason}` : ''}
                </span>
                {hasPnl && (
                    <span className={`font-medium ${isPnlPositive ? 'text-[#2D6A4F]' : 'text-[#B91C1C]'}`}>
                        {formatMoney(pnl, { signed: true })}
                    </span>
                )}
            </div>
        </div>
    );
}
