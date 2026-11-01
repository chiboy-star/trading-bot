"""
Regime, Universe, and Directionality Breakdown
Tests whether restricting to:
1. Core pairs (BTC, ETH, SOL)
2. Long-Only direction
3. BTC 200-EMA macro trend filter
reveals a statistically genuine edge.
"""

import os
import glob
import pandas as pd
import numpy as np
import sys
sys.path.insert(0, os.getcwd())
from research.strategy_candidates import load_data, calc_atr, calc_ema, simulate_strategy

def run_universe_tests():
    data_4h = load_data('4h')
    
    # 1. Filter to Core symbols only
    core_symbols = ["BTC_USDT", "ETH_USDT", "SOL_USDT"]
    data_core = {k: v for k, v in data_4h.items() if k in core_symbols}
    
    # Get BTC trend for regime filter
    btc_df = data_4h.get('BTC_USDT')
    if btc_df is not None:
        btc_df = btc_df.copy()
        btc_df['btc_ema200'] = calc_ema(btc_df['close'], 200)
        btc_trend = btc_df.set_index('datetime')['close'] > btc_df.set_index('datetime')['btc_ema200']
    else:
        btc_trend = None

    print("=" * 70)
    print("UNIVERSE & DIRECTIONALITY COMPARISON ON 4H BARS")
    print("=" * 70)

    for universe_name, data in [("ALL 12 PAIRS", data_4h), ("CORE 3 (BTC, ETH, SOL)", data_core)]:
        for direction in ["LONG_AND_SHORT", "LONG_ONLY"]:
            for use_btc_regime in [False, True]:
                # Prepare signals
                test_data = {}
                for sym, df in data.items():
                    d = df.copy()
                    d['atr'] = calc_atr(d, 14)
                    d['ema50'] = calc_ema(d['close'], 50)
                    d['upper_20'] = d['high'].shift(1).rolling(20).max()
                    d['lower_20'] = d['low'].shift(1).rolling(20).min()
                    d['exit_lower_10'] = d['low'].shift(1).rolling(10).min()
                    d['exit_upper_10'] = d['high'].shift(1).rolling(10).max()
                    
                    d['signal'] = 0
                    long_cond = (d['close'] > d['upper_20']) & (d['close'] > d['ema50'])
                    short_cond = (d['close'] < d['lower_20']) & (d['close'] < d['ema50'])
                    
                    if use_btc_regime and btc_trend is not None:
                        # Map BTC regime to this dataframe's datetime
                        regime = d['datetime'].map(btc_trend).fillna(False)
                        long_cond = long_cond & regime
                        short_cond = short_cond & (~regime)
                        
                    d.loc[long_cond, 'signal'] = 1
                    if direction == "LONG_AND_SHORT":
                        d.loc[short_cond, 'signal'] = -1
                        
                    d['exit_signal'] = 0
                    d.loc[d['close'] < d['exit_lower_10'], 'exit_signal'] = -1
                    if direction == "LONG_AND_SHORT":
                        d.loc[d['close'] > d['exit_upper_10'], 'exit_signal'] = 1
                        
                    test_data[sym] = d
                    
                label = f"{universe_name} | {direction} | BTC_Regime={use_btc_regime}"
                res = simulate_strategy(test_data, label, max_positions=3)
                print(f"\n[{label}]")
                print(f"  Final Equity:   ${res['final_equity']:,.2f} (Net: ${res['net_pnl']:,.2f})")
                print(f"  Trades: {res['total_trades']}, WinRate: {res['win_rate']:.1f}%, PF: {res['profit_factor']:.2f}, Sharpe: {res['sharpe']:.2f}, MaxDD: {res['max_dd']:.1f}%")

if __name__ == '__main__':
    run_universe_tests()
