"""
Phase A Deep Audit: Benchmark Verifications, Monte Carlo 200 Runs, and Slippage Monotonicity Sweep
"""

import os
import sys
import glob
import json
import numpy as np
import pandas as pd

sys.path.insert(0, os.getcwd())
from research.indicators import compute_all_indicators
from research.strategy import StrategyLogic
from research.backtest import Backtester

def run_slippage_sweep():
    print("\n" + "=" * 80)
    print("SLIPPAGE MONOTONICITY SWEEP (Fixed-Risk Mode, No Ruin Stop)")
    print("=" * 80)
    
    engine_loader = Backtester()
    ohlcv_dict, funding_dict = engine_loader.load_all_data()
    
    slips = [0.0001, 0.0002, 0.0005]
    results = []
    
    for s in slips:
        print(f"Running full backtest with Core Slippage = {s*100:.2f}% ({int(s*10000)} bps)...", flush=True)
        bt = Backtester(
            initial_capital=10000.0,
            taker_fee=0.0006,
            core_slippage=s,
            satellite_slippage=s * 2.4, # Proportional satellite slippage
            fixed_risk_mode=True,
            stop_at_ruin=False
        )
        bt.load_all_data = lambda: (ohlcv_dict, funding_dict)
        m = bt.run()
        results.append({
            'core_slippage_pct': s * 100,
            'satellite_slippage_pct': s * 2.4 * 100,
            'trades': m.get('total_trades', 0),
            'win_rate': m.get('win_rate', 0.0),
            'profit_factor': m.get('profit_factor', 0.0),
            'total_return_pct': m.get('total_return_pct', 0.0),
            'avg_r': m.get('avg_r', 0.0),
            'fees': sum(t.total_fees for t in bt.trade_log),
            'slippage_cost': sum(t.slippage_cost for t in bt.trade_log)
        })
        
    df_res = pd.DataFrame(results)
    print("\nSLIPPAGE SWEEP RESULTS:")
    print(df_res.to_string(index=False))
    return results

def run_zero_cost_baseline():
    print("\n" + "=" * 80)
    print("ZERO-COST STRATEGY BASELINE (fees=0, slippage=0, funding=0, Fixed-Risk Mode)")
    print("=" * 80)
    
    engine_loader = Backtester()
    ohlcv_dict, funding_dict = engine_loader.load_all_data()
    
    bt = Backtester(
        initial_capital=10000.0,
        taker_fee=0.0,
        core_slippage=0.0,
        satellite_slippage=0.0,
        fixed_risk_mode=True,
        stop_at_ruin=False
    )
    bt.load_all_data = lambda: (ohlcv_dict, funding_dict)
    m = bt.run()
    
    trades = bt.trade_log
    wins = [t for t in trades if t.net_pnl > 0]
    losses = [t for t in trades if t.net_pnl < 0]
    wr = len(wins) / (len(wins) + len(losses)) * 100.0
    pf = sum(t.net_pnl for t in wins) / abs(sum(t.net_pnl for t in losses))
    avg_r = np.mean([t.r_multiple for t in trades])
    avg_win = np.mean([t.net_pnl for t in wins])
    avg_loss = abs(np.mean([t.net_pnl for t in losses]))
    
    print(f"\nZero-Cost Total Trades:      {len(trades)}")
    print(f"Zero-Cost Win Rate:          {wr:.2f}% ({len(wins)} W / {len(losses)} L)")
    print(f"Zero-Cost Profit Factor:     {pf:.2f}")
    print(f"Zero-Cost Avg Expectancy (R): {avg_r:+.2f} R")
    print(f"Zero-Cost Avg Win / Loss:    ${avg_win:,.2f} / ${avg_loss:,.2f}")
    print(f"Zero-Cost Total Net PnL:     ${sum(t.net_pnl for t in trades):,.2f}")
    
    return {
        'trades': len(trades),
        'win_rate': wr,
        'profit_factor': pf,
        'avg_r': avg_r,
        'avg_win': avg_win,
        'avg_loss': avg_loss,
        'total_pnl': sum(t.net_pnl for t in trades)
    }

def run_monte_carlo_random_entry(num_runs: int = 200):
    print("\n" + "=" * 80)
    print(f"RANDOM-ENTRY MONTE CARLO BASELINE ({num_runs} RUNS) — ZERO-COST & FULL-COST")
    print("=" * 80)
    
    engine_loader = Backtester()
    ohlcv_dict, funding_dict = engine_loader.load_all_data()
    
    # We want matched trade count (~4,188 trades across 12 pairs over 70,000 bars = ~350 trades per pair)
    # Entry probability per bar per pair: 350 / 70000 = ~0.005 (1 entry every 200 bars)
    strategy = StrategyLogic(atr_multiplier=2.8, adx_threshold=20.0)
    
    symbols = list(ohlcv_dict.keys())
    
    full_cost_pfs = []
    full_cost_wrs = []
    full_cost_rs = []
    
    zero_cost_pfs = []
    zero_cost_wrs = []
    zero_cost_rs = []
    
    np.random.seed(1337)
    
    for r_idx in range(num_runs):
        if (r_idx + 1) % 50 == 0:
            print(f"  Processed {r_idx + 1}/{num_runs} Monte Carlo iterations...", flush=True)
            
        fc_trades_pnl = []
        fc_trades_r = []
        zc_trades_pnl = []
        zc_trades_r = []
        
        for sym in symbols:
            df = ohlcv_dict[sym]
            opens = df['open'].to_numpy()
            highs = df['high'].to_numpy()
            lows = df['low'].to_numpy()
            closes = df['close'].to_numpy()
            atrs = df['atr'].to_numpy()
            n = len(closes)
            
            slip = 0.0005 if sym in ["BTC_USDT", "ETH_USDT", "SOL_USDT", "SUI_USDT", "XRP_USDT", "DOGE_USDT", "1000PEPE_USDT"] else 0.0012
            fee = 0.0006
            risk_dollars = 200.0
            
            in_pos = False
            pos_side = 'LONG'
            pos_entry_fc = 0.0
            pos_entry_zc = 0.0
            pos_stop = 0.0
            pos_highest = 0.0
            pos_lowest = 0.0
            pos_atr = 0.0
            
            for i in range(50, n - 1):
                if in_pos:
                    exit_eval = strategy.evaluate_exit(
                        side=pos_side,
                        entry_price=pos_entry_fc,
                        trailing_stop=pos_stop,
                        highest_price=pos_highest,
                        lowest_price=pos_lowest,
                        candle_open=opens[i],
                        candle_high=highs[i],
                        candle_low=lows[i],
                        candle_close=closes[i],
                        curr_atr=atrs[i] if atrs[i] > 0 else pos_atr,
                        atr_multiplier=2.8,
                        take_profit_price=None,
                        curr_ema_fast=0, prev_ema_fast=0, curr_ema_slow=0, prev_ema_slow=0,
                        slippage=slip
                    )
                    pos_stop = exit_eval.new_trailing_stop
                    pos_highest = exit_eval.new_highest
                    pos_lowest = exit_eval.new_lowest
                    
                    if exit_eval.should_exit:
                        exit_price_fc = exit_eval.execution_price
                        # Zero cost exit: effective stop or close without slippage
                        exit_price_zc = min(opens[i], pos_stop) if pos_side == 'LONG' else max(opens[i], pos_stop)
                        
                        size = risk_dollars / (2.8 * pos_atr)
                        notional_in_fc = size * pos_entry_fc
                        notional_out_fc = size * exit_price_fc
                        gross_fc = (notional_out_fc - notional_in_fc) if pos_side == 'LONG' else (notional_in_fc - notional_out_fc)
                        fees = (notional_in_fc + notional_out_fc) * fee
                        net_fc = gross_fc - fees
                        fc_trades_pnl.append(net_fc)
                        fc_trades_r.append(net_fc / risk_dollars)
                        
                        notional_in_zc = size * pos_entry_zc
                        notional_out_zc = size * exit_price_zc
                        gross_zc = (notional_out_zc - notional_in_zc) if pos_side == 'LONG' else (notional_in_zc - notional_out_zc)
                        zc_trades_pnl.append(gross_zc)
                        zc_trades_r.append(gross_zc / risk_dollars)
                        
                        in_pos = False
                else:
                    if np.random.rand() < 0.005 and atrs[i] > 0:
                        in_pos = True
                        pos_side = 'LONG' if np.random.rand() > 0.5 else 'SHORT'
                        entry_open = opens[i + 1]
                        pos_entry_fc = entry_open * (1.0 + slip) if pos_side == 'LONG' else entry_open * (1.0 - slip)
                        pos_entry_zc = entry_open
                        pos_atr = atrs[i]
                        pos_stop = pos_entry_fc - (2.8 * pos_atr) if pos_side == 'LONG' else pos_entry_fc + (2.8 * pos_atr)
                        pos_highest = pos_entry_fc
                        pos_lowest = pos_entry_fc
                        
        if fc_trades_pnl:
            w_fc = [p for p in fc_trades_pnl if p > 0]
            l_fc = [p for p in fc_trades_pnl if p < 0]
            pf_fc = sum(w_fc) / abs(sum(l_fc)) if l_fc and abs(sum(l_fc)) > 0 else 1.0
            full_cost_pfs.append(pf_fc)
            full_cost_wrs.append(len(w_fc) / len(fc_trades_pnl) * 100.0)
            full_cost_rs.append(np.mean(fc_trades_r))
            
        if zc_trades_pnl:
            w_zc = [p for p in zc_trades_pnl if p > 0]
            l_zc = [p for p in zc_trades_pnl if p < 0]
            pf_zc = sum(w_zc) / abs(sum(l_zc)) if l_zc and abs(sum(l_zc)) > 0 else 1.0
            zero_cost_pfs.append(pf_zc)
            zero_cost_wrs.append(len(w_zc) / len(zc_trades_pnl) * 100.0)
            zero_cost_rs.append(np.mean(zc_trades_r))
            
    return {
        'num_runs': num_runs,
        'full_cost': {
            'mean_pf': float(np.mean(full_cost_pfs)),
            'std_pf': float(np.std(full_cost_pfs)),
            'p5': float(np.percentile(full_cost_pfs, 5)),
            'p25': float(np.percentile(full_cost_pfs, 25)),
            'median': float(np.percentile(full_cost_pfs, 50)),
            'p75': float(np.percentile(full_cost_pfs, 75)),
            'p95': float(np.percentile(full_cost_pfs, 95)),
            'mean_wr': float(np.mean(full_cost_wrs)),
            'mean_r': float(np.mean(full_cost_rs))
        },
        'zero_cost': {
            'mean_pf': float(np.mean(zero_cost_pfs)),
            'std_pf': float(np.std(zero_cost_pfs)),
            'p5': float(np.percentile(zero_cost_pfs, 5)),
            'p25': float(np.percentile(zero_cost_pfs, 25)),
            'median': float(np.percentile(zero_cost_pfs, 50)),
            'p75': float(np.percentile(zero_cost_pfs, 75)),
            'p95': float(np.percentile(zero_cost_pfs, 95)),
            'mean_wr': float(np.mean(zero_cost_wrs)),
            'mean_r': float(np.mean(zero_cost_rs))
        }
    }

if __name__ == '__main__':
    slip_res = run_slippage_sweep()
    zc_res = run_zero_cost_baseline()
    mc_res = run_monte_carlo_random_entry(200)
    
    print("\n" + "=" * 80)
    print("MONTE CARLO RANDOM BASELINE SUMMARY:")
    print("FULL COST:")
    print(f"  Mean PF: {mc_res['full_cost']['mean_pf']:.3f} | Median: {mc_res['full_cost']['median']:.3f} | 5th-95th: [{mc_res['full_cost']['p5']:.3f}, {mc_res['full_cost']['p95']:.3f}]")
    print(f"  Mean Win Rate: {mc_res['full_cost']['mean_wr']:.2f}% | Mean R: {mc_res['full_cost']['mean_r']:+.3f} R")
    print("ZERO COST:")
    print(f"  Mean PF: {mc_res['zero_cost']['mean_pf']:.3f} | Median: {mc_res['zero_cost']['median']:.3f} | 5th-95th: [{mc_res['zero_cost']['p5']:.3f}, {mc_res['zero_cost']['p95']:.3f}]")
    print(f"  Mean Win Rate: {mc_res['zero_cost']['mean_wr']:.2f}% | Mean R: {mc_res['zero_cost']['mean_r']:+.3f} R")
    print("=" * 80)
    
    # Save results as json for easy reporting
    with open("research/results/deep_audit_results.json", "w") as f:
        json.dump({
            'slippage_sweep': slip_res,
            'zero_cost_baseline': zc_res,
            'monte_carlo': mc_res
        }, f, indent=2)
    print("\nDeep audit results saved to research/results/deep_audit_results.json")
