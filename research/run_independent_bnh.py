
import pandas as pd
import numpy as np

# Load raw files directly
df_price = pd.read_parquet('research/data/BTC_USDT_15m.parquet')
df_fund = pd.read_parquet('research/data/BTC_USDT_funding.parquet')

p_start = float(df_price['open'].iloc[0])
p_end = float(df_price['close'].iloc[-1])
price_return = (p_end - p_start) / p_start

initial_capital = 10000.0
amount = initial_capital / p_start

entry_exec = p_start * (1 + 0.0005)
exit_exec = p_end * (1 - 0.0005)
entry_fee = (amount * entry_exec) * 0.0006
exit_fee = (amount * exit_exec) * 0.0006
slippage_entry = amount * p_start * 0.0005
slippage_exit = amount * p_end * 0.0005

fund_map = dict(zip(df_fund['timestamp'].astype(int), df_fund['funding_rate'].astype(float)))
total_funding_paid = 0.0

for idx, row in df_price.iterrows():
    ts = int(row['timestamp'])
    dt = pd.to_datetime(ts, unit='ms', utc=True)
    if dt.minute == 0 and dt.hour in (0, 8, 16):
        rate = fund_map.get(ts, 0.0)
        if rate != 0.0:
            notional = amount * float(row['close'])
            funding_cashflow = -(notional * rate)
            total_funding_paid += funding_cashflow

gross_pnl = amount * (exit_exec - entry_exec)
net_pnl = gross_pnl - entry_fee - exit_fee + total_funding_paid
net_return = (net_pnl / initial_capital) * 100

print(f"Independent Buy & Hold Calculation:")
print(f"Start Price: {p_start:.2f} | End Price: {p_end:.2f} | Raw Gain: {price_return*100:.2f}%")
print(f"Total Entry Fee: {entry_fee:.2f} | Exit Fee: {exit_fee:.2f} | Sum Fees: {entry_fee + exit_fee:.2f}")
print(f"Total Slippage Drag: {slippage_entry + slippage_exit:.2f}")
print(f"Total Funding Paid: {total_funding_paid:.2f}")
print(f"Gross PnL: {gross_pnl:.2f} | Net PnL: {net_pnl:.2f}")
print(f"Expected Net Return: {net_return:.2f}%")
