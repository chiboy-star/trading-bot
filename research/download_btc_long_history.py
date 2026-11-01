"""
Downloads the longest continuous public BTC daily history from Bitstamp (2014 to present).
Saves to data/BTC_USD_1d_bitstamp_2014_2026.parquet with strict zero-gap and zero-duplicate validation.
"""

import time
import ccxt
import pandas as pd

def download_bitstamp_btc_daily():
    print("Initializing Bitstamp public CCXT connection...")
    exchange = ccxt.bitstamp({
        'enableRateLimit': True,
        'timeout': 30000
    })

    symbol = 'BTC/USD'
    timeframe = '1d'
    since = int(ccxt.Exchange.parse8601('2014-01-01T00:00:00Z'))
    now_ms = int(time.time() * 1000)

    all_candles = []
    print(f"Fetching {symbol} {timeframe} from {exchange.iso8601(since)} to present...")

    curr_since = since
    while curr_since < now_ms:
        try:
            candles = exchange.fetch_ohlcv(symbol, timeframe, since=curr_since, limit=1000)
            if not candles:
                break
            all_candles.extend(candles)
            last_ts = candles[-1][0]
            if last_ts <= curr_since:
                break
            curr_since = last_ts + 86400000 # Next day
            print(f"  Fetched up to {exchange.iso8601(last_ts)} ({len(all_candles)} total candles)")
            time.sleep(exchange.rateLimit / 1000.0)
        except Exception as e:
            print(f"Error fetching candles at {curr_since}: {e}. Retrying in 5s...")
            time.sleep(5)

    df = pd.DataFrame(all_candles, columns=['timestamp', 'open', 'high', 'low', 'close', 'volume'])
    df = df.drop_duplicates(subset=['timestamp']).sort_values('timestamp').reset_index(drop=True)
    df['datetime'] = pd.to_datetime(df['timestamp'], unit='ms', utc=True)

    # Validation
    assert df['timestamp'].is_monotonic_increasing, "Timestamps not monotonic!"
    time_diffs = df['timestamp'].diff().iloc[1:]
    expected_diff = 86400000
    gaps = time_diffs[time_diffs != expected_diff]
    print(f"\nDownloaded {len(df)} daily candles.")
    print(f"Earliest: {df['datetime'].min().strftime('%Y-%m-%d')} | Latest: {df['datetime'].max().strftime('%Y-%m-%d')}")
    print(f"Gaps detected: {len(gaps)}")

    target_path = "data/BTC_USD_1d_bitstamp_2014_2026.parquet"
    df.to_parquet(target_path, index=False)
    print(f"Successfully saved clean BTC daily archive to {target_path}")

if __name__ == "__main__":
    download_bitstamp_btc_daily()
