"""
Master Phase 1 Benchmark Runner:
Reruns all empirical benchmarks on real 2-year dataset using the corrected backtester:
1. Full 2-Year Fixed-Risk Baseline ($200 per 1R, no compounding, no stop at ruin).
2. Zero-Cost Strategy Baseline (fees=0, slip=0, funding=0).
3. Slippage Sweep (0.01%, 0.02%, 0.05% Core, proportional Satellite).
4. Sensitivity Sweeps (ATR multiplier 1.8 - 3.8, ADX threshold 16 - 28).
5. Walk-Forward Analysis (IS and OOS across rolling windows).
6. Random-Entry Monte Carlo (200 runs at full cost and zero cost, matched trade count).
"""

import os
import sys
import json
import numpy as np
import pandas as pd
from datetime import datetime, timezone

sys.path.insert(0, os.getcwd())
from research.backtest import Backtester, CORE_SYMBOLS
from research.strategy import StrategyLogic
from research.walk_forward import run_window_backtest

def run_all():
    print("=" * 80)
    print("PHASE 1 FULL AUDITED BENCHMARK SUITE (REAL 2-YEAR DATA)")
    print("=" * 80)
    
    loader = Backtester()
    ohlcv_dict, funding_dict = loader.load_all_data()
    
    # -------------------------------------------------------------
    # 1. FULL 2-YEAR FIXED-RISK BASELINE
    # -------------------------------------------------------------
    print("\n[1/6] Running Full 2-Year Fixed-Risk Baseline ($200/1R, no compounding, no stop at ruin)...", flush=True)
    bt_fixed = Backtester(
        initial_capital=10000.0,
        taker_fee=0.0006,
        core_slippage=0.0005,
        satellite_slippage=0.0012,
        fixed_risk_mode=True,
        stop_at_ruin=False
    )
    bt_fixed.load_all_data = lambda: (ohlcv_dict, funding_dict)
    m_fixed = bt_fixed.run()
    
    trades = bt_fixed.trade_log
    wins = [t for t in trades if t.net_pnl > 0]
    losses = [t for t in trades if t.net_pnl < 0]
    be = [t for t in trades if t.net_pnl == 0]
    wr = len(wins) / (len(wins) + len(losses)) * 100.0 if (len(wins) + len(losses)) > 0 else 0.0
    pf = sum(t.net_pnl for t in wins) / abs(sum(t.net_pnl for t in losses)) if losses else 0.0
    avg_r = np.mean([t.r_multiple for t in trades]) if trades else 0.0
    avg_win = np.mean([t.net_pnl for t in wins]) if wins else 0.0
    avg_loss = abs(np.mean([t.net_pnl for t in losses])) if losses else 0.0
    total_pnl = sum(t.net_pnl for t in trades)
    
    # Playbook breakdown
    playbooks = {}
    for t in trades:
        pb = t.setup_type or 'OTHER'
        if pb not in playbooks:
            playbooks[pb] = []
        playbooks[pb].append(t)
        
    pb_breakdown = {}
    for pb, pb_trades in playbooks.items():
        p_wins = [t for t in pb_trades if t.net_pnl > 0]
        p_losses = [t for t in pb_trades if t.net_pnl < 0]
        p_wr = len(p_wins) / (len(p_wins) + len(p_losses)) * 100.0 if (len(p_wins) + len(p_losses)) > 0 else 0.0
        p_pf = sum(t.net_pnl for t in p_wins) / abs(sum(t.net_pnl for t in p_losses)) if p_losses else 0.0
        p_r = np.mean([t.r_multiple for t in pb_trades])
        pb_breakdown[pb] = {
            'trades': len(pb_trades),
            'win_rate': round(p_wr, 2),
            'net_pnl': round(sum(t.net_pnl for t in pb_trades), 2),
            'profit_factor': round(p_pf, 2),
            'avg_r': round(p_r, 2)
        }
        
    # Symbol breakdown
    sym_trades = {}
    for t in trades:
        s = t.symbol
        if s not in sym_trades:
            sym_trades[s] = []
        sym_trades[s].append(t)
        
    symbol_breakdown = {}
    for s, s_list in sym_trades.items():
        s_wins = [t for t in s_list if t.net_pnl > 0]
        s_losses = [t for t in s_list if t.net_pnl < 0]
        s_wr = len(s_wins) / (len(s_wins) + len(s_losses)) * 100.0 if (len(s_wins) + len(s_losses)) > 0 else 0.0
        s_pf = sum(t.net_pnl for t in s_wins) / abs(sum(t.net_pnl for t in s_losses)) if s_losses else 0.0
        s_r = np.mean([t.r_multiple for t in s_list])
        symbol_breakdown[s] = {
            'tier': 'CORE' if s in CORE_SYMBOLS else 'SATELLITE',
            'trades': len(s_list),
            'win_rate': round(s_wr, 2),
            'net_pnl': round(sum(t.net_pnl for t in s_list), 2),
            'profit_factor': round(s_pf, 2),
            'avg_r': round(s_r, 2)
        }
        
    baseline_result = {
        'total_trades': len(trades),
        'wins': len(wins),
        'losses': len(losses),
        'breakevens': len(be),
        'win_rate': round(wr, 2),
        'profit_factor': round(pf, 2),
        'avg_r': round(avg_r, 2),
        'avg_win': round(avg_win, 2),
        'avg_loss': round(avg_loss, 2),
        'net_pnl': round(total_pnl, 2),
        'fees_paid': round(sum(t.total_fees for t in trades), 2),
        'slippage_cost': round(sum(t.slippage_cost for t in trades), 2),
        'funding_pnl': round(sum(t.funding_pnl for t in trades), 2),
        'playbooks': pb_breakdown,
        'symbols': symbol_breakdown
    }
    
    print(f"  Fixed-Risk Trades: {len(trades)} | Win Rate: {wr:.2f}% | PF: {pf:.2f} | Exp: {avg_r:.2f} R")

    # -------------------------------------------------------------
    # 2. ZERO-COST STRATEGY BASELINE
    # -------------------------------------------------------------
    print("\n[2/6] Running Zero-Cost Baseline (fees=0, slip=0, funding=0)...", flush=True)
    bt_zero = Backtester(
        initial_capital=10000.0,
        taker_fee=0.0,
        core_slippage=0.0,
        satellite_slippage=0.0,
        fixed_risk_mode=True,
        stop_at_ruin=False
    )
    bt_zero.load_all_data = lambda: (ohlcv_dict, funding_dict)
    m_zero = bt_zero.run()
    z_trades = bt_zero.trade_log
    z_wins = [t for t in z_trades if t.net_pnl > 0]
    z_losses = [t for t in z_trades if t.net_pnl < 0]
    z_wr = len(z_wins) / (len(z_wins) + len(z_losses)) * 100.0 if (len(z_wins) + len(z_losses)) > 0 else 0.0
    z_pf = sum(t.net_pnl for t in z_wins) / abs(sum(t.net_pnl for t in z_losses)) if z_losses else 0.0
    z_r = np.mean([t.r_multiple for t in z_trades]) if z_trades else 0.0
    
    zero_cost_result = {
        'trades': len(z_trades),
        'win_rate': round(z_wr, 2),
        'profit_factor': round(z_pf, 2),
        'avg_r': round(z_r, 2),
        'avg_win': round(np.mean([t.net_pnl for t in z_wins]), 2) if z_wins else 0.0,
        'avg_loss': round(abs(np.mean([t.net_pnl for t in z_losses])), 2) if z_losses else 0.0,
        'net_pnl': round(sum(t.net_pnl for t in z_trades), 2)
    }
    print(f"  Zero-Cost Trades: {len(z_trades)} | Win Rate: {z_wr:.2f}% | PF: {z_pf:.2f} | Exp: {z_r:.2f} R")

    # -------------------------------------------------------------
    # 3. SLIPPAGE MONOTONICITY SWEEP
    # -------------------------------------------------------------
    print("\n[3/6] Running Slippage Monotonicity Sweep (0.01%, 0.02%, 0.05%)...", flush=True)
    slippage_results = []
    for s in [0.0001, 0.0002, 0.0005]:
        bt_s = Backtester(
            initial_capital=10000.0,
            taker_fee=0.0006,
            core_slippage=s,
            satellite_slippage=s * 2.4,
            fixed_risk_mode=True,
            stop_at_ruin=False
        )
        bt_s.load_all_data = lambda: (ohlcv_dict, funding_dict)
        m_s = bt_s.run()
        s_tr = bt_s.trade_log
        w_s = [t for t in s_tr if t.net_pnl > 0]
        l_s = [t for t in s_tr if t.net_pnl < 0]
        s_wr = len(w_s) / (len(w_s) + len(l_s)) * 100.0 if (len(w_s) + len(l_s)) > 0 else 0.0
        s_pf = sum(t.net_pnl for t in w_s) / abs(sum(t.net_pnl for t in l_s)) if l_s else 0.0
        slippage_results.append({
            'core_slippage_pct': round(s * 100, 3),
            'satellite_slippage_pct': round(s * 2.4 * 100, 3),
            'trades': len(s_tr),
            'win_rate': round(s_wr, 2),
            'profit_factor': round(s_pf, 3),
            'total_return_pct': round(m_s.get('total_return_pct', 0.0), 1),
            'fees': round(sum(t.total_fees for t in s_tr), 2),
            'slippage_cost': round(sum(t.slippage_cost for t in s_tr), 2)
        })
        print(f"  Slippage {s*100:.2f}%: Trades {len(s_tr)} | WR {s_wr:.2f}% | PF {s_pf:.3f}")

    # -------------------------------------------------------------
    # 4. SENSITIVITY SWEEPS (ATR & ADX)
    # -------------------------------------------------------------
    print("\n[4/6] Running Sensitivity Sweeps (ATR Multipliers & ADX Thresholds)...", flush=True)
    sensitivity_results = []
    # ATR Multipliers
    for atr_m in [1.8, 2.2, 2.8, 3.2, 3.8]:
        bt_sens = Backtester(
            atr_multiplier=atr_m,
            adx_threshold=20.0,
            fixed_risk_mode=True,
            stop_at_ruin=False
        )
        bt_sens.load_all_data = lambda: (ohlcv_dict, funding_dict)
        m_sens = bt_sens.run()
        tr_sens = bt_sens.trade_log
        w_sens = [t for t in tr_sens if t.net_pnl > 0]
        l_sens = [t for t in tr_sens if t.net_pnl < 0]
        wr_sens = len(w_sens) / (len(w_sens) + len(l_sens)) * 100.0 if (len(w_sens) + len(l_sens)) > 0 else 0.0
        pf_sens = sum(t.net_pnl for t in w_sens) / abs(sum(t.net_pnl for t in l_sens)) if l_sens else 0.0
        r_sens = np.mean([t.r_multiple for t in tr_sens]) if tr_sens else 0.0
        sensitivity_results.append({
            'param': 'ATR_MULTIPLIER',
            'value': atr_m,
            'trades': len(tr_sens),
            'win_rate': round(wr_sens, 2),
            'profit_factor': round(pf_sens, 2),
            'return_pct': round(m_sens.get('total_return_pct', 0.0), 1),
            'avg_r': round(r_sens, 2)
        })
        print(f"  ATR {atr_m}: Trades {len(tr_sens)} | WR {wr_sens:.2f}% | PF {pf_sens:.2f}")

    # ADX Thresholds
    for adx_t in [16.0, 20.0, 24.0, 28.0]:
        bt_sens = Backtester(
            atr_multiplier=2.8,
            adx_threshold=adx_t,
            fixed_risk_mode=True,
            stop_at_ruin=False
        )
        bt_sens.load_all_data = lambda: (ohlcv_dict, funding_dict)
        m_sens = bt_sens.run()
        tr_sens = bt_sens.trade_log
        w_sens = [t for t in tr_sens if t.net_pnl > 0]
        l_sens = [t for t in tr_sens if t.net_pnl < 0]
        wr_sens = len(w_sens) / (len(w_sens) + len(l_sens)) * 100.0 if (len(w_sens) + len(l_sens)) > 0 else 0.0
        pf_sens = sum(t.net_pnl for t in w_sens) / abs(sum(t.net_pnl for t in l_sens)) if l_sens else 0.0
        r_sens = np.mean([t.r_multiple for t in tr_sens]) if tr_sens else 0.0
        sensitivity_results.append({
            'param': 'ADX_THRESHOLD',
            'value': adx_t,
            'trades': len(tr_sens),
            'win_rate': round(wr_sens, 2),
            'profit_factor': round(pf_sens, 2),
            'return_pct': round(m_sens.get('total_return_pct', 0.0), 1),
            'avg_r': round(r_sens, 2)
        })
        print(f"  ADX {adx_t}: Trades {len(tr_sens)} | WR {wr_sens:.2f}% | PF {pf_sens:.2f}")

    # -------------------------------------------------------------
    # 5. WALK-FORWARD ANALYSIS (6 Rolling Windows)
    # -------------------------------------------------------------
    print("\n[5/6] Running Walk-Forward Analysis across rolling windows...", flush=True)
    all_ts = []
    for df in ohlcv_dict.values():
        all_ts.extend(df['timestamp'].tolist())
    min_ts = min(all_ts)
    max_ts = max(all_ts)
    
    month_ms = 30 * 86400 * 1000
    train_duration = 6 * month_ms
    test_duration = 3 * month_ms
    step_duration = 3 * month_ms
    
    wfa_results = []
    curr_start = min_ts
    w_idx = 1
    
    while curr_start + train_duration + test_duration <= max_ts:
        tr_start = curr_start
        tr_end = tr_start + train_duration
        te_start = tr_end + 1
        te_end = te_start + test_duration
        
        tr_m = run_window_backtest(tr_start, tr_end, ohlcv_dict, funding_dict)
        te_m = run_window_backtest(te_start, te_end, ohlcv_dict, funding_dict)
        
        tr_label = f"{datetime.fromtimestamp(tr_start/1000, timezone.utc).strftime('%Y-%m')} to {datetime.fromtimestamp(tr_end/1000, timezone.utc).strftime('%Y-%m')}"
        te_label = f"{datetime.fromtimestamp(te_start/1000, timezone.utc).strftime('%Y-%m')} to {datetime.fromtimestamp(te_end/1000, timezone.utc).strftime('%Y-%m')}"
        
        wfa_results.append({
            'window': f"W{w_idx}",
            'train_period': tr_label,
            'test_period': te_label,
            'is_trades': tr_m['total_trades'],
            'is_wr': tr_m['win_rate'],
            'is_pf': tr_m['profit_factor'],
            'oos_trades': te_m['total_trades'],
            'oos_wr': te_m['win_rate'],
            'oos_pf': te_m['profit_factor']
        })
        print(f"  W{w_idx}: IS Trades {tr_m['total_trades']} (WR {tr_m['win_rate']}%, PF {tr_m['profit_factor']}) | OOS Trades {te_m['total_trades']} (WR {te_m['win_rate']}%, PF {te_m['profit_factor']})")
        curr_start += step_duration
        w_idx += 1

    # -------------------------------------------------------------
    # 6. RANDOM-ENTRY MONTE CARLO (200 RUNS, ZERO & FULL COST)
    # -------------------------------------------------------------
    print("\n[6/6] Running Random-Entry Monte Carlo (200 Runs, Zero & Full Cost)...", flush=True)
    strategy = StrategyLogic(atr_multiplier=2.8, adx_threshold=20.0)
    symbols = list(ohlcv_dict.keys())
    
    fc_pfs = []
    fc_wrs = []
    fc_rs = []
    zc_pfs = []
    zc_wrs = []
    zc_rs = []
    
    np.random.seed(1337)
    num_mc_runs = 200
    
    for r_i in range(num_mc_runs):
        if (r_i + 1) % 50 == 0:
            print(f"  MC Iteration {r_i + 1}/{num_mc_runs}...", flush=True)
            
        fc_pnls = []
        zc_pnls = []
        fc_r_list = []
        zc_r_list = []
        
        for sym in symbols:
            df = ohlcv_dict[sym]
            opens = df['open'].to_numpy()
            highs = df['high'].to_numpy()
            lows = df['low'].to_numpy()
            closes = df['close'].to_numpy()
            atrs = df['atr'].to_numpy()
            n = len(closes)
            
            slip = 0.0005 if sym in CORE_SYMBOLS else 0.0012
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
                        exit_price_zc = min(opens[i], pos_stop) if pos_side == 'LONG' else max(opens[i], pos_stop)
                        
                        size = risk_dollars / (2.8 * pos_atr)
                        notional_in_fc = size * pos_entry_fc
                        notional_out_fc = size * exit_price_fc
                        gross_fc = (notional_out_fc - notional_in_fc) if pos_side == 'LONG' else (notional_in_fc - notional_out_fc)
                        fees = (notional_in_fc + notional_out_fc) * fee
                        net_fc = gross_fc - fees
                        fc_pnls.append(net_fc)
                        fc_r_list.append(net_fc / risk_dollars)
                        
                        notional_in_zc = size * pos_entry_zc
                        notional_out_zc = size * exit_price_zc
                        gross_zc = (notional_out_zc - notional_in_zc) if pos_side == 'LONG' else (notional_in_zc - notional_out_zc)
                        zc_pnls.append(gross_zc)
                        zc_r_list.append(gross_zc / risk_dollars)
                        
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
                        
        if fc_pnls:
            w_fc = [p for p in fc_pnls if p > 0]
            l_fc = [p for p in fc_pnls if p < 0]
            pf_fc = sum(w_fc) / abs(sum(l_fc)) if l_fc and abs(sum(l_fc)) > 0 else 1.0
            fc_pfs.append(pf_fc)
            fc_wrs.append(len(w_fc) / len(fc_pnls) * 100.0)
            fc_rs.append(np.mean(fc_r_list))
            
        if zc_pnls:
            w_zc = [p for p in zc_pnls if p > 0]
            l_zc = [p for p in zc_pnls if p < 0]
            pf_zc = sum(w_zc) / abs(sum(l_zc)) if l_zc and abs(sum(l_zc)) > 0 else 1.0
            zc_pfs.append(pf_zc)
            zc_wrs.append(len(w_zc) / len(zc_pnls) * 100.0)
            zc_rs.append(np.mean(zc_r_list))
            
    mc_result = {
        'num_runs': num_mc_runs,
        'full_cost': {
            'mean_pf': round(float(np.mean(fc_pfs)), 3),
            'median_pf': round(float(np.percentile(fc_pfs, 50)), 3),
            'p5': round(float(np.percentile(fc_pfs, 5)), 3),
            'p95': round(float(np.percentile(fc_pfs, 95)), 3),
            'mean_wr': round(float(np.mean(fc_wrs)), 2),
            'mean_r': round(float(np.mean(fc_rs)), 3)
        },
        'zero_cost': {
            'mean_pf': round(float(np.mean(zc_pfs)), 3),
            'median_pf': round(float(np.percentile(zc_pfs, 50)), 3),
            'p5': round(float(np.percentile(zc_pfs, 5)), 3),
            'p95': round(float(np.percentile(zc_pfs, 95)), 3),
            'mean_wr': round(float(np.mean(zc_wrs)), 2),
            'mean_r': round(float(np.mean(zc_rs)), 3)
        }
    }
    
    print("\n" + "=" * 80)
    print("ALL BENCHMARKS COMPLETED!")
    print("=" * 80)
    
    master_results = {
        'baseline': baseline_result,
        'zero_cost': zero_cost_result,
        'slippage_sweep': slippage_results,
        'sensitivity': sensitivity_results,
        'walk_forward': wfa_results,
        'monte_carlo': mc_result
    }
    
    with open("research/results/phase1_audit_results.json", "w") as f:
        json.dump(master_results, f, indent=2)
    print("Saved master results to research/results/phase1_audit_results.json")
    return master_results

if __name__ == "__main__":
    run_all()
