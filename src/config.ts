import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const argv = process.argv.slice(2);

// Execution mode: strictly default to PAPER unless explicitly passed --live and configured as LIVE
const hasLiveArg = argv.includes('--live');
const hasPaperArg = argv.includes('--paper') || argv.includes('--dry-run');
const envMode = (process.env.EXECUTION_MODE || 'PAPER').toUpperCase();

export const isLiveMode = hasLiveArg && !hasPaperArg && envMode === 'LIVE';
export const executionMode: 'LIVE' | 'PAPER' = isLiveMode ? 'LIVE' : 'PAPER';

export const DEFAULT_CORE_PAIRS: string[] = [
    "BTC/USDT",
    "ETH/USDT",
    "SOL/USDT",
    "SUI/USDT",
    "XRP/USDT",
    "DOGE/USDT",
    "1000PEPE/USDT"
];

export const DEFAULT_SATELLITE_PAIRS: string[] = [
    "STRK/USDT",
    "AKE/USDT",
    "TIA/USDT",
    "ALT/USDT",
    "Q/USDT"
];

function parseCorePairs(val?: string): string[] {
    if (!val) return DEFAULT_CORE_PAIRS;
    try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
        const split = val.split(',').map(s => s.trim()).filter(Boolean);
        if (split.length > 0) return split;
    }
    return DEFAULT_CORE_PAIRS;
}

export const config = {
    app: {
        env: process.env.NODE_ENV || 'development',
        logLevel: process.env.LOG_LEVEL || 'info',
        executionMode,
        isLive: isLiveMode,
        isPaper: !isLiveMode,
        // Closed-bar entry guard: false by default, entries strictly execute on closed candles
        allowIntrabarSignals: process.env.ALLOW_INTRABAR_SIGNALS === 'true',
        allowIntrabarStops: process.env.ALLOW_INTRABAR_STOPS !== 'false',
        paperActiveMode: process.env.PAPER_ACTIVE_MODE === 'true',
        strategyPaused: process.env.STRATEGY_PAUSED !== 'false', // Default to true: 15m strategy paused pending edge discovery
    },
    strategy: {
        fastEmaPeriod: Number(process.env.STRATEGY_FAST_EMA || 20),
        slowEmaPeriod: Number(process.env.STRATEGY_SLOW_EMA || 50),
        rsiPeriod: Number(process.env.STRATEGY_RSI_PERIOD || 14),
        longRsiMin: Number(process.env.STRATEGY_LONG_RSI_MIN || 40),
        longRsiMax: Number(process.env.STRATEGY_LONG_RSI_MAX || 65),
        shortRsiMin: Number(process.env.STRATEGY_SHORT_RSI_MIN || 35),
        shortRsiMax: Number(process.env.STRATEGY_SHORT_RSI_MAX || 60),
        adxPeriod: Number(process.env.STRATEGY_ADX_PERIOD || 14),
        adxThreshold: Number(process.env.STRATEGY_ADX_THRESHOLD || 20),
        atrPeriod: Number(process.env.STRATEGY_ATR_PERIOD || 14),
        atrMultiplier: Number(process.env.ATR_TRAILING_MULTIPLIER || process.env.STRATEGY_ATR_MULTIPLIER || 2.8),
        trailingStopMode: (process.env.STRATEGY_TRAILING_STOP_MODE as 'intrabar' | 'close') || 'intrabar',
        takeProfitRMultiplier: Number(process.env.STRATEGY_TP_R_MULTIPLIER || 0), // 0 disables fixed TP (ATR trailing only)
    },
    risk: {
        maxRiskPct: Number(process.env.RISK_MAX_PCT || 0.02), // 2% per trade
        maxDrawdownPct: Number(process.env.RISK_MAX_DRAWDOWN_PCT || 0.05), // 5% 24h circuit breaker
        lockoutMs: Number(process.env.RISK_LOCKOUT_MS || 24 * 60 * 60 * 1000), // 24h lockout
        sizingMode: (process.env.RISK_SIZING_MODE as 'fixed' | 'kelly') || 'fixed',
        kellyFraction: Number(process.env.RISK_KELLY_FRACTION || 0.5), // Half-Kelly
        kellyWinRate: Number(process.env.RISK_KELLY_WIN_RATE || 0.55),
        kellyRewardRatio: Number(process.env.RISK_KELLY_REWARD_RATIO || 1.5),
        minAdaptiveRiskPct: 0.01, // 1.0% min risk for underperforming setups
        maxAdaptiveRiskPct: 0.025, // 2.5% max risk for outperforming setups
        maxConcurrentPositions: Number(process.env.MAX_CONCURRENT_POSITIONS || 8),
        maxSameDirectionPositions: Number(process.env.MAX_SAME_DIRECTION_POSITIONS || 4),
        maxTotalOpenRiskPct: Number(process.env.RISK_MAX_TOTAL_OPEN_RISK_PCT || 0.06), // 6% max portfolio open risk cap
        learnerMinSampleSize: Number(process.env.LEARNER_MIN_SAMPLE_SIZE || 50), // 50 trades minimum for adaptive weights
    },
    watchlist: {
        pinnedCorePairs: parseCorePairs(process.env.PINNED_CORE_PAIRS),
        dynamicScreenerSlots: Number(process.env.DYNAMIC_SCREENER_SLOTS || 5),
        maxConcurrentPositions: Number(process.env.MAX_CONCURRENT_POSITIONS || 8),
        maxSameDirectionPositions: Number(process.env.MAX_SAME_DIRECTION_POSITIONS || 4),
        screeningIntervalHours: Number(process.env.SCREENING_INTERVAL_HOURS || 6),
    },
    exchange: {
        timeframe: process.env.TIMEFRAME || '15m',
        initialCapital: Number(process.env.INITIAL_CAPITAL || 10000),
        takerFee: Number(process.env.TAKER_FEE || 0.0006), // 0.06% Bybit standard futures rate
        slippage: Number(process.env.SLIPPAGE || 0.0005),   // 0.05% for liquid Core pairs
        satelliteSlippage: Number(process.env.SATELLITE_SLIPPAGE || 0.0012), // 0.12% for Satellite mid-caps
        fundingIntervalHours: Number(process.env.FUNDING_INTERVAL_HOURS || 8),
        defaultFundingRate: Number(process.env.DEFAULT_FUNDING_RATE || 0.0001), // 0.01% per 8h
        bybitHostname: (process.env.BYBIT_HOSTNAME || 'bytick.com').replace(/^api\./, ''),
        apiKey: process.env.EXCHANGE_API_KEY || '',
        apiSecret: process.env.EXCHANGE_API_SECRET || '',
    },
    fx: {
        defaultUsdNgnRate: Number(process.env.DEFAULT_USD_NGN_RATE || 1650),
        cacheTtlMs: 15 * 60 * 1000, // 15 minutes
    },
    tradew: {
        metaApiToken: process.env.TRADEW_METAAPI_TOKEN || '',
        accountId: process.env.TRADEW_ACCOUNT_ID || '',
        server: process.env.TRADEW_SERVER || 'TradeW-Live',
        platform: process.env.TRADEW_PLATFORM || 'MT5',
        zmqUrl: process.env.TRADEW_ZMQ_URL || 'tcp://127.0.0.1:5555',
        targetSymbol: process.env.TRADEW_TARGET_SYMBOL || 'ETC/USDT',
        mt5Symbol: process.env.TRADEW_MT5_SYMBOL || 'ETCUSDT',
    },
    forex: {
        enabled: process.env.FOREX_ENABLED === 'true',
        oandaApiKey: process.env.OANDA_API_KEY || '',
        oandaAccountId: process.env.OANDA_ACCOUNT_ID || '',
    },
    notifications: {
        discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
    },
};

export function getSlippageForSymbol(symbol: string): number {
    const cleanSym = symbol.split(':')[0].toUpperCase();
    const isCore = config.watchlist.pinnedCorePairs.some(p => p.split(':')[0].toUpperCase() === cleanSym);
    return isCore ? config.exchange.slippage : config.exchange.satelliteSlippage;
}

export type AppConfig = typeof config;
export default config;
