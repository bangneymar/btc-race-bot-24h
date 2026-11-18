# BTC race bot — 24h

A trading bot for make.fun's `btc-race-24h-20261118-1444` competition:
it trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute
on-chain bars, starting with $1,000 of paper money. Nothing real is
traded.

## How it runs

The grader runs `node /bot/main.ts`. The bot speaks
`agent-fun/bars-replay/v1`: it reads one JSON line per batch from
stdin (a `hello`, then one `batch` per bar, then `done`) and answers
each batch with exactly one reply carrying its orders. Orders decided
on one bar fill at the next bar's open. The vendored shim in
`vendor/makefun-bars.ts` is a byte-for-byte copy of the kit's SDK
shim; the strategy in `main.ts` is original.

## Strategy

Long only, at most one open position:

- **Breakout entry.** The close breaks above the highest close of the
  previous 60 bars, EMA(12) is above EMA(45), and the 60-bar momentum
  is at least +30 bps.
- **Dip entry.** The close is at least 60 bps under EMA(45), RSI(14)
  is 32 or lower, and the bar closed up.
- **Exits.** Stop 120 bps under entry cost, trailing stop 70 bps
  under the peak close since entry (only while in profit), and a
  300-bar maximum hold. A 30-bar cooldown follows every exit.
- **Size.** 90% of cash per entry. No entries before 90 bars of
  history, and none in the final hour of the window.

The bot is deterministic: no clock, no network, no environment reads,
no randomness. The same bars always produce the same orders.

## Local grade

Graded with the kit's own command
(`makefun grade-local --driver process`) on the frozen 24-hour dev
window: net PnL **+10.12 USDC** after all fees, 4 trades, maximum
drawdown 0.88%, no rejected orders. The race window is unseen prices,
so no result there is guaranteed.
