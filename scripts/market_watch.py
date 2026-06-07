"""
market_watch.py — Tier-1 deterministic change detector for the autonomous market monitor.

Runs frequently (every ~30 min in market hours, via Task Scheduler). Snapshots the
SignalForge state + key live levels, DIFFS against the previous run, and decides whether
anything MATERIAL changed. The expensive Tier-2 Opus narrator (wired separately) only runs
when this says material==true — so Opus fires on real events, not on a fixed clock.

Signals watched (all free data; same feeds SignalForge already uses):
  - Macro regime flip                         (quantlab.macro_regimes)
  - Recession-probability band shift          (quantlab.cycle_position_snapshots)
  - Sell-off state change                     (selloff_monitor: S&P/Nasdaq/semis)
  - Stabilization / escalation verdict change (selloff_monitor, when in an active sell-off)
  - VIX band move                             (^VIX)
  - 10Y yield band move                       (^TNX)
  - A top-10 FTEC holding crossing a notable daily-move band (NVDA/AAPL/MSFT/AVGO/...)
  - A NEW data-quarantine row                 (quantlab.health_quarantine, if the table exists)

Materiality gating = "alert on TRANSITION, not persistence": every signal is bucketed into a
discrete state and a change fires only when the bucket changes (categorical) or worsens
(ordinal). A standing condition (VIX sitting at 22 for hours) therefore does NOT re-alert every
cycle. First run, or first cycle of a new day for the daily-move signals, just establishes a
baseline and stays silent.

Outputs:
  - reports/market_watch_state.json   (prior buckets; internal, gitignored)
  - reports/market_watch_latest.json  ({material, changes[], state, headline, ts}) — the Tier-2
                                        narrator reads this and pushes a plain-language alert when material.
  - stdout one-line verdict (captured in the scheduler log).

INFORMATIONAL / decision-support only (ADR-056). NOT trade signals, NOT investment advice.
Thresholds are tunable + documented inline; start permissive, ratchet on review.
"""
from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))  # allow sibling imports when run as a script
REPORTS = REPO / "reports"
STATE_FILE = REPORTS / "market_watch_state.json"
LATEST_FILE = REPORTS / "market_watch_latest.json"

# Top FTEC names worth an individual move-alert (the load-bearing weights).
WATCH_HOLDINGS = ["NVDA", "AAPL", "MSFT", "AVGO", "AMD", "MU"]
NOTABLE_MOVE_PCT = 4.0  # |daily move| at/above this is "notable" and eligible to alert


# ── band helpers (ordinal buckets; lower index = calmer) ──────────────────────
def _band_recession(p):
    if p is None:
        return None
    for hi, name in [(10, "low"), (20, "moderate"), (35, "elevated"), (50, "high")]:
        if p < hi:
            return name
    return "recession-likely"


def _band_vix(v):
    if v is None:
        return None
    for hi, name in [(15, "calm"), (20, "normal"), (25, "elevated"), (30, "stressed")]:
        if v < hi:
            return name
    return "fear"


def _band_10y(y):
    """0.1%-wide buckets — a 10bp move in the 10Y is material; sub-10bp jitter is not."""
    return f"{round(float(y) * 10) / 10:.1f}%" if y is not None else None


def _band_move(pct):
    """Daily %-move bucket for a single name. Notable = |move| >= NOTABLE_MOVE_PCT."""
    if pct is None:
        return None
    if pct <= -6:
        return "crash"
    if pct <= -NOTABLE_MOVE_PCT:
        return "sharp-down"
    if pct < NOTABLE_MOVE_PCT:
        return "normal"            # -4%..+4% — not individually alert-worthy
    if pct < 6:
        return "sharp-up"
    return "surge"


_SELLOFF_RANK = {"normal": 0, "pullback": 1, "ACTIVE SELL-OFF": 2}


def _f(x):
    """Coerce numpy/None to a JSON-safe float (rounded) or None."""
    try:
        return None if x is None else round(float(x), 2)
    except Exception:
        return None


def snapshot() -> dict:
    """Compute the current discrete state. Best-effort per source; never raises."""
    import selloff_monitor as sm
    state: dict = {"date": _dt.date.today().isoformat()}

    # Sell-off / VIX / 10Y all come from one yfinance pull.
    try:
        d = sm._pull()
        states, active = sm._states(d)
        if states:
            worst = max(states, key=lambda s: _SELLOFF_RANK.get(s[3], 0))
            state["selloff"] = worst[3]
            state["selloff_active"] = active
        if active:
            _, ss, sn = sm._stabilization(d)
            _, es = sm._escalation(d)
            state["stabilization"] = sm._STAB_SHORT.get(sm._stab_verdict(ss, sn, active))
            state["escalation"] = sm._ESC_SHORT.get(sm._esc_verdict(es))
        vix = d.get("^VIX")
        if vix and len(vix["close"]):
            state["vix"] = _f(vix["close"][-1])
            state["vix_band"] = _band_vix(state["vix"])
        tnx = d.get("^TNX")
        if tnx and len(tnx["close"]):
            state["t10y"] = _f(tnx["close"][-1])
            state["t10y_band"] = _band_10y(state["t10y"])
    except Exception as e:
        state["_selloff_err"] = f"{type(e).__name__}: {str(e)[:60]}"

    # SignalForge composites from ClickHouse (best-effort).
    try:
        from ftec_daily_brief import _ch
        regime = _ch("SELECT regime FROM macro_regimes ORDER BY trade_date DESC LIMIT 1")
        if regime:
            state["regime"] = regime
        rec = _ch("SELECT round(recession_prob_pct,1) FROM cycle_position_snapshots ORDER BY snapshot_date DESC LIMIT 1")
        if rec not in (None, "", "\\N"):
            try:
                state["recession_pct"] = float(rec)
                state["recession_band"] = _band_recession(float(rec))
            except ValueError:
                pass
        # Quarantine table is Phase-2 / may not exist yet — guard.
        q = _ch("SELECT count() FROM quantlab.health_quarantine WHERE status='pending'")
        if q not in (None, "") and q.isdigit():
            state["quarantine"] = int(q)
    except Exception as e:
        state["_ch_err"] = f"{type(e).__name__}: {str(e)[:60]}"

    # Top-holding daily moves (light 5d pull).
    try:
        import yfinance as yf
        df = yf.download(WATCH_HOLDINGS, period="5d", auto_adjust=True, progress=False, threads=True)["Close"]
        hb = {}
        for t in WATCH_HOLDINGS:
            try:
                s = df[t].dropna()
                mv = (float(s.iloc[-1]) / float(s.iloc[-2]) - 1) * 100
                hb[t] = {"move": _f(mv), "band": _band_move(mv)}
            except Exception:
                pass
        if hb:
            state["holdings"] = hb
    except Exception as e:
        state["_holdings_err"] = f"{type(e).__name__}: {str(e)[:60]}"

    return state


def _load_prior() -> dict | None:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def diff(prior: dict | None, cur: dict) -> list[dict]:
    """Return the list of MATERIAL changes (alert on transition, not persistence)."""
    if not prior:
        return []  # first run — establish baseline, stay silent
    changes: list[dict] = []
    same_day = prior.get("date") == cur.get("date")

    def chg(key, label, sev, frm, to):
        changes.append({"key": key, "label": label, "severity": sev, "from": frm, "to": to})

    # Regime flip (categorical; cross-day comparison is intended).
    if "regime" in cur and prior.get("regime") not in (None, cur["regime"]):
        chg("regime", f"Macro regime: {prior['regime']} → {cur['regime']}", "alert", prior.get("regime"), cur["regime"])

    # Recession-probability band shift (worsening = alert, easing = info).
    if "recession_band" in cur and prior.get("recession_band") not in (None, cur["recession_band"]):
        order = ["low", "moderate", "elevated", "high", "recession-likely"]
        worse = order.index(cur["recession_band"]) > order.index(prior["recession_band"]) if prior.get("recession_band") in order else True
        chg("recession", f"Recession risk: {prior['recession_band']} → {cur['recession_band']} ({cur.get('recession_pct')}%)",
            "alert" if worse else "info", prior.get("recession_band"), cur["recession_band"])

    # Sell-off state change (to ACTIVE = alert; easing = info).
    if "selloff" in cur and prior.get("selloff") not in (None, cur["selloff"]):
        worse = _SELLOFF_RANK.get(cur["selloff"], 0) > _SELLOFF_RANK.get(prior.get("selloff"), 0)
        chg("selloff", f"Sell-off state: {prior['selloff']} → {cur['selloff']}", "alert" if worse else "info",
            prior.get("selloff"), cur["selloff"])

    # Stabilization / escalation verdict change (only meaningful while active).
    for k, lbl in [("stabilization", "Stabilization"), ("escalation", "Escalation lean")]:
        if k in cur and prior.get(k) not in (None, cur[k]):
            chg(k, f"{lbl}: {prior.get(k)} → {cur[k]}", "warn", prior.get(k), cur[k])

    # VIX band move (up = warn/alert, down = info).
    if "vix_band" in cur and prior.get("vix_band") not in (None, cur["vix_band"]):
        order = ["calm", "normal", "elevated", "stressed", "fear"]
        worse = order.index(cur["vix_band"]) > order.index(prior["vix_band"]) if prior.get("vix_band") in order else True
        chg("vix", f"VIX: {prior['vix_band']} → {cur['vix_band']} ({cur.get('vix')})",
            "alert" if (worse and cur["vix_band"] in ("stressed", "fear")) else ("warn" if worse else "info"),
            prior.get("vix_band"), cur["vix_band"])

    # 10Y yield band move (the sell-off's root cause — any 0.1% step is worth noting).
    if "t10y_band" in cur and prior.get("t10y_band") not in (None, cur["t10y_band"]):
        chg("t10y", f"10Y yield: {prior['t10y_band']} → {cur['t10y_band']}", "warn", prior.get("t10y_band"), cur["t10y_band"])

    # Top-holding crossing into a notable move band. Suppressed on the first cycle of a new
    # day (daily-move resets at the open; the daily brief covers the open). Re-alert only on
    # worsening within the notable bands.
    if same_day and "holdings" in cur:
        rank = {"crash": 0, "sharp-down": 1, "normal": 2, "sharp-up": 3, "surge": 4}
        ph = prior.get("holdings", {})
        for t, hv in cur["holdings"].items():
            cb = hv.get("band")
            pb = ph.get(t, {}).get("band")
            if cb in ("crash", "sharp-down", "sharp-up", "surge") and cb != pb:
                # worsening to the downside, or first crossing into any notable band
                down = cb in ("crash", "sharp-down")
                chg(f"hold:{t}", f"{t} {hv.get('move'):+.1f}% ({cb})", "alert" if cb == "crash" else "warn", pb, cb)

    # New data-quarantine row (a Tier-2 correctness flag appeared).
    if "quarantine" in cur and prior.get("quarantine") is not None and cur["quarantine"] > prior["quarantine"]:
        chg("quarantine", f"NEW data-quarantine item(s): {prior['quarantine']} → {cur['quarantine']}", "alert",
            prior.get("quarantine"), cur["quarantine"])

    return changes


def _headline(state: dict, changes: list[dict]) -> str:
    if not changes:
        so = state.get("selloff", "n/a")
        return f"No material change · regime {state.get('regime','?')} · sell-off {so} · VIX {state.get('vix','?')}"
    order = {"alert": 0, "warn": 1, "info": 2}
    top = sorted(changes, key=lambda c: order.get(c["severity"], 9))
    return " | ".join(c["label"] for c in top[:4])


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    REPORTS.mkdir(exist_ok=True)
    prior = _load_prior()
    cur = snapshot()
    changes = diff(prior, cur)
    material = len(changes) > 0
    out = {
        "ts": _dt.datetime.now().isoformat(timespec="seconds"),
        "material": material,
        "first_run": prior is None,
        "changes": changes,
        "headline": _headline(cur, changes),
        "state": cur,
    }
    LATEST_FILE.write_text(json.dumps(out, indent=2), encoding="utf-8")
    STATE_FILE.write_text(json.dumps(cur, indent=2), encoding="utf-8")  # becomes next run's prior
    tag = "MATERIAL" if material else ("BASELINE" if prior is None else "quiet")
    print(f"[market-watch] {tag}: {out['headline']}")
    if material:
        for c in sorted(changes, key=lambda c: c["severity"]):
            print(f"  - [{c['severity']}] {c['label']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
