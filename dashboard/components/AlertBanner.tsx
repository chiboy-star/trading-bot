import React from 'react';
import type { AlertItem } from '@/lib/db';

interface AlertBannerProps {
    alerts: AlertItem[];
    onDismiss: (alertId: number) => Promise<void>;
}

export default function AlertBanner({ alerts, onDismiss }: AlertBannerProps) {
    if (!alerts || alerts.length === 0) return null;

    return (
        <div className="space-y-2 mb-6" role="region" aria-label="Active System Alerts">
            {alerts.map((alert) => {
                const isError = alert.type === 'ERROR';
                return (
                    <div
                        key={alert.id}
                        className={`p-4 rounded-lg border flex items-start justify-between gap-3 text-sm ${
                            isError
                                ? 'bg-[#FEE2E2] border-[#FECACA] text-[#B91C1C]'
                                : 'bg-[#F3F4F6] border-[#E5E7EB] text-[#111315]'
                        }`}
                        role="alert"
                    >
                        <div className="space-y-0.5">
                            <div className="flex items-center gap-2 font-medium">
                                <span className={`w-2 h-2 rounded-full ${isError ? 'bg-[#B91C1C]' : 'bg-[#4B5563]'}`} />
                                <span>{alert.message}</span>
                            </div>
                            {alert.cause && (
                                <p className="text-xs text-[#525866] pl-4">
                                    Cause: {alert.cause}
                                </p>
                            )}
                            <div className="text-[11px] text-[#525866] pl-4 tabular-nums" suppressHydrationWarning>
                                Timestamp: {alert.timeFormatted}
                            </div>
                        </div>

                        <button
                            type="button"
                            onClick={() => onDismiss(alert.id)}
                            className="text-xs font-semibold px-2.5 py-1 rounded border border-current hover:opacity-80 transition-opacity focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current cursor-pointer shrink-0"
                            aria-label={`Dismiss alert ${alert.id}`}
                        >
                            Dismiss
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
