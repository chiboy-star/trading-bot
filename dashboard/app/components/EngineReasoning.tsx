'use client';

import React, { useState } from 'react';
import {
    Activity,
    AlertCircle,
    ArrowDown,
    ArrowDownRight,
    ArrowRight,
    ArrowUp,
    ArrowUpRight,
    CheckCircle2,
    Compass,
    HelpCircle,
    Info,
    Shield,
    Sparkles,
    TrendingDown,
    TrendingUp,
    XCircle,
    Zap
} from 'lucide-react';
import type { EngineReasoningItem } from '@/lib/db';

interface EngineReasoningProps {
    reasoningList: EngineReasoningItem[];
}

export default function EngineReasoning({ reasoningList }: EngineReasoningProps) {
    const [selectedSymbol, setSelectedSymbol] = useState<string>('BTC/USDT');
    const [viewMode, setViewMode] = useState<'single' | 'all'>('single');

    if (!reasoningList || reasoningList.length === 0) {
        return null;
    }

    const currentItem = reasoningList.find((r) => r.symbol === selectedSymbol) || reasoningList[0];

    return (
        <section aria-label="Decision Inspector Engine Reasoning" className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-6 shadow-xl shadow-black/30 backdrop-blur-sm space-y-6">
            {/* Panel Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
                <div className="flex items-center gap-3">
                    <div className="relative p-2.5 rounded-xl bg-gradient-to-tr from-cyan-500/20 via-blue-500/10 to-indigo-500/20 text-cyan-400 border border-cyan-500/30 shadow-md shadow-cyan-500/10">
                        <Compass className="w-5 h-5 text-cyan-400" />
                        <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cyan-500"></span>
                        </span>
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-bold text-white tracking-tight">
                                Decision Inspector: Engine Reasoning
                            </h2>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 tracking-wider">
                                BIDIRECTIONAL PERPETUALS
                            </span>
                        </div>
                        <p className="text-xs text-slate-400">
                            Transparent algorithmic inspection of Long (RSI 40-65) &amp; Short (RSI 35-60) triggers with ADX &gt; 25 trend gates
                        </p>
                    </div>
                </div>

                {/* View Mode & Coin Switcher Controls */}
                <div className="flex items-center flex-wrap gap-2">
                    {/* View Mode Toggle */}
                    <div className="flex items-center bg-slate-900/90 p-1 rounded-xl border border-slate-800">
                        <button
                            onClick={() => setViewMode('single')}
                            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                                viewMode === 'single'
                                    ? 'bg-cyan-500 text-slate-950 shadow-sm'
                                    : 'text-slate-400 hover:text-slate-200'
                            }`}
                        >
                            Focus Tab
                        </button>
                        <button
                            onClick={() => setViewMode('all')}
                            className={`px-3 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                                viewMode === 'all'
                                    ? 'bg-cyan-500 text-slate-950 shadow-sm'
                                    : 'text-slate-400 hover:text-slate-200'
                            }`}
                        >
                            All Pairs ({reasoningList.length})
                        </button>
                    </div>

                    {/* Single Coin Selector Tabs */}
                    {viewMode === 'single' && (
                        <div className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800 overflow-x-auto max-w-full">
                            {reasoningList.map((item) => {
                                const isSelected = item.symbol === selectedSymbol;
                                const isShort = item.activeSide === 'SHORT' || item.posture === 'SHORT_TRIGGERED';
                                const isLong = item.activeSide === 'LONG' || item.posture === 'LONG_TRIGGERED';
                                return (
                                    <button
                                        key={item.symbol}
                                        onClick={() => setSelectedSymbol(item.symbol)}
                                        className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 whitespace-nowrap ${
                                            isSelected
                                                ? 'bg-slate-800 text-cyan-400 border border-cyan-500/30 shadow-sm'
                                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                                        }`}
                                    >
                                        <span className={`w-1.5 h-1.5 rounded-full ${isShort ? 'bg-rose-400' : isLong ? 'bg-emerald-400' : item.trendFilter.passed ? 'bg-cyan-400' : 'bg-slate-500'}`}></span>
                                        <span>{item.symbol}</span>
                                    </button>
                                );
                            })}
                        </div>
                    )}
                </div>
            </div>

            {/* Content Display: Single Focus or All Pairs */}
            {viewMode === 'single' ? (
                <CoinReasoningCard item={currentItem} isFullWidth />
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                    {reasoningList.map((item) => (
                        <CoinReasoningCard key={item.symbol} item={item} />
                    ))}
                </div>
            )}
        </section>
    );
}

/**
 * Individual Coin Decision Reasoning Card with Bidirectional Diagnostics.
 */
function CoinReasoningCard({ item, isFullWidth = false }: { item: EngineReasoningItem; isFullWidth?: boolean }) {
    const isCash = item.posture === 'CASH';
    const isLong = item.posture === 'ACTIVE_LONG';
    const isShort = item.posture === 'ACTIVE_SHORT';
    const isLongSignal = item.posture === 'LONG_TRIGGERED';
    const isShortSignal = item.posture === 'SHORT_TRIGGERED';

    return (
        <div className={`bg-[#0A0E18]/80 border rounded-xl p-5 transition-all shadow-md flex flex-col justify-between space-y-5 ${
            isLong
                ? 'border-emerald-500/40 shadow-emerald-500/5'
                : isShort
                ? 'border-rose-500/40 shadow-rose-500/5'
                : isLongSignal
                ? 'border-cyan-500/40 shadow-cyan-500/5'
                : isShortSignal
                ? 'border-violet-500/40 shadow-violet-500/5'
                : 'border-slate-800/90 hover:border-slate-700/80'
        }`}>
            {/* Header: Asset + Posture Badge */}
            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                    <span className="font-bold text-base text-white tracking-tight">{item.symbol}</span>
                    <span className="text-xs font-mono text-slate-400">
                        ${item.currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                    </span>
                </div>

                <div>
                    {isLong && (
                        <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5 shadow-sm shadow-emerald-500/10">
                            <ArrowUp className="w-3 h-3 text-emerald-400" />
                            ACTIVE LONG
                        </span>
                    )}
                    {isShort && (
                        <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30 flex items-center gap-1.5 shadow-sm shadow-rose-500/10">
                            <ArrowDown className="w-3 h-3 text-rose-400" />
                            ACTIVE SHORT
                        </span>
                    )}
                    {isLongSignal && (
                        <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-cyan-500/20 text-cyan-300 border border-cyan-400/40 flex items-center gap-1.5 animate-pulse">
                            <Zap className="w-3.5 h-3.5 text-cyan-400" />
                            LONG TRIGGERED
                        </span>
                    )}
                    {isShortSignal && (
                        <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-violet-500/20 text-violet-300 border border-violet-400/40 flex items-center gap-1.5 animate-pulse">
                            <Zap className="w-3.5 h-3.5 text-violet-400" />
                            SHORT TRIGGERED
                        </span>
                    )}
                    {isCash && (
                        <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-800 text-slate-300 border border-slate-700/80 flex items-center gap-1.5">
                            <Shield className="w-3 h-3 text-slate-400" />
                            SITTING IN CASH
                        </span>
                    )}
                </div>
            </div>

            {/* PLAIN ENGLISH EXPLAINER SUMMARY BANNER */}
            <div className={`p-4 rounded-xl border relative overflow-hidden transition-all ${
                isLong
                    ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-200'
                    : isShort
                    ? 'bg-rose-950/20 border-rose-500/30 text-rose-200'
                    : isLongSignal
                    ? 'bg-cyan-950/25 border-cyan-500/30 text-cyan-200'
                    : isShortSignal
                    ? 'bg-violet-950/25 border-violet-500/30 text-violet-200'
                    : 'bg-slate-900/60 border-slate-800 text-slate-200'
            }`}>
                <div className="flex items-start gap-3">
                    <div className="mt-0.5">
                        {isLong ? (
                            <TrendingUp className="w-5 h-5 text-emerald-400 shrink-0" />
                        ) : isShort ? (
                            <TrendingDown className="w-5 h-5 text-rose-400 shrink-0" />
                        ) : isLongSignal ? (
                            <Sparkles className="w-5 h-5 text-cyan-400 shrink-0 animate-pulse" />
                        ) : isShortSignal ? (
                            <Sparkles className="w-5 h-5 text-violet-400 shrink-0 animate-pulse" />
                        ) : (
                            <Shield className="w-5 h-5 text-indigo-400 shrink-0" />
                        )}
                    </div>
                    <div className="space-y-1">
                        <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                            <span>Engine Posture</span>
                            <span>•</span>
                            <span className={isLong ? 'text-emerald-400' : isShort ? 'text-rose-400' : isLongSignal ? 'text-cyan-400' : isShortSignal ? 'text-violet-400' : 'text-indigo-400'}>
                                {isLong ? 'Long Exposure' : isShort ? 'Short Exposure' : isLongSignal ? 'Long Signal Confirmed' : isShortSignal ? 'Short Signal Confirmed' : 'Capital Preserved'}
                            </span>
                        </div>
                        <p className="text-sm font-medium leading-relaxed text-slate-100">
                            &ldquo;{item.summarySentence}&rdquo;
                        </p>
                    </div>
                </div>
            </div>

            {/* DIAGNOSTIC CHECKLIST */}
            <div className="space-y-3 pt-1">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-400">
                    <span className="uppercase tracking-wider text-[11px]">Bidirectional Gates</span>
                    <span className="text-[11px] text-slate-500">Long &amp; Short Rules</span>
                </div>

                {/* 1. Trend Filter (ADX) */}
                <div className="bg-slate-900/70 border border-slate-800/80 rounded-xl p-3.5 space-y-2">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            {item.trendFilter.passed ? (
                                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                            ) : (
                                <XCircle className="w-4 h-4 text-red-400 shrink-0" />
                            )}
                            <span className="text-xs font-bold text-white">Trend Filter (ADX)</span>
                        </div>
                        <span
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                                item.trendFilter.passed
                                    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                    : 'bg-red-500/15 text-red-400 border-red-500/30'
                            }`}
                        >
                            {item.trendFilter.badge}
                        </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-300 pl-6">
                        <span className="font-mono text-cyan-300 font-semibold">ADX = {item.trendFilter.adx.toFixed(1)}</span>
                        <span className="text-[11px] text-slate-400">Threshold: &gt; 25</span>
                    </div>
                    <p className="text-[11px] text-slate-400 pl-6 leading-normal">
                        {item.trendFilter.details}
                    </p>
                </div>

                {/* 2. Long Momentum Filter (RSI 40-65) */}
                <div className="bg-slate-900/70 border border-slate-800/80 rounded-xl p-3.5 space-y-2">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            {item.longMomentumFilter.passed ? (
                                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                            ) : (
                                <XCircle className="w-4 h-4 text-slate-500 shrink-0" />
                            )}
                            <span className="text-xs font-bold text-white">Long Momentum (RSI 40–65)</span>
                        </div>
                        <span
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                                item.longMomentumFilter.passed
                                    ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
                                    : 'bg-slate-800 text-slate-400 border-slate-700'
                            }`}
                        >
                            {item.longMomentumFilter.badge}
                        </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-300 pl-6">
                        <span className="font-mono text-cyan-300 font-semibold">RSI = {item.longMomentumFilter.rsi.toFixed(1)}</span>
                        <span className="text-[11px] text-slate-400">Long Window: 40–65</span>
                    </div>
                </div>

                {/* 3. Short Momentum Filter (RSI 35-60) */}
                <div className="bg-slate-900/70 border border-slate-800/80 rounded-xl p-3.5 space-y-2">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            {item.shortMomentumFilter.passed ? (
                                <CheckCircle2 className="w-4 h-4 text-rose-400 shrink-0" />
                            ) : (
                                <XCircle className="w-4 h-4 text-slate-500 shrink-0" />
                            )}
                            <span className="text-xs font-bold text-white">Short Momentum (RSI 35–60)</span>
                        </div>
                        <span
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                                item.shortMomentumFilter.passed
                                    ? 'bg-rose-500/15 text-rose-400 border-rose-500/30'
                                    : 'bg-slate-800 text-slate-400 border-slate-700'
                            }`}
                        >
                            {item.shortMomentumFilter.badge}
                        </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-300 pl-6">
                        <span className="font-mono text-rose-300 font-semibold">RSI = {item.shortMomentumFilter.rsi.toFixed(1)}</span>
                        <span className="text-[11px] text-slate-400">Short Window: 35–60</span>
                    </div>
                </div>

                {/* 4. Trigger State (20/50 EMA) */}
                <div className="bg-slate-900/70 border border-slate-800/80 rounded-xl p-3.5 space-y-2">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            {item.triggerFilter.longCrossover ? (
                                <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                            ) : item.triggerFilter.shortCrossover ? (
                                <CheckCircle2 className="w-4 h-4 text-rose-400 shrink-0" />
                            ) : (
                                <div className="w-4 h-4 rounded-full border border-slate-600 flex items-center justify-center shrink-0">
                                    <span className="w-1.5 h-1.5 rounded-full bg-slate-500"></span>
                                </div>
                            )}
                            <span className="text-xs font-bold text-white">Trigger State (20/50 EMA)</span>
                        </div>
                        <span
                            className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${
                                item.triggerFilter.longCrossover
                                    ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40 shadow-sm shadow-cyan-500/20'
                                    : item.triggerFilter.shortCrossover
                                    ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 shadow-sm shadow-rose-500/20'
                                    : 'bg-slate-800 text-slate-400 border-slate-700'
                            }`}
                        >
                            {item.triggerFilter.badge}
                        </span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-300 pl-6 font-mono">
                        <span className="text-cyan-400">20 EMA: ${item.triggerFilter.ema20.toFixed(2)}</span>
                        <span className="text-amber-400">50 EMA: ${item.triggerFilter.ema50.toFixed(2)}</span>
                    </div>
                    <p className="text-[11px] text-slate-400 pl-6 leading-normal">
                        {item.triggerFilter.details}
                    </p>
                </div>
            </div>
        </div>
    );
}
