import React, { useState } from 'react';
import StatusPill from './StatusPill';
import MetricTile from './MetricTile';
import KillSwitchModal from './KillSwitchModal';
import ResetBreakerModal from './ResetBreakerModal';
import CircuitBreakerSlider from './CircuitBreakerSlider';
import { useCurrency } from '@/context/CurrencyContext';
import type { SystemStateInfo, MetricSummary, PositionItem } from '@/lib/db';

interface StatusZoneProps {
    systemState: SystemStateInfo;
    metrics: MetricSummary;
    positions: PositionItem[];
    onControlAction: (action: 'PAUSE' | 'RESUME' | 'KILL_SWITCH' | 'RESET_CIRCUIT_BREAKER') => Promise<void>;
    isMutating: boolean;
}

export default function StatusZone({
    systemState,
    metrics,
    positions,
    onControlAction,
    isMutating,
}: StatusZoneProps) {
    const [isKillModalOpen, setIsKillModalOpen] = useState(false);
    const [isResetModalOpen, setIsResetModalOpen] = useState(false);
    const { currency, setCurrency, formatMoney, fxRateFormatted } = useCurrency();
    const isPaused = systemState.status === 'PAUSED';
    const isBreakerHalted = Boolean(systemState.isCircuitBreakerHalted);

    const handleTogglePause = async () => {
        await onControlAction(isPaused ? 'RESUME' : 'PAUSE');
    };

    const handleConfirmKill = async () => {
        await onControlAction('KILL_SWITCH');
        setIsKillModalOpen(false);
    };

    const handleConfirmResetBreaker = async () => {
        await onControlAction('RESET_CIRCUIT_BREAKER');
        setIsResetModalOpen(false);
    };

    const todayPnl = metrics.todayPnl;
    const isPositive = todayPnl >= 0;
    const sign = isPositive ? '+' : '-';
    const formattedPnl = formatMoney(todayPnl, { signed: true });
    const formattedPnlPercent = `${sign}${Math.abs(metrics.todayPnlPercent).toFixed(2)}% today`;

    return (
        <section aria-label="Bot Status & Primary Controls" className="space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#E5E7EB]">
                {/* Status Pill, Currency Toggle & Engine Meta */}
                <div className="flex flex-wrap items-center gap-3">
                    <StatusPill systemState={systemState} />

                    {/* Crisp Segmented USD | NGN Toggle */}
                    <div className="inline-flex items-center rounded border border-[#E5E7EB] bg-[#FAF9F6] p-0.5 text-xs font-medium">
                        <button
                            type="button"
                            onClick={() => setCurrency('USD')}
                            className={`px-2.5 py-1 rounded transition-colors cursor-pointer ${
                                currency === 'USD'
                                    ? 'bg-[#111315] text-[#FAF9F6] font-semibold'
                                    : 'text-[#4B5563] hover:text-[#111315]'
                            }`}
                        >
                            USD
                        </button>
                        <button
                            type="button"
                            onClick={() => setCurrency('NGN')}
                            className={`px-2.5 py-1 rounded transition-colors cursor-pointer ${
                                currency === 'NGN'
                                    ? 'bg-[#111315] text-[#FAF9F6] font-semibold'
                                    : 'text-[#4B5563] hover:text-[#111315]'
                            }`}
                        >
                            NGN
                        </button>
                    </div>

                    {/* Active FX Rate Caption when NGN selected */}
                    {currency === 'NGN' && (
                        <span className="text-[11px] text-[#4B5563] tabular-nums hidden sm:inline" suppressHydrationWarning>
                            {fxRateFormatted}
                        </span>
                    )}

                    <span className="text-xs text-[#525866] tabular-nums hidden lg:inline">
                        Timezone: UTC
                    </span>
                </div>

                {/* Operator Control Actions */}
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        onClick={handleTogglePause}
                        disabled={isMutating}
                        className="h-12 px-6 bg-[#111315] hover:bg-[#25282C] text-white text-sm font-semibold rounded transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#111315] disabled:opacity-50 min-w-[130px] flex items-center justify-center cursor-pointer"
                    >
                        {isMutating ? 'Updating...' : isPaused ? 'Resume Bot' : 'Pause Bot'}
                    </button>

                    <button
                        type="button"
                        onClick={() => setIsKillModalOpen(true)}
                        disabled={isMutating}
                        className="h-12 px-4 border border-[#E5E7EB] hover:border-[#FECACA] hover:bg-[#FEE2E2]/40 text-[#B91C1C] text-sm font-medium rounded transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B91C1C] disabled:opacity-50 cursor-pointer"
                    >
                        Kill Switch
                    </button>

                    {isBreakerHalted && (
                        <button
                            type="button"
                            onClick={() => setIsResetModalOpen(true)}
                            disabled={isMutating}
                            className="h-12 px-4 bg-[#B91C1C] hover:bg-[#991B1B] text-white text-sm font-semibold rounded transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#B91C1C] disabled:opacity-50 flex items-center gap-2 cursor-pointer shadow-xs"
                        >
                            <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
                            Reset Breaker
                        </button>
                    )}
                </div>
            </div>

            {/* Circuit Breaker Emergency Active Alert Banner */}
            {isBreakerHalted && (
                <div
                    className="p-3.5 bg-[#FEF2F2] border border-[#FECACA] rounded text-xs text-[#991B1B] font-medium flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-xs"
                    role="alert"
                >
                    <div className="flex items-center gap-2.5">
                        <span className="w-2 h-2 rounded-full bg-[#DC2626] animate-ping" />
                        <span>
                            <strong>Circuit Breaker Engaged:</strong> 24h rolling loss threshold ({metrics.circuitBreakerLimitPct?.toFixed(1) ?? '5.0'}%) exceeded. New position entries are halted{systemState.lockoutUntil ? ` until ${new Date(systemState.lockoutUntil).toLocaleTimeString()}` : ''}.
                        </span>
                    </div>
                    <button
                        type="button"
                        onClick={() => setIsResetModalOpen(true)}
                        disabled={isMutating}
                        className="px-3 py-1.5 bg-[#DC2626] hover:bg-[#B91C1C] text-white text-xs font-semibold rounded transition-colors self-start sm:self-auto cursor-pointer"
                    >
                        Override & Reset Breaker
                    </button>
                </div>
            )}

            {/* Paused Crisp Notice Banner */}
            {isPaused && (
                <div
                    className="p-3 bg-[#F3F4F6] border border-[#E5E7EB] rounded text-xs text-[#4B5563] font-medium flex items-center justify-between"
                    role="alert"
                >
                    <span>Bot is paused. No new orders will be placed.</span>
                    <span className="text-[11px] text-[#525866] tabular-nums">
                        Active positions remain protected by trailing stops
                    </span>
                </div>
            )}

            {/* Dynamic Circuit Breaker Threshold Slider */}
            <CircuitBreakerSlider
                currentLimit={metrics.circuitBreakerLimitPct ?? 5.0}
            />

            {/* Dominant Metric Tile: Today's P&L */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <MetricTile
                    caption="Today's P&L (Realized + Open)"
                    value={formattedPnl}
                    subValue={formattedPnlPercent}
                    isPnl={true}
                    pnlPositive={isPositive}
                    dominant={true}
                    className="md:col-span-4"
                />
            </div>

            {/* 2-Step Confirmation Modals */}
            <KillSwitchModal
                isOpen={isKillModalOpen}
                positions={positions}
                onConfirm={handleConfirmKill}
                onCancel={() => setIsKillModalOpen(false)}
                isSubmitting={isMutating}
            />

            <ResetBreakerModal
                isOpen={isResetModalOpen}
                currentDrawdownPct={metrics.maxDrawdown ?? 0}
                thresholdPct={metrics.circuitBreakerLimitPct ?? 5.0}
                onConfirm={handleConfirmResetBreaker}
                onCancel={() => setIsResetModalOpen(false)}
                isSubmitting={isMutating}
            />
        </section>
    );
}
