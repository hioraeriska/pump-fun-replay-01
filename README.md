# Pump.fun Replay Sprint — Paper Bot

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hioraeriska/pump-fun-replay-01/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/hioraeriska/pump-fun-replay-01/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money on a replay of recorded Solana pump.fun bonding-curve activity. Nothing is traded for real.

## Strategy

Early-momentum buyer with strict exits, written as a single deterministic `main.ts`
implementing the `agent-fun/replay/v2` protocol directly (newline-delimited JSON on
stdin/stdout, no dependencies):

- **Entry:** coins 2–20 minutes old showing price ≥ 1.20× their creation price,
  ≥ 1.10× their price five minutes ago, buy volume dominating sell volume, at least
  8 trades from at least 5 distinct buyers, and a market cap under 100 SOL.
- **Sizing:** up to 1.2 SOL per coin, laddered in under the 1%-of-real-reserves
  per-order cap, at most 5 open positions.
- **Exits:** take half at +60%, the rest at +120% or on a 25% trailing drop from the
  peak, stop-loss at −25% from average entry, and a time exit after 90 minutes below
  +15%.
- **Determinism:** every decision is a pure function of the replayed events — no
  clock, no randomness — so two runs produce byte-identical action logs.

## Run

```sh
node main.ts
```

The harness drives it over stdin/stdout; see the competition kit for
`grade-local`.
