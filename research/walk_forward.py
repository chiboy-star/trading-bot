"""
Walk-Forward Analysis (WFA) Suite
Evaluates rolling In-Sample (Train) vs Out-of-Sample (Test) windows
Flags strategy decay, parameter overfitting, and out-of-sample collapse.
"""

import os
import sys
import glob
from dataclasses import dataclass
from typing import Dict, List, Tuple, Any
import numpy as np
import pandas as pd
from datetime import datetime, timezone

sys.path.insert(0, os.getcwd())
from research.backtest import Backtester

def run_window_backtest(
    start_ts: int,
    end_ts: int,
    ohlcv_dict: Dict[str, pd.DataFrame],
    funding_dict: Dict[str, pd.DataFrame]
) -> Dict[str, Any]:
    """Runs a backtest strictly sliced between start_ts and end_ts."""
    sliced_ohlcv = {}
    for sym, df in ohlcv_dict.items():
        sub = df[(df['timestamp'] >= start_ts) & (df['timestamp'] <= end_ts)].reset_index(drop=True)
        if len(sub) > 50:
            sliced_ohlcv[sym] = sub

    sliced_funding = {}
    for sym, df_f in funding_dict.items():
        sub_f = df_f[(df_f['timestamp'] >= start_ts) & (df_f['timestamp'] <= end_ts)].reset_index(drop=True)
        sliced_funding[sym] = sub_f

    engine = Backtester(fixed_risk_mode=True, stop_at_ruin=False)
    # Override load_all_data to return pre-sliced data
    engine.load_all_data = lambda: (sliced_ohlcv, sliced_funding)
    res = engine.run()
    return res

def run_walk_forward_analysis():
    print("Loading data for Walk-Forward Analysis...")
    engine_loader = Backtester()
    ohlcv_dict, funding_dict = engine_loader.load_all_data()

    # Determine date bounds
    all_ts = []
    for df in ohlcv_dict.values():
        all_ts.extend(df['timestamp'].tolist())
    min_ts = min(all_ts)
    max_ts = max(all_ts)
    total_duration_ms = max_ts - min_ts

    # 4 Rolling 6-month Train / 3-month Test windows
    # 30 days = 2,592,000,000 ms
    month_ms = 30 * 86400 * 1000
    train_duration = 6 * month_ms
    test_duration = 3 * month_ms
    step_duration = 3 * month_ms

    windows = []
    curr_start = min_ts
    window_idx = 1

    while curr_start + train_duration + test_duration <= max_ts:
        train_start = curr_start
        train_end = train_start + train_duration
        test_start = train_end + 1
        test_end = test_start + test_duration

        windows.append({
            'window': f"W{window_idx}",
            'train_start': train_start,
            'train_end': train_end,
            'test_start': test_start,
            'test_end': test_end,
            'train_period': f"{datetime.fromtimestamp(train_start/1000, timezone.utc).strftime('%Y-%m')} to {datetime.fromtimestamp(train_end/1000, timezone.utc).strftime('%Y-%m')}",
            'test_period': f"{datetime.fromtimestamp(test_start/1000, timezone.utc).strftime('%Y-%m')} to {datetime.fromtimestamp(test_end/1000, timezone.utc).strftime('%Y-%m')}"
        })
        curr_start += step_duration
        window_idx += 1

    print(f"Executing Walk-Forward Analysis across {len(windows)} rolling windows...\n")

    wfa_results = []

    for w in windows:
        print(f"--- Running {w['window']}: Train [{w['train_period']}] vs Test [{w['test_period']}] ---")
        train_metrics = run_window_backtest(w['train_start'], w['train_end'], ohlcv_dict, funding_dict)
        test_metrics = run_window_backtest(w['test_start'], w['test_end'], ohlcv_dict, funding_dict)

        is_collapse = test_metrics['profit_factor'] < 0.8 or test_metrics['total_return_pct'] < -15.0 or test_metrics['avg_r'] < -0.10

        wfa_results.append({
            'window': w['window'],
            'train_period': w['train_period'],
            'test_period': w['test_period'],
            'is_trades': train_metrics['total_trades'],
            'is_win_rate': train_metrics['win_rate'],
            'is_profit_factor': train_metrics['profit_factor'],
            'is_return_pct': train_metrics['total_return_pct'],
            'is_avg_r': train_metrics['avg_r'],
            'is_max_dd': train_metrics['max_drawdown_pct'],
            'oos_trades': test_metrics['total_trades'],
            'oos_win_rate': test_metrics['win_rate'],
            'oos_profit_factor': test_metrics['profit_factor'],
            'oos_return_pct': test_metrics['total_return_pct'],
            'oos_avg_r': test_metrics['avg_r'],
            'oos_max_dd': test_metrics['max_drawdown_pct'],
            'status': 'COLLAPSE' if is_collapse else 'STABLE'
        })

    df_wfa = pd.DataFrame(wfa_results)
    os.makedirs("research/results", exist_ok=True)
    df_wfa.to_csv("research/results/walk_forward_results.csv", index=False)

    print("\n" + "=" * 110)
    print("WALK-FORWARD ANALYSIS RESULTS (IN-SAMPLE vs OUT-OF-SAMPLE)")
    print("=" * 110)
    for r in wfa_results:
        print(f"Window: {r['window']} | Train: {r['train_period']} -> Test: {r['test_period']} | Status: [{r['status']}]")
        print(f"   In-Sample  (IS):  Trades: {r['is_trades']:<5} | WinRate: {r['is_win_rate']:<5.1f}% | PF: {r['is_profit_factor']:<5.2f} | Return: {r['is_return_pct']:<+6.1f}% | Avg R: {r['is_avg_r']:<+5.2f} R | MaxDD: {r['is_max_dd']:.1f}%")
        print(f"   Out-Sample (OOS): Trades: {r['oos_trades']:<5} | WinRate: {r['oos_win_rate']:<5.1f}% | PF: {r['oos_profit_factor']:<5.2f} | Return: {r['oos_return_pct']:<+6.1f}% | Avg R: {r['oos_avg_r']:<+5.2f} R | MaxDD: {r['oos_max_dd']:.1f}%")
        print("-" * 110)

    return df_wfa

if __name__ == "__main__":
    run_walk_forward_analysis()
