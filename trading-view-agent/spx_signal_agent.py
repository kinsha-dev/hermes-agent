#!/usr/bin/env python3
"""
SPX Signal Agent — Config Helper
=================================
This file stores configuration for the scheduled TradingView signal agent.
The agent itself runs via Claude in Chrome (browser-based, no network restriction).

Edit agent_config.json directly or run: python3 spx_signal_agent.py --setup
"""

import json
import argparse
import urllib.request
import urllib.parse
from pathlib import Path

CONFIG_FILE = Path(__file__).parent / "agent_config.json"

DEFAULT_CONFIG = {
    "phone_number": "+917736492801",
    "callmebot_api_key": "",          # Get free key: see --setup instructions
    "signal_threshold": 60,           # Min score (0-100) to send alert
    "angle_threshold": 30,            # Min EMA slope degrees
    "chart_url": "https://www.tradingview.com/chart/vWJrWPZ1/?symbol=SP%3ASPX",
    "timeframe": "30m",
    "trading_hours_only": True,
    "cooldown_minutes": 45,
    "last_signal": {"direction": None, "timestamp": None}
}


def load_config():
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE) as f:
            cfg = json.load(f)
        for k, v in DEFAULT_CONFIG.items():
            if k not in cfg:
                cfg[k] = v
        return cfg
    return DEFAULT_CONFIG.copy()


def save_config(cfg):
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)
    print(f"✅ Config saved → {CONFIG_FILE}")


def test_callmebot(cfg):
    """Send a test WhatsApp via CallMeBot API."""
    api_key = cfg.get("callmebot_api_key", "")
    phone   = cfg.get("phone_number", "")
    if not api_key:
        print("❌ No CallMeBot API key set. Run --setup first.")
        return False
    msg = "✅ SPX Signal Agent test message — alerts are working!"
    encoded = urllib.parse.quote(msg)
    url = f"https://api.callmebot.com/whatsapp.php?phone={phone}&text={encoded}&apikey={api_key}"
    print(f"📲 Sending test to {phone}...")
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            body = r.read().decode()
            print(f"Response: {body[:120]}")
            return True
    except Exception as e:
        print(f"Error: {e}")
        return False


def setup_wizard():
    print("\n" + "="*56)
    print("  SPX Signal Agent — CallMeBot Setup")
    print("="*56)
    print("""
📱 CALLMEBOT — Free WhatsApp API (one-time setup, ~1 min):

  Step 1: Save this number in your WhatsApp contacts:
          +34 644 49 00 17   (name: CallMeBot)

  Step 2: Send this exact message to that number on WhatsApp:
          I allow callmebot to send me messages

  Step 3: Wait ~30 sec — they'll reply with your API key.

  Step 4: Paste the API key below.
""")
    api_key = input("Paste your CallMeBot API key here: ").strip()
    cfg = load_config()
    cfg["callmebot_api_key"] = api_key

    if api_key:
        save_config(cfg)
        test = input("Send a test WhatsApp now? [y/N]: ").strip().lower()
        if test == "y":
            test_callmebot(cfg)
    else:
        print("⚠️  No key entered. Edit agent_config.json when you have it.")
        save_config(cfg)

    print("\n🚀 Setup complete! The scheduled agent will run every 15 min.")
    print(f"   Chart: {cfg['chart_url']}")
    print(f"   Phone: {cfg['phone_number']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="SPX Agent Config")
    parser.add_argument("--setup",    action="store_true", help="Run setup wizard")
    parser.add_argument("--test-msg", action="store_true", help="Send test WhatsApp")
    parser.add_argument("--show",     action="store_true", help="Show current config")
    args = parser.parse_args()

    if args.setup:
        setup_wizard()
    elif args.test_msg:
        cfg = load_config()
        test_callmebot(cfg)
    elif args.show:
        cfg = load_config()
        cfg_display = {k: v for k, v in cfg.items() if k != "callmebot_api_key"}
        cfg_display["callmebot_api_key"] = "****" if cfg.get("callmebot_api_key") else "(not set)"
        print(json.dumps(cfg_display, indent=2))
    else:
        parser.print_help()
