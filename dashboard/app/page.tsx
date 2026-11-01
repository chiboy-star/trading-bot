'use client';

import React, { useState, useEffect } from 'react';
import useSWR from 'swr';
import Link from 'next/link';
import StatusZone from '@/components/StatusZone';
import MetricTile from '@/components/MetricTile';
import LiveMarketChart from '@/components/LiveMarketChart';
import EquityCurve from '@/components/EquityCurve';
import PositionRow from '@/components/PositionRow';
import OrderRow from '@/components/OrderRow';
import AlertBanner from '@/components/AlertBanner';
import SkeletonBlock from '@/components/SkeletonBlock';
import { useCurrency } from '@/context/CurrencyContext';
import { getOperatorAuthHeaders } from '@/lib/clientAuth';
import type { InstitutionalDashboardData } from '@/lib/db';

const fetcher = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error('Failed to fetch institutional dashboard data');
    }
    return res.json();
};

export default function DashboardPage() {
    const [mounted, setMounted] = useState(false);
    const [isMutating, setIsMutating] = useState(false);
    const [activeActivityTab, setActiveActivityTab] = useState<'POSITIONS' | 'ORDERS' | 'LOG'>('POSITIONS');
    const { formatMoney } = useCurrency();

    useEffect(() => {
        setMounted(true);
    }, []);

    // Polled every 3 seconds via SWR as specified in Design Doc
    const { data, error, isLoading, mutate } = useSWR<InstitutionalDashboardData>(
        '/api/dashboard',
        fetcher,
        {
            refreshInterval: 3000,
            revalidateOnFocus: true,
            dedupingInterval: 1000,
        }
    );

    const handleControlAction = async (action: 'PAUSE' | 'RESUME' | 'KILL_SWITCH' | 'RESET_CIRCUIT_BREAKER') => {
        setIsMutating(true);
        try {
            const res = await fetch('/api/control', {
                method: 'POST',
                headers: getOperatorAuthHeaders(),
                body: JSON.stringify({ action }),
            });
            if (res.ok) {
                await mutate();
            }
        } catch (err) {
            console.error('Failed to dispatch operator control action', err);
        } finally {
            setIsMutating(false);
        }
    };

    const handleDismissAlert = async (alertId: number) => {
        try {
            const res = await fetch('/api/control', {
                method: 'POST',
                headers: getOperatorAuthHeaders(),
                body: JSON.stringify({ action: 'DISMISS_ALERT', alertId }),
            });
            if (res.ok) {
                await mutate();
            }
        } catch (err) {
            console.error('Failed to dismiss alert', err);
        }
    };

    // Layout-preserving skeleton for initial load (Zero spinning loaders!)
    if (isLoading && !data) {
        return (
            <main className="min-h-screen bg-[#FAF9F6] text-[#111315]">
                <div className="max-w-[1200px] mx-auto px-6 md:px-16 py-8 space-y-8">
                    {/* Top Bar Skeleton */}
                    <div className="flex items-center justify-between pb-6 border-b border-[#E5E7EB]">
                        <SkeletonBlock width="w-48" height="h-6" />
                        <div className="flex gap-3">
                            <SkeletonBlock width="w-32" height="h-12" />
                            <SkeletonBlock width="w-24" height="h-12" />
                        </div>
                    </div>

                    {/* Dominant Metric Skeleton */}
                    <SkeletonBlock width="w-full" height="h-28" />

                    {/* Main Grid Skeleton */}
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                        <div className="lg:col-span-8 space-y-6">
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <SkeletonBlock height="h-24" />
                                <SkeletonBlock height="h-24" />
                                <SkeletonBlock height="h-24" />
                            </div>
                            <SkeletonBlock height="h-72" />
                        </div>
                        <div className="lg:col-span-4 space-y-4">
                            <SkeletonBlock height="h-12" />
                            <SkeletonBlock height="h-64" />
                        </div>
                    </div>
                </div>
            </main>
        );
    }

    if (error || !data) {
        return (
            <main className="min-h-screen bg-[#FAF9F6] text-[#111315] flex items-center justify-center p-6">
                <div className="max-w-md w-full bg-[#FFFFFF] border border-[#FECACA] p-6 rounded-lg space-y-3">
                    <h1 className="text-base font-semibold text-[#B91C1C]">
                        Unable to connect to trading engine
                    </h1>
                    <p className="text-xs text-[#525866]">
                        {error?.message || 'Database could not be reached. Ensure the bot backend is running.'}
                    </p>
                    <button
                        type="button"
                        onClick={() => mutate()}
                        className="px-4 py-2 text-xs font-semibold bg-[#111315] text-white rounded hover:bg-[#25282C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#111315]"
                    >
                        Retry Connection
                    </button>
                </div>
            </main>
        );
    }

    const { systemState, metrics, equityHistory, positions, orders, alerts, activityLog, monitoredMarkets } = data;
    const syncTimeStr = mounted ? `${new Date(data.lastUpdated).toISOString().slice(11, 19)} UTC` : '--:--:-- UTC';

    return (
        <main className="min-h-screen bg-[#FAF9F6] text-[#111315]">
            {/* Header & Spatial Architecture Container (Max width 1200px, 24px phone / 64px desktop) */}
            <div className="max-w-[1200px] mx-auto px-6 md:px-16 py-8 space-y-8">
                {/* Institutional Header */}
                <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#E5E7EB] pb-5">
                    <div>
                        <div className="text-xs font-semibold tracking-widest uppercase text-[#525866]">
                            Institutional Algorithmic System
                        </div>
                        <h1 className="text-xl font-bold tracking-tight text-[#111315] mt-0.5">
                            Trading Engine Dashboard
                        </h1>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-[#525866]">
                        <Link
                            href="/recorder"
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#E5E7EB] hover:bg-[#D1D5DB] text-[#111315] font-semibold transition-colors"
                        >
                            📊 Recorder Status
                        </Link>
                        <div className="text-right tabular-nums" suppressHydrationWarning>
                            <span>Synced: {syncTimeStr}</span>
                        </div>
                    </div>
                </header>

                {/* Dismissible Alerts Banner */}
                <AlertBanner alerts={alerts} onDismiss={handleDismissAlert} />

                {/* ZONE 1: STATUS ZONE */}
                {/* On phone: pinned/sticky at top with subtle hairline border; Desktop: top row full width */}
                <div className="sticky top-0 z-30 bg-[#FAF9F6]/95 backdrop-blur-none border-b border-[#E5E7EB] md:border-b-0 md:static pb-4 md:pb-0">
                    <StatusZone
                        systemState={systemState}
                        metrics={metrics}
                        positions={positions}
                        onControlAction={handleControlAction}
                        isMutating={isMutating}
                    />
                </div>

                {/* TWO-COLUMN RESPONSIVE GRID (Desktop: Left 2/3, Right 1/3; Phone: vertical stack) */}
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                    {/* ZONE 2: PERFORMANCE ZONE (lg:col-span-8, 2/3 width) */}
                    <section
                        aria-label="Performance Metrics and Live Market Analysis"
                        className="lg:col-span-8 space-y-6"
                    >
                        {/* Secondary Metric Tiles */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                            <MetricTile
                                caption="Total Equity"
                                value={formatMoney(metrics.totalEquity)}
                                subValue={`Initial Capital: ${formatMoney(metrics.initialCapital)}`}
                            />
                            <MetricTile
                                caption="Win Rate"
                                value={`${metrics.winRate.toFixed(1)}%`}
                                subValue={`${metrics.totalTradesCount} closed trades`}
                            />
                            <MetricTile
                                caption="24h Drawdown"
                                value={`${metrics.maxDrawdown.toFixed(2)}%`}
                                subValue={`Circuit Breaker Limit: ${(metrics.circuitBreakerLimitPct ?? 5.0).toFixed(1)}%`}
                                isPnl={metrics.maxDrawdown > 0}
                                pnlPositive={false}
                            />
                        </div>

                        {/* Live Monitored Asset Ticker & Price Chart */}
                        <LiveMarketChart
                            markets={monitoredMarkets || []}
                            activePositions={positions}
                        />

                        {/* Interactive Equity Curve Chart */}
                        <EquityCurve
                            data={equityHistory}
                            currentEquity={metrics.totalEquity}
                        />
                    </section>

                    {/* ZONE 3: ACTIVITY ZONE (lg:col-span-4, 1/3 width) */}
                    <section
                        aria-label="Active Positions and Order Activity"
                        className="lg:col-span-4 border border-[#E5E7EB] bg-[#FFFFFF] rounded-lg overflow-hidden flex flex-col"
                    >
                        {/* Activity Zone Tabs */}
                        <div className="flex border-b border-[#E5E7EB] bg-[#FAF9F6]">
                            <button
                                type="button"
                                onClick={() => setActiveActivityTab('POSITIONS')}
                                className={`flex-1 py-3 text-xs font-semibold tracking-wider uppercase border-b-2 transition-colors cursor-pointer tabular-nums ${
                                    activeActivityTab === 'POSITIONS'
                                        ? 'border-[#111315] text-[#111315] bg-[#FFFFFF]'
                                        : 'border-transparent text-[#525866] hover:text-[#111315]'
                                }`}
                            >
                                Open Positions ({positions.length})
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveActivityTab('ORDERS')}
                                className={`flex-1 py-3 text-xs font-semibold tracking-wider uppercase border-b-2 transition-colors cursor-pointer tabular-nums ${
                                    activeActivityTab === 'ORDERS'
                                        ? 'border-[#111315] text-[#111315] bg-[#FFFFFF]'
                                        : 'border-transparent text-[#525866] hover:text-[#111315]'
                                }`}
                            >
                                Recent Orders ({orders.length})
                            </button>
                            <button
                                type="button"
                                onClick={() => setActiveActivityTab('LOG')}
                                className={`flex-1 py-3 text-xs font-semibold tracking-wider uppercase border-b-2 transition-colors cursor-pointer tabular-nums ${
                                    activeActivityTab === 'LOG'
                                        ? 'border-[#111315] text-[#111315] bg-[#FFFFFF]'
                                        : 'border-transparent text-[#525866] hover:text-[#111315]'
                                }`}
                            >
                                Audit Log
                            </button>
                        </div>

                        {/* Tab Content List Container */}
                        <div className="divide-y divide-[#E5E7EB] max-h-[560px] overflow-y-auto">
                            {activeActivityTab === 'POSITIONS' && (
                                <>
                                    {positions.length === 0 ? (
                                        <div className="py-12 px-4 text-center text-xs text-[#525866]">
                                            No active open positions. Watching screened pairs...
                                        </div>
                                    ) : (
                                        positions.map((pos) => (
                                            <PositionRow
                                                key={`${pos.symbol}-${pos.broker}`}
                                                position={pos}
                                            />
                                        ))
                                    )}
                                </>
                            )}

                            {activeActivityTab === 'ORDERS' && (
                                <>
                                    {orders.length === 0 ? (
                                        <div className="py-12 px-4 text-center text-xs text-[#525866]">
                                            No order history recorded yet.
                                        </div>
                                    ) : (
                                        orders.map((ord) => (
                                            <OrderRow key={ord.id} order={ord} />
                                        ))
                                    )}
                                </>
                            )}

                            {activeActivityTab === 'LOG' && (
                                <>
                                    {activityLog.length === 0 ? (
                                        <div className="py-12 px-4 text-center text-xs text-[#525866]">
                                            No audit entries logged.
                                        </div>
                                    ) : (
                                        activityLog.map((log) => (
                                            <div
                                                key={log.id}
                                                className="p-3 text-xs space-y-1 hover:bg-[#FAF9F6] transition-colors border-b border-[#E5E7EB]"
                                            >
                                                <div className="flex items-center justify-between text-[#525866] tabular-nums">
                                                    <span className="font-medium text-[#111315]">
                                                        {log.type}
                                                    </span>
                                                    <span suppressHydrationWarning>{log.timeFormatted}</span>
                                                </div>
                                                <p className="text-[#111315]">{log.message}</p>
                                                {log.cause && (
                                                    <p className="text-[11px] text-[#525866]">
                                                        Cause: {log.cause}
                                                    </p>
                                                )}
                                            </div>
                                        ))
                                    )}
                                </>
                            )}
                        </div>
                    </section>
                </div>
            </div>
        </main>
    );
}
