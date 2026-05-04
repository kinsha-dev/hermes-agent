#!/usr/bin/env bash
# refresh-anthropic-token.sh
# Reads Claude Code OAuth token from macOS Keychain.
# If expired, refreshes via Anthropic OAuth endpoint.
# Injects fresh tokens into all moltbot agent auth files.
#
# Usage:
#   bash refresh-anthropic-token.sh        # run manually
#   crontab -l                             # verify cron entry

set -euo pipefail

CONTAINER_NAME="moltbot"
LOG_DIR="/Users/kinsha/.openclaw/logs"
LOG_FILE="$LOG_DIR/token-refresh.log"
TOKEN_CACHE="$LOG_DIR/token-cache.json"
MAX_LOG_LINES=500

# Anthropic OAuth constants (from Claude Code source)
TOKEN_ENDPOINT="https://platform.claude.com/v1/oauth/token"
CLIENT_ID="9d1c250a-e61b-44d9-88ed-5944d1962f5e"
BETA_HEADER="oauth-2025-04-20"

mkdir -p "$LOG_DIR"

log()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }
warn() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠ $*" | tee -a "$LOG_FILE"; }
fail() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ $*" | tee -a "$LOG_FILE"; exit 1; }

rotate_log() {
  if [[ -f "$LOG_FILE" ]]; then
    tail -n $MAX_LOG_LINES "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
  fi
}

rotate_log
log "=== Token refresh started ==="

# ── 1. Read tokens — env var first, then Keychain ─────────────────────────────
NOW_MS=$(python3 -c "import time; print(int(time.time() * 1000))")
ACCESS=""
REFRESH=""
EXPIRES=""
SOURCE=""

# Always try keychain first for cache purposes (has refresh token + longer expiry)
# Even if we end up using the env var for injection, keychain token goes into cache
KEYCHAIN_JSON=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || true)
if [[ -n "$KEYCHAIN_JSON" ]]; then
  KC_ACCESS=$(echo "$KEYCHAIN_JSON"  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['claudeAiOauth']['accessToken'])")
  KC_REFRESH=$(echo "$KEYCHAIN_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['claudeAiOauth']['refreshToken'])")
  KC_EXPIRES=$(echo "$KEYCHAIN_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['claudeAiOauth']['expiresAt'])")
  # Write keychain to cache only if it expires later than existing cache
  # (protects against overwriting a good refreshed token with a stale keychain entry)
  python3 -c "
import json, os
cache_file = '${TOKEN_CACHE}'
existing_exp = 0
if os.path.exists(cache_file):
    try:
        existing_exp = json.load(open(cache_file)).get('expiresAt', 0)
    except Exception:
        pass
if ${KC_EXPIRES} > existing_exp:
    cache = {'accessToken': '${KC_ACCESS}', 'refreshToken': '${KC_REFRESH}', 'expiresAt': ${KC_EXPIRES}}
    open(cache_file, 'w').write(json.dumps(cache))
" 2>/dev/null || true
fi

# Priority 1: CLAUDE_CODE_OAUTH_TOKEN env var (set by Claude Desktop app)
if [[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]]; then
  ACCESS="$CLAUDE_CODE_OAUTH_TOKEN"
  EXPIRES=$(python3 -c "import time; print(int((time.time() + 3600) * 1000))")
  REFRESH=""
  SOURCE="env:CLAUDE_CODE_OAUTH_TOKEN"
  log "Using fresh token from CLAUDE_CODE_OAUTH_TOKEN (valid ~1h)"
fi

# Priority 2: macOS Keychain
if [[ -z "$ACCESS" ]] && [[ -n "$KEYCHAIN_JSON" ]]; then
  ACCESS="$KC_ACCESS"
  REFRESH="$KC_REFRESH"
  EXPIRES="$KC_EXPIRES"
  SOURCE="keychain"
fi

# Priority 3: local token cache (used by cron when Keychain is inaccessible)
if [[ -z "$ACCESS" ]] && [[ -f "$TOKEN_CACHE" ]]; then
  ACCESS=$(python3 -c "import json; d=json.load(open('$TOKEN_CACHE')); print(d['accessToken'])" 2>/dev/null || true)
  REFRESH=$(python3 -c "import json; d=json.load(open('$TOKEN_CACHE')); print(d.get('refreshToken',''))" 2>/dev/null || true)
  EXPIRES=$(python3 -c "import json; d=json.load(open('$TOKEN_CACHE')); print(d['expiresAt'])" 2>/dev/null || true)
  SOURCE="cache"
  [[ -n "$ACCESS" ]] && log "Keychain unavailable — using token cache (expires_at=$EXPIRES)"
fi

if [[ -z "$ACCESS" ]]; then
  fail "No Claude Code credentials in Keychain or cache. Run: claude auth login"
fi

DIFF_H=$(python3 -c "print(round(($EXPIRES - $NOW_MS) / 3600000, 2))")
log "Token source=$SOURCE expires_in=${DIFF_H}h"

# ── 2. Refresh token if expired or expiring within 30 min ─────────────────────
NEEDS_REFRESH=$(python3 -c "print('yes' if $DIFF_H < 0.5 else 'no')")

if [[ "$NEEDS_REFRESH" == "yes" ]]; then
  log "Token expired/near-expiry — attempting OAuth refresh..."

  REFRESH_RESULT=$(curl -sf -X POST "$TOKEN_ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "anthropic-beta: $BETA_HEADER" \
    -d "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"${REFRESH}\",\"client_id\":\"${CLIENT_ID}\"}" \
    2>/dev/null || echo '{"error":"curl_failed"}')

  if echo "$REFRESH_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); exit(0 if 'access_token' in d else 1)" 2>/dev/null; then
    # Refresh succeeded — extract new tokens
    NEW_ACCESS=$(echo "$REFRESH_RESULT"  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['access_token'])")
    NEW_REFRESH=$(echo "$REFRESH_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('refresh_token', ''))")
    EXPIRES_IN=$(echo "$REFRESH_RESULT"  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('expires_in', 3600))")
    NEW_EXPIRES=$(python3 -c "import time; print(int((time.time() + $EXPIRES_IN) * 1000))")

    log "OAuth refresh succeeded! New token valid for ${EXPIRES_IN}s"

    # Update Keychain with new tokens
    NEW_KEYCHAIN=$(echo "$KEYCHAIN_JSON" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
d['claudeAiOauth']['accessToken'] = '${NEW_ACCESS}'
if '${NEW_REFRESH}': d['claudeAiOauth']['refreshToken'] = '${NEW_REFRESH}'
d['claudeAiOauth']['expiresAt'] = ${NEW_EXPIRES}
print(json.dumps(d))
")
    KC_ACCOUNT=$(security find-generic-password -s "Claude Code-credentials" 2>/dev/null | awk -F'"' '/"acct"/{print $4}')
    security add-generic-password -U -a "$KC_ACCOUNT" -s "Claude Code-credentials" -w "$NEW_KEYCHAIN" 2>/dev/null && \
      log "Keychain updated with fresh tokens" || \
      warn "Keychain update failed (continuing with container injection)"

    ACCESS="$NEW_ACCESS"
    if [[ -n "$NEW_REFRESH" ]]; then REFRESH="$NEW_REFRESH"; fi
    EXPIRES="$NEW_EXPIRES"
    DIFF_H=$(python3 -c "print(round(($EXPIRES - $NOW_MS) / 3600000, 2))")

    # Write cache so cron can use it when Keychain is inaccessible
    python3 -c "
import json
cache = {'accessToken': '${ACCESS}', 'refreshToken': '${REFRESH}', 'expiresAt': ${EXPIRES}}
open('${TOKEN_CACHE}', 'w').write(json.dumps(cache))
" && log "Token cache updated" || warn "Token cache write failed"
  else
    ERR=$(echo "$REFRESH_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error','unknown'))" 2>/dev/null || echo "unknown")
    warn "OAuth refresh failed ($ERR) — run 'claude auth login' on Mac to re-authenticate"
    # Continue with whatever we have (even if expired — inject so gateway attempts it)
  fi
fi

# ── 3. Verify container is running ────────────────────────────────────────────
if ! docker ps --format "{{.Names}}" | grep -q "^${CONTAINER_NAME}$"; then
  fail "Container $CONTAINER_NAME not running — skipping injection"
fi

# ── 4. Inject token into all agent auth files (type:token — plain bearer) ─────
docker exec -i "$CONTAINER_NAME" python3 - "$ACCESS" "$EXPIRES" << 'PYEOF'
import json, sys, time
from pathlib import Path

ACCESS, EXPIRES = sys.argv[1], int(sys.argv[2])
now = time.time() * 1000
diff_h = (EXPIRES - now) / 3600000
print(f"  Injecting OAuth token as bearer (expires in {diff_h:.1f}h)")

# type:token = raw bearer, no refresh needed — OpenClaw uses it as-is
token_obj = {"type": "token", "token": ACCESS, "expires": EXPIRES}
profile_obj = {"type": "token", "provider": "anthropic", "token": ACCESS, "expires": EXPIRES}

# main/auth.json
p = Path("/home/node/.openclaw/agents/main/agent/auth.json")
d = json.loads(p.read_text())
d["anthropic"] = token_obj
p.write_text(json.dumps(d, indent=2))
print("  ✓ main/auth.json")

# main/auth-profiles.json
p = Path("/home/node/.openclaw/agents/main/agent/auth-profiles.json")
d = json.loads(p.read_text())
d["profiles"]["anthropic:default"] = profile_obj
d["lastGood"]["anthropic"] = "anthropic:default"
s = d.setdefault("usageStats", {}).setdefault("anthropic:default", {})
s["errorCount"] = 0
s.pop("cooldownUntil", None)
s.pop("failureCounts", None)
p.write_text(json.dumps(d, indent=2))
print("  ✓ main/auth-profiles.json")

# subagent auth files (both auth.json and auth-profiles.json)
for agent in ["fact-checker", "btc-trader"]:
    base = Path(f"/home/node/.openclaw/agents/{agent}/agent")
    base.mkdir(parents=True, exist_ok=True)

    # auth.json
    ap = base / "auth.json"
    try:
        existing = json.loads(ap.read_text()) if ap.exists() else {}
    except Exception:
        existing = {}
    existing["anthropic"] = token_obj
    ap.write_text(json.dumps(existing, indent=2))
    print(f"  ✓ {agent}/auth.json")

    # auth-profiles.json
    pp = base / "auth-profiles.json"
    try:
        pd = json.loads(pp.read_text()) if pp.exists() else {}
    except Exception:
        pd = {}
    pd.setdefault("version", 1)
    pd.setdefault("profiles", {})["anthropic:default"] = profile_obj
    pd.setdefault("lastGood", {})["anthropic"] = "anthropic:default"
    s = pd.setdefault("usageStats", {}).setdefault("anthropic:default", {})
    s["errorCount"] = 0
    s.pop("cooldownUntil", None)
    s.pop("failureCounts", None)
    s.pop("lastFailureAt", None)
    pp.write_text(json.dumps(pd, indent=2))
    print(f"  ✓ {agent}/auth-profiles.json")

print("  Done.")
PYEOF

log "Injection complete (token valid ${DIFF_H}h)"
log "=== Token refresh complete ==="
