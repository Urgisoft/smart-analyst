"""
market_watch_alert.py — Tier-2 alerter for the autonomous market monitor.

Reads reports/market_watch_latest.json (written by market_watch.py). If material==true,
composes a concise plain-language alert and pushes it to Telegram. No-ops quietly otherwise,
so it is safe to run every cycle right after the detector.

Two quality tiers, auto-selected:
  - ALWAYS: a deterministic plain-language alert built from the detector's change list +
    a rule-based "what this means" line per change. Free, reliable, no dependencies.
  - IF AVAILABLE: if the Claude Code CLI is found (PATH, or CLAUDE_CLI in .env), Opus is asked
    to web-search the CAUSE of each change and write the alert. On ANY failure it silently
    falls back to the deterministic text — so the monitor never goes dark waiting on Opus.

Decision-support only (ADR-056). NEVER investment advice, NEVER buy/sell, no price targets.
The Opus prompt is hard-constrained to the same wall; the deterministic text states it too.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
LATEST_FILE = REPO / "reports" / "market_watch_latest.json"

# Rule-based "what this means" — plain language, strictly descriptive (no advice).
_MEANING = {
    "regime": "Macro risk posture is shifting.",
    "recession": "The recession-distance gauge moved.",
    "selloff": "Broad market state changed — wait for confirmation before assuming a turn (don't catch the knife).",
    "stabilization": "Stabilization signals shifted — confirmation of a turn already underway, not a forecast.",
    "escalation": "The contained-vs-escalating lean shifted (credit-weighted).",
    "vix": "The volatility regime moved.",
    "t10y": "The 10Y yield moved — it's the root cause of the current AI/semis sell-off.",
    "quarantine": "A data-quality issue was flagged — check the Health page before trusting affected numbers.",
}


def _meaning_for(changes: list[dict]) -> list[str]:
    out, seen = [], set()
    for c in changes:
        base = c["key"].split(":")[0]
        if base == "hold":
            continue  # holdings get a combined line below
        if base in _MEANING and base not in seen:
            out.append(_MEANING[base]); seen.add(base)
    holds = [c for c in changes if c["key"].startswith("hold:")]
    if holds:
        names = ", ".join(c["key"].split(":", 1)[1] for c in holds)
        out.append(f"Large moves in top FTEC holdings ({names}) — concentration risk is in play.")
    return out


def deterministic_text(payload: dict) -> str:
    changes = payload.get("changes", [])
    L = ["\U0001F4E1 SignalForge market alert", payload.get("ts", "")]
    L.append("")
    order = {"alert": 0, "warn": 1, "info": 2}
    for c in sorted(changes, key=lambda c: order.get(c["severity"], 9)):
        L.append(f"• [{c['severity'].upper()}] {c['label']}")
    means = _meaning_for(changes)
    if means:
        L.append("")
        L.append("What this means:")
        L.extend(f"- {m}" for m in means)
    st = payload.get("state", {})
    L.append("")
    L.append(f"State now: regime {st.get('regime','?')} · sell-off {st.get('selloff','?')} "
             f"· VIX {st.get('vix','?')} · 10Y {st.get('t10y','?')}%")
    L.append("")
    L.append("Decision-support only — not investment advice, not a validated signal.")
    return "\n".join(x for x in L if x is not None)


def _find_claude() -> str | None:
    env_path = None
    envf = REPO / ".env"
    if envf.exists():
        for line in envf.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.strip().startswith("CLAUDE_CLI="):
                env_path = line.split("=", 1)[1].strip().strip('"').strip("'")
    if env_path and Path(env_path).exists():
        return env_path
    return shutil.which("claude")


def opus_text(payload: dict) -> str | None:
    """Ask headless Opus to narrate the CAUSE. Returns None on any failure (caller falls back)."""
    claude = _find_claude()
    if not claude:
        return None
    prompt = (
        "You are SignalForge's market-monitor narrator. A deterministic detector flagged these "
        "MATERIAL changes today.\n\n"
        f"CHANGES: {json.dumps(payload.get('changes', []))}\n"
        f"CURRENT STATE: {json.dumps(payload.get('state', {}))}\n\n"
        "Web-search today's market news to explain the LIKELY CAUSE of each change. Then write a "
        "concise Telegram alert (<=12 short lines, plain language for a non-statistician):\n"
        "1) a one-line headline, 2) what changed + the likely cause, 3) what it means / what to watch.\n\n"
        "STRICT RULES: decision-support only; NEVER recommend buy/sell or position sizing; no price "
        "targets; you are NOT a licensed advisor. If a web search does NOT confirm the cause, say "
        "'cause unconfirmed' — do NOT invent specific figures, dates, or events. End with the exact "
        "line 'Not investment advice.' Output ONLY the alert text, no preamble."
    )
    try:
        # Prompt via STDIN (not argv) avoids Windows quoting/injection with the JSON payload; .cmd
        # shims must run through cmd /c. Verified end-to-end against claude 2.1.168 on Max.
        args = [claude, "-p", "--model", "opus"]
        if os.name == "nt":
            args = ["cmd", "/c"] + args
        # encoding=utf-8 is REQUIRED: Opus output has →/—/etc.; Windows' default cp1252 decode throws.
        r = subprocess.run(args, input=prompt, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=180)
        txt = (r.stdout or "").strip()
        return txt if (r.returncode == 0 and len(txt) > 40) else None
    except Exception:
        return None


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        payload = json.loads(LATEST_FILE.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[market-alert] no payload to read ({e}); nothing to do.")
        return 0
    if not payload.get("material"):
        print("[market-alert] quiet — nothing material, no alert sent.")
        return 0

    enriched = opus_text(payload)
    text = enriched or deterministic_text(payload)
    tier = "opus" if enriched else "deterministic"

    from ftec_daily_brief import _load_env, push_telegram
    env = _load_env()
    result = push_telegram(env, text)
    print(f"[market-alert] MATERIAL ({tier}) — {result}")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
