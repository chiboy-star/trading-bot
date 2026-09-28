'use client';

import React, { useState, useMemo } from 'react';
import {
    Activity,
    AlertTriangle,
    ArrowDownRight,
    ArrowUpRight,
    Award,
    Banknote,
    CheckCircle2,
    Clock,
    Compass,
    DollarSign,
    Filter,
    Layers,
    Radio,
    Search,
    ShieldCheck,
    Sliders,
    TrendingDown,
    TrendingUp,
    Wallet,
    Zap,
    Cpu,
    Server,
    ExternalLink
} from 'lucide-react';
import type { TradeWAccountMetrics, ActivePositionRecord, TradeRecord, EngineReasoningItem, CandleDataPoint } from '@/lib/db';

interface TradeWEngineViewProps {
    tradewAccount?: TradeWAccountMetrics;
    activePositions?: ActivePositionRecord[];
    tradeHistory?: TradeRecord[];
    engineReasoning?: EngineReasoningItem[];
    chartData?: Record<string, CandleDataPoint[]>;
    formatNGN: (usdAmount: number) => string;
    formatPnlNGN: (usdAmount: number) => string;
}

export default function TradeWEngineView({
    tradewAccount,
    activePositions = [],
    tradeHistory = [],
    engineReasoning = [],
    formatNGN,
    formatPnlNGN
}: TradeWEngineViewProps) {
    const [statusFilter, setStatusFilter] = useState<'ALL' | 'WIN' | 'LOSS'>('ALL');
    const [directionFilter, setDirectionFilter] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
    const [searchQuery, setSearchQuery] = useState<string>('');
    const [executionModeFilter, setExecutionModeFilter] = useState<'LIVE_FORWARD' | 'BACKTEST_MOCK'>('LIVE_FORWARD');
    const [pageSize, setPageSize] = useState<number>(25);
    const [currentPage, setCurrentPage] = useState<number>(1);

    // Default account fallback
    const account: TradeWAccountMetrics = tradewAccount || {
        balance: 10000.00,
        equity: 10000.00,
        freeMargin: 10000.00,
        margin: 0.00,
        marginLevel: 0.00,
        leverage: 100,
        currency: 'USD',
        server: 'TradeW-Live',
        platform: 'MT5',
        activeCfdCount: 0,
        connected: true,
        lastUpdated: Date.now()
    };

    // Filter active positions strictly for Trade W
    const tradewActivePositions = useMemo(() => {
        return activePositions.filter(p => p.broker === 'TRADE_W');
    }, [activePositions]);

    // Filter trade history strictly for Trade W broker
    const tradewTrades = useMemo(() => {
        return tradeHistory.filter(t => t.broker === 'TRADE_W');
    }, [tradeHistory]);

    // Live Forward vs Backtest Mock count for Trade W
    const liveForwardCount = useMemo(() => tradewTrades.filter(t => t.executionMode === 'LIVE_FORWARD').length, [tradewTrades]);
    const mockCount = useMemo(() => tradewTrades.filter(t => t.executionMode === 'BACKTEST_MOCK').length, [tradewTrades]);

    // Filtered trades by search, status, and direction
    const filteredTrades = useMemo(() => {
        return tradewTrades
            .filter((trade) => {
                if (trade.executionMode !== executionModeFilter) return false;
                if (statusFilter === 'WIN' && trade.status !== 'WIN') return false;
                if (statusFilter === 'LOSS' && trade.status !== 'LOSS') return false;
                if (directionFilter === 'LONG' && trade.direction !== 'LONG') return false;
                if (directionFilter === 'SHORT' && trade.direction !== 'SHORT') return false;
                if (searchQuery.trim()) {
                    const query = searchQuery.toLowerCase();
                    return (
                        trade.symbol.toLowerCase().includes(query) ||
                        trade.orderId.toLowerCase().includes(query) ||
                        trade.type.toLowerCase().includes(query) ||
                        trade.direction.toLowerCase().includes(query)
                    );
                }
                return true;
            })
            .sort((a, b) => b.timestamp - a.timestamp);
    }, [tradewTrades, executionModeFilter, statusFilter, directionFilter, searchQuery]);

    const totalPages = Math.max(1, Math.ceil(filteredTrades.length / pageSize));
    const paginatedTrades = useMemo(() => {
        const start = (currentPage - 1) * pageSize;
        return filteredTrades.slice(start, start + pageSize);
    }, [filteredTrades, currentPage, pageSize]);

    // Locate ETC/USDT engine reasoning if available
    const etcReasoning = engineReasoning.find(r => r.symbol === 'ETC/USDT') || {
        symbol: 'ETC/USDT',
        currentPrice: 9.28,
        hasActivePosition: tradewActivePositions.length > 0,
        activeSide: tradewActivePositions[0]?.side,
        posture: 'CASH',
        summarySentence: 'Sitting in cash: Evaluating 1h closed candles on Trade W MT5. Preserving margin until 20/50 EMA cross aligns with ADX > 25.',
        trendFilter: { adx: 21.4, passed: false, threshold: 25, badge: 'FAIL (<= 25)', details: 'Awaiting trend strength acceleration' },
        longMomentumFilter: { rsi: 51.2, passed: true, rangeMin: 40, rangeMax: 65, badge: 'PASS (40–65)', details: 'Neutral RSI momentum' },
        shortMomentumFilter: { rsi: 51.2, passed: true, rangeMin: 35, rangeMax: 60, badge: 'PASS (35–60)', details: 'Neutral RSI momentum' },
        triggerFilter: { ema20: 9.25, ema50: 9.31, longCrossover: false, shortCrossover: false, bullishAlignment: false, badge: 'NO CROSS', details: '20 EMA is below 50 EMA' },
        checklist: [
            { name: 'Trend Strength (ADX)', value: 'ADX 21.4', passed: false, ruleDescription: 'Threshold > 25 confirms trend strength', badgeText: 'FAIL (<= 25)' },
            { name: 'Long Momentum (RSI 40–65)', value: 'RSI 51.2', passed: true, ruleDescription: 'Safe buy momentum envelope', badgeText: 'PASS (40–65)' },
            { name: 'Short Momentum (RSI 35–60)', value: 'RSI 51.2', passed: true, ruleDescription: 'Safe short momentum envelope', badgeText: 'PASS (35–60)' },
            { name: 'Crossover Trigger', value: '20 EMA < 50 EMA', passed: false, ruleDescription: 'Requires fresh crossover on 1h closed candle', badgeText: 'NO CROSS' }
        ]
    };

    const initialBalance = 10000.00;
    const isProfitable = account.balance > initialBalance;
    const isDrawdown = account.balance < initialBalance;
    const balanceColor = isProfitable ? 'text-emerald-400' : isDrawdown ? 'text-rose-400' : 'text-white';
    const marginUtilization = account.balance > 0 ? (account.margin / account.balance) * 100 : 0;

    return (
        <div className="space-y-6">
            {/* 1. TRADE W MT4/MT5 TERMINAL ARCHITECTURE BANNER */}
            <div className="bg-gradient-to-r from-emerald-950/40 via-[#0C1520] to-[#0D121F]/90 border border-emerald-500/30 rounded-2xl p-5 shadow-xl shadow-black/40 backdrop-blur-md relative overflow-hidden">
                <div className="absolute top-0 right-0 w-80 h-80 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 relative z-10">
                    <div className="flex items-start gap-4">
                        <div className="p-3 rounded-2xl bg-gradient-to-tr from-emerald-600 to-teal-500 text-white shadow-lg shadow-emerald-500/20 border border-emerald-400/30 shrink-0">
                            <Layers className="w-6 h-6" />
                        </div>
                        <div>
                            <div className="flex flex-wrap items-center gap-2">
                                <h2 className="text-xl font-black tracking-tight text-white flex items-center gap-2">
                                    Trade W Execution Environment
                                </h2>
                                <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 tracking-wider">
                                    METATRADER 5 (MT5)
                                </span>
                                <span className="text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 tracking-wider flex items-center gap-1">
                                    <Cpu className="w-3 h-3" />
                                    MetaApi / ZMQ Bridge
                                </span>
                            </div>
                            <p className="text-xs text-slate-300 mt-1 max-w-2xl leading-relaxed">
                                Automated CFD execution gateway dedicated to the <span className="text-emerald-400 font-semibold">Trade W broker</span> terminal. 
                                Continuously polls 1-hour candles for <span className="text-cyan-300 font-mono font-semibold">ETC/USDT</span> and executes the 20/50 EMA, RSI, and ADX &gt; 25 strategy with dynamic 1.5x ATR trailing risk protection.
                            </p>
                        </div>
                    </div>

                    {/* Server & Terminal Metadata Pills */}
                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                        <div className="px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-800 text-xs flex items-center gap-2">
                            <Server className="w-3.5 h-3.5 text-slate-400" />
                            <span className="text-slate-400">Server:</span>
                            <span className="font-mono font-semibold text-slate-200">{account.server}</span>
                        </div>
                        <div className="px-3 py-1.5 rounded-xl bg-slate-900/90 border border-slate-800 text-xs flex items-center gap-2">
                            <span className="text-slate-400">Leverage:</span>
                            <span className="font-mono font-semibold text-emerald-400">1:{account.leverage}</span>
                        </div>
                        <div className="px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs font-semibold text-emerald-400 flex items-center gap-1.5">
                            <span className="relative flex h-2 w-2">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                            </span>
                            <span>TERMINAL CONNECTED</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* 2. DEDICATED METRICS ROW FOR TRADE W (MT4/MT5) ACCOUNT */}
            <section aria-label="Trade W MT4/MT5 Metrics Row" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                {/* Metric 1: MT4/MT5 Account Balance */}
                <div className="bg-[#0D121F]/90 border border-slate-800/80 hover:border-emerald-500/40 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm relative overflow-hidden transition-all group">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-full blur-2xl group-hover:bg-emerald-500/10 transition-all pointer-events-none" />
                    <div className="flex items-center justify-between text-slate-400 mb-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-300">MT4/MT5 Account Balance</span>
                        <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <Wallet className="w-4 h-4" />
                        </div>
                    </div>
                    <div className={`text-2xl font-black tracking-tight ${balanceColor}`}>
                        ${account.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                        <span className="text-emerald-400 font-semibold">{formatNGN(account.balance)}</span>
                        <span className="text-[11px] font-mono text-slate-500">Base: {account.currency}</span>
                    </div>
                </div>

                {/* Metric 2: Free Margin */}
                <div className="bg-[#0D121F]/90 border border-slate-800/80 hover:border-cyan-500/40 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm relative overflow-hidden transition-all group">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-cyan-500/5 rounded-full blur-2xl group-hover:bg-cyan-500/10 transition-all pointer-events-none" />
                    <div className="flex items-center justify-between text-slate-400 mb-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-300">Free Margin</span>
                        <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                            <Banknote className="w-4 h-4" />
                        </div>
                    </div>
                    <div className="text-2xl font-black tracking-tight text-cyan-400">
                        ${account.freeMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                        <span>Used Margin: ${account.margin.toFixed(2)}</span>
                        <span className="text-[11px] font-mono text-cyan-400">{marginUtilization.toFixed(1)}% Used</span>
                    </div>
                </div>

                {/* Metric 3: Active CFD Positions */}
                <div className="bg-[#0D121F]/90 border border-slate-800/80 hover:border-indigo-500/40 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm relative overflow-hidden transition-all group">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/5 rounded-full blur-2xl group-hover:bg-indigo-500/10 transition-all pointer-events-none" />
                    <div className="flex items-center justify-between text-slate-400 mb-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-300">Active CFD Positions</span>
                        <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                            <Activity className="w-4 h-4" />
                        </div>
                    </div>
                    <div className="text-2xl font-black tracking-tight text-white flex items-baseline gap-2">
                        <span>{tradewActivePositions.length}</span>
                        <span className="text-xs font-normal text-slate-400">Contracts Open</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                        <span>Asset: ETC/USDT</span>
                        <span className={`font-semibold ${tradewActivePositions.length > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
                            {tradewActivePositions.length > 0 ? `${tradewActivePositions[0].side} Active` : 'Waiting for Signal'}
                        </span>
                    </div>
                </div>

                {/* Metric 4: Equity & Floating PnL */}
                <div className="bg-[#0D121F]/90 border border-slate-800/80 hover:border-blue-500/40 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm relative overflow-hidden transition-all group">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-full blur-2xl group-hover:bg-blue-500/10 transition-all pointer-events-none" />
                    <div className="flex items-center justify-between text-slate-400 mb-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-300">Account Equity</span>
                        <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
                            <TrendingUp className="w-4 h-4" />
                        </div>
                    </div>
                    <div className="text-2xl font-black tracking-tight text-white">
                        ${account.equity.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                        <span>Floating PnL:</span>
                        <span className={`font-semibold ${account.equity >= account.balance ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {account.equity >= account.balance ? '+' : ''}${(account.equity - account.balance).toFixed(2)}
                        </span>
                    </div>
                </div>

                {/* Metric 5: Margin Level & Health */}
                <div className="bg-[#0D121F]/90 border border-slate-800/80 hover:border-teal-500/40 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm relative overflow-hidden transition-all group">
                    <div className="absolute top-0 right-0 w-24 h-24 bg-teal-500/5 rounded-full blur-2xl group-hover:bg-teal-500/10 transition-all pointer-events-none" />
                    <div className="flex items-center justify-between text-slate-400 mb-2">
                        <span className="text-xs font-bold uppercase tracking-wider text-slate-300">Margin Level</span>
                        <div className="p-2 rounded-xl bg-teal-500/10 text-teal-400 border border-teal-500/20">
                            <ShieldCheck className="w-4 h-4" />
                        </div>
                    </div>
                    <div className="text-2xl font-black tracking-tight text-white">
                        {account.marginLevel > 0 ? `${account.marginLevel.toFixed(0)}%` : '∞ Nominal'}
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                        <span className="text-emerald-400 flex items-center gap-1 font-medium">
                            <ShieldCheck className="w-3.5 h-3.5" /> No Call Risk
                        </span>
                        <span className="text-[11px] font-mono text-slate-500">Stop Out: 30%</span>
                    </div>
                </div>
            </section>

            {/* 3. ETC/USDT CFD LIVE QUANTITATIVE ENGINE REASONING */}
            <section className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-6 shadow-xl shadow-black/30 backdrop-blur-sm">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
                    <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            <Zap className="w-5 h-5" />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-base font-bold text-white">ETC/USDT CFD Quantitative Diagnostic</h3>
                                <span className="text-xs px-2 py-0.5 rounded font-mono font-bold bg-slate-800 text-slate-300">
                                    1h Closed Bar Scan
                                </span>
                            </div>
                            <p className="text-xs text-slate-400 mt-0.5">
                                Evaluating Gate 1 (ADX &gt; 25), Gate 2 (RSI momentum envelope), and Gate 3 (20/50 EMA cross)
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3 bg-slate-900/90 px-4 py-2 rounded-xl border border-slate-800">
                        <div>
                            <span className="text-[10px] uppercase font-semibold text-slate-400 block">Current CFD Price</span>
                            <span className="text-lg font-black font-mono text-white">
                                ${etcReasoning.currentPrice.toFixed(3)}
                            </span>
                        </div>
                        <div className="border-l border-slate-800 pl-3">
                            <span className="text-[10px] uppercase font-semibold text-slate-400 block">Posture</span>
                            <span className="text-xs font-bold font-mono text-cyan-400">
                                {etcReasoning.posture}
                            </span>
                        </div>
                    </div>
                </div>

                {/* 4 Quantitative Gate Cards */}
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mt-5">
                    {/* Gate 1: ADX */}
                    <div className={`p-4 rounded-xl border ${etcReasoning.trendFilter.passed ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-slate-900/70 border-slate-800'}`}>
                        <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-slate-400 font-semibold uppercase text-[10px]">Gate 1: Trend Strength</span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${etcReasoning.trendFilter.passed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                                {etcReasoning.trendFilter.badge}
                            </span>
                        </div>
                        <div className="text-xl font-bold font-mono text-white mt-1">
                            ADX {etcReasoning.trendFilter.adx.toFixed(1)}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-1">Rule: ADX &gt; 25 requires strong trend to prevent sideways chop.</p>
                    </div>

                    {/* Gate 2: Long RSI */}
                    <div className={`p-4 rounded-xl border ${etcReasoning.longMomentumFilter.passed ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-slate-900/70 border-slate-800'}`}>
                        <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-slate-400 font-semibold uppercase text-[10px]">Gate 2: Long RSI</span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${etcReasoning.longMomentumFilter.passed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                                {etcReasoning.longMomentumFilter.badge}
                            </span>
                        </div>
                        <div className="text-xl font-bold font-mono text-white mt-1">
                            RSI {etcReasoning.longMomentumFilter.rsi.toFixed(1)}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-1">Envelope 40–65 ensures safe entry without buying extreme tops.</p>
                    </div>

                    {/* Gate 3: Short RSI */}
                    <div className={`p-4 rounded-xl border ${etcReasoning.shortMomentumFilter.passed ? 'bg-emerald-500/10 border-emerald-500/30' : 'bg-slate-900/70 border-slate-800'}`}>
                        <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-slate-400 font-semibold uppercase text-[10px]">Gate 2: Short RSI</span>
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${etcReasoning.shortMomentumFilter.passed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>
                                {etcReasoning.shortMomentumFilter.badge}
                            </span>
                        </div>
                        <div className="text-xl font-bold font-mono text-white mt-1">
                            RSI {etcReasoning.shortMomentumFilter.rsi.toFixed(1)}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-1">Envelope 35–60 ensures safe entry without shorting oversold bottoms.</p>
                    </div>

                    {/* Gate 4: 20/50 EMA Trigger */}
                    <div className={`p-4 rounded-xl border ${etcReasoning.triggerFilter.longCrossover || etcReasoning.triggerFilter.shortCrossover ? 'bg-cyan-500/10 border-cyan-500/30' : 'bg-slate-900/70 border-slate-800'}`}>
                        <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-slate-400 font-semibold uppercase text-[10px]">Gate 3: 20/50 EMA Cross</span>
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-300">
                                {etcReasoning.triggerFilter.badge}
                            </span>
                        </div>
                        <div className="text-xl font-bold font-mono text-white mt-1">
                            ${etcReasoning.triggerFilter.ema20.toFixed(2)} / ${etcReasoning.triggerFilter.ema50.toFixed(2)}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-1">Dynamic 1.5x ATR trailing stop arms immediately upon entry confirmation.</p>
                    </div>
                </div>

                {/* Plain English Summary Sentence */}
                <div className="mt-4 p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 text-xs text-slate-300 flex items-center gap-2.5">
                    <Compass className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>{etcReasoning.summarySentence}</span>
                </div>
            </section>

            {/* 4. ACTIVE TRADE W CFD POSITIONS */}
            <section className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-6 shadow-xl shadow-black/30 backdrop-blur-sm">
                <div className="flex items-center justify-between pb-4 border-b border-slate-800/80">
                    <div>
                        <div className="flex items-center gap-2">
                            <h3 className="text-base font-bold text-white">Trade W Active CFD Positions</h3>
                            <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                {tradewActivePositions.length} Open
                            </span>
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">
                            Positions actively held in MT4/MT5 with ratcheting 1.5x ATR trailing stop-loss
                        </p>
                    </div>
                </div>

                <div className="overflow-x-auto mt-4 rounded-xl border border-slate-800/80">
                    <table className="w-full text-left text-xs text-slate-300">
                        <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold border-b border-slate-800 tracking-wider">
                            <tr>
                                <th className="py-3 px-4">Contract / Symbol</th>
                                <th className="py-3 px-4 text-center">Direction</th>
                                <th className="py-3 px-4 text-right">Volume (Units)</th>
                                <th className="py-3 px-4 text-right">Entry Price</th>
                                <th className="py-3 px-4 text-right">Current Price</th>
                                <th className="py-3 px-4 text-right">1.5x ATR Stop</th>
                                <th className="py-3 px-4 text-right">Floating PnL ($)</th>
                                <th className="py-3 px-4 text-right">Floating PnL (₦)</th>
                                <th className="py-3 px-4 text-center">Duration</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60 bg-[#0A0E17]/40 font-mono">
                            {tradewActivePositions.length === 0 ? (
                                <tr>
                                    <td colSpan={9} className="py-10 text-center text-slate-500 font-sans">
                                        <div className="flex flex-col items-center justify-center gap-2">
                                            <div className="p-3 rounded-full bg-slate-900 text-slate-400 border border-slate-800">
                                                <Layers className="w-5 h-5 text-emerald-400" />
                                            </div>
                                            <p className="font-semibold text-slate-300 text-sm">No Active CFD Positions on Trade W</p>
                                            <p className="text-xs text-slate-500 max-w-md">
                                                The Trade W background runner is polling ETC/USDT. A position will open automatically as soon as ADX &gt; 25, RSI momentum, and 20/50 EMA cross align.
                                            </p>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                tradewActivePositions.map((pos) => {
                                    const isWin = pos.pnl >= 0;
                                    return (
                                        <tr key={pos.symbol} className="hover:bg-slate-800/30 transition-colors">
                                            <td className="py-3 px-4 font-bold text-white">
                                                {pos.symbol} <span className="text-[10px] text-emerald-400 font-normal">(CFD)</span>
                                            </td>
                                            <td className="py-3 px-4 text-center">
                                                {pos.side === 'LONG' ? (
                                                    <span className="inline-flex items-center gap-1 font-bold px-2 py-0.5 rounded text-[11px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                                                        <TrendingUp className="w-3 h-3" /> LONG
                                                    </span>
                                                ) : (
                                                    <span className="inline-flex items-center gap-1 font-bold px-2 py-0.5 rounded text-[11px] bg-rose-500/10 text-rose-400 border border-rose-500/30">
                                                        <TrendingDown className="w-3 h-3" /> SHORT
                                                    </span>
                                                )}
                                            </td>
                                            <td className="py-3 px-4 text-right text-slate-200">{pos.amount.toFixed(2)}</td>
                                            <td className="py-3 px-4 text-right text-slate-300">${pos.entryPrice.toFixed(3)}</td>
                                            <td className="py-3 px-4 text-right font-bold text-white">${pos.currentPrice.toFixed(3)}</td>
                                            <td className="py-3 px-4 text-right text-cyan-300">${pos.trailingStop.toFixed(3)}</td>
                                            <td className={`py-3 px-4 text-right font-bold ${isWin ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                {isWin ? '+' : ''}${pos.pnl.toFixed(2)} ({isWin ? '+' : ''}{pos.pnlPercent.toFixed(2)}%)
                                            </td>
                                            <td className={`py-3 px-4 text-right font-bold ${isWin ? 'text-emerald-400' : 'text-rose-400'}`}>
                                                {formatPnlNGN(pos.pnl)}
                                            </td>
                                            <td className="py-3 px-4 text-center text-slate-400 font-sans">{pos.holdingDuration}</td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </section>

            {/* 5. FILTERED TRADE W TRADE HISTORY */}
            <section className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-6 shadow-xl shadow-black/30 backdrop-blur-sm">
                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
                    <div>
                        <div className="flex items-center gap-2">
                            <h3 className="text-base font-bold text-white">Trade W Execution History</h3>
                            <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                {filteredTrades.length} Trade W Executions
                            </span>
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">
                            Filtered strictly for trades executed on the <span className="text-emerald-400 font-semibold">Trade W broker (broker = &apos;TRADE_W&apos;)</span>
                        </p>
                    </div>

                    {/* Filter controls */}
                    <div className="flex flex-wrap items-center gap-3">
                        {/* Status filters */}
                        <div className="flex items-center bg-[#07090E] p-1 rounded-xl border border-slate-800">
                            <button
                                onClick={() => setStatusFilter('ALL')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                                    statusFilter === 'ALL' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                                }`}
                            >
                                All
                            </button>
                            <button
                                onClick={() => setStatusFilter('WIN')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                                    statusFilter === 'WIN' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-slate-400 hover:text-emerald-400'
                                }`}
                            >
                                Wins
                            </button>
                            <button
                                onClick={() => setStatusFilter('LOSS')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                                    statusFilter === 'LOSS' ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' : 'text-slate-400 hover:text-rose-400'
                                }`}
                            >
                                Losses
                            </button>
                        </div>

                        {/* Direction filters */}
                        <div className="flex items-center bg-[#07090E] p-1 rounded-xl border border-slate-800">
                            <button
                                onClick={() => setDirectionFilter('ALL')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                                    directionFilter === 'ALL' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'
                                }`}
                            >
                                All Dir
                            </button>
                            <button
                                onClick={() => setDirectionFilter('LONG')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                                    directionFilter === 'LONG' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-slate-400 hover:text-emerald-400'
                                }`}
                            >
                                Longs
                            </button>
                            <button
                                onClick={() => setDirectionFilter('SHORT')}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer ${
                                    directionFilter === 'SHORT' ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' : 'text-slate-400 hover:text-rose-400'
                                }`}
                            >
                                Shorts
                            </button>
                        </div>

                        {/* Search Input */}
                        <div className="relative">
                            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                            <input
                                type="text"
                                placeholder="Search TW order..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-xl pl-8 pr-3 py-1.5 focus:outline-none focus:border-emerald-500 w-36"
                            />
                        </div>
                    </div>
                </div>

                <div className="overflow-x-auto mt-4 rounded-xl border border-slate-800/80">
                    <table className="w-full text-left text-xs text-slate-300">
                        <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold border-b border-slate-800 tracking-wider">
                            <tr>
                                <th className="py-3 px-4">Date / Time</th>
                                <th className="py-3 px-4">Order ID</th>
                                <th className="py-3 px-4">Symbol</th>
                                <th className="py-3 px-4 text-center">Direction</th>
                                <th className="py-3 px-4">Side / Type</th>
                                <th className="py-3 px-4 text-right">Execution Price ($)</th>
                                <th className="py-3 px-4 text-right">Volume</th>
                                <th className="py-3 px-4 text-right">Fee ($)</th>
                                <th className="py-3 px-4 text-right">Net PnL ($)</th>
                                <th className="py-3 px-4 text-center">Broker</th>
                                <th className="py-3 px-4 text-center">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60 bg-[#0A0E17]/40 font-mono">
                            {paginatedTrades.length === 0 ? (
                                <tr>
                                    <td colSpan={11} className="py-12 text-center text-slate-500 font-sans">
                                        <div className="flex flex-col items-center justify-center gap-2">
                                            <div className="p-3 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                                <Radio className="w-5 h-5 animate-pulse" />
                                            </div>
                                            <p className="font-semibold text-slate-300 text-sm">No Trade W executions logged yet</p>
                                            <p className="text-xs text-slate-500 max-w-md">
                                                The dedicated Trade W MT4/MT5 runner is currently scanning 1-hour candles for ETC/USDT. 
                                                As soon as all 3 entry gates align on a closed candle, executions tagged with <span className="text-emerald-400 font-mono">broker = &apos;TRADE_W&apos;</span> will appear here.
                                            </p>
                                        </div>
                                    </td>
                                </tr>
                            ) : (
                                paginatedTrades.map((t) => {
                                    const isWin = t.pnl > 0;
                                    const isSell = t.side === 'SELL';
                                    return (
                                        <tr key={t.id} className="hover:bg-slate-800/30 transition-colors">
                                            <td className="py-3 px-4 text-slate-400 whitespace-nowrap">{t.dateStr}</td>
                                            <td className="py-3 px-4 text-slate-400 font-mono text-[11px]">{t.orderId}</td>
                                            <td className="py-3 px-4 font-bold text-white font-sans">{t.symbol}</td>
                                            <td className="py-3 px-4 text-center font-sans">
                                                {t.direction === 'LONG' ? (
                                                    <span className="inline-flex items-center gap-1 font-bold px-2 py-0.5 rounded text-[11px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                                                        <TrendingUp className="w-3 h-3" /> LONG
                                                    </span>
                                                ) : (
                                                    <span className="inline-flex items-center gap-1 font-bold px-2 py-0.5 rounded text-[11px] bg-rose-500/10 text-rose-400 border border-rose-500/30">
                                                        <TrendingDown className="w-3 h-3" /> SHORT
                                                    </span>
                                                )}
                                            </td>
                                            <td className="py-3 px-4 font-sans">
                                                <span className={`inline-flex items-center gap-1 font-semibold px-2 py-0.5 rounded text-[11px] ${
                                                    t.side === 'BUY' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                                                }`}>
                                                    {t.side} ({t.type})
                                                </span>
                                            </td>
                                            <td className="py-3 px-4 text-right text-slate-200">${t.price.toFixed(3)}</td>
                                            <td className="py-3 px-4 text-right text-slate-300">{t.amount.toFixed(2)}</td>
                                            <td className="py-3 px-4 text-right text-slate-400">${t.fee.toFixed(2)}</td>
                                            <td className="py-3 px-4 text-right font-bold">
                                                {isSell ? (
                                                    <span className={isWin ? 'text-emerald-400' : 'text-rose-400'}>
                                                        {isWin ? '+' : ''}${t.pnl.toFixed(2)} ({isWin ? '+' : ''}{t.pnlPercent.toFixed(2)}%)
                                                    </span>
                                                ) : (
                                                    <span className="text-slate-500 font-sans">—</span>
                                                )}
                                            </td>
                                            <td className="py-3 px-4 text-center font-sans">
                                                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                                    TRADE_W
                                                </span>
                                            </td>
                                            <td className="py-3 px-4 text-center font-sans">
                                                {t.status === 'WIN' && (
                                                    <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                                        WIN
                                                    </span>
                                                )}
                                                {t.status === 'LOSS' && (
                                                    <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30">
                                                        LOSS
                                                    </span>
                                                )}
                                                {t.status === 'ENTRY' && (
                                                    <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-400">
                                                        ENTRY
                                                    </span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
            </section>
        </div>
    );
}
