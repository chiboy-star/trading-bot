import { LiquidationRecord, OrderbookSnapshot, ShardConnectionStatus, ShardInfo } from './types';
import { createLogger } from '../utils/logger';

const log = createLogger('recorder-ws');

export interface WSClientOptions {
    primaryUrl?: string;
    fallbackUrl?: string;
    pingIntervalMs?: number;
    maxBackoffMs?: number;
    orderbookSampleIntervalMs?: number;
    shardCapacity?: number;
}

export interface LocalBook {
    symbol: string;
    bids: Map<number, number>; // price -> size
    asks: Map<number, number>; // price -> size
    lastUpdateId: number;
    lastSeq?: number;
    initialized: boolean;
}

export class SingleWSShard {
    public readonly shardId: number;
    private primaryUrl: string;
    private fallbackUrl: string;
    private activeUrl: string;
    private pingIntervalMs: number;
    private maxBackoffMs: number;
    private backoffMs: number = 1000;
    private isRunning: boolean = false;
    private ws: WebSocket | null = null;
    private pingTimer: any = null;
    private reconnectTimeout: any = null;
    private lastMsgTime: number = 0;
    private hasToggledHostForFailure: boolean = false;

    public jsonParseErrors: number = 0;
    public messageHandlingErrors: number = 0;
    public status: ShardConnectionStatus = 'DISCONNECTED';
    public topics: Set<string> = new Set();
    public onMessage?: (msg: any) => void;
    public onStatusChange?: (shardId: number, status: ShardConnectionStatus) => void;

    constructor(
        shardId: number,
        primaryUrl: string,
        fallbackUrl: string,
        pingIntervalMs: number = 20000,
        maxBackoffMs: number = 60000
    ) {
        this.shardId = shardId;
        this.primaryUrl = primaryUrl;
        this.fallbackUrl = fallbackUrl;
        this.activeUrl = primaryUrl;
        this.pingIntervalMs = pingIntervalMs;
        this.maxBackoffMs = maxBackoffMs;
    }

    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.connect();
    }

    public stop(): void {
        this.isRunning = false;
        this.clearTimers(true);
        if (this.ws) {
            const old = this.ws;
            this.ws = null;
            try {
                old.onopen = null as any;
                old.onmessage = null as any;
                old.onclose = null as any;
                old.onerror = null as any;
                old.close();
                if (typeof (old as any).terminate === 'function') (old as any).terminate();
            } catch {}
        }
        this.status = 'DISCONNECTED';
        if (this.onStatusChange) this.onStatusChange(this.shardId, 'DISCONNECTED');
    }

    private clearTimers(includeReconnect: boolean = true): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (includeReconnect && this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
    }

    private connect(): void {
        if (!this.isRunning) return;
        this.clearTimers(true);
        this.status = 'CONNECTING';

        try {
            const socket = new WebSocket(this.activeUrl);
            this.ws = socket;

            socket.addEventListener('open', () => {
                if (socket !== this.ws) return;
                this.status = 'CONNECTED';
                this.lastMsgTime = Date.now();
                // NOTE: backoff is NOT reset here; it resets only when a message is received
                if (this.onStatusChange) this.onStatusChange(this.shardId, 'CONNECTED');
                this.startPingKeepalive();
                this.resubscribe();
            });

            socket.addEventListener('message', (event) => {
                if (socket !== this.ws) return;
                this.lastMsgTime = Date.now();
                // Reset backoff and host toggle flag upon receiving data
                this.backoffMs = 1000;
                this.hasToggledHostForFailure = false;

                let msg: any;
                try {
                    msg = JSON.parse(event.data);
                } catch (err: any) {
                    this.jsonParseErrors++;
                    if (this.jsonParseErrors <= 5 || this.jsonParseErrors % 100 === 0) {
                        log.error({
                            shardId: this.shardId,
                            error: err?.message,
                            parseErrorsCount: this.jsonParseErrors
                        }, 'WebSocket message JSON parse error');
                    }
                    return;
                }

                // Parse subscribe responses loudly if failed
                if (msg && msg.op === 'subscribe') {
                    if (msg.success === false) {
                        log.error({
                            shardId: this.shardId,
                            ret_msg: msg.ret_msg,
                            conn_id: msg.conn_id,
                            req_id: msg.req_id
                        }, '[WS_SUB_FAIL] WebSocket subscription failed on Bybit exchange');
                    }
                    return;
                }

                if (this.onMessage) {
                    try {
                        this.onMessage(msg);
                    } catch (err: any) {
                        this.messageHandlingErrors++;
                        log.error({
                            shardId: this.shardId,
                            topic: msg?.topic,
                            err: err?.message || err,
                            handlingErrorsCount: this.messageHandlingErrors
                        }, 'WebSocket message processing exception');
                    }
                }
            });

            socket.addEventListener('close', () => {
                if (socket !== this.ws) return;
                this.scheduleReconnect('Socket closed');
            });

            socket.addEventListener('error', (err: any) => {
                if (socket !== this.ws) return;
                this.scheduleReconnect(`Socket error: ${err?.message || 'unknown'}`);
            });
        } catch (err: any) {
            this.scheduleReconnect(`Connect exception: ${err?.message || 'unknown'}`);
        }
    }

    public scheduleReconnect(reason: string): void {
        if (!this.isRunning) return;
        if (this.reconnectTimeout !== null) {
            // Idempotent: a reconnect timer is already pending
            return;
        }

        this.status = 'RECONNECTING';
        this.clearTimers(false);
        if (this.onStatusChange) this.onStatusChange(this.shardId, 'RECONNECTING');

        // Clean up socket
        if (this.ws) {
            const old = this.ws;
            this.ws = null;
            try {
                old.onopen = null as any;
                old.onmessage = null as any;
                old.onclose = null as any;
                old.onerror = null as any;
                old.close();
                if (typeof (old as any).terminate === 'function') (old as any).terminate();
            } catch {}
        }

        // Toggle host only once per failure sequence
        if (!this.hasToggledHostForFailure) {
            this.activeUrl = this.activeUrl === this.primaryUrl ? this.fallbackUrl : this.primaryUrl;
            this.hasToggledHostForFailure = true;
        }

        // Add ±25% jitter to backoff
        const jitter = 0.75 + Math.random() * 0.5;
        const delay = Math.round(this.backoffMs * jitter);
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);

        log.warn({ shardId: this.shardId, reason, delay, targetUrl: this.activeUrl }, 'WebSocket shard reconnection scheduled');
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectTimeout = null;
            this.connect();
        }, delay);
    }

    private startPingKeepalive(): void {
        this.pingTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            if (Date.now() - this.lastMsgTime > this.pingIntervalMs * 2) {
                log.warn({ shardId: this.shardId }, 'WebSocket keepalive timeout; reconnecting shard');
                this.ws.close();
                return;
            }
            try {
                this.ws.send(JSON.stringify({ op: 'ping' }));
            } catch {}
        }, this.pingIntervalMs);
    }

    public subscribe(newTopics: string[]): void {
        for (const t of newTopics) this.topics.add(t);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.sendBatch(newTopics);
        }
    }

    public resubscribeTopic(topic: string): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        try {
            this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }));
            this.ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
        } catch (err: any) {
            log.warn({ shardId: this.shardId, topic, err: err?.message }, 'Failed to resubscribe topic');
        }
    }

    private resubscribe(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const topicList = Array.from(this.topics);
        this.sendBatch(topicList);
    }

    private sendBatch(topicList: string[]): void {
        for (let i = 0; i < topicList.length; i += 10) {
            const batch = topicList.slice(i, i + 10);
            try {
                this.ws?.send(JSON.stringify({ op: 'subscribe', args: batch }));
            } catch {}
        }
    }

    public getLastMessageTime(): number {
        return this.lastMsgTime;
    }
}

export class BybitPublicWSClient {
    private primaryUrl: string;
    private fallbackUrl: string;
    private pingIntervalMs: number;
    private maxBackoffMs: number;
    private orderbookSampleIntervalMs: number;
    private shardCapacity: number;

    private shards: SingleWSShard[] = [];
    private isRunning: boolean = false;
    private lastSampledOrderbookTime: Map<string, number> = new Map();
    private liquidationCounts: Map<string, number> = new Map();
    private hourlyWindowStart: number = Date.now();

    // Stream freshness timestamps
    private lastLiquidationEventTime: number = 0;
    private lastOrderbookTime: number = 0;

    // Local maintained orderbooks per symbol
    private orderbooks: Map<string, LocalBook> = new Map();

    public onLiquidation?: (record: LiquidationRecord) => void;
    public onOrderbook?: (snapshot: OrderbookSnapshot) => void;
    public onStatus?: (status: 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'RECONNECTING', downShards?: number[]) => void;

    constructor(options: WSClientOptions = {}) {
        this.primaryUrl = options.primaryUrl || 'wss://stream.bybit.com/v5/public/linear';
        this.fallbackUrl = options.fallbackUrl || 'wss://stream.bytick.com/v5/public/linear';
        this.pingIntervalMs = options.pingIntervalMs || 20000;
        this.maxBackoffMs = options.maxBackoffMs || 60000;
        this.orderbookSampleIntervalMs = options.orderbookSampleIntervalMs || 10000;
        this.shardCapacity = options.shardCapacity || 100;
    }

    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        // Stagger initial shard starts by ~1s to prevent connection bursts
        this.shards.forEach((shard, idx) => {
            setTimeout(() => {
                if (this.isRunning) shard.start();
            }, idx * 1000);
        });
    }

    public stop(): void {
        this.isRunning = false;
        for (const shard of this.shards) {
            shard.stop();
        }
        if (this.onStatus) this.onStatus('DISCONNECTED');
    }

    public setTrackedSymbols(orderbookSymbols: string[], liquidationSymbols: string[]): void {
        for (const shard of this.shards) shard.stop();
        this.shards = [];
        this.orderbooks.clear();

        const depthTopics = orderbookSymbols.map(s => `orderbook.50.${s}`);
        const liqTopics = liquidationSymbols.map(s => `allLiquidation.${s}`);

        let currentShard = this.createShard(0);
        currentShard.subscribe(depthTopics);

        for (const topic of liqTopics) {
            if (currentShard.topics.size >= this.shardCapacity) {
                this.shards.push(currentShard);
                currentShard = this.createShard(this.shards.length);
            }
            currentShard.subscribe([topic]);
        }

        if (currentShard.topics.size > 0) {
            this.shards.push(currentShard);
        }

        if (this.isRunning) {
            this.shards.forEach((shard, idx) => {
                setTimeout(() => {
                    if (this.isRunning) shard.start();
                }, idx * 1000);
            });
        }

        log.info({
            totalLiquidationSymbols: liquidationSymbols.length,
            orderbookSymbols: orderbookSymbols.length,
            shardsCount: this.shards.length,
            topicsPerShardAvg: Math.round((liqTopics.length + depthTopics.length) / Math.max(this.shards.length, 1))
        }, 'Sharded WebSocket manager configured');
    }

    public addNewListing(symbol: string, isWithin72h: boolean = true): void {
        const liqTopic = `allLiquidation.${symbol}`;
        const obTopic = isWithin72h ? `orderbook.50.${symbol}` : null;

        let targetShard = this.shards.find(s => s.topics.size < this.shardCapacity);
        if (!targetShard) {
            targetShard = this.createShard(this.shards.length);
            this.shards.push(targetShard);
            if (this.isRunning) targetShard.start();
        }

        const topicsToAdd = [liqTopic];
        if (obTopic) topicsToAdd.push(obTopic);
        targetShard.subscribe(topicsToAdd);

        log.info({ symbol, shardId: targetShard.shardId }, 'New listing subscribed to WebSocket shard');
    }

    private createShard(shardId: number): SingleWSShard {
        const shard = new SingleWSShard(
            shardId,
            this.primaryUrl,
            this.fallbackUrl,
            this.pingIntervalMs,
            this.maxBackoffMs
        );

        shard.onMessage = (msg) => this.handleMessage(msg);
        shard.onStatusChange = (sId, status) => {
            log.info({ shardId: sId, status }, 'WS Shard connection status changed');
            this.emitAggregateStatus();
        };

        return shard;
    }

    private emitAggregateStatus(): void {
        if (!this.onStatus) return;
        const aggregate = this.getAggregateStatus();
        const downShards = this.getDownShards();
        this.onStatus(aggregate, downShards);
    }

    public getAggregateStatus(): 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED' | 'RECONNECTING' {
        if (this.shards.length === 0) return 'DISCONNECTED';
        const allDisconnected = this.shards.every(s => s.status === 'DISCONNECTED');
        if (allDisconnected) return 'DISCONNECTED';
        const connectedCount = this.shards.filter(s => s.status === 'CONNECTED').length;
        if (connectedCount === this.shards.length) return 'CONNECTED';
        return 'DEGRADED';
    }

    public getDownShards(): number[] {
        return this.shards.filter(s => s.status !== 'CONNECTED').map(s => s.shardId);
    }

    public getShardsStatus(): ShardInfo[] {
        return this.shards.map(s => ({
            shardId: s.shardId,
            status: s.status,
            lastMessageTime: s.getLastMessageTime(),
            topicsCount: s.topics.size
        }));
    }

    public getConnectedShardsCount(): number {
        return this.shards.filter(s => s.status === 'CONNECTED').length;
    }

    public getShardsCount(): number {
        return this.shards.length;
    }

    public resubscribeTopic(topic: string): void {
        for (const shard of this.shards) {
            if (shard.topics.has(topic)) {
                shard.resubscribeTopic(topic);
                break;
            }
        }
    }

    public handleMessage(msg: any): void {
        if (!msg || msg.ret_msg === 'pong' || msg.op === 'ping') return;
        const topic = msg.topic;
        if (!topic) return;

        // 1. LIQUIDATIONS
        if (topic.startsWith('allLiquidation.')) {
            const dataList = Array.isArray(msg.data) ? msg.data : [msg.data];
            const recordedAt = Date.now();
            this.lastLiquidationEventTime = recordedAt;

            for (const item of dataList) {
                if (!item || !item.s) continue;
                const sym = item.s;
                const count = (this.liquidationCounts.get(sym) || 0) + 1;
                this.liquidationCounts.set(sym, count);

                const record: LiquidationRecord = {
                    symbol: sym,
                    side: item.S === 'Buy' ? 'Buy' : 'Sell',
                    price: parseFloat(item.p || '0'),
                    size: parseFloat(item.v || '0'),
                    timestamp: Number(item.T || msg.ts || recordedAt),
                    recordedAt
                };
                if (this.onLiquidation) {
                    this.onLiquidation(record);
                }
            }
            return;
        }

        // 2. ORDERBOOK (Maintained local book with snapshot/delta handling)
        if (topic.startsWith('orderbook.')) {
            const symbol = msg.data?.s || topic.split('.').pop() || '';
            if (!symbol) return;

            const msgType = msg.type; // 'snapshot' | 'delta'
            const updateId = Number(msg.data?.u || 0);
            const seq = Number(msg.data?.seq || 0);

            let book = this.orderbooks.get(symbol);
            if (!book) {
                book = {
                    symbol,
                    bids: new Map<number, number>(),
                    asks: new Map<number, number>(),
                    lastUpdateId: 0,
                    initialized: false
                };
                this.orderbooks.set(symbol, book);
            }

            // A. Snapshot or initial load
            if (msgType === 'snapshot' || updateId === 1) {
                book.bids.clear();
                book.asks.clear();

                for (const [pStr, sStr] of (msg.data?.b || [])) {
                    const price = parseFloat(pStr);
                    const size = parseFloat(sStr);
                    if (size > 0) book.bids.set(price, size);
                }
                for (const [pStr, sStr] of (msg.data?.a || [])) {
                    const price = parseFloat(pStr);
                    const size = parseFloat(sStr);
                    if (size > 0) book.asks.set(price, size);
                }

                book.lastUpdateId = updateId;
                book.lastSeq = seq;
                book.initialized = true;
            }
            // B. Delta update
            else if (msgType === 'delta') {
                if (!book.initialized) {
                    log.warn({ symbol, topic }, 'Received orderbook delta before snapshot. Requesting resubscribe.');
                    this.resubscribeTopic(topic);
                    return;
                }

                // Check continuity: delta updateId must be >= book.lastUpdateId
                // A gap in sequence or negative spread indicates inconsistency
                if (book.lastUpdateId > 0 && updateId > 0 && updateId < book.lastUpdateId) {
                    log.warn({ symbol, currentUpdateId: book.lastUpdateId, receivedUpdateId: updateId }, 'Orderbook update ID out of order. Dropping book.');
                    book.initialized = false;
                    book.bids.clear();
                    book.asks.clear();
                    this.resubscribeTopic(topic);
                    return;
                }

                // Apply bid updates (size 0 = delete)
                for (const [pStr, sStr] of (msg.data?.b || [])) {
                    const price = parseFloat(pStr);
                    const size = parseFloat(sStr);
                    if (size === 0) {
                        book.bids.delete(price);
                    } else {
                        book.bids.set(price, size);
                    }
                }

                // Apply ask updates (size 0 = delete)
                for (const [pStr, sStr] of (msg.data?.a || [])) {
                    const price = parseFloat(pStr);
                    const size = parseFloat(sStr);
                    if (size === 0) {
                        book.asks.delete(price);
                    } else {
                        book.asks.set(price, size);
                    }
                }

                book.lastUpdateId = updateId;
                if (seq > 0) book.lastSeq = seq;
            }

            // Periodic sampling of maintained book: 25 best levels every 10s
            if (!book.initialized) return;

            const now = Date.now();
            const lastSampleTime = this.lastSampledOrderbookTime.get(symbol) || 0;
            if (now - lastSampleTime < this.orderbookSampleIntervalMs) {
                return;
            }

            // Sort bids descending (highest price first)
            const sortedBids = Array.from(book.bids.entries())
                .sort((a, b) => b[0] - a[0])
                .slice(0, 25);

            // Sort asks ascending (lowest price first)
            const sortedAsks = Array.from(book.asks.entries())
                .sort((a, b) => a[0] - b[0])
                .slice(0, 25);

            if (sortedBids.length === 0 || sortedAsks.length === 0) {
                log.warn({ symbol }, 'Maintained orderbook has empty bids or asks. Dropping and resubscribing.');
                book.initialized = false;
                this.resubscribeTopic(topic);
                return;
            }

            const bestBid = sortedBids[0][0];
            const bestAsk = sortedAsks[0][0];

            // Inconsistency check: spread must be strictly positive
            if (bestBid >= bestAsk) {
                log.warn({ symbol, bestBid, bestAsk }, 'Crossed orderbook detected in maintained local book. Dropping and resubscribing.');
                book.initialized = false;
                book.bids.clear();
                book.asks.clear();
                this.resubscribeTopic(topic);
                return;
            }

            this.lastSampledOrderbookTime.set(symbol, now);
            this.lastOrderbookTime = now;

            const spread = parseFloat((bestAsk - bestBid).toFixed(8));
            const midPrice = parseFloat(((bestBid + bestAsk) / 2).toFixed(8));
            const timestamp = Number(msg.ts || now);

            const snapshot: OrderbookSnapshot = {
                symbol,
                timestamp,
                depth: 25,
                bids: sortedBids,
                asks: sortedAsks,
                bestBid,
                bestAsk,
                spread,
                midPrice,
                recordedAt: now
            };

            if (this.onOrderbook) {
                this.onOrderbook(snapshot);
            }
        }
    }

    public getLocalBook(symbol: string): {
        symbol: string;
        bids: [number, number][];
        asks: [number, number][];
        initialized: boolean;
        lastUpdateId: number;
    } | null {
        const book = this.orderbooks.get(symbol);
        if (!book) return null;
        return {
            symbol: book.symbol,
            bids: Array.from(book.bids.entries()).sort((a, b) => b[0] - a[0]),
            asks: Array.from(book.asks.entries()).sort((a, b) => a[0] - b[0]),
            initialized: book.initialized,
            lastUpdateId: book.lastUpdateId
        };
    }

    public getLastLiquidationEventTime(): number {
        return this.lastLiquidationEventTime;
    }

    public getLastOrderbookTime(): number {
        return this.lastOrderbookTime;
    }

    public getLiquidationEventStats(): {
        totalEventsInWindow: number;
        windowHours: number;
        eventsPerHour: number;
        symbolStats: Record<string, number>;
    } {
        const now = Date.now();
        const durationHours = Math.max((now - this.hourlyWindowStart) / 3600000, 0.01);
        let total = 0;
        const symbolStats: Record<string, number> = {};

        for (const [sym, count] of this.liquidationCounts.entries()) {
            symbolStats[sym] = count;
            total += count;
        }

        return {
            totalEventsInWindow: total,
            windowHours: parseFloat(durationHours.toFixed(2)),
            eventsPerHour: parseFloat((total / durationHours).toFixed(2)),
            symbolStats
        };
    }

    public getLastMessageTime(): number {
        let maxTime = 0;
        for (const s of this.shards) {
            maxTime = Math.max(maxTime, s.getLastMessageTime());
        }
        return maxTime;
    }
}
