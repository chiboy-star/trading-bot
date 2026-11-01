'use client';

import React, { useState, useMemo, useRef } from 'react';
import { useCurrency } from '@/context/CurrencyContext';
import type { MonitoredMarketItem, PositionItem, CandlePoint } from '@/lib/db';

interface LiveMarketChartProps {
    markets: MonitoredMarketItem[];
    activePositions: PositionItem[];
}

const DEFAULT_CORE_SET = new Set(['BTC', 'ETH', 'SOL', 'SUI', 'XRP', 'DOGE', 'AVAX', 'LINK']);

function normalizeSym(s: string): string {
    return (s || '').replace(':USDT', '').trim().toUpperCase();
}

function getBaseSymbol(s: string): string {
    return normalizeSym(s).split('/')[0];
}

// Calculate EMA series on the fly for 100 candle closes
function computeEmaSeries(closes: number[], period: number): (number | null)[] {
    if (closes.length < period) return closes.map(() => null);
    const k = 2 / (period + 1);
    const result: (number | null)[] = [];

    // First EMA is SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += closes[i];
        result.push(null);
    }
    let prevEma = sum / period;
    result[period - 1] = prevEma;

    for (let i = period; i < closes.length; i++) {
        const currentEma = closes[i] * k + prevEma * (1 - k);
        result.push(currentEma);
        prevEma = currentEma;
    }
    return result;
}

export default function LiveMarketChart({ markets, activePositions }: LiveMarketChartProps) {
    const { formatMoney } = useCurrency();
    const [selectedSymbol, setSelectedSymbol] = useState<string>(() => {
        if (activePositions.length > 0) return normalizeSym(activePositions[0].symbol);
        if (markets.length > 0) return normalizeSym(markets[0].symbol);
        return 'BTC/USDT';
    });
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    const svgRef = useRef<SVGSVGElement>(null);

    // Active positions map by normalized symbol
    const positionBySymbol = useMemo(() => {
        const map = new Map<string, PositionItem>();
        for (const pos of activePositions) {
            map.set(normalizeSym(pos.symbol), pos);
        }
        return map;
    }, [activePositions]);

    // Active markets list with fallback if empty
    const activeMarkets = useMemo(() => {
        if (markets.length > 0) return markets;
        return [
            {
                symbol: 'BTC/USDT',
                price: 68500,
                change24h: 1.25,
                ema20: 68200,
                ema50: 67800,
                rsi14: 56.4,
                adx14: 26.2,
                signalProximity: 'Trending (ADX 26) · Price holding above 20 EMA',
                updatedAt: Date.now(),
                tier: 'CORE' as const,
                candles: []
            }
        ];
    }, [markets]);

    // Grouping: 1. Active in Position, 2. Core Majors, 3. Trending Satellites (sorted by highest intraday ADX)
    const { activeInPosition, coreMajors, trendingSatellites } = useMemo(() => {
        const inPos: { market: MonitoredMarketItem; position: PositionItem }[] = [];
        const core: MonitoredMarketItem[] = [];
        const sat: MonitoredMarketItem[] = [];

        for (const m of activeMarkets) {
            const sym = normalizeSym(m.symbol);
            const pos = positionBySymbol.get(sym);
            if (pos) {
                inPos.push({ market: m, position: pos });
            } else if (m.tier === 'CORE' || (!m.tier && DEFAULT_CORE_SET.has(getBaseSymbol(sym)))) {
                core.push(m);
            } else {
                sat.push(m);
            }
        }

        // Active positions sorted by unrealized PnL descending
        inPos.sort((a, b) => b.position.unrealizedPnl - a.position.unrealizedPnl);

        // Trending satellites sorted by highest ADX descending
        sat.sort((a, b) => (b.adx14 || 0) - (a.adx14 || 0));

        return {
            activeInPosition: inPos,
            coreMajors: core,
            trendingSatellites: sat
        };
    }, [activeMarkets, positionBySymbol]);

    // Currently selected market
    const currentMarket = useMemo(() => {
        const match = activeMarkets.find(m => normalizeSym(m.symbol) === normalizeSym(selectedSymbol));
        return match || activeMarkets[0];
    }, [activeMarkets, selectedSymbol]);

    const currentPosition = positionBySymbol.get(normalizeSym(currentMarket.symbol));

    const candles = currentMarket.candles || [];
    const closes = useMemo(() => candles.map(c => c.close), [candles]);
    const ema20Series = useMemo(() => computeEmaSeries(closes, 20), [closes]);
    const ema50Series = useMemo(() => computeEmaSeries(closes, 50), [closes]);

    // Compute chart coordinates
    const { minVal, maxVal, pricePath, ema20Path, ema50Path, coords } = useMemo(() => {
        if (candles.length === 0) {
            const p = currentMarket.price || 100;
            return {
                minVal: p * 0.98,
                maxVal: p * 1.02,
                pricePath: '',
                ema20Path: '',
                ema50Path: '',
                coords: []
            };
        }

        const width = 800;
        const height = 240;
        const paddingY = 24;
        const paddingX = 20;

        let allValues: number[] = candles.map(c => c.close);
        ema20Series.forEach(v => { if (v !== null) allValues.push(v); });
        ema50Series.forEach(v => { if (v !== null) allValues.push(v); });

        if (currentPosition) {
            allValues.push(currentPosition.entryPrice);
            allValues.push(currentPosition.trailingStop);
        }

        let min = Math.min(...allValues);
        let max = Math.max(...allValues);
        if (min === max) {
            min *= 0.99;
            max *= 1.01;
        }

        const range = max - min || 1;
        const stepX = candles.length > 1 ? (width - paddingX * 2) / (candles.length - 1) : 0;

        const getY = (val: number) => height - paddingY - ((val - min) / range) * (height - paddingY * 2);

        const calculatedCoords = candles.map((c, i) => ({
            x: paddingX + i * stepX,
            y: getY(c.close),
            candle: c,
            ema20: ema20Series[i],
            ema50: ema50Series[i]
        }));

        const pPath = calculatedCoords.reduce((acc, curr, i) => {
            return i === 0 ? `M ${curr.x} ${curr.y}` : `${acc} L ${curr.x} ${curr.y}`;
        }, '');

        let e20Path = '';
        let first20 = true;
        calculatedCoords.forEach(c => {
            if (c.ema20 !== null) {
                const y20 = getY(c.ema20);
                if (first20) {
                    e20Path = `M ${c.x} ${y20}`;
                    first20 = false;
                } else {
                    e20Path += ` L ${c.x} ${y20}`;
                }
            }
        });

        let e50Path = '';
        let first50 = true;
        calculatedCoords.forEach(c => {
            if (c.ema50 !== null) {
                const y50 = getY(c.ema50);
                if (first50) {
                    e50Path = `M ${c.x} ${y50}`;
                    first50 = false;
                } else {
                    e50Path += ` L ${c.x} ${y50}`;
                }
            }
        });

        return {
            minVal: min,
            maxVal: max,
            pricePath: pPath,
            ema20Path: e20Path,
            ema50Path: e50Path,
            coords: calculatedCoords
        };
    }, [candles, closes, ema20Series, ema50Series, currentMarket.price, currentPosition]);

    const activeHover = hoveredIndex !== null && coords[hoveredIndex] ? coords[hoveredIndex] : null;

    const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
        if (!svgRef.current || coords.length === 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const relativeX = (mouseX / rect.width) * 800;

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

    // Calculate Y coordinates for active position entry and stop-loss markers
    const range = maxVal - minVal || 1;
    const height = 240;
    const paddingY = 24;
    const entryY = currentPosition ? height - paddingY - ((currentPosition.entryPrice - minVal) / range) * (height - paddingY * 2) : null;
    const stopY = currentPosition ? height - paddingY - ((currentPosition.trailingStop - minVal) / range) * (height - paddingY * 2) : null;

    const isCurrentCore = currentMarket.tier === 'CORE' || DEFAULT_CORE_SET.has(getBaseSymbol(currentMarket.symbol));

    return (
        <div className="border border-[#E5E7EB] bg-[#FFFFFF] rounded-lg p-5 space-y-4">
            {/* 1. Monitored Pairs Strip: 15-Coin Core + Satellite Universe */}
            <div className="space-y-2 border-b border-[#E5E7EB] pb-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className="text-xs uppercase tracking-wider font-semibold text-[#111315]">
                            Monitored Universe ({activeMarkets.length})
                        </span>
                        <span className="text-[10px] text-[#525866] tabular-nums">
                            {activeInPosition.length > 0 && `${activeInPosition.length} in position · `}
                            {coreMajors.length} Core · {trendingSatellites.length} Satellite
                        </span>
                    </div>
                    <span className="text-[10px] text-[#525866] uppercase tracking-wider font-medium">
                        6h Rotation
                    </span>
                </div>

                {/* Horizontally scrollable pill strip with clean grouping */}
                <div className="flex items-center gap-2 overflow-x-auto pb-1.5 pt-0.5 no-scrollbar scroll-smooth">
                    {/* GROUP 1: Active in Position (sorted first) */}
                    {activeInPosition.length > 0 && (
                        <div className="flex items-center gap-1.5 shrink-0 bg-[#F9FAFB] border border-[#E5E7EB] rounded-lg px-2 py-1">
                            <span className="text-[10px] uppercase font-bold tracking-wider text-[#111315] mr-0.5">
                                Position:
                            </span>
                            {activeInPosition.map(({ market, position }) => {
                                const isSelected = normalizeSym(market.symbol) === normalizeSym(currentMarket.symbol);
                                const isProfit = position.unrealizedPnl >= 0;

                                return (
                                    <button
                                        key={market.symbol}
                                        type="button"
                                        onClick={() => {
                                            setSelectedSymbol(market.symbol);
                                            setHoveredIndex(null);
                                        }}
                                        className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-all flex items-center gap-1.5 tabular-nums cursor-pointer whitespace-nowrap shadow-2xs ${
                                            isSelected
                                                ? 'bg-[#111315] text-[#FAF9F6] border-[#111315]'
                                                : isProfit
                                                    ? 'bg-[#FFFFFF] text-[#111315] border-[#C8E6C9] hover:border-[#2D6A4F]'
                                                    : 'bg-[#FFFFFF] text-[#111315] border-[#FECACA] hover:border-[#B91C1C]'
                                        }`}
                                    >
                                        <span
                                            className={`w-1.5 h-1.5 rounded-full ${
                                                isProfit ? 'bg-[#2D6A4F]' : 'bg-[#B91C1C]'
                                            }`}
                                        />
                                        <span className="font-semibold">{getBaseSymbol(market.symbol)}</span>
                                        <span
                                            className={`text-[10px] font-semibold px-1 py-0.2 rounded ${
                                                isSelected
                                                    ? isProfit ? 'bg-[#2D6A4F] text-[#FAF9F6]' : 'bg-[#B91C1C] text-[#FAF9F6]'
                                                    : isProfit ? 'bg-[#E8F5E9] text-[#2D6A4F]' : 'bg-[#FEE2E2] text-[#B91C1C]'
                                            }`}
                                        >
                                            {isProfit ? '+' : ''}{position.unrealizedPnlPercent.toFixed(1)}%
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {/* GROUP 2: Core Majors */}
                    <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] uppercase font-semibold text-[#525866] tracking-wider shrink-0 px-1">
                            Core:
                        </span>
                        {coreMajors.map((market) => {
                            const isSelected = normalizeSym(market.symbol) === normalizeSym(currentMarket.symbol);
                            const isTrending = market.adx14 >= 20;

                            return (
                                <button
                                    key={market.symbol}
                                    type="button"
                                    onClick={() => {
                                        setSelectedSymbol(market.symbol);
                                        setHoveredIndex(null);
                                    }}
                                    className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors flex items-center gap-1.5 tabular-nums cursor-pointer whitespace-nowrap ${
                                        isSelected
                                            ? 'bg-[#111315] text-[#FAF9F6] border-[#111315]'
                                            : 'bg-[#FAF9F6] text-[#4B5563] border-[#E5E7EB] hover:text-[#111315] hover:border-[#D1D5DB]'
                                    }`}
                                >
                                    <span
                                        className={`w-1.5 h-1.5 rounded-full ${
                                            isTrending ? 'bg-[#2D6A4F]' : 'bg-[#9CA3AF]'
                                        }`}
                                    />
                                    <span>{getBaseSymbol(market.symbol)}</span>
                                    <span className={isSelected ? 'text-[#FAF9F6]/80' : 'text-[#6B7280]'}>
                                        {formatMoney(market.price, { precision: 'auto' })}
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    {/* Vertical Divider */}
                    {trendingSatellites.length > 0 && (
                        <div className="h-5 w-px bg-[#E5E7EB] mx-1 shrink-0" />
                    )}

                    {/* GROUP 3: Trending Satellites (sorted by highest intraday ADX) */}
                    {trendingSatellites.length > 0 && (
                        <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-[10px] uppercase font-semibold text-[#525866] tracking-wider shrink-0 px-1">
                                Satellites:
                            </span>
                            {trendingSatellites.map((market) => {
                                const isSelected = normalizeSym(market.symbol) === normalizeSym(currentMarket.symbol);
                                const isStrong = market.adx14 >= 25;

                                return (
                                    <button
                                        key={market.symbol}
                                        type="button"
                                        onClick={() => {
                                            setSelectedSymbol(market.symbol);
                                            setHoveredIndex(null);
                                        }}
                                        className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors flex items-center gap-1.5 tabular-nums cursor-pointer whitespace-nowrap ${
                                            isSelected
                                                ? 'bg-[#111315] text-[#FAF9F6] border-[#111315]'
                                                : 'bg-[#FAF9F6] text-[#4B5563] border-[#E5E7EB] hover:text-[#111315] hover:border-[#D1D5DB]'
                                        }`}
                                    >
                                        <span
                                            className={`w-1.5 h-1.5 rounded-full ${
                                                isStrong ? 'bg-[#2D6A4F]' : 'bg-[#9CA3AF]'
                                            }`}
                                        />
                                        <span>{getBaseSymbol(market.symbol)}</span>
                                        <span
                                            className={`text-[10px] px-1 py-0.2 rounded font-medium ${
                                                isSelected
                                                    ? 'bg-white/20 text-[#FAF9F6]'
                                                    : 'bg-[#E5E7EB]/70 text-[#4B5563]'
                                            }`}
                                        >
                                            ADX {market.adx14.toFixed(0)}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* 2. Live Pair Header */}
            <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
                <div>
                    <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-xl font-semibold text-[#111315]">
                            {currentMarket.symbol.replace(':USDT', '')}
                        </h3>
                        <span
                            className={`text-[10px] uppercase font-semibold px-1.5 py-0.5 rounded border tracking-wide ${
                                isCurrentCore
                                    ? 'border-[#E5E7EB] bg-[#F3F4F6] text-[#4B5563]'
                                    : 'border-[#E0E7FF] bg-[#EEF2FF] text-[#4338CA]'
                            }`}
                        >
                            {isCurrentCore ? 'Core Major' : 'Satellite'}
                        </span>
                        {currentPosition && (
                            <div className="flex items-center gap-1.5">
                                <span
                                    className={`text-[10px] font-semibold px-2 py-0.5 rounded border uppercase tracking-wide ${
                                        currentPosition.side === 'LONG'
                                            ? 'border-[#C8E6C9] bg-[#E8F5E9] text-[#2D6A4F]'
                                            : 'border-[#FECACA] bg-[#FEE2E2] text-[#B91C1C]'
                                    }`}
                                >
                                    Active {currentPosition.side}
                                </span>
                                <span
                                    className={`text-xs font-semibold tabular-nums px-1.5 py-0.5 rounded ${
                                        currentPosition.unrealizedPnl >= 0
                                            ? 'bg-[#E8F5E9] text-[#2D6A4F]'
                                            : 'bg-[#FEE2E2] text-[#B91C1C]'
                                    }`}
                                >
                                    {formatMoney(currentPosition.unrealizedPnl, { signed: true })} ({currentPosition.unrealizedPnlPercent >= 0 ? '+' : ''}{currentPosition.unrealizedPnlPercent.toFixed(2)}%)
                                </span>
                            </div>
                        )}
                        <span
                            className={`text-xs font-semibold tabular-nums ${
                                currentMarket.change24h >= 0 ? 'text-[#2D6A4F]' : 'text-[#B91C1C]'
                            }`}
                        >
                            {currentMarket.change24h >= 0 ? '+' : ''}{currentMarket.change24h.toFixed(2)}%
                        </span>
                    </div>

                    <div className="mt-1 flex items-baseline gap-3 flex-wrap">
                        <span className="text-3xl font-semibold tabular-nums text-[#111315]">
                            {formatMoney(activeHover ? activeHover.candle.close : currentMarket.price, { precision: 'auto' })}
                        </span>
                        <div className="flex items-center gap-3 text-xs text-[#525866] tabular-nums flex-wrap">
                            <span>
                                ADX: <strong>{currentMarket.adx14.toFixed(1)}</strong>{' '}
                                <span className="text-[10px] text-[#6B7280]">
                                    ({currentMarket.adx14 >= 25 ? 'Strong Trend' : currentMarket.adx14 >= 20 ? 'Trending' : 'Choppy'})
                                </span>
                            </span>
                            <span>RSI: <strong>{currentMarket.rsi14.toFixed(1)}</strong></span>
                            <span className="hidden md:inline">EMA20: <strong>{formatMoney(currentMarket.ema20, { precision: 'auto' })}</strong></span>
                            <span className="hidden md:inline">EMA50: <strong>{formatMoney(currentMarket.ema50, { precision: 'auto' })}</strong></span>
                        </div>
                    </div>
                </div>

                {/* Live Reasoning */}
                <div className="sm:text-right max-w-md">
                    <span className="text-[11px] text-[#525866] uppercase tracking-wider block font-medium">
                        Bot Signal Analysis
                    </span>
                    <span className="text-xs text-[#111315] font-medium leading-relaxed block mt-0.5">
                        {currentMarket.signalProximity}
                    </span>
                </div>
            </div>

            {/* 3. Price & EMA Chart (SVG thin 1.5px Ink + dashed Graphite 20/50 EMA) */}
            <div className="relative w-full overflow-hidden">
                <svg
                    ref={svgRef}
                    viewBox="0 0 800 240"
                    className="w-full h-60 cursor-crosshair select-none"
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                    preserveAspectRatio="none"
                >
                    {/* Baseline */}
                    <line x1="0" y1="220" x2="800" y2="220" stroke="#E5E7EB" strokeWidth="1" />

                    {/* 50 EMA dashed subtle line */}
                    {ema50Path && (
                        <path
                            d={ema50Path}
                            fill="none"
                            stroke="#9CA3AF"
                            strokeWidth="1.2"
                            strokeDasharray="6 4"
                        />
                    )}

                    {/* 20 EMA dashed line */}
                    {ema20Path && (
                        <path
                            d={ema20Path}
                            fill="none"
                            stroke="#4B5563"
                            strokeWidth="1.2"
                            strokeDasharray="4 3"
                        />
                    )}

                    {/* 1.5px Ink price curve */}
                    {pricePath && (
                        <path
                            d={pricePath}
                            fill="none"
                            stroke="#111315"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                        />
                    )}

                    {/* Horizontal markers for active position entry and stop */}
                    {entryY !== null && currentPosition && (
                        <g>
                            <line
                                x1="0"
                                y1={entryY}
                                x2="800"
                                y2={entryY}
                                stroke="#2D6A4F"
                                strokeWidth="1.2"
                                strokeDasharray="4 4"
                            />
                            <text
                                x="795"
                                y={entryY - 4}
                                textAnchor="end"
                                fill="#2D6A4F"
                                fontSize="10"
                                fontWeight="600"
                                className="tabular-nums"
                            >
                                Entry {formatMoney(currentPosition.entryPrice, { precision: 'auto' })}
                            </text>
                        </g>
                    )}

                    {stopY !== null && currentPosition && (
                        <g>
                            <line
                                x1="0"
                                y1={stopY}
                                x2="800"
                                y2={stopY}
                                stroke="#B91C1C"
                                strokeWidth="1.2"
                                strokeDasharray="4 4"
                            />
                            <text
                                x="795"
                                y={stopY - 4}
                                textAnchor="end"
                                fill="#B91C1C"
                                fontSize="10"
                                fontWeight="600"
                                className="tabular-nums"
                            >
                                Stop {formatMoney(currentPosition.trailingStop, { precision: 'auto' })}
                            </text>
                        </g>
                    )}

                    {/* Crosshair & Tooltip Point */}
                    {activeHover && (
                        <g>
                            <line
                                x1={activeHover.x}
                                y1="0"
                                x2={activeHover.x}
                                y2="240"
                                stroke="#525866"
                                strokeWidth="1"
                                strokeDasharray="3 3"
                            />
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

                {/* Crosshair readout */}
                <div className="flex items-center justify-between text-xs text-[#525866] tabular-nums mt-1">
                    <div className="flex items-center gap-4">
                        <span className="flex items-center gap-1.5">
                            <span className="w-3 h-0.5 bg-[#111315] inline-block" /> Price
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="w-3 h-0.5 border-t border-dashed border-[#4B5563] inline-block" /> 20 EMA
                        </span>
                        <span className="flex items-center gap-1.5">
                            <span className="w-3 h-0.5 border-t border-dashed border-[#9CA3AF] inline-block" /> 50 EMA
                        </span>
                    </div>

                    <div suppressHydrationWarning>
                        {activeHover ? (
                            <span>
                                {new Date(activeHover.candle.timestamp).toUTCString().slice(17, 22)} UTC · {formatMoney(activeHover.candle.close, { precision: 'auto' })}
                            </span>
                        ) : (
                            <span>Last 100 15m candles</span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
