'use client';

import React, { useState, useEffect } from 'react';
import useSWR from 'swr';
import {
    Activity,
    Database as DbIcon,
    AlertTriangle,
    CheckCircle2,
    XCircle,
    RefreshCw,
    Wifi,
    Zap,
    Clock,
    Layers,
    TrendingUp
} from 'lucide-react';
import type { RecorderDashboardStatus } from '@/lib/recorder_db';

const fetcher = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error('Failed to fetch recorder status');
    }
    return res.json();
};

export default function RecorderStatusPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    // Auto-refresh every 30 seconds
    const { data, error, isLoading, mutate } = useSWR<RecorderDashboardStatus>(
        '/api/recorder',
        fetcher,
        {
            refreshInterval: 30000,
            revalidateOnFocus: true,
            dedupingInterval: 5000,
        }
    );

    const syncTimeStr = mounted && data?.timestamp
        ? `${new Date(data.timestamp).toISOString().slice(11, 19)} UTC`
        : '--:--:-- UTC';

    return (
        <main className="min-h-screen bg-[#0E1012] text-[#F3F4F6] font-sans">
            <div className="max-w-[1360px] mx-auto px-4 md:px-8 py-8 space-y-8">
                {/* Top Header & Status Bar */}
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#22262B] pb-5">
                    <div className="flex items-center gap-4">
                        <div>
                            <div className="flex items-center gap-2">
                                <h1 className="text-xl font-bold tracking-tight text-[#FFFFFF] flex items-center gap-2.5">
                                    <DbIcon className="w-5 h-5 text-[#3B82F6]" />
                                    Bybit Market Data Recorder Status
                                </h1>
                                <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-[#1E293B] text-[#93C5FD] border border-[#3B82F6]/30">
                                    Read-Only (WAL)
                                </span>
                            </div>
                            <p className="text-xs text-[#9CA3AF] mt-0.5">
                                24/7 Market data recorder ingestion & data quality telemetry
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        {data && (
                            <div className="flex items-center gap-2 px-3 py-1 rounded bg-[#16191D] border border-[#22262B]">
                                <div className={`w-2.5 h-2.5 rounded-full animate-pulse ${
                                    data.overallHealth === 'HEALTHY' ? 'bg-[#10B981]' :
                                    data.overallHealth === 'DEGRADED' ? 'bg-[#F59E0B]' : 'bg-[#EF4444]'
                                }`} />
                                <span className="text-xs font-bold uppercase tracking-wider">
                                    {data.overallHealth}
                                </span>
                            </div>
                        )}
                        <button
                            type="button"
                            onClick={() => mutate()}
                            disabled={isLoading}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1F242B] hover:bg-[#2B323C] text-[#E5E7EB] rounded border border-[#343B45] transition-colors disabled:opacity-50"
                        >
                            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-[#3B82F6]' : ''}`} />
                            Auto-refresh 30s
                        </button>
                        <div className="text-xs text-[#6B7280] font-mono tabular-nums">
                            Synced: {syncTimeStr}
                        </div>
                    </div>
                </div>

                {/* Error Banner */}
                {error && (
                    <div className="bg-[#451A1A] border border-[#7F1D1D] p-4 rounded-lg flex items-start gap-3">
                        <AlertTriangle className="w-5 h-5 text-[#F87171] shrink-0 mt-0.5" />
                        <div>
                            <h3 className="text-sm font-semibold text-[#FECACA]">Recorder Connection Error</h3>
                            <p className="text-xs text-[#FCA5A5] mt-1">{error.message || 'Could not read data/recorder.db'}</p>
                        </div>
                    </div>
                )}

                {/* Initial Loading Skeleton */}
                {!data && !error && (
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 animate-pulse">
                        {[1, 2, 3, 4].map(i => (
                            <div key={i} className="h-28 bg-[#16191D] rounded-lg border border-[#22262B]" />
                        ))}
                    </div>
                )}

                {data && (
                    <>
                        {/* 1. TOP METRIC TILES */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                            {/* Card 1: WebSocket Shards & Active Contracts */}
                            <div className="bg-[#14171A] border border-[#22262B] p-4 rounded-lg space-y-2">
                                <div className="flex items-center justify-between text-xs text-[#9CA3AF]">
                                    <span className="font-semibold uppercase tracking-wider flex items-center gap-1.5">
                                        <Wifi className="w-4 h-4 text-[#10B981]" />
                                        WebSocket Sharding
                                    </span>
                                    <span className="font-mono text-[11px] text-[#10B981] bg-[#064E3B]/40 px-1.5 py-0.5 rounded border border-[#059669]/30">
                                        {data.wsShards.status}
                                    </span>
                                </div>
                                <div className="flex items-baseline gap-2">
                                    <span className="text-2xl font-bold text-[#FFFFFF] font-mono">
                                        {data.wsShards.totalShards} Shards
                                    </span>
                                    <span className="text-xs text-[#9CA3AF]">
                                        ({data.wsShards.activeSymbols} Symbols)
                                    </span>
                                </div>
                                <p className="text-[11px] text-[#6B7280] truncate font-mono" title={data.wsShards.details}>
                                    {data.wsShards.details}
                                </p>
                            </div>

                            {/* Card 2: REST Rate Limiting & Error Counters */}
                            <div className="bg-[#14171A] border border-[#22262B] p-4 rounded-lg space-y-2">
                                <div className="flex items-center justify-between text-xs text-[#9CA3AF]">
                                    <span className="font-semibold uppercase tracking-wider flex items-center gap-1.5">
                                        <Activity className="w-4 h-4 text-[#3B82F6]" />
                                        REST & Rate Limits (1h)
                                    </span>
                                    <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded border ${
                                        (data.restMetrics?.errors10006LastHour || 0) === 0 && (data.restMetrics?.errors429LastHour || 0) === 0
                                            ? 'text-[#10B981] bg-[#064E3B]/40 border-[#059669]/30'
                                            : 'text-[#F59E0B] bg-[#78350F]/40 border-[#D97706]/30'
                                    }`}>
                                        Peak: {data.restMetrics?.peak5sRequests || 0} req/5s
                                    </span>
                                </div>
                                <div className="flex items-baseline gap-3">
                                    <div>
                                        <span className="text-xs text-[#9CA3AF] mr-1">10006:</span>
                                        <span className={`text-xl font-bold font-mono ${
                                            (data.restMetrics?.errors10006LastHour || 0) > 0 ? 'text-[#F59E0B]' : 'text-[#FFFFFF]'
                                        }`}>
                                            {data.restMetrics?.errors10006LastHour || 0}
                                        </span>
                                    </div>
                                    <div>
                                        <span className="text-xs text-[#9CA3AF] mr-1">429:</span>
                                        <span className={`text-xl font-bold font-mono ${
                                            (data.restMetrics?.errors429LastHour || 0) > 0 ? 'text-[#EF4444]' : 'text-[#FFFFFF]'
                                        }`}>
                                            {data.restMetrics?.errors429LastHour || 0}
                                        </span>
                                    </div>
                                </div>
                                <div className="text-[11px] text-[#6B7280] flex items-center justify-between">
                                    <span>Wire Reqs (1h): <strong className="text-[#E5E7EB] font-mono">{data.restMetrics?.totalRequestsLastHour?.toLocaleString() || 0}</strong></span>
                                    <span>Cap: <strong className="text-[#E5E7EB] font-mono">100/5s</strong></span>
                                </div>
                            </div>

                            {/* Card 3: Liquidation Velocity & Storage */}
                            <div className="bg-[#14171A] border border-[#22262B] p-4 rounded-lg space-y-2">
                                <div className="flex items-center justify-between text-xs text-[#9CA3AF]">
                                    <span className="font-semibold uppercase tracking-wider flex items-center gap-1.5">
                                        <Zap className="w-4 h-4 text-[#F59E0B]" />
                                        Liquidations (24h)
                                    </span>
                                    <span className="text-[11px] text-[#FCD34D]">
                                        {data.liquidations.eventsPerHour}/hr
                                    </span>
                                </div>
                                <div className="flex items-baseline gap-2">
                                    <span className="text-2xl font-bold text-[#FFFFFF] font-mono">
                                        {data.liquidations.countLast24h.toLocaleString()}
                                    </span>
                                    <span className="text-xs text-[#9CA3AF]">
                                        Events
                                    </span>
                                </div>
                                <p className="text-[11px] text-[#6B7280]">
                                    Disk: {data.dbSizeMb.toFixed(1)} MB (+{data.growthRateMbPerDay} MB/d)
                                </p>
                            </div>

                            {/* Card 4: Listings & Network Health */}
                            <div className="bg-[#14171A] border border-[#22262B] p-4 rounded-lg space-y-2">
                                <div className="flex items-center justify-between text-xs text-[#9CA3AF]">
                                    <span className="font-semibold uppercase tracking-wider flex items-center gap-1.5">
                                        <Layers className="w-4 h-4 text-[#8B5CF6]" />
                                        Listings & Network
                                    </span>
                                    <span className="text-[11px] text-[#C4B5FD]">
                                        {data.listings.listingsLast7d} new (7d)
                                    </span>
                                </div>
                                <div className="flex items-baseline gap-2">
                                    <span className="text-2xl font-bold text-[#FFFFFF] font-mono">
                                        {data.listings.haEligibleCount} H-A
                                    </span>
                                    <span className="text-xs text-[#9CA3AF]">
                                        ({data.listings.totalListings} total)
                                    </span>
                                </div>
                                <div className="text-[11px] text-[#6B7280] flex items-center justify-between">
                                    <span>DNS Fails (24h): <strong className="text-[#E5E7EB] font-mono">{data.network.dnsFailureCount24h}</strong></span>
                                    <span>Max Outage: <strong className="text-[#E5E7EB] font-mono">{data.network.longestOutageMinutes24h}m</strong></span>
                                </div>
                            </div>
                        </div>

                        {/* 2. STREAM HEALTH & FRESHNESS TILES */}
                        <div className="space-y-3">
                            <div className="flex items-center justify-between">
                                <h2 className="text-sm font-semibold tracking-wider uppercase text-[#9CA3AF] flex items-center gap-2">
                                    <Activity className="w-4 h-4 text-[#3B82F6]" />
                                    Data Stream Ingestion & Freshness
                                </h2>
                                <span className="text-xs text-[#6B7280]">
                                    8 Parallel Ingestion Feeds
                                </span>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                                {data.streams.map((s) => (
                                    <div
                                        key={s.stream}
                                        className="bg-[#14171A] border border-[#22262B] p-3.5 rounded-lg flex items-center justify-between"
                                    >
                                        <div className="space-y-1">
                                            <div className="text-xs font-semibold text-[#FFFFFF]">
                                                {s.stream}
                                            </div>
                                            <div className="text-[11px] font-mono text-[#6B7280]">
                                                {s.tableName}
                                            </div>
                                            <div className="text-xs text-[#9CA3AF] font-mono">
                                                {s.statusText}
                                            </div>
                                        </div>
                                        <div className="flex flex-col items-end gap-1">
                                            {s.status === 'GREEN' ? (
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-[#064E3B]/60 text-[#34D399] border border-[#059669]/40">
                                                    <CheckCircle2 className="w-3 h-3" />
                                                    GREEN
                                                </span>
                                            ) : (
                                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold bg-[#7F1D1D]/60 text-[#F87171] border border-[#DC2626]/40">
                                                    <XCircle className="w-3 h-3" />
                                                    RED
                                                </span>
                                            )}
                                            {s.latestTimestamp && (
                                                <span className="text-[10px] text-[#6B7280] font-mono">
                                                    {new Date(s.latestTimestamp).toISOString().slice(11, 19)}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* 3. ROW COUNTS & KLINE COVERAGE */}
                        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                            {/* Left Column: Worst 20 1m Kline Coverage */}
                            <div className="lg:col-span-8 bg-[#14171A] border border-[#22262B] rounded-lg p-5 space-y-4">
                                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-[#22262B] pb-3">
                                    <div>
                                        <h3 className="text-sm font-semibold text-[#FFFFFF] flex items-center gap-2">
                                            <TrendingUp className="w-4 h-4 text-[#3B82F6]" />
                                            1m Kline Completeness & Coverage
                                        </h3>
                                        <div className="mt-1 space-y-0.5 text-xs text-[#9CA3AF]">
                                            <p>
                                                <strong className="text-[#E5E7EB]">24h window:</strong> {data.klineCoverage.coverage24hDescription || 'Trailing 24-hour window candle completeness across all active contracts.'}
                                            </p>
                                            <p>
                                                <strong className="text-[#E5E7EB]">since first bar:</strong> {data.klineCoverage.coverageSinceFirstBarDescription || "Lifetime timeseries continuity from each contract's initial stored bar to current time."}
                                            </p>
                                        </div>
                                    </div>
                                    <div className="flex sm:flex-col items-end justify-between sm:justify-center gap-1.5 text-xs text-right">
                                        <div>
                                            <span className="text-[#9CA3AF] text-[11px] mr-1">24h Window:</span>
                                            <strong className="text-[#10B981] font-mono text-sm">
                                                {data.klineCoverage.coverage24hPct}%
                                            </strong>
                                        </div>
                                        <div>
                                            <span className="text-[#9CA3AF] text-[11px] mr-1">Since First Bar:</span>
                                            <strong className="text-[#3B82F6] font-mono text-sm">
                                                {data.klineCoverage.coverageSinceFirstBarPct}%
                                            </strong>
                                        </div>
                                        <span className="text-[#6B7280] block text-[10px]">
                                            {data.klineCoverage.symbolsAbove98Count}/{data.klineCoverage.symbolsAuditedCount} contracts &ge; 98%
                                        </span>
                                    </div>
                                </div>

                                <div className="overflow-x-auto">
                                    <table className="w-full text-left text-xs">
                                        <thead>
                                            <tr className="border-b border-[#22262B] text-[#9CA3AF]">
                                                <th className="py-2 font-medium">Symbol</th>
                                                <th className="py-2 font-medium">First Bar (UTC)</th>
                                                <th className="py-2 font-medium text-right">Stored Bars</th>
                                                <th className="py-2 font-medium text-right">Expected</th>
                                                <th className="py-2 font-medium text-right">Coverage</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-[#1D2126] font-mono">
                                            {data.klineCoverage.worst20.map((row) => (
                                                <tr key={row.symbol} className="hover:bg-[#1A1E23] transition-colors">
                                                    <td className="py-2 font-bold text-[#FFFFFF]">{row.symbol}</td>
                                                    <td className="py-2 text-[#9CA3AF] text-[11px]">
                                                        {row.firstBarIso.replace('T', ' ').slice(0, 19)}
                                                    </td>
                                                    <td className="py-2 text-right text-[#E5E7EB]">{row.storedBars}</td>
                                                    <td className="py-2 text-right text-[#6B7280]">{row.expectedBars}</td>
                                                    <td className="py-2 text-right">
                                                        <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold ${
                                                            row.coveragePct >= 98 ? 'bg-[#064E3B]/60 text-[#34D399]' :
                                                            row.coveragePct >= 50 ? 'bg-[#78350F]/60 text-[#FBBF24]' :
                                                            'bg-[#7F1D1D]/60 text-[#F87171]'
                                                        }`}>
                                                            {row.coveragePct.toFixed(1)}%
                                                        </span>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            {/* Right Column: Database Table Counts & Gaps Summary */}
                            <div className="lg:col-span-4 space-y-6">
                                {/* Table Counts */}
                                <div className="bg-[#14171A] border border-[#22262B] rounded-lg p-5 space-y-3">
                                    <h3 className="text-sm font-semibold text-[#FFFFFF] border-b border-[#22262B] pb-2 flex items-center gap-2">
                                        <DbIcon className="w-4 h-4 text-[#3B82F6]" />
                                        Database Table Counts
                                    </h3>
                                    <div className="space-y-2">
                                        {data.tableCounts.map((tc) => (
                                            <div
                                                key={tc.table}
                                                className="flex items-center justify-between text-xs py-1 border-b border-[#1A1E24] last:border-0"
                                            >
                                                <span className="font-mono text-[#9CA3AF] text-[11px]">{tc.table}</span>
                                                <span className="font-mono font-semibold text-[#FFFFFF]">
                                                    {tc.count.toLocaleString()}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                {/* Outages & Gaps Overview */}
                                <div className="bg-[#14171A] border border-[#22262B] rounded-lg p-5 space-y-3">
                                    <div className="flex flex-col gap-2 border-b border-[#22262B] pb-2">
                                        <div className="flex items-center justify-between">
                                            <h3 className="text-sm font-semibold text-[#FFFFFF] flex items-center gap-2">
                                                <Clock className="w-4 h-4 text-[#F59E0B]" />
                                                Gaps & Outages
                                            </h3>
                                            <span className="text-[11px] text-[#9CA3AF] font-mono">
                                                {data.gaps.totalGapsCount} Total Logged
                                            </span>
                                        </div>
                                        <div className="flex flex-wrap gap-1.5 text-[10px]">
                                            <span className="px-1.5 py-0.5 rounded font-semibold bg-[#7F1D1D]/50 text-[#FCA5A5] border border-[#DC2626]/30">
                                                Unrecoverable Streams: {data.gaps.unrecoverableStreamOutages || data.gaps.unrecoverableGapsCount || 0}
                                            </span>
                                            <span className="px-1.5 py-0.5 rounded font-semibold bg-[#3B82F6]/30 text-[#93C5FD] border border-[#2563EB]/30">
                                                Largest Outage: {data.gaps.largestOutageMinutes ?? data.gaps.longestOutageMinutes24h}m
                                            </span>
                                            <span className="px-1.5 py-0.5 rounded font-semibold bg-[#78350F]/50 text-[#FCD34D] border border-[#D97706]/30">
                                                Open Recoverable: {data.gaps.openRecoverableGapsCount || 0}
                                            </span>
                                            <span className="px-1.5 py-0.5 rounded font-semibold bg-[#064E3B]/50 text-[#6EE7B7] border border-[#059669]/30">
                                                Resolved: {data.gaps.resolvedGapsCount || 0}
                                            </span>
                                        </div>
                                    </div>

                                    {data.gaps.recentGaps.length === 0 ? (
                                        <div className="text-center py-6 text-xs text-[#6B7280] space-y-1">
                                            <CheckCircle2 className="w-6 h-6 text-[#10B981] mx-auto opacity-80" />
                                            <p className="text-[#9CA3AF] font-medium">No Data Gaps Recorded</p>
                                            <p className="text-[11px]">Continuous ingestion pipeline uninterrupted</p>
                                        </div>
                                    ) : (
                                        <div className="space-y-2">
                                            {data.gaps.recentGaps.slice(0, 6).map((gap) => (
                                                <div
                                                    key={gap.id}
                                                    className="bg-[#101316] p-2.5 rounded border border-[#22262B] text-xs space-y-1"
                                                >
                                                    <div className="flex items-center justify-between">
                                                        <span className="font-bold text-[#FFFFFF]">{gap.symbol}</span>
                                                        <span className="text-[11px] font-mono text-[#F59E0B]">
                                                            {gap.durationMinutes}m gap
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center justify-between text-[11px]">
                                                        <span className="text-[#9CA3AF] font-mono">{gap.dataType}</span>
                                                        {gap.category === 'UNRECOVERABLE_STREAM' ? (
                                                             <span className="px-1 py-0.2 rounded text-[9px] font-bold uppercase bg-[#7F1D1D]/60 text-[#F87171] border border-[#DC2626]/40">
                                                                Unrecoverable (Lost Stream)
                                                            </span>
                                                        ) : gap.category === 'RECOVERABLE_OPEN' ? (
                                                            <span className="px-1 py-0.2 rounded text-[9px] font-bold uppercase bg-[#78350F]/60 text-[#FBBF24] border border-[#D97706]/40">
                                                                Open (Pending REST Fill)
                                                            </span>
                                                        ) : (
                                                            <span className="px-1 py-0.2 rounded text-[9px] font-bold uppercase bg-[#064E3B]/60 text-[#34D399] border border-[#059669]/40">
                                                                Resolved
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="text-[10px] text-[#6B7280] flex items-center justify-between font-mono">
                                                        <span>ID #{gap.id}</span>
                                                        <span>{new Date(gap.detectedAt).toISOString().slice(11, 19)} UTC</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </main>
    );
}
