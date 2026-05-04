# Design: Subagent Isolation + Auto Session Compaction

**Date**: 2026-03-08
**Problem**: `agent:main:main` WhatsApp session accumulates 254K+ tokens over time, causing LLM timeouts. All tasks (fact-check, BTC queries, general chat) compete for the same context window.
**Goal**: Main agent stays lightweight (pure router). Heavy tasks run in isolated subagents with their own session history. All sessions auto-compact when they exceed 100 messages.

---

## Architecture

```
WhatsApp (+917736492801)
        │
        ▼
┌──────────────────┐
│   main agent     │  ← lightweight router only
│   session stays  │
│   tiny (1-3 turns│
└──────┬───────────┘
       │ dispatches via exec (background)
       ├──── "fact-check X" ──────────────▶ ┌──────────────────┐
       │                                    │  fact-checker    │
       │                                    │  agent           │
       │                                    │  own workspace   │
       │                                    │  own session     │
       └──── "BTC position?" ─────────────▶ └──────────────────┘
                                            ┌──────────────────┐
                                            │  btc-trader      │
                                            │  agent           │
                                            │  own workspace   │
                                            │  own session     │
                                            └──────────────────┘

Compaction cron (every 30 min):
  → Scans all agent session stores
  → If any session JSONL > 100 messages: summarize → memory file → clear
```

---

## Components

### 1. Two New Isolated Agents

| Agent ID | Workspace | Purpose |
|---|---|---|
| `fact-checker` | `~/.openclaw/workspace/fact-checker-agent/` | Handles fact-check WhatsApp requests |
| `btc-trader` | `~/.openclaw/workspace/btc-trader-agent/` | Handles BTC queries + BTC cron |
| `main` | `~/.openclaw/workspace/` (existing) | Router only — general chat + dispatching |

Created with:
```bash
openclaw agents add fact-checker \
  --workspace /home/node/.openclaw/workspace/fact-checker-agent \
  --model nvidia/moonshotai/kimi-k2.5 \
  --non-interactive

openclaw agents add btc-trader \
  --workspace /home/node/.openclaw/workspace/btc-trader-agent \
  --model nvidia/moonshotai/kimi-k2.5 \
  --non-interactive
```

Each creates:
- `~/.openclaw/agents/[id]/` — agent state dir (auth, models)
- `~/.openclaw/agents/[id]/sessions/` — isolated session store

### 2. Main Agent as Lightweight Router

**Main agent system context updated** (SOUL.md or new ROUTER.md) to say:
> "You are a router. Dispatch fact-check tasks to the fact-checker agent. Dispatch BTC queries to btc-trader agent. Handle general chat directly. Keep your responses short — let subagents do the heavy work."

**Dispatch mechanism** — main agent's SKILL.md / description instructs ONE exec call:
```bash
# In background to avoid gateway deadlock
openclaw agent --agent fact-checker \
  --to +917736492801 \
  --message "fact-check Ukraine drones" \
  --deliver --reply-channel whatsapp &
```

Main session `agent:main:whatsapp:+917736492801` stays at 1-2 turns per user message.

### 3. Per-Agent Skills

**fact-checker agent workspace**:
- `SOUL.md` — identity for fact-checker agent
- `BOOT.md` — on startup: read `pending.json`, recent memory files
- `skills/fact-checker/SKILL.md` — existing fact-checker SKILL.md (symlinked or copied)

**btc-trader agent workspace**:
- `SOUL.md` — identity for btc-trader agent
- `BOOT.md` — on startup: read `paper-trading-btc.json`, `risk-state.json`, recent memory
- Skills: BTC trading scripts knowledge embedded in SOUL.md

### 4. Session Compaction Cron

**Script**: `~/.openclaw/skills/compact-sessions/scripts/compact.py`

**Logic**:
```
For each agent in [main, fact-checker, btc-trader]:
  Load sessions.json for that agent
  For each session that has a JSONL file:
    Count lines (messages) in JSONL
    If lines > 100:
      Extract last 30 user+assistant messages
      Call Ollama (qwen3.5:4b) to summarize → 5-sentence summary
      Write to <workspace>/memory/YYYY-MM-DD-HH-[session-slug].md
      Delete session entry from sessions.json
      Log: "[compact] cleared agent:<id>:<session> → saved memory file"
```

**Registered as OpenClaw cron**: every 30 minutes, `sessionTarget: isolated`

**Memory file format**:
```markdown
# Session Summary: 2026-03-08 14:30 UTC
Agent: fact-checker | Session: agent:fact-checker:whatsapp:+917736492801
Turns: 127 | Compacted at: ~85K tokens

## Summary
[3-5 sentence LLM summary of what happened in the session]

## Key State
- Last fact-checked: Ukraine drone attacks (UNVERIFIED, pending approval)
- User preference: wants brief confirmations
- Pending expires: 2026-03-08 22:00 UTC
```

### 5. BOOT.md Per Agent (Context Injection)

The `boot-md` hook already exists and runs `BOOT.md` at gateway startup from each agent's workspace.

**`workspace/fact-checker-agent/BOOT.md`**:
```markdown
# Fact-Checker Agent Boot

On startup:
1. Read `~/.openclaw/workspace/fact-checker/pending.json` if it exists
2. Read the 3 most recent files in `memory/`
3. You are now ready to fact-check. Wait for user requests.
```

**`workspace/btc-trader-agent/BOOT.md`**:
```markdown
# BTC Trader Agent Boot

On startup:
1. Read `memory/paper-trading-btc.json` and `memory/risk-state.json`
2. Read the 2 most recent files in `memory/`
3. Silently note current position and risk state. Ready for queries.
```

**`workspace/BOOT.md`** (main agent):
```markdown
# Main Agent Boot

On startup:
1. Read the 2 most recent files in `memory/` for recent context
2. You are a router. Dispatch fact-check and BTC requests to subagents.
```

---

## Data Flow

### Fact-check request (WhatsApp → subagent)
```
User: "fact-check Russia drone attack"
  → main agent receives → exec (background):
      openclaw agent --agent fact-checker --to +917736492801 \
        --message "fact-check Russia drone attack" \
        --deliver --reply-channel whatsapp &
  → main agent responds immediately: "Routing to fact-checker..."
  → fact-checker agent runs in its own session:
      reads SKILL.md → exec run_pipeline.sh → sends WhatsApp brief
```

### Session compaction (auto)
```
compact.py cron fires (every 30 min)
  → fact-checker session has 127 messages
  → Ollama summarizes last 30 messages
  → Saves: workspace/fact-checker-agent/memory/2026-03-08-14-fact-check-session.md
  → Deletes session from fact-checker sessions.json
  → On next fact-check request: BOOT.md injects memory file context
```

### BTC query
```
User: "what's my paper trading position?"
  → main agent dispatches to btc-trader agent (background exec)
  → btc-trader agent: reads paper-trading-btc.json → reports position
  → same compaction applies when btc-trader session > 100 messages
```

---

## Files to Create/Modify

| File | Action |
|---|---|
| `~/.openclaw/skills/compact-sessions/scripts/compact.py` | CREATE — compaction script |
| `~/.openclaw/skills/compact-sessions/SKILL.md` | CREATE — cron registration |
| `~/.openclaw/workspace/BOOT.md` | CREATE — main agent boot context |
| `~/.openclaw/workspace/fact-checker-agent/BOOT.md` | CREATE — fact-checker boot context |
| `~/.openclaw/workspace/fact-checker-agent/SOUL.md` | CREATE — fact-checker identity |
| `~/.openclaw/workspace/btc-trader-agent/BOOT.md` | CREATE — BTC trader boot context |
| `~/.openclaw/workspace/btc-trader-agent/SOUL.md` | CREATE — BTC trader identity |
| `~/.openclaw/workspace/skills/fact-checker/SKILL.md` | MODIFY — update description to route dispatch |
| `~/.openclaw/workspace/SOUL.md` | MODIFY — add router instructions |
| `~/.openclaw/openclaw.json` | MODIFIED by `openclaw agents add` |
| `moltbot-docker-setup.sh` | MODIFY — add agent creation commands |

---

## Verification

1. `openclaw agents list` → shows `main`, `fact-checker`, `btc-trader`
2. Send "fact-check climate change" via WhatsApp → main agent responds "Routing..." → fact-checker agent sends brief
3. Send "BTC position" → main responds "Routing..." → btc-trader responds with position
4. Run `compact.py --dry-run` → shows which sessions would be compacted
5. Wait 30 min → check `workspace/fact-checker-agent/memory/` for compaction files
6. Check `docker logs moltbot` for BOOT.md load confirmation on next restart
