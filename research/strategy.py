"""
Quantitative Trading Strategy Logic in Python
Faithful 1:1 reproduction of src/strategy/core.ts:
- Playbook A: TREND_PULLBACK (Strict RSI bounce/pullback enforcement)
- Playbook B: EMA_CROSSOVER (2-candle crossover window)
- Playbook C: EXTREME_RSI_REVERSAL (Mean-reversion scalp with 1.2x ATR stop & 2.0x ATR TP)
- Fallback:   VOLATILITY_BREAKOUT (10-candle range breakout with rising ADX)
- Trailing Stop: 2.8x ATR (only ratchets, never loosens)
"""

from dataclasses import dataclass
from typing import Optional, Tuple, Dict, Any
import numpy as np

@dataclass
class SignalResult:
    signal: str                # 'BUY', 'SELL', 'HOLD'
    direction: Optional[str]   # 'LONG', 'SHORT', None
    setup_type: Optional[str]  # 'TREND_PULLBACK', 'EMA_CROSSOVER', 'EXTREME_RSI_REVERSAL', 'VOLATILITY_BREAKOUT', None
    reason: str
    recommended_risk_pct: float = 0.02
    recommended_atr_mult: float = 2.8
    take_profit_price: Optional[float] = None

@dataclass
class ExitResult:
    should_exit: bool
    reason: Optional[str]      # 'TRAILING_STOP', 'TAKE_PROFIT', 'EMA_CROSS', None
    execution_price: float
    new_trailing_stop: float
    new_highest: float
    new_lowest: float

class StrategyLogic:
    def __init__(
        self,
        atr_multiplier: float = 2.8,
        adx_threshold: float = 20.0,
        fast_ema_period: int = 20,
        slow_ema_period: int = 50,
        rsi_period: int = 14,
        allow_shorts: bool = True
    ):
        self.atr_multiplier = atr_multiplier
        self.adx_threshold = adx_threshold
        self.fast_ema_period = fast_ema_period
        self.slow_ema_period = slow_ema_period
        self.rsi_period = rsi_period
        self.allow_shorts = allow_shorts

    def evaluate_entry(
        self,
        candle_idx: int,
        opens: np.ndarray,
        highs: np.ndarray,
        lows: np.ndarray,
        closes: np.ndarray,
        ema_fast: np.ndarray,
        ema_slow: np.ndarray,
        rsi: np.ndarray,
        atr: np.ndarray,
        adx: np.ndarray,
    ) -> SignalResult:
        """
        Evaluates entry setups on a CLOSED bar at `candle_idx`.
        """
        if candle_idx < 15 or np.isnan(ema_slow[candle_idx]) or np.isnan(adx[candle_idx]):
            return SignalResult('HOLD', None, None, 'Warming up indicators')

        curr_close = closes[candle_idx]
        curr_open = opens[candle_idx]
        curr_high = highs[candle_idx]
        curr_low = lows[candle_idx]

        prev_close = closes[candle_idx - 1]
        prev_open = opens[candle_idx - 1]
        prev_high = highs[candle_idx - 1]
        prev_low = lows[candle_idx - 1]

        curr_ema_fast = ema_fast[candle_idx]
        prev_ema_fast = ema_fast[candle_idx - 1]
        curr_ema_slow = ema_slow[candle_idx]
        prev_ema_slow = ema_slow[candle_idx - 1]

        curr_rsi = rsi[candle_idx]
        prev_rsi = rsi[candle_idx - 1]
        curr_atr = atr[candle_idx]
        curr_adx = adx[candle_idx]
        prev_adx = adx[candle_idx - 1]

        # 2-candle EMA crossover detection for Playbook B
        two_bars_ago_fast = ema_fast[candle_idx - 2] if candle_idx >= 2 else prev_ema_fast
        two_bars_ago_slow = ema_slow[candle_idx - 2] if candle_idx >= 2 else prev_ema_slow

        long_cross_curr = (prev_ema_fast <= prev_ema_slow) and (curr_ema_fast > curr_ema_slow)
        long_cross_prev = (two_bars_ago_fast <= two_bars_ago_slow) and (prev_ema_fast > prev_ema_slow) and (curr_ema_fast >= curr_ema_slow)
        long_ema_cross2 = long_cross_curr or long_cross_prev

        short_cross_curr = (prev_ema_fast >= prev_ema_slow) and (curr_ema_fast < curr_ema_slow)
        short_cross_prev = (two_bars_ago_fast >= two_bars_ago_slow) and (prev_ema_fast < prev_ema_slow) and (curr_ema_fast <= curr_ema_slow)
        short_ema_cross2 = short_cross_curr or short_cross_prev

        # Lookback RSI across last 4 candles
        start_rsi_idx = max(0, candle_idx - 3)
        recent_rsis = rsi[start_rsi_idx:candle_idx + 1]
        had_rsi_below_35 = np.any(recent_rsis < 35.0)
        had_rsi_above_65 = np.any(recent_rsis > 65.0)

        # -------------------------------------------------------------
        # PLAYBOOK B — EMA_CROSSOVER (Classic Momentum, 2-candle window)
        # -------------------------------------------------------------
        crossover_adx_threshold = 18.0
        crossover_adx_passed = curr_adx >= crossover_adx_threshold
        rsi_cross_passed = (curr_rsi >= 35.0) and (curr_rsi <= 68.0)

        if long_ema_cross2 and crossover_adx_passed and rsi_cross_passed:
            return SignalResult(
                signal='BUY',
                direction='LONG',
                setup_type='EMA_CROSSOVER',
                reason=f"Bullish EMA crossover within last 2 bars, ADX {curr_adx:.1f} >= 18, RSI {curr_rsi:.1f}",
                recommended_risk_pct=0.02,
                recommended_atr_mult=self.atr_multiplier
            )

        if self.allow_shorts and short_ema_cross2 and crossover_adx_passed and rsi_cross_passed:
            return SignalResult(
                signal='SELL',
                direction='SHORT',
                setup_type='EMA_CROSSOVER',
                reason=f"Bearish EMA crossover within last 2 bars, ADX {curr_adx:.1f} >= 18, RSI {curr_rsi:.1f}",
                recommended_risk_pct=0.02,
                recommended_atr_mult=self.atr_multiplier
            )

        # -------------------------------------------------------------
        # PLAYBOOK A — TREND_PULLBACK (Strict RSI pullback enforcement)
        # -------------------------------------------------------------
        pullback_tolerance = 0.4 * max(0.000001, curr_atr)
        adx_passed = curr_adx >= self.adx_threshold

        # Long Trend Pullback: EMA20 > EMA50, ADX >= 20, strictly requiring RSI in [35, 55]
        if curr_ema_fast > curr_ema_slow and adx_passed:
            rsi_in_long_zone = (curr_rsi >= 35.0) and (curr_rsi <= 55.0)
            rsi_recovered_long = had_rsi_above_65 and rsi_in_long_zone
            ema_touched_long = (abs(curr_close - curr_ema_fast) <= pullback_tolerance) or \
                (curr_low <= curr_ema_fast + pullback_tolerance and curr_close >= curr_ema_fast - pullback_tolerance)
            bounced_long = curr_close > curr_open
            price_bounce_long = ema_touched_long and bounced_long

            if rsi_in_long_zone and (rsi_recovered_long or price_bounce_long):
                return SignalResult(
                    signal='BUY',
                    direction='LONG',
                    setup_type='TREND_PULLBACK',
                    reason=f"Trend Pullback [LONG]: EMA20 > EMA50, ADX {curr_adx:.1f}, RSI {curr_rsi:.1f} in [35, 55]",
                    recommended_risk_pct=0.02,
                    recommended_atr_mult=self.atr_multiplier
                )

        # Short Trend Pullback: EMA20 < EMA50, ADX >= 20, strictly requiring RSI in [45, 65]
        if self.allow_shorts and curr_ema_fast < curr_ema_slow and adx_passed:
            rsi_in_short_zone = (curr_rsi >= 45.0) and (curr_rsi <= 65.0)
            rsi_recovered_short = had_rsi_below_35 and rsi_in_short_zone
            ema_touched_short = (abs(curr_close - curr_ema_fast) <= pullback_tolerance) or \
                (curr_high >= curr_ema_fast - pullback_tolerance and curr_close <= curr_ema_fast + pullback_tolerance)
            rejecting_short = curr_close < curr_open
            price_reject_short = ema_touched_short and rejecting_short

            if rsi_in_short_zone and (rsi_recovered_short or price_reject_short):
                return SignalResult(
                    signal='SELL',
                    direction='SHORT',
                    setup_type='TREND_PULLBACK',
                    reason=f"Trend Pullback [SHORT]: EMA20 < EMA50, ADX {curr_adx:.1f}, RSI {curr_rsi:.1f} in [45, 65]",
                    recommended_risk_pct=0.02,
                    recommended_atr_mult=self.atr_multiplier
                )

        # -------------------------------------------------------------
        # PLAYBOOK C — EXTREME_RSI_REVERSAL (Mean-Reversion Scalp)
        # -------------------------------------------------------------
        # Long bounce: Extreme exhaustion (RSI < 22) + reversal candle body
        is_oversold_exhaustion = (curr_rsi < 22.0) or (prev_rsi < 22.0)
        is_reversal_long = (
            curr_close > prev_high or
            (curr_close > curr_open and curr_open <= prev_low and curr_close >= prev_close) or
            (curr_close > curr_open and (curr_close - curr_open) >= 0.35 * curr_atr)
        )

        if is_oversold_exhaustion and is_reversal_long and curr_rsi <= 35.0:
            return SignalResult(
                signal='BUY',
                direction='LONG',
                setup_type='EXTREME_RSI_REVERSAL',
                reason=f"Extreme oversold exhaustion bounce (RSI {curr_rsi:.1f} < 22)",
                recommended_risk_pct=0.01,
                recommended_atr_mult=1.2,
                take_profit_price=curr_close + (2.0 * curr_atr)
            )

        # Short fade: Extreme exhaustion (RSI > 78) + reversal candle body
        is_overbought_exhaustion = (curr_rsi > 78.0) or (prev_rsi > 78.0)
        is_reversal_short = (
            curr_close < prev_low or
            (curr_close < curr_open and curr_open >= prev_high and curr_close <= prev_close) or
            (curr_close < curr_open and (curr_open - curr_close) >= 0.35 * curr_atr)
        )

        if self.allow_shorts and is_overbought_exhaustion and is_reversal_short and curr_rsi >= 65.0:
            return SignalResult(
                signal='SELL',
                direction='SHORT',
                setup_type='EXTREME_RSI_REVERSAL',
                reason=f"Extreme overbought exhaustion fade (RSI {curr_rsi:.1f} > 78)",
                recommended_risk_pct=0.01,
                recommended_atr_mult=1.2,
                take_profit_price=curr_close - (2.0 * curr_atr)
            )

        # -------------------------------------------------------------
        # FALLBACK: VOLATILITY BREAKOUT
        # -------------------------------------------------------------
        is_adx_rising = curr_adx > 22.0 and (
            (curr_adx - prev_adx >= 1.5) or (prev_adx > 0 and curr_adx > prev_adx + 1.0)
        )
        if is_adx_rising and candle_idx >= 12:
            # Lookback 10 candles (from candle_idx - 10 to candle_idx - 1)
            lookback_high = np.max(highs[candle_idx - 10:candle_idx])
            lookback_low = np.min(lows[candle_idx - 10:candle_idx])

            if curr_close > lookback_high and curr_rsi >= 50.0 and curr_rsi <= 72.0:
                return SignalResult(
                    signal='BUY',
                    direction='LONG',
                    setup_type='VOLATILITY_BREAKOUT',
                    reason=f"Volatility expansion breakout above 10-candle high, ADX rising to {curr_adx:.1f}, RSI {curr_rsi:.1f}",
                    recommended_risk_pct=0.02,
                    recommended_atr_mult=self.atr_multiplier
                )

            if self.allow_shorts and curr_close < lookback_low and curr_rsi <= 50.0 and curr_rsi >= 28.0:
                return SignalResult(
                    signal='SELL',
                    direction='SHORT',
                    setup_type='VOLATILITY_BREAKOUT',
                    reason=f"Volatility expansion breakdown below 10-candle low, ADX rising to {curr_adx:.1f}, RSI {curr_rsi:.1f}",
                    recommended_risk_pct=0.02,
                    recommended_atr_mult=self.atr_multiplier
                )

        return SignalResult('HOLD', None, None, 'No setup triggered')

    def evaluate_exit(
        self,
        side: str,
        entry_price: float,
        trailing_stop: float,
        highest_price: float,
        lowest_price: float,
        candle_open: float,
        candle_high: float,
        candle_low: float,
        candle_close: float,
        curr_atr: float,
        atr_multiplier: float,
        take_profit_price: Optional[float],
        curr_ema_fast: float,
        prev_ema_fast: float,
        curr_ema_slow: float,
        prev_ema_slow: float,
        slippage: float = 0.0005
    ) -> ExitResult:
        """
        Evaluates dynamic ATR trailing stop, take-profit target, and reverse EMA crossover.
        Order per bar:
        (a) check exits against the stop level carried from the PREVIOUS bar (trailing_stop);
        (b) only then update the trailing stop using current bar's high/low for use from the NEXT bar.
        If both stop and target are touched in one bar, assume the worse outcome (stop),
        applied consistently and symmetrically for longs and shorts.
        """
        new_trailing_stop = trailing_stop
        new_highest = highest_price
        new_lowest = lowest_price

        if side == 'LONG':
            # (a) Check exits against stop level carried from PREVIOUS bar
            # Intrabar ordering: If both stop and target are touched, assume worse outcome (stop)
            if candle_low <= trailing_stop:
                effective_stop_price = min(candle_open, trailing_stop)
                exec_price = effective_stop_price * (1.0 - slippage)
                return ExitResult(True, 'TRAILING_STOP', exec_price, trailing_stop, highest_price, lowest_price)

            # Check Take-Profit Target (Only if stop was not hit)
            if take_profit_price is not None and candle_high >= take_profit_price:
                effective_tp_price = max(candle_open, take_profit_price)
                exec_price = effective_tp_price * (1.0 - slippage)
                return ExitResult(True, 'TAKE_PROFIT', exec_price, trailing_stop, highest_price, lowest_price)

            # Check Reverse EMA Cross on closed candle
            if prev_ema_fast >= prev_ema_slow and curr_ema_fast < curr_ema_slow:
                exec_price = candle_close * (1.0 - slippage)
                return ExitResult(True, 'EMA_CROSS', exec_price, trailing_stop, highest_price, lowest_price)

            # (b) Only if NO exit occurred, update trailing stop using current bar's high/low for use from NEXT bar
            if candle_high > new_highest:
                new_highest = candle_high
                proposed_stop = new_highest - (atr_multiplier * curr_atr)
                if proposed_stop > new_trailing_stop:
                    new_trailing_stop = proposed_stop

        elif side == 'SHORT':
            # (a) Check exits against stop level carried from PREVIOUS bar
            # Intrabar ordering: If both stop and target are touched, assume worse outcome (stop)
            if trailing_stop > 0.0 and candle_high >= trailing_stop:
                effective_stop_price = max(candle_open, trailing_stop)
                exec_price = effective_stop_price * (1.0 + slippage)
                return ExitResult(True, 'TRAILING_STOP', exec_price, trailing_stop, highest_price, lowest_price)

            # Check Take-Profit Target (Only if stop was not hit)
            if take_profit_price is not None and candle_low <= take_profit_price:
                effective_tp_price = min(candle_open, take_profit_price)
                exec_price = effective_tp_price * (1.0 + slippage)
                return ExitResult(True, 'TAKE_PROFIT', exec_price, trailing_stop, highest_price, lowest_price)

            # Check Reverse EMA Cross on closed candle
            if prev_ema_fast <= prev_ema_slow and curr_ema_fast > curr_ema_slow:
                exec_price = candle_close * (1.0 + slippage)
                return ExitResult(True, 'EMA_CROSS', exec_price, trailing_stop, highest_price, lowest_price)

            # (b) Only if NO exit occurred, update trailing stop using current bar's high/low for use from NEXT bar
            if candle_low < new_lowest or new_lowest == 0.0:
                new_lowest = candle_low
                proposed_stop = new_lowest + (atr_multiplier * curr_atr)
                if new_trailing_stop == 0.0 or proposed_stop < new_trailing_stop:
                    new_trailing_stop = proposed_stop

        return ExitResult(False, None, candle_close, new_trailing_stop, new_highest, new_lowest)
