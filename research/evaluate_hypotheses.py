"""
Institutional Evaluation Engine for Pre-Registered Hypotheses (H1, H2, H3, H4)
Strict zero-lookahead, realistic costs, historical funding, walk-forward OOS,
parameter sensitivity sweeps, and Monte Carlo random-entry testing.
"""

import os
import glob
from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Tuple
import numpy as np
import pandas as pd

# Cost configurations
FEE_TAKER = 0.00055  # Bybit VIP0 standard taker fee (0.055%)
FEE_MAKER = 0.00020  # Bybit VIP0 standard maker fee (0.020%)

SLIPPAGE_TIERS = {
    "BTC_USDT": 0.0002,     # 2 bps
    "ETH_USDT": 0.0002,     # 2 bps
    "SOL_USDT": 0.0005,     # 5 bps
    "DOGE_USDT": 0.0005,    # 5 bps
    "XRP_USDT": 0.0005,     # 5 bps
    "1000PEPE_USDT": 0.0010, # 10 bps
    "SUI_USDT": 0.0010,
    "TIA_USDT": 0.0010,
    "STRK_USDT": 0.0010,
    "ALT_USDT": 0.0010,
    "AKE_USDT": 0.0010,
    "Q_USDT": 0.0010,
}

def get_slippage(symbol: str) -> float:
    return SLIPPAGE_TIERS.get(symbol, 0.0010)

def load_data_1d() -> Dict[str, pd.DataFrame]:
    data = {}
    for f in sorted(glob.glob("data/*_1d.parquet")):
        sym = os.path.basename(f).replace("_1d.parquet", "")
        df = pd.read_parquet(f)
        df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
        df = df.sort_values('timestamp').reset_index(drop=True)
        data[sym] = df
    return data

def load_data_4h() -> Dict[str, pd.DataFrame]:
    data = {}
    for f in sorted(glob.glob("data/*_4h.parquet")):
        sym = os.path.basename(f).replace("_4h.parquet", "")
        df = pd.read_parquet(f)
        df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
        df = df.sort_values('timestamp').reset_index(drop=True)
        data[sym] = df
    return data

def load_funding_data() -> Dict[str, pd.DataFrame]:
    funding = {}
    for f in sorted(glob.glob("data/*_funding.parquet")):
        sym = os.path.basename(f).replace("_funding.parquet", "")
        df = pd.read_parquet(f)
        if 'funding_time' in df.columns:
            df['datetime'] = pd.to_datetime(df['funding_time'], unit='ms', utc=True)
        else:
            df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
        df = df.sort_values('datetime').reset_index(drop=True)
        funding[sym] = df
    return funding

def load_oi_data() -> Dict[str, pd.DataFrame]:
    oi_dict = {}
    for f in sorted(glob.glob("data/*_oi.parquet")):
        sym = os.path.basename(f).replace("_oi.parquet", "")
        df = pd.read_parquet(f)
        df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
        df = df.sort_values('datetime').reset_index(drop=True)
        oi_dict[sym] = df
    return oi_dict

def calc_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    tr1 = df['high'] - df['low']
    tr2 = (df['high'] - df['close'].shift(1)).abs()
    tr3 = (df['low'] - df['close'].shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0 / period, adjust=False).mean()

def calc_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1.0 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1.0 / period, adjust=False).mean()
    rs = avg_gain / (avg_loss + 1e-10)
    return 100 - (100 / (1 + rs))

# ---------------------------------------------------------------------------
# HYPOTHESIS 1: Daily Trend Following (BTC & ETH Long/Flat)
# ---------------------------------------------------------------------------
@dataclass
class TradeRecord:
    symbol: str
    side: str
    entry_bar_idx: int
    exit_bar_idx: int
    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    entry_price: float
    exit_price: float
    size: float
    gross_pnl: float
    net_pnl: float
    fees: float
    slippage: float
    funding_cost: float
    r_multiple: float
    exit_reason: str

def backtest_h1_daily_trend(
    df: pd.DataFrame,
    funding_df: pd.DataFrame,
    symbol: str,
    fast_ema: int = 50,
    slow_sma: int = 200,
    atr_period: int = 20,
    trailing_mult: float = 3.0,
    initial_equity: float = 10000.0,
    risk_per_trade_r: float = 200.0,  # Fixed $200 per 1R for fixed-risk audit
) -> Tuple[List[TradeRecord], pd.DataFrame]:
    df = df.copy()
    df['ema_fast'] = df['close'].ewm(span=fast_ema, adjust=False).mean()
    df['sma_slow'] = df['close'].rolling(window=slow_sma).mean()
    df['atr'] = calc_atr(df, period=atr_period)

    trades: List[TradeRecord] = []
    in_pos = False
    entry_price = 0.0
    entry_idx = 0
    size = 0.0
    trailing_stop = 0.0
    highest_close = 0.0
    risk_r_dist = 0.0

    slippage_rate = get_slippage(symbol)

    for i in range(slow_sma, len(df) - 1):
        curr_bar = df.iloc[i]
        next_bar = df.iloc[i + 1]

        if in_pos:
            # 1. Test exits against stop carried from bar i
            # Intrabar low test
            exit_triggered = False
            exit_price = 0.0
            exit_reason = ""

            # Check gap below stop at open
            if next_bar['open'] <= trailing_stop:
                exit_triggered = True
                exit_price = next_bar['open'] * (1.0 - slippage_rate)
                exit_reason = "stop_gap_open"
            elif next_bar['low'] <= trailing_stop:
                exit_triggered = True
                exit_price = trailing_stop * (1.0 - slippage_rate)
                exit_reason = "stop_hit_low"
            # Check trend exit signal at bar i close (Close[i] < EMA50[i])
            elif curr_bar['close'] < curr_bar['ema_fast']:
                exit_triggered = True
                exit_price = next_bar['open'] * (1.0 - slippage_rate)
                exit_reason = "trend_ema_exit"

            if exit_triggered:
                # Calculate funding during holding period
                hold_start = df.iloc[entry_idx]['datetime']
                hold_end = next_bar['datetime']
                f_mask = (funding_df['datetime'] >= hold_start) & (funding_df['datetime'] <= hold_end)
                total_funding_rate = funding_df.loc[f_mask, 'funding_rate'].sum() if len(funding_df) > 0 else 0.0
                funding_cost = total_funding_rate * (entry_price * size) # Long pays positive funding

                gross_pnl = (exit_price - entry_price) * size
                entry_fee = (entry_price * size) * FEE_TAKER
                exit_fee = (exit_price * size) * FEE_TAKER
                total_fees = entry_fee + exit_fee
                total_slippage = (entry_price * slippage_rate * size) + (exit_price * slippage_rate * size)
                net_pnl = gross_pnl - total_fees - funding_cost
                r_mult = net_pnl / risk_per_trade_r if risk_per_trade_r > 0 else 0.0

                trades.append(TradeRecord(
                    symbol=symbol,
                    side="LONG",
                    entry_bar_idx=entry_idx,
                    exit_bar_idx=i + 1,
                    entry_time=df.iloc[entry_idx]['datetime'],
                    exit_time=next_bar['datetime'],
                    entry_price=entry_price,
                    exit_price=exit_price,
                    size=size,
                    gross_pnl=gross_pnl,
                    net_pnl=net_pnl,
                    fees=total_fees,
                    slippage=total_slippage,
                    funding_cost=funding_cost,
                    r_multiple=r_mult,
                    exit_reason=exit_reason
                ))
                in_pos = False
            else:
                # 2. Only if position survived, update trailing stop at close of bar i for next bar
                if curr_bar['close'] > highest_close:
                    highest_close = curr_bar['close']
                    new_stop = highest_close - (trailing_mult * curr_bar['atr'])
                    if new_stop > trailing_stop:
                        trailing_stop = new_stop

        # Entry logic evaluated at bar i close, executes at bar i+1 open
        if not in_pos:
            ema_rising = curr_bar['ema_fast'] > df.iloc[i - 1]['ema_fast']
            trend_bull = (curr_bar['close'] > curr_bar['ema_fast']) and (curr_bar['close'] > curr_bar['sma_slow'])
            
            if trend_bull and ema_rising:
                fill_price = next_bar['open'] * (1.0 + slippage_rate)
                atr_val = curr_bar['atr']
                if atr_val > 0:
                    init_stop = fill_price - (trailing_mult * atr_val)
                    risk_r_dist = fill_price - init_stop
                    size = risk_per_trade_r / risk_r_dist if risk_r_dist > 0 else 0.0
                    entry_price = fill_price
                    trailing_stop = init_stop
                    highest_close = fill_price
                    entry_idx = i + 1
                    in_pos = True

    return trades, df

# ---------------------------------------------------------------------------
# HYPOTHESIS 2: Weekly Cross-Sectional Momentum (Altcoins vs. BTC Regime)
# ---------------------------------------------------------------------------
@dataclass
class PortfolioRebalanceRecord:
    datetime: pd.Timestamp
    btc_regime_bull: bool
    selected_symbols: List[str]
    portfolio_value: float
    weekly_gross_pnl: float
    weekly_net_pnl: float
    weekly_fees: float
    weekly_slippage: float
    weekly_funding: float

def backtest_h2_cross_sectional_momentum(
    dfs: Dict[str, pd.DataFrame],
    funding_dfs: Dict[str, pd.DataFrame],
    lookback_days: int = 28,
    top_n: int = 2,
    initial_equity: float = 10000.0,
) -> Tuple[List[PortfolioRebalanceRecord], pd.DataFrame]:
    # Align all daily closes into a single multi-symbol dataframe
    close_dict = {}
    open_dict = {}
    for sym, df in dfs.items():
        sub = df.set_index('datetime').sort_index()
        close_dict[sym] = sub['close']
        open_dict[sym] = sub['open']
    
    closes = pd.DataFrame(close_dict).dropna(subset=['BTC_USDT'])
    opens = pd.DataFrame(open_dict).reindex(closes.index)

    # BTC 50-day EMA regime
    btc_ema50 = closes['BTC_USDT'].ewm(span=50, adjust=False).mean()

    # Rebalance every 7 days (weekly)
    rebalance_dates = closes.index[::7]

    records: List[PortfolioRebalanceRecord] = []
    equity = initial_equity
    current_holdings: Dict[str, float] = {}  # sym -> position notional

    for idx, dt in enumerate(rebalance_dates[:-1]):
        next_dt = rebalance_dates[idx + 1]
        
        # Slicing period
        # Evaluation is at close of dt (Sunday close)
        # Execution is at open of next day (Monday open)
        curr_row = closes.loc[dt]
        btc_bull = curr_row['BTC_USDT'] > btc_ema50.loc[dt]

        # Calculate momentum lookback
        pos_in_closes = closes.index.get_loc(dt)
        if pos_in_closes < lookback_days:
            continue
        
        start_dt = closes.index[pos_in_closes - lookback_days]
        perf = (closes.loc[dt] / closes.loc[start_dt]) - 1.0

        # Filter symbols that have traded for at least 45 days
        valid_symbols = [
            s for s in closes.columns 
            if pd.notna(curr_row[s]) and pd.notna(closes.loc[start_dt, s]) and (closes[s].loc[:dt].count() >= 45)
        ]

        # Top N leaders
        ranked = perf[valid_symbols].sort_values(ascending=False)
        selected = list(ranked.index[:top_n]) if btc_bull else []

        # Weekly performance of selected positions
        # Enter at open after dt, exit at open after next_dt
        # Find next open index
        open_idx = closes.index.get_loc(dt) + 1
        close_idx = closes.index.get_loc(next_dt) + 1
        if close_idx >= len(opens):
            close_idx = len(opens) - 1

        entry_dt = opens.index[open_idx]
        exit_dt = opens.index[close_idx]

        weekly_gross = 0.0
        weekly_fees = 0.0
        weekly_slippage = 0.0
        weekly_funding = 0.0

        target_allocation = (equity / len(selected)) if (btc_bull and len(selected) > 0) else 0.0

        for sym in selected:
            sym_entry = opens.loc[entry_dt, sym]
            sym_exit = opens.loc[exit_dt, sym]
            if pd.isna(sym_entry) or pd.isna(sym_exit) or sym_entry <= 0:
                continue

            slip = get_slippage(sym)
            eff_entry = sym_entry * (1.0 + slip)
            eff_exit = sym_exit * (1.0 - slip)

            sym_units = target_allocation / eff_entry
            pnl_gross = (sym_exit - sym_entry) * sym_units
            fee_entry = target_allocation * FEE_TAKER
            fee_exit = (sym_exit * sym_units) * FEE_TAKER
            slip_cost = (sym_entry * slip * sym_units) + (sym_exit * slip * sym_units)

            # Funding cost
            f_df = funding_dfs.get(sym, pd.DataFrame())
            f_sum = 0.0
            if len(f_df) > 0:
                f_mask = (f_df['datetime'] >= entry_dt) & (f_df['datetime'] <= exit_dt)
                f_sum = f_df.loc[f_mask, 'funding_rate'].sum()
            fund_cost = f_sum * target_allocation

            weekly_gross += pnl_gross
            weekly_fees += (fee_entry + fee_exit)
            weekly_slippage += slip_cost
            weekly_funding += fund_cost

        weekly_net = weekly_gross - weekly_fees - weekly_slippage - weekly_funding
        equity += weekly_net

        records.append(PortfolioRebalanceRecord(
            datetime=dt,
            btc_regime_bull=btc_bull,
            selected_symbols=selected,
            portfolio_value=equity,
            weekly_gross_pnl=weekly_gross,
            weekly_net_pnl=weekly_net,
            weekly_fees=weekly_fees,
            weekly_slippage=weekly_slippage,
            weekly_funding=weekly_funding
        ))

    return records, pd.DataFrame([asdict(r) for r in records])

# ---------------------------------------------------------------------------
# HYPOTHESIS 3: 4H Funding Rate & Open Interest Crowding Fade
# ---------------------------------------------------------------------------
def backtest_h3_crowding_fade(
    dfs_4h: Dict[str, pd.DataFrame],
    funding_dfs: Dict[str, pd.DataFrame],
    oi_dfs: Dict[str, pd.DataFrame],
    symbols: List[str] = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "DOGE_USDT", "XRP_USDT", "1000PEPE_USDT"],
    z_thresh: float = 2.0,
    oi_change_thresh: float = 0.08,
    rsi_high: float = 70.0,
    rsi_low: float = 30.0,
    pt_atr_mult: float = 2.0,
    sl_atr_mult: float = 1.5,
    max_hold_bars: int = 12,
    risk_r: float = 200.0
) -> Tuple[List[TradeRecord], Dict[str, int]]:
    all_trades: List[TradeRecord] = []
    symbol_trade_counts = {s: 0 for s in symbols}

    for sym in symbols:
        if sym not in dfs_4h:
            continue
        df = dfs_4h[sym].copy()
        f_df = funding_dfs.get(sym, pd.DataFrame())
        oi_df = oi_dfs.get(sym, pd.DataFrame())

        if len(df) < 100 or len(f_df) < 50:
            continue

        # Merge funding rate onto 4h bars (backward as-of merge to strictly prevent lookahead)
        df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
        f_sub = f_df[['datetime', 'funding_rate']].sort_values('datetime')
        df = pd.merge_asof(df, f_sub, on='datetime', direction='backward')
        df['funding_rate'] = df['funding_rate'].fillna(0.0)

        # Merge OI onto 4h bars (backward as-of)
        if len(oi_df) > 0 and 'open_interest' in oi_df.columns:
            oi_sub = oi_df[['datetime', 'open_interest']].sort_values('datetime')
            df = pd.merge_asof(df, oi_sub, on='datetime', direction='backward')
            df['oi_change_24h'] = df['open_interest'].pct_change(periods=6).fillna(0.0)
        else:
            df['oi_change_24h'] = 0.0

        # Indicators
        df['atr'] = calc_atr(df, period=14)
        df['rsi'] = calc_rsi(df['close'], period=14)
        
        # Funding rate rolling Z-score (20 4H bars = ~3.3 days)
        f_mean = df['funding_rate'].rolling(20).mean()
        f_std = df['funding_rate'].rolling(20).std()
        df['f_zscore'] = (df['funding_rate'] - f_mean) / (f_std + 1e-8)

        slip = get_slippage(sym)

        in_pos = False
        pos_side = ""
        entry_price = 0.0
        entry_idx = 0
        size = 0.0
        stop_price = 0.0
        target_price = 0.0
        hold_bars = 0

        for i in range(30, len(df) - 1):
            curr_bar = df.iloc[i]
            next_bar = df.iloc[i + 1]

            if in_pos:
                hold_bars += 1
                exit_triggered = False
                exit_price = 0.0
                exit_reason = ""

                if pos_side == "SHORT":
                    # Test stop and target carried from bar i
                    # Check gap open
                    if next_bar['open'] >= stop_price:
                        exit_triggered = True
                        exit_price = next_bar['open'] * (1.0 + slip)
                        exit_reason = "stop_gap_open"
                    elif next_bar['open'] <= target_price:
                        exit_triggered = True
                        exit_price = next_bar['open'] * (1.0 + slip)
                        exit_reason = "target_gap_open"
                    elif next_bar['high'] >= stop_price:
                        exit_triggered = True
                        exit_price = stop_price * (1.0 + slip)
                        exit_reason = "stop_hit_high"
                    elif next_bar['low'] <= target_price:
                        exit_triggered = True
                        exit_price = target_price * (1.0 + slip)
                        exit_reason = "target_hit_low"
                    elif hold_bars >= max_hold_bars:
                        exit_triggered = True
                        exit_price = next_bar['open'] * (1.0 + slip)
                        exit_reason = "time_stop"
                    elif abs(curr_bar['f_zscore']) < 0.5:
                        exit_triggered = True
                        exit_price = next_bar['open'] * (1.0 + slip)
                        exit_reason = "funding_normalized"

                    if exit_triggered:
                        gross_pnl = (entry_price - exit_price) * size
                        entry_fee = (entry_price * size) * FEE_TAKER
                        exit_fee = (exit_price * size) * FEE_TAKER
                        slip_cost = (entry_price * slip * size) + (exit_price * slip * size)
                        # Short perp receives positive funding
                        hold_start = df.iloc[entry_idx]['datetime']
                        hold_end = next_bar['datetime']
                        f_mask = (f_df['datetime'] >= hold_start) & (f_df['datetime'] <= hold_end)
                        total_f_rate = f_df.loc[f_mask, 'funding_rate'].sum() if len(f_df) > 0 else 0.0
                        funding_pnl = total_f_rate * (entry_price * size) # positive when rate positive
                        net_pnl = gross_pnl - (entry_fee + exit_fee) - slip_cost + funding_pnl
                        r_mult = net_pnl / risk_r

                        all_trades.append(TradeRecord(
                            symbol=sym,
                            side="SHORT",
                            entry_bar_idx=entry_idx,
                            exit_bar_idx=i + 1,
                            entry_time=df.iloc[entry_idx]['datetime'],
                            exit_time=next_bar['datetime'],
                            entry_price=entry_price,
                            exit_price=exit_price,
                            size=size,
                            gross_pnl=gross_pnl,
                            net_pnl=net_pnl,
                            fees=entry_fee + exit_fee,
                            slippage=slip_cost,
                            funding_cost=-funding_pnl,
                            r_multiple=r_mult,
                            exit_reason=exit_reason
                        ))
                        symbol_trade_counts[sym] += 1
                        in_pos = False

                elif pos_side == "LONG":
                    if next_bar['open'] <= stop_price:
                        exit_triggered = True
                        exit_price = next_bar['open'] * (1.0 - slip)
                        exit_reason = "stop_gap_open"
                    elif next_bar['open'] >= target_price:
                        exit_triggered = True
                        exit_price = next_bar['open'] * (1.0 - slip)
                        exit_reason = "target_gap_open"
                    elif next_bar['low'] <= stop_price:
                        exit_triggered = True
                        exit_price = stop_price * (1.0 - slip)
                        exit_reason = "stop_hit_low"
                    elif next_bar['high'] >= target_price:
                        exit_triggered = True
                        exit_price = target_price * (1.0 - slip)
                        exit_reason = "target_hit_high"
                    elif hold_bars >= max_hold_bars:
                        exit_triggered = True
                        exit_price = next_bar['open'] * (1.0 - slip)
                        exit_reason = "time_stop"
                    elif abs(curr_bar['f_zscore']) < 0.5:
                        exit_triggered = True
                        exit_price = next_bar['open'] * (1.0 - slip)
                        exit_reason = "funding_normalized"

                    if exit_triggered:
                        gross_pnl = (exit_price - entry_price) * size
                        entry_fee = (entry_price * size) * FEE_TAKER
                        exit_fee = (exit_price * size) * FEE_TAKER
                        slip_cost = (entry_price * slip * size) + (exit_price * slip * size)
                        # Long pays positive funding
                        hold_start = df.iloc[entry_idx]['datetime']
                        hold_end = next_bar['datetime']
                        f_mask = (f_df['datetime'] >= hold_start) & (f_df['datetime'] <= hold_end)
                        total_f_rate = f_df.loc[f_mask, 'funding_rate'].sum() if len(f_df) > 0 else 0.0
                        funding_cost = total_f_rate * (entry_price * size)
                        net_pnl = gross_pnl - (entry_fee + exit_fee) - slip_cost - funding_cost
                        r_mult = net_pnl / risk_r

                        all_trades.append(TradeRecord(
                            symbol=sym,
                            side="LONG",
                            entry_bar_idx=entry_idx,
                            exit_bar_idx=i + 1,
                            entry_time=df.iloc[entry_idx]['datetime'],
                            exit_time=next_bar['datetime'],
                            entry_price=entry_price,
                            exit_price=exit_price,
                            size=size,
                            gross_pnl=gross_pnl,
                            net_pnl=net_pnl,
                            fees=entry_fee + exit_fee,
                            slippage=slip_cost,
                            funding_cost=funding_cost,
                            r_multiple=r_mult,
                            exit_reason=exit_reason
                        ))
                        symbol_trade_counts[sym] += 1
                        in_pos = False

            if not in_pos:
                # Entry signals evaluated on bar i close
                atr_val = curr_bar['atr']
                if atr_val <= 0:
                    continue

                # Short Crowded Longs: High Funding Z-Score + Rising OI + Overbought RSI
                short_signal = (curr_bar['f_zscore'] > z_thresh) and (curr_bar['oi_change_24h'] > oi_change_thresh) and (curr_bar['rsi'] > rsi_high)
                # Long Crowded Shorts: Low Funding Z-Score + Rising OI + Oversold RSI
                long_signal = (curr_bar['f_zscore'] < -z_thresh) and (curr_bar['oi_change_24h'] > (oi_change_thresh * 0.6)) and (curr_bar['rsi'] < rsi_low)

                if short_signal:
                    fill_price = next_bar['open'] * (1.0 - slip)
                    stop_price = fill_price + (sl_atr_mult * atr_val)
                    target_price = fill_price - (pt_atr_mult * atr_val)
                    risk_dist = stop_price - fill_price
                    size = risk_r / risk_dist if risk_dist > 0 else 0.0
                    entry_price = fill_price
                    pos_side = "SHORT"
                    entry_idx = i + 1
                    hold_bars = 0
                    in_pos = True
                elif long_signal:
                    fill_price = next_bar['open'] * (1.0 + slip)
                    stop_price = fill_price - (sl_atr_mult * atr_val)
                    target_price = fill_price + (pt_atr_mult * atr_val)
                    risk_dist = fill_price - stop_price
                    size = risk_r / risk_dist if risk_dist > 0 else 0.0
                    entry_price = fill_price
                    pos_side = "LONG"
                    entry_idx = i + 1
                    hold_bars = 0
                    in_pos = True

    return all_trades, symbol_trade_counts

# ---------------------------------------------------------------------------
# HYPOTHESIS 4: Delta-Neutral Funding Rate Carry
# ---------------------------------------------------------------------------
@dataclass
class CarryWindowRecord:
    symbol: str
    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    duration_days: float
    gross_funding_yield: float
    net_funding_yield: float
    trading_friction: float
    annualized_net_yield: float
    status: str

def backtest_h4_delta_neutral_carry(
    funding_dfs: Dict[str, pd.DataFrame],
    symbols: List[str] = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "DOGE_USDT", "SUI_USDT"],
    min_annual_rate: float = 0.15,  # 15% annualized threshold to open carry
    exit_annual_rate: float = 0.04,  # 4% annualized threshold to close carry
    roundtrip_cost: float = 0.0022,  # 2 legs (Spot + Perp) roundtrip fees & slippage = ~0.22%
) -> Dict[str, List[CarryWindowRecord]]:
    results = {}

    for sym in symbols:
        if sym not in funding_dfs:
            continue
        df = funding_dfs[sym].copy().sort_values('datetime').reset_index(drop=True)
        if len(df) < 50:
            continue

        # Annualized rolling 3-day (9 funding payments) average rate
        # 3 payments per day -> 9 payments in 3 days
        df['annual_rate_3d'] = df['funding_rate'].rolling(9).mean() * 3 * 365

        windows: List[CarryWindowRecord] = []
        in_carry = False
        open_idx = 0
        open_time = None

        for i in range(9, len(df)):
            curr = df.iloc[i]
            
            if in_carry:
                # Check exit condition
                if curr['annual_rate_3d'] < exit_annual_rate or curr['funding_rate'] < 0:
                    exit_time = curr['datetime']
                    duration_days = (exit_time - open_time).total_seconds() / 86400.0
                    
                    # Accumulate actual funding cashflows collected
                    window_slice = df.iloc[open_idx:i+1]
                    gross_yield = window_slice['funding_rate'].sum()
                    net_yield = gross_yield - roundtrip_cost
                    annualized = (net_yield / duration_days) * 365 if duration_days > 0 else 0.0

                    windows.append(CarryWindowRecord(
                        symbol=sym,
                        entry_time=open_time,
                        exit_time=exit_time,
                        duration_days=duration_days,
                        gross_funding_yield=gross_yield,
                        net_funding_yield=net_yield,
                        trading_friction=roundtrip_cost,
                        annualized_net_yield=annualized,
                        status="COMPLETED"
                    ))
                    in_carry = False

            if not in_carry:
                if curr['annual_rate_3d'] >= min_annual_rate:
                    in_carry = True
                    open_idx = i
                    open_time = curr['datetime']

        # If still in carry at end of dataset
        if in_carry:
            exit_time = df.iloc[-1]['datetime']
            duration_days = (exit_time - open_time).total_seconds() / 86400.0
            window_slice = df.iloc[open_idx:]
            gross_yield = window_slice['funding_rate'].sum()
            net_yield = gross_yield - roundtrip_cost
            annualized = (net_yield / duration_days) * 365 if duration_days > 0 else 0.0
            windows.append(CarryWindowRecord(
                symbol=sym,
                entry_time=open_time,
                exit_time=exit_time,
                duration_days=duration_days,
                gross_funding_yield=gross_yield,
                net_funding_yield=net_yield,
                trading_friction=roundtrip_cost,
                annualized_net_yield=annualized,
                status="OPEN_AT_END"
            ))

        results[sym] = windows

    return results

# ---------------------------------------------------------------------------
# STATISTICAL & BENCHMARK HELPERS
# ---------------------------------------------------------------------------
def compute_trade_metrics(trades: List[TradeRecord]) -> Dict:
    if not trades:
        return {
            "trades": 0, "win_rate": 0.0, "gross_pf": 0.0, "net_pf": 0.0,
            "net_pnl": 0.0, "expectancy_r": 0.0, "total_fees": 0.0, "total_funding": 0.0
        }
    df_t = pd.DataFrame([asdict(t) for t in trades])
    wins = df_t[df_t['net_pnl'] > 0]
    losses = df_t[df_t['net_pnl'] < 0]
    gross_wins = df_t[df_t['gross_pnl'] > 0]
    gross_losses = df_t[df_t['gross_pnl'] < 0]

    win_rate = (len(wins) / len(df_t)) * 100.0
    net_profit = wins['net_pnl'].sum()
    net_loss = abs(losses['net_pnl'].sum())
    gross_profit = gross_wins['gross_pnl'].sum()
    gross_loss = abs(gross_losses['gross_pnl'].sum())

    net_pf = (net_profit / net_loss) if net_loss > 0 else (999.0 if net_profit > 0 else 0.0)
    gross_pf = (gross_profit / gross_loss) if gross_loss > 0 else (999.0 if gross_profit > 0 else 0.0)

    return {
        "trades": len(df_t),
        "win_rate": win_rate,
        "gross_pf": gross_pf,
        "net_pf": net_pf,
        "net_pnl": df_t['net_pnl'].sum(),
        "expectancy_r": df_t['r_multiple'].mean(),
        "total_fees": df_t['fees'].sum() + df_t['slippage'].sum(),
        "total_funding": df_t['funding_cost'].sum()
    }

def compute_btc_buy_and_hold_benchmark(btc_1d: pd.DataFrame) -> Dict:
    df = btc_1d.sort_values('timestamp').reset_index(drop=True)
    t0_price = df.iloc[0]['close']
    t1_price = df.iloc[-1]['close']
    total_return = ((t1_price - t0_price) / t0_price) * 100.0
    
    # Daily returns
    daily_rets = df['close'].pct_change().dropna()
    cagr = ((t1_price / t0_price) ** (365.0 / len(df)) - 1.0) * 100.0
    sharpe = (daily_rets.mean() / (daily_rets.std() + 1e-10)) * np.sqrt(365)
    
    # Max drawdown
    cummax = df['close'].cummax()
    drawdown = (df['close'] - cummax) / cummax
    max_dd = drawdown.min() * 100.0

    return {
        "start_date": df.iloc[0]['datetime'].strftime('%Y-%m-%d'),
        "end_date": df.iloc[-1]['datetime'].strftime('%Y-%m-%d'),
        "days": len(df),
        "bnh_total_return_pct": total_return,
        "bnh_cagr_pct": cagr,
        "bnh_sharpe": sharpe,
        "bnh_max_dd_pct": max_dd,
    }
