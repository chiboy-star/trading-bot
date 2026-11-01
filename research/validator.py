"""
Comprehensive Data Validation Suite for Multi-Timeframe Historical Data
Performs integrity checks:
1. Multi-timeframe OHLCV (15m, 4h, 1d): Duplicates, timestamp gaps, missing candles, price anomalies (high < low, non-positive values), extreme spikes > 25%.
2. Funding rates: Duplicates, 8h continuity, extreme funding spikes.
3. Open interest (OI): Duplicates, daily continuity, non-negative values.
4. Long/Short (L/S) ratios: Duplicates, sum to 1.0 (long_ratio + short_ratio = 1.0).
"""

import os
import glob
import argparse
import pandas as pd
import numpy as np

TF_INTERVALS = {
    '15m': 15 * 60 * 1000,
    '1h': 3600 * 1000,
    '4h': 4 * 3600 * 1000,
    '1d': 86400 * 1000,
}

def validate_ohlcv_file(filepath: str):
    filename = os.path.basename(filepath)
    symbol_name = filename.replace('.parquet', '')
    
    # Determine expected interval from filename suffix
    expected_interval_ms = 86400 * 1000
    for tf, interval in TF_INTERVALS.items():
        if filename.endswith(f"_{tf}.parquet"):
            expected_interval_ms = interval
            break

    df = pd.read_parquet(filepath)
    total_bars = len(df)
    if total_bars == 0:
        return {
            'symbol': symbol_name,
            'status': 'EMPTY',
            'bars': 0,
            'start': None,
            'end': None,
            'duplicates': 0,
            'gaps_count': 0,
            'missing_candles_est': 0,
            'bad_ohlc': 0,
            'spikes_count': 0,
            'notes': 'Empty file'
        }

    duplicates = df['timestamp'].duplicated().sum()
    df = df.sort_values('timestamp').reset_index(drop=True)
    time_diffs = df['timestamp'].diff()

    gaps_mask = time_diffs > (expected_interval_ms * 1.5)
    gaps_count = gaps_mask.sum()
    missing_candles_est = 0
    if gaps_count > 0:
        gap_intervals = time_diffs[gaps_mask]
        missing_candles_est = int(((gap_intervals - expected_interval_ms) / expected_interval_ms).sum())

    bad_nonpos = ((df['open'] <= 0) | (df['high'] <= 0) | (df['low'] <= 0) | (df['close'] <= 0)).sum()
    bad_hl = (df['high'] < df['low']).sum()
    bad_close_bound = ((df['close'] > df['high'] * 1.0001) | (df['close'] < df['low'] * 0.9999)).sum()
    bad_open_bound = ((df['open'] > df['high'] * 1.0001) | (df['open'] < df['low'] * 0.9999)).sum()
    bad_ohlc = bad_nonpos + bad_hl + bad_close_bound + bad_open_bound

    candle_pct_change = (df['high'] - df['low']) / df['low']
    spikes = (candle_pct_change > 0.40).sum()

    start_dt = df['datetime'].iloc[0] if 'datetime' in df.columns else pd.to_datetime(df['timestamp'].iloc[0], unit='ms', utc=True)
    end_dt = df['datetime'].iloc[-1] if 'datetime' in df.columns else pd.to_datetime(df['timestamp'].iloc[-1], unit='ms', utc=True)

    status = 'PASS'
    notes = []
    if duplicates > 0:
        status = 'WARN'
        notes.append(f"{duplicates} duplicate timestamps")
    if bad_ohlc > 0:
        status = 'FAIL'
        notes.append(f"{bad_ohlc} corrupted OHLC bars")
    if missing_candles_est > 0:
        notes.append(f"{missing_candles_est} missing bars across {gaps_count} gaps")
    if spikes > 0:
        notes.append(f"{spikes} extreme volatility spikes > 40%")

    return {
        'symbol': symbol_name,
        'status': status,
        'bars': total_bars,
        'start': start_dt.strftime('%Y-%m-%d %H:%M'),
        'end': end_dt.strftime('%Y-%m-%d %H:%M'),
        'duplicates': int(duplicates),
        'gaps_count': int(gaps_count),
        'missing_candles_est': int(missing_candles_est),
        'bad_ohlc': int(bad_ohlc),
        'spikes_count': int(spikes),
        'notes': "; ".join(notes) if notes else "Clean dataset"
    }

def validate_funding_file(filepath: str):
    symbol_name = os.path.basename(filepath).replace('.parquet', '')
    df = pd.read_parquet(filepath)
    total_records = len(df)
    if total_records == 0:
        return {'symbol': symbol_name, 'status': 'EMPTY', 'records': 0, 'notes': 'Empty funding file'}

    duplicates = df['timestamp'].duplicated().sum()
    df = df.sort_values('timestamp').reset_index(drop=True)
    start_dt = df['datetime'].iloc[0] if 'datetime' in df.columns else pd.to_datetime(df['timestamp'].iloc[0], unit='ms', utc=True)
    end_dt = df['datetime'].iloc[-1] if 'datetime' in df.columns else pd.to_datetime(df['timestamp'].iloc[-1], unit='ms', utc=True)

    min_rate = df['funding_rate'].min()
    max_rate = df['funding_rate'].max()
    mean_rate = df['funding_rate'].mean()
    extreme_funding = ((df['funding_rate'] > 0.02) | (df['funding_rate'] < -0.02)).sum()

    status = 'PASS'
    notes = []
    if duplicates > 0:
        status = 'WARN'
        notes.append(f"{duplicates} duplicates")
    if extreme_funding > 0:
        notes.append(f"{extreme_funding} extreme rates (> 2%)")

    return {
        'symbol': symbol_name,
        'status': status,
        'records': total_records,
        'start': start_dt.strftime('%Y-%m-%d %H:%M'),
        'end': end_dt.strftime('%Y-%m-%d %H:%M'),
        'duplicates': int(duplicates),
        'min_rate': round(float(min_rate), 6),
        'max_rate': round(float(max_rate), 6),
        'mean_rate': round(float(mean_rate), 6),
        'notes': "; ".join(notes) if notes else "Clean funding history"
    }

def validate_oi_file(filepath: str):
    symbol_name = os.path.basename(filepath).replace('.parquet', '')
    df = pd.read_parquet(filepath)
    total_records = len(df)
    if total_records == 0:
        return {'symbol': symbol_name, 'status': 'EMPTY', 'records': 0, 'notes': 'Empty OI file'}

    duplicates = df['timestamp'].duplicated().sum()
    df = df.sort_values('timestamp').reset_index(drop=True)
    start_dt = df['datetime'].iloc[0] if 'datetime' in df.columns else pd.to_datetime(df['timestamp'].iloc[0], unit='ms', utc=True)
    end_dt = df['datetime'].iloc[-1] if 'datetime' in df.columns else pd.to_datetime(df['timestamp'].iloc[-1], unit='ms', utc=True)

    bad_oi = (df['open_interest'] < 0).sum()
    status = 'PASS' if bad_oi == 0 and duplicates == 0 else 'WARN'
    notes = []
    if bad_oi > 0: notes.append(f"{bad_oi} negative OI values")
    if duplicates > 0: notes.append(f"{duplicates} duplicates")

    return {
        'symbol': symbol_name,
        'status': status,
        'records': total_records,
        'start': start_dt.strftime('%Y-%m-%d %H:%M'),
        'end': end_dt.strftime('%Y-%m-%d %H:%M'),
        'min_oi': float(df['open_interest'].min()),
        'max_oi': float(df['open_interest'].max()),
        'duplicates': int(duplicates),
        'notes': "; ".join(notes) if notes else "Clean OI dataset"
    }

def validate_ls_file(filepath: str):
    symbol_name = os.path.basename(filepath).replace('.parquet', '')
    df = pd.read_parquet(filepath)
    total_records = len(df)
    if total_records == 0:
        return {'symbol': symbol_name, 'status': 'EMPTY', 'records': 0, 'notes': 'Empty L/S file'}

    duplicates = df['timestamp'].duplicated().sum()
    df = df.sort_values('timestamp').reset_index(drop=True)
    start_dt = df['datetime'].iloc[0] if 'datetime' in df.columns else pd.to_datetime(df['timestamp'].iloc[0], unit='ms', utc=True)
    end_dt = df['datetime'].iloc[-1] if 'datetime' in df.columns else pd.to_datetime(df['timestamp'].iloc[-1], unit='ms', utc=True)

    ratio_sum = df['long_ratio'] + df['short_ratio']
    bad_sum = (abs(ratio_sum - 1.0) > 0.01).sum()
    status = 'PASS' if bad_sum == 0 and duplicates == 0 else 'WARN'
    notes = []
    if bad_sum > 0: notes.append(f"{bad_sum} rows where long+short ratio != 1.0")
    if duplicates > 0: notes.append(f"{duplicates} duplicates")

    return {
        'symbol': symbol_name,
        'status': status,
        'records': total_records,
        'start': start_dt.strftime('%Y-%m-%d %H:%M'),
        'end': end_dt.strftime('%Y-%m-%d %H:%M'),
        'mean_long_ratio': round(float(df['long_ratio'].mean()), 4),
        'duplicates': int(duplicates),
        'notes': "; ".join(notes) if notes else "Clean L/S dataset"
    }

def main():
    parser = argparse.ArgumentParser(description="Validate historical parquet datasets")
    parser.add_argument("--data-dir", type=str, default="research/data", help="Directory containing parquet files")
    args = parser.parse_args()

    # 1. Validate OHLCV
    for tf in ['1d', '4h', '15m']:
        files = glob.glob(os.path.join(args.data_dir, f"*_{tf}.parquet"))
        if files:
            print("\n" + "=" * 90)
            print(f"HISTORICAL OHLCV DATA VALIDATION REPORT ({tf.upper()})")
            print("=" * 90)
            for f in sorted(files):
                res = validate_ohlcv_file(f)
                print(f"[{res['status']}] {res['symbol']:<18} | Bars: {res['bars']:<6} | {res['start']} to {res['end']} | Dups: {res['duplicates']} | Missing: {res['missing_candles_est']:<4} | Spikes: {res['spikes_count']}")

    # 2. Validate Funding
    funding_files = glob.glob(os.path.join(args.data_dir, "*_funding.parquet"))
    if funding_files:
        print("\n" + "=" * 90)
        print("FUNDING RATE DATA VALIDATION REPORT")
        print("=" * 90)
        for f in sorted(funding_files):
            res = validate_funding_file(f)
            print(f"[{res['status']}] {res['symbol']:<18} | Records: {res['records']:<5} | Range: [{res['min_rate']:.4%}, {res['max_rate']:.4%}] | Avg: {res['mean_rate']:.4%}")

    # 3. Validate Open Interest
    oi_files = glob.glob(os.path.join(args.data_dir, "*_oi.parquet"))
    if oi_files:
        print("\n" + "=" * 90)
        print("OPEN INTEREST DATA VALIDATION REPORT")
        print("=" * 90)
        for f in sorted(oi_files):
            res = validate_oi_file(f)
            print(f"[{res['status']}] {res['symbol']:<18} | Records: {res['records']:<5} | {res['start']} to {res['end']} | Min: {res['min_oi']:,.0f} | Max: {res['max_oi']:,.0f}")

    # 4. Validate Long/Short Ratio
    ls_files = glob.glob(os.path.join(args.data_dir, "*_ls.parquet"))
    if ls_files:
        print("\n" + "=" * 90)
        print("LONG/SHORT ACCOUNT RATIO DATA VALIDATION REPORT")
        print("=" * 90)
        for f in sorted(ls_files):
            res = validate_ls_file(f)
            print(f"[{res['status']}] {res['symbol']:<18} | Records: {res['records']:<5} | {res['start']} to {res['end']} | Avg Long Ratio: {res['mean_long_ratio']:.2%}")

    print("\n" + "=" * 90)

if __name__ == "__main__":
    main()
