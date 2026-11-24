// Pump.fun Replay Sprint — early-momentum paper trading bot (v2).
// Protocol: agent-fun/replay/v2, newline-delimited JSON on stdin/stdout.
//   hello -> (no reply); batch {seq, slot, events, marks, fills, account} -> one reply
//   {type:"reply", seq, orders}; done -> exit.
// Strategy (tuned on the dev replay with an offline simulator, then verified
// with the kit's grade-local): buy young coins showing early momentum plus buy
// dominance, ladder up to 1.0 SOL per coin under the 1%-of-real-reserves
// per-order cap, at most 5 open positions, at most 40 coins entered in total.
// Exits: take half at +50%, the rest at +100% or on a 20% trailing drop,
// stop-loss at -11% from average entry, time exit after 90 minutes below +15%.
// A coin is never re-entered after an exit. Sells are emitted in full and the
// engine rejects them for free while the payout exceeds real reserves, so a
// position waits for a clean exit instead of bleeding out in dust sells.
// Total position value is kept under half of a coin's real reserves so an
// exit stays payable. Every decision is a pure function of the replayed
// events: no clock, no randomness, so two runs produce byte-identical logs.

import * as readline from "node:readline";

// ---------------------------------------------------------------- config
const MAX_OPEN_POSITIONS = 5;
const MAX_COINS_ENTERED = 40; // guardrail needs >= 20 round-tripped coins
const TARGET_POSITION = 1_000_000_000n; // 1.0 SOL per coin, in lamports
const MIN_BUY = 20_000_000n; // 0.02 SOL per buy order
const MAX_BUYS_PER_POSITION = 8; // ladder steps per coin
const MIN_ENTRY_AGE_S = 30; // do not chase the first thirty seconds
const MAX_ENTRY_AGE_S = 1200; // stop entering after twenty minutes
const ENTRY_GAIN_NUM = 105; // entry needs price >= 1.05x the creation price
const ENTRY_GAIN_MAX_NUM = 200; // and <= 2.00x (never chase a vertical spike)
const MOMENTUM_NUM = 102; // and >= 1.02x its price five minutes ago
const MOMENTUM_LOOKBACK_S = 300;
const MAX_ENTRY_MCAP_SOL = 100; // skip coins already worth 100 SOL or more
// Price is lamports per base token unit (6 decimals): one billion tokens is
// 1e15 base units, so market cap in SOL is price * 1e15 / 1e9 = price * 1e6.
const MCAP_MULTIPLIER = 1_000_000;
const MIN_TRADES = 4;
const MIN_BUYERS = 3;
const BUY_DOMINANCE_NUM = 6; // buy volume must be >= 1.2x sell volume (6/5)
const BUY_DOMINANCE_DEN = 5;
const TAKE_PROFIT_1_NUM = 150; // +50%: sell half
const TAKE_PROFIT_2_NUM = 200; // +100%: sell the rest
const TRAIL_NUM = 80; // after TP1, exit if price falls to 80% of the peak
const STOP_LOSS_NUM = 89; // -11% from average entry: exit everything
const TIME_EXIT_AGE_S = 5400; // ninety minutes
const TIME_EXIT_GAIN_NUM = 115; // still below +15% by then: exit
const MAX_SLIPPAGE_BPS = 500;
const MAX_ORDERS_PER_BATCH = 16;
const CASH_BUFFER = 1_000_000n; // lamports kept back for transaction fees
const MAX_SAMPLES_PER_MINT = 120;
const MAX_BUYERS_TRACKED = 200;

// ---------------------------------------------------------------- types
type Order =
  | {
      side: "buy";
      client_id: string;
      mint: string;
      quote_lamports: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      mint: string;
      token_amount: string;
      max_slippage_bps: number;
    };

interface MintState {
  mint: string;
  createdTs: number;
  createPrice: number;
  lastPrice: number;
  lastRealSol: bigint;
  lastRealTok: bigint;
  lastTs: number;
  trades: number;
  buys: number;
  sells: number;
  buyVol: bigint;
  sellVol: bigint;
  buyers: Set<string>;
  complete: boolean;
  samples: Array<{ ts: number; price: number }>;
}

interface Position {
  mint: string;
  tokens: bigint;
  quoteIn: bigint;
  tokensBought: bigint;
  peak: number;
  openedTs: number;
  soldHalf: boolean;
  buys: number;
}

// ---------------------------------------------------------------- state
const mints = new Map<string, MintState>();
const positions = new Map<string, Position>();
const pendingBuys = new Map<string, bigint>(); // mint -> lamports committed, not yet filled
const pendingNewMints = new Set<string>(); // mints with a buy in flight, no position yet
const enteredMints = new Set<string>(); // every mint we ever emitted a buy for
const neverReenter = new Set<string>(); // mints whose position closed once
let cashLamports = 0n;
let txFeeLamports = 105_000n; // base 5000 + priority 100000, replaced by hello.fees
let orderCounter = 0;
let helloSeen = false;

const debug = process.env.PUMP_DEBUG === "1";
function log(...args: unknown[]): void {
  if (debug) console.error(...args);
}

// ---------------------------------------------------------------- helpers
function priceOf(vSol: bigint, vTok: bigint): number {
  if (vTok === 0n) return 0;
  return Number(vSol) / Number(vTok);
}

function marketCapSol(price: number): number {
  return price * MCAP_MULTIPLIER;
}

function priceAt(m: MintState, ts: number): number {
  let best = m.createPrice;
  for (const s of m.samples) {
    if (s.ts <= ts) best = s.price;
    else break;
  }
  return best;
}

function recordSample(m: MintState, ts: number, price: number): void {
  const last = m.samples[m.samples.length - 1];
  if (last && ts - last.ts < 30 && Math.abs(price - last.price) / last.price < 0.02) return;
  m.samples.push({ ts, price });
  if (m.samples.length > MAX_SAMPLES_PER_MINT) m.samples.shift();
}

function entryPriceOf(p: Position): number {
  if (p.tokensBought === 0n) return 0;
  return Number(p.quoteIn) / Number(p.tokensBought);
}

function nextClientId(kind: string): string {
  orderCounter += 1;
  return `${kind}-${orderCounter}`;
}

// ---------------------------------------------------------------- event intake
function onCreate(ev: any): void {
  const mint: string = ev.mint;
  if (mints.has(mint)) return;
  const ts = Number(ev.timestamp);
  const price = priceOf(BigInt(ev.virtual_sol_reserves), BigInt(ev.virtual_token_reserves));
  mints.set(mint, {
    mint,
    createdTs: ts,
    createPrice: price,
    lastPrice: price,
    lastRealSol: 0n,
    lastRealTok: BigInt(ev.real_token_reserves),
    lastTs: ts,
    trades: 0,
    buys: 0,
    sells: 0,
    buyVol: 0n,
    sellVol: 0n,
    buyers: new Set<string>(),
    complete: false,
    samples: [{ ts, price }],
  });
}

function onTrade(ev: any): void {
  const mint: string = ev.mint;
  let m = mints.get(mint);
  if (!m) {
    // A trade before any CreateEvent should not be delivered; stay safe anyway.
    const ts = Number(ev.timestamp);
    const price = priceOf(BigInt(ev.virtual_sol_reserves), BigInt(ev.virtual_token_reserves));
    m = {
      mint,
      createdTs: ts,
      createPrice: price,
      lastPrice: price,
      lastRealSol: BigInt(ev.real_sol_reserves),
      lastRealTok: BigInt(ev.real_token_reserves),
      lastTs: ts,
      trades: 0,
      buys: 0,
      sells: 0,
      buyVol: 0n,
      sellVol: 0n,
      buyers: new Set<string>(),
      complete: false,
      samples: [{ ts, price }],
    };
    mints.set(mint, m);
  }
  const ts = Number(ev.timestamp);
  const price = priceOf(BigInt(ev.virtual_sol_reserves), BigInt(ev.virtual_token_reserves));
  m.lastPrice = price;
  m.lastRealSol = BigInt(ev.real_sol_reserves);
  m.lastRealTok = BigInt(ev.real_token_reserves);
  m.lastTs = ts;
  m.trades += 1;
  const sol = BigInt(ev.sol_amount);
  if (ev.is_buy) {
    m.buys += 1;
    m.buyVol += sol;
    if (m.buyers.size < MAX_BUYERS_TRACKED) m.buyers.add(String(ev.user));
  } else {
    m.sells += 1;
    m.sellVol += sol;
  }
  recordSample(m, ts, price);
}

function onComplete(ev: any): void {
  const m = mints.get(String(ev.mint));
  if (m) m.complete = true;
}

// ---------------------------------------------------------------- fill intake
function onFills(fills: any[]): void {
  for (const f of fills) {
    const cid: string = String(f.client_id || "");
    if (!cid.startsWith("b-") && !cid.startsWith("s-")) continue; // harness closes
    if (f.status !== "filled") {
      // A rejected or failed order frees its pending commitment.
      if (cid.startsWith("b-")) {
        const mint: string = f.mint;
        const pend = pendingBuys.get(mint) || 0n;
        if (pend > 0n) {
          // We cannot know which of several pending buys this was; the pending
          // map is only an upper bound, so clear it conservatively when the
          // position plus remaining pendings still cover the target.
          pendingBuys.delete(mint);
          pendingNewMints.delete(mint);
        }
      }
      continue;
    }
    const mint: string = f.mint;
    if (f.side === "buy") {
      const tokens = BigInt(f.token_amount);
      const quote = BigInt(f.quote_lamports);
      let p = positions.get(mint);
      if (!p) {
        const m = mints.get(mint);
        p = {
          mint,
          tokens: 0n,
          quoteIn: 0n,
          tokensBought: 0n,
          peak: m ? m.lastPrice : 0,
          openedTs: m ? m.lastTs : 0,
          soldHalf: false,
          buys: 0,
        };
        positions.set(mint, p);
      }
      p.tokens += tokens;
      p.quoteIn += quote;
      p.tokensBought += tokens;
      p.buys += 1;
      const m = mints.get(mint);
      if (m && m.lastPrice > p.peak) p.peak = m.lastPrice;
      const pend = pendingBuys.get(mint) || 0n;
      if (pend >= quote) pendingBuys.set(mint, pend - quote);
      else pendingBuys.delete(mint);
      if (pend <= quote) pendingNewMints.delete(mint);
    } else {
      // sell
      const tokens = BigInt(f.token_amount);
      const p = positions.get(mint);
      if (p) {
        p.tokens -= tokens;
        if (p.tokens <= 0n) {
          positions.delete(mint);
          neverReenter.add(mint);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- decisions
// All entry filters in one place: age window, trade/buyer counts, gain band,
// market-cap ceiling, buy dominance, and five-minute momentum.
function entryEligible(m: MintState): boolean {
  const age = m.lastTs - m.createdTs;
  if (age < MIN_ENTRY_AGE_S || age > MAX_ENTRY_AGE_S) return false;
  if (m.trades < MIN_TRADES) return false;
  if (m.buyers.size < MIN_BUYERS) return false;
  if (m.lastPrice <= 0 || m.createPrice <= 0) return false;
  if (m.lastPrice < m.createPrice * (ENTRY_GAIN_NUM / 100)) return false;
  if (m.lastPrice > m.createPrice * (ENTRY_GAIN_MAX_NUM / 100)) return false;
  if (marketCapSol(m.lastPrice) >= MAX_ENTRY_MCAP_SOL) return false;
  if (m.buyVol * BigInt(BUY_DOMINANCE_DEN) < m.sellVol * BigInt(BUY_DOMINANCE_NUM)) return false;
  const fiveMinAgo = priceAt(m, m.lastTs - MOMENTUM_LOOKBACK_S);
  if (m.lastPrice < fiveMinAgo * (MOMENTUM_NUM / 100)) return false;
  return true;
}

function committedLamports(mint: string): bigint {
  const p = positions.get(mint);
  const spent = p ? p.quoteIn : 0n;
  const pend = pendingBuys.get(mint) || 0n;
  return spent + pend;
}

function decide(batch: any): Order[] {
  const orders: Order[] = [];
  const touched = new Set<string>();
  for (const ev of batch.events) touched.add(String(ev.mint));

  // --- exits first: stop-loss, take-profit, trailing stop, time exit.
  for (const [mint, p] of positions) {
    if (orders.length >= MAX_ORDERS_PER_BATCH) break;
    const m = mints.get(mint);
    if (!m || m.complete) continue; // a completing coin is closed by the engine
    const price = m.lastPrice;
    if (price <= 0) continue;
    const entry = entryPriceOf(p);
    if (entry <= 0) continue;
    if (price > p.peak) p.peak = price;
    const age = m.lastTs - m.createdTs;
    let sellTokens = 0n;
    if (price <= entry * (STOP_LOSS_NUM / 100)) {
      sellTokens = p.tokens; // stop-loss: exit everything
    } else if (!p.soldHalf && price >= entry * (TAKE_PROFIT_1_NUM / 100)) {
      sellTokens = p.tokens / 2n; // take half at +50%
      p.soldHalf = true;
    } else if (p.soldHalf && price >= entry * (TAKE_PROFIT_2_NUM / 100)) {
      sellTokens = p.tokens; // take the rest at +100%
    } else if (p.soldHalf && price <= p.peak * (TRAIL_NUM / 100)) {
      sellTokens = p.tokens; // trailing stop after the first take-profit
    } else if (age >= TIME_EXIT_AGE_S && price < entry * (TIME_EXIT_GAIN_NUM / 100)) {
      sellTokens = p.tokens; // dead money after ninety minutes
    }
    if (sellTokens > 0n) {
      // Emit the full exit. The engine rejects a sell whose payout exceeds
      // real reserves for free, and it fills cleanly once reserves grow, so
      // never shrink an exit into dust: partial exits bleed a position out
      // at the bottom and pay a transaction fee per chunk.
      orders.push({
        side: "sell",
        client_id: nextClientId("s"),
        mint,
        token_amount: sellTokens.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }

  // --- entries and laddering, only while a position slot is free.
  const openCount =
    positions.size + [...pendingNewMints].filter((mt) => !positions.has(mt)).length;
  if (openCount < MAX_OPEN_POSITIONS) {
    for (const mint of touched) {
      if (orders.length >= MAX_ORDERS_PER_BATCH) break;
      const m = mints.get(mint);
      if (!m || m.complete) continue;
      if (neverReenter.has(mint)) continue;
      if (enteredMints.size >= MAX_COINS_ENTERED && !enteredMints.has(mint)) continue;
      if (!entryEligible(m)) continue;

      const p = positions.get(mint);
      if (p && p.buys >= MAX_BUYS_PER_POSITION) continue;
      const committed = committedLamports(mint);
      if (p) {
        // Ladder only into strength, never average down hard.
        const entry = entryPriceOf(p);
        if (entry > 0 && m.lastPrice < entry * 0.95) continue;
      }
      if (m.lastRealSol <= 0n) continue;
      // Total spent per coin is capped at half of real reserves, and so is
      // the position's current value, so a full exit stays payable.
      const spentCap = m.lastRealSol / 2n;
      let quote = TARGET_POSITION < spentCap ? TARGET_POSITION : spentCap;
      quote -= committed;
      if (p) {
        const posValue = BigInt(Math.floor(Number(p.tokens) * m.lastPrice));
        const room = m.lastRealSol / 2n - posValue;
        if (quote > room) quote = room;
      }
      // One order per mint per reply, at most 1% of decision-time real reserves.
      const cap1pct = m.lastRealSol / 100n;
      if (quote > cap1pct) quote = cap1pct;
      const feesForReply = txFeeLamports * BigInt(orders.length + 1);
      const affordable = cashLamports - CASH_BUFFER - feesForReply;
      if (quote > affordable) quote = affordable;
      if (quote < MIN_BUY) continue;
      orders.push({
        side: "buy",
        client_id: nextClientId("b"),
        mint,
        quote_lamports: quote.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      pendingBuys.set(mint, (pendingBuys.get(mint) || 0n) + quote);
      enteredMints.add(mint);
      if (!p) pendingNewMints.add(mint);
    }
  }

  return orders;
}

// ---------------------------------------------------------------- main loop
function handleHello(msg: any): void {
  helloSeen = true;
  const capital = BigInt(msg.capital?.lamports ?? "10000000000");
  void capital;
  const fees = msg.fees || {};
  const base = BigInt(fees.base_fee_lamports ?? "5000");
  const prio = BigInt(fees.priority_fee_lamports ?? "100000");
  txFeeLamports = base + prio;
  log("hello: capital", msg.capital?.lamports, "txFee", txFeeLamports.toString());
}

function handleBatch(msg: any): void {
  for (const ev of msg.events) {
    if (ev.event === "CreateEvent") onCreate(ev);
    else if (ev.event === "TradeEvent") onTrade(ev);
    else if (ev.event === "CompleteEvent") onComplete(ev);
  }
  if (Array.isArray(msg.fills)) onFills(msg.fills);
  if (msg.account) {
    cashLamports = BigInt(msg.account.cash_lamports);
    // Cross-check: drop positions the account no longer shows (harness closes).
    const live = new Set<string>();
    for (const pos of msg.account.positions) live.add(String(pos.mint));
    for (const mint of [...positions.keys()]) {
      if (!live.has(mint) && !pendingBuys.has(mint)) {
        positions.delete(mint);
        neverReenter.add(mint);
      }
    }
  }
  const orders = decide(msg);
  process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
}

function main(): void {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.type === "hello") handleHello(msg);
    else if (msg.type === "batch") handleBatch(msg);
    else if (msg.type === "done") {
      log("done");
      process.exit(0);
    }
  });
  rl.on("close", () => process.exit(0));
}

main();
