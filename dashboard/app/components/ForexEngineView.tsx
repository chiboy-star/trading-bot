'use client';

import React, { useState } from 'react';
import {
    Activity,
    AlertTriangle,
    ArrowUpRight,
    Award,
    Banknote,
    CheckCircle2,
    Clock,
    Compass,
    DollarSign,
    Globe,
    Layers,
    Radio,
    ShieldCheck,
    Sliders,
    TrendingDown,
    TrendingUp,
    Wallet,
    Zap
} from 'lucide-react';

// Configuration constant for USDT/USD to NGN conversion
const USD_TO_NGN_RATE = 1325.71;

const ngnFormatter = new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

function formatNGN(usdAmount: number): string {
    return ngnFormatter.format(usdAmount * USD_TO_NGN_RATE);
}

function formatPnlNGN(usdAmount: number): string {
    const ngn = usdAmount * USD_TO_NGN_RATE;
    if (ngn > 0) return `+${ngnFormatter.format(ngn)}`;
    return ngnFormatter.format(ngn);
}

interface ForexPairMock {
    symbol: string;
    bid: number;
    ask: number;
    spreadPips: number;
    change24hPct: number;
    adx: number;
    adxPassed: boolean;
    rsi: number;
    rsiPassed: boolean;
    emaState: string;
    emaPassed: boolean;
    posture: 'ACTIVE_LONG' | 'CASH';
    positionSummary: string;
    pipValueUsd: number;
}

const FOREX_PAIRS: ForexPairMock[] = [
    {
        symbol: 'EUR/USD',
        bid: 1.08418,
        ask: 1.08430,
        spreadPips: 1.2,
        change24hPct: 0.38,
        adx: 28.4,
        adxPassed: true,
        rsi: 54.2,
        rsiPassed: true,
        emaState: '20 > 50 EMA Bullish Cross',
        emaPassed: true,
        posture: 'ACTIVE_LONG',
        positionSummary: 'Active Long: EUR/USD holding above 20 EMA with 1.5x ATR trailing stop at 1.0820 (+26.8 pips / +₦112,685.35).',
        pipValueUsd: 10.0
    },
    {
        symbol: 'GBP/USD',
        bid: 1.29152,
        ask: 1.29170,
        spreadPips: 1.8,
        change24hPct: -0.14,
        adx: 18.2,
        adxPassed: false,
        rsi: 48.1,
        rsiPassed: true,
        emaState: 'No Cross (20 EMA Flat)',
        emaPassed: false,
        posture: 'CASH',
        positionSummary: 'Sitting in cash: GBP/USD is rangebound below London session resistance (ADX 18.2 <= 25). Awaiting breakout trend.',
        pipValueUsd: 10.0
    },
    {
        symbol: 'USD/JPY',
        bid: 154.620,
        ask: 154.635,
        spreadPips: 1.5,
        change24hPct: -0.52,
        adx: 32.1,
        adxPassed: true,
        rsi: 42.5,
        rsiPassed: true,
        emaState: '20 < 50 EMA Bearish Alignment',
        emaPassed: false,
        posture: 'CASH',
        positionSummary: 'Sitting in cash: USD/JPY is in a strong downward trend (ADX 32.1), but engine is long-only and waiting for bullish reversal crossover.',
        pipValueUsd: 6.46
    }
];

export default function ForexEngineView() {
    const [selectedPair, setSelectedPair] = useState<string>('EUR/USD');

    return (
        <div className="space-y-6">
            {/* OANDA Live Demo Status Banner */}
            <div className="bg-gradient-to-r from-blue-950/40 via-indigo-950/30 to-slate-900 border border-blue-500/30 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="flex items-center gap-3.5">
                    <div className="p-3 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shadow-md shadow-blue-500/10">
                        <Globe className="w-6 h-6 text-blue-400" />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h2 className="text-base font-bold text-white tracking-tight">
                                OANDA v20 Engine Scaffolding (Demo Environment)
                            </h2>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 border border-blue-400/30">
                                PRACTICE ACCOUNT
                            </span>
                            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                                CONNECTED
                            </span>
                        </div>
                        <p className="text-xs text-slate-300 mt-0.5">
                            Account: <span className="font-mono text-cyan-300 font-semibold">001-004-9842109-001</span> • Leverage: <span className="text-white font-semibold">1:50</span> • Session: <span className="text-amber-300 font-medium">London / NY Overlap</span>
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    <div className="px-3 py-1.5 rounded-xl bg-slate-900/80 border border-slate-800 text-xs text-slate-300 flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        <span>Daily Max Loss: <strong>5% ($1,274.00)</strong></span>
                    </div>
                </div>
            </div>

            {/* 1. FOREX METRICS ROW */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                {/* Metric 1: Total FX Balance */}
                <div className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm">
                    <div className="flex items-center justify-between text-slate-400 mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider">Demo FX Balance</span>
                        <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
                            <Wallet className="w-4 h-4" />
                        </div>
                    </div>
                    <div className="text-2xl font-black text-white">
                        {formatNGN(25480.50)}
                    </div>
                    <div className="mt-2 text-xs text-slate-400 flex items-center justify-between">
                        <span>$25,480.50 USD</span>
                        <span className="text-slate-500 font-mono">Init: $25,000.00</span>
                    </div>
                </div>

                {/* Metric 2: Unrealized PnL */}
                <div className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm">
                    <div className="flex items-center justify-between text-slate-400 mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider">Unrealized FX PnL</span>
                        <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <TrendingUp className="w-4 h-4" />
                        </div>
                    </div>
                    <div className="text-2xl font-black text-emerald-400">
                        {formatPnlNGN(342.80)}
                    </div>
                    <div className="mt-2 text-xs text-emerald-400 flex items-center justify-between">
                        <span>+$342.80 USD (+1.37%)</span>
                        <span className="text-slate-400 font-semibold">+26.8 Pips</span>
                    </div>
                </div>

                {/* Metric 3: Margin Used & Free Margin */}
                <div className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm">
                    <div className="flex items-center justify-between text-slate-400 mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider">Margin Health</span>
                        <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                            <Sliders className="w-4 h-4" />
                        </div>
                    </div>
                    <div className="text-2xl font-black text-white">
                        2,038%
                    </div>
                    <div className="mt-2 text-xs text-slate-400 flex items-center justify-between">
                        <span>Used: $1,250.00</span>
                        <span className="text-cyan-400 font-semibold">Free: $24,230.50</span>
                    </div>
                </div>

                {/* Metric 4: Daily Win Rate */}
                <div className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm">
                    <div className="flex items-center justify-between text-slate-400 mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider">Forex Win Rate</span>
                        <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                            <Award className="w-4 h-4" />
                        </div>
                    </div>
                    <div className="text-2xl font-black text-white">
                        66.7%
                    </div>
                    <div className="mt-2 text-xs text-slate-400 flex items-center gap-1.5">
                        <span className="text-emerald-400 font-semibold">4W</span>
                        <span>/</span>
                        <span className="text-red-400 font-semibold">2L</span>
                        <span className="text-slate-500">(Profit Factor: 2.14)</span>
                    </div>
                </div>

                {/* Metric 5: Active FX Positions */}
                <div className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm">
                    <div className="flex items-center justify-between text-slate-400 mb-2">
                        <span className="text-xs font-semibold uppercase tracking-wider">Active Exposure</span>
                        <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                            <Activity className="w-4 h-4" />
                        </div>
                    </div>
                    <div className="text-2xl font-black text-white">
                        1 Position
                    </div>
                    <div className="mt-2 text-xs text-slate-400 flex items-center justify-between">
                        <span>EUR/USD Long</span>
                        <span className="text-emerald-400 font-medium">0.30 Lots</span>
                    </div>
                </div>
            </div>

            {/* 2. MONITORED FOREX PAIRS (EUR/USD, GBP/USD, USD/JPY) */}
            <div className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-6 shadow-xl shadow-black/30 backdrop-blur-sm space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
                    <div className="flex items-center gap-2.5">
                        <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
                            <Layers className="w-4 h-4" />
                        </div>
                        <div>
                            <h3 className="text-base font-bold text-white tracking-tight">
                                Monitored Forex Pairs: Regime &amp; Signals
                            </h3>
                            <p className="text-xs text-slate-400">
                                Live quotes, pip spread, quantitative regime checklist, and posture explainer
                            </p>
                        </div>
                    </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                    {FOREX_PAIRS.map((pair) => {
                        const isLong = pair.posture === 'ACTIVE_LONG';
                        return (
                            <div
                                key={pair.symbol}
                                className={`bg-slate-900/80 border rounded-xl p-5 space-y-4 shadow-md transition-all ${
                                    isLong ? 'border-emerald-500/40 shadow-emerald-500/5' : 'border-slate-800 hover:border-slate-700'
                                }`}
                            >
                                {/* Header */}
                                <div className="flex items-center justify-between">
                                    <div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-base font-bold text-white">{pair.symbol}</span>
                                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                                                {pair.spreadPips} pips
                                            </span>
                                        </div>
                                        <div className="text-[11px] text-slate-400 mt-0.5">
                                            Bid: <span className="font-mono text-slate-200">{pair.bid.toFixed(pair.symbol.includes('JPY') ? 3 : 5)}</span> • Ask: <span className="font-mono text-slate-200">{pair.ask.toFixed(pair.symbol.includes('JPY') ? 3 : 5)}</span>
                                        </div>
                                    </div>

                                    {isLong ? (
                                        <span className="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                                            ACTIVE LONG
                                        </span>
                                    ) : (
                                        <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-slate-800 text-slate-400 border border-slate-700">
                                            SITTING IN CASH
                                        </span>
                                    )}
                                </div>

                                {/* Posture Explainer */}
                                <div className={`p-3 rounded-lg border text-xs leading-relaxed ${
                                    isLong ? 'bg-emerald-950/20 border-emerald-500/30 text-emerald-200' : 'bg-slate-950/50 border-slate-800/80 text-slate-300'
                                }`}>
                                    &ldquo;{pair.positionSummary}&rdquo;
                                </div>

                                {/* Quantitative Checklist */}
                                <div className="space-y-2 pt-1 border-t border-slate-800/70 text-xs">
                                    <div className="flex items-center justify-between">
                                        <span className="text-slate-400">Trend (ADX &gt; 25):</span>
                                        <span className={`font-semibold font-mono ${pair.adxPassed ? 'text-emerald-400' : 'text-red-400'}`}>
                                            ADX {pair.adx.toFixed(1)} ({pair.adxPassed ? 'PASS' : 'FAIL'})
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-slate-400">Momentum (RSI 40-65):</span>
                                        <span className={`font-semibold font-mono ${pair.rsiPassed ? 'text-emerald-400' : 'text-red-400'}`}>
                                            RSI {pair.rsi.toFixed(1)} ({pair.rsiPassed ? 'PASS' : 'FAIL'})
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="text-slate-400">EMA Trigger:</span>
                                        <span className={`font-medium ${pair.emaPassed ? 'text-cyan-400' : 'text-slate-400'}`}>
                                            {pair.emaState}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* 3. ACTIVE FOREX POSITIONS TABLE */}
            <div className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-6 shadow-xl shadow-black/30 backdrop-blur-sm space-y-4">
                <div className="flex items-center justify-between">
                    <div>
                        <h3 className="text-base font-bold text-white">Active Forex Positions</h3>
                        <p className="text-xs text-slate-400">
                            Simulated OANDA practice positions with pip tracking and Naira conversion
                        </p>
                    </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-slate-800/80">
                    <table className="w-full text-left text-xs text-slate-300">
                        <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold border-b border-slate-800 tracking-wider">
                            <tr>
                                <th className="py-3 px-4">Ticket</th>
                                <th className="py-3 px-4">Instrument</th>
                                <th className="py-3 px-4">Side</th>
                                <th className="py-3 px-4 text-right">Units / Lots</th>
                                <th className="py-3 px-4 text-right">Entry Rate</th>
                                <th className="py-3 px-4 text-right">Current Rate</th>
                                <th className="py-3 px-4 text-right">Trailing Stop</th>
                                <th className="py-3 px-4 text-right">Unrealized PnL</th>
                                <th className="py-3 px-4 text-center">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60 bg-[#0A0E17]/40">
                            <tr className="hover:bg-slate-800/30 transition-colors">
                                <td className="py-3 px-4 font-mono text-cyan-400 font-semibold">#FX-EUR-942</td>
                                <td className="py-3 px-4 font-bold text-white">EUR/USD</td>
                                <td className="py-3 px-4">
                                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                                        BUY (LONG)
                                    </span>
                                </td>
                                <td className="py-3 px-4 text-right font-mono text-slate-200">30,000 (0.30)</td>
                                <td className="py-3 px-4 text-right font-mono text-slate-300">1.08150</td>
                                <td className="py-3 px-4 text-right font-mono text-white font-semibold">1.08418</td>
                                <td className="py-3 px-4 text-right font-mono text-amber-400">1.08200 (1.5x ATR)</td>
                                <td className="py-3 px-4 text-right font-mono font-bold text-emerald-400">
                                    +₦112,685.35 <span className="text-[10px] text-emerald-300">(+26.8 pips / +$85.00)</span>
                                </td>
                                <td className="py-3 px-4 text-center">
                                    <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                        TRAILING
                                    </span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            {/* 4. OANDA INTEGRATION ARCHITECTURE CARD */}
            <div className="bg-[#0A0E18]/60 border border-slate-800/80 rounded-2xl p-5 text-xs text-slate-400 space-y-2">
                <div className="flex items-center gap-2 font-bold text-slate-200">
                    <Compass className="w-4 h-4 text-blue-400" />
                    <span>Forex Quantitative Scaffolding Notice</span>
                </div>
                <p className="leading-relaxed">
                    This view scaffolds multi-market integration for the OANDA v20 REST API. When live trading is activated via your <code className="text-cyan-400 font-mono">OANDA_API_KEY</code> and <code className="text-cyan-400 font-mono">OANDA_ACCOUNT_ID</code>, the engine streams institutional bid/ask tick data, enforces strict pip-based 1.5x ATR trailing stops, and applies our validated 20/50 EMA + ADX &gt; 25 trend filters across global FX pairs.
                </p>
            </div>
        </div>
    );
}
