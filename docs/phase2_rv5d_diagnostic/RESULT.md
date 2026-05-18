# Phase 2 — RV_5d lead-lag pre-registration diagnostic — RESULT

**Run date:** 2026-05-09
**Script:** `scripts/_phase2_rv5d_leadlag_diagnostic.ts`
**Verdict:** **FAIL** — escalate to VVIX per pre-committed order.

## Methodology

`realized_stress = 1 iff sqrt(252) * sample_stdev(SPY_log_return, last 5
sessions) > θ`. K = {20%, 25%, 30%, 35%, 40%} declared and locked
before scoring. Pre-registration criterion (critic-mandated, HANDOFF
session 32): for at least one θ in K, RV_5d leads `vix_term_inverted`
by ≥1 trading session in ≥2 of 3 fast-crash events.

Events:
- Feb-2018 Volmageddon (window 2018-01-15 → 2018-02-28).
- Mar-2020 COVID (window 2020-02-15 → 2020-04-15).
- Aug-2024 yen-carry unwind (window 2024-07-15 → 2024-08-31).

Oct-1987 unavailable (SPY data starts 2008-01-02 in `quantlab.candles`).

## Per-event findings

### Feb-2018 Volmageddon

`vix_term_inverted` first fire: **2018-02-02** (window idx 13).

| θ   | RV_first_date | RV_first_val | lead | verdict          |
|----|---------------|--------------|------|------------------|
| 20% | 2018-02-05    | 28.3%        | −1   | FAIL (vix led)   |
| 25% | 2018-02-05    | 28.3%        | −1   | FAIL (vix led)   |
| 30% | 2018-02-06    | 37.8%        | −2   | FAIL (vix led)   |
| 35% | 2018-02-06    | 37.8%        | −2   | FAIL (vix led)   |
| 40% | 2018-02-08    | 40.5%        | −4   | FAIL (vix led)   |

`vix_term_inverted` fired 1-4 sessions before RV_5d crossed any θ in K.
Term structure inverted as the options market priced near-term vol up
ahead of the realized-vol explosion that followed Feb 5's XIV collapse.

### Mar-2020 COVID

`vix_term_inverted` first fire: **2020-02-24** (window idx 4).

| θ   | RV_first_date | RV_first_val | lead | verdict           |
|----|---------------|--------------|------|-------------------|
| 20% | 2020-02-24    | 23.4%        | +0   | TIE (co-fired)    |
| 25% | 2020-02-25    | 26.7%        | −1   | FAIL (vix led)    |
| 30% | 2020-03-02    | 53.4%        | −5   | FAIL (vix led)    |
| 35% | 2020-03-02    | 53.4%        | −5   | FAIL (vix led)    |
| 40% | 2020-03-02    | 53.4%        | −5   | FAIL (vix led)    |

RV_5d co-fired with `vix_term_inverted` at θ=20% on the same session.
At higher θ the term structure consistently led realized vol by 1-5
sessions. The variance risk premium worked in the OPPOSITE direction
the critic hypothesized for COVID specifically — implied vol priced
the dislocation faster than 5-day realized vol could compute it.

### Aug-2024 yen-carry unwind

`vix_term_inverted` first fire: **2024-08-02** (window idx 14).

| θ   | RV_first_date | RV_first_val | lead | verdict           |
|----|---------------|--------------|------|-------------------|
| 20% | 2024-07-26    | 22.0%        | +5   | PASS (RV led)     |
| 25% | 2024-08-05    | 27.3%        | −1   | FAIL (vix led)    |
| 30% | 2024-08-06    | 30.7%        | −2   | FAIL (vix led)    |
| 35% | NEVER         | —            | N/A  | RV never crossed  |
| 40% | NEVER         | —            | N/A  | RV never crossed  |

Only event where RV_5d led at any θ. The 22.0% reading on 2024-07-26 is
just barely above the 20% threshold; in a 35% / 40% threshold world
RV_5d would never have fired in this event at all. The lead is real
but fragile — sensitive to where the threshold sits and to how a brief
mean-reverting spike is interpreted.

## Verdict

| θ   | Pass count (lead ≥ 1) |
|----|-----------------------|
| 20% | 1/3                   |
| 25% | 0/3                   |
| 30% | 0/3                   |
| 35% | 0/3                   |
| 40% | 0/3                   |

No θ in K achieves lead ≥ 1 in ≥ 2 of 3 events. **Pre-registration FAIL.**

## Diagnosis

The variance-risk-premium argument (Bollerslev-Tauchen-Zhou 2009)
establishes that *implied minus realized* is a documented economic
quantity. The critic's pivot used this to claim realized vol is
ECONOMICALLY DISTINCT from implied. That economic distinction holds —
but the *temporal lead* it implies (realized leads implied) is the
opposite of what the data shows in the SPY context.

The likely reason: the SPX options market is liquid and forward-looking;
near-term vol gets priced into the term structure on news-event days
within the same session. 5-day realized vol, by construction, requires
several sessions of high-magnitude returns before it can cross 25%+
thresholds. So `vix_term_inverted` (a same-day signal of implied near-
term stress) systematically beats RV_5d (which requires 3-5 sessions of
realized variance to register). This is a structural property of the
two metrics, not a regime-specific quirk.

For Phase 2's stated purpose — closing the *fast-crash detection gap*
where Phase 1 misses crashes that complete in hours/days — RV_5d is
mechanically too slow. It cannot lead something that fires intra-
session.

## Action

Per pre-committed escalation order (HANDOFF session 32):
**RV_5d → VVIX → absolute VIX → ship E.**

Next: VVIX with critic's §3 mods forced as pre-conditions before any
procedure run:
1. **Lead-lag pre-registration on the same 3 events.** Required before
   committing the family. Note: critic's original memo asserted (from
   memory, not from data) that VVIX co-fires same-session with
   `vix_term_inverted` in these events. If that claim survives empirical
   verification, VVIX also fails pre-reg → escalate to absolute VIX.
2. **Single-event leverage diagnostic in procedure** (drop largest
   contiguous high-VVIX window, re-run Steps 3-5).
3. **Politis-White 2004 data-driven block length** for permutation
   bootstrap.
4. **Methodology-era handling** for the CBOE VIX 2014 construction
   break (truncate post-2014 OR stratify).

VVIX requires data ingest (~2-3 days realistic per critic). User check-
in recommended before committing the ingest, since the critic's prior
on VVIX is also negative.

## Files referenced

- `scripts/_phase2_rv5d_leadlag_diagnostic.ts` — the diagnostic script.
- `quantlab.candles` (SPY_USD, source=yfinance_regime) — SPY closes.
- `quantlab.macro_regimes` (classifier_version=phase1_v2) — vix_term_inverted.
