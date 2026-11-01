import { FillRequest, SimulatedFill } from './types';
import { OrderbookSnapshot } from '../recorder/types';

export class PaperFillSimulator {
    public readonly takerFeeRate: number = 0.00055; // Bybit VIP0 0.055%
    public readonly makerFeeRate: number = 0.00020; // Bybit VIP0 0.020%

    /**
     * Simulates order execution.
     * Walks recorded order book if available; otherwise uses conservative tiered slippage.
     */
    public simulateFill(request: FillRequest, book?: OrderbookSnapshot | null): SimulatedFill {
        if (book && book.asks.length > 0 && book.bids.length > 0) {
            return this.simulateFromBook(request, book);
        }
        return this.simulateConservativeModel(request);
    }

    /**
     * Realistic book walk against recorded top-25 depth snapshots.
     */
    private simulateFromBook(request: FillRequest, book: OrderbookSnapshot): SimulatedFill {
        let remainingQty = request.quantity;
        let totalCost = 0;
        let filledQty = 0;

        if (request.side === 'BUY') {
            // Walk Ask side (sorted ascending: lowest price first)
            for (const [price, size] of book.asks) {
                if (remainingQty <= 0) break;
                const fillHere = Math.min(remainingQty, size);
                totalCost += fillHere * price;
                filledQty += fillHere;
                remainingQty -= fillHere;
            }

            // If order size exhausts top 25 depth, fill remainder with conservative penalty
            if (remainingQty > 0) {
                const worstAsk = book.asks[book.asks.length - 1][0];
                const penaltyPrice = worstAsk * 1.0008; // 0.08% penalty for blowing through book
                totalCost += remainingQty * penaltyPrice;
                filledQty += remainingQty;
                remainingQty = 0;
            }

            const fillPrice = parseFloat((totalCost / filledQty).toFixed(6));
            const slippage = parseFloat((fillPrice - request.signalPrice).toFixed(6));
            const slippagePct = parseFloat(((slippage / request.signalPrice) * 100).toFixed(4));
            const feeTier = request.postOnly ? 'MAKER' : 'TAKER';
            const feeRate = feeTier === 'MAKER' ? this.makerFeeRate : this.takerFeeRate;
            const fee = parseFloat((fillPrice * filledQty * feeRate).toFixed(6));

            return {
                symbol: request.symbol,
                side: request.side,
                type: request.type,
                quantity: request.quantity,
                signalPrice: request.signalPrice,
                fillPrice,
                slippage,
                slippagePct,
                fee,
                feeRate,
                feeTier,
                simulatedFromBook: true,
                timestamp: request.timestamp,
                notes: `Walked top-25 ask book (${book.asks.length} levels)`
            };
        } else {
            // Walk Bid side (sorted descending: highest price first)
            for (const [price, size] of book.bids) {
                if (remainingQty <= 0) break;
                const fillHere = Math.min(remainingQty, size);
                totalCost += fillHere * price;
                filledQty += fillHere;
                remainingQty -= fillHere;
            }

            if (remainingQty > 0) {
                const worstBid = book.bids[book.bids.length - 1][0];
                const penaltyPrice = worstBid * 0.9992;
                totalCost += remainingQty * penaltyPrice;
                filledQty += remainingQty;
                remainingQty = 0;
            }

            const fillPrice = parseFloat((totalCost / filledQty).toFixed(6));
            const slippage = parseFloat((request.signalPrice - fillPrice).toFixed(6));
            const slippagePct = parseFloat(((slippage / request.signalPrice) * 100).toFixed(4));
            const feeTier = request.postOnly ? 'MAKER' : 'TAKER';
            const feeRate = feeTier === 'MAKER' ? this.makerFeeRate : this.takerFeeRate;
            const fee = parseFloat((fillPrice * filledQty * feeRate).toFixed(6));

            return {
                symbol: request.symbol,
                side: request.side,
                type: request.type,
                quantity: request.quantity,
                signalPrice: request.signalPrice,
                fillPrice,
                slippage,
                slippagePct,
                fee,
                feeRate,
                feeTier,
                simulatedFromBook: true,
                timestamp: request.timestamp,
                notes: `Walked top-25 bid book (${book.bids.length} levels)`
            };
        }
    }

    /**
     * Conservative tiered slippage model when depth snapshots are not recorded.
     */
    private simulateConservativeModel(request: FillRequest): SimulatedFill {
        let adverseSlippagePct = 0.0012; // 0.12% default for altcoins
        const sym = request.symbol.toUpperCase();

        if (sym === 'BTCUSDT') {
            adverseSlippagePct = 0.0003; // 0.03%
        } else if (sym === 'ETHUSDT') {
            adverseSlippagePct = 0.0004; // 0.04%
        } else if (['SOLUSDT', 'DOGEUSDT', 'XRPUSDT'].includes(sym)) {
            adverseSlippagePct = 0.0007; // 0.07%
        }

        const slippageMultiplier = request.side === 'BUY' ? (1 + adverseSlippagePct) : (1 - adverseSlippagePct);
        const fillPrice = parseFloat((request.signalPrice * slippageMultiplier).toFixed(6));
        const slippage = parseFloat(Math.abs(fillPrice - request.signalPrice).toFixed(6));
        const slippagePct = parseFloat((adverseSlippagePct * 100).toFixed(4));

        const feeTier = request.postOnly ? 'MAKER' : 'TAKER';
        const feeRate = feeTier === 'MAKER' ? this.makerFeeRate : this.takerFeeRate;
        const fee = parseFloat((fillPrice * request.quantity * feeRate).toFixed(6));

        return {
            symbol: request.symbol,
            side: request.side,
            type: request.type,
            quantity: request.quantity,
            signalPrice: request.signalPrice,
            fillPrice,
            slippage,
            slippagePct,
            fee,
            feeRate,
            feeTier,
            simulatedFromBook: false,
            timestamp: request.timestamp,
            notes: `Conservative tiered slippage model (${slippagePct}% adverse)`
        };
    }
}
