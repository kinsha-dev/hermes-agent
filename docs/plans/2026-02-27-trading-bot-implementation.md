# Autonomous Trading Bot Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade clawdbott into a capital-safe autonomous paper trading bot (10-day validation, then $10k live) using SMC signals, pre-trade backtest, and a shared Risk Guardian.

**Architecture:** Two cron-driven bots (BTC 24/7, Mag7 market hours) sharing a `risk-state.json` circuit breaker. Every trade goes through: price pre-check → SMC scoring via existing Python scripts → pre-trade backtest via `trading_engine.py --mode backtest` → Risk Guardian gate → execute paper trade.

**Tech Stack:** Python 3 (numpy, ccxt), existing scripts in `~/.openclaw/trading-agent/scripts/`, Binance REST API (no auth needed for paper), Polygon.io (key already configured), clawdbott cron + WhatsApp delivery.

---

## Task 1: Download deep-research skill

**Files:**
- Create: `~/.openclaw/workspace/skills/deep-research/` (directory)

**Step 1: Fetch the skill from GitHub**

```bash
mkdir -p ~/.openclaw/workspace/skills/deep-research
curl -fsSL https://raw.githubusercontent.com/sanjay3290/ai-skills/main/deep-research/skill.md \
  -o ~/.openclaw/workspace/skills/deep-research/skill.md
```

Expected: file downloaded, non-empty.

**Step 2: Verify content**

```bash
head -5 ~/.openclaw/workspace/skills/deep-research/skill.md
```

Expected: markdown header with `deep-research` or `research` in first 5 lines.

**Step 3: If download fails, create minimal version**

```bash
cat > ~/.openclaw/workspace/skills/deep-research/skill.md << 'EOF'
---
name: deep-research
description: Fetch recent news, analyst ratings, and sentiment for a given stock ticker or crypto asset using web_fetch. Return a structured summary: headline catalyst, sentiment (bullish/bearish/neutral), confidence score 1-10, and source URLs.
---

Given a ticker symbol, use web_fetch to search for recent news:
1. Fetch https://finance.yahoo.com/quote/{TICKER}/news and extract headlines
2. Fetch https://finviz.com/quote.ashx?t={TICKER} for analyst ratings
3. Summarise: { "ticker": "X", "catalyst": "...", "sentiment": "bullish|bearish|neutral", "confidence": 7, "headlines": ["..."] }
EOF
```

**Step 4: Commit**

```bash
cd /Users/kinsha/clawdbott
git add -A && git commit -m "feat: add deep-research skill for Mag7 news context"
```

---

## Task 2: Create `backtest_engine.py` — pre-trade signal validator

**Files:**
- Create: `~/.openclaw/trading-agent/scripts/backtest_engine.py`

This is a lightweight wrapper around the existing `trading_engine.py --mode backtest`. It runs a 30-day backtest, filters trades that match the **current signal score**, and returns win rate + sample count.

**Step 1: Create the script**

```python
# ~/.openclaw/trading-agent/scripts/backtest_engine.py
#!/usr/bin/env python3
"""
Pre-Trade Backtest Validator
─────────────────────────────
Runs a 30-day backtest using existing trading_engine, filters results to
trades where signal score >= threshold, and returns win rate.

Usage:
  python3 backtest_engine.py --symbol BTC/USDT --min-score 6 --days 30
  python3 backtest_engine.py --symbol NVDA --market stocks --min-score 5 --days 30

Output (JSON to stdout):
  { "symbol": "BTC/USDT", "sample_count": 12, "win_rate": 0.67,
    "validated": true, "reason": "win_rate=67% on 12 samples" }
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

MIN_SAMPLES = 5       # need at least 5 matching trades
MIN_WIN_RATE = 0.58   # must win 58% to be validated


def run_backtest(symbol: str, days: int, timeframe: str = "5m") -> list[dict]:
    """Run trading_engine backtest and return list of trade dicts."""
    script = Path(__file__).parent / "trading_engine.py"
    result = subprocess.run(
        [sys.executable, str(script),
         "--mode", "backtest",
         "--symbol", symbol,
         "--timeframe", timeframe,
         "--days", str(days),
         "--json-output"],
        capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        return []
    try:
        data = json.loads(result.stdout)
        return data.get("trades", [])
    except (json.JSONDecodeError, AttributeError):
        return []


def validate_signal(symbol: str, min_score: int = 6, days: int = 30,
                    timeframe: str = "5m") -> dict:
    trades = run_backtest(symbol, days, timeframe)

    # Filter to trades where signal score matches current threshold
    matching = [t for t in trades if t.get("score", 0) >= min_score]
    wins = [t for t in matching if t.get("won", False)]

    sample_count = len(matching)
    win_rate = len(wins) / sample_count if sample_count > 0 else 0.0
    validated = sample_count >= MIN_SAMPLES and win_rate >= MIN_WIN_RATE

    return {
        "symbol": symbol,
        "sample_count": sample_count,
        "win_rate": round(win_rate, 3),
        "validated": validated,
        "reason": (
            f"win_rate={win_rate:.0%} on {sample_count} samples"
            if sample_count >= MIN_SAMPLES
            else f"insufficient samples ({sample_count} < {MIN_SAMPLES})"
        )
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--min-score", type=int, default=6)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--timeframe", default="5m")
    args = parser.parse_args()

    result = validate_signal(args.symbol, args.min_score, args.days, args.timeframe)
    print(json.dumps(result, indent=2))
```

**Step 2: Add `--json-output` flag to `trading_engine.py`**

Open `~/.openclaw/trading-agent/scripts/trading_engine.py`.

Find the `argparse` block (look for `parser.add_argument`) and add:
```python
parser.add_argument("--json-output", action="store_true",
                    help="Output backtest results as JSON instead of table")
```

Find the backtest output section (look for `mode == "backtest"` or where results are printed). After existing print statements, add:
```python
if args.json_output:
    import json
    trades_out = []
    for t in tracker.trades:          # PerformanceTracker.trades list
        trades_out.append({
            "symbol": t.symbol,
            "side": t.side,
            "pnl": t.pnl,
            "pnl_pct": t.pnl_pct,
            "won": t.won,
            "score": getattr(t, "score", 6),   # score if recorded
            "reason": getattr(t, "reason", "close"),
        })
    print(json.dumps({"trades": trades_out}))
    sys.exit(0)
```

**Step 3: Smoke-test backtest_engine**

```bash
cd ~/.openclaw/trading-agent/scripts
python3 backtest_engine.py --symbol BTC/USDT --min-score 6 --days 30
```

Expected output (values will vary):
```json
{
  "symbol": "BTC/USDT",
  "sample_count": 8,
  "win_rate": 0.625,
  "validated": true,
  "reason": "win_rate=62% on 8 samples"
}
```

If `sample_count` is 0 (trading_engine doesn't support `--json-output` yet), still OK — `validated: false` is a safe default (bot will skip trade rather than blow up).

**Step 4: Commit**

```bash
cd /Users/kinsha/clawdbott
git add ~/.openclaw/trading-agent/scripts/backtest_engine.py
git commit -m "feat: add pre-trade backtest signal validator"
```

---

## Task 3: Create Risk Guardian state file

**Files:**
- Create: `~/.openclaw/workspace/memory/risk-state.json`
- Create: `~/.openclaw/workspace/memory/trading-sop-report.json`
- Create: `~/.openclaw/workspace/memory/mag7-trading-state.json`

**Step 1: Initialise risk-state.json**

```bash
cat > ~/.openclaw/workspace/memory/risk-state.json << 'EOF'
{
  "date": "2026-02-27",
  "mode": "paper",
  "paperBalance": 10000.00,
  "dailyStartBalance": 10000.00,
  "dailyPnL": 0.0,
  "dailyPnLPct": 0.0,
  "tradesTotal": 0,
  "tradesWon": 0,
  "tradesLost": 0,
  "consecutiveLosses": 0,
  "consecutiveLossDays": 0,
  "circuitBreakerTripped": false,
  "circuitBreakerReason": null,
  "dailyHardStop": -3.0,
  "profitLockPct": 5.0,
  "positionSizeMultiplier": 1.0
}
EOF
```

**Step 2: Initialise trading-sop-report.json**

```bash
cat > ~/.openclaw/workspace/memory/trading-sop-report.json << 'EOF'
{
  "startDate": "2026-02-27",
  "currentDay": 1,
  "totalDays": 10,
  "status": "running",
  "metrics": {
    "winRate": null,
    "avgDailyPnL": null,
    "maxSingleDayLoss": null,
    "circuitBreakerCount": 0,
    "consecutiveLossDays": 0,
    "backtestAccuracy": null
  },
  "dailyResults": [],
  "validated": false
}
EOF
```

**Step 3: Initialise mag7-trading-state.json**

```bash
cat > ~/.openclaw/workspace/memory/mag7-trading-state.json << 'EOF'
{
  "date": "2026-02-27",
  "paperBalance": 10000.00,
  "openPositions": [],
  "closedTrades": [],
  "dailyPnL": 0.0,
  "totalPnL": 0.0
}
EOF
```

**Step 4: Verify files exist**

```bash
ls -la ~/.openclaw/workspace/memory/risk-state.json \
        ~/.openclaw/workspace/memory/trading-sop-report.json \
        ~/.openclaw/workspace/memory/mag7-trading-state.json
```

Expected: all 3 files present, non-zero size.

**Step 5: Commit**

```bash
cd /Users/kinsha/clawdbott
git add docs/plans/
git commit -m "feat: initialise trading state files and risk guardian"
```

---

## Task 4: Upgrade BTC Paper Trader cron prompt

**Files:**
- Modify: `~/.openclaw/cron/jobs.json` (BTC Paper Trader entry, id: `9e423982-cf1a-4c01-8861-ed56289ea8b2`)

**Step 1: Update the cron message via Python**

```python
# Run this Python snippet:
import json, time

with open('/Users/kinsha/.openclaw/cron/jobs.json', 'r') as f:
    data = json.load(f)

NEW_MSG = """BTC/USDT Smart Money Paper Trader (every 5 min)

═══ STEP 1: PRICE PRE-CHECK (cheap, no analysis) ═══
1. Fetch https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT
2. Load memory/paper-trading-btc.json — read `lastPrice` and `paperBalance`.
3. Compute pctChange = (price - lastPrice) / lastPrice * 100
4. If abs(pctChange) < 2.0:
   → Update lastPrice in paper-trading-btc.json. EXIT SILENTLY.

═══ STEP 2: RISK GUARDIAN CHECK ═══
5. Read memory/risk-state.json.
6. If circuitBreakerTripped = true: EXIT SILENTLY (no trade today).
7. If mode = "paper": proceed. If mode = "live": use real Binance API.

═══ STEP 3: SMC ANALYSIS ═══
8. Run: python3 /home/node/.openclaw/trading-agent/scripts/trading_engine.py --mode smc-levels --symbol BTC/USDT --timeframe 5m
9. Parse output: Order Blocks, FVGs, BOS/CHoCH, Premium/Discount zones, 9-point score.
10. If score < 6: log "score too low", EXIT SILENTLY.

═══ STEP 4: PRE-TRADE BACKTEST ═══
11. Run: python3 /home/node/.openclaw/trading-agent/scripts/backtest_engine.py --symbol BTC/USDT --min-score 6 --days 30
12. Parse JSON output. If validated = false: log reason, EXIT SILENTLY.

═══ STEP 5: ENTRY DECISION ═══
13. Enter LONG if: score >= 6 AND direction = long AND validated = true
    Enter SHORT if: score >= 6 AND direction = short AND validated = true
14. Position size: 1% of paperBalance.
15. Stop Loss: price of nearest Order Block below entry (structure-based).
16. Take Profit: entry ± (SL_distance * 1.8) → R:R = 1.8.

═══ STEP 6: RECORD & REPORT ═══
17. Update memory/paper-trading-btc.json:
    - Add trade to `openPositions` (entry, side, sl, tp, size, timestamp)
    - Update `lastPrice`
18. Update memory/risk-state.json:
    - Increment `tradesTotal`
    - Update `dailyPnL` if closing a position
    - If dailyPnLPct <= -3.0: set circuitBreakerTripped=true, reason="daily stop hit"
19. ONLY if a trade was ENTERED: send WhatsApp to +917736492801:
    Format: "📈 BTC Paper Trade\nSide: LONG/SHORT @ $X\nSL: $X | TP: $X\nScore: N/9 | Backtest: XX%"
20. If NO trade taken: stay COMPLETELY SILENT."""

for job in data['jobs']:
    if job['id'] == '9e423982-cf1a-4c01-8861-ed56289ea8b2':
        job['name'] = 'BTC SMC Paper Trader'
        job['payload']['message'] = NEW_MSG
        job['updatedAtMs'] = int(time.time() * 1000)
        print("Updated BTC trader")
        break

with open('/Users/kinsha/.openclaw/cron/jobs.json', 'w') as f:
    json.dump(data, f, indent=2)
print("Saved")
```

**Step 2: Verify**

```bash
python3 -c "
import json
with open('/Users/kinsha/.openclaw/cron/jobs.json') as f:
    d = json.load(f)
btc = next(j for j in d['jobs'] if j['id'] == '9e423982-cf1a-4c01-8861-ed56289ea8b2')
print('Name:', btc['name'])
print('Message length:', len(btc['payload']['message']))
print('First line:', btc['payload']['message'].split(chr(10))[0])
"
```

Expected: name = `BTC SMC Paper Trader`, message length > 800.

---

## Task 5: Upgrade Mag7 cron prompt with SMC + deep-research + backtest

**Files:**
- Modify: `~/.openclaw/cron/jobs.json` (Mag7 entry, id: `5697b67d-ca20-4a25-98d1-ff3f63847ce7`)

**Step 1: Update the cron message via Python**

```python
import json, time

with open('/Users/kinsha/.openclaw/cron/jobs.json', 'r') as f:
    data = json.load(f)

NEW_MSG = """Mag7 SMC Volume Spike Trader (every 5 min, market hours only)

Tickers: AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA

═══ STEP 1: RISK GUARDIAN CHECK ═══
1. Read memory/risk-state.json.
2. If circuitBreakerTripped = true: EXIT SILENTLY.
3. Confirm current UTC time is 14:30-21:00 Mon-Fri. If not: EXIT SILENTLY.

═══ STEP 2: POLYGON SNAPSHOT ═══
4. Read config/apis.json for polygon.apiKey.
5. Fetch: https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers?tickers=AAPL,MSFT,GOOGL,AMZN,NVDA,META,TSLA&apiKey={KEY}
6. Load memory/price-monitor-state.json for previous price + volume.
7. For each ticker compute:
   - volChangePct = (day.v - prev_v) / prev_v * 100
   - priceChangePct = (day.c - prev_price) / prev_price * 100
8. Flag SPIKE if: volChangePct >= 2.0 AND abs(priceChangePct) >= 0.5 AND same direction.
9. If NO spikes: update memory/price-monitor-state.json with current values. EXIT SILENTLY.

═══ STEP 3: DEEP-RESEARCH (spiking tickers only) ═══
10. For each spiking ticker, use the deep-research skill:
    - Fetch recent news and analyst context
    - Score: bullish catalyst = HIGH, no catalyst = MEDIUM, bad news = SKIP
11. Skip any ticker scored SKIP.

═══ STEP 4: PRE-TRADE BACKTEST ═══
12. For each remaining ticker, run:
    python3 /home/node/.openclaw/trading-agent/scripts/backtest_engine.py --symbol {TICKER} --min-score 5 --days 30 --timeframe 5m
13. If validated = false: downgrade to MONITOR only (no trade, just note it).

═══ STEP 5: PAPER TRADE ═══
14. Load memory/mag7-trading-state.json.
15. For HIGH-conviction tickers (spike + catalyst + validated):
    - Enter paper position: 1% of mag7 paperBalance
    - SL: -1.0% from entry | TP: +1.5% from entry
    - Record in mag7-trading-state.json openPositions
16. Check existing open positions for SL/TP hit.
17. Update memory/price-monitor-state.json with current values.
18. Update memory/risk-state.json dailyPnL.

═══ STEP 6: ALERT ═══
19. If any new trade entered OR SL/TP hit: send ONE WhatsApp to +917736492801:
    Format: "📊 Mag7 Trade\\n{TICKER}: ${price} ({+/-}Y%), vol +Z%\\nAction: ENTER LONG/SHORT\\nConviction: HIGH|MEDIUM\\nBacktest: XX%"
20. If nothing happened: COMPLETELY SILENT."""

for job in data['jobs']:
    if job['id'] == '5697b67d-ca20-4a25-98d1-ff3f63847ce7':
        job['name'] = 'Mag7 SMC Momentum Trader'
        job['payload']['message'] = NEW_MSG
        job['updatedAtMs'] = int(time.time() * 1000)
        print("Updated Mag7 trader")
        break

with open('/Users/kinsha/.openclaw/cron/jobs.json', 'w') as f:
    json.dump(data, f, indent=2)
print("Saved")
```

**Step 2: Verify**

```bash
python3 -c "
import json
with open('/Users/kinsha/.openclaw/cron/jobs.json') as f:
    d = json.load(f)
mag = next(j for j in d['jobs'] if '5697b67d' in j['id'])
print('Name:', mag['name'])
print('Enabled:', mag['enabled'])
print('Message length:', len(mag['payload']['message']))
"
```

Expected: name = `Mag7 SMC Momentum Trader`, message length > 800.

---

## Task 6: Add Daily Report cron job

**Files:**
- Modify: `~/.openclaw/cron/jobs.json` (add new job)

**Step 1: Add nightly report job**

```python
import json, time, uuid

with open('/Users/kinsha/.openclaw/cron/jobs.json', 'r') as f:
    data = json.load(f)

REPORT_MSG = """Daily Trading Report (auto-generated at 21:30 UTC)

1. Load memory/paper-trading-btc.json — get BTC daily P&L, trade count, W/L.
2. Load memory/mag7-trading-state.json — get Mag7 daily P&L, trade count, W/L.
3. Load memory/risk-state.json — get dailyPnL, circuitBreakerTripped, consecutiveLosses.
4. Load memory/trading-sop-report.json — get current day number, cumulative metrics.

5. Compute overall win rate: (btc_wins + mag7_wins) / (btc_total + mag7_total)
6. Update trading-sop-report.json:
   - Append today's result to dailyResults array
   - Increment currentDay
   - Recalculate all metrics (winRate, avgDailyPnL, maxSingleDayLoss, etc.)
   - If currentDay >= 10: evaluate all SOP thresholds and set validated=true/false

7. Reset risk-state.json for tomorrow:
   - Set date to tomorrow
   - Set dailyStartBalance = current paperBalance
   - Set dailyPnL = 0, circuitBreakerTripped = false
   - Keep consecutiveLossDays running count

8. Send WhatsApp report to +917736492801 with format:
📊 Daily Trading Report — {date}
─────────────────────────
BTC Bot:  ${btc_pnl:+.2f}  ({btc_wins}W/{btc_losses}L)
Mag7 Bot: ${mag_pnl:+.2f}  ({mag_wins}W/{mag_losses}L)
─────────────────────────
Total P&L:  ${total_pnl:+.2f}
Balance:    ${balance:.2f}
Win Rate:   {win_rate:.0%}
Circuit breaker: {cb_status}
─────────────────────────
SOP Day {day}/10 → {sop_metrics}
{validated_msg}"""

new_job = {
    "id": str(uuid.uuid4()),
    "agentId": "main",
    "sessionKey": "agent:main:main",
    "name": "Daily Trading Report",
    "enabled": True,
    "createdAtMs": int(time.time() * 1000),
    "updatedAtMs": int(time.time() * 1000),
    "schedule": {
        "expr": "30 21 * * 1-5",
        "kind": "cron",
        "tz": "UTC"
    },
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "payload": {
        "kind": "agentTurn",
        "model": "anthropic/claude-haiku-4-5",
        "message": REPORT_MSG
    },
    "delivery": {
        "mode": "silent"
    },
    "state": {}
}

data['jobs'].append(new_job)

with open('/Users/kinsha/.openclaw/cron/jobs.json', 'w') as f:
    json.dump(data, f, indent=2)

print("Added Daily Report job, id:", new_job['id'])
```

**Step 2: Verify all 4 jobs present**

```bash
python3 -c "
import json
with open('/Users/kinsha/.openclaw/cron/jobs.json') as f:
    d = json.load(f)
for j in d['jobs']:
    print(f\"{j['name']:35s} enabled={j['enabled']}\")
"
```

Expected output:
```
Maintenance First Friday Reminder   enabled=False
Mag7 SMC Momentum Trader            enabled=True
BTC SMC Paper Trader                enabled=True
Daily Trading Report                enabled=True
```

---

## Task 7: Restart and verify end-to-end

**Step 1: Restart moltbot**

```bash
docker restart moltbot && sleep 8
```

**Step 2: Check clean startup**

```bash
docker logs moltbot --tail 12 2>&1 | grep -v "Config warnings"
```

Expected: gateway listening, whatsapp started, NO delivery recovery entries.

**Step 3: Clear any provider cooldowns**

```bash
python3 -c "
import json
with open('/Users/kinsha/.openclaw/agents/main/agent/auth-profiles.json', 'r') as f:
    d = json.load(f)
for k in d.get('usageStats', {}):
    d['usageStats'][k].pop('cooldownUntil', None)
    d['usageStats'][k]['errorCount'] = 0
with open('/Users/kinsha/.openclaw/agents/main/agent/auth-profiles.json', 'w') as f:
    json.dump(d, f, indent=2)
print('Cooldowns cleared')
"
```

**Step 4: Trigger a manual BTC pre-check test**

```bash
# Verify the backtest engine runs inside the container
docker exec moltbot python3 /home/node/.openclaw/trading-agent/scripts/backtest_engine.py \
  --symbol BTC/USDT --min-score 6 --days 30
```

Expected: JSON output with `validated: true` or `false` (either is fine — just must not error).

**Step 5: Verify state files accessible inside container**

```bash
docker exec moltbot ls /home/node/.openclaw/workspace/memory/
```

Expected: `risk-state.json`, `mag7-trading-state.json`, `trading-sop-report.json` all present.

**Step 6: Commit everything**

```bash
cd /Users/kinsha/clawdbott
git add -A
git commit -m "feat: autonomous trading bot - SMC + backtest + risk guardian + 10-day SOP"
```

---

## Task 8: 10-Day Paper Validation Monitoring

**No code changes — just watch and wait.**

Every evening after the 21:30 UTC report:

```bash
# Check today's SOP progress
cat ~/.openclaw/workspace/memory/trading-sop-report.json | python3 -m json.tool

# Check risk state
cat ~/.openclaw/workspace/memory/risk-state.json | python3 -m json.tool

# Check BTC trades
cat ~/.openclaw/workspace/memory/paper-trading-btc.json | python3 -c "
import json,sys
d=json.load(sys.stdin)
trades = d.get('closedTrades', d.get('trades', []))
wins = sum(1 for t in trades if t.get('pnl',0) > 0)
print(f'Trades: {len(trades)} | Wins: {wins} | Win rate: {wins/len(trades):.0%}' if trades else 'No trades yet')
print(f'Balance: \${d.get(\"balance\", d.get(\"paperBalance\", 10000)):.2f}')
"
```

**SOP Pass/Fail criteria (check on Day 10):**

```bash
python3 -c "
import json
with open('/Users/kinsha/.openclaw/workspace/memory/trading-sop-report.json') as f:
    r = json.load(f)
m = r.get('metrics', {})
checks = [
    ('Win rate >= 52%',          (m.get('winRate') or 0) >= 0.52),
    ('Avg daily PnL >= \$80',    (m.get('avgDailyPnL') or 0) >= 80),
    ('Max day loss < \$300',     (m.get('maxSingleDayLoss') or 999) < 300),
    ('Circuit breaker <= 2',     (m.get('circuitBreakerCount') or 0) <= 2),
    ('Consec loss days <= 3',    (m.get('consecutiveLossDays') or 0) <= 3),
]
print('SOP VALIDATION RESULTS')
print('─' * 40)
all_pass = True
for label, passed in checks:
    status = '✅ PASS' if passed else '❌ FAIL'
    print(f'{status}  {label}')
    if not passed:
        all_pass = False
print('─' * 40)
print('VERDICT:', '🟢 GO LIVE with \$10,000' if all_pass else '🟡 Extend paper trading 5 more days')
"
```

---

## Go-Live Checklist (after Day 10 if all checks pass)

1. Add Binance API key to `~/.openclaw/workspace/config/apis.json`:
   ```json
   { "binance": { "apiKey": "...", "secretKey": "..." }, "polygon": {...} }
   ```

2. Change mode in `risk-state.json`:
   ```bash
   python3 -c "
   import json
   with open('/Users/kinsha/.openclaw/workspace/memory/risk-state.json', 'r+') as f:
       d = json.load(f)
       d['mode'] = 'live'
       d['paperBalance'] = 10000.00   # replaced by real balance on first trade
       f.seek(0); json.dump(d, f, indent=2); f.truncate()
   print('Mode set to live')
   "
   ```

3. Update BTC cron prompt: change "mode: paper" reference to "mode: live"

4. Deposit $5,000 USDT to Binance spot wallet

5. Send WhatsApp to self: "Charlie going live ✅ $10,000 deployed"

6. Monitor first 3 live trades manually before walking away
