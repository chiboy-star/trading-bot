import dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env in project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export interface OrderEnteredParams {
    symbol: string;
    entryPrice: number;
    amount: number;
    initialStop: number;
    atr?: number;
    timestamp: number;
    direction?: 'LONG' | 'SHORT';
}

export interface PositionClosedParams {
    symbol: string;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
    reason: 'TRAILING_STOP' | 'EMA_CROSS' | string;
    durationMs?: number;
    timestamp: number;
}

export interface CircuitBreakerParams {
    totalLoss: number;
    capital: number;
    lockoutUntil: number;
    timestamp: number;
}

export interface DiscordEmbedField {
    name: string;
    value: string;
    inline?: boolean;
}

export interface DiscordEmbed {
    title: string;
    description?: string;
    color: number;
    fields: DiscordEmbedField[];
    timestamp?: string;
    footer?: {
        text: string;
    };
}

/**
 * Dispatches a Discord embed payload via native fetch.
 * Fails silently with a console warning if DISCORD_WEBHOOK_URL is unset.
 */
export async function sendDiscordAlert(embed: DiscordEmbed): Promise<boolean> {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl || webhookUrl.trim() === '') {
        console.warn("\x1b[33m[NOTIFIER WARNING]\x1b[0m DISCORD_WEBHOOK_URL is not set. Discord alert skipped.");
        return false;
    }

    try {
        const payload = {
            username: "Trading Bot - Quantitative Engine",
            avatar_url: "https://cryptologos.cc/logos/bitcoin-btc-logo.png",
            embeds: [embed]
        };

        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            console.error(`\x1b[31m[NOTIFIER ERROR]\x1b[0m Discord webhook responded with status ${response.status}: ${response.statusText}`);
            return false;
        }

        return true;
    } catch (err) {
        console.error("\x1b[31m[NOTIFIER ERROR]\x1b[0m Failed to send Discord webhook:", err);
        return false;
    }
}

/**
 * Sends [ORDER ENTERED] alert with Green embed (0x2ECC71 = 3066993)
 */
export async function notifyOrderEntered(data: OrderEnteredParams): Promise<boolean> {
    const isoTime = new Date(data.timestamp).toISOString();
    const cost = data.amount * data.entryPrice;
    const isShort = data.direction === 'SHORT';
    const dirLabel = isShort ? 'Short' : 'Long';
    const crossLabel = isShort ? '20/50 EMA Death Cross (20 EMA crossed below 50 EMA)' : '20/50 EMA Golden Cross';

    const embed: DiscordEmbed = {
        title: `${isShort ? '🔴' : '🟢'} [ORDER ENTERED] ${data.symbol} (${dirLabel.toUpperCase()})`,
        description: `${dirLabel} position opened following ${crossLabel} confirmation with ADX > 25 & RSI momentum filter.`,
        color: isShort ? 15158332 : 3066993, // Red (0xE74C3C) if Short, Green (0x2ECC71) if Long
        fields: [
            { name: "Direction", value: `**${dirLabel.toUpperCase()}**`, inline: true },
            { name: "Pair", value: `\`${data.symbol}\``, inline: true },
            { name: "Entry Price", value: `**$${data.entryPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**`, inline: true },
            { name: "Position Size", value: `${data.amount.toFixed(4)} (~$${cost.toFixed(2)})`, inline: true },
            { name: isShort ? "Initial Stop-Loss (Above Entry)" : "Initial Stop-Loss (1.5x ATR)", value: `\`$${data.initialStop.toFixed(2)}\``, inline: true },
            ...(data.atr ? [{ name: "ATR (14)", value: `$${data.atr.toFixed(2)}`, inline: true }] : []),
            { name: "Timestamp", value: isoTime, inline: false }
        ],
        timestamp: isoTime,
        footer: { text: "Paper Trading Engine • ADX Market Regime + 1.5x ATR Trailing Stop" }
    };

    return sendDiscordAlert(embed);
}

/**
 * Sends [POSITION CLOSED] alert with Blue (Profit) or Orange (Loss) embed.
 */
export async function notifyPositionClosed(data: PositionClosedParams): Promise<boolean> {
    const isoTime = new Date(data.timestamp).toISOString();
    const isWin = data.pnl > 0;
    const color = isWin ? 3447003 : 15105570; // Blue (0x3498DB) if profit, Orange (0xE67E22) if loss
    const pnlSign = data.pnl >= 0 ? "+$" : "-$";
    const pnlPctSign = data.pnlPercent >= 0 ? "+" : "";
    const pnlFormatted = `${pnlSign}${Math.abs(data.pnl).toFixed(2)} (${pnlPctSign}${data.pnlPercent.toFixed(2)}%)`;

    const readableReason = data.reason === 'TRAILING_STOP' 
        ? 'Dynamic 1.5x ATR Trailing Stop Hit (Long)'
        : data.reason === 'TRAILING_STOP (SHORT)'
        ? 'Dynamic 1.5x ATR Trailing Stop Hit (Short)'
        : data.reason === 'EMA_CROSS'
        ? 'Trend Reversal (20 EMA crossed below 50 EMA)'
        : data.reason === 'EMA_CROSS (SHORT)'
        ? 'Trend Reversal (20 EMA crossed above 50 EMA)'
        : data.reason;

    const embed: DiscordEmbed = {
        title: `${isWin ? '🔵' : '🟠'} [POSITION CLOSED] ${data.symbol}`,
        description: `Position closed. Realized PnL: **${pnlFormatted}**`,
        color: color,
        fields: [
            { name: "Pair", value: `\`${data.symbol}\``, inline: true },
            { name: "Exit Price", value: `**$${data.exitPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**`, inline: true },
            { name: "Realized PnL", value: `**${pnlFormatted}**`, inline: true },
            { name: "Exit Reason", value: readableReason, inline: false },
            ...(data.durationMs ? [{ name: "Holding Duration", value: `${(data.durationMs / (1000 * 60 * 60)).toFixed(1)} hours`, inline: true }] : []),
            { name: "Timestamp", value: isoTime, inline: false }
        ],
        timestamp: isoTime,
        footer: { text: "Paper Trading Engine • Risk Managed Real-Time Execution" }
    };

    return sendDiscordAlert(embed);
}

/**
 * Sends [CIRCUIT BREAKER HIT] emergency alert with Red embed (0xE74C3C = 15158332)
 */
export async function notifyCircuitBreaker(data: CircuitBreakerParams): Promise<boolean> {
    const isoTime = new Date(data.timestamp).toISOString();
    const lockoutIso = new Date(data.lockoutUntil).toISOString();

    const embed: DiscordEmbed = {
        title: `🚨 [CIRCUIT BREAKER HIT] Trading Halted`,
        description: `Emergency Circuit Breaker activated. Portfolio rolling 24-hour drawdown exceeded **5%** ($${data.totalLoss.toFixed(2)} / $${data.capital.toFixed(2)}). All new orders are halted for 24 hours.`,
        color: 15158332, // Red (0xE74C3C)
        fields: [
            { name: "24h Drawdown Loss", value: `-$${data.totalLoss.toFixed(2)}`, inline: true },
            { name: "Current Capital", value: `$${data.capital.toFixed(2)}`, inline: true },
            { name: "Cooldown Duration", value: "24 Hours", inline: true },
            { name: "Lockout Expiry", value: lockoutIso, inline: false },
            { name: "Timestamp", value: isoTime, inline: false }
        ],
        timestamp: isoTime,
        footer: { text: "Portfolio Risk Protection • Capital Preservation Protocol" }
    };

    return sendDiscordAlert(embed);
}
