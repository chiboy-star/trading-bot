/**
 * Global REST Rate Limiter for Bybit Public Endpoints.
 * 
 * Enforces a strict token-bucket rate limit shared across ALL REST calls
 * and both hosts (api.bybit.com and api.bytick.com).
 * 
 * Specification:
 * - Sustained rate: capped near 20 requests/second.
 * - Burst capacity: <= 40 requests.
 * - Queue FIFO draining to prevent starvation and enforce steady pacing.
 * - Error 10006 backoff: provides global cooldown when Bybit rate limits / throttles.
 * - Sliding window tracking: records requests to analyze traffic across 5-second windows.
 */

export class GlobalRestRateLimiter {
    private capacity: number;
    private tokens: number;
    private fillRate: number; // tokens per second
    private lastRefill: number;
    private queue: Array<() => void> = [];
    private drainTimer: NodeJS.Timeout | null = null;
    private backoffUntil: number = 0;
    private requestTimestamps: number[] = [];
    private error10006Timestamps: number[] = [];
    private error429Timestamps: number[] = [];
    private endpointCounts5s: Map<number, Record<string, number>> = new Map();

    constructor(capacity: number = 40, fillRate: number = 20) {
        this.capacity = capacity;
        this.tokens = capacity;
        this.fillRate = fillRate;
        this.lastRefill = Date.now();
    }

    private refill(): void {
        const now = Date.now();
        // If in backoff, tokens do not refill until backoff has expired
        if (now < this.backoffUntil) {
            return;
        }

        const effectiveLast = Math.max(this.lastRefill, this.backoffUntil);
        const elapsed = (now - effectiveLast) / 1000;
        if (elapsed > 0) {
            this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.fillRate);
            this.lastRefill = now;
        }
    }

    /**
     * Trigger global backoff across all pending and future requests.
     * Used on HTTP 429 or Bybit Error 10006 (throttled).
     */
    public triggerBackoff(durationMs: number): void {
        const now = Date.now();
        this.backoffUntil = Math.max(this.backoffUntil, now + durationMs);
        this.tokens = 0; // Drain tokens during backoff
        this.scheduleDrain();
    }

    public isBackoffActive(): boolean {
        return Date.now() < this.backoffUntil;
    }

    public getBackoffRemainingMs(): number {
        return Math.max(0, this.backoffUntil - Date.now());
    }

    /**
     * Record a dispatched REST request timestamp, endpoint, and any error code.
     */
    public recordRequest(endpoint: string = 'unknown', timestamp: number = Date.now(), errorCode?: number): void {
        this.requestTimestamps.push(timestamp);
        const cutoff = timestamp - 3600000; // retain 1 hour
        while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < cutoff) {
            this.requestTimestamps.shift();
        }

        const bucket5s = Math.floor(timestamp / 5000) * 5000;
        let epMap = this.endpointCounts5s.get(bucket5s);
        if (!epMap) {
            epMap = {};
            this.endpointCounts5s.set(bucket5s, epMap);
        }
        epMap[endpoint] = (epMap[endpoint] || 0) + 1;

        if (errorCode === 10006) {
            this.error10006Timestamps.push(timestamp);
        } else if (errorCode === 429) {
            this.error429Timestamps.push(timestamp);
        }

        while (this.error10006Timestamps.length > 0 && this.error10006Timestamps[0] < cutoff) {
            this.error10006Timestamps.shift();
        }
        while (this.error429Timestamps.length > 0 && this.error429Timestamps[0] < cutoff) {
            this.error429Timestamps.shift();
        }

        for (const b of this.endpointCounts5s.keys()) {
            if (b < cutoff) this.endpointCounts5s.delete(b);
        }
    }

    public getErrorCountsPastHour(now: number = Date.now()): { errors10006: number; errors429: number } {
        const cutoff = now - 3600000;
        const e10006 = this.error10006Timestamps.filter(t => t >= cutoff).length;
        const e429 = this.error429Timestamps.filter(t => t >= cutoff).length;
        return { errors10006: e10006, errors429: e429 };
    }

    /**
     * Analyze request density across sliding 5-second windows over the last hour (or specified window).
     */
    public getRequestsPer5sWindows(windowDurationMs: number = 3600000): {
        totalRequests: number;
        peak5sRequests: number;
        avg5sRequests: number;
        windows5sCount: number;
        windowDistribution: Array<{ timestamp: number; iso: string; count: number; byEndpoint: Record<string, number> }>;
    } {
        const now = Date.now();
        const start = now - windowDurationMs;
        const events = this.requestTimestamps.filter(t => t >= start);
        const bucketSizeMs = 5000;
        const buckets = new Map<number, number>();

        for (let b = Math.floor(start / bucketSizeMs) * bucketSizeMs; b <= now; b += bucketSizeMs) {
            buckets.set(b, 0);
        }

        for (const t of events) {
            const b = Math.floor(t / bucketSizeMs) * bucketSizeMs;
            buckets.set(b, (buckets.get(b) || 0) + 1);
        }

        let peak = 0;
        let sum = 0;
        const windowDistribution: Array<{ timestamp: number; iso: string; count: number; byEndpoint: Record<string, number> }> = [];

        for (const [b, count] of buckets.entries()) {
            if (count > peak) peak = count;
            sum += count;
            windowDistribution.push({
                timestamp: b,
                iso: new Date(b).toISOString(),
                count,
                byEndpoint: this.endpointCounts5s.get(b) || {}
            });
        }

        const countWindows = buckets.size;
        return {
            totalRequests: events.length,
            peak5sRequests: peak,
            avg5sRequests: countWindows > 0 ? parseFloat((sum / countWindows).toFixed(2)) : 0,
            windows5sCount: countWindows,
            windowDistribution
        };
    }

    /**
     * Acquire a token before dispatching a REST call.
     * Resolves immediately if tokens are available, or queues until refilled.
     */
    public async acquire(cost: number = 1): Promise<void> {
        this.refill();

        const now = Date.now();
        if (now < this.backoffUntil) {
            return new Promise<void>((resolve) => {
                this.queue.push(() => {
                    this.tokens = Math.max(0, this.tokens - cost);
                    this.recordRequest();
                    resolve();
                });
                this.scheduleDrain();
            });
        }

        if (this.queue.length === 0 && this.tokens >= cost) {
            this.tokens -= cost;
            this.recordRequest();
            return;
        }

        return new Promise<void>((resolve) => {
            this.queue.push(() => {
                this.tokens = Math.max(0, this.tokens - cost);
                this.recordRequest();
                resolve();
            });
            this.scheduleDrain();
        });
    }

    private scheduleDrain(): void {
        if (this.drainTimer) return;

        const processQueue = () => {
            this.drainTimer = null;
            this.refill();

            const now = Date.now();
            if (now < this.backoffUntil) {
                const waitMs = Math.max(10, this.backoffUntil - now);
                this.drainTimer = setTimeout(processQueue, waitMs);
                return;
            }

            while (this.queue.length > 0 && this.tokens >= 1) {
                const next = this.queue.shift();
                if (next) next();
            }

            if (this.queue.length > 0) {
                const needed = 1 - this.tokens;
                const waitMs = Math.max(10, Math.ceil((needed / this.fillRate) * 1000));
                this.drainTimer = setTimeout(processQueue, waitMs);
            }
        };

        const now = Date.now();
        const backoffWait = Math.max(0, this.backoffUntil - now);
        const needed = 1 - this.tokens;
        const refillWait = needed > 0 ? Math.max(10, Math.ceil((needed / this.fillRate) * 1000)) : 0;
        const initialWait = Math.max(backoffWait, refillWait);
        this.drainTimer = setTimeout(processQueue, initialWait);
    }

    public getAvailableTokens(): number {
        this.refill();
        return this.tokens;
    }

    public getQueueLength(): number {
        return this.queue.length;
    }

    public getCapacity(): number {
        return this.capacity;
    }

    public getFillRate(): number {
        return this.fillRate;
    }

    /**
     * Reset rate limiter state (useful in tests or recovery)
     */
    public reset(): void {
        if (this.drainTimer) {
            clearTimeout(this.drainTimer);
            this.drainTimer = null;
        }
        this.tokens = this.capacity;
        this.lastRefill = Date.now();
        this.backoffUntil = 0;
        while (this.queue.length > 0) {
            const next = this.queue.shift();
            if (next) next();
        }
    }
}

// Single global rate limiter instance shared across all REST calls and both hosts
export const globalRestRateLimiter = new GlobalRestRateLimiter(40, 20);
export default globalRestRateLimiter;
