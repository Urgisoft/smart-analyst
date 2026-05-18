# Phase 2 — `realized_stress` procedure RESULT

Run date: 2026-05-10
Seed: 42
Train-end: 2026-05-10
SPY rows: 4617; with drawdown: 4366
K = {-10%, -12%, -15%, -18%, -20%}; α_Bonferroni = 0.002

## Outcome
- Status: **PROCEDURE_REJECT**
- Chosen θ: (none — procedure rejected)
- Chosen rule: (none — procedure rejected)

## Reasoning trace
- Step 3: 2 of 5 θ pass Bonferroni-adjusted p ≤ 0.0020.
- Step 4: PBO = 0.025 < 0.5.
- Step 5: walk-forward θ-spread 0.080 > ±0.03 → fail; §3.10 escalate.

## Acceptance bar (Phase 2 SPEC §3.11)
1. Surviving θ post-Bonferroni (two-sided, SPEC §3.11 item 1 rev 3 — "at least one"): ✅ 2
2. PBO: ✅ 0.025
3. Walk-forward θ-spread ≤ ±0.03: ❌ 0.080
4. Co-fire histogram produced: ❌
5. V-fire: ❌ skipped (procedure rejected before V-touch)

## Next step
- Procedure rejected before V-touch. SPEC §3.10 default escalate. V remains UNTOUCHED for the next family attempt.
