"""
Rerun H2 Permutation Test on Point-in-Time Large Caps (BTC, ETH, SOL, XRP, DOGE)
"""

import sys
import numpy as np
import pandas as pd
from evaluate_hypotheses import load_data_1d, load_funding_data, get_slippage, FEE_TAKER

sys.stdout.reconfigure(line_buffering=True)

def run():
    dfs_1d = load_data_1d()
    funding_dfs = load_funding_data()
    large_caps = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "XRP_USDT", "DOGE_USDT"]

    close_dict = {}
    open_dict = {}
    for sym in large_caps:
        sub = dfs_1d[sym].set_index('datetime').sort_index()
        close_dict[sym] = sub['close']
        open_dict[sym] = sub['open']

    closes = pd.DataFrame(close_dict).dropna(subset=['BTC_USDT'])
    opens = pd.DataFrame(open_dict).reindex(closes.index)
    btc_ema50 = closes['BTC_USDT'].ewm(span=50, adjust=False).mean()
    rebalance_dates = closes.index[::7]

    week_info = []
    for idx in range(len(rebalance_dates) - 1):
        dt = rebalance_dates[idx]
        next_dt = rebalance_dates[idx + 1]
        pos_in_closes = closes.index.get_loc(dt)
        if pos_in_closes < 28:
            continue
        curr_row = closes.loc[dt]
        btc_bull = curr_row['BTC_USDT'] > btc_ema50.loc[dt]
        start_dt = closes.index[pos_in_closes - 28]

        open_idx = closes.index.get_loc(dt) + 1
        close_idx = closes.index.get_loc(next_dt) + 1
        if close_idx >= len(opens):
            close_idx = len(opens) - 1

        entry_dt = opens.index[open_idx]
        exit_dt = opens.index[close_idx]

        mom_returns = {}
        for s in large_caps:
            mom_returns[s] = (closes.loc[dt, s] / closes.loc[start_dt, s]) - 1.0

        trade_net_ret = {}
        for s in large_caps:
            e_p = opens.loc[entry_dt, s]
            x_p = opens.loc[exit_dt, s]
            slip = get_slippage(s)
            eff_entry = e_p * (1.0 + slip)
            eff_exit = x_p * (1.0 - slip)
            gross_pct = (eff_exit - eff_entry) / eff_entry
            fee_pct = FEE_TAKER * 2

            f_df = funding_dfs.get(s, pd.DataFrame())
            f_cost_pct = 0.0
            if len(f_df) > 0:
                f_mask = (f_df['datetime'] >= entry_dt) & (f_df['datetime'] <= exit_dt)
                f_cost_pct = f_df.loc[f_mask, 'funding_rate'].sum()

            trade_net_ret[s] = gross_pct - fee_pct - f_cost_pct

        week_info.append({
            "dt": dt,
            "btc_bull": btc_bull,
            "mom_returns": mom_returns,
            "trade_net_ret": trade_net_ret
        })

    def sim(shuffle=False, seed=0):
        equity = 10000.0
        records = []
        rng = np.random.default_rng(seed) if shuffle else None
        for w in week_info:
            btc_bull = w['btc_bull']
            mom = w['mom_returns']
            if btc_bull:
                if shuffle:
                    cands = list(mom.keys())
                    selected = list(rng.choice(cands, size=2, replace=False))
                else:
                    sorted_mom = sorted(mom.items(), key=lambda x: x[1], reverse=True)
                    selected = [s for s, _ in sorted_mom[:2]]
            else:
                selected = []

            weekly_net = 0.0
            alloc = equity / len(selected) if (len(selected) > 0) else 0.0
            for s in selected:
                weekly_net += alloc * w['trade_net_ret'].get(s, 0.0)
            equity += weekly_net
            records.append(weekly_net)
        return equity, np.array(records)

    # Real large-cap run
    real_eq, real_w_net = sim(shuffle=False)
    real_ret = ((real_eq - 10000.0) / 10000.0) * 100.0
    w_rets_real = real_w_net / 10000.0 # approx or exact
    # Exact weekly returns
    eq_curve = [10000.0]
    for w in real_w_net:
        eq_curve.append(eq_curve[-1] + w)
    eq_curve = np.array(eq_curve)
    pct_rets = real_w_net / eq_curve[:-1]
    real_sh = (pct_rets.mean() / (pct_rets.std() + 1e-10)) * np.sqrt(52)

    perm_rets = []
    perm_shs = []
    for s in range(1000):
        p_eq, p_w_net = sim(shuffle=True, seed=s)
        p_ret = ((p_eq - 10000.0) / 10000.0) * 100.0
        p_curve = [10000.0]
        for w in p_w_net:
            p_curve.append(p_curve[-1] + w)
        p_curve = np.array(p_curve)
        p_pct_rets = p_w_net / p_curve[:-1]
        p_sh = (p_pct_rets.mean() / (p_pct_rets.std() + 1e-10)) * np.sqrt(52)
        perm_rets.append(p_ret)
        perm_shs.append(p_sh)

    perm_rets = np.array(perm_rets)
    perm_shs = np.array(perm_shs)
    pct_ret = (np.sum(perm_rets < real_ret) / len(perm_rets)) * 100.0
    pct_sh = (np.sum(perm_shs < real_sh) / len(perm_shs)) * 100.0

    print("--- Large-Cap Universe (5 Start Symbols) Permutation Test (1,000 Runs) ---")
    print(f"Real Large-Cap Return: {real_ret:.2f}% | Sharpe: {real_sh:.2f}")
    print(f"Random Permutation Median Return: {np.median(perm_rets):.2f}% | 95th: {np.percentile(perm_rets, 95):.2f}%")
    print(f"Random Permutation Median Sharpe: {np.median(perm_shs):.2f} | 95th: {np.percentile(perm_shs, 95):.2f}")
    print(f"Empirical Percentile: Return = {pct_ret:.2f}% | Sharpe = {pct_sh:.2f}%")

if __name__ == "__main__":
    run()
