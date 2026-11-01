"""
Parity Test Suite: TypeScript Live Engine vs Python Research Strategy
Validates that Python StrategyLogic reproduces TypeScript StrategyEngine.evaluateEntry exactly.
"""

import os
import sys
import json
import numpy as np

sys.path.insert(0, os.getcwd())
from research.indicators import calculate_ema, calculate_rsi, calculate_atr, calculate_adx
from research.strategy import StrategyLogic

def run_parity_test(fixture_path: str = "research/parity_fixture.json"):
    if not os.path.exists(fixture_path):
        raise FileNotFoundError(f"Fixture file not found at {fixture_path}. Run 'node scripts/export_parity_fixture.js' first.")

    with open(fixture_path, 'r') as f:
        data = json.load(f)

    candles = data['candles']
    fixture = data['fixture']

    opens = np.array([c['open'] for c in candles], dtype=float)
    highs = np.array([c['high'] for c in candles], dtype=float)
    lows = np.array([c['low'] for c in candles], dtype=float)
    closes = np.array([c['close'] for c in candles], dtype=float)

    ema_fast = calculate_ema(closes, 20)
    ema_slow = calculate_ema(closes, 50)
    rsi = calculate_rsi(closes, 14)
    atr = calculate_atr(highs, lows, closes, 14)
    adx = calculate_adx(highs, lows, closes, 14)

    strategy = StrategyLogic(atr_multiplier=2.8, adx_threshold=20.0, allow_shorts=True)

    passed_count = 0
    total_evals = len(fixture)
    mismatches = []

    for item in fixture:
        idx = item['candle_idx']
        ts_eval = item['ts_eval']

        py_res = strategy.evaluate_entry(
            candle_idx=idx,
            opens=opens,
            highs=highs,
            lows=lows,
            closes=closes,
            ema_fast=ema_fast,
            ema_slow=ema_slow,
            rsi=rsi,
            atr=atr,
            adx=adx
        )

        ts_signal = ts_eval['signal']
        ts_dir = ts_eval['direction']
        ts_setup = ts_eval['setupType']

        sig_match = (py_res.signal == ts_signal)
        dir_match = (py_res.direction == ts_dir)
        setup_match = (py_res.setup_type == ts_setup)

        if sig_match and dir_match and setup_match:
            passed_count += 1
        else:
            mismatches.append({
                'idx': idx,
                'timestamp': item['timestamp'],
                'ts': {'signal': ts_signal, 'direction': ts_dir, 'setup': ts_setup, 'reason': ts_eval['reason']},
                'py': {'signal': py_res.signal, 'direction': py_res.direction, 'setup': py_res.setup_type, 'reason': py_res.reason}
            })

    print("=" * 70)
    print("STRATEGY PARITY TEST: TypeScript Engine vs Python Research Strategy")
    print("=" * 70)
    print(f"Total Evaluations Tested: {total_evals}")
    print(f"Passed Assertions:        {passed_count} / {total_evals} ({(passed_count / total_evals) * 100:.2f}%)")
    print(f"Mismatches:               {len(mismatches)}")

    if mismatches:
        print("\nDiscrepancy Samples:")
        for m in mismatches[:5]:
            print(f"  Candle {m['idx']}: TS -> {m['ts']} | PY -> {m['py']}")
        raise AssertionError(f"Parity test failed with {len(mismatches)} mismatches.")

    print("\nRESULT: 100% PARITY CONFIRMED! Zero discrepancies across all evaluated bars.")
    print("=" * 70)

if __name__ == "__main__":
    run_parity_test()
