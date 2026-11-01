import React, { useState, useMemo, useRef } from 'react';
import { useCurrency } from '@/context/CurrencyContext';
import type { EquityPoint } from '@/lib/db';

interface EquityCurveProps {
    data: {
        '24H': EquityPoint[];
        '7D': EquityPoint[];
        '30D': EquityPoint[];
        'ALL': EquityPoint[];
    };
    currentEquity: number;
}

type Period = '24H' | '7D' | '30D' | 'ALL';

export default function EquityCurve({ data, currentEquity }: EquityCurveProps) {
    const [selectedPeriod, setSelectedPeriod] = useState<Period>('24H');
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const { formatMoney } = useCurrency();

    const points = data[selectedPeriod] || [];

    // Compute coordinate mapping
    const { minVal, maxVal, pathD, coords } = useMemo(() => {
        if (!points || points.length === 0) {
            return { minVal: currentEquity, maxVal: currentEquity, pathD: '', coords: [] };
        }

        const values = points.map(p => p.equity);
        let min = Math.min(...values);
        let max = Math.max(...values);
        if (min === max) {
            min -= 10;
            max += 10;
        }

        const width = 800;
        const height = 240;
        const padding = 20;

        const valRange = max - min || 1;
        const xStep = points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

        const calculatedCoords = points.map((p, idx) => {
            const x = padding + idx * xStep;
            const y = height - padding - ((p.equity - min) / valRange) * (height - padding * 2);
            return { x, y, point: p };
        });

        const d = calculatedCoords.reduce((acc, curr, idx) => {
            return idx === 0 ? `M ${curr.x} ${curr.y}` : `${acc} L ${curr.x} ${curr.y}`;
        }, '');

        return { minVal: min, maxVal: max, pathD: d, coords: calculatedCoords };
    }, [points, currentEquity]);

    const activeHover = hoveredIndex !== null && coords[hoveredIndex] ? coords[hoveredIndex] : null;

    const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
        if (!containerRef.current || coords.length === 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const svgWidth = rect.width;
        const relativeX = (mouseX / svgWidth) * 800;

        // Find closest point index
        let closestIdx = 0;
        let minDistance = Infinity;
        coords.forEach((c, idx) => {
            const dist = Math.abs(c.x - relativeX);
            if (dist < minDistance) {
                minDistance = dist;
                closestIdx = idx;
            }
        });

        setHoveredIndex(closestIdx);
    };

    const handleMouseLeave = () => {
        setHoveredIndex(null);
    };

    return (
        <div className="border border-[#E5E7EB] bg-[#FFFFFF] rounded-lg p-5 space-y-4">
            {/* Header: Title + Period Selector */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                    <h3 className="text-xs uppercase tracking-wider font-medium text-[#525866]">
                        Equity Curve
                    </h3>
                    <div className="mt-1 flex items-baseline gap-2">
                        <span className="text-xl font-semibold tabular-nums text-[#111315]">
                            {formatMoney(currentEquity)}
                        </span>
                    </div>
                </div>

                {/* Period Selector Tabs */}
                <div
                    className="inline-flex items-center border border-[#E5E7EB] rounded p-0.5 bg-[#FAF9F6]"
                    role="tablist"
                    aria-label="Equity chart timeframe"
                >
                    {(['24H', '7D', '30D', 'ALL'] as Period[]).map((period) => (
                        <button
                            key={period}
                            type="button"
                            role="tab"
                            aria-selected={selectedPeriod === period}
                            onClick={() => {
                                setSelectedPeriod(period);
                                setHoveredIndex(null);
                            }}
                            className={`px-3 py-1 text-xs font-medium rounded transition-colors tabular-nums cursor-pointer ${
                                selectedPeriod === period
                                    ? 'bg-[#111315] text-white'
                                    : 'text-[#525866] hover:text-[#111315]'
                            }`}
                        >
                            {period}
                        </button>
                    ))}
                </div>
            </div>

            {/* Crosshair readout display */}
            <div className="h-6 flex items-center justify-between text-xs text-[#525866] tabular-nums">
                {activeHover ? (
                    <>
                        <span suppressHydrationWarning>{activeHover.point.timeFormatted}</span>
                        <span className="font-semibold text-[#111315]">
                            {formatMoney(activeHover.point.equity)}
                        </span>
                    </>
                ) : (
                    <span>Hover or touch to inspect account balance across {selectedPeriod}</span>
                )}
            </div>

            {/* SVG Chart Line (Strict 1.5px Ink Line, NO Area Fill, NO Grid Clutter) */}
            <div ref={containerRef} className="relative w-full overflow-hidden">
                <svg
                    viewBox="0 0 800 240"
                    className="w-full h-56 cursor-crosshair select-none"
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                    preserveAspectRatio="none"
                >
                    {/* Baseline hairline indicator */}
                    <line
                        x1="0"
                        y1="220"
                        x2="800"
                        y2="220"
                        stroke="#E5E7EB"
                        strokeWidth="1"
                    />

                    {/* Pure 1.5px Ink line with NO area fill */}
                    {pathD && (
                        <path
                            d={pathD}
                            fill="none"
                            stroke="#111315"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    )}

                    {/* Interactive Crosshair & Tooltip Point */}
                    {activeHover && (
                        <g>
                            {/* Vertical subtle indicator hairline */}
                            <line
                                x1={activeHover.x}
                                y1="0"
                                x2={activeHover.x}
                                y2="240"
                                stroke="#525866"
                                strokeWidth="1"
                                strokeDasharray="3 3"
                            />
                            {/* Point Dot */}
                            <circle
                                cx={activeHover.x}
                                cy={activeHover.y}
                                r="4"
                                fill="#111315"
                                stroke="#FFFFFF"
                                strokeWidth="2"
                            />
                        </g>
                    )}
                </svg>
            </div>
        </div>
    );
}
