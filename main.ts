// Breakout + dip bot for the cbBTC 1-minute bars replay.
//
// Protocol notes, in plain words: the harness sends one hello, then
// one batch per bar, and the bot answers every batch with its orders.
// Each bar carries the close the bot may trade on; an order decided
// on one bar fills at the next bar's open, after fees, slippage and
// price impact.
//
// Strategy (written for this competition, long only, one position):
//   * Breakout entry: the close breaks above the highest close of the
//     previous 60 bars, the fast EMA is above the slow EMA, and the
//     60-bar momentum is at least +30 bps. This waits for a real move
//     instead of chasing every 1-minute wiggle, because a full round
//     trip costs roughly 26 bps and most 1-minute moves are smaller.
//   * Dip entry: the close sits at least 60 bps under the slow EMA,
//     RSI(14) is 32 or lower, and the current bar closed up. This buys
//     an oversold bounce only once buyers step back in.
//   * Exits: a stop 120 bps under the entry cost, a trailing stop
//     70 bps under the highest close since entry (armed only while in
//     profit), and a 300-bar maximum hold. After any exit the bot rests
//     30 bars before looking for a new entry, so one whipsaw cannot
//     chain into many losing trades.
//   * Size: 90% of cash per entry. The pool is deep enough that this
//     keeps price impact modest while still making a caught move pay.
//
// Determinism: no clock, no network, no environment reads, no random
// numbers. Every decision comes only from the closes seen so far and
// the account the harness reports, so two runs on the same data send
// identical orders.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

const FAST_EMA = 12;
const SLOW_EMA = 45;
const LOOKBACK = 60; // bars for the breakout high and the momentum window
const MOMENTUM_MIN_BPS = 30; // 60-bar rise needed for a breakout entry
const DIP_MIN_BPS = 60; // how far under the slow EMA a dip entry needs
const RSI_PERIOD = 14;
const RSI_MAX_DIP = 32;
const STOP_BPS = 120; // stop under entry cost
const TRAIL_BPS = 70; // trailing stop under the peak close since entry
const MAX_HOLD_BARS = 300;
const COOLDOWN_BARS = 30;
const SIZE_NUM = 9n; // 90% of cash
const SIZE_DEN = 10n;
const MAX_SLIPPAGE_BPS = 100;
const MIN_HISTORY = 90; // bars of closes before any entry: the slow EMA
// and RSI need time to settle, or an early dip signal fires while the
// averages still describe prices from before a plunge.
const LATEST_ENTRY_BAR = 1380; // no new entries in the final hour: a
// position opened there cannot run its course before the window ends
// and would be flattened at whatever price the last close holds.

class Bot {
  closes: number[] = [];
  emaFast: number | null = null;
  emaSlow: number | null = null;
  gains: number[] = [];
  losses: number[] = [];
  avgGain: number | null = null;
  avgLoss: number | null = null;
  rsi = 50;
  entryPrice: number | null = null;
  peakClose: number | null = null;
  holdBars = 0;
  cooldownUntilSeq = -1;
  wasHolding = false;

  noteClose(close: number): void {
    if (this.closes.length > 0) {
      const change = close - this.closes[this.closes.length - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      if (this.avgGain === null || this.avgLoss === null) {
        this.gains.push(gain);
        this.losses.push(loss);
        if (this.gains.length >= RSI_PERIOD) {
          this.avgGain = this.gains.reduce((a, x) => a + x, 0) / RSI_PERIOD;
          this.avgLoss = this.losses.reduce((a, x) => a + x, 0) / RSI_PERIOD;
          this.updateRsi();
        }
      } else {
        const n = RSI_PERIOD;
        this.avgGain = (this.avgGain * (n - 1) + gain) / n;
        this.avgLoss = (this.avgLoss * (n - 1) + loss) / n;
        this.updateRsi();
      }
    }
    const kFast = 2 / (FAST_EMA + 1);
    const kSlow = 2 / (SLOW_EMA + 1);
    if (this.emaFast === null || this.emaSlow === null) {
      this.emaFast = close;
      this.emaSlow = close;
    } else {
      this.emaFast += kFast * (close - this.emaFast);
      this.emaSlow += kSlow * (close - this.emaSlow);
    }
    this.closes.push(close);
  }

  updateRsi(): void {
    if (this.avgLoss === 0) {
      this.rsi = 100;
    } else {
      this.rsi = 100 - 100 / (1 + this.avgGain! / this.avgLoss!);
    }
  }

  entrySignals(): boolean {
    const closes = this.closes;
    const close = closes[closes.length - 1];
    const prior = closes.slice(closes.length - LOOKBACK - 1, closes.length - 1);
    let priorHigh = -Infinity;
    for (const c of prior) if (c > priorHigh) priorHigh = c;
    const base = closes[closes.length - LOOKBACK - 1];
    const momentumBps = ((close - base) * 10000) / base;
    if (close > priorHigh && this.emaFast! > this.emaSlow! && momentumBps >= MOMENTUM_MIN_BPS) {
      return true;
    }
    const dipBps = ((close - this.emaSlow!) * 10000) / this.emaSlow!;
    if (dipBps <= -DIP_MIN_BPS && this.rsi <= RSI_MAX_DIP && close > closes[closes.length - 2]) {
      return true;
    }
    return false;
  }

  onBatch(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
    // Find this batch's bar for our symbol; a missing bar means no new
    // price, so hold still and answer with no orders.
    let bar = null;
    for (const candidate of batch.bars) {
      if (candidate.symbol === SYMBOL) {
        bar = candidate;
        break;
      }
    }
    if (bar === null || state.warmingUp) return [];
    const close = Number(bar.c);
    this.noteClose(close);

    const holding = state.positions.get(SYMBOL);
    if (holding !== undefined && holding.qty > 0n) {
      if (!this.wasHolding) {
        // Position just appeared: anchor exits to its cost basis.
        const sym = state.symbols.get(SYMBOL)!;
        const quoteScale = state.hello.capital.quote_scale;
        this.entryPrice =
          (Number(holding.cost) * 10 ** (sym.qty_scale + sym.price_scale)) /
          (Number(holding.qty) * 10 ** quoteScale);
        this.peakClose = close;
        this.holdBars = 0;
      }
      this.wasHolding = true;
      if (close > this.peakClose!) this.peakClose = close;
      this.holdBars += 1;
      const pnlBps = ((close - this.entryPrice!) * 10000) / this.entryPrice!;
      const trailBps = ((close - this.peakClose!) * 10000) / this.peakClose!;
      const shouldSell =
        pnlBps <= -STOP_BPS ||
        (pnlBps > 0 && trailBps <= -TRAIL_BPS) ||
        this.holdBars >= MAX_HOLD_BARS;
      if (shouldSell) {
        this.cooldownUntilSeq = state.seq + COOLDOWN_BARS;
        return [{ side: 'sell', symbol: SYMBOL, qty: holding.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: if we were holding, the position just closed; the cooldown
    // set at the exit decision still applies.
    this.wasHolding = false;
    this.entryPrice = null;
    this.peakClose = null;
    this.holdBars = 0;
    if (this.closes.length < MIN_HISTORY) return [];
    if (state.seq < this.cooldownUntilSeq) return [];
    // Bar time, not the wall clock: how many bars of the window have
    // closed, counted from the hello's first close.
    const barsElapsed = Math.floor((batch.t - state.hello.first_close_ms) / 60000) + 1;
    if (barsElapsed >= LATEST_ENTRY_BAR) return [];
    if (!this.entrySignals()) return [];
    const notional = (state.cash * SIZE_NUM) / SIZE_DEN;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
}

const bot = new Bot();

await runBars({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
