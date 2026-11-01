import { LiquidationRecord, OrderbookSnapshot } from './types';
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

class SingleWSShard {
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

    public topics: Set<string> = new Set();
    public onMessage?: (msg: any) => void;
    public onStatusChange?: (shardId: number, status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') => void;

    constructor(shardId: number, primaryUrl: string, fallbackUrl: string, pingIntervalMs: number = 20000, maxBackoffMs: number = 60000) {
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
        this.clearTimers();
        if (this.ws) {
            try { this.ws.close(); } catch {}
            this.ws = null;
        }
        if (this.onStatusChange) this.onStatusChange(this.shardId, 'DISCONNECTED');
    }

    private clearTimers(): void {
        if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
        if (this.reconnectTimeout) { clearTimeout(this.reconnectTimeout); this.reconnectTimeout = null; }
    }

    private connect(): void {
        if (!this.isRunning) return;
        this.clearTimers();

        try {
            this.ws = new WebSocket(this.activeUrl);

            this.ws.addEventListener('open', () => {
                this.backoffMs = 1000;
                this.lastMsgTime = Date.now();
                if (this.onStatusChange) this.onStatusChange(this.shardId, 'CONNECTED');
                this.startPingKeepalive();
                this.resubscribe();
            });

            this.ws.addEventListener('message', (event) => {
                this.lastMsgTime = Date.now();
                try {
                    const msg = JSON.parse(event.data);
                    if (this.onMessage) this.onMessage(msg);
                } catch {}
            });

            this.ws.addEventListener('close', () => this.scheduleReconnect('Socket closed'));
            this.ws.addEventListener('error', () => this.scheduleReconnect('Socket error'));
        } catch {
            this.scheduleReconnect('Connect exception');
        }
    }

    private scheduleReconnect(reason: string): void {
        if (!this.isRunning) return;
        this.clearTimers();
        if (this.onStatusChange) this.onStatusChange(this.shardId, 'RECONNECTING');

        // Alternate host on failure
        this.activeUrl = this.activeUrl === this.primaryUrl ? this.fallbackUrl : this.primaryUrl;
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);

        this.reconnectTimeout = setTimeout(() => this.connect(), delay);
    }

    private startPingKeepalive(): void {
        this.pingTimer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            if (Date.now() - this.lastMsgTime > this.pingIntervalMs * 2) {
                this.ws.close();
                return;
            }
            try { this.ws.send(JSON.stringify({ op: 'ping' })); } catch {}
        }, this.pingIntervalMs);
    }

    public subscribe(newTopics: string[]): void {
        for (const t of newTopics) this.topics.add(t);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.sendBatch(newTopics);
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

    public onLiquidation?: (record: LiquidationRecord) => void;
    public onOrderbook?: (snapshot: OrderbookSnapshot) => void;
    public onStatus?: (status: 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') => void;

    constructor(options: WSClientOptions = {}) {
        this.primaryUrl = options.primaryUrl || 'wss://stream.bybit.com/v5/public/linear';
        this.fallbackUrl = options.fallbackUrl || 'wss://stream.bytick.com/v5/public/linear';
        this.pingIntervalMs = options.pingIntervalMs || 20000;
        this.maxBackoffMs = options.maxBackoffMs || 60000;
        this.orderbookSampleIntervalMs = options.orderbookSampleIntervalMs || 10000;
        this.shardCapacity = options.shardCapacity || 100; // max 100 topics per WS connection to stay well below Bybit limits
    }

    public start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        for (const shard of this.shards) {
            shard.start();
        }
    }

    public stop(): void {
        this.isRunning = false;
        for (const shard of this.shards) {
            shard.stop();
        }
        if (this.onStatus) this.onStatus('DISCONNECTED');
    }

    /**
     * Distributes all active linear contracts into sharded connections.
     * Guaranteed: ALL active contracts get allLiquidation subscriptions!
     */
    public setTrackedSymbols(orderbookSymbols: string[], liquidationSymbols: string[]): void {
        // Stop existing shards if re-configuring
        for (const shard of this.shards) shard.stop();
        this.shards = [];

        // Depth topics strictly for BTC, ETH, and <72h new listings
        const depthTopics = orderbookSymbols.map(s => `orderbook.50.${s}`);
        const liqTopics = liquidationSymbols.map(s => `allLiquidation.${s}`);

        // Shard 0 takes orderbook depth topics + initial slice of liquidations
        let currentShard = this.createShard(0);
        currentShard.subscribe(depthTopics);

        for (const topic of liqTopics) {
            if (currentShard.topics.size >= this.shardCapacity) {
                if (this.isRunning) currentShard.start();
                this.shards.push(currentShard);
                currentShard = this.createShard(this.shards.length);
            }
            currentShard.subscribe([topic]);
        }

        if (currentShard.topics.size > 0) {
            if (this.isRunning) currentShard.start();
            this.shards.push(currentShard);
        }

        log.info({
            totalLiquidationSymbols: liquidationSymbols.length,
            orderbookSymbols: orderbookSymbols.length,
            shardsCount: this.shards.length,
            topicsPerShardAvg: Math.round((liqTopics.length + depthTopics.length) / Math.max(this.shards.length, 1))
        }, 'Sharded WebSocket manager configured');
    }

    /**
     * Dynamically adds newly listed contracts to active shards.
     */
    public addNewListing(symbol: string, isWithin72h: boolean = true): void {
        const liqTopic = `allLiquidation.${symbol}`;
        const obTopic = isWithin72h ? `orderbook.50.${symbol}` : null;

        // Find shard with remaining capacity
        let targetShard = this.shards.find(s => s.topics.size < this.shardCapacity);
        if (!targetShard) {
            targetShard = this.createShard(this.shards.length);
            if (this.isRunning) targetShard.start();
            this.shards.push(targetShard);
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
            // If any shard is connected, notify overall connected
            const anyConnected = this.shards.some(s => s['ws']?.readyState === WebSocket.OPEN);
            if (this.onStatus) {
                this.onStatus(anyConnected ? 'CONNECTED' : status);
            }
        };

        return shard;
    }

    private handleMessage(msg: any): void {
        if (msg.ret_msg === 'pong' || msg.op === 'ping') return;
        const topic = msg.topic;
        if (!topic) return;

        // 1. LIQUIDATIONS
        if (topic.startsWith('allLiquidation.')) {
            const dataList = Array.isArray(msg.data) ? msg.data : [msg.data];
            const recordedAt = Date.now();

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

        // 2. ORDERBOOK
        if (topic.startsWith('orderbook.')) {
            const symbol = msg.data?.s;
            if (!symbol) return;

            const now = Date.now();
            const lastSampleTime = this.lastSampledOrderbookTime.get(symbol) || 0;
            if (now - lastSampleTime < this.orderbookSampleIntervalMs) {
                return;
            }

            const rawBids = msg.data?.b;
            const rawAsks = msg.data?.a;

            if (Array.isArray(rawBids) && Array.isArray(rawAsks) && rawBids.length > 0 && rawAsks.length > 0) {
                this.lastSampledOrderbookTime.set(symbol, now);
                const depth = 25;
                const bids: [number, number][] = rawBids.slice(0, depth).map((b: [string, string]) => [parseFloat(b[0]), parseFloat(b[1])]);
                const asks: [number, number][] = rawAsks.slice(0, depth).map((a: [string, string]) => [parseFloat(a[0]), parseFloat(a[1])]);

                const bestBid = bids[0][0];
                const bestAsk = asks[0][0];
                const spread = parseFloat((bestAsk - bestBid).toFixed(8));
                const midPrice = parseFloat(((bestBid + bestAsk) / 2).toFixed(8));
                const timestamp = Number(msg.ts || now);

                const snapshot: OrderbookSnapshot = {
                    symbol,
                    timestamp,
                    depth,
                    bids,
                    asks,
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

    public getShardsCount(): number {
        return this.shards.length;
    }
}
