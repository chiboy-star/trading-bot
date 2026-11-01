export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT';

export interface FillRequest {
    symbol: string;
    side: OrderSide;
    type: OrderType;
    quantity: number;
    signalPrice: number;
    timestamp: number;
    postOnly?: boolean;
}

export interface SimulatedFill {
    symbol: string;
    side: OrderSide;
    type: OrderType;
    quantity: number;
    signalPrice: number;
    fillPrice: number;
    slippage: number; // in USDT per unit
    slippagePct: number;
    fee: number; // total fee in USDT
    feeRate: number;
    feeTier: 'TAKER' | 'MAKER';
    simulatedFromBook: boolean;
    timestamp: number;
    notes: string;
}

export interface SignalEvent {
    runId: string;
    paramsHash: string;
    hypothesis: 'H-A' | 'H-B';
    symbol: string;
    direction: 'LONG' | 'SHORT';
    timestamp: number;
    signalPrice: number;
    initialStopPrice: number;
    targetPrice: number;
    riskUnitsR: number;
    metrics: Record<string, number | string>;
}

export interface PaperTradeRecord {
    id?: number;
    runId: string;
    paramsHash: string;
    hypothesis: 'H-A' | 'H-B';
    symbol: string;
    direction: 'LONG' | 'SHORT';
    entryTimestamp: number;
    entryPrice: number;
    fillPrice: number;
    initialStop: number;
    targetPrice: number;
    quantity: number;
    slippage: number;
    entryFee: number;
    exitTimestamp?: number;
    exitPrice?: number;
    exitFee?: number;
    exitReason?: 'STOP_LOSS' | 'TAKE_PROFIT' | 'TIME_STOP' | 'INTRABAR_STOP';
    pnlGross?: number;
    pnlNet?: number;
    pnlR?: number;
    fundingAccrued?: number;
    status: 'OPEN' | 'CLOSED';
}
