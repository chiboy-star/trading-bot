"""
Step 2: Comprehensive Institutional Audit of Hypothesis 2 (Cross-Sectional Momentum)
Vectorized for instant execution and exact institutional auditing.
"""

import os
import sys
import numpy as np
import pandas as pd
from typing import Dict, List, Tuple
from evaluate_hypotheses import (
    load_data_1d,
    load_funding_data,
    get_slippage,
    FEE_TAKER
)

sys.stdout.reconfigure(line_buffering=True)

def run_h2_audit():
    print("=" * 80)
    print("STEP 2: AUDIT OF HYPOTHESIS 2 (CROSS-SECTIONAL MOMENTUM)")
    print("=" * 80)

    dfs_1d = load_data_1d()
    funding_dfs = load_funding_data()

    # -----------------------------------------------------------------------
    # 2.1 Listing Dates & Point-in-Time Survivorship Analysis
    # -----------------------------------------------------------------------
    print("\n--- 2.1 Symbol Listing Dates & Data Span ---")
    symbol_spans = []
    for sym, df in dfs_1d.items():
        t0 = df['datetime'].min()
        t1 = df['datetime'].max()
        symbol_spans.append({
            "symbol": sym,
            "first_date": t0.strftime('%Y-%m-%d'),
            "last_date": t1.strftime('%Y-%m-%d'),
            "days": len(df),
            "existed_at_start": t0.strftime('%Y-%m-%d') <= '2022-04-25'
        })
    df_spans = pd.DataFrame(symbol_spans).sort_values("first_date")
    print(df_spans.to_string(index=False))

    large_caps_start = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "DOGE_USDT"]
    print(f"\nStart-of-Dataset Universe (Large Caps existing since 2022-04-24): {large_caps_start}")

    # Pre-align all data
    all_symbols = list(dfs_1d.keys())
    close_dict = {}
    open_dict = {}
    for sym in all_symbols:
        sub = dfs_1d[sym].set_index('datetime').sort_index()
        close_dict[sym] = sub['close']
        open_dict[sym] = sub['open']

    all_closes = pd.DataFrame(close_dict).dropna(subset=['BTC_USDT'])
    all_opens = pd.DataFrame(open_dict).reindex(all_closes.index)
    btc_ema50 = all_closes['BTC_USDT'].ewm(span=50, adjust=False).mean()
    rebalance_dates = all_closes.index[::7]

    # Precompute weekly holding net returns for each symbol
    # week idx -> entry_dt (Monday open), exit_dt (next Monday open)
    week_info = []
    for idx in range(len(rebalance_dates) - 1):
        dt = rebalance_dates[idx]
        next_dt = rebalance_dates[idx + 1]
        pos_in_closes = all_closes.index.get_loc(dt)
        if pos_in_closes < 28:
            continue
        curr_row = all_closes.loc[dt]
        btc_bull = curr_row['BTC_USDT'] > btc_ema50.loc[dt]
        start_dt = all_closes.index[pos_in_closes - 28]

        open_idx = all_closes.index.get_loc(dt) + 1
        close_idx = all_closes.index.get_loc(next_dt) + 1
        if close_idx >= len(all_opens):
            close_idx = len(all_opens) - 1

        entry_dt = all_opens.index[open_idx]
        exit_dt = all_opens.index[close_idx]

        # Calculate momentum ranking return for each symbol
        mom_returns = {}
        for s in all_symbols:
            if pd.notna(curr_row[s]) and pd.notna(all_closes.loc[start_dt, s]) and (all_closes[s].loc[:dt].count() >= 45):
                mom_returns[s] = (all_closes.loc[dt, s] / all_closes.loc[start_dt, s]) - 1.0

        # Precompute next week trade return for each symbol
        trade_net_ret = {}
        for s in all_symbols:
            e_p = all_opens.loc[entry_dt, s]
            x_p = all_opens.loc[exit_dt, s]
            if pd.isna(e_p) or pd.isna(x_p) or e_p <= 0:
                trade_net_ret[s] = 0.0
                continue
            slip = get_slippage(s)
            eff_entry = e_p * (1.0 + slip)
            eff_exit = x_p * (1.0 - slip)
            gross_pct = (eff_exit - eff_entry) / eff_entry
            fee_pct = (FEE_TAKER * 2)

            f_df = funding_dfs.get(s, pd.DataFrame())
            f_cost_pct = 0.0
            if len(f_df) > 0:
                f_mask = (f_df['datetime'] >= entry_dt) & (f_df['datetime'] <= exit_dt)
                f_cost_pct = f_df.loc[f_mask, 'funding_rate'].sum()

            net_pct = gross_pct - fee_pct - f_cost_pct
            trade_net_ret[s] = net_pct

        week_info.append({
            "dt": dt,
            "btc_bull": btc_bull,
            "mom_returns": mom_returns,
            "trade_net_ret": trade_net_ret
        })

    print(f"Precomputed {len(week_info)} weekly rebalance cycles.")

    # Simulation function
    def simulate_strategy(universe_filter: List[str], compounding: bool = True, shuffle: bool = False, seed: int = 0):
        equity = 10000.0
        records = []
        sym_pnl = {s: 0.0 for s in universe_filter}
        sym_trades = {s: 0 for s in universe_filter}
        rng = np.random.default_rng(seed) if shuffle else None

        for w in week_info:
            btc_bull = w['btc_bull']
            mom = {s: r for s, r in w['mom_returns'].items() if s in universe_filter}
            
            if btc_bull and len(mom) > 0:
                if shuffle:
                    candidates = list(mom.keys())
                    selected = list(rng.choice(candidates, size=min(2, len(candidates)), replace=False))
                else:
                    sorted_mom = sorted(mom.items(), key=lambda x: x[1], reverse=True)
                    selected = [s for s, _ in sorted_mom[:2]]
            else:
                selected = []

            weekly_net = 0.0
            alloc_per_sym = (equity / len(selected)) if (compounding and len(selected) > 0) else (5000.0 if len(selected) > 0 else 0.0)

            for s in selected:
                ret_pct = w['trade_net_ret'].get(s, 0.0)
                pos_pnl = alloc_per_sym * ret_pct
                weekly_net += pos_pnl
                sym_pnl[s] += pos_pnl
                sym_trades[s] += 1

            equity += weekly_net
            records.append({"dt": w['dt'], "equity": equity, "weekly_net": weekly_net, "btc_bull": btc_bull, "selected": selected})

        return pd.DataFrame(records), sym_pnl, sym_trades

    # -----------------------------------------------------------------------
    # (i) Large Caps Only (BTC, ETH, SOL, XRP, DOGE)
    # -----------------------------------------------------------------------
    print("\n--- 2.1(i) Re-run on Large Caps Only (No survivorship / no meme additions) ---")
    df_lc, lc_pnl, lc_trades = simulate_strategy(large_caps_start, compounding=True)
    lc_final = df_lc['equity'].iloc[-1]
    lc_ret = ((lc_final - 10000.0) / 10000.0) * 100.0
    lc_w_rets = df_lc['weekly_net'] / df_lc['equity'].shift(1).fillna(10000.0)
    lc_sharpe = (lc_w_rets.mean() / (lc_w_rets.std() + 1e-10)) * np.sqrt(52)
    lc_cummax = df_lc['equity'].cummax()
    lc_max_dd = ((df_lc['equity'] - lc_cummax) / lc_cummax).min() * 100.0
    lc_wins = df_lc.loc[df_lc['weekly_net'] > 0, 'weekly_net'].sum()
    lc_loss = abs(df_lc.loc[df_lc['weekly_net'] < 0, 'weekly_net'].sum())
    lc_pf = lc_wins / lc_loss if lc_loss > 0 else 999.0

    print(f"Large Caps Final Equity: ${lc_final:,.2f} | Total Return: {lc_ret:.2f}%")
    print(f"Sharpe Ratio           : {lc_sharpe:.2f} | Max DD: {lc_max_dd:.2f}% | Net PF: {lc_pf:.2f}")
    print("Large Caps Symbol PnL Contribution:")
    for s, pnl in lc_pnl.items():
        print(f"  {s:15}: Net PnL = ${pnl:10,.2f} ({lc_trades[s]:2d} weeks selected)")

    # -----------------------------------------------------------------------
    # 2.2 Permutation Test (1,000 Monte Carlo Shuffles)
    # -----------------------------------------------------------------------
    print("\n--- 2.2 Permutation Test (1,000 Random Shuffles of Cross-Sectional Ranking) ---")
    df_real, real_pnl, real_trades = simulate_strategy(all_symbols, compounding=True)
    real_final = df_real['equity'].iloc[-1]
    real_ret = ((real_final - 10000.0) / 10000.0) * 100.0
    real_w_rets = df_real['weekly_net'] / df_real['equity'].shift(1).fillna(10000.0)
    real_sharpe = (real_w_rets.mean() / (real_w_rets.std() + 1e-10)) * np.sqrt(52)

    perm_returns = []
    perm_sharpes = []
    for seed in range(1000):
        df_p, _, _ = simulate_strategy(all_symbols, compounding=True, shuffle=True, seed=seed)
        p_fin = df_p['equity'].iloc[-1]
        p_ret = ((p_fin - 10000.0) / 10000.0) * 100.0
        p_w = df_p['weekly_net'] / df_p['equity'].shift(1).fillna(10000.0)
        p_sh = (p_w.mean() / (p_w.std() + 1e-10)) * np.sqrt(52)
        perm_returns.append(p_ret)
        perm_sharpes.append(p_sh)

    perm_returns = np.array(perm_returns)
    perm_sharpes = np.array(perm_sharpes)
    p_ret_pct = (np.sum(perm_returns < real_ret) / len(perm_returns)) * 100.0
    p_sh_pct = (np.sum(perm_sharpes < real_sharpe) / len(perm_sharpes)) * 100.0

    print(f"Real Strategy Return: {real_ret:,.2f}% | Real Sharpe: {real_sharpe:.2f}")
    print(f"Random Permutation Median Return: {np.median(perm_returns):,.2f}%")
    print(f"Random Permutation 95th Pct Return: {np.percentile(perm_returns, 95):,.2f}%")
    print(f"Random Permutation 99th Pct Return: {np.percentile(perm_returns, 99):,.2f}%")
    print(f"Empirical Percentile of Real Strategy: {p_ret_pct:.2f}% (Return) | {p_sh_pct:.2f}% (Sharpe)")

    # -----------------------------------------------------------------------
    # 2.4 Fixed-Risk (Non-Compounding $5,000 / slot)
    # -----------------------------------------------------------------------
    print("\n--- 2.4 Sizing: Fixed-Risk (Non-Compounding $5,000 / slot) ---")
    df_fixed, fixed_pnl, fixed_trades = simulate_strategy(all_symbols, compounding=False)
    fixed_pnl_total = df_fixed['weekly_net'].sum()
    fixed_wins = df_fixed.loc[df_fixed['weekly_net'] > 0, 'weekly_net'].sum()
    fixed_loss = abs(df_fixed.loc[df_fixed['weekly_net'] < 0, 'weekly_net'].sum())
    fixed_net_pf = fixed_wins / fixed_loss if fixed_loss > 0 else 999.0
    total_r = fixed_pnl_total / 200.0
    exp_r = total_r / len(df_fixed)
    fixed_cummax = df_fixed['equity'].cummax()
    fixed_max_dd_dollars = (df_fixed['equity'] - fixed_cummax).min()
    fixed_max_dd_pct = ((df_fixed['equity'] - fixed_cummax) / fixed_cummax).min() * 100.0

    print(f"Fixed-Risk Total Net PnL : ${fixed_pnl_total:,.2f}")
    print(f"Fixed-Risk Total R       : {total_r:+.2f} R across {len(df_fixed)} rebalances")
    print(f"Fixed-Risk Expectancy    : {exp_r:+.3f} R / week")
    print(f"Fixed-Risk Net PF        : {fixed_net_pf:.2f}")
    print(f"Fixed-Risk Max Drawdown  : ${fixed_max_dd_dollars:,.2f} ({fixed_max_dd_pct:.2f}%)")
    print("Leverage: Strictly 1.0x (unleveraged spot or 1x perp). Liquidations: Impossible at 1x leverage.")

    # -----------------------------------------------------------------------
    # 2.5 Sub-Period Breakdown & Symbol Contribution
    # -----------------------------------------------------------------------
    print("\n--- 2.5 Sub-Period Breakdown & Symbol Contribution ---")
    df_real['year'] = df_real['dt'].dt.year
    periods = {
        "2022 Bear (Apr-Dec 2022)": (df_real['dt'] < '2023-01-01'),
        "2023 Recovery": (df_real['dt'] >= '2023-01-01') & (df_real['dt'] < '2024-01-01'),
        "2024 Bull": (df_real['dt'] >= '2024-01-01') & (df_real['dt'] < '2025-01-01'),
        "2025-2026 Expansion": (df_real['dt'] >= '2025-01-01')
    }

    sub_period_stats = []
    for name, mask in periods.items():
        sub = df_real[mask]
        if len(sub) == 0:
            continue
        p_eq_start = sub['equity'].iloc[0] - sub['weekly_net'].iloc[0]
        p_eq_end = sub['equity'].iloc[-1]
        p_ret = ((p_eq_end - p_eq_start) / p_eq_start) * 100.0
        p_w_rets = sub['weekly_net'] / (sub['equity'].shift(1).fillna(p_eq_start))
        p_sh = (p_w_rets.mean() / (p_w_rets.std() + 1e-10)) * np.sqrt(52)
        p_cummax = sub['equity'].cummax()
        p_mdd = ((sub['equity'] - p_cummax) / p_cummax).min() * 100.0
        p_bull_pct = (sub['btc_bull'].sum() / len(sub)) * 100.0
        p_wins = sub.loc[sub['weekly_net'] > 0, 'weekly_net'].sum()
        p_loss = abs(sub.loc[sub['weekly_net'] < 0, 'weekly_net'].sum())
        p_pf = p_wins / p_loss if p_loss > 0 else 999.0
        sub_period_stats.append({
            "Period": name,
            "Weeks": len(sub),
            "BTC Bull %": f"{p_bull_pct:.1f}%",
            "Net Return": f"{p_ret:+.1f}%",
            "Sharpe": f"{p_sh:.2f}",
            "Max DD": f"{p_mdd:.1f}%",
            "Net PF": f"{p_pf:.2f}"
        })
    print(pd.DataFrame(sub_period_stats).to_string(index=False))

    print("\nFull Universe Symbol PnL Contribution (Compounded Strategy):")
    sorted_syms = sorted(real_pnl.items(), key=lambda x: x[1], reverse=True)
    total_real_pnl = sum(real_pnl.values())
    for s, pnl in sorted_syms:
        pct_contrib = (pnl / total_real_pnl) * 100.0 if total_real_pnl > 0 else 0.0
        print(f"  {s:15}: Net PnL = ${pnl:10,.2f} ({pct_contrib:5.1f}% of total) | {real_trades[s]:3d} weeks held")

    print("\nFixed-Risk Symbol PnL Contribution (Uncompounded $5k/slot):")
    sorted_fixed_syms = sorted(fixed_pnl.items(), key=lambda x: x[1], reverse=True)
    total_fixed_pnl = sum(fixed_pnl.values())
    for s, pnl in sorted_fixed_syms:
        pct_contrib = (pnl / total_fixed_pnl) * 100.0 if total_fixed_pnl > 0 else 0.0
        print(f"  {s:15}: Net PnL = ${pnl:10,.2f} ({pct_contrib:5.1f}% of total) | {fixed_trades[s]:3d} weeks held")

    # -----------------------------------------------------------------------
    # 2.6 Multiple-Testing Correction
    # -----------------------------------------------------------------------
    print("\n--- 2.6 Multiple Testing & Overfitting Penalty ---")
    M = 50
    import math
    t_stat = (real_w_rets.mean() / (real_w_rets.std() + 1e-10)) * np.sqrt(len(real_w_rets))
    p_val = 1.0 - 0.5 * (1.0 + math.erf(t_stat / np.sqrt(2)))
    bonferroni_sig = p_val < (0.05 / M)
    print(f"Total Variant Trials Tested Across Project : {M}")
    print(f"H2 Weekly T-Statistic                      : {t_stat:.3f}")
    print(f"One-Sided P-Value                          : {p_val:.6f}")
    print(f"Bonferroni Adjusted Significance (p < {0.05/M:.5f}): {'SIGNIFICANT' if bonferroni_sig else 'NOT SIGNIFICANT'}")

if __name__ == "__main__":
    run_h2_audit()
