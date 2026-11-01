"""
Event-Driven Multi-Asset Quantitative Backtesting Engine
Features:
- Chronological multi-pair simulation across all 12 symbols (Core + Satellite)
- Closed-bar signal evaluation, execution at next bar's open (zero lookahead)
- Realistic cost modeling: Bybit taker fees, liquidity-tiered slippage, 8-hour funding payments
- Full risk controls: ATR stop-distance sizing, max 10 concurrent, max 6 same-direction, 5% 24h circuit breaker
- Detailed performance analytics: CAGR, Max Drawdown, Sharpe/Sortino, Expectancy (R), Playbook & Symbol breakdowns
- Benchmark against Buy & Hold BTC
"""

import os
import sys
import glob
import argparse
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple, Any
import numpy as np
import pandas as pd
from datetime import datetime, timezone

sys.path.insert(0, os.getcwd())
from research.indicators import compute_all_indicators
from research.strategy import StrategyLogic, SignalResult

CORE_SYMBOLS = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "SUI_USDT", "XRP_USDT", "DOGE_USDT", "1000PEPE_USDT"]

@dataclass
class Position:
    symbol: str
    side: str
    amount: float
    entry_price: float
    entry_time: int
    entry_datetime: str
    setup_type: str
    trailing_stop: float
    highest_price: float
    lowest_price: float
    atr: float
    atr_multiplier: float
    take_profit_price: Optional[float]
    initial_risk_dollars: float
    initial_stop_distance: float
    accumulated_funding: float = 0.0

@dataclass
class TradeRecord:
    symbol: str
    side: str
    setup_type: str
    entry_time: str
    exit_time: str
    duration_hours: float
    entry_price: float
    exit_price: float
    amount: float
    notional_entry: float
    notional_exit: float
    gross_pnl: float
    fee_entry: float
    fee_exit: float
    total_fees: float
    slippage_cost: float
    funding_pnl: float
    net_pnl: float
    return_pct: float
    r_multiple: float
    exit_reason: str
    capital_after: float

class Backtester:
    def __init__(
        self,
        data_dir: str = "research/data",
        initial_capital: float = 10000.0,
        taker_fee: float = 0.0006,        # 0.06% Bybit futures taker
        core_slippage: float = 0.0005,    # 0.05% (5 bps) for liquid core
        satellite_slippage: float = 0.0012, # 0.12% (12 bps) for mid-caps
        max_concurrent: int = 10,
        max_same_direction: int = 6,
        circuit_breaker_pct: float = 0.05,
        circuit_breaker_lockout_ms: int = 86400000, # 24h
        leverage: float = 10.0,
        atr_multiplier: float = 2.8,
        adx_threshold: float = 20.0,
        stop_at_ruin: bool = True,
        ruin_threshold: float = 500.0,
        fixed_risk_mode: bool = False
    ):
        self.data_dir = data_dir
        self.initial_capital = initial_capital
        self.capital = initial_capital
        self.taker_fee = taker_fee
        self.core_slippage = core_slippage
        self.satellite_slippage = satellite_slippage
        self.max_concurrent = max_concurrent
        self.max_same_direction = max_same_direction
        self.circuit_breaker_pct = circuit_breaker_pct
        self.circuit_breaker_lockout_ms = circuit_breaker_lockout_ms
        self.leverage = leverage
        self.stop_at_ruin = stop_at_ruin
        self.ruin_threshold = ruin_threshold
        self.fixed_risk_mode = fixed_risk_mode

        self.strategy = StrategyLogic(
            atr_multiplier=atr_multiplier,
            adx_threshold=adx_threshold,
            allow_shorts=True
        )

        self.positions: Dict[str, Position] = {}
        self.pending_orders: Dict[str, Tuple[SignalResult, int]] = {} # symbol -> (signal, signal_candle_ts)
        self.trade_log: List[TradeRecord] = []
        self.equity_history: List[Dict[str, Any]] = []

        # Circuit breaker state
        self.lockout_until = 0
        self.daily_losses: List[Tuple[int, float]] = [] # (timestamp, loss_dollars)

    def get_slippage(self, symbol: str) -> float:
        return self.core_slippage if symbol in CORE_SYMBOLS else self.satellite_slippage

    def load_all_data(self) -> Tuple[Dict[str, pd.DataFrame], Dict[str, pd.DataFrame]]:
        """Loads and prepares OHLCV and funding tables for all pairs."""
        ohlcv_files = glob.glob(os.path.join(self.data_dir, "*_15m.parquet"))
        funding_files = glob.glob(os.path.join(self.data_dir, "*_funding.parquet"))

        ohlcv_dict = {}
        for f in ohlcv_files:
            slug = os.path.basename(f).replace("_15m.parquet", "")
            df = pd.read_parquet(f)
            df = compute_all_indicators(df)
            ohlcv_dict[slug] = df

        funding_dict = {}
        for f in funding_files:
            slug = os.path.basename(f).replace("_funding.parquet", "")
            df = pd.read_parquet(f)
            funding_dict[slug] = df

        return ohlcv_dict, funding_dict

    def is_circuit_breaker_halted(self, current_ts: int) -> bool:
        """Checks if 24h realized loss exceeds circuit breaker limit."""
        if current_ts < self.lockout_until:
            return True

        # Prune daily losses older than 24h
        cutoff = current_ts - 86400000
        self.daily_losses = [(ts, loss) for ts, loss in self.daily_losses if ts >= cutoff]
        total_24h_loss = sum(loss for _, loss in self.daily_losses)

        threshold = self.initial_capital * self.circuit_breaker_pct
        if total_24h_loss >= threshold:
            self.lockout_until = current_ts + self.circuit_breaker_lockout_ms
            return True

        return False

    def run(self) -> Dict[str, Any]:
        print("Loading and preparing indicators across all datasets...", flush=True)
        ohlcv_dict, funding_dict = self.load_all_data()

        # Build funding lookup dictionaries: (symbol, timestamp) -> rate
        funding_map: Dict[Tuple[str, int], float] = {}
        for sym, df_f in funding_dict.items():
            for _, row in df_f.iterrows():
                funding_map[(sym, int(row['timestamp']))] = float(row['funding_rate'])

        # Pre-extract numpy arrays for blazing fast indexing
        symbol_arrays: Dict[str, Dict[str, np.ndarray]] = {}
        symbol_indices: Dict[str, Dict[int, int]] = {}
        for sym, df in ohlcv_dict.items():
            symbol_arrays[sym] = {
                'open': df['open'].to_numpy(dtype=float),
                'high': df['high'].to_numpy(dtype=float),
                'low': df['low'].to_numpy(dtype=float),
                'close': df['close'].to_numpy(dtype=float),
                'atr': df['atr'].to_numpy(dtype=float),
                'ema_fast': df['ema_fast'].to_numpy(dtype=float),
                'ema_slow': df['ema_slow'].to_numpy(dtype=float),
                'rsi': df['rsi'].to_numpy(dtype=float),
                'adx': df['adx'].to_numpy(dtype=float),
            }
            symbol_indices[sym] = {int(ts): idx for idx, ts in enumerate(df['timestamp'].values)}

        # Create synchronized global timeline
        all_timestamps = set()
        for df in ohlcv_dict.values():
            all_timestamps.update(df['timestamp'].tolist())
        timeline = sorted(list(all_timestamps))

        total_steps = len(timeline)
        print(f"Beginning chronological simulation over {total_steps} bars ({len(ohlcv_dict)} pairs)...", flush=True)

        for step_idx, ts in enumerate(timeline):
            dt_utc = datetime.fromtimestamp(ts / 1000, timezone.utc)

            # 1. APPLY 8-HOUR FUNDING PAYMENTS (at 00:00, 08:00, 16:00 UTC)
            if dt_utc.minute == 0 and dt_utc.hour in (0, 8, 16):
                for sym, pos in list(self.positions.items()):
                    rate = funding_map.get((sym, ts), 0.0)
                    if rate != 0.0 and sym in symbol_indices and ts in symbol_indices[sym]:
                        idx = symbol_indices[sym][ts]
                        curr_close = symbol_arrays[sym]['close'][idx]
                        notional = pos.amount * curr_close
                        funding_cashflow = -(notional * rate) if pos.side == 'LONG' else (notional * rate)
                        self.capital += funding_cashflow
                        pos.accumulated_funding += funding_cashflow

            # 2. EXECUTE PENDING ORDERS AT CURRENT BAR'S OPEN (next bar after closed signal)
            is_ruined = self.stop_at_ruin and self.capital <= self.ruin_threshold
            if is_ruined:
                self.pending_orders.clear()

            if not self.is_circuit_breaker_halted(ts) and not is_ruined:
                for sym in list(self.pending_orders.keys()):
                    sig, sig_ts = self.pending_orders.pop(sym)
                    if sym not in symbol_indices or ts not in symbol_indices[sym]:
                        continue

                    idx = symbol_indices[sym][ts]
                    arrs = symbol_arrays[sym]
                    bar_open = arrs['open'][idx]
                    # Use signal candle ATR (closed bar idx - 1) for zero-lookahead sizing & stop distance
                    sig_idx = idx - 1 if idx >= 1 else idx
                    signal_atr = arrs['atr'][sig_idx]
                    if np.isnan(signal_atr) or signal_atr <= 0:
                        continue

                    # Portfolio Heat Guard
                    if len(self.positions) >= self.max_concurrent:
                        continue

                    # Directional Correlation Guard
                    same_dir_count = sum(1 for p in self.positions.values() if p.side == sig.direction)
                    if same_dir_count >= self.max_same_direction:
                        continue

                    slippage = self.get_slippage(sym)
                    exec_price = bar_open * (1.0 + slippage) if sig.direction == 'LONG' else bar_open * (1.0 - slippage)
                    atr_mult = sig.recommended_atr_mult
                    stop_distance = atr_mult * signal_atr

                    # Margin & Buying power check
                    capital_basis = self.initial_capital if self.fixed_risk_mode else self.capital
                    margin_used = sum((p.amount * p.entry_price) / self.leverage for p in self.positions.values())
                    available_buying_power = max(0.0, capital_basis - margin_used)

                    # Position Sizing: Risk Amount / Stop Distance
                    if self.fixed_risk_mode:
                        risk_amount = self.initial_capital * sig.recommended_risk_pct
                    else:
                        risk_amount = self.capital * sig.recommended_risk_pct

                    size_by_risk = risk_amount / stop_distance
                    max_affordable_size = (available_buying_power * self.leverage * (1.0 - self.taker_fee)) / exec_price
                    pos_size = min(size_by_risk, max_affordable_size)

                    notional = pos_size * exec_price
                    # Guard against dust / zero sizing (minimum $10 notional required)
                    if pos_size <= 0 or notional < 10.0:
                        continue

                    entry_fee = notional * self.taker_fee
                    self.capital -= entry_fee

                    init_stop = exec_price - stop_distance if sig.direction == 'LONG' else exec_price + stop_distance

                    self.positions[sym] = Position(
                        symbol=sym,
                        side=sig.direction,
                        amount=pos_size,
                        entry_price=exec_price,
                        entry_time=ts,
                        entry_datetime=dt_utc.isoformat(),
                        setup_type=sig.setup_type or 'EMA_CROSSOVER',
                        trailing_stop=init_stop,
                        highest_price=exec_price,
                        lowest_price=exec_price,
                        atr=signal_atr,
                        atr_multiplier=atr_mult,
                        take_profit_price=sig.take_profit_price,
                        initial_risk_dollars=risk_amount,
                        initial_stop_distance=stop_distance,
                        accumulated_funding=0.0
                    )

            # 3. MANAGE OPEN POSITIONS & EXITS
            for sym, pos in list(self.positions.items()):
                if sym not in symbol_indices or ts not in symbol_indices[sym]:
                    continue

                idx = symbol_indices[sym][ts]
                arrs = symbol_arrays[sym]

                b_open = arrs['open'][idx]
                b_high = arrs['high'][idx]
                b_low = arrs['low'][idx]
                b_close = arrs['close'][idx]
                b_atr = arrs['atr'][idx]
                eff_atr = b_atr if (not np.isnan(b_atr) and b_atr > 0) else pos.atr

                curr_fast = arrs['ema_fast'][idx]
                prev_fast = arrs['ema_fast'][idx - 1] if idx >= 1 else curr_fast
                curr_slow = arrs['ema_slow'][idx]
                prev_slow = arrs['ema_slow'][idx - 1] if idx >= 1 else curr_slow

                slippage = self.get_slippage(sym)

                exit_eval = self.strategy.evaluate_exit(
                    side=pos.side,
                    entry_price=pos.entry_price,
                    trailing_stop=pos.trailing_stop,
                    highest_price=pos.highest_price,
                    lowest_price=pos.lowest_price,
                    candle_open=b_open,
                    candle_high=b_high,
                    candle_low=b_low,
                    candle_close=b_close,
                    curr_atr=eff_atr,
                    atr_multiplier=pos.atr_multiplier,
                    take_profit_price=pos.take_profit_price,
                    curr_ema_fast=curr_fast,
                    prev_ema_fast=prev_fast,
                    curr_ema_slow=curr_slow,
                    prev_ema_slow=prev_slow,
                    slippage=slippage
                )

                pos.trailing_stop = exit_eval.new_trailing_stop
                pos.highest_price = exit_eval.new_highest
                pos.lowest_price = exit_eval.new_lowest

                if exit_eval.should_exit:
                    exit_price = exit_eval.execution_price
                    notional_entry = pos.amount * pos.entry_price
                    notional_exit = pos.amount * exit_price

                    if pos.side == 'LONG':
                        gross_pnl = notional_exit - notional_entry
                    else:
                        gross_pnl = notional_entry - notional_exit

                    entry_fee = notional_entry * self.taker_fee
                    exit_fee = notional_exit * self.taker_fee
                    slippage_cost = notional_exit * slippage + notional_entry * slippage
                    net_pnl = gross_pnl - entry_fee - exit_fee + pos.accumulated_funding
                    self.capital += (gross_pnl - exit_fee)

                    duration_h = (ts - pos.entry_time) / (1000 * 3600)
                    r_mult = net_pnl / pos.initial_risk_dollars if pos.initial_risk_dollars > 0 else 0.0

                    if net_pnl < 0:
                        self.daily_losses.append((ts, abs(net_pnl)))

                    self.trade_log.append(TradeRecord(
                        symbol=sym,
                        side=pos.side,
                        setup_type=pos.setup_type,
                        entry_time=pos.entry_datetime,
                        exit_time=dt_utc.isoformat(),
                        duration_hours=round(duration_h, 2),
                        entry_price=round(pos.entry_price, 4),
                        exit_price=round(exit_price, 4),
                        amount=round(pos.amount, 6),
                        notional_entry=round(notional_entry, 2),
                        notional_exit=round(notional_exit, 2),
                        gross_pnl=round(gross_pnl, 2),
                        fee_entry=round(notional_entry * self.taker_fee, 2),
                        fee_exit=round(exit_fee, 2),
                        total_fees=round(notional_entry * self.taker_fee + exit_fee, 2),
                        slippage_cost=round(slippage_cost, 2),
                        funding_pnl=round(pos.accumulated_funding, 2),
                        net_pnl=round(net_pnl, 2),
                        return_pct=round((net_pnl / notional_entry) * 100, 2),
                        r_multiple=round(r_mult, 2),
                        exit_reason=exit_eval.reason or 'EXIT',
                        capital_after=round(self.capital, 2)
                    ))

                    del self.positions[sym]

            # 4. EVALUATE NEW CLOSED-BAR SIGNALS FOR NEXT BAR EXECUTION
            if not self.is_circuit_breaker_halted(ts):
                for sym in symbol_indices.keys():
                    if sym in self.positions or sym in self.pending_orders:
                        continue
                    if ts not in symbol_indices[sym]:
                        continue

                    idx = symbol_indices[sym][ts]
                    arrs = symbol_arrays[sym]

                    sig = self.strategy.evaluate_entry(
                        candle_idx=idx,
                        opens=arrs['open'],
                        highs=arrs['high'],
                        lows=arrs['low'],
                        closes=arrs['close'],
                        ema_fast=arrs['ema_fast'],
                        ema_slow=arrs['ema_slow'],
                        rsi=arrs['rsi'],
                        atr=arrs['atr'],
                        adx=arrs['adx']
                    )

                    if sig.signal in ('BUY', 'SELL') and sig.direction is not None:
                        self.pending_orders[sym] = (sig, ts)

            # Record periodic equity history (every 4 hours = 16 bars)
            if step_idx % 16 == 0:
                unrealized_pnl = 0.0
                for s_sym, s_pos in self.positions.items():
                    if s_sym in symbol_indices and ts in symbol_indices[s_sym]:
                        c_idx = symbol_indices[s_sym][ts]
                        c_close = symbol_arrays[s_sym]['close'][c_idx]
                        if s_pos.side == 'LONG':
                            unrealized_pnl += s_pos.amount * (c_close - s_pos.entry_price)
                        else:
                            unrealized_pnl += s_pos.amount * (s_pos.entry_price - c_close)

                total_equity = self.capital + unrealized_pnl
                self.equity_history.append({
                    'timestamp': ts,
                    'datetime': dt_utc.isoformat(),
                    'capital': round(self.capital, 2),
                    'total_equity': round(total_equity, 2),
                    'open_positions': len(self.positions)
                })

            if step_idx > 0 and step_idx % 10000 == 0:
                print(f"  Processed {step_idx}/{total_steps} bars ({step_idx/total_steps*100:.1f}%) | Open Trades: {len(self.positions)} | Closed: {len(self.trade_log)} | Capital: ${self.capital:,.2f}", flush=True)

        return self.generate_metrics(ohlcv_dict)

    def generate_metrics(self, ohlcv_dict: Dict[str, pd.DataFrame]) -> Dict[str, Any]:
        trades_df = pd.DataFrame([t.__dict__ for t in self.trade_log])
        equity_df = pd.DataFrame(self.equity_history)

        os.makedirs("research/results", exist_ok=True)
        if not trades_df.empty:
            trades_df.to_csv("research/results/trade_log.csv", index=False)
        if not equity_df.empty:
            equity_df.to_csv("research/results/equity_curve.csv", index=False)

        total_trades = len(trades_df)
        if total_trades == 0:
            print("No trades generated during the backtest.")
            return {'total_trades': 0}

        wins = trades_df[trades_df['net_pnl'] > 0]
        losses = trades_df[trades_df['net_pnl'] < 0]
        decisive_trades = len(wins) + len(losses)
        win_rate = (len(wins) / decisive_trades) * 100.0 if decisive_trades > 0 else 0.0

        total_gross_profit = wins['net_pnl'].sum()
        total_gross_loss = abs(losses['net_pnl'].sum())
        profit_factor = (total_gross_profit / total_gross_loss) if total_gross_loss > 0 else np.nan

        avg_win = wins['net_pnl'].mean() if len(wins) > 0 else 0.0
        avg_loss = abs(losses['net_pnl'].mean()) if len(losses) > 0 else 0.0
        avg_r = trades_df['r_multiple'].mean()

        total_fees = trades_df['total_fees'].sum()
        total_slippage = trades_df['slippage_cost'].sum()
        total_funding = trades_df['funding_pnl'].sum()
        net_profit = self.capital - self.initial_capital
        total_return_pct = (net_profit / self.initial_capital) * 100.0

        # Equity Curve drawdown & CAGR
        equity_series = equity_df['total_equity']
        peak = equity_series.cummax()
        drawdown = (equity_series - peak) / peak
        max_drawdown_pct = abs(drawdown.min()) * 100.0

        # Duration & CAGR
        start_ts = equity_df['timestamp'].iloc[0]
        end_ts = equity_df['timestamp'].iloc[-1]
        years = max(0.1, (end_ts - start_ts) / (1000 * 365.25 * 86400))
        final_equity = equity_series.iloc[-1]
        cagr = ((final_equity / self.initial_capital) ** (1.0 / years) - 1.0) * 100.0

        # Sharpe & Sortino (annualized from 4h returns)
        returns_4h = equity_series.pct_change().dropna()
        ann_factor = np.sqrt(6 * 365) # 6 four-hour intervals per day * 365 days
        mean_ret = returns_4h.mean()
        std_ret = returns_4h.std()
        sharpe = (mean_ret / std_ret) * ann_factor if std_ret > 0 else 0.0

        downside_std = returns_4h[returns_4h < 0].std()
        sortino = (mean_ret / downside_std) * ann_factor if downside_std > 0 else 0.0

        # BTC Buy and Hold benchmark
        btc_df = ohlcv_dict.get('BTC_USDT')
        btc_return_pct = 0.0
        if btc_df is not None and not btc_df.empty:
            btc_start = btc_df['close'].iloc[0]
            btc_end = btc_df['close'].iloc[-1]
            btc_return_pct = ((btc_end - btc_start) / btc_start) * 100.0

        # Breakdowns
        playbook_breakdown = trades_df.groupby('setup_type').agg(
            trades=('symbol', 'count'),
            win_rate=('net_pnl', lambda x: (x > 0).mean() * 100.0),
            net_pnl=('net_pnl', 'sum'),
            profit_factor=('net_pnl', lambda x: (x[x > 0].sum() / abs(x[x < 0].sum())) if abs(x[x < 0].sum()) > 0 else np.nan),
            avg_r=('r_multiple', 'mean')
        ).reset_index()

        symbol_breakdown = trades_df.groupby('symbol').agg(
            trades=('symbol', 'count'),
            win_rate=('net_pnl', lambda x: (x > 0).mean() * 100.0),
            net_pnl=('net_pnl', 'sum'),
            profit_factor=('net_pnl', lambda x: (x[x > 0].sum() / abs(x[x < 0].sum())) if abs(x[x < 0].sum()) > 0 else np.nan),
            avg_r=('r_multiple', 'mean')
        ).reset_index()

        # Display summary
        print("\n" + "=" * 80)
        print("QUANTITATIVE STRATEGY BACKTEST RESULTS (2-YEAR SIMULATION)")
        print("=" * 80)
        print(f"Initial Capital:         ${self.initial_capital:,.2f}")
        print(f"Final Capital:           ${self.capital:,.2f}")
        print(f"Net Profit:              ${net_profit:,.2f} ({total_return_pct:+.2f}%)")
        print(f"CAGR:                    {cagr:.2f}%")
        print(f"Max Drawdown:            {max_drawdown_pct:.2f}%")
        print(f"Sharpe Ratio:            {sharpe:.2f}")
        print(f"Sortino Ratio:           {sortino:.2f}")
        print(f"Total Trades:            {total_trades}")
        print(f"Win Rate:                {win_rate:.2f}% ({len(wins)} W / {len(losses)} L)")
        print(f"Profit Factor:           {profit_factor:.2f}")
        print(f"Avg Expectancy (R):      {avg_r:+.2f} R")
        print(f"Avg Win / Avg Loss:      ${avg_win:,.2f} / ${avg_loss:,.2f}")
        print(f"Total Taker Fees:        ${total_fees:,.2f}")
        print(f"Total Slippage Incurred: ${total_slippage:,.2f}")
        print(f"Total Funding Payments:  ${total_funding:,.2f}")
        print("-" * 80)
        print(f"BENCHMARK (BTC Buy & Hold): {btc_return_pct:+.2f}%")
        print("=" * 80)

        print("\n--- PER-PLAYBOOK BREAKDOWN ---")
        print(playbook_breakdown.to_string(index=False))

        print("\n--- PER-SYMBOL BREAKDOWN ---")
        print(symbol_breakdown.to_string(index=False))

        return {
            'total_trades': total_trades,
            'win_rate': win_rate,
            'total_return_pct': total_return_pct,
            'cagr': cagr,
            'max_drawdown_pct': max_drawdown_pct,
            'sharpe': sharpe,
            'sortino': sortino,
            'profit_factor': profit_factor,
            'avg_r': avg_r,
            'btc_benchmark_pct': btc_return_pct,
            'playbook_breakdown': playbook_breakdown.to_dict('records'),
            'symbol_breakdown': symbol_breakdown.to_dict('records')
        }

def main():
    parser = argparse.ArgumentParser(description="Run realistic backtest on 15m historical crypto data")
    parser.add_argument("--capital", type=float, default=10000.0, help="Initial capital in USDT")
    parser.add_argument("--atr-mult", type=float, default=2.8, help="ATR trailing stop multiplier (default: 2.8)")
    parser.add_argument("--adx-thresh", type=float, default=20.0, help="ADX threshold (default: 20)")
    parser.add_argument("--fixed-risk", action="store_true", help="Risk fixed dollar amount of initial capital (prevents ruin contamination)")
    parser.add_argument("--no-stop-ruin", action="store_true", help="Do not stop when capital hits ruin threshold")
    args = parser.parse_args()

    engine = Backtester(
        initial_capital=args.capital,
        atr_multiplier=args.atr_mult,
        adx_threshold=args.adx_thresh,
        fixed_risk_mode=args.fixed_risk,
        stop_at_ruin=not args.no_stop_ruin
    )
    engine.run()

if __name__ == "__main__":
    main()
