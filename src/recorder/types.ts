export interface ContractSnapshot {
    snapshotTimestamp: number;
    symbol: string;
    baseCoin: string;
    quoteCoin: string;
    status: string;
    contractType: string;
    launchTime: number;
    deliveryTime: number;
    tickSize: number;
    minOrderQty: number;
    maxOrderQty: number;
    qtyStep: number;
    fundingInterval: number;
    rawJson?: string;
}

export type ListingEventType = 'LISTING' | 'DELISTING' | 'STATUS_CHANGE';

export interface ListingEvent {
    id?: number;
    detectedAt: number;
    symbol: string;
    eventType: ListingEventType;
    prevStatus: string | null;
    newStatus: string | null;
    launchTime: number | null;
    details: string;
}

export interface Kline1m {
    symbol: string;
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    turnover: number;
}

export interface FundingRateRecord {
    symbol: string;
    fundingRateTimestamp: number;
    fundingRate: number;
    recordedAt: number;
    isBackfilled?: boolean;
}

export interface OpenInterestRecord {
    symbol: string;
    timestamp: number;
    openInterest: number;
    openInterestValue: number;
    recordedAt: number;
    isBackfilled?: boolean;
}

export interface LiquidationRecord {
    id?: number;
    symbol: string;
    side: 'Buy' | 'Sell';
    price: number;
    size: number;
    timestamp: number;
    recordedAt: number;
}

export interface OrderbookLevel {
    price: number;
    size: number;
}

export interface OrderbookSnapshot {
    id?: number;
    symbol: string;
    timestamp: number;
    depth: number;
    bids: [number, number][]; // [price, size]
    asks: [number, number][]; // [price, size]
    bestBid: number;
    bestAsk: number;
    spread: number;
    midPrice: number;
    recordedAt: number;
}

export interface DataGap {
    id?: number;
    symbol: string;
    dataType: 'kline_1m' | 'funding' | 'open_interest' | 'orderbook' | 'streams_lost' | 'network_outage' | 'ws_disconnect';
    gapStart: number;
    gapEnd: number;
    missingCount: number;
    detectedAt: number;
    resolvedAt?: number | null;
    cause?: string;
}

export interface RecorderHeartbeat {
    timestamp: number;
    activeSymbolsCount: number;
    status: 'HEALTHY' | 'STALE' | 'RECONNECTING' | 'DEGRADED';
    lastDataTimestamp: number;
    details: string;
}

export interface DataEpoch {
    epochId: string;
    startedAt: number;
    description: string;
}

export type ShardConnectionStatus = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';

export interface ShardInfo {
    shardId: number;
    status: ShardConnectionStatus;
    lastMessageTime: number;
    topicsCount: number;
}

export interface DataQualityReport {
    generatedAt: number;
    evaluationWindowMs: number;
    windowStart: number;
    windowEnd: number;
    epoch?: DataEpoch | null;
    storage: {
        dbPath: string;
        dbSizeBytes: number;
        dbSizeMb: number;
    };
    counts: {
        contractSnapshots: number;
        uniqueContractsRecorded: number;
        listingEvents: number;
        klines1m: number;
        fundingRates: number;
        openInterestSnapshots: number;
        liquidations: number;
        orderbookSnapshots: number;
        heartbeats: number;
    };
    newListings: ListingEvent[];
    delistings: ListingEvent[];
    gaps: {
        totalGapsDetected: number;
        unresolvedGaps: number;
        unrecoverableStreamGaps: number;
        openRecoverableGaps: number;
        resolvedGaps: number;
        gapsByDataType: Record<string, number>;
        largestGapMinutes: number;
    };
    restMetrics?: {
        totalRequestsLastHour: number;
        errors10006LastHour: number;
        errors429LastHour: number;
        peak5sRequests: number;
        avg5sRequests?: number;
        windowDistribution?: Array<{
            window5s: number;
            iso: string;
            total: number;
            errors10006: number;
            errors429: number;
            byEndpoint: Record<string, number>;
        }>;
    };
    freshness: {
        lastKlineTimestamp: number | null;
        lastTickerTimestamp: number | null;
        lastOrderbookTimestamp: number | null;
        lastLiquidationTimestamp: number | null;
        isStale: boolean;
        staleReason?: string;
    };
    diskUsageProjection: {
        dailyEstimatedMb: number;
        monthlyEstimatedGb: number;
        annualEstimatedGb: number;
    };
    recorderCompleteness: {
        recordingSpanMinutes: number;
        recordingSpanText: string;
        totalExpectedBars: number;
        totalStoredBars: number;
        coverage24hPct: number;
        coverageSinceFirstBarPct: number;
        coverage24hDescription: string;
        coverageSinceFirstBarDescription: string;
        overallCoveragePct: number;
        recordedTimeCoveragePct: number;
        totalTimeCoveragePct: number;
        symbolsAbove98Count: number;
        symbolsBelow98Count: number;
        symbolsBelow98: Array<{
            symbol: string;
            firstBarTimestamp: number | null;
            firstBarIso: string;
            storedBars: number;
            expectedBars: number;
            coveragePct: number;
            verification: string;
        }>;
        exchangeAuditSample: Array<{
            symbol: string;
            storedBars: number;
            exchangeAvailableBars: number;
            status: 'ZERO_VOLUME_CONFIRMED' | 'RECORDER_GAP' | 'OFFLINE';
            details: string;
        }>;
    };
    listingStats: {
        listingsLast7Days: number;
        listingsTotalSinceStart: number;
        listingsEligibleForHA: number;
        recentListings: Array<{
            symbol: string;
            detectedAt: number;
            launchTime: number | null;
            depthCovered: boolean;
        }>;
    };
    liquidationStats: {
        liquidationsInWindow: number;
        liquidationsPerHour: number;
    };
    gapDetails: Array<{
        id?: number;
        symbol: string;
        dataType: string;
        gapStart: number;
        gapEnd: number;
        durationMinutes: number;
        detectedAt: number;
        resolvedAt?: number | null;
    }>;
}

export type AssetClass = 'CRYPTO' | 'STOCK' | 'ETF' | 'COMMODITY' | 'FOREX' | 'UNKNOWN';

export interface ContractClassification {
    symbol: string;
    assetClass: AssetClass;
    isCrypto: boolean;
    isUnknown: boolean;
    symbolTypeRaw: string;
    reason: string;
}

/**
 * Classifies whether a Bybit linear perpetual contract is native crypto vs traditional asset perp
 * (equity/stock, ETF, commodity, or forex), or an UNKNOWN type.
 * 
 * Strict Classification Rule:
 * 1. Checks Bybit symbolType in rawJson:
 *    - 'stock', 'ETF', 'commodity', 'forex' -> Non-crypto asset classes
 *    - '' (standard) or 'innovation' -> CRYPTO
 * 2. Checks symbol suffixes and patterns:
 *    - ends with 'STOCKUSDT' -> STOCK
 *    - known traditional equity perps (ABBV, AGPU, TTMI, BA, CRML, etc.) -> STOCK
 *    - known commodities (XAU, XAG, etc.) -> COMMODITY
 *    - known ETFs (SPY, QQQ, etc.) -> ETF
 * 3. FALLBACK SAFETY RULE:
 *    - Any unrecognized symbolType or missing/unparseable raw metadata is classified as 'UNKNOWN'.
 *    - 'UNKNOWN' is NEVER silently treated as crypto. It is strictly excluded from Hypothesis H-A.
 */
export function classifyContract(
    symbolOrObj: string | { symbol: string; symbolType?: string; rawJson?: string },
    rawJson?: string | null
): ContractClassification {
    let symbol: string;
    let raw: any = rawJson;

    if (typeof symbolOrObj === 'object' && symbolOrObj !== null) {
        symbol = symbolOrObj.symbol || '';
        if (symbolOrObj.symbolType !== undefined) {
            raw = { symbolType: symbolOrObj.symbolType };
        } else if (symbolOrObj.rawJson) {
            raw = symbolOrObj.rawJson;
        }
    } else {
        symbol = String(symbolOrObj || '');
    }

    let symbolTypeRaw = '';
    let parsedJson: any = null;
    if (raw) {
        try {
            parsedJson = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (parsedJson && typeof parsedJson.symbolType === 'string') {
                symbolTypeRaw = parsedJson.symbolType;
            }
        } catch {
            // parse error
        }
    }

    const st = symbolTypeRaw.trim().toLowerCase();

    // 1. Explicit Non-Crypto Types
    if (st === 'stock' || symbol.endsWith('STOCKUSDT')) {
        return { symbol, assetClass: 'STOCK', isCrypto: false, isUnknown: false, symbolTypeRaw, reason: 'Bybit equity perpetual' };
    }
    if (st === 'etf') {
        return { symbol, assetClass: 'ETF', isCrypto: false, isUnknown: false, symbolTypeRaw, reason: 'Bybit ETF perpetual' };
    }
    if (st === 'commodity') {
        return { symbol, assetClass: 'COMMODITY', isCrypto: false, isUnknown: false, symbolTypeRaw, reason: 'Bybit commodity perpetual' };
    }
    if (st === 'forex') {
        return { symbol, assetClass: 'FOREX', isCrypto: false, isUnknown: false, symbolTypeRaw, reason: 'Bybit forex perpetual' };
    }

    // 2. Pattern-based non-crypto verification
    const nonCryptoKnown = new Set([
        'ABBVUSDT', 'AGPUUSDT', 'TTMIUSDT', 'BAUSDT', 'CRMLUSDT',
        'AXPUSDT', 'IBKRUSDT', 'LMTUSDT', 'PGUSDT', 'MXLUSDT',
        'XAUUSDT', 'XAGUSDT', 'SPYUSDT', 'QQQUSDT', 'NVDAUSDT',
        'TSLAUSDT', 'AAPLUSDT', 'MDTSTOCKUSDT', 'CSTOCKUSDT',
        '4STOCKUSDT'
    ]);
    if (nonCryptoKnown.has(symbol)) {
        return { symbol, assetClass: 'STOCK', isCrypto: false, isUnknown: false, symbolTypeRaw, reason: 'Matched known traditional equity ticker' };
    }

    // 3. Explicit Verified Crypto Types
    if (st === '' || st === 'innovation') {
        // If raw JSON was present and confirmed
        return {
            symbol,
            assetClass: 'CRYPTO',
            isCrypto: true,
            isUnknown: false,
            symbolTypeRaw,
            reason: st === 'innovation' ? 'Bybit innovation crypto linear contract' : 'Bybit standard crypto linear contract'
        };
    }

    // 4. UNKNOWN: Unrecognized symbolType or unparseable metadata.
    // Strictly NOT treated as crypto. Excluded from H-A.
    return {
        symbol,
        assetClass: 'UNKNOWN',
        isCrypto: false,
        isUnknown: true,
        symbolTypeRaw,
        reason: `Unrecognized or missing symbolType "${symbolTypeRaw}"; flagged UNKNOWN and excluded from H-A`
    };
}

export function isCryptoPerp(
    symbolOrObj: string | { symbol: string; symbolType?: string; rawJson?: string },
    rawJson?: string | null
): boolean {
    return classifyContract(symbolOrObj, rawJson).isCrypto;
}

