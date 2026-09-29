'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import dynamic from 'next/dynamic';
import {
    Activity,
    AlertTriangle,
    ArrowDownRight,
    ArrowUpRight,
    Award,
    Banknote,
    CheckCircle2,
    ChevronLeft,
    ChevronRight,
    Clock,
    DollarSign,
    Filter,
    Globe,
    Layers,
    Radio,
    RefreshCw,
    Search,
    ShieldAlert,
    ShieldCheck,
    Sliders,
    TrendingDown,
    TrendingUp,
    Wallet,
    Zap
} from 'lucide-react';
import type { DashboardData, TradeRecord } from '@/lib/db';
import EngineReasoning from './components/EngineReasoning';
import ForexEngineView from './components/ForexEngineView';
import TradeWEngineView from './components/TradeWEngineView';

// Dynamically import CandlestickChart to prevent SSR canvas issues
const CandlestickChart = dynamic(() => import('./components/CandlestickChart'), {
    ssr: false,
    loading: () => (
        <div className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-8 h-[460px] flex items-center justify-center shadow-xl shadow-black/30">
            <div className="flex flex-col items-center gap-3 text-slate-400 text-xs">
                <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin"></div>
                <span className="font-medium text-slate-300">Loading interactive TradingView chart...</span>
            </div>
        </div>
    )
});

// Configuration constant for USDT to NGN conversion
const USDT_TO_NGN_RATE = 1325.71;

// Standard Nigerian Naira currency formatter
const ngnFormatter = new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
});

/**
 * Converts a USDT amount to Nigerian Naira and formats it with the ₦ currency symbol.
 */
function formatNGN(usdtAmount: number): string {
    return ngnFormatter.format(usdtAmount * USDT_TO_NGN_RATE);
}

/**
 * Formats a USDT PnL value into signed Nigerian Naira.
 */
function formatPnlNGN(usdtAmount: number): string {
    const ngn = usdtAmount * USDT_TO_NGN_RATE;
    if (ngn > 0) {
        return `+${ngnFormatter.format(ngn)}`;
    }
    return ngnFormatter.format(ngn);
}

export default function DashboardPage() {
    const [data, setData] = useState<DashboardData | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(true);
    const [isValidating, setIsValidating] = useState<boolean>(false);
    const [lastSyncTime, setLastSyncTime] = useState<string>('Syncing...');

    // Market Navigation: Bybit Crypto vs OANDA Forex vs Trade W (MT5)
    const [marketEngine, setMarketEngine] = useState<'crypto' | 'forex' | 'tradew'>('crypto');

    // Chart Selected Asset
    const [selectedChartSymbol, setSelectedChartSymbol] = useState<string>('BTC/USDT');

    // Trade History Filters & Pagination
    const [symbolFilter, setSymbolFilter] = useState<string>('ALL');
    const [statusFilter, setStatusFilter] = useState<'ALL' | 'WIN' | 'LOSS'>('ALL');
    const [directionFilter, setDirectionFilter] = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
    const [searchQuery, setSearchQuery] = useState<string>('');
    const [sortField, setSortField] = useState<'timestamp' | 'pnl' | 'symbol'>('timestamp');
    const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
    const [pageSize, setPageSize] = useState<number>(25);
    const [currentPage, setCurrentPage] = useState<number>(1);
    const [executionModeFilter, setExecutionModeFilter] = useState<'LIVE_FORWARD' | 'BACKTEST_MOCK'>('LIVE_FORWARD');

    // 10-second automatic polling synchronization with live background bot
    const fetchData = useCallback(async (isManual = false) => {
        if (isManual) setIsValidating(true);
        try {
            const res = await fetch('/api/trading-data', { cache: 'no-store' });
            if (res.ok) {
                const json: DashboardData = await res.json();
                setData(json);
                setLastSyncTime(new Date().toLocaleTimeString());
            }
        } catch (err) {
            console.error("Dashboard polling error:", err);
        } finally {
            setIsLoading(false);
            if (isManual) setIsValidating(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
        const interval = setInterval(() => fetchData(false), 10000); // 10s automatic polling
        return () => clearInterval(interval);
    }, [fetchData]);

    const metrics = data?.metrics;
    const allActivePositions = data?.activePositions || [];
    const activePositions = useMemo(() => {
        if (marketEngine === 'tradew') return allActivePositions.filter(p => p.broker === 'TRADE_W');
        if (marketEngine === 'forex') return allActivePositions.filter(p => p.broker === 'OANDA');
        return allActivePositions.filter(p => p.broker === 'BYBIT' || !p.broker);
    }, [allActivePositions, marketEngine]);
    const tradeHistory = data?.tradeHistory || [];
    const marketOverview = data?.marketOverview || [];
    const engineReasoning = data?.engineReasoning || [];
    const chartData = data?.chartData || {};

    // Reset pagination to page 1 whenever filters change
    useEffect(() => {
        setCurrentPage(1);
    }, [symbolFilter, statusFilter, directionFilter, searchQuery, pageSize, executionModeFilter]);

    // Counts for Segmented Control
    const liveForwardCount = useMemo(() => {
        return tradeHistory.filter((t) => {
            if (marketEngine === 'tradew') return t.broker === 'TRADE_W' && t.executionMode === 'LIVE_FORWARD';
            if (marketEngine === 'crypto') return (t.broker === 'BYBIT' || !t.broker) && t.executionMode === 'LIVE_FORWARD';
            return t.executionMode === 'LIVE_FORWARD';
        }).length;
    }, [tradeHistory, marketEngine]);

    const historicalBacktestCount = useMemo(() => {
        return tradeHistory.filter((t) => {
            if (marketEngine === 'tradew') return t.broker === 'TRADE_W' && t.executionMode === 'BACKTEST_MOCK';
            if (marketEngine === 'crypto') return (t.broker === 'BYBIT' || !t.broker) && t.executionMode === 'BACKTEST_MOCK';
            return t.executionMode === 'BACKTEST_MOCK';
        }).length;
    }, [tradeHistory, marketEngine]);

    // Filter and Sort Trade History
    const filteredTrades = useMemo(() => {
        return tradeHistory
            .filter((trade) => {
                if (marketEngine === 'tradew') {
                    if (trade.broker !== 'TRADE_W') return false;
                } else if (marketEngine === 'crypto') {
                    if (trade.broker && trade.broker !== 'BYBIT') return false;
                }
                if (trade.executionMode !== executionModeFilter) return false;
                if (symbolFilter !== 'ALL' && trade.symbol !== symbolFilter) return false;
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
            .sort((a, b) => {
                let valA = a[sortField];
                let valB = b[sortField];
                if (typeof valA === 'string') {
                    return sortDirection === 'asc'
                        ? (valA as string).localeCompare(valB as string)
                        : (valB as string).localeCompare(valA as string);
                }
                return sortDirection === 'asc' ? (valA as number) - (valB as number) : (valB as number) - (valA as number);
            });
    }, [tradeHistory, marketEngine, executionModeFilter, symbolFilter, statusFilter, directionFilter, searchQuery, sortField, sortDirection]);

    // Pagination Calculations
    const totalPages = Math.max(1, Math.ceil(filteredTrades.length / pageSize));
    const paginatedTrades = useMemo(() => {
        const start = (currentPage - 1) * pageSize;
        return filteredTrades.slice(start, start + pageSize);
    }, [filteredTrades, currentPage, pageSize]);

    const handleSort = (field: 'timestamp' | 'pnl' | 'symbol') => {
        if (sortField === field) {
            setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDirection('desc');
        }
    };

    const isHalted = metrics?.circuitBreakerHalted ?? false;
    const availableChartSymbols = useMemo(() => {
        const set = new Set(['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
        marketOverview.forEach((m) => set.add(m.symbol));
        return Array.from(set);
    }, [marketOverview]);
    const currentChartCandles = chartData[selectedChartSymbol] || [];

    // Balance calculations for top metrics cards
    const initialCapitalUSDT = 10000;
    const netPnlUSDT = metrics?.netPnl ?? 0;
    const currentPaperBalanceUSDT = initialCapitalUSDT + netPnlUSDT;
    const isAboveInitial = currentPaperBalanceUSDT > initialCapitalUSDT;
    const isBelowInitial = currentPaperBalanceUSDT < initialCapitalUSDT;
    const currentBalanceColor = isAboveInitial
        ? 'text-emerald-400'
        : isBelowInitial
        ? 'text-red-400'
        : 'text-white';

    return (
        <main className="min-h-screen bg-[#07090E] text-slate-100 flex flex-col font-sans selection:bg-cyan-500/20 selection:text-cyan-300">
            {/* Top Navigation Bar */}
            <header className="border-b border-slate-800/80 bg-[#0B0F19]/90 backdrop-blur-md sticky top-0 z-50 px-6 py-3.5 flex flex-wrap items-center justify-between gap-4 shadow-lg shadow-black/40">
                <div className="flex items-center gap-4">
                    <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-600 via-blue-600 to-indigo-600 shadow-md shadow-cyan-500/20 border border-cyan-400/30">
                        <Zap className="w-5 h-5 text-white" />
                        <span className="absolute -top-1 -right-1 flex h-3 w-3">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
                        </span>
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h1 className="text-xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
                                QuantEngine
                            </h1>
                            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 tracking-wider">
                                {marketEngine === 'crypto' ? 'BYBIT CRYPTO' : marketEngine === 'forex' ? 'OANDA FOREX' : 'TRADE W (MT5)'}
                            </span>
                            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 tracking-wider flex items-center gap-1">
                                <Banknote className="w-3 h-3" />
                                ₦ NGN MODE
                            </span>
                        </div>
                        <p className="text-xs text-slate-400 flex items-center gap-1.5">
                            Trend-Following Strategy • Only trades when the market is clearly trending • Auto-exits to protect profits
                        </p>
                    </div>
                </div>

                {/* Multi-Market Toggle & Status Badges */}
                <div className="flex items-center flex-wrap gap-3">
                    {/* Multi-Market Navigation Switcher: [Bybit Crypto], [OANDA Forex], [Trade W (MT5)] */}
                    <div className="flex items-center bg-[#07090E] p-1 rounded-xl border border-slate-800 shadow-inner">
                        <button
                            onClick={() => setMarketEngine('crypto')}
                            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                                marketEngine === 'crypto'
                                    ? 'bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-md shadow-cyan-500/20'
                                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                            }`}
                        >
                            <Zap className="w-3.5 h-3.5" />
                            <span>Bybit Crypto</span>
                        </button>
                        <button
                            onClick={() => setMarketEngine('forex')}
                            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                                marketEngine === 'forex'
                                    ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/20'
                                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                            }`}
                        >
                            <Globe className="w-3.5 h-3.5" />
                            <span>OANDA Forex</span>
                        </button>
                        <button
                            onClick={() => setMarketEngine('tradew')}
                            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                                marketEngine === 'tradew'
                                    ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-md shadow-emerald-500/20'
                                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40'
                            }`}
                        >
                            <Layers className="w-3.5 h-3.5" />
                            <span>Trade W (MT5)</span>
                        </button>
                    </div>

                    {/* FX Peg Indicator */}
                    <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                        <span className="text-slate-400 font-normal">FX Peg:</span>
                        <span>1 USD/USDT = ₦{USDT_TO_NGN_RATE.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>

                    {/* Circuit Breaker Status Pill */}
                    <div
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                            isHalted
                                ? 'bg-red-500/15 border-red-500/40 text-red-400 shadow-sm shadow-red-500/20 animate-pulse'
                                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        }`}
                    >
                        {isHalted ? (
                            <>
                                <ShieldAlert className="w-4 h-4 text-red-400" />
                                <span>CIRCUIT BREAKER: HALTED</span>
                            </>
                        ) : (
                            <>
                                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                                <span>RISK: NOMINAL (5% Max DD)</span>
                            </>
                        )}
                    </div>

                    {/* Live Polling Indicator */}
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-900 border border-slate-800 text-slate-300">
                        <Radio className={`w-3.5 h-3.5 ${isValidating ? 'text-cyan-400 animate-spin' : 'text-emerald-400'}`} />
                        <span>10s Sync ({lastSyncTime})</span>
                    </div>

                    {/* Manual Refresh Button */}
                    <button
                        onClick={() => fetchData(true)}
                        disabled={isValidating}
                        title="Force refresh database state"
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800/80 hover:bg-slate-700/80 border border-slate-700 text-slate-200 hover:text-white transition-all active:scale-95 disabled:opacity-50 cursor-pointer"
                    >
                        <RefreshCw className={`w-3.5 h-3.5 ${isValidating ? 'animate-spin text-cyan-400' : ''}`} />
                        <span>Refresh</span>
                    </button>
                </div>
            </header>

            {/* Dashboard Body Container */}
            <div className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
                {marketEngine === 'forex' ? (
                    /* FOREX ENGINE VIEW (OANDA Forex) */
                    <ForexEngineView />
                ) : marketEngine === 'tradew' ? (
                    /* TRADE W (MT5) ENGINE VIEW */
                    <TradeWEngineView
                        tradewAccount={data?.tradewAccount}
                        activePositions={activePositions}
                        tradeHistory={tradeHistory}
                        engineReasoning={engineReasoning}
                        chartData={chartData}
                        formatNGN={formatNGN}
                        formatPnlNGN={formatPnlNGN}
                    />
                ) : (
                    /* BYBIT CRYPTO ENGINE VIEW */
                    <>
                        {/* Practice Mode Banner */}
                        <div className="bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border border-amber-500/20 rounded-2xl px-5 py-3.5 flex items-center gap-3 shadow-lg shadow-black/20">
                            <div className="p-2 rounded-xl bg-amber-500/15 text-amber-400 border border-amber-500/25 shrink-0">
                                <AlertTriangle className="w-4 h-4" />
                            </div>
                            <div>
                                <p className="text-sm font-bold text-amber-300">
                                    🎓 Practice Mode — No Real Money At Risk
                                </p>
                                <p className="text-xs text-slate-400 mt-0.5">
                                    This bot trades with simulated funds ($10,000 USDT). All trades are paper-only and do not execute on any exchange. 
                                    Use this to test the strategy before committing real capital.
                                </p>
                            </div>
                        </div>

                        {/* 1. METRICS ROW (Displaying in Nigerian Naira ₦) */}
                        <section aria-label="Portfolio Metrics in NGN" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                            {/* Card 1: Initial Capital */}
                            <div className="bg-[#0D121F]/90 border border-slate-800/80 hover:border-slate-700/80 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm relative overflow-hidden transition-all group">
                                <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-full blur-2xl group-hover:bg-blue-500/10 transition-all pointer-events-none" />
                                <div className="flex items-center justify-between text-slate-400 mb-2">
                                    <span className="text-xs font-semibold uppercase tracking-wider">Initial Capital</span>
                                    <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                        <Wallet className="w-4 h-4" />
                                    </div>
                                </div>
                                <div className="text-2xl font-black tracking-tight text-white">
                                    {formatNGN(initialCapitalUSDT)}
                                </div>
                                <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                                    <span>Starting Allocation</span>
                                    <span className="text-[11px] text-slate-400 font-mono font-medium">${initialCapitalUSDT.toLocaleString()} USDT</span>
                                </div>
                            </div>

                            {/* Card 2: Current Paper Balance */}
                            <div className="bg-[#0D121F]/90 border border-slate-800/80 hover:border-slate-700/80 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm relative overflow-hidden transition-all group">
                                <div
                                    className={`absolute top-0 right-0 w-24 h-24 rounded-full blur-2xl transition-all pointer-events-none ${
                                        isAboveInitial
                                            ? 'bg-emerald-500/5 group-hover:bg-emerald-500/10'
                                            : isBelowInitial
                                            ? 'bg-red-500/5 group-hover:bg-red-500/10'
                                            : 'bg-cyan-500/5 group-hover:bg-cyan-500/10'
                                    }`}
                                />
                                <div className="flex items-center justify-between text-slate-400 mb-2">
                                    <span className="text-xs font-semibold uppercase tracking-wider">Current Paper Balance</span>
                                    <div
                                        className={`p-2 rounded-xl border ${
                                            isAboveInitial
                                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                                : isBelowInitial
                                                ? 'bg-red-500/10 text-red-400 border-red-500/20'
                                                : 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'
                                        }`}
                                    >
                                        <Banknote className="w-4 h-4" />
                                    </div>
                                </div>
                                <div className={`text-2xl font-black tracking-tight ${currentBalanceColor}`}>
                                    {formatNGN(currentPaperBalanceUSDT)}
                                </div>
                                <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                                    <span className={`font-semibold ${isAboveInitial ? 'text-emerald-400' : isBelowInitial ? 'text-red-400' : 'text-slate-400'}`}>
                                        {isAboveInitial ? '▲ In Profit' : isBelowInitial ? '▼ In Drawdown' : '● Even'}
                                    </span>
                                    <span className="text-[11px] text-slate-400 font-mono font-medium">
                                        (${currentPaperBalanceUSDT.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT)
                                    </span>
                                </div>
                            </div>

                            {/* Card 3: Cumulative Net PnL */}
                            <div className="bg-[#0D121F]/90 border border-slate-800/80 hover:border-slate-700/80 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm relative overflow-hidden transition-all group">
                                <div
                                    className={`absolute top-0 right-0 w-24 h-24 rounded-full blur-2xl transition-all pointer-events-none ${
                                        (metrics?.netPnl ?? 0) >= 0 ? 'bg-emerald-500/5 group-hover:bg-emerald-500/10' : 'bg-red-500/5 group-hover:bg-red-500/10'
                                    }`}
                                />
                                <div className="flex items-center justify-between text-slate-400 mb-2">
                                    <span className="text-xs font-semibold uppercase tracking-wider">Cumulative Net PnL</span>
                                    <div
                                        className={`p-2 rounded-xl border ${
                                            (metrics?.netPnl ?? 0) >= 0
                                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                                : 'bg-red-500/10 text-red-400 border-red-500/20'
                                        }`}
                                    >
                                        {(metrics?.netPnl ?? 0) >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                                    </div>
                                </div>
                                <div
                                    className={`text-2xl font-black tracking-tight flex items-baseline gap-1 ${
                                        (metrics?.netPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                                    }`}
                                >
                                    {formatPnlNGN(metrics?.netPnl ?? 0)}
                                </div>
                                <div className="mt-2 flex items-center justify-between text-xs font-medium">
                                    <span
                                        className={`px-1.5 py-0.5 rounded ${
                                            (metrics?.netPnlPercent ?? 0) >= 0
                                                ? 'bg-emerald-500/10 text-emerald-400'
                                                : 'bg-red-500/10 text-red-400'
                                        }`}
                                    >
                                        {(metrics?.netPnlPercent ?? 0) >= 0 ? '+' : ''}
                                        {(metrics?.netPnlPercent ?? 0).toFixed(2)}%
                                    </span>
                                    <span className="text-slate-400 cursor-help" title="Profit Factor = total money gained ÷ total money lost. Above 1.0 = profitable. Above 1.5 = good. Above 2.0 = excellent.">
                                        PF: {metrics?.profitFactor ? (metrics.profitFactor === 999 ? '∞' : metrics.profitFactor.toFixed(2)) : '—'}
                                        <span className="ml-1 text-[10px] text-slate-500">ⓘ</span>
                                    </span>
                                </div>
                            </div>

                            {/* Card 4: Win Rate */}
                            <div className="bg-[#0D121F]/90 border border-slate-800/80 hover:border-slate-700/80 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm relative overflow-hidden transition-all group">
                                <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-500/5 rounded-full blur-2xl group-hover:bg-indigo-500/10 transition-all pointer-events-none" />
                                <div className="flex items-center justify-between text-slate-400 mb-2">
                                    <span className="text-xs font-semibold uppercase tracking-wider">Win Rate</span>
                                    <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                                        <Award className="w-4 h-4" />
                                    </div>
                                </div>
                                <div className="text-2xl font-black tracking-tight text-white">
                                    {(metrics?.winRate ?? 0).toFixed(1)}%
                                </div>
                                <div className="mt-2 text-xs text-slate-400 flex items-center justify-between">
                                    <div className="flex items-center gap-1.5">
                                        <span className="text-emerald-400 font-semibold">{metrics?.winningTrades ?? 0}W</span>
                                        <span>/</span>
                                        <span className="text-red-400 font-semibold">{metrics?.losingTrades ?? 0}L</span>
                                        <span className="text-slate-500 text-[11px] cursor-help" title="Win rate is the percentage of trades that made a profit. Above 50% means the bot is winning more often than losing.">(Target &gt; 50%) ⓘ</span>
                                    </div>
                                    <span className="text-slate-500 text-[11px] font-mono">
                                        {metrics?.totalTrades ?? 0} trades
                                    </span>
                                </div>
                            </div>

                            {/* Card 5: Risk Protocol */}
                            <div className="bg-[#0D121F]/90 border border-slate-800/80 hover:border-slate-700/80 rounded-2xl p-5 shadow-lg shadow-black/30 backdrop-blur-sm relative overflow-hidden transition-all group">
                                <div
                                    className={`absolute top-0 right-0 w-24 h-24 rounded-full blur-2xl transition-all pointer-events-none ${
                                        isHalted ? 'bg-red-500/10' : 'bg-emerald-500/5'
                                    }`}
                                />
                                <div className="flex items-center justify-between text-slate-400 mb-2">
                                    <span className="text-xs font-semibold uppercase tracking-wider">Risk Protocol</span>
                                    <div
                                        className={`p-2 rounded-xl border ${
                                            isHalted
                                                ? 'bg-red-500/10 text-red-400 border-red-500/20'
                                                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                        }`}
                                    >
                                        {isHalted ? <ShieldAlert className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
                                    </div>
                                </div>
                                <div className={`text-xl font-bold tracking-tight ${isHalted ? 'text-red-400' : 'text-emerald-400'}`}>
                                    {isHalted ? 'HALTED' : 'ACTIVE'}
                                </div>
                                <div className="mt-2 text-xs text-slate-400 flex items-center gap-1 cursor-help" title="The bot risks maximum 2% of its balance on any single trade. If total daily losses exceed 5%, all trading is paused for 24 hours to prevent further damage.">
                                    <span>2% Risk/Trade • 5% Max DD ⓘ</span>
                                </div>
                            </div>
                        </section>

                        {/* 2. INTERACTIVE CANDLESTICK CHART (Requirement 3: Lightweight-Charts 100 Hourly Bars with 20/50 EMA) */}
                        <section aria-label="Interactive Candlestick Chart">
                            <CandlestickChart
                                symbol={selectedChartSymbol}
                                candles={currentChartCandles}
                                selectedSymbol={selectedChartSymbol}
                                onSelectSymbol={setSelectedChartSymbol}
                                availableSymbols={availableChartSymbols}
                            />
                        </section>

                        {/* 3. DECISION INSPECTOR: ENGINE REASONING (Requirement 2: Plain-English Explainer + Diagnostic Checklist) */}
                        <section aria-label="Engine Reasoning Decision Inspector">
                            <EngineReasoning reasoningList={engineReasoning} />
                        </section>

                        {/* 4. ACTIVE POSITIONS CARD (Values in NGN) */}
                        <section aria-label="Active Positions in NGN" className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-6 shadow-xl shadow-black/30 backdrop-blur-sm">
                            <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
                                <div className="flex items-center gap-2.5">
                                    <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                                        <Layers className="w-4 h-4" />
                                    </div>
                                    <div>
                                        <h2 className="text-lg font-bold text-white flex items-center gap-2">
                                            Active Positions
                                            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700 font-medium">
                                                {activePositions.length} Open
                                            </span>
                                        </h2>
                                        <p className="text-xs text-slate-400">
                                            Live positions with dynamic auto-exit safety prices (trailing stops) to protect profits
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {activePositions.length === 0 ? (
                                <div className="py-12 px-4 rounded-xl border border-dashed border-slate-800/90 text-center flex flex-col items-center justify-center bg-slate-900/30">
                                    <div className="w-12 h-12 rounded-full bg-slate-800/80 flex items-center justify-center text-slate-400 mb-3 border border-slate-700/50">
                                        <Radio className="w-6 h-6 text-cyan-400 animate-pulse" />
                                    </div>
                                    <h3 className="text-sm font-semibold text-slate-200">No Active Positions Currently Open</h3>
                                    <p className="text-xs text-slate-400 max-w-md mt-1">
                                        Engine is actively monitoring {availableChartSymbols.length > 0 ? availableChartSymbols.slice(0, 5).join(', ') : 'selected pairs'} for confirmed 20/50 EMA crossover, RSI momentum, and ADX &gt; 25 trend strength.
                                    </p>
                                    <div className="mt-4 flex items-center gap-2 text-[11px] text-cyan-400 bg-cyan-500/10 border border-cyan-500/20 px-3 py-1 rounded-full font-medium">
                                        <CheckCircle2 className="w-3.5 h-3.5" />
                                        <span>Scanning live 1h closed candles every 10 seconds</span>
                                    </div>
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {activePositions.map((pos) => {
                                        const isPosWin = pos.pnl >= 0;
                                        return (
                                            <div
                                                key={pos.symbol}
                                                className="bg-slate-900/80 border border-slate-800 hover:border-slate-700 rounded-xl p-5 shadow-md transition-all relative overflow-hidden"
                                            >
                                                <div className="flex items-center justify-between mb-3">
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-bold text-white text-base">{pos.symbol}</span>
                                                        {pos.side === 'SHORT' ? (
                                                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/30 flex items-center gap-1">
                                                                <TrendingDown className="w-3 h-3" />
                                                                SHORT
                                                            </span>
                                                        ) : (
                                                            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                                                                <TrendingUp className="w-3 h-3" />
                                                                LONG
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="text-xs text-slate-400 flex items-center gap-1">
                                                        <Clock className="w-3 h-3 text-slate-500" />
                                                        <span>{pos.holdingDuration}</span>
                                                    </div>
                                                </div>

                                                {/* Price & PnL in NGN */}
                                                <div className="grid grid-cols-2 gap-2 py-3 border-y border-slate-800/80 my-3">
                                                    <div>
                                                        <div className="text-[11px] text-slate-400">Entry Price (₦)</div>
                                                        <div className="text-sm font-semibold text-slate-200">
                                                            {formatNGN(pos.entryPrice)}
                                                        </div>
                                                        <div className="text-[10px] text-slate-500 font-mono">
                                                            ${pos.entryPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })} USDT
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div className="text-[11px] text-slate-400">Current Price (₦)</div>
                                                        <div className="text-sm font-semibold text-white">
                                                            {formatNGN(pos.currentPrice)}
                                                        </div>
                                                        <div className="text-[10px] text-slate-500 font-mono">
                                                            ${pos.currentPrice.toLocaleString('en-US', { minimumFractionDigits: 2 })} USDT
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div className="text-[11px] text-slate-400">Position Size</div>
                                                        <div className="text-sm font-semibold text-slate-200">
                                                            {pos.amount.toFixed(4)}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <div className="text-[11px] text-slate-400">Unrealized PnL (₦)</div>
                                                        <div className={`text-sm font-bold flex items-center gap-0.5 ${isPosWin ? 'text-emerald-400' : 'text-red-400'}`}>
                                                            {formatPnlNGN(pos.pnl)} ({isPosWin ? '+' : ''}{pos.pnlPercent.toFixed(2)}%)
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Dynamic Trailing Stop Section in NGN */}
                                                <div className="space-y-1.5 bg-[#07090E]/60 p-3 rounded-lg border border-slate-800/70">
                                                    <div className="flex items-center justify-between text-xs">
                                                        <span className="text-slate-400 font-medium cursor-help" title="If the price reaches this level, the bot will automatically sell to protect your capital. This price moves in your favor as profits grow, but never moves against you.">Auto-Exit Safety Price: <span className="text-[10px] text-slate-500">ⓘ</span></span>
                                                        <span className="text-amber-400 font-bold">
                                                            {formatNGN(pos.trailingStop)}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                                                        <span>Distance to Stop:</span>
                                                        <span className="text-slate-300 font-semibold">
                                                            {formatNGN(pos.stopDistance)} ({pos.stopDistancePercent.toFixed(2)}%)
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center justify-between text-[11px] text-slate-500">
                                                        <span>{pos.side === 'SHORT' ? 'Lowest Watermark:' : 'Highest Watermark:'}</span>
                                                        <span className="text-slate-300">
                                                            {formatNGN(pos.side === 'SHORT' ? (pos.lowestPrice || pos.currentPrice) : pos.highestPrice)}
                                                        </span>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </section>

                        {/* 5. MARKET REGIME & MONITORED ASSETS OVERVIEW */}
                        <section aria-label="Market Regime Status in NGN" className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {marketOverview.map((item) => (
                                <div
                                    key={item.symbol}
                                    className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-5 shadow-lg shadow-black/20 flex flex-col justify-between"
                                >
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="flex items-center gap-2">
                                            <span className="font-bold text-base text-white">{item.symbol}</span>
                                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                                                1h Feed
                                            </span>
                                        </div>
                                        <span className="text-xs text-slate-400 flex items-center gap-1">
                                            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                                            Live
                                        </span>
                                    </div>

                                    <div className="my-2">
                                        <div className="text-2xl font-black text-white">
                                            {formatNGN(item.latestClose)}
                                        </div>
                                        <div className="text-xs text-slate-500 font-mono mt-0.5">
                                            ${item.latestClose.toLocaleString('en-US', { minimumFractionDigits: 2 })} USDT
                                        </div>
                                        <div className="flex items-center justify-between text-xs text-slate-400 mt-2">
                                            <span>24h High: {formatNGN(item.high24h)}</span>
                                            <span>24h Low: {formatNGN(item.low24h)}</span>
                                        </div>
                                    </div>

                                    <div className="mt-3 pt-3 border-t border-slate-800/70 flex items-center justify-between text-[11px]">
                                        <span className="text-slate-400">What the bot needs to trade:</span>
                                        <span className="text-cyan-400 font-semibold cursor-help" title="The bot only opens a trade when ALL 3 conditions are met at the same time: (1) Short-term trend crosses long-term trend, (2) ADX above 25 confirms the market is actually trending, (3) RSI is in a safe zone to enter.">Trend cross + Strong momentum + Safe entry zone ⓘ</span>
                                    </div>
                                </div>
                            ))}
                        </section>

                        {/* 6. TRADE HISTORY TABLE (Segmented Control: Live Forward Test vs Historical Backtest) */}
                        <section aria-label="Trade History in NGN" className="bg-[#0D121F]/90 border border-slate-800/80 rounded-2xl p-6 shadow-xl shadow-black/30 backdrop-blur-sm space-y-5">
                            {/* Segmented Control / Toggle: [Live Forward Test] | [Historical Backtest] */}
                            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 p-2 bg-[#07090E]/90 rounded-2xl border border-slate-800/90 shadow-inner">
                                <div className="inline-flex items-center p-1 bg-slate-900/90 rounded-xl border border-slate-800 shadow-sm gap-1">
                                    <button
                                        onClick={() => setExecutionModeFilter('LIVE_FORWARD')}
                                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                                            executionModeFilter === 'LIVE_FORWARD'
                                                ? 'bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-md shadow-cyan-500/25 border border-cyan-400/30'
                                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                                        }`}
                                    >
                                        <Radio className={`w-3.5 h-3.5 ${executionModeFilter === 'LIVE_FORWARD' ? 'text-cyan-200 animate-pulse' : 'text-slate-400'}`} />
                                        <span>Live Forward Test</span>
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                                            executionModeFilter === 'LIVE_FORWARD'
                                                ? 'bg-white/20 text-white'
                                                : 'bg-slate-800 text-slate-400'
                                        }`}>
                                            {liveForwardCount}
                                        </span>
                                    </button>

                                    <button
                                        onClick={() => setExecutionModeFilter('BACKTEST_MOCK')}
                                        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                                            executionModeFilter === 'BACKTEST_MOCK'
                                                ? 'bg-gradient-to-r from-amber-600 to-orange-600 text-white shadow-md shadow-amber-500/25 border border-amber-400/30'
                                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                                        }`}
                                    >
                                        <Clock className={`w-3.5 h-3.5 ${executionModeFilter === 'BACKTEST_MOCK' ? 'text-amber-200' : 'text-slate-400'}`} />
                                        <span>Historical Backtest</span>
                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold ${
                                            executionModeFilter === 'BACKTEST_MOCK'
                                                ? 'bg-white/20 text-white'
                                                : 'bg-slate-800 text-slate-400'
                                        }`}>
                                            {historicalBacktestCount}
                                        </span>
                                    </button>
                                </div>

                                <div className="text-xs text-slate-400 flex items-center gap-2 px-3">
                                    {executionModeFilter === 'LIVE_FORWARD' ? (
                                        <div className="flex items-center gap-2">
                                            <span className="relative flex h-2 w-2">
                                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                                                <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
                                            </span>
                                            <span className="text-cyan-400 font-medium">Forward paper trades executed live by runner</span>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-2">
                                            <span className="w-2 h-2 rounded-full bg-amber-400"></span>
                                            <span className="text-amber-400 font-medium">Historical simulated trades from backtesting</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-4 border-b border-slate-800/80">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h2 className="text-lg font-bold text-white flex items-center gap-2">
                                            {executionModeFilter === 'LIVE_FORWARD' ? 'Live Forward Trade History' : 'Historical Backtest Trade History'}
                                        </h2>
                                        <span className={`text-xs px-2.5 py-0.5 rounded-full font-semibold border ${
                                            executionModeFilter === 'LIVE_FORWARD'
                                                ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/20'
                                                : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                                        }`}>
                                            {filteredTrades.length} Trades
                                        </span>
                                    </div>
                                    <p className="text-xs text-slate-400 mt-0.5">
                                        {executionModeFilter === 'LIVE_FORWARD'
                                            ? 'Real-time forward paper trades — recorded directly as live signals trigger'
                                            : 'Archived backtest validation trades and benchmark simulations'}
                                    </p>
                                </div>

                                {/* Filters & Controls */}
                                <div className="flex flex-wrap items-center gap-3">
                                    {/* STATUS PILL FILTERS (All, Wins Only, Losses Only) */}
                                    <div className="flex items-center bg-[#07090E] p-1 rounded-xl border border-slate-800 shadow-inner">
                                        <button
                                            onClick={() => setStatusFilter('ALL')}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                                                statusFilter === 'ALL'
                                                    ? 'bg-slate-800 text-white shadow-sm'
                                                    : 'text-slate-400 hover:text-slate-200'
                                            }`}
                                        >
                                            All
                                        </button>
                                        <button
                                            onClick={() => setStatusFilter('WIN')}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                                                statusFilter === 'WIN'
                                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                                                    : 'text-slate-400 hover:text-emerald-400'
                                            }`}
                                        >
                                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                                            Wins Only
                                        </button>
                                        <button
                                            onClick={() => setStatusFilter('LOSS')}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                                                statusFilter === 'LOSS'
                                                    ? 'bg-red-500/20 text-red-300 border border-red-500/40 shadow-sm'
                                                    : 'text-slate-400 hover:text-red-400'
                                            }`}
                                        >
                                            <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                                            Losses Only
                                        </button>
                                    </div>

                                    {/* DIRECTION PILL FILTERS (All Directions, Longs Only, Shorts Only) */}
                                    <div className="flex items-center bg-[#07090E] p-1 rounded-xl border border-slate-800 shadow-inner">
                                        <button
                                            onClick={() => setDirectionFilter('ALL')}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                                                directionFilter === 'ALL'
                                                    ? 'bg-slate-800 text-white shadow-sm'
                                                    : 'text-slate-400 hover:text-slate-200'
                                            }`}
                                        >
                                            All Dir
                                        </button>
                                        <button
                                            onClick={() => setDirectionFilter('LONG')}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1 ${
                                                directionFilter === 'LONG'
                                                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                                                    : 'text-slate-400 hover:text-emerald-400'
                                            }`}
                                        >
                                            <TrendingUp className="w-3 h-3 text-emerald-400" />
                                            Longs
                                        </button>
                                        <button
                                            onClick={() => setDirectionFilter('SHORT')}
                                            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer flex items-center gap-1 ${
                                                directionFilter === 'SHORT'
                                                    ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-sm'
                                                    : 'text-slate-400 hover:text-rose-400'
                                            }`}
                                        >
                                            <TrendingDown className="w-3 h-3 text-rose-400" />
                                            Shorts
                                        </button>
                                    </div>

                                    {/* Symbol Dropdown Filter */}
                                    <select
                                        value={symbolFilter}
                                        onChange={(e) => setSymbolFilter(e.target.value)}
                                        className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-xl px-3 py-1.5 focus:outline-none focus:border-cyan-500 transition-all cursor-pointer"
                                    >
                                        <option value="ALL">All Pairs</option>
                                        {Array.from(new Set(['BTC/USDT', 'ETH/USDT', 'SOL/USDT', ...tradeHistory.map((t) => t.symbol)])).map((sym) => (
                                            <option key={sym} value={sym}>{sym}</option>
                                        ))}
                                    </select>

                                    {/* Search Input */}
                                    <div className="relative">
                                        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                                        <input
                                            type="text"
                                            placeholder="Search ID, pair..."
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                            className="bg-slate-900 border border-slate-800 text-slate-200 text-xs rounded-xl pl-8 pr-3 py-1.5 focus:outline-none focus:border-cyan-500 transition-all w-40 placeholder:text-slate-500"
                                        />
                                    </div>

                                    {/* Records Per Page Selector (25 or 50) */}
                                    <div className="flex items-center gap-1 bg-[#07090E] p-1 rounded-xl border border-slate-800 text-xs">
                                        <button
                                            onClick={() => setPageSize(25)}
                                            className={`px-2.5 py-1 rounded-lg font-semibold transition-all cursor-pointer ${
                                                pageSize === 25
                                                    ? 'bg-cyan-500 text-slate-950 font-bold'
                                                    : 'text-slate-400 hover:text-slate-200'
                                            }`}
                                        >
                                            25
                                        </button>
                                        <button
                                            onClick={() => setPageSize(50)}
                                            className={`px-2.5 py-1 rounded-lg font-semibold transition-all cursor-pointer ${
                                                pageSize === 50
                                                    ? 'bg-cyan-500 text-slate-950 font-bold'
                                                    : 'text-slate-400 hover:text-slate-200'
                                            }`}
                                        >
                                            50
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Table Container */}
                            <div className="overflow-x-auto rounded-xl border border-slate-800/80">
                                <table className="w-full text-left text-xs text-slate-300">
                                    <thead className="bg-slate-900/90 text-slate-400 uppercase font-semibold border-b border-slate-800 tracking-wider">
                                        <tr>
                                            <th
                                                onClick={() => handleSort('timestamp')}
                                                className="py-3 px-4 cursor-pointer hover:text-white transition-colors"
                                            >
                                                Date / Time {sortField === 'timestamp' && (sortDirection === 'asc' ? '↑' : '↓')}
                                            </th>
                                            <th
                                                onClick={() => handleSort('symbol')}
                                                className="py-3 px-4 cursor-pointer hover:text-white transition-colors"
                                            >
                                                Symbol {sortField === 'symbol' && (sortDirection === 'asc' ? '↑' : '↓')}
                                            </th>
                                            <th className="py-3 px-4 text-center">Direction</th>
                                            <th className="py-3 px-4">Side / Type</th>
                                            <th className="py-3 px-4 text-right">Execution Price (₦)</th>
                                            <th className="py-3 px-4 text-right">Amount</th>
                                            <th className="py-3 px-4 text-right">Fee (₦)</th>
                                            <th
                                                onClick={() => handleSort('pnl')}
                                                className="py-3 px-4 text-right cursor-pointer hover:text-white transition-colors"
                                            >
                                                Net PnL (₦) {sortField === 'pnl' && (sortDirection === 'asc' ? '↑' : '↓')}
                                            </th>
                                            <th className="py-3 px-4 text-center">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800/60 bg-[#0A0E17]/40 font-mono">
                                        {paginatedTrades.length === 0 ? (
                                            <tr>
                                                <td colSpan={9} className="py-12 text-center text-slate-500 font-sans">
                                                    {executionModeFilter === 'LIVE_FORWARD' ? (
                                                        <div className="flex flex-col items-center justify-center gap-2">
                                                            <div className="p-3 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                                                                <Radio className="w-5 h-5 animate-pulse" />
                                                            </div>
                                                            <p className="font-semibold text-slate-300 text-sm">No live forward trades recorded yet</p>
                                                            <p className="text-xs text-slate-500 max-w-md">
                                                                The live runner is monitoring the market. As soon as all 3 entry conditions align on a pair, new live forward trades will appear here automatically.
                                                            </p>
                                                        </div>
                                                    ) : (
                                                        <div className="flex flex-col items-center justify-center gap-2">
                                                            <p className="font-semibold text-slate-300 text-sm">No historical backtest trades match your filters</p>
                                                            <p className="text-xs text-slate-500">Adjust the filters above to view historical backtest data.</p>
                                                        </div>
                                                    )}
                                                </td>
                                            </tr>
                                        ) : (
                                            paginatedTrades.map((t) => {
                                                const isExit = t.type !== 'ENTRY' && t.status !== 'ENTRY';
                                                const isWin = t.pnl > 0;
                                                return (
                                                    <tr key={t.id} className="hover:bg-slate-800/30 transition-colors">
                                                        <td className="py-3 px-4 text-slate-400 whitespace-nowrap">
                                                            {t.dateStr}
                                                        </td>
                                                        <td className="py-3 px-4 font-bold text-white whitespace-nowrap font-sans">
                                                            {t.symbol}
                                                        </td>
                                                        <td className="py-3 px-4 text-center whitespace-nowrap font-sans">
                                                            {t.direction === 'SHORT' ? (
                                                                <span className="inline-flex items-center gap-1 font-bold px-2 py-0.5 rounded text-[11px] bg-rose-500/10 text-rose-400 border border-rose-500/30">
                                                                    <TrendingDown className="w-3 h-3" />
                                                                    SHORT
                                                                </span>
                                                            ) : (
                                                                <span className="inline-flex items-center gap-1 font-bold px-2 py-0.5 rounded text-[11px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                                                                    <TrendingUp className="w-3 h-3" />
                                                                    LONG
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td className="py-3 px-4 whitespace-nowrap font-sans">
                                                            <span
                                                                className={`inline-flex items-center gap-1 font-semibold px-2 py-0.5 rounded text-[11px] ${
                                                                    t.side === 'BUY'
                                                                        ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                                                        : 'bg-indigo-500/10 text-indigo-400 border border-indigo-500/20'
                                                                }`}
                                                            >
                                                                {t.side} ({t.type})
                                                            </span>
                                                        </td>
                                                        <td className="py-3 px-4 text-right font-medium text-slate-200">
                                                            {formatNGN(t.price)}
                                                        </td>
                                                        <td className="py-3 px-4 text-right text-slate-300">
                                                            {t.amount.toFixed(4)}
                                                        </td>
                                                        <td className="py-3 px-4 text-right text-slate-400">
                                                            {formatNGN(t.fee)}
                                                        </td>
                                                        <td className="py-3 px-4 text-right font-bold">
                                                            {isExit ? (
                                                                <span className={isWin ? 'text-emerald-400' : 'text-red-400'}>
                                                                    {formatPnlNGN(t.pnl)} ({isWin ? '+' : ''}{t.pnlPercent.toFixed(2)}%)
                                                                </span>
                                                            ) : (
                                                                <span className="text-slate-500 font-sans">—</span>
                                                            )}
                                                        </td>
                                                        <td className="py-3 px-4 text-center whitespace-nowrap font-sans">
                                                            {t.status === 'WIN' && (
                                                                <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                                                                    WIN
                                                                </span>
                                                            )}
                                                            {t.status === 'LOSS' && (
                                                                <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-red-500/15 text-red-400 border border-red-500/30">
                                                                    LOSS
                                                                </span>
                                                            )}
                                                            {t.status === 'ENTRY' && (
                                                                <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-slate-800 text-slate-400 border border-slate-700">
                                                                    FILLED
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

                            {/* PAGINATION CONTROLS (Requirement 1: Next and Previous page controls) */}
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 text-xs text-slate-400">
                                <div>
                                    Showing <span className="font-semibold text-white">{(currentPage - 1) * pageSize + (filteredTrades.length > 0 ? 1 : 0)}</span> to{' '}
                                    <span className="font-semibold text-white">{Math.min(currentPage * pageSize, filteredTrades.length)}</span> of{' '}
                                    <span className="font-semibold text-white">{filteredTrades.length}</span> entries (Page{' '}
                                    <span className="font-semibold text-cyan-400">{currentPage}</span> of{' '}
                                    <span className="font-semibold text-white">{totalPages}</span>)
                                </div>

                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                                        disabled={currentPage <= 1}
                                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-200 hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                    >
                                        <ChevronLeft className="w-4 h-4" />
                                        <span>Previous</span>
                                    </button>

                                    {/* Page Number Indicator Pills */}
                                    <div className="flex items-center gap-1">
                                        {Array.from({ length: totalPages }, (_, i) => i + 1)
                                            .filter((page) => {
                                                // Show first, last, and immediate neighbors of currentPage
                                                return page === 1 || page === totalPages || Math.abs(page - currentPage) <= 1;
                                            })
                                            .map((page, idx, arr) => {
                                                const prev = arr[idx - 1];
                                                const hasEllipsis = prev && page - prev > 1;
                                                return (
                                                    <React.Fragment key={page}>
                                                        {hasEllipsis && <span className="px-1 text-slate-600">...</span>}
                                                        <button
                                                            onClick={() => setCurrentPage(page)}
                                                            className={`w-7 h-7 rounded-lg font-semibold text-xs transition-all cursor-pointer ${
                                                                page === currentPage
                                                                    ? 'bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-500/20'
                                                                    : 'bg-slate-900 border border-slate-800 text-slate-400 hover:text-white hover:bg-slate-800'
                                                            }`}
                                                        >
                                                            {page}
                                                        </button>
                                                    </React.Fragment>
                                                );
                                            })}
                                    </div>

                                    <button
                                        onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                                        disabled={currentPage >= totalPages}
                                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-slate-200 hover:text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                    >
                                        <span>Next</span>
                                        <ChevronRight className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        </section>
                    </>
                )}
            </div>

            {/* Footer */}
            <footer className="mt-auto border-t border-slate-800/80 bg-[#090D16]/90 py-5 px-6 text-xs text-slate-400">
                <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                        <span className="font-semibold text-slate-300">QuantEngine v1.0.0</span>
                        <span className="text-slate-600">•</span>
                        <span>Paper Trading Simulation</span>
                        <span className="text-slate-600">•</span>
                        <span className="text-amber-400/90 font-medium">No real funds at risk</span>
                    </div>
                    <div className="flex items-center gap-4 text-slate-400">
                        <span>Synced every 10s</span>
                        <span className="text-slate-600">•</span>
                        <span>Risk Target: 2% / Pos • Max DD: 5%</span>
                    </div>
                </div>
            </footer>
        </main>
    );
}
