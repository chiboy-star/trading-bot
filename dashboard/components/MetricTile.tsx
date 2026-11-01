import React from 'react';

interface MetricTileProps {
    caption: string;
    value: string | number;
    subValue?: string;
    isPnl?: boolean;
    pnlPositive?: boolean;
    unit?: string;
    dominant?: boolean;
    className?: string;
}

export default function MetricTile({
    caption,
    value,
    subValue,
    isPnl = false,
    pnlPositive = false,
    unit = '',
    dominant = false,
    className = '',
}: MetricTileProps) {
    let valueColorClass = 'text-[#111315]';
    if (isPnl) {
        valueColorClass = pnlPositive ? 'text-[#2D6A4F]' : 'text-[#B91C1C]';
    }

    // Suppress unit if value already contains currency symbol ($ or ₦) and unit is redundant currency code (NGN, USD, ₦, $)
    const strVal = String(value);
    const hasCurrencySymbol = strVal.includes('₦') || strVal.includes('$');
    const isRedundantUnit = Boolean(
        unit &&
        hasCurrencySymbol &&
        ['NGN', 'USD', '₦', '$'].includes(unit.trim().toUpperCase())
    );
    const displayUnit = isRedundantUnit ? '' : unit;

    return (
        <div
            className={`border border-[#E5E7EB] bg-[#FFFFFF] rounded-lg p-5 flex flex-col justify-between ${
                dominant ? 'md:col-span-2 shadow-xs' : ''
            } ${className}`}
        >
            <div className="text-xs uppercase tracking-wider font-medium text-[#525866]">
                {caption}
            </div>
            <div className="mt-2 flex items-baseline gap-2">
                <span
                    className={`tabular-nums font-semibold tracking-tight ${
                        dominant ? 'text-3xl md:text-4xl' : 'text-2xl'
                    } ${valueColorClass}`}
                >
                    {value}
                </span>
                {displayUnit && (
                    <span className="text-xs text-[#525866] font-medium uppercase">
                        {displayUnit}
                    </span>
                )}
            </div>
            {subValue && (
                <div className="mt-1 text-xs text-[#525866] tabular-nums font-normal">
                    {subValue}
                </div>
            )}
        </div>
    );
}
