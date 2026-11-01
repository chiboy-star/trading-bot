"""
Parameter Sensitivity Analysis Suite
Varies ATR Trailing Multiplier, ADX Threshold, and RSI Pullback Windows
Determines parameter stability vs fragility across the 2-year dataset.
"""

import os
import sys
import argparse
from typing import Dict, List, Any
import pandas as pd
import numpy as np

sys.path.insert(0, os.getcwd())
from research.backtest import Backtester

def run_sensitivity_analysis():
    print("Loading data for Sensitivity Analysis...")
    engine_loader = Backtester()
    ohlcv_dict, funding_dict = engine_loader.load_all_data()

    results = []

    # 1. ATR Multiplier Sensitivity (around 2.8)
    atr_values = [1.8, 2.2, 2.8, 3.2, 3.8]
    print("\n--- 1. Testing ATR Multiplier Variations ---")
    for atr_m in atr_values:
        print(f"Testing ATR Multiplier = {atr_m:.1f}...")
        bt = Backtester(atr_multiplier=atr_m, adx_threshold=20.0, fixed_risk_mode=True, stop_at_ruin=False)
        bt.load_all_data = lambda: (ohlcv_dict, funding_dict)
        m = bt.run()
        results.append({
            'parameter': 'ATR_MULTIPLIER',
            'value': f"{atr_m:.1f}",
            'trades': m.get('total_trades', 0),
            'win_rate': m.get('win_rate', 0.0),
            'profit_factor': m.get('profit_factor', 0.0),
            'total_return_pct': m.get('total_return_pct', 0.0),
            'avg_r': m.get('avg_r', 0.0),
            'max_drawdown_pct': m.get('max_drawdown_pct', 0.0)
        })

    # 2. ADX Threshold Sensitivity (around 20)
    adx_values = [16.0, 20.0, 24.0, 28.0]
    print("\n--- 2. Testing ADX Threshold Variations ---")
    for adx_th in adx_values:
        print(f"Testing ADX Threshold = {adx_th:.1f}...")
        bt = Backtester(atr_multiplier=2.8, adx_threshold=adx_th, fixed_risk_mode=True, stop_at_ruin=False)
        bt.load_all_data = lambda: (ohlcv_dict, funding_dict)
        m = bt.run()
        results.append({
            'parameter': 'ADX_THRESHOLD',
            'value': f"{adx_th:.1f}",
            'trades': m.get('total_trades', 0),
            'win_rate': m.get('win_rate', 0.0),
            'profit_factor': m.get('profit_factor', 0.0),
            'total_return_pct': m.get('total_return_pct', 0.0),
            'avg_r': m.get('avg_r', 0.0),
            'max_drawdown_pct': m.get('max_drawdown_pct', 0.0)
        })

    df_res = pd.DataFrame(results)
    os.makedirs("research/results", exist_ok=True)
    df_res.to_csv("research/results/sensitivity_results.csv", index=False)

    print("\n" + "=" * 95)
    print("STRATEGY PARAMETER SENSITIVITY REPORT")
    print("=" * 95)
    print(df_res.to_string(index=False))
    print("=" * 95)

    return df_res

if __name__ == "__main__":
    run_sensitivity_analysis()
