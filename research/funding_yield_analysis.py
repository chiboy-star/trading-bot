"""
Funding Rate Arbitrage / Carry Analysis
Evaluates the quantitative viability of:
1. Pure Delta-Neutral Basis / Cash-and-Carry (Long Spot / Short Perp)
2. Directional Funding Dislocation Harvest (Fading Crowded Rates)
"""

import os
import sys
import glob
import pandas as pd
import numpy as np

def analyze_funding():
    files = sorted(glob.glob("research/data/*_funding.parquet"))
    print("=" * 70)
    print("FUNDING RATE CARRY & YIELD ANALYSIS (2+ YEARS)")
    print("=" * 70)
    
    summary = []
    for f in files:
        sym = os.path.basename(f).replace("_funding.parquet", "")
        df = pd.read_parquet(f)
        if 'datetime' not in df.columns and 'timestamp' in df.columns:
            df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
        df = df.sort_values('timestamp').reset_index(drop=True)
        
        # Funding rate per 8 hours
        mean_rate = df['funding_rate'].mean()
        # Annualized rate = mean_rate * 3 * 365
        ann_yield_pct = mean_rate * 3 * 365 * 100
        
        # Proportion of positive funding intervals
        pct_positive = (df['funding_rate'] > 0).mean() * 100
        
        # Total cumulative funding rate earned by a Short perp holder
        cum_funding_short_pct = df['funding_rate'].sum() * 100
        
        summary.append({
            'symbol': sym,
            'records': len(df),
            'mean_8h_pct': mean_rate * 100,
            'ann_yield_pct': ann_yield_pct,
            'pct_positive': pct_positive,
            'cum_short_pnl_pct': cum_funding_short_pct
        })
        
    res_df = pd.DataFrame(summary)
    print(res_df.to_string(index=False))
    
    print("\n[FINDINGS]")
    avg_ann_yield = res_df['ann_yield_pct'].mean()
    print(f"Average Annualized Funding Yield across all pairs: {avg_ann_yield:.2f}%")
    print(f"BTC Annualized Funding Yield: {res_df[res_df['symbol'] == 'BTC_USDT']['ann_yield_pct'].values[0]:.2f}%")
    print(f"ETH Annualized Funding Yield: {res_df[res_df['symbol'] == 'ETH_USDT']['ann_yield_pct'].values[0]:.2f}%")
    print(f"SOL Annualized Funding Yield: {res_df[res_df['symbol'] == 'SOL_USDT']['ann_yield_pct'].values[0]:.2f}%")

if __name__ == '__main__':
    analyze_funding()
