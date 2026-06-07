"""
selloff_monitor.py — Sell-Off & Stabilization Monitor + Escalation-Risk Read (v1).

Implements docs/specs/selloff-stabilization-monitor.md + selloff-escalation-risk-read.md.
INFORMATIONAL ONLY — never a trade-decision input, never a bottom/escalation forecast.
Stabilization signals CONFIRM a turn already underway; the escalation read is a probability
LEAN from current evidence, credit-weighted. "Mixed/unclear" is a valid, honest output.

Reads free daily data via yfinance (indices, semis epicenter, VIX term structure, 10Y,
HY vs IG credit, safe havens, defensives) — the same feed families SignalForge already uses.
Writes reports/selloff_monitor_<date>.md + prints. Wired into scripts/daily_refresh.ps1.
Per the spec it does NOT push urgent alerts (surfaced for review on the operator's schedule).

The scoring lives in pure helpers (_states / _stabilization / _escalation) that BOTH the full
markdown report (build_report) and the few-line compact_summary share, so the two renderings
can never drift. compact_summary() is embedded in the daily FTEC Telegram brief
(scripts/ftec_daily_brief.py) so the read reaches the operator on their existing schedule.

v1 thresholds are tunable + documented inline. No validated-signal claim (ADR-056).
"""
from __future__ import annotations
import datetime as _dt
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TICKERS = ["^GSPC", "^IXIC", "SOXX", "^VIX", "^VIX3M", "^TNX",
           "HYG", "LQD", "TLT", "GLD", "XLV", "XLP"]


def _pull():
    """Batch-download ~3 months daily; return {ticker: {close[], high[], low[]}}."""
    import yfinance as yf
    df = yf.download(TICKERS, period="3mo", auto_adjust=True, progress=False, threads=True)
    out = {}
    for t in TICKERS:
        try:
            out[t] = {
                "close": df["Close"][t].dropna().values,
                "high": df["High"][t].dropna().values,
                "low": df["Low"][t].dropna().values,
            }
        except Exception:
            out[t] = None
    return out


def _ret(c, n=1):
    return (c[-1] / c[-1 - n] - 1) * 100 if len(c) > n else None


def _drawdown(c, win=20):
    if len(c) < win:
        win = len(c)
    return (c[-1] / max(c[-win:]) - 1) * 100


def _state(name, c):
    """Phase 1 — normal / pullback / active sell-off (spec thresholds, tunable)."""
    day = _ret(c, 1)
    dd = _drawdown(c, 20)
    if day is None:
        return name, None, None, "n/a"
    if day < -2.5 or dd < -8:
        s = "ACTIVE SELL-OFF"
    elif day <= -1 or dd <= -5:
        s = "pullback"
    else:
        s = "normal"
    return name, day, dd, s


def _close_strength(t):
    """(close-low)/(high-low) of the latest day — high = closed off the lows (buyers stepped in)."""
    if not t or len(t["close"]) == 0:
        return None
    h, l, c = t["high"][-1], t["low"][-1], t["close"][-1]
    return (c - l) / (h - l) if h > l else None


# ── Shared scoring (pure; consumed by both build_report + compact_summary) ────

def _states(d: dict):
    """Per-index sell-off state. Returns (states, active) where states = [(name, day, dd, s)]."""
    states = []
    for nm, tk in [("S&P 500", "^GSPC"), ("Nasdaq", "^IXIC"), ("Semis (SOXX, epicenter)", "SOXX")]:
        t = d.get(tk)
        if t:
            states.append(_state(nm, t["close"]))
    active = any("ACTIVE" in s[3] for s in states)
    return states, active


def _stabilization(d: dict):
    """4 stabilization signals. Returns (lines, score, n). +1 stabilizing / -1 deteriorating / 0 neutral."""
    lines, stab = [], []

    # 1. 10Y yield settling (highest priority). ^TNX returns the yield directly (e.g. 4.54).
    tnx = d.get("^TNX")
    if tnx and len(tnx["close"]) >= 4:
        y = tnx["close"]
        rising = y[-1] >= max(y[-4:-1])   # new 3-day high = still rising
        easing = y[-1] <= y[-2] <= y[-3]  # flat/down 2 sessions
        st = "stabilizing" if easing else ("deteriorating" if rising else "neutral")
        stab.append(1 if easing else (-1 if rising else 0))
        lines.append(f"1. **10Y yield (top priority):** {y[-1]:.2f}% — {st} "
                     f"({'settling/easing' if easing else 'making new highs' if rising else 'choppy'})")

    # 2. VIX peak-and-roll-over + term structure.
    vix, vix3 = d.get("^VIX"), d.get("^VIX3M")
    if vix and len(vix["close"]) >= 3:
        v = vix["close"]
        peak10 = max(v[-10:]) if len(v) >= 10 else max(v)
        rolled = v[-1] < peak10 * 0.97 and v[-1] <= v[-2]  # off the peak + declining
        term = (v[-1] / vix3["close"][-1]) if (vix3 and vix3["close"][-1]) else None
        backwardation = term is not None and term > 1.0
        st = "stabilizing" if (rolled and not backwardation) else ("deteriorating" if backwardation or v[-1] >= peak10 else "neutral")
        stab.append(1 if (rolled and not backwardation) else (-1 if (backwardation or v[-1] >= peak10) else 0))
        tterm = f", term {term:.2f} ({'backwardation=stress' if backwardation else 'contango=calmer'})" if term else ""
        lines.append(f"2. **VIX:** {v[-1]:.1f} (10d peak {peak10:.1f}) — {st} "
                     f"({'rolled over' if rolled else 'at/near highs'}{tterm})")

    # 3. Epicenter (semis) stops making new lows.
    sox = d.get("SOXX")
    if sox and len(sox["close"]) >= 6:
        c = sox["close"]
        new_low = c[-1] <= min(c[-6:-1])  # fresh 5-day low
        st = "deteriorating" if new_low else "stabilizing"
        stab.append(-1 if new_low else 1)
        lines.append(f"3. **Epicenter (semis) lows:** {st} ({'making fresh 5-day lows' if new_low else 'holding above recent lows'})")

    # 4. Down-day deceleration + close strength.
    sp = d.get("^GSPC")
    if sp and len(sp["close"]) >= 4:
        c = sp["close"]
        rets = [(c[-i] / c[-i - 1] - 1) * 100 for i in (1, 2, 3)]  # last 3 daily returns (most recent first)
        decel = abs(rets[0]) < abs(rets[1]) if rets[1] != 0 else False
        cs = _close_strength(sp)
        strong_close = cs is not None and cs > 0.6
        st = "stabilizing" if (decel or strong_close) else ("deteriorating" if cs is not None and cs < 0.25 else "neutral")
        stab.append(1 if (decel or strong_close) else (-1 if (cs is not None and cs < 0.25) else 0))
        lines.append(f"4. **Down-days/close:** {st} (last 3 days {rets[0]:+.1f}/{rets[1]:+.1f}/{rets[2]:+.1f}%, "
                     f"close strength {cs:.2f}{' = closed off lows' if strong_close else ' = closed near lows' if (cs is not None and cs<0.25) else ''})")

    return lines, sum(stab), len(stab)


def _stab_verdict(score: int, n: int, active: bool) -> str:
    """Composite stabilization read (dead-cat guard: require multi-signal alignment)."""
    if active:
        if score >= max(2, n - 1):
            return "CONDITIONS CALMING — confirmation, NOT a bottom call"
        elif score <= -2:
            return "STILL DETERIORATING — selling not yet calmed"
        return "MIXED — no multi-signal stabilization confirmed yet"
    return "not in an active sell-off — stabilization read N/A"


def _escalation(d: dict):
    """4 escalation factors (credit double-weighted). Returns (lines, score). +contained / -escalating."""
    lines, lean = [], []

    # 1. Credit (MOST weighted): HY vs IG 5-day.
    hyg, lqd = d.get("HYG"), d.get("LQD")
    if hyg and lqd:
        h5, l5 = _ret(hyg["close"], 5), _ret(lqd["close"], 5)
        if h5 is not None and l5 is not None:
            spread = h5 - l5  # HY underperforming IG = widening credit stress
            esc = spread < -1.0
            lean += [(-2 if esc else 2)]  # double weight
            lines.append(f"1. **Credit (HY vs IG, most-weighted):** {'ESCALATING' if esc else 'contained'} "
                         f"(HYG 5d {h5:+.1f}% vs LQD {l5:+.1f}%; {'HY stress widening' if esc else 'credit calm — stress staying in equities'})")

    # 2. Breadth of decline: rotation (defensives up vs tech down) vs broad.
    xlv, ixic = d.get("XLV"), d.get("^IXIC")
    if xlv and ixic:
        v5, t5 = _ret(xlv["close"], 5), _ret(ixic["close"], 5)
        if v5 is not None and t5 is not None:
            rotation = v5 > -1.0 and t5 < -2.0  # defensives holding while tech falls
            broad = v5 < -2.0 and t5 < -2.0     # everything down together
            lean += [(-1 if broad else 1)]
            lines.append(f"2. **Breadth of decline:** {'ESCALATING (broad)' if broad else 'contained (rotation)' if rotation else 'mixed'} "
                         f"(defensives XLV 5d {v5:+.1f}% vs Nasdaq {t5:+.1f}%)")

    # 3. Safe havens working?
    tlt, gld = d.get("TLT"), d.get("GLD")
    if tlt and gld:
        bt, bg = _ret(tlt["close"], 5), _ret(gld["close"], 5)
        if bt is not None and bg is not None:
            working = bt > 0 or bg > 0  # at least one catching a bid
            lean += [(1 if working else -1)]
            lines.append(f"3. **Safe havens:** {'working (orderly)' if working else 'NOT working (forced-liquidation risk)'} "
                         f"(TLT 5d {bt:+.1f}%, GLD {bg:+.1f}%)")

    # 4. Close pattern (forced selling into the close?).
    cs_sp = _close_strength(d.get("^GSPC"))
    if cs_sp is not None:
        forced = cs_sp < 0.25
        lean += [(-1 if forced else 1)]
        lines.append(f"4. **Close pattern:** {'ESCALATING (closing near lows = forced selling)' if forced else 'contained (intraday recovery / closed off lows)'} "
                     f"(S&P close strength {cs_sp:.2f})")

    return lines, sum(lean)


def _esc_verdict(score: int) -> str:
    if score >= 2:
        return "LEANS CONTAINED (rotation / temporary on current evidence)"
    elif score <= -2:
        return "SHOWS ESCALATION CHARACTERISTICS (credit/breadth/havens deteriorating)"
    return "MIXED — evidence does not clearly lean either way (an honest, valid output)"


def build_report(d: dict) -> str:
    """Full markdown report (reports/selloff_monitor_<date>.md)."""
    L = []
    today = _dt.date.today().isoformat()
    L.append(f"# Sell-Off & Stabilization Monitor — {today}")
    L.append("")
    L.append("_Informational only — NOT a trade signal, NOT a bottom/escalation forecast. Stabilization "
             "signals CONFIRM a turn already underway; the escalation read is a probability lean from "
             "current evidence. (ADR-056.)_")
    L.append("")

    # ── Phase 1: state ──────────────────────────────────────────────────────
    L.append("## State")
    states, active = _states(d)
    for (nm, day, dd, s) in states:
        L.append(f"- **{nm}:** {s} — today {day:+.1f}%, {dd:+.1f}% from 20d high")
    L.append("")

    # ── Phase 2: stabilization signals ──────────────────────────────────────
    L.append("## Stabilization signals (confirmation a turn is underway, not a forecast)")
    stab_lines, score, n = _stabilization(d)
    L.extend(stab_lines)
    comp = _stab_verdict(score, n, active)
    L.append("")
    L.append(f"**Stabilization composite:** {comp}  _(net {score:+d} across {n} signals; a lone green day is down-weighted)_")
    L.append("")

    # ── Escalation-risk read (credit-weighted lean) ──────────────────────────
    L.append("## Escalation-risk read (contained vs escalating — a lean, never a forecast)")
    esc_lines, lscore = _escalation(d)
    L.extend(esc_lines)
    L.append("")
    L.append("5. **Cause type:** qualitative — see the AI-narrative briefing (discrete-and-digested = contained; "
             "open-ended/developing = escalation). Not computed here.")
    verdict = _esc_verdict(lscore)
    L.append("")
    L.append(f"**Escalation lean:** {verdict}  _(credit is double-weighted; net {lscore:+d})_")
    L.append("")
    L.append("Informational decision-support only — not investment advice, not a validated signal, not a "
             "predictor. Stabilization confirms a turn already underway; escalation is a lean from current "
             "evidence (credit-weighted). When mixed, it says so.")
    return "\n".join(L)


# Compact verdict phrasings for the few-line embed (the full report keeps the long form).
_STAB_SHORT = {"CONDITIONS CALMING — confirmation, NOT a bottom call": "CALMING (confirmation, not a bottom call)",
               "STILL DETERIORATING — selling not yet calmed": "STILL DETERIORATING",
               "MIXED — no multi-signal stabilization confirmed yet": "MIXED (no confirmation yet)",
               "not in an active sell-off — stabilization read N/A": "n/a (no active sell-off)"}
_ESC_SHORT = {"LEANS CONTAINED (rotation / temporary on current evidence)": "LEANS CONTAINED (rotation/temporary)",
              "SHOWS ESCALATION CHARACTERISTICS (credit/breadth/havens deteriorating)": "ESCALATION CHARACTERISTICS",
              "MIXED — evidence does not clearly lean either way (an honest, valid output)": "MIXED"}


def compact_summary(d: dict) -> str:
    """A few-line read for embedding in the daily Telegram brief (ftec_daily_brief.py).

    Same scoring as build_report — only the rendering is condensed. Returns "" if the
    data is unavailable so the caller can skip the section cleanly. When there is no
    active sell-off, collapses to a single calm line (no noise on normal days).
    """
    states, active = _states(d)
    if not states:
        return ""
    st = " · ".join(f"{nm.split(' (')[0]} {s}" for (nm, day, dd, s) in states)
    head = "## Sell-off & stabilization monitor"
    if not active:
        return f"{head}\n- **State:** {st} → no active sell-off; monitor idle."

    _, score, n = _stabilization(d)
    _, lscore = _escalation(d)
    stab_v = _STAB_SHORT.get(_stab_verdict(score, n, active), _stab_verdict(score, n, active))
    esc_v = _ESC_SHORT.get(_esc_verdict(lscore), _esc_verdict(lscore))

    extra = []
    tnx, vix = d.get("^TNX"), d.get("^VIX")
    if tnx and len(tnx["close"]):
        extra.append(f"10Y {tnx['close'][-1]:.2f}%")
    if vix and len(vix["close"]):
        extra.append(f"VIX {vix['close'][-1]:.1f}")

    lines = [head,
             f"- **State:** {st}",
             f"- **Stabilization:** {stab_v} (net {score:+d}/{n})",
             f"- **Escalation lean:** {esc_v} (net {lscore:+d}, credit-weighted)"]
    if extra:
        lines.append(f"- **Levels:** {' · '.join(extra)}")
    lines.append("_Confirmation, not a forecast — full read in reports/selloff_monitor_<date>.md._")
    return "\n".join(lines)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    d = _pull()
    report = build_report(d)
    out_dir = REPO / "reports"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"selloff_monitor_{_dt.date.today():%Y%m%d}.md"
    out.write_text(report, encoding="utf-8")
    print(report)
    print(f"\n[selloff-monitor] wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
