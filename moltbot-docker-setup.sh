#!/usr/bin/env bash
# moltbot-docker-setup.sh
# Recreate the moltbot OpenClaw container with the correct image and config.
#
# Usage:
#   ./moltbot-docker-setup.sh            # Pull + start moltbot
#   ./moltbot-docker-setup.sh --no-pull  # Skip image pull, just recreate
#   ./moltbot-docker-setup.sh --logs     # Tail logs after start

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────
CONTAINER_NAME="moltbot"
IMAGE="ghcr.io/openclaw/openclaw:2026.3.2"
CONFIG_DIR="/Users/kinsha/.openclaw"
XURL_DIR="$HOME/.xurl"

# Gateway token (stored in openclaw.json — passed here so startup command
# can also read it if needed, but the primary source is the bind-mounted config)
GATEWAY_TOKEN="3a59d6d0c4071d2c60194eac093fdef7f0e364750c4acd05"

# Optional: Anthropic API key for skill scripts (e.g. fact-checker)
# Store in ~/.openclaw/secrets.env as: ANTHROPIC_API_KEY=sk-ant-api03-...
ANTHROPIC_API_KEY=""
SECRETS_FILE="${CONFIG_DIR}/secrets.env"
if [[ -f "$SECRETS_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
fi

# Ports
#   18800 — TCP proxy inside container (0.0.0.0:18800 → 127.0.0.1:18789)
#            Exposes the loopback-bound gateway to the host
#   18790 — ACP bridge discovery port
HOST_GATEWAY_PORT=18800
HOST_ACP_PORT=18790

# Parse flags
SKIP_PULL=false
FOLLOW_LOGS=false
for arg in "$@"; do
  case "$arg" in
    --no-pull) SKIP_PULL=true ;;
    --logs)    FOLLOW_LOGS=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# ─── Startup command ──────────────────────────────────────────────────────────
# Runs a tiny Node.js TCP proxy (18800 → 18789) in the background so the
# loopback-only gateway is reachable from the host, then starts the gateway.
PROXY_CMD='node -e "
const net = require(\"net\");
const PROXY_PORT = 18800;
const GW_PORT = 18789;
net.createServer(client => {
  const server = net.connect(GW_PORT, \"127.0.0.1\");
  client.pipe(server);
  server.pipe(client);
  client.on(\"error\", () => server.destroy());
  server.on(\"error\", () => client.destroy());
}).listen(PROXY_PORT, \"0.0.0.0\", () => {
  console.log(\"[proxy] forwarding 0.0.0.0:\" + PROXY_PORT + \" -> 127.0.0.1:\" + GW_PORT);
});
"'
START_CMD="service cron start 2>/dev/null; $PROXY_CMD & sleep 1 && exec node openclaw.mjs gateway --allow-unconfigured"

# ─── Pre-flight ───────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found in PATH" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not running. Start Docker Desktop first." >&2
  exit 1
fi

if [[ ! -d "$CONFIG_DIR" ]]; then
  echo "ERROR: Config dir not found: $CONFIG_DIR" >&2
  exit 1
fi


# ─── Pull image ───────────────────────────────────────────────────────────────
if [[ "$SKIP_PULL" == false ]]; then
  echo "==> Pulling image: $IMAGE"
  docker pull "$IMAGE"
else
  echo "==> Skipping image pull (--no-pull)"
fi

# ─── Remove existing container ────────────────────────────────────────────────
if docker ps -a --format "{{.Names}}" | grep -q "^${CONTAINER_NAME}$"; then
  echo "==> Stopping and removing existing container: $CONTAINER_NAME"
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm   "$CONTAINER_NAME" 2>/dev/null || true
fi

# ─── Start container ──────────────────────────────────────────────────────────
echo "==> Starting $CONTAINER_NAME"
ANTHROPIC_API_KEY_FLAG=()
if [[ -n "$ANTHROPIC_API_KEY" ]]; then
  ANTHROPIC_API_KEY_FLAG=(-e "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}")
  echo "==> ANTHROPIC_API_KEY loaded from secrets.env"
fi

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  -e HOME=/home/node \
  -e TERM=xterm-256color \
  -e OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN" \
  ${ANTHROPIC_API_KEY_FLAG:+"${ANTHROPIC_API_KEY_FLAG[@]}"} \
  -v "${CONFIG_DIR}:/home/node/.openclaw" \
  -v "${XURL_DIR}:/home/node/.xurl" \
  -p "${HOST_GATEWAY_PORT}:${HOST_GATEWAY_PORT}" \
  -p "${HOST_ACP_PORT}:${HOST_ACP_PORT}" \
  "$IMAGE" \
  sh -c "$START_CMD"

# ─── Wait for gateway ─────────────────────────────────────────────────────────
echo "==> Waiting for gateway to start..."
for i in $(seq 1 15); do
  if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "\[gateway\] listening"; then
    echo "==> Gateway is up."
    break
  fi
  if [[ "$i" -eq 15 ]]; then
    echo "WARNING: Gateway did not report 'listening' within 15s — check logs below."
  fi
  sleep 1
done

# ─── Install system dependencies ──────────────────────────────────────────────
echo "==> Installing system dependencies (chromium, python3-pip)"
docker exec -u root "$CONTAINER_NAME" bash -c '
  apt-get update -qq
  # Chromium for OpenClaw browser tool
  if ! command -v chromium >/dev/null 2>&1; then
    echo "  chromium not found — installing via apt..."
    apt-get install -y -q chromium && echo "  ✓ chromium installed"
  else
    echo "  ✓ chromium already present"
  fi
  # jq for shell scripts (fact-checker etc.)
  if ! command -v jq >/dev/null 2>&1; then
    echo "  jq not found — installing via apt..."
    apt-get install -y -q jq && echo "  ✓ jq installed"
  else
    echo "  ✓ jq already present"
  fi
  # pip for Python skill scripts
  if ! python3 -m pip --version >/dev/null 2>&1; then
    echo "  pip not found — installing via apt..."
    apt-get install -y -q python3-pip
  fi
'

# ─── Install Python dependencies ─────────────────────────────────────────────
echo "==> Installing Python dependencies (numpy, pandas, openai, anthropic)"
docker exec -u root "$CONTAINER_NAME" bash -c '
  # --break-system-packages required on Debian 12 (PEP 668) inside Docker
  python3 -m pip install --quiet --no-cache-dir --break-system-packages numpy pandas openai anthropic \
    && echo "  ✓ numpy + pandas + openai + anthropic installed"
'

# ─── Write ACP server wrapper ─────────────────────────────────────────────────
echo "==> Writing ACP server wrapper: /tmp/acp-server.sh"
docker exec "$CONTAINER_NAME" bash -c "cat > /tmp/acp-server.sh << 'EOF'
#!/bin/bash
exec node /app/openclaw.mjs acp --url ws://127.0.0.1:18789 --token ${GATEWAY_TOKEN}
EOF
chmod +x /tmp/acp-server.sh"

# ─── Install cron + start daemon (for session compaction) ─────────────────────
echo "==> Installing cron daemon for session compaction"
docker exec -u root "$CONTAINER_NAME" bash -c '
  if ! command -v cron >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -q cron && echo "  ✓ cron installed"
  else
    echo "  ✓ cron already present"
  fi
  service cron start 2>/dev/null || true
  echo "  ✓ cron daemon started"
'

# ─── Create isolated subagents (idempotent) ───────────────────────────────────
echo "==> Creating isolated subagents (fact-checker, btc-trader)"
docker exec "$CONTAINER_NAME" bash -c '
  # fact-checker agent
  if openclaw agents list 2>/dev/null | grep -q "fact-checker"; then
    echo "  ✓ fact-checker agent already exists"
  else
    openclaw agents add fact-checker \
      --workspace /home/node/.openclaw/workspace/fact-checker-agent \
      --model anthropic/claude-haiku-4-5 \
      --non-interactive 2>&1 | grep -v "clawdbot:"
    echo "  ✓ fact-checker agent created"
  fi
  # btc-trader agent
  if openclaw agents list 2>/dev/null | grep -q "btc-trader"; then
    echo "  ✓ btc-trader agent already exists"
  else
    openclaw agents add btc-trader \
      --workspace /home/node/.openclaw/workspace/btc-trader-agent \
      --model anthropic/claude-haiku-4-5 \
      --non-interactive 2>&1 | grep -v "clawdbot:"
    echo "  ✓ btc-trader agent created"
  fi
  # Create memory dirs
  mkdir -p /home/node/.openclaw/workspace/fact-checker-agent/memory
  mkdir -p /home/node/.openclaw/workspace/btc-trader-agent/memory
  echo "  ✓ memory dirs ready"
'

# ─── Ensure dispatch skill is in global skills dir ────────────────────────────
echo "==> Ensuring dispatch skill is in global skills dir"
docker exec "$CONTAINER_NAME" bash -c '
  mkdir -p /home/node/.openclaw/skills/dispatch
  if [[ -f /home/node/.openclaw/workspace/skills/dispatch/SKILL.md ]]; then
    cp /home/node/.openclaw/workspace/skills/dispatch/SKILL.md /home/node/.openclaw/skills/dispatch/SKILL.md
    echo "  ✓ dispatch SKILL.md copied to global skills"
  else
    echo "  ⚠ dispatch SKILL.md not found in workspace skills"
  fi
'

# ─── Register session compaction crontab ──────────────────────────────────────
echo "==> Registering session compaction crontab (every 30 min)"
docker exec -u root "$CONTAINER_NAME" bash -c "
  (crontab -u node -l 2>/dev/null || echo '') | grep -v 'compact.py' > /tmp/existing_cron.txt
  echo '*/30 * * * * python3 /home/node/.openclaw/skills/compact-sessions/scripts/compact.py >> /tmp/compact_sessions.log 2>&1' >> /tmp/existing_cron.txt
  crontab -u node /tmp/existing_cron.txt
  echo '  ✓ compact-sessions crontab registered'
"

# ─── Install host-side token-refresh crontab (every 30min) ───────────────────
echo "==> Installing Anthropic token-refresh crontab (host, every 30min)"
REFRESH_SCRIPT="$(cd "$(dirname "$0")" && pwd)/refresh-anthropic-token.sh"
chmod +x "$REFRESH_SCRIPT"
mkdir -p /Users/kinsha/.openclaw/logs
CRON_LINE="*/30 * * * * $REFRESH_SCRIPT >> /Users/kinsha/.openclaw/logs/token-refresh-cron.log 2>&1"
if ! crontab -l 2>/dev/null | grep -qF "refresh-anthropic-token"; then
  (crontab -l 2>/dev/null; echo "$CRON_LINE") | crontab -
  echo "  ✓ crontab installed"
else
  echo "  ✓ crontab already present"
fi
echo "==> Running initial token refresh"
bash "$REFRESH_SCRIPT" && echo "  ✓ Token injected" || echo "  ⚠ Token refresh failed (check keychain)"

# ─── Remove stale lock files ──────────────────────────────────────────────────
LOCK_COUNT=$(docker exec "$CONTAINER_NAME" bash -c \
  'ls /home/node/.openclaw/agents/main/sessions/*.lock 2>/dev/null | wc -l' || echo 0)
if [[ "$LOCK_COUNT" -gt 0 ]]; then
  echo "==> Removing $LOCK_COUNT stale session lock file(s)"
  docker exec "$CONTAINER_NAME" bash -c \
    'rm -f /home/node/.openclaw/agents/main/sessions/*.lock'
fi

# ─── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "✓ $CONTAINER_NAME is running ($(docker inspect --format '{{.Config.Image}}' "$CONTAINER_NAME"))"
echo ""
echo "  Gateway WebSocket : ws://127.0.0.1:${HOST_GATEWAY_PORT}"
echo "  ACP bridge        : port ${HOST_ACP_PORT}"
echo "  Config dir        : ${CONFIG_DIR}"
echo "  Gateway token     : ${GATEWAY_TOKEN}"
echo ""
echo "  Logs     : docker logs -f $CONTAINER_NAME"
echo "  Exec in  : docker exec -it $CONTAINER_NAME bash"
echo "  ACP test : docker exec -i $CONTAINER_NAME bash -c \\"
echo "    '(sleep 4; printf \"ping\n\"; sleep 20) | node /app/openclaw.mjs acp client --server /tmp/acp-server.sh 2>&1'"
echo ""

if [[ "$FOLLOW_LOGS" == true ]]; then
  echo "==> Tailing logs (Ctrl+C to stop)..."
  docker logs -f "$CONTAINER_NAME"
fi
