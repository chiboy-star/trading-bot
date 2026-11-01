"""
Technical indicators calculation matching technicalindicators (npm) exactly:
- EMA(period): Wilder/Standard EMA with initial SMA
- RSI(period): Wilder's smoothed RSI (period 14)
- ATR(period): Wilder's smoothed ATR (period 14)
- ADX(period): Wilder's smoothed ADX, +DI, -DI (period 14)
"""

import numpy as np
import pandas as pd
from typing import Tuple, Dict

def calculate_ema(values: np.ndarray, period: int) -> np.ndarray:
    """Calculates EMA with initial SMA seed matching technicalindicators."""
    n = len(values)
    ema = np.full(n, np.nan)
    if n < period:
        return ema
    
    # Initial seed is simple moving average
    ema[period - 1] = np.mean(values[:period])
    multiplier = 2.0 / (period + 1.0)
    
    for i in range(period, n):
        ema[i] = (values[i] - ema[i - 1]) * multiplier + ema[i - 1]
        
    return ema

def calculate_rsi(closes: np.ndarray, period: int = 14) -> np.ndarray:
    """Calculates Wilder's smoothed RSI matching technicalindicators."""
    n = len(closes)
    rsi = np.full(n, np.nan)
    if n <= period:
        return rsi
        
    diff = np.diff(closes)
    gains = np.maximum(diff, 0.0)
    losses = np.maximum(-diff, 0.0)
    
    # First average gain/loss
    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])
    
    if avg_loss == 0.0:
        rsi[period] = 100.0
    else:
        rs = avg_gain / avg_loss
        rsi[period] = 100.0 - (100.0 / (1.0 + rs))
        
    for i in range(period, len(diff)):
        current_idx = i + 1
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        
        if avg_loss == 0.0:
            rsi[current_idx] = 100.0
        else:
            rs = avg_gain / avg_loss
            rsi[current_idx] = 100.0 - (100.0 / (1.0 + rs))
            
    return rsi

def calculate_atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> np.ndarray:
    """Calculates Wilder's smoothed ATR matching technicalindicators (starts at index period)."""
    n = len(closes)
    atr = np.full(n, np.nan)
    if n <= period:
        return atr
        
    tr = np.zeros(n)
    # technicalindicators calculates TR starting from candle 1 using candle 0 close
    for i in range(1, n):
        hl = highs[i] - lows[i]
        hc = abs(highs[i] - closes[i - 1])
        lc = abs(lows[i] - closes[i - 1])
        tr[i] = max(hl, hc, lc)
        
    # Initial ATR is SMA of TR from index 1 to period
    atr[period] = np.mean(tr[1:period + 1])
    
    for i in range(period + 1, n):
        atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period
        
    return atr

def calculate_adx(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> np.ndarray:
    """Calculates Wilder's smoothed ADX, +DI, -DI matching technicalindicators."""
    n = len(closes)
    adx = np.full(n, np.nan)
    if n < period * 2:
        return adx
        
    tr = np.zeros(n)
    plus_dm = np.zeros(n)
    minus_dm = np.zeros(n)
    
    for i in range(1, n):
        hl = highs[i] - lows[i]
        hc = abs(highs[i] - closes[i - 1])
        lc = abs(lows[i] - closes[i - 1])
        tr[i] = max(hl, hc, lc)
        
        up_move = highs[i] - highs[i - 1]
        down_move = lows[i - 1] - lows[i]
        
        if up_move > down_move and up_move > 0:
            plus_dm[i] = up_move
        else:
            plus_dm[i] = 0.0
            
        if down_move > up_move and down_move > 0:
            minus_dm[i] = down_move
        else:
            minus_dm[i] = 0.0
            
    # Initial Wilder smoothing for TR, +DM, -DM across 1..period
    smooth_tr = np.sum(tr[1:period + 1])
    smooth_plus_dm = np.sum(plus_dm[1:period + 1])
    smooth_minus_dm = np.sum(minus_dm[1:period + 1])
    
    dx_values = []
    dx_indices = []
    
    plus_di = 100.0 * (smooth_plus_dm / smooth_tr) if smooth_tr > 0 else 0.0
    minus_di = 100.0 * (smooth_minus_dm / smooth_tr) if smooth_tr > 0 else 0.0
    di_sum = plus_di + minus_di
    dx = 100.0 * abs(plus_di - minus_di) / di_sum if di_sum > 0 else 0.0
    dx_values.append(dx)
    dx_indices.append(period)
    
    for i in range(period + 1, n):
        smooth_tr = smooth_tr - (smooth_tr / period) + tr[i]
        smooth_plus_dm = smooth_plus_dm - (smooth_plus_dm / period) + plus_dm[i]
        smooth_minus_dm = smooth_minus_dm - (smooth_minus_dm / period) + minus_dm[i]
        
        plus_di = 100.0 * (smooth_plus_dm / smooth_tr) if smooth_tr > 0 else 0.0
        minus_di = 100.0 * (smooth_minus_dm / smooth_tr) if smooth_tr > 0 else 0.0
        di_sum = plus_di + minus_di
        dx = 100.0 * abs(plus_di - minus_di) / di_sum if di_sum > 0 else 0.0
        
        dx_values.append(dx)
        dx_indices.append(i)
        
    if len(dx_values) >= period:
        # Initial ADX is SMA of first `period` DX values at index 2*period - 1
        current_adx = np.mean(dx_values[:period])
        first_adx_idx = dx_indices[period - 1]
        adx[first_adx_idx] = current_adx
        
        for k in range(period, len(dx_values)):
            current_adx = (current_adx * (period - 1) + dx_values[k]) / period
            target_idx = dx_indices[k]
            adx[target_idx] = current_adx
            
    return adx

def compute_all_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Enriches OHLCV dataframe with fast EMA(20), slow EMA(50), RSI(14), ATR(14), and ADX(14)."""
    closes = df['close'].to_numpy(dtype=float)
    highs = df['high'].to_numpy(dtype=float)
    lows = df['low'].to_numpy(dtype=float)
    
    df['ema_fast'] = calculate_ema(closes, 20)
    df['ema_slow'] = calculate_ema(closes, 50)
    df['rsi'] = calculate_rsi(closes, 14)
    df['atr'] = calculate_atr(highs, lows, closes, 14)
    df['adx'] = calculate_adx(highs, lows, closes, 14)
    
    return df
