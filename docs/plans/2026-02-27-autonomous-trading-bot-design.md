# Autonomous Trading Bot — Design Document
**Date:** 2026-02-27
**Author:** kingAbid + Charlie (clawdbott)
**Status:** Approved — proceed to implementation

---

## 1. Goal

Build a fully autonomous trading bot on top of clawdbott that:
- Targets **$100/day average** over a 30-day rolling window
- **Preserves capital first** — stops trading on -3% daily drawdown
- Runs **10 days paper trading** to validate SOP before deploying $10,000 real capital
- Requires **minimal human intervention** — WhatsApp alerts only on trades and circuit breakers

---

## 2. Architecture

Two parallel bots sharing a single Risk Guardian:

```
clawdbott (Charlie)
├── 🔴 BTC Live Trader          (24/7, Binance API, every 5 min)
├── 📊 Mag7 Momentum Trader     (Market hours 14:30-21:00 UTC Mon-Fri, every 5 min)
└── 🛡️ Risk Guardian            (shared, checks before every trade)
```

**Skill downloaded from awesome-claude-skills:**
- `deep-research` from `sanjay3290/ai-skills` (GitHub)
- Used by Mag7 bot to fetch news/analyst context before entering positions

---

## 3. Capital Allocation

| Phase | Mode | BTC Allocation | Mag7 Allocation | Reserve |
|---|---|---|---|---|
| Days 1–10 | Paper | $10,000 virtual | $10,000 virtual | — |
| Day 11+ (if validated) | Live | $5,000 | $3,000 | $2,000 |

**Live capital never exceeds $10,000 total deployed.**

---

## 4. Trade Logic

### 4.1 BTC Trader — Signal Stack

Every 5 minutes:

**STEP 1 — Price Pre-check (free, no LLM)**
- Fetch `https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT`
- Load `lastPrice` from `memory/paper-trading-btc.json`
- If change < ±2% → update `lastPrice`, exit silently

**STEP 2 — SMC Analysis (Python scripts)**
- `smc_concepts.py`: Order Blocks, Fair Value Gaps, BOS/CHoCH, Premium/Discount zones
- `signal_generator.py`: RSI(14), EMA(9/21) crossover, MACD, Bollinger Bands, VWAP
- Fetch last 200 candles: `GET /api/v3/klines?symbol=BTCUSDT&interval=5m&limit=200`

**STEP 3 — Pre-Trade Backtest**
- Run same SMC + indicator logic on the 200 historical candles
- Count occurrences of this exact signal pattern
- Calculate win rate of pattern in this dataset
- **Gate:** pattern must appear ≥5 times AND win rate ≥58% to proceed

**STEP 4 — Entry Conditions (ALL required)**
- Price in Discount zone (longs) or Premium zone (shorts)
- Order Block OR Fair Value Gap present as confluence
- BOS or CHoCH confirmed in trade direction
- ≥ 3 of 4 indicators aligned (RSI, EMA cross, MACD, BB)
- Backtest win rate ≥ 58%

**STEP 5 — Position & Risk**
- Size: 1% of balance per trade
- Stop Loss: below nearest Order Block / FVG (structure-based)
- Take Profit: 1.5–2× SL distance (dynamic R:R ≥ 1.5)
- Trailing stop: activates after +0.8% profit, trails at 0.5%
- Max 2 open positions simultaneously

### 4.2 Mag7 Trader — Signal Stack

Every 5 minutes during market hours:

1. Polygon snapshot for AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA
2. Volume spike detection: vol ≥ 2% increase + price ≥ 0.5% move (same direction)
3. If spike detected → `deep-research` skill: fetch news/analyst context
4. SMC on 5m chart: is price at OB or FVG?
5. Pre-trade backtest: does this pattern win ≥58% on this ticker historically?
6. Score signal: HIGH (spike + news + SMC) / MEDIUM (spike + SMC) / SKIP
7. Paper: auto-execute. Live: WhatsApp alert with 60s confirmation window

---

## 5. Risk Guardian

Shared across both bots. Runs before every trade entry.

**State file:** `memory/risk-state.json`
```json
{
  "date": "2026-02-27",
  "dailyPnL": 0.0,
  "dailyPnLPct": 0.0,
  "tradesTotal": 0,
  "tradesWon": 0,
  "circuitBreakerTripped": false,
  "circuitBreakerReason": null
}
```

**Circuit Breaker Rules:**
| Trigger | Action |
|---|---|
| Daily P&L < -3% | Halt ALL trading until next UTC day, WhatsApp alert |
| 3 consecutive losses | Reduce position size to 0.5% for next 3 trades |
| Daily P&L > +5% | Lock in profits, halt new entries for the day |
| Consecutive loss days ≥ 3 | WhatsApp alert, pause 24h, await manual resume |

---

## 6. Reporting

**Nightly at 21:30 UTC** — auto-generated report to WhatsApp:
```
📈 Daily Trading Report — Feb 27
BTC Bot: +$47.20 (3W / 2L / 1 open)
Mag7 Bot: +$38.50 (2W / 1L)
Total P&L: +$85.70
Circuit breaker: NOT triggered
10-Day Avg: $XX/day
SOP Status: Day 3/10 ✅
```

**State files written daily:**
- `memory/paper-trading-btc.json` — BTC trades + balance
- `memory/mag7-trading-state.json` — Mag7 trades + balance
- `memory/risk-state.json` — daily P&L + circuit breaker
- `memory/trading-sop-report.json` — 10-day validation scores

---

## 7. 10-Day SOP Validation Criteria

| Metric | Pass Threshold |
|---|---|
| Win rate (overall) | ≥ 52% |
| Average daily P&L | ≥ $80/day |
| Max single-day loss | < $300 |
| Circuit breaker triggers | ≤ 2 in 10 days |
| Consecutive loss days | ≤ 3 |
| Backtest accuracy | ≥ 60% (predicted wins actually won) |

**If ALL pass → go live with $10,000**
**If ANY fail → review signal params, extend paper 5 days, re-evaluate**

---

## 8. Files & Structure

```
clawdbott/
└── docs/plans/
    └── 2026-02-27-autonomous-trading-bot-design.md  ← this file

~/.openclaw/
├── workspace/
│   ├── skills/
│   │   └── deep-research/          ← download from sanjay3290/ai-skills
│   ├── memory/
│   │   ├── paper-trading-btc.json  ← upgrade existing
│   │   ├── mag7-trading-state.json ← new
│   │   ├── risk-state.json         ← new (shared guardian)
│   │   └── trading-sop-report.json ← new (10-day tracker)
│   └── config/
│       └── apis.json               ← Polygon key already set
├── trading-agent/scripts/
│   ├── smc_concepts.py             ← existing, use as-is
│   ├── smc_signal_generator.py     ← existing, extend for pre-trade backtest
│   ├── signal_generator.py         ← existing
│   ├── risk_manager.py             ← existing, extend for circuit breaker
│   └── backtest_engine.py          ← new
└── cron/jobs.json
    ├── BTC Paper Trader            ← upgrade prompt + logic
    ├── Mag7 Volume Spike Monitor   ← upgrade with SMC + deep-research
    └── Daily Report Generator      ← new cron @ 21:30 UTC
```

---

## 9. Cron Jobs

| Job | Schedule | Model | Description |
|---|---|---|---|
| BTC Trader | every 5 min, 24/7 | claude-haiku-4-5 | Pre-check → SMC → backtest → trade |
| Mag7 Trader | `*/5 14-21 * * 1-5` UTC | claude-haiku-4-5 | Spike → research → SMC → backtest → trade |
| Daily Report | `30 21 * * 1-5` UTC | claude-haiku-4-5 | Summarise P&L, SOP score, WhatsApp alert |

---

## 10. Go-Live Checklist (after 10-day paper validation)

- [ ] All 6 SOP metrics pass
- [ ] Binance API key added to `config/apis.json`
- [ ] $5,000 USDT deposited to Binance spot wallet
- [ ] $3,000 to brokerage for Mag7 (Alpaca / IBKR paper first)
- [ ] Change BTC cron prompt: `mode: paper → mode: live`
- [ ] Notify via WhatsApp: "Going live ✅"
