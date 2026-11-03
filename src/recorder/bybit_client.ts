import dns from 'dns';
import { Agent } from 'undici';
import { ContractSnapshot, Kline1m, FundingRateRecord, OpenInterestRecord, OrderbookSnapshot } from './types';
import { createLogger } from '../utils/logger';
import { globalRestRateLimiter } from './rate_limiter';

const log = createLogger('bybit-client');

export interface BybitClientOptions {
    primaryHost?: string;
    fallbackHost?: string;
    requestTimeoutMs?: number;
    rateLimitDelayMs?: number;
    maxRetries?: number;
    banDurationMs?: number;
}

export class BybitPublicClient {
    private primaryHost: string;
    private fallbackHost: string;
    private requestTimeoutMs: number;
    private rateLimitDelayMs: number;
    private maxRetries: number;
    private lastRequestTime: number = 0;
    private agent: Agent;
    private dnsResolver: dns.promises.Resolver;

    // Static IP Ban Circuit Breaker shared by ALL instances
    public static banDurationMs: number = 30 * 60 * 1000; // 30 minutes default
    private static banLockoutUntil: number = 0;
    private static isProbing: boolean = false;
    private static probePromise: Promise<boolean> | null = null;

    public onDnsFailure?: (hostname: string, err: any) => void;
    public onBanDetected?: (lockoutUntil: number, cause: string) => void;
    public onRequestMetric?: (timestamp: number, endpoint: string, isSuccess: boolean, errorCode?: number) => void;

    constructor(options: BybitClientOptions = {}) {
        this.primaryHost = options.primaryHost || process.env.BYBIT_PRIMARY_REST || 'https://api.bytick.com';
        this.fallbackHost = options.fallbackHost || process.env.BYBIT_FALLBACK_REST || 'https://api.bybit.com';
        this.requestTimeoutMs = options.requestTimeoutMs || 10000;
        this.rateLimitDelayMs = options.rateLimitDelayMs || 50;
        this.maxRetries = options.maxRetries || 3;
        if (options.banDurationMs) {
            BybitPublicClient.banDurationMs = options.banDurationMs;
        }

        // Initialize public DNS fallback resolver (Google 8.8.8.8, Cloudflare 1.1.1.1, Google 8.8.4.4)
        this.dnsResolver = new dns.promises.Resolver();
        this.dnsResolver.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

        // Configure Undici Agent with public DNS fallback for read-only public requests
        this.agent = new Agent({
            connect: {
                lookup: (hostname: string, opts: any, callback: (err: any, address?: any, family?: number) => void) => {
                    const cb = typeof opts === 'function' ? opts : callback;
                    const lookupOpts = typeof opts === 'function' ? {} : opts;

                    dns.lookup(hostname, lookupOpts, (err, address, family) => {
                        if (!err) {
                            return cb(null, address, family);
                        }

                        // System DNS failed: trigger callback & attempt public DNS fallback
                        if (this.onDnsFailure) {
                            this.onDnsFailure(hostname, err);
                        }
                        log.warn({ hostname, err: err?.message, code: err?.code }, 'System DNS resolution failed; invoking public DNS fallback (8.8.8.8 / 1.1.1.1)');

                        this.dnsResolver.resolve4(hostname).then(ips => {
                            if (!ips || ips.length === 0) {
                                return cb(err);
                            }
                            log.info({ hostname, fallbackIp: ips[0] }, 'Public DNS fallback successfully resolved hostname');
                            if (lookupOpts && lookupOpts.all) {
                                cb(null, ips.map(ip => ({ address: ip, family: 4 })));
                            } else {
                                cb(null, ips[0], 4);
                            }
                        }).catch(dnsErr => {
                            log.error({ hostname, dnsErr: dnsErr?.message }, 'Public DNS fallback also failed to resolve hostname');
                            cb(err);
                        });
                    });
                }
            }
        });
    }

    public isBanActive(): boolean {
        return Date.now() < BybitPublicClient.banLockoutUntil;
    }

    public getBanLockoutUntil(): number {
        return BybitPublicClient.banLockoutUntil;
    }

    public setBanLockout(lockoutUntil: number): void {
        BybitPublicClient.banLockoutUntil = lockoutUntil;
    }

    public clearBanLockout(): void {
        BybitPublicClient.banLockoutUntil = 0;
    }

    /**
     * When ban lockout expires, dispatches exactly ONE single probe request to /v5/market/time.
     * All concurrent requests wait on this probe.
     */
    public async probeBanRecovery(): Promise<boolean> {
        if (BybitPublicClient.isProbing && BybitPublicClient.probePromise) {
            return BybitPublicClient.probePromise;
        }

        BybitPublicClient.isProbing = true;
        BybitPublicClient.probePromise = (async () => {
            log.warn('HTTP 403 ban lockout period expired. Sending ONE single probe request to /v5/market/time...');
            try {
                await globalRestRateLimiter.acquire();
                const probeUrl = `${this.primaryHost}/v5/market/time`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

                const response = await fetch(probeUrl, {
                    method: 'GET',
                    signal: controller.signal,
                    dispatcher: this.agent,
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'BybitMarketRecorder/1.0'
                    }
                } as any);
                clearTimeout(timeoutId);

                if (response.status === 403) {
                    const newLockout = Date.now() + BybitPublicClient.banDurationMs;
                    BybitPublicClient.banLockoutUntil = newLockout;
                    log.fatal({ newLockout: new Date(newLockout).toISOString() }, '[BAN] Probe received HTTP 403! IP ban is STILL ACTIVE. Pausing ALL REST for another 30 minutes.');
                    if (this.onBanDetected) {
                        try { this.onBanDetected(newLockout, 'HTTP_403_BAN'); } catch (e) {}
                    }
                    return false;
                }

                if (!response.ok) {
                    throw new Error(`Probe HTTP ${response.status}: ${response.statusText}`);
                }

                const data = await response.json();
                if (data.retCode !== 0) {
                    throw new Error(`Probe API Error [${data.retCode}]: ${data.retMsg}`);
                }

                log.info({ serverTime: data.result?.timeSecond }, '[OK] Probe to /v5/market/time SUCCEEDED! IP ban confirmed lifted. Circuit breaker reset.');
                BybitPublicClient.banLockoutUntil = 0;
                return true;
            } catch (err: any) {
                log.error({ err: err?.message || err }, 'Probe failed or ban still active');
                return false;
            } finally {
                BybitPublicClient.isProbing = false;
                BybitPublicClient.probePromise = null;
            }
        })();

        return BybitPublicClient.probePromise;
    }

    private async rateLimitWait(): Promise<void> {
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.rateLimitDelayMs) {
            await new Promise(res => setTimeout(res, this.rateLimitDelayMs - elapsed));
        }
        this.lastRequestTime = Date.now();
    }

    public async fetchJson(endpoint: string, params: Record<string, string | number> = {}): Promise<any> {
        const now = Date.now();

        // 1. Check IP Ban Circuit Breaker
        if (BybitPublicClient.banLockoutUntil > 0) {
            if (now < BybitPublicClient.banLockoutUntil) {
                throw new Error(`HTTP_403_BAN: All Bybit REST calls are paused due to IP ban circuit breaker until ${new Date(BybitPublicClient.banLockoutUntil).toISOString()}`);
            }
            // Lockout duration expired: perform probe
            const unbanned = await this.probeBanRecovery();
            if (!unbanned) {
                throw new Error(`HTTP_403_BAN: Ban recovery probe failed; REST calls remain paused until ${new Date(BybitPublicClient.banLockoutUntil).toISOString()}`);
            }
        }

        // 2. Token Bucket Rate Limiting (Global shared limiter: 20 req/s, burst <= 40)
        await globalRestRateLimiter.acquire();
        await this.rateLimitWait();

        const query = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null && v !== '') {
                query.append(k, String(v));
            }
        }
        const queryString = query.toString() ? `?${query.toString()}` : '';

        // Alternate hosts across attempts
        const hosts = [this.primaryHost, this.fallbackHost];
        let lastError: any = null;

        for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
            for (const host of hosts) {
                const url = `${host}${endpoint}${queryString}`;
                const reqTs = Date.now();
                globalRestRateLimiter.recordRequest(endpoint, reqTs);
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

                    const response = await fetch(url, {
                        method: 'GET',
                        signal: controller.signal,
                        dispatcher: this.agent,
                        headers: {
                            'Accept': 'application/json',
                            'User-Agent': 'BybitMarketRecorder/1.0'
                        }
                    } as any);
                    clearTimeout(timeoutId);

                    if (!response.ok) {
                        // CRITICAL: 403 treated as an IP ban.
                        // Strictly NO retries, NO host switching, trip circuit breaker immediately.
                        if (response.status === 403) {
                            const lockoutUntil = Date.now() + BybitPublicClient.banDurationMs;
                            BybitPublicClient.banLockoutUntil = lockoutUntil;
                            log.fatal({
                                host,
                                endpoint,
                                status: 403,
                                lockoutUntil: new Date(lockoutUntil).toISOString()
                            }, '[BAN] HTTP 403 Forbidden encountered from Bybit REST! Treating as IP ban. Pausing ALL REST for 30+ minutes. NO retries, NO host switching.');

                            if (this.onBanDetected) {
                                try {
                                    this.onBanDetected(lockoutUntil, 'HTTP_403_BAN');
                                } catch (e) {
                                    log.error({ err: e }, 'Failed to invoke onBanDetected callback');
                                }
                            }

                            throw new Error(`HTTP 403 Forbidden: Bybit IP ban detected. Circuit breaker paused all REST until ${new Date(lockoutUntil).toISOString()}`);
                        }

                        if (response.status === 429) {
                            // Rate limit hit: wait 1.5s and retry next host
                            globalRestRateLimiter.recordRequest(endpoint, reqTs, 429);
                            if (this.onRequestMetric) this.onRequestMetric(reqTs, endpoint, false, 429);
                            log.warn({ host, endpoint, status: 429 }, 'Rate limit 429 encountered, backing off 1500ms');
                            await new Promise(r => setTimeout(r, 1500));
                        }
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }

                    const data = await response.json();
                    if (data.retCode !== 0) {
                        // Bybit 10006: Too many visits! The request is throttled.
                        // CRITICAL: Slow down globally with exponential backoff and DO NOT switch hosts!
                        if (data.retCode === 10006 || (data.retMsg && (data.retMsg.includes('Too many visits') || data.retMsg.includes('throttled')))) {
                            globalRestRateLimiter.recordRequest(endpoint, reqTs, 10006);
                            if (this.onRequestMetric) this.onRequestMetric(reqTs, endpoint, false, 10006);
                            const backoffMs = Math.min(30000, 3000 * Math.pow(2, attempt - 1));
                            globalRestRateLimiter.triggerBackoff(backoffMs);
                            log.warn({
                                host,
                                endpoint,
                                attempt,
                                retCode: data.retCode,
                                retMsg: data.retMsg,
                                backoffMs
                            }, '[WARN] Bybit Error 10006 (Throttled)! Triggered global backoff; retrying on SAME host without switching.');
                            await new Promise(r => setTimeout(r, backoffMs));
                            lastError = new Error(`Bybit API Error [10006]: ${data.retMsg}`);
                            // Retry on SAME host (do not switch to fallback)
                            break;
                        }
                        throw new Error(`Bybit API Error [${data.retCode}]: ${data.retMsg}`);
                    }

                    if (this.onRequestMetric) {
                        this.onRequestMetric(reqTs, endpoint, true);
                    }
                    return data.result;
                } catch (err: any) {
                    // If this is a 403 ban, stop immediately: do NOT try fallback host or retry!
                    if (this.isBanActive() || (err?.message && err.message.includes('HTTP 403'))) {
                        throw err;
                    }

                    const causeStr = err?.cause ? ` (cause: ${err.cause.code || err.cause.message || err.cause})` : '';
                    lastError = new Error(`${err?.message || err}${causeStr}`);

                    // If error is 10006, do NOT switch host!
                    if (lastError.message.includes('10006') || lastError.message.includes('Too many visits')) {
                        break; // exit hosts loop to stay on primary host
                    }

                    log.warn({
                        host,
                        endpoint,
                        attempt,
                        maxRetries: this.maxRetries,
                        err: lastError.message
                    }, 'Bybit REST request attempt failed; switching host / retrying with backoff');

                    // Promote working host when failure occurs
                    if (host === this.primaryHost) {
                        this.primaryHost = this.fallbackHost;
                        this.fallbackHost = host;
                    }
                }
            }

            // Exponential backoff between failed retry cycles
            if (attempt < this.maxRetries) {
                const backoffMs = attempt * 400;
                await new Promise(r => setTimeout(r, backoffMs));
            }
        }

        throw new Error(`Failed to fetch ${endpoint} from all hosts after ${this.maxRetries} attempts: ${lastError?.message || lastError}`);
    }

    /**
     * Snapshot all linear contracts via GET /v5/market/instruments-info?category=linear
     * Handles cursor pagination until all pages are retrieved.
     */
    public async fetchAllLinearContracts(snapshotTimestamp: number = Date.now()): Promise<ContractSnapshot[]> {
        const contracts: ContractSnapshot[] = [];
        let cursor = '';

        while (true) {
            const params: Record<string, string | number> = {
                category: 'linear',
                limit: 100
            };
            if (cursor) params.cursor = cursor;

            const result = await this.fetchJson('/v5/market/instruments-info', params);
            if (!result || !Array.isArray(result.list)) break;

            for (const item of result.list) {
                if (item.symbol && item.symbol.endsWith('USDT') && item.contractType === 'LinearPerpetual') {
                    const priceFilter = item.priceFilter || {};
                    const lotSizeFilter = item.lotSizeFilter || {};

                    contracts.push({
                        symbol: item.symbol,
                        status: item.status || 'Trading',
                        baseCoin: item.baseCoin || '',
                        quoteCoin: item.quoteCoin || '',
                        contractType: item.contractType || 'LinearPerpetual',
                        tickSize: parseFloat(priceFilter.tickSize || '0.01'),
                        minOrderQty: parseFloat(lotSizeFilter.minOrderQty || '0.001'),
                        maxOrderQty: parseFloat(lotSizeFilter.maxOrderQty || '1000000'),
                        qtyStep: parseFloat(lotSizeFilter.qtyStep || '0.001'),
                        fundingInterval: Number(item.fundingInterval || 480),
                        launchTime: Number(item.launchTime || 0),
                        deliveryTime: Number(item.deliveryTime || 0),
                        snapshotTimestamp,
                        rawJson: JSON.stringify(item)
                    });
                }
            }

            cursor = result.nextPageCursor;
            if (!cursor) break;
        }

        return contracts;
    }

    /**
     * Fetch all linear tickers in a single call via GET /v5/market/tickers?category=linear
     * Extracts funding rates and open interest across all active contracts.
     */
    public async fetchAllTickers(recordedAt: number = Date.now()): Promise<{
        fundingRates: FundingRateRecord[];
        openInterests: OpenInterestRecord[];
    }> {
        const result = await this.fetchJson('/v5/market/tickers', { category: 'linear' });
        const fundingRates: FundingRateRecord[] = [];
        const openInterests: OpenInterestRecord[] = [];

        if (result && Array.isArray(result.list)) {
            for (const item of result.list) {
                const symbol = item.symbol;
                if (!symbol || !symbol.endsWith('USDT')) continue;

                // Funding Rate
                const fundingRate = parseFloat(item.fundingRate || '0');
                const nextFundingTime = Number(item.nextFundingTime || recordedAt);
                fundingRates.push({
                    symbol,
                    fundingRateTimestamp: nextFundingTime,
                    fundingRate,
                    recordedAt,
                    isBackfilled: false
                });

                // Open Interest
                const openInterest = parseFloat(item.openInterest || '0');
                const openInterestValue = parseFloat(item.openInterestValue || '0');
                openInterests.push({
                    symbol,
                    timestamp: recordedAt,
                    openInterest,
                    openInterestValue,
                    recordedAt,
                    isBackfilled: false
                });
            }
        }

        return { fundingRates, openInterests };
    }

    /**
     * Fetch 1-minute klines for a given contract via GET /v5/market/kline
     * Supports Bybit V5 max limit of 1000 candles per call.
     */
    public async fetch1mKlines(
        symbol: string,
        limit: number = 1000,
        start?: number,
        end?: number
    ): Promise<Kline1m[]> {
        const params: Record<string, string | number> = {
            category: 'linear',
            symbol,
            interval: '1',
            limit: Math.min(1000, Math.max(1, limit))
        };
        if (start) params.start = start;
        if (end) params.end = end;

        const result = await this.fetchJson('/v5/market/kline', params);
        const klines: Kline1m[] = [];
        const now = Date.now();

        if (result && Array.isArray(result.list)) {
            for (const row of result.list) {
                // Bybit format: [startTime, openPrice, highPrice, lowPrice, closePrice, volume, turnover]
                const timestamp = Number(row[0]);
                // Reject currently forming candles (incomplete volume and price range)
                if (timestamp + 60000 > now) {
                    continue;
                }
                const open = parseFloat(row[1]);
                const high = parseFloat(row[2]);
                const low = parseFloat(row[3]);
                const close = parseFloat(row[4]);
                const volume = parseFloat(row[5]);
                const turnover = parseFloat(row[6]);

                klines.push({
                    symbol,
                    timestamp,
                    open,
                    high,
                    low,
                    close,
                    volume,
                    turnover
                });
            }
        }

        // Return sorted chronologically ascending (oldest to newest)
        return klines.sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Fetch historical funding rates via GET /v5/market/funding/history
     */
    public async fetchHistoricalFundingRates(
        symbol: string,
        limit: number = 200,
        startTime?: number,
        endTime?: number
    ): Promise<FundingRateRecord[]> {
        const params: Record<string, string | number> = {
            category: 'linear',
            symbol,
            limit: Math.min(200, Math.max(1, limit))
        };
        if (startTime) params.startTime = startTime;
        if (endTime) params.endTime = endTime;

        const result = await this.fetchJson('/v5/market/funding/history', params);
        const records: FundingRateRecord[] = [];
        const now = Date.now();

        if (result && Array.isArray(result.list)) {
            for (const item of result.list) {
                records.push({
                    symbol: item.symbol || symbol,
                    fundingRateTimestamp: Number(item.fundingRateTimestamp),
                    fundingRate: parseFloat(item.fundingRate || '0'),
                    recordedAt: now,
                    isBackfilled: true
                });
            }
        }

        return records.sort((a, b) => a.fundingRateTimestamp - b.fundingRateTimestamp);
    }

    /**
     * Fetch historical open interest via GET /v5/market/open-interest
     * intervalTime: '5min' | '15min' | '30min' | '1h' | '4h' | '1d'
     */
    public async fetchHistoricalOpenInterest(
        symbol: string,
        intervalTime: string = '5min',
        limit: number = 200,
        startTime?: number,
        endTime?: number
    ): Promise<OpenInterestRecord[]> {
        const params: Record<string, string | number> = {
            category: 'linear',
            symbol,
            intervalTime,
            limit: Math.min(200, Math.max(1, limit))
        };
        if (startTime) params.startTime = startTime;
        if (endTime) params.endTime = endTime;

        const result = await this.fetchJson('/v5/market/open-interest', params);
        const records: OpenInterestRecord[] = [];
        const now = Date.now();

        if (result && Array.isArray(result.list)) {
            for (const item of result.list) {
                const ts = Number(item.timestamp);
                const oi = parseFloat(item.openInterest || '0');
                records.push({
                    symbol,
                    timestamp: ts,
                    openInterest: oi,
                    openInterestValue: 0, // Computed or estimated if not provided in history
                    recordedAt: now,
                    isBackfilled: true
                });
            }
        }

        return records.sort((a, b) => a.timestamp - b.timestamp);
    }

    /**
     * Fetch order-book snapshot (top 10-25 levels) via GET /v5/market/orderbook
     */
    public async fetchOrderbookSnapshot(
        symbol: string,
        depth: number = 25,
        recordedAt: number = Date.now()
    ): Promise<OrderbookSnapshot | null> {
        const result = await this.fetchJson('/v5/market/orderbook', {
            category: 'linear',
            symbol,
            limit: depth
        });

        if (!result || !Array.isArray(result.b) || !Array.isArray(result.a)) {
            return null;
        }

        const rawBids = result.b.slice(0, depth);
        const rawAsks = result.a.slice(0, depth);

        const bids: [number, number][] = rawBids.map((b: [string, string]) => [parseFloat(b[0]), parseFloat(b[1])]);
        const asks: [number, number][] = rawAsks.map((a: [string, string]) => [parseFloat(a[0]), parseFloat(a[1])]);

        if (bids.length === 0 || asks.length === 0) return null;

        const bestBid = bids[0][0];
        const bestAsk = asks[0][0];
        const spread = parseFloat((bestAsk - bestBid).toFixed(8));
        const midPrice = parseFloat(((bestBid + bestAsk) / 2).toFixed(8));
        const timestamp = Number(result.ts || recordedAt);

        return {
            symbol,
            timestamp,
            depth,
            bids,
            asks,
            bestBid,
            bestAsk,
            spread,
            midPrice,
            recordedAt
        };
    }
}
