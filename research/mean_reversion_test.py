"""
Mean Reversion & Volatility Band Evaluation
Tests whether mean reversion (fading Bollinger Band / RSI extremes) provides positive expectancy.
"""

import os
import sys
import glob
import pandas as pd
import numpy as np

sys.path.insert(0, os.getcwd())
from research.strategy_candidates import load_data, calc_atr, simulate_strategy

def calc_bollinger(series: pd.Series, period: int = 20, num_std: float = 2.0):
    sma = series.rolling(period).mean()
    std = series.rolling(period).std()
    upper = sma + (num_std * std)
    lower = sma - (num_std * std)
    return sma, upper, lower

def calc_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = (delta.where(delta > 0, 0)).ewm(alpha=1.0/period, adjust=False).mean()
    loss = (-delta.where(delta < 0, 0)).ewm(alpha=1.0/period, adjust=False).mean()
    rs = gain / (loss + 1e-10)
    return 100 - (100 / (1 + rs))

def run_mean_reversion():
    data_1h = load_data('1h')
    data_4h = load_data('4h')
    
    print("=" * 70)
    print("EVALUATING MEAN REVERSION / BOLLINGER BAND FADE ON 1H & 4H")
    print("=" * 70)
    
    for tf_name, data in [("1-HOUR BARS", data_1h), ("4-HOUR BARS", data_4h)]:
        for std_mult in [2.0, 2.5]:
            test_data = {}
            for sym, df in data.items():
                d = df.copy()
                d['atr'] = calc_atr(d, 14)
                d['sma20'], d['upper'], d['lower'] = calc_bollinger(d['close'], 20, std_mult)
                d['rsi'] = calc_rsi(d['close'], 14)
                
                # Signal: Buy when close < lower band and RSI < 30
                # Signal: Sell when close > upper band and RSI > 70
                d['signal'] = 0
                long_cond = (d['close'] < d['lower']) & (d['rsi'] < 30)
                short_cond = (d['close'] > d['upper']) & (d['rsi'] > 70)
                
                d.loc[long_cond, 'signal'] = 1
                d.loc[short_cond, 'signal'] = -1
                
                # Exit when price crosses back to middle band (sma20)
                d['exit_signal'] = 0
                d.loc[d['close'] >= d['sma20'], 'exit_signal'] = -1 # close long
                d.loc[d['close'] <= d['sma20'], 'exit_signal'] = 1  # close short
                
                test_data[sym] = d
                
            label = f"{tf_name} | Bollinger {std_mult} Std + RSI Extreme"
            res = simulate_strategy(test_data, label, max_positions=5, risk_per_trade=0.01)
            print(f"\n[{label}]")
            print(f"  Final Equity:   ${res['final_equity']:,.2f} (Net: ${res['net_pnl']:,.2f})")
            print(f"  Trades: {res['total_trades']}, WinRate: {res['win_rate']:.1f}%, PF: {res['profit_factor']:.2f}, Sharpe: {res['sharpe']:.2f}, MaxDD: {res['max_dd']:.1f}%")
            print(f"  Fees: ${res['total_fees']:,.2f}, Slippage: ${res['total_slippage']:,.2f}, Avg Duration: {res['avg_duration_hours']:.1f}h")

if __name__ == '__main__':
    run_mean_reversion()
