'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, LineSeries, ColorType, IChartApi, ISeriesApi } from 'lightweight-charts';
import { TrendingUp, Layers, Activity } from 'lucide-react';
import type { CandleDataPoint } from '@/lib/db';

interface CandlestickChartProps {
    symbol: string;
    candles: CandleDataPoint[];
    selectedSymbol: string;
    onSelectSymbol: (sym: string) => void;
    availableSymbols: string[];
}

export default function CandlestickChart({
    candles,
    selectedSymbol,
    onSelectSymbol,
    availableSymbols
}: CandlestickChartProps) {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartInstanceRef = useRef<IChartApi | null>(null);
    const candlestickSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const ema20SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
    const ema50SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);

    const [hoveredCandle, setHoveredCandle] = useState<CandleDataPoint | null>(null);

    // Latest candle summary
    const latestCandle = candles && candles.length > 0 ? candles[candles.length - 1] : null;
    const activeCandle = hoveredCandle || latestCandle;
    const candleChangePct = activeCandle && activeCandle.open > 0
        ? ((activeCandle.close - activeCandle.open) / activeCandle.open) * 100
        : 0;

    useEffect(() => {
        if (!chartContainerRef.current) return;

        // Clean up any existing chart
        if (chartInstanceRef.current) {
            chartInstanceRef.current.remove();
            chartInstanceRef.current = null;
        }

        const container = chartContainerRef.current;
        const width = container.clientWidth || 800;
        const height = 400;

        const chart = createChart(container, {
            width,
            height,
            layout: {
                background: { type: ColorType.Solid, color: '#090D16' },
                textColor: '#94A3B8',
                fontSize: 11,
                fontFamily: 'Inter, system-ui, sans-serif'
            },
            grid: {
                vertLines: { color: 'rgba(30, 41, 59, 0.45)' },
                horzLines: { color: 'rgba(30, 41, 59, 0.45)' }
            },
            crosshair: {
                vertLine: {
                    color: 'rgba(6, 182, 212, 0.5)',
                    width: 1,
                    style: 2,
                    labelBackgroundColor: '#0E7490'
                },
                horzLine: {
                    color: 'rgba(6, 182, 212, 0.5)',
                    width: 1,
                    style: 2,
                    labelBackgroundColor: '#0E7490'
                }
            },
            rightPriceScale: {
                borderColor: '#1E293B',
                scaleMargins: {
                    top: 0.1,
                    bottom: 0.15
                }
            },
            timeScale: {
                borderColor: '#1E293B',
                timeVisible: true,
                secondsVisible: false
            }
        });

        chartInstanceRef.current = chart;

        // 1. Candlestick Series
        const candleSeries = chart.addSeries(CandlestickSeries, {
            upColor: '#10B981',
            downColor: '#EF4444',
            borderVisible: false,
            wickUpColor: '#10B981',
            wickDownColor: '#EF4444'
        });
        candlestickSeriesRef.current = candleSeries;

        // 2. 20 EMA Series (Cyan)
        const ema20Series = chart.addSeries(LineSeries, {
            color: '#06B6D4',
            lineWidth: 2,
            title: '20 EMA',
            crosshairMarkerVisible: true
        });
        ema20SeriesRef.current = ema20Series;

        // 3. 50 EMA Series (Amber)
        const ema50Series = chart.addSeries(LineSeries, {
            color: '#F59E0B',
            lineWidth: 2,
            title: '50 EMA',
            crosshairMarkerVisible: true
        });
        ema50SeriesRef.current = ema50Series;

        // Set Data
        if (candles && candles.length > 0) {
            // Deduplicate and ensure strictly ascending timestamps
            const seenTimes = new Set<number>();
            const validCandles: any[] = [];
            const validEma20: any[] = [];
            const validEma50: any[] = [];

            candles.forEach((c) => {
                if (!seenTimes.has(c.time)) {
                    seenTimes.add(c.time);
                    validCandles.push({
                        time: c.time,
                        open: c.open,
                        high: c.high,
                        low: c.low,
                        close: c.close
                    });
                    if (c.ema20 !== null && c.ema20 !== undefined) {
                        validEma20.push({ time: c.time, value: c.ema20 });
                    }
                    if (c.ema50 !== null && c.ema50 !== undefined) {
                        validEma50.push({ time: c.time, value: c.ema50 });
                    }
                }
            });

            candleSeries.setData(validCandles);
            ema20Series.setData(validEma20);
            ema50Series.setData(validEma50);
            chart.timeScale().fitContent();
        }

        // Crosshair move listener for interactive HUD inspection
        chart.subscribeCrosshairMove((param) => {
            if (!param || !param.time || !param.seriesData) {
                setHoveredCandle(null);
                return;
            }
            const candle = param.seriesData.get(candleSeries) as any;
            const e20 = param.seriesData.get(ema20Series) as any;
            const e50 = param.seriesData.get(ema50Series) as any;

            if (candle) {
                setHoveredCandle({
                    time: Number(param.time),
                    open: candle.open,
                    high: candle.high,
                    low: candle.low,
                    close: candle.close,
                    ema20: e20 ? e20.value : null,
                    ema50: e50 ? e50.value : null
                });
            } else {
                setHoveredCandle(null);
            }
        });

        // Resize observer
        const resizeObserver = new ResizeObserver((entries) => {
            if (!entries || entries.length === 0) return;
            const entry = entries[0];
            const newWidth = entry.contentRect.width;
            if (newWidth > 0 && chartInstanceRef.current) {
                chartInstanceRef.current.applyOptions({ width: newWidth });
            }
        });

        resizeObserver.observe(container);

        return () => {
            resizeObserver.disconnect();
            if (chartInstanceRef.current) {
                chartInstanceRef.current.remove();
                chartInstanceRef.current = null;
            }
        };
    }, [candles, selectedSymbol]);

    return (
        <div className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-5 shadow-xl shadow-black/30 backdrop-blur-sm space-y-4">
            {/* Header & Controls */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
                <div className="flex items-center gap-3">
                    <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                        <TrendingUp className="w-5 h-5" />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-base font-bold text-white tracking-tight">
                                Hourly Candlestick Chart (100 Bars)
                            </h2>
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-400 border border-cyan-500/30">
                                1H CLOSED BARS
                            </span>
                        </div>
                        <p className="text-xs text-slate-400">
                            Overlaying 20 EMA (Cyan) &amp; 50 EMA (Amber) Golden Cross Strategy triggers
                        </p>
                    </div>
                </div>

                {/* Coin Selector Tabs */}
                <div className="flex items-center gap-1.5 bg-slate-900/90 p-1 rounded-xl border border-slate-800">
                    {availableSymbols.map((sym) => {
                        const isSelected = sym === selectedSymbol;
                        return (
                            <button
                                key={sym}
                                onClick={() => onSelectSymbol(sym)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                                    isSelected
                                        ? 'bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20'
                                        : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
                                }`}
                            >
                                {sym}
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Interactive HUD Bar (Displays OHLC and EMA Values) */}
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs bg-[#07090E]/70 px-4 py-2.5 rounded-xl border border-slate-800/70 font-mono">
                {activeCandle ? (
                    <div className="flex flex-wrap items-center gap-4">
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500 font-sans text-[11px]">Symbol:</span>
                            <span className="font-bold text-white">{selectedSymbol}</span>
                            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700/60">USD/USDT</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500 font-sans text-[11px]">O:</span>
                            <span className="text-slate-200">${activeCandle.open.toFixed(2)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500 font-sans text-[11px]">H:</span>
                            <span className="text-emerald-400">${activeCandle.high.toFixed(2)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500 font-sans text-[11px]">L:</span>
                            <span className="text-red-400">${activeCandle.low.toFixed(2)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500 font-sans text-[11px]">C:</span>
                            <span className={`font-bold ${candleChangePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                ${activeCandle.close.toFixed(2)} ({candleChangePct >= 0 ? '+' : ''}{candleChangePct.toFixed(2)}%)
                            </span>
                        </div>
                        {activeCandle.ema20 !== null && (
                            <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-cyan-400"></span>
                                <span className="text-cyan-400 font-sans text-[11px]">20 EMA:</span>
                                <span className="text-cyan-300 font-semibold">${activeCandle.ema20.toFixed(2)}</span>
                            </div>
                        )}
                        {activeCandle.ema50 !== null && (
                            <div className="flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                                <span className="text-amber-400 font-sans text-[11px]">50 EMA:</span>
                                <span className="text-amber-300 font-semibold">${activeCandle.ema50.toFixed(2)}</span>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="text-slate-400">Hover over chart candles to inspect OHLC and EMA values</div>
                )}

                <div className="flex items-center gap-3 text-[11px] font-sans">
                    <span className="flex items-center gap-1 text-cyan-400 font-medium">
                        <span className="w-2.5 h-1 bg-cyan-400 rounded-sm"></span>
                        Fast (20)
                    </span>
                    <span className="flex items-center gap-1 text-amber-400 font-medium">
                        <span className="w-2.5 h-1 bg-amber-400 rounded-sm"></span>
                        Slow (50)
                    </span>
                </div>
            </div>

            {/* Canvas Mount Container */}
            <div
                ref={chartContainerRef}
                className="w-full h-[400px] rounded-xl overflow-hidden border border-slate-800/80 shadow-inner bg-[#090D16]"
            />
        </div>
    );
}
