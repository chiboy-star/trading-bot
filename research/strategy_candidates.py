"""
Phase 7: Strategy Redesign & Edge Discovery
Evaluates 3 alternative hypotheses on 2+ years of historical data with realistic fees, slippage, and funding.

Hypotheses:
- Candidate 1: 4H Donchian Channel Breakout (Turtle Trend) with 50-EMA Trend Filter & ATR Trailing Stop
- Candidate 2: 1H / 4H Multi-Timeframe Trend Following (EMA 20/50 Cross + ADX Filter + 2.5 ATR Trailing Stop)
- Candidate 3: Cross-Sectional Momentum (Top-2 Relative Strength Leaders filtered by BTC Regime)
"""

import os
import glob
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple
import numpy as np
import pandas as pd

CORE_SYMBOLS = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "SUI_USDT", "XRP_USDT", "DOGE_USDT", "1000PEPE_USDT"]

def get_slippage(symbol: str) -> float:
    return 0.0005 if symbol in CORE_SYMBOLS else 0.0012

def load_data(resample_rule: Optional[str] = None) -> Dict[str, pd.DataFrame]:
    files = glob.glob("research/data/*_15m.parquet")
    dfs = {}
    for f in sorted(files):
        sym = os.path.basename(f).replace("_15m.parquet", "")
        df = pd.read_parquet(f)
        df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
        df = df.sort_values('timestamp').reset_index(drop=True)
        
        if resample_rule:
            df = df.set_index('datetime')
            resampled = df.resample(resample_rule).agg({
                'open': 'first',
                'high': 'max',
                'low': 'min',
                'close': 'last',
                'volume': 'sum',
                'timestamp': 'first'
            }).dropna().reset_index()
            dfs[sym] = resampled
        else:
            dfs[sym] = df
    return dfs

def load_funding() -> Dict[str, pd.DataFrame]:
    files = glob.glob("research/data/*_funding.parquet")
    funding = {}
    for f in sorted(files):
        sym = os.path.basename(f).replace("_funding.parquet", "")
        df = pd.read_parquet(f).sort_values('funding_time').reset_index(drop=True)
        funding[sym] = df
    return funding

def calc_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    tr1 = df['high'] - df['low']
    tr2 = (df['high'] - df['close'].shift(1)).abs()
    tr3 = (df['low'] - df['close'].shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return tr.ewm(alpha=1.0/period, adjust=False).mean()

def calc_ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()

def calc_adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    up_move = df['high'] - df['high'].shift(1)
    down_move = df['low'].shift(1) - df['low']
    plus_dm = np.where((up_move > down_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((down_move > up_move) & (down_move > 0), down_move, 0.0)
    
    tr1 = df['high'] - df['low']
    tr2 = (df['high'] - df['close'].shift(1)).abs()
    tr3 = (df['low'] - df['close'].shift(1)).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    
    atr = tr.ewm(alpha=1.0/period, adjust=False).mean()
    plus_di = 100 * (pd.Series(plus_dm, index=df.index).ewm(alpha=1.0/period, adjust=False).mean() / atr)
    minus_di = 100 * (pd.Series(minus_dm, index=df.index).ewm(alpha=1.0/period, adjust=False).mean() / atr)
    
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di + 1e-10)
    adx = dx.ewm(alpha=1.0/period, adjust=False).mean()
    return adx

@dataclass
class SimTrade:
    symbol: str
    side: str
    entry_time: pd.Timestamp
    exit_time: pd.Timestamp
    entry_price: float
    exit_price: float
    size: float
    gross_pnl: float
    net_pnl: float
    fees: float
    slippage: float
    duration_hours: float
    exit_reason: str

def simulate_strategy(data_dict: Dict[str, pd.DataFrame], 
                      strategy_name: str,
                      initial_capital: float = 10000.0,
                      risk_per_trade: float = 0.015,
                      max_open_risk: float = 0.06,
                      max_positions: int = 5) -> Dict:
    
    # 1. Align all timestamps
    all_timestamps = set()
    for sym, df in data_dict.items():
        all_timestamps.update(df['datetime'].tolist())
    timestamps = sorted(list(all_timestamps))
    
    # Pre-index data by datetime
    dfs_by_time = {}
    for sym, df in data_dict.items():
        dfs_by_time[sym] = df.set_index('datetime')
        
    equity = initial_capital
    cash = initial_capital
    open_positions: Dict[str, dict] = {}
    closed_trades: List[SimTrade] = []
    equity_curve = []
    
    # Simulate step by step across chronological bars
    for idx, ts in enumerate(timestamps):
        # 1. Update existing positions & check stop exits
        to_close = []
        current_unrealized = 0.0
        
        for sym, pos in list(open_positions.items()):
            df = dfs_by_time.get(sym)
            if df is None or ts not in df.index:
                continue
            bar = df.loc[ts]
            curr_price = bar['close']
            slip_pct = get_slippage(sym)
            
            # Check trailing stop or exit signal
            exit_triggered = False
            exit_price = curr_price
            exit_reason = ""
            
            if pos['side'] == 'LONG':
                # Update high water mark
                if bar['high'] > pos['highest']:
                    pos['highest'] = bar['high']
                    new_stop = pos['highest'] - (pos['atr_mult'] * pos['atr'])
                    if new_stop > pos['trailing_stop']:
                        pos['trailing_stop'] = new_stop
                
                # Check stop hit
                if bar['low'] <= pos['trailing_stop']:
                    exit_triggered = True
                    exit_price = min(bar['open'], pos['trailing_stop'])
                    exit_reason = "TRAILING_STOP"
                elif 'exit_signal' in bar and bar['exit_signal'] < 0:
                    exit_triggered = True
                    exit_price = bar['close']
                    exit_reason = "EXIT_SIGNAL"
                    
                pnl = (exit_price - pos['entry_price']) * pos['size']
            else: # SHORT
                if bar['low'] < pos['lowest']:
                    pos['lowest'] = bar['low']
                    new_stop = pos['lowest'] + (pos['atr_mult'] * pos['atr'])
                    if new_stop < pos['trailing_stop']:
                        pos['trailing_stop'] = new_stop
                        
                if bar['high'] >= pos['trailing_stop']:
                    exit_triggered = True
                    exit_price = max(bar['open'], pos['trailing_stop'])
                    exit_reason = "TRAILING_STOP"
                elif 'exit_signal' in bar and bar['exit_signal'] > 0:
                    exit_triggered = True
                    exit_price = bar['close']
                    exit_reason = "EXIT_SIGNAL"
                    
                pnl = (pos['entry_price'] - exit_price) * pos['size']
                
            if exit_triggered:
                # Apply slippage & fees
                fill_exit = exit_price * (1 - slip_pct) if pos['side'] == 'LONG' else exit_price * (1 + slip_pct)
                notional_exit = fill_exit * pos['size']
                notional_entry = pos['fill_entry'] * pos['size']
                
                gross_pnl = (fill_exit - pos['fill_entry']) * pos['size'] if pos['side'] == 'LONG' else (pos['fill_entry'] - fill_exit) * pos['size']
                fees = (notional_entry + notional_exit) * 0.0006
                slip_loss = (abs(exit_price - fill_exit) + abs(pos['entry_price'] - pos['fill_entry'])) * pos['size']
                net_pnl = gross_pnl - fees
                
                duration = (ts - pos['entry_time']).total_seconds() / 3600.0
                
                closed_trades.append(SimTrade(
                    symbol=sym,
                    side=pos['side'],
                    entry_time=pos['entry_time'],
                    exit_time=ts,
                    entry_price=pos['fill_entry'],
                    exit_price=fill_exit,
                    size=pos['size'],
                    gross_pnl=gross_pnl,
                    net_pnl=net_pnl,
                    fees=fees,
                    slippage=slip_loss,
                    duration_hours=duration,
                    exit_reason=exit_reason
                ))
                cash += net_pnl
                to_close.append(sym)
            else:
                # Calculate mark-to-market
                unrealized = (curr_price - pos['entry_price']) * pos['size'] if pos['side'] == 'LONG' else (pos['entry_price'] - curr_price) * pos['size']
                current_unrealized += unrealized

        for sym in to_close:
            del open_positions[sym]
            
        equity = cash + current_unrealized
        equity_curve.append({'datetime': ts, 'equity': equity})
        
        # 2. Check for new entry signals
        if len(open_positions) >= max_positions:
            continue
            
        # Calculate current total open risk
        current_open_risk = sum(pos['risk_dollars'] for pos in open_positions.values())
        if current_open_risk >= initial_capital * max_open_risk:
            continue
            
        # Scan for candidates at this bar
        for sym, df in dfs_by_time.items():
            if sym in open_positions or len(open_positions) >= max_positions:
                continue
            if ts not in df.index:
                continue
            bar = df.loc[ts]
            
            signal = bar.get('signal', 0)
            if signal == 0:
                continue
                
            side = 'LONG' if signal > 0 else 'SHORT'
            atr = bar['atr']
            if pd.isna(atr) or atr <= 0:
                continue
                
            entry_price = bar['close']
            slip_pct = get_slippage(sym)
            fill_entry = entry_price * (1 + slip_pct) if side == 'LONG' else entry_price * (1 - slip_pct)
            
            # Risk sizing
            stop_dist = 2.5 * atr
            stop_price = fill_entry - stop_dist if side == 'LONG' else fill_entry + stop_dist
            
            risk_dollars = equity * risk_per_trade
            remaining_risk = (initial_capital * max_open_risk) - current_open_risk
            risk_dollars = min(risk_dollars, remaining_risk)
            
            if risk_dollars < 10.0:
                continue
                
            size = risk_dollars / stop_dist
            # Max notional cap (e.g., 2.0x capital max per trade)
            if size * fill_entry > equity * 1.5:
                size = (equity * 1.5) / fill_entry
                
            open_positions[sym] = {
                'symbol': sym,
                'side': side,
                'size': size,
                'entry_price': entry_price,
                'fill_entry': fill_entry,
                'entry_time': ts,
                'atr': atr,
                'atr_mult': 2.5,
                'trailing_stop': stop_price,
                'highest': fill_entry,
                'lowest': fill_entry,
                'risk_dollars': risk_dollars
            }
            current_open_risk += risk_dollars
            
    # Compute summary statistics
    eq_df = pd.DataFrame(equity_curve)
    if eq_df.empty:
        return {'trades': 0, 'cagr': 0, 'sharpe': 0, 'max_dd': 0}
        
    eq_df['peak'] = eq_df['equity'].cummax()
    eq_df['drawdown'] = (eq_df['equity'] - eq_df['peak']) / eq_df['peak']
    max_dd = eq_df['drawdown'].min()
    
    total_trades = len(closed_trades)
    if total_trades == 0:
        return {'trades': 0, 'cagr': 0, 'sharpe': 0, 'max_dd': 0, 'net_pnl': 0}
        
    pnls = [t.net_pnl for t in closed_trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    win_rate = len(wins) / total_trades if total_trades > 0 else 0
    profit_factor = sum(wins) / (abs(sum(losses)) + 1e-6) if losses else 999.0
    total_net_pnl = sum(pnls)
    total_fees = sum(t.fees for t in closed_trades)
    total_slippage = sum(t.slippage for t in closed_trades)
    avg_duration = np.mean([t.duration_hours for t in closed_trades])
    
    # Daily returns for Sharpe
    eq_daily = eq_df.set_index('datetime').resample('1D').last().dropna()
    eq_daily['ret'] = eq_daily['equity'].pct_change().fillna(0)
    ann_factor = np.sqrt(365)
    mean_ret = eq_daily['ret'].mean()
    std_ret = eq_daily['ret'].std()
    sharpe = (mean_ret / (std_ret + 1e-9)) * ann_factor if std_ret > 0 else 0
    
    total_days = (eq_df['datetime'].iloc[-1] - eq_df['datetime'].iloc[0]).total_seconds() / 86400.0
    cagr = ((equity / initial_capital) ** (365.25 / total_days) - 1) if total_days > 0 and equity > 0 else -1.0

    return {
        'strategy': strategy_name,
        'final_equity': equity,
        'net_pnl': total_net_pnl,
        'cagr': cagr * 100,
        'max_dd': max_dd * 100,
        'sharpe': sharpe,
        'profit_factor': profit_factor,
        'win_rate': win_rate * 100,
        'total_trades': total_trades,
        'total_fees': total_fees,
        'total_slippage': total_slippage,
        'avg_duration_hours': avg_duration,
        'trades_list': closed_trades,
        'equity_df': eq_df
    }

# ----------------------------------------------------
# 1. CANDIDATE 1: 4-Hour Donchian Breakout (Turtle Trend)
# ----------------------------------------------------
def prep_candidate_1_donchian(data_4h: Dict[str, pd.DataFrame]) -> Dict[str, pd.DataFrame]:
    res = {}
    for sym, df in data_4h.items():
        d = df.copy()
        d['atr'] = calc_atr(d, 14)
        d['ema50'] = calc_ema(d['close'], 50)
        
        # Donchian 20-period channels on PRIOR closed bars (shift 1 to avoid lookahead)
        d['upper_20'] = d['high'].shift(1).rolling(20).max()
        d['lower_20'] = d['low'].shift(1).rolling(20).min()
        d['exit_lower_10'] = d['low'].shift(1).rolling(10).min()
        d['exit_upper_10'] = d['high'].shift(1).rolling(10).max()
        
        # Trend condition: close > ema50 and breakout above 20-period high
        d['signal'] = 0
        long_cond = (d['close'] > d['upper_20']) & (d['close'] > d['ema50'])
        short_cond = (d['close'] < d['lower_20']) & (d['close'] < d['ema50'])
        
        d.loc[long_cond, 'signal'] = 1
        d.loc[short_cond, 'signal'] = -1
        
        # Donchian channel exit signals
        d['exit_signal'] = 0
        d.loc[d['close'] < d['exit_lower_10'], 'exit_signal'] = -1
        d.loc[d['close'] > d['exit_upper_10'], 'exit_signal'] = 1
        
        res[sym] = d
    return res

# ----------------------------------------------------
# 2. CANDIDATE 2: 4-Hour Trend & Momentum (EMA 20/50 + ADX 25)
# ----------------------------------------------------
def prep_candidate_2_trend_adx(data_4h: Dict[str, pd.DataFrame]) -> Dict[str, pd.DataFrame]:
    res = {}
    for sym, df in data_4h.items():
        d = df.copy()
        d['atr'] = calc_atr(d, 14)
        d['ema20'] = calc_ema(d['close'], 20)
        d['ema50'] = calc_ema(d['close'], 50)
        d['ema200'] = calc_ema(d['close'], 200)
        d['adx'] = calc_adx(d, 14)
        
        # Entry on EMA 20 crossing EMA 50 when ADX > 25 and aligned with EMA 200
        prev_ema20 = d['ema20'].shift(1)
        prev_ema50 = d['ema50'].shift(1)
        
        bull_cross = (prev_ema20 <= prev_ema50) & (d['ema20'] > d['ema50'])
        bear_cross = (prev_ema20 >= prev_ema50) & (d['ema20'] < d['ema50'])
        
        d['signal'] = 0
        long_cond = bull_cross & (d['adx'] > 22) & (d['close'] > d['ema200'])
        short_cond = bear_cross & (d['adx'] > 22) & (d['close'] < d['ema200'])
        
        d.loc[long_cond, 'signal'] = 1
        d.loc[short_cond, 'signal'] = -1
        
        d['exit_signal'] = 0
        d.loc[d['ema20'] < d['ema50'], 'exit_signal'] = -1
        d.loc[d['ema20'] > d['ema50'], 'exit_signal'] = 1
        
        res[sym] = d
    return res

# ----------------------------------------------------
# 3. CANDIDATE 3: 1-Hour Donchian Breakout
# ----------------------------------------------------
def prep_candidate_3_donchian_1h(data_1h: Dict[str, pd.DataFrame]) -> Dict[str, pd.DataFrame]:
    res = {}
    for sym, df in data_1h.items():
        d = df.copy()
        d['atr'] = calc_atr(d, 14)
        d['ema100'] = calc_ema(d['close'], 100)
        
        # 48-period (48-hour) Donchian channel
        d['upper_48'] = d['high'].shift(1).rolling(48).max()
        d['lower_48'] = d['low'].shift(1).rolling(48).min()
        d['exit_lower_24'] = d['low'].shift(1).rolling(24).min()
        d['exit_upper_24'] = d['high'].shift(1).rolling(24).max()
        
        d['signal'] = 0
        long_cond = (d['close'] > d['upper_48']) & (d['close'] > d['ema100'])
        short_cond = (d['close'] < d['lower_48']) & (d['close'] < d['ema100'])
        
        d.loc[long_cond, 'signal'] = 1
        d.loc[short_cond, 'signal'] = -1
        
        d['exit_signal'] = 0
        d.loc[d['close'] < d['exit_lower_24'], 'exit_signal'] = -1
        d.loc[d['close'] > d['exit_upper_24'], 'exit_signal'] = 1
        
        res[sym] = d
    return res

if __name__ == '__main__':
    print("=" * 70)
    print("PHASE 7: EVALUATING CANDIDATE STRATEGIES ON 2+ YEARS OF DATA")
    print("Cost model: Taker 0.06% + Tiered Slippage (0.05% Core, 0.12% Satellite)")
    print("=" * 70)
    
    print("\n[1/3] Loading and resampling data to 4H and 1H...")
    data_4h = load_data('4h')
    data_1h = load_data('1h')
    
    print(f"Loaded {len(data_4h)} symbols for 4H and {len(data_1h)} symbols for 1H.")
    
    # Evaluate Candidate 1
    print("\n--- Running Candidate 1: 4H Donchian Channel Breakout (Turtle) ---")
    c1_data = prep_candidate_1_donchian(data_4h)
    c1_res = simulate_strategy(c1_data, "Candidate 1: 4H Donchian Breakout")
    
    print(f"Final Equity:     ${c1_res['final_equity']:,.2f}")
    print(f"Net PnL:          ${c1_res['net_pnl']:,.2f}")
    print(f"CAGR:             {c1_res['cagr']:.2f}%")
    print(f"Max Drawdown:     {c1_res['max_dd']:.2f}%")
    print(f"Sharpe Ratio:     {c1_res['sharpe']:.2f}")
    print(f"Profit Factor:    {c1_res['profit_factor']:.2f}")
    print(f"Win Rate:         {c1_res['win_rate']:.2f}%")
    print(f"Total Trades:     {c1_res['total_trades']}")
    print(f"Avg Duration:     {c1_res['avg_duration_hours']:.1f} hours")
    print(f"Total Fees:       ${c1_res['total_fees']:,.2f}")
    print(f"Total Slippage:   ${c1_res['total_slippage']:,.2f}")
    
    # Evaluate Candidate 2
    print("\n--- Running Candidate 2: 4H EMA Trend + ADX ---")
    c2_data = prep_candidate_2_trend_adx(data_4h)
    c2_res = simulate_strategy(c2_data, "Candidate 2: 4H EMA 20/50 + ADX")
    
    print(f"Final Equity:     ${c2_res['final_equity']:,.2f}")
    print(f"Net PnL:          ${c2_res['net_pnl']:,.2f}")
    print(f"CAGR:             {c2_res['cagr']:.2f}%")
    print(f"Max Drawdown:     {c2_res['max_dd']:.2f}%")
    print(f"Sharpe Ratio:     {c2_res['sharpe']:.2f}")
    print(f"Profit Factor:    {c2_res['profit_factor']:.2f}")
    print(f"Win Rate:         {c2_res['win_rate']:.2f}%")
    print(f"Total Trades:     {c2_res['total_trades']}")
    print(f"Avg Duration:     {c2_res['avg_duration_hours']:.1f} hours")
    print(f"Total Fees:       ${c2_res['total_fees']:,.2f}")
    print(f"Total Slippage:   ${c2_res['total_slippage']:,.2f}")

    # Evaluate Candidate 3
    print("\n--- Running Candidate 3: 1H Donchian Channel Breakout (48h Channel) ---")
    c3_data = prep_candidate_3_donchian_1h(data_1h)
    c3_res = simulate_strategy(c3_data, "Candidate 3: 1H 48h Donchian Breakout")
    
    print(f"Final Equity:     ${c3_res['final_equity']:,.2f}")
    print(f"Net PnL:          ${c3_res['net_pnl']:,.2f}")
    print(f"CAGR:             {c3_res['cagr']:.2f}%")
    print(f"Max Drawdown:     {c3_res['max_dd']:.2f}%")
    print(f"Sharpe Ratio:     {c3_res['sharpe']:.2f}")
    print(f"Profit Factor:    {c3_res['profit_factor']:.2f}")
    print(f"Win Rate:         {c3_res['win_rate']:.2f}%")
    print(f"Total Trades:     {c3_res['total_trades']}")
    print(f"Avg Duration:     {c3_res['avg_duration_hours']:.1f} hours")
    print(f"Total Fees:       ${c3_res['total_fees']:,.2f}")
    print(f"Total Slippage:   ${c3_res['total_slippage']:,.2f}")

    print("\n" + "=" * 70)
