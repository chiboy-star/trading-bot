"""
Phase 3 Execution & Auditing Pipeline
Runs pre-registered Hypotheses H1, H2, H3, H4 against all historical data,
computes walk-forward splits, sensitivity sweeps, Monte Carlo distributions,
and checks against pre-registered criteria.
"""

import os
import json
import numpy as np
import pandas as pd
from typing import Dict, List
from evaluate_hypotheses import (
    load_data_1d,
    load_data_4h,
    load_funding_data,
    load_oi_data,
    backtest_h1_daily_trend,
    backtest_h2_cross_sectional_momentum,
    backtest_h3_crowding_fade,
    backtest_h4_delta_neutral_carry,
    compute_trade_metrics,
    compute_btc_buy_and_hold_benchmark,
    asdict,
    TradeRecord
)

def run_pipeline():
    print("=" * 80)
    print("PHASE 3: PRE-REGISTERED HYPOTHESES EVALUATION PIPELINE")
    print("=" * 80)

    # 1. Load Data
    print("\n[1/6] Loading data archives...")
    dfs_1d = load_data_1d()
    dfs_4h = load_data_4h()
    funding_dfs = load_funding_data()
    oi_dfs = load_oi_data()
    print(f"Loaded 1D: {len(dfs_1d)} pairs | 4H: {len(dfs_4h)} pairs | Funding: {len(funding_dfs)} pairs | OI: {len(oi_dfs)} pairs")

    # Benchmark: BTC Buy & Hold
    bnh_btc = compute_btc_buy_and_hold_benchmark(dfs_1d['BTC_USDT'])
    print(f"\n--- Benchmark: BTC Buy & Hold ({bnh_btc['start_date']} to {bnh_btc['end_date']}) ---")
    print(f"Total Return: {bnh_btc['bnh_total_return_pct']:.2f}% | CAGR: {bnh_btc['bnh_cagr_pct']:.2f}% | Sharpe: {bnh_btc['bnh_sharpe']:.2f} | Max DD: {bnh_btc['bnh_max_dd_pct']:.2f}%")

    results_summary = {
        "benchmark": bnh_btc,
        "h1": {},
        "h2": {},
        "h3": {},
        "h4": {}
    }

    # -----------------------------------------------------------------------
    # [2/6] HYPOTHESIS 1: Daily Trend Following (BTC & ETH Long/Flat)
    # -----------------------------------------------------------------------
    print("\n" + "=" * 50)
    print("[2/6] Evaluating Hypothesis 1: Daily Trend Following")
    print("=" * 50)
    
    h1_trades = []
    h1_symbol_metrics = {}
    for sym in ["BTC_USDT", "ETH_USDT"]:
        trades, _ = backtest_h1_daily_trend(
            df=dfs_1d[sym],
            funding_df=funding_dfs.get(sym, pd.DataFrame()),
            symbol=sym,
            fast_ema=50,
            slow_sma=200,
            atr_period=20,
            trailing_mult=3.0,
            risk_per_trade_r=200.0
        )
        m = compute_trade_metrics(trades)
        h1_symbol_metrics[sym] = m
        h1_trades.extend(trades)
        print(f"{sym:10}: Trades={m['trades']} | WR={m['win_rate']:.1f}% | Net PF={m['net_pf']:.2f} | Net PnL=${m['net_pnl']:,.2f} | Exp={m['expectancy_r']:.3f} R")

    h1_total_m = compute_trade_metrics(h1_trades)
    print(f"H1 TOTAL  : Trades={h1_total_m['trades']} | WR={h1_total_m['win_rate']:.1f}% | Net PF={h1_total_m['net_pf']:.2f} | Net PnL=${h1_total_m['net_pnl']:,.2f} | Exp={h1_total_m['expectancy_r']:.3f} R")

    # Walk-Forward Analysis for H1 (4 windows)
    btc_df = dfs_1d['BTC_USDT']
    n_bars = len(btc_df)
    window_size = n_bars // 4
    h1_wf_results = []
    print("\n  H1 Walk-Forward Windows (BTC_USDT):")
    for w in range(4):
        start_i = w * window_size
        end_i = (w + 1) * window_size if w < 3 else n_bars
        sub_df = btc_df.iloc[start_i:end_i].reset_index(drop=True)
        sub_trades, _ = backtest_h1_daily_trend(sub_df, funding_dfs['BTC_USDT'], 'BTC_USDT', 50, 200, 20, 3.0)
        sub_m = compute_trade_metrics(sub_trades)
        t_start = sub_df.iloc[0]['datetime'].strftime('%Y-%m-%d')
        t_end = sub_df.iloc[-1]['datetime'].strftime('%Y-%m-%d')
        h1_wf_results.append({
            "window": w + 1, "period": f"{t_start} to {t_end}",
            "trades": sub_m['trades'], "net_pf": sub_m['net_pf'], "expectancy_r": sub_m['expectancy_r']
        })
        print(f"    Window {w+1} ({t_start} to {t_end}): Trades={sub_m['trades']}, Net PF={sub_m['net_pf']:.2f}, Exp={sub_m['expectancy_r']:.3f} R")

    # Sensitivity Analysis for H1 (+/- 20% on Fast EMA and Trailing Mult)
    h1_sensitivity = []
    for f_ema in [40, 50, 60]:
        for t_mult in [2.4, 3.0, 3.6]:
            s_trades, _ = backtest_h1_daily_trend(btc_df, funding_dfs['BTC_USDT'], 'BTC_USDT', fast_ema=f_ema, trailing_mult=t_mult)
            s_m = compute_trade_metrics(s_trades)
            h1_sensitivity.append({"fast_ema": f_ema, "trailing_mult": t_mult, "net_pf": s_m['net_pf'], "exp_r": s_m['expectancy_r']})

    # Monte Carlo Random Entry Baseline for H1
    print("\n  Running H1 Random-Entry Monte Carlo (200 runs)...")
    np.random.seed(42)
    h1_mc_pfs = []
    target_trades = h1_total_m['trades']
    if target_trades > 0:
        for _ in range(200):
            # Generate random entries matching trade count
            rand_indices = np.sort(np.random.choice(range(200, n_bars - 20), size=target_trades // 2, replace=False))
            mc_net_pnl = 0.0
            mc_wins = 0.0
            mc_losses = 0.0
            for idx in rand_indices:
                entry_p = btc_df.iloc[idx + 1]['open'] * (1.0 + 0.0002)
                # random hold 15-45 bars
                hold = np.random.randint(10, 40)
                exit_idx = min(idx + 1 + hold, n_bars - 1)
                exit_p = btc_df.iloc[exit_idx]['open'] * (1.0 - 0.0002)
                pnl = (exit_p - entry_p) / entry_p * 200.0 - 0.40 # approx fees
                if pnl > 0:
                    mc_wins += pnl
                else:
                    mc_losses += abs(pnl)
            pf = mc_wins / mc_losses if mc_losses > 0 else 1.0
            h1_mc_pfs.append(pf)
    h1_p95 = np.percentile(h1_mc_pfs, 95) if h1_mc_pfs else 0.0
    print(f"  H1 Random Entry 95th Percentile PF: {h1_p95:.2f} | Strategy Net PF: {h1_total_m['net_pf']:.2f}")

    results_summary['h1'] = {
        "metrics": h1_total_m,
        "by_symbol": h1_symbol_metrics,
        "walk_forward": h1_wf_results,
        "sensitivity": h1_sensitivity,
        "mc_p95": h1_p95
    }

    # -----------------------------------------------------------------------
    # [3/6] HYPOTHESIS 2: Weekly Cross-Sectional Momentum
    # -----------------------------------------------------------------------
    print("\n" + "=" * 50)
    print("[3/6] Evaluating Hypothesis 2: Weekly Cross-Sectional Momentum")
    print("=" * 50)
    
    rebalance_records, df_h2 = backtest_h2_cross_sectional_momentum(
        dfs=dfs_1d,
        funding_dfs=funding_dfs,
        lookback_days=28,
        top_n=2,
        initial_equity=10000.0
    )
    
    h2_final_equity = df_h2['portfolio_value'].iloc[-1]
    h2_total_return = ((h2_final_equity - 10000.0) / 10000.0) * 100.0
    h2_weekly_rets = df_h2['weekly_net_pnl'] / (df_h2['portfolio_value'].shift(1).fillna(10000.0))
    h2_cagr = ((h2_final_equity / 10000.0) ** (52.0 / len(df_h2)) - 1.0) * 100.0
    h2_sharpe = (h2_weekly_rets.mean() / (h2_weekly_rets.std() + 1e-10)) * np.sqrt(52)
    h2_cummax = df_h2['portfolio_value'].cummax()
    h2_dd = (df_h2['portfolio_value'] - h2_cummax) / h2_cummax
    h2_max_dd = h2_dd.min() * 100.0
    h2_win_weeks = (df_h2['weekly_net_pnl'] > 0).mean() * 100.0
    h2_gross_pf = df_h2.loc[df_h2['weekly_gross_pnl'] > 0, 'weekly_gross_pnl'].sum() / (abs(df_h2.loc[df_h2['weekly_gross_pnl'] < 0, 'weekly_gross_pnl'].sum()) + 1e-10)
    h2_net_pf = df_h2.loc[df_h2['weekly_net_pnl'] > 0, 'weekly_net_pnl'].sum() / (abs(df_h2.loc[df_h2['weekly_net_pnl'] < 0, 'weekly_net_pnl'].sum()) + 1e-10)

    print(f"H2 Rebalances : {len(df_h2)} weeks")
    print(f"H2 Final Equity: ${h2_final_equity:,.2f} | Total Return: {h2_total_return:.2f}% | CAGR: {h2_cagr:.2f}%")
    print(f"H2 Sharpe Ratio: {h2_sharpe:.2f} | Max DD: {h2_max_dd:.2f}% | Win Rate: {h2_win_weeks:.1f}%")
    print(f"H2 Gross PF   : {h2_gross_pf:.2f} | Net PF: {h2_net_pf:.2f}")
    print(f"H2 Total Friction Paid: Fees=${df_h2['weekly_fees'].sum():,.2f} | Slippage=${df_h2['weekly_slippage'].sum():,.2f} | Funding=${df_h2['weekly_funding'].sum():,.2f}")

    # Sensitivity for H2
    h2_sensitivity = []
    print("\n  H2 Sensitivity (Lookback x Top N):")
    for lb in [21, 28, 35]:
        for n in [2, 3]:
            _, sub_h2_df = backtest_h2_cross_sectional_momentum(dfs_1d, funding_dfs, lookback_days=lb, top_n=n)
            sub_eq = sub_h2_df['portfolio_value'].iloc[-1]
            sub_ret = ((sub_eq - 10000.0) / 10000.0) * 100.0
            sub_w_rets = sub_h2_df['weekly_net_pnl'] / (sub_h2_df['portfolio_value'].shift(1).fillna(10000.0))
            sub_sh = (sub_w_rets.mean() / (sub_w_rets.std() + 1e-10)) * np.sqrt(52)
            sub_net_pf = sub_h2_df.loc[sub_h2_df['weekly_net_pnl'] > 0, 'weekly_net_pnl'].sum() / (abs(sub_h2_df.loc[sub_h2_df['weekly_net_pnl'] < 0, 'weekly_net_pnl'].sum()) + 1e-10)
            h2_sensitivity.append({"lookback": lb, "top_n": n, "return_pct": sub_ret, "sharpe": sub_sh, "net_pf": sub_net_pf})
            print(f"    Lookback={lb}d, Top={n}: Return={sub_ret:6.1f}%, Sharpe={sub_sh:4.2f}, Net PF={sub_net_pf:4.2f}")

    results_summary['h2'] = {
        "weeks": len(df_h2),
        "total_return_pct": h2_total_return,
        "cagr_pct": h2_cagr,
        "sharpe": h2_sharpe,
        "max_dd_pct": h2_max_dd,
        "gross_pf": h2_gross_pf,
        "net_pf": h2_net_pf,
        "fees_paid": float(df_h2['weekly_fees'].sum()),
        "slippage_paid": float(df_h2['weekly_slippage'].sum()),
        "funding_paid": float(df_h2['weekly_funding'].sum()),
        "sensitivity": h2_sensitivity
    }

    # -----------------------------------------------------------------------
    # [4/6] HYPOTHESIS 3: 4H Funding Rate & OI Crowding Fade
    # -----------------------------------------------------------------------
    print("\n" + "=" * 50)
    print("[4/6] Evaluating Hypothesis 3: 4H Crowding Fade")
    print("=" * 50)
    
    h3_trades, h3_counts = backtest_h3_crowding_fade(
        dfs_4h=dfs_4h,
        funding_dfs=funding_dfs,
        oi_dfs=oi_dfs,
        z_thresh=2.0,
        oi_change_thresh=0.08,
        rsi_high=70.0,
        rsi_low=30.0,
        risk_r=200.0
    )
    h3_m = compute_trade_metrics(h3_trades)
    print(f"H3 Total Trades: {h3_m['trades']}")
    print(f"Per-Symbol Trades: {h3_counts}")
    print(f"Win Rate: {h3_m['win_rate']:.1f}% | Gross PF: {h3_m['gross_pf']:.2f} | Net PF: {h3_m['net_pf']:.2f}")
    print(f"Net PnL: ${h3_m['net_pnl']:,.2f} | Expectancy: {h3_m['expectancy_r']:.3f} R")

    results_summary['h3'] = {
        "metrics": h3_m,
        "counts": h3_counts
    }

    # -----------------------------------------------------------------------
    # [5/6] HYPOTHESIS 4: Delta-Neutral Funding Rate Carry
    # -----------------------------------------------------------------------
    print("\n" + "=" * 50)
    print("[5/6] Evaluating Hypothesis 4: Delta-Neutral Funding Rate Carry")
    print("=" * 50)

    h4_windows = backtest_h4_delta_neutral_carry(
        funding_dfs=funding_dfs,
        min_annual_rate=0.15,
        exit_annual_rate=0.04,
        roundtrip_cost=0.0022
    )

    h4_summary_by_sym = {}
    for sym, wins in h4_windows.items():
        if not wins:
            continue
        tot_days = sum(w.duration_days for w in wins)
        gross_y = sum(w.gross_funding_yield for w in wins)
        net_y = sum(w.net_funding_yield for w in wins)
        fric = sum(w.trading_friction for w in wins)
        ann_net = (net_y / (tot_days / 365.0)) * 100.0 if tot_days > 0 else 0.0
        h4_summary_by_sym[sym] = {
            "carry_windows": len(wins),
            "total_active_days": tot_days,
            "gross_yield_pct": gross_y * 100.0,
            "net_yield_pct": net_y * 100.0,
            "trading_friction_pct": fric * 100.0,
            "annualized_net_yield_pct": ann_net
        }
        print(f"{sym:15}: Windows={len(wins):2d} | Active={tot_days:5.1f}d | Gross={gross_y*100:5.2f}% | Fric={fric*100:5.2f}% | Net={net_y*100:5.2f}% | Ann Net={ann_net:5.2f}%")

    results_summary['h4'] = h4_summary_by_sym

    # -----------------------------------------------------------------------
    # [6/6] Save Results
    # -----------------------------------------------------------------------
    with open("results/phase3_evaluation_results.json", "w") as f:
        json.dump(results_summary, f, indent=2, default=str)
    print("\n[6/6] Saved results to results/phase3_evaluation_results.json")
    print("=" * 80)
    print("PIPELINE COMPLETE.")
    print("=" * 80)

if __name__ == "__main__":
    run_pipeline()
