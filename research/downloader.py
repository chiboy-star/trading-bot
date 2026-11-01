"""
Bybit Historical Multi-Timeframe OHLCV, Funding, Open Interest & Account Ratio Downloader
Supports 4+ years pagination, rate limit compliance, DNS fallback, and Parquet persistence.
"""

import os
import sys
import time
import argparse
import logging
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

# DNS Fallback patch for regions where bybit/bytick domains are ISP-blocked
import socket
try:
    import dns.resolver
    resolver = dns.resolver.Resolver()
    resolver.nameservers = ['8.8.8.8', '1.1.1.1']
    orig_getaddrinfo = socket.getaddrinfo

    def resilient_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        try:
            return orig_getaddrinfo(host, port, family, type, proto, flags)
        except Exception:
            answers = resolver.resolve(host, 'A')
            ip = str(answers[0])
            return orig_getaddrinfo(ip, port, family, type, proto, flags)

    socket.getaddrinfo = resilient_getaddrinfo
except ImportError:
    pass

import ccxt

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("Downloader")

# 12 Target Pairs (7 Core + 5 Satellite)
DEFAULT_PAIRS = [
    "BTC/USDT:USDT",
    "ETH/USDT:USDT",
    "SOL/USDT:USDT",
    "SUI/USDT:USDT",
    "XRP/USDT:USDT",
    "DOGE/USDT:USDT",
    "1000PEPE/USDT:USDT",
    "STRK/USDT:USDT",
    "AKE/USDT:USDT",
    "TIA/USDT:USDT",
    "ALT/USDT:USDT",
    "Q/USDT:USDT",
]

def get_symbol_slug(symbol: str) -> str:
    """Converts 'BTC/USDT:USDT' to 'BTC_USDT'"""
    base = symbol.split(':')[0]
    return base.replace('/', '_')

def create_exchange(hostname: str = "bytick.com") -> ccxt.bybit:
    return ccxt.bybit({
        'hostname': hostname,
        'options': {'defaultType': 'future'},
        'enableRateLimit': True,
        'timeout': 30000,
    })

def download_ohlcv_symbol(
    exchange: ccxt.bybit,
    symbol: str,
    timeframe: str = '1d',
    since_ts: int = 0,
    max_retries: int = 5
) -> pd.DataFrame:
    """
    Downloads complete OHLCV history with pagination and retry handling.
    """
    logger.info(f"Downloading {timeframe} OHLCV for {symbol} since {datetime.fromtimestamp(since_ts/1000, timezone.utc).isoformat()}...")
    all_candles = []
    current_since = since_ts
    limit = 1000

    tf_ms = {
        '15m': 15 * 60 * 1000,
        '1h': 3600 * 1000,
        '4h': 4 * 3600 * 1000,
        '1d': 86400 * 1000,
        '1w': 7 * 86400 * 1000
    }
    ms_step = tf_ms.get(timeframe, 86400 * 1000)
    now_ts = int(time.time() * 1000)

    while current_since < now_ts:
        retries = 0
        success = False
        batch = []

        while retries < max_retries and not success:
            try:
                batch = exchange.fetch_ohlcv(symbol, timeframe=timeframe, since=current_since, limit=limit)
                success = True
            except (ccxt.NetworkError, ccxt.RateLimitExceeded, Exception) as e:
                retries += 1
                wait_sec = 2 ** retries
                logger.warning(f"Fetch error for {symbol} ({timeframe}) at {current_since}: {e}. Retrying in {wait_sec}s...")
                time.sleep(wait_sec)

        if not success or not batch:
            # Advance by 30 days if no candles returned (e.g. before inception)
            advance_ms = 30 * 86400 * 1000
            current_since += advance_ms
            if current_since >= now_ts:
                break
            continue

        all_candles.extend(batch)
        last_candle_ts = batch[-1][0]

        if last_candle_ts <= current_since:
            current_since += ms_step
            continue

        current_since = last_candle_ts + ms_step
        time.sleep(0.04)

    if not all_candles:
        logger.warning(f"No candles downloaded for {symbol} ({timeframe}).")
        return pd.DataFrame()

    df = pd.DataFrame(all_candles, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
    df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)
    df = df.drop_duplicates(subset=['timestamp']).sort_values('timestamp').reset_index(drop=True)
    logger.info(f"Finished {symbol} {timeframe}: {len(df)} total bars from {df['datetime'].iloc[0]} to {df['datetime'].iloc[-1]}")
    return df

def download_funding_rates(
    exchange: ccxt.bybit,
    symbol: str,
    since_ts: int = 0,
    max_retries: int = 5
) -> pd.DataFrame:
    """
    Downloads full 8-hour funding rate history with pagination.
    """
    logger.info(f"Downloading funding rates for {symbol}...")
    all_rates = []
    current_since = since_ts
    limit = 200
    now_ts = int(time.time() * 1000)

    while current_since < now_ts:
        retries = 0
        success = False
        batch = []

        while retries < max_retries and not success:
            try:
                batch = exchange.fetch_funding_rate_history(symbol, since=current_since, limit=limit)
                success = True
            except (ccxt.NetworkError, ccxt.RateLimitExceeded, Exception) as e:
                retries += 1
                wait_sec = 2 ** retries
                logger.warning(f"Funding error for {symbol} at {current_since}: {e}. Retrying in {wait_sec}s...")
                time.sleep(wait_sec)

        if not success or not batch:
            # Advance 30 days if no records
            current_since += 30 * 86400 * 1000
            if current_since >= now_ts:
                break
            continue

        all_rates.extend(batch)
        last_ts = batch[-1]['timestamp']

        if len(batch) < 2 or last_ts <= current_since:
            current_since += 8 * 3600 * 1000
            continue

        current_since = last_ts + 1000
        time.sleep(0.04)

    if not all_rates:
        logger.warning(f"No funding rates returned for {symbol}.")
        return pd.DataFrame()

    records = []
    for item in all_rates:
        records.append({
            'timestamp': item['timestamp'],
            'datetime': pd.to_datetime(item['timestamp'], unit='ms', utc=True),
            'funding_rate': float(item['fundingRate']) if item['fundingRate'] is not None else 0.0
        })

    df = pd.DataFrame(records)
    df = df.drop_duplicates(subset=['timestamp']).sort_values('timestamp').reset_index(drop=True)
    logger.info(f"Finished {symbol} Funding: {len(df)} records from {df['datetime'].iloc[0]} to {df['datetime'].iloc[-1]}")
    return df

def download_open_interest(
    exchange: ccxt.bybit,
    symbol: str,
    timeframe: str = '1d',
    since_ts: int = 0,
    max_retries: int = 5
) -> pd.DataFrame:
    """
    Downloads historical Open Interest from Bybit.
    """
    logger.info(f"Downloading {timeframe} Open Interest for {symbol}...")
    all_oi = []
    current_since = since_ts
    limit = 200
    now_ts = int(time.time() * 1000)

    while current_since < now_ts:
        retries = 0
        success = False
        batch = []

        while retries < max_retries and not success:
            try:
                batch = exchange.fetch_open_interest_history(symbol, timeframe=timeframe, since=current_since, limit=limit)
                success = True
            except Exception as e:
                retries += 1
                time.sleep(2 ** retries)

        if not success or not batch:
            current_since += 30 * 86400 * 1000
            if current_since >= now_ts:
                break
            continue

        all_oi.extend(batch)
        last_ts = batch[-1]['timestamp']

        if len(batch) < 2 or last_ts <= current_since:
            current_since += 86400 * 1000
            continue

        current_since = last_ts + 1000
        time.sleep(0.04)

    if not all_oi:
        logger.warning(f"No Open Interest data returned for {symbol}.")
        return pd.DataFrame()

    records = []
    for item in all_oi:
        oi_val = item.get('openInterestAmount')
        if oi_val is None and 'info' in item:
            oi_val = item['info'].get('openInterest')
        records.append({
            'timestamp': item['timestamp'],
            'datetime': pd.to_datetime(item['timestamp'], unit='ms', utc=True),
            'open_interest': float(oi_val) if oi_val is not None else 0.0
        })

    df = pd.DataFrame(records).drop_duplicates('timestamp').sort_values('timestamp').reset_index(drop=True)
    logger.info(f"Finished {symbol} Open Interest: {len(df)} records from {df['datetime'].iloc[0]} to {df['datetime'].iloc[-1]}")
    return df

def download_long_short_ratio(
    exchange: ccxt.bybit,
    symbol: str,
    timeframe: str = '1d'
) -> pd.DataFrame:
    """
    Downloads available Long/Short account ratio from Bybit (note: Bybit limits public history to rolling 30 days).
    """
    logger.info(f"Downloading {timeframe} Long/Short ratio for {symbol} (Bybit 30-day limit applies)...")
    try:
        batch = exchange.fetch_long_short_ratio_history(symbol, timeframe=timeframe, limit=500)
    except Exception as e:
        logger.warning(f"Could not fetch Long/Short ratio for {symbol}: {e}")
        return pd.DataFrame()

    if not batch:
        return pd.DataFrame()

    records = []
    for item in batch:
        info = item.get('info', {})
        records.append({
            'timestamp': item['timestamp'],
            'datetime': pd.to_datetime(item['timestamp'], unit='ms', utc=True),
            'long_ratio': float(info.get('buyRatio', 0.0)),
            'short_ratio': float(info.get('sellRatio', 0.0))
        })

    df = pd.DataFrame(records).drop_duplicates('timestamp').sort_values('timestamp').reset_index(drop=True)
    logger.info(f"Finished {symbol} Long/Short Ratio: {len(df)} records from {df['datetime'].iloc[0]} to {df['datetime'].iloc[-1]}")
    return df

def audit_inactive_delisted_pairs(exchange: ccxt.bybit) -> List[str]:
    """Checks for delisted or inactive markets to quantify survivorship bias."""
    try:
        mkts = exchange.load_markets()
        inactive = [m for m, v in mkts.items() if not v.get('active', True) and v.get('linear')]
        logger.info(f"Bybit inactive linear markets detected: {len(inactive)} ({inactive})")
        return inactive
    except Exception as e:
        logger.warning(f"Could not inspect inactive markets: {e}")
        return []

def main():
    parser = argparse.ArgumentParser(description="Download Bybit historical multi-timeframe OHLCV, funding, OI, and L/S data")
    parser.add_argument("--years", type=float, default=4.5, help="Years of history to pull (default: 4.5 years)")
    parser.add_argument("--timeframes", nargs='+', default=["1d", "4h"], help="Timeframes to download (e.g. 1d 4h)")
    parser.add_argument("--symbols", nargs='+', default=None, help="Symbols to download")
    parser.add_argument("--out-dir", type=str, default="research/data", help="Output directory for parquet files")
    args = parser.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    exchange = create_exchange("bytick.com")

    # Handle comma or space separation
    symbols = []
    if args.symbols:
        for s in args.symbols:
            symbols.extend(s.split(','))
    else:
        symbols = DEFAULT_PAIRS

    timeframes = []
    for tf in args.timeframes:
        timeframes.extend(tf.split(','))
    start_ts = int((time.time() - args.years * 365.25 * 86400) * 1000)

    logger.info(f"Starting comprehensive data download for {len(symbols)} pairs across {timeframes}...")
    logger.info(f"Target history start: {datetime.fromtimestamp(start_ts/1000, timezone.utc).isoformat()}")

    # Check inactive/delisted markets
    inactive_pairs = audit_inactive_delisted_pairs(exchange)

    summary = []

    for sym in symbols:
        slug = get_symbol_slug(sym)

        # 1. Download Multi-Timeframe OHLCV
        for tf in timeframes:
            ohlcv_path = os.path.join(args.out_dir, f"{slug}_{tf}.parquet")
            df_ohlcv = download_ohlcv_symbol(exchange, sym, timeframe=tf, since_ts=start_ts)
            if not df_ohlcv.empty:
                df_ohlcv.to_parquet(ohlcv_path, index=False, engine='pyarrow')
                logger.info(f"Saved: {ohlcv_path} ({len(df_ohlcv)} bars)")

        # 2. Download Extended Funding Rates
        funding_path = os.path.join(args.out_dir, f"{slug}_funding.parquet")
        df_funding = download_funding_rates(exchange, sym, since_ts=start_ts)
        if not df_funding.empty:
            df_funding.to_parquet(funding_path, index=False, engine='pyarrow')
            logger.info(f"Saved: {funding_path} ({len(df_funding)} records)")

        # 3. Download Open Interest History (Daily)
        oi_path = os.path.join(args.out_dir, f"{slug}_oi.parquet")
        df_oi = download_open_interest(exchange, sym, timeframe='1d', since_ts=start_ts)
        if not df_oi.empty:
            df_oi.to_parquet(oi_path, index=False, engine='pyarrow')
            logger.info(f"Saved: {oi_path} ({len(df_oi)} records)")

        # 4. Download Long/Short Ratio (Daily, rolling 30-day window)
        ls_path = os.path.join(args.out_dir, f"{slug}_ls.parquet")
        df_ls = download_long_short_ratio(exchange, sym, timeframe='1d')
        if not df_ls.empty:
            df_ls.to_parquet(ls_path, index=False, engine='pyarrow')
            logger.info(f"Saved: {ls_path} ({len(df_ls)} records)")

        summary.append({
            'symbol': sym,
            'slug': slug,
            'funding_records': len(df_funding),
            'oi_records': len(df_oi),
            'ls_records': len(df_ls)
        })

    logger.info("=" * 60)
    logger.info("PHASE 2 DATA COLLECTION COMPLETED!")
    logger.info("=" * 60)

if __name__ == "__main__":
    main()
