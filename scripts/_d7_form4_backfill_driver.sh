#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# D7 full-market Form 4 backfill driver (ADR-052 D7 / OQ-C38-1).
#
# WHY full-market (not the OQ-C32-1 SP500 allowlist): the 2024-07..2025-11 window
# was previously ingested SP500-FILTERED (Cycle 32), producing P/S volume far
# below the ADR-052 D2 coverage floor (500 P/S filings / trailing-30d). Those
# days are therefore NOT ADMITTED to the z-baseline. The live daemon ingest is
# full-market (no allowlist); to make the gap days coverage-homogeneous with the
# live window they must be re-ingested full-market. The 500 floor is NOT lowered
# (anti-shopping; ADR-052 D2 / ADR-054 D3).
#
# Order: BACKWARD from 2025-11 so each completed month extends the continuous
# admitted block contiguously backward from the existing Dec-2025+ full-market
# coverage. Partial progress is durable + useful (a longer continuous baseline).
#
# Idempotent: insider_trades is ReplacingMergeTree((issuer_cik,accession,
# transaction_id)); re-running a month collapses dupes. Resume: read the
# .progress file, delete already-done months from the array, re-launch.
#
# Paced: the python ingest self-throttles at SEC_RATE_LIMIT_RPS=10 with 429
# exponential backoff. Run SEQUENTIALLY (this loop) — never parallelize the
# hammer (EDGAR per-IP sustained-access throttle).
# ─────────────────────────────────────────────────────────────────────────────
set -u
cd "$(dirname "$0")/.." || exit 1

LOG=logs/d7_form4_backfill.log
PROG=logs/d7_form4_backfill.progress
PY=.venv/Scripts/python.exe

months=(
  "2025-11-01 2025-11-30"
  "2025-10-01 2025-10-31"
  "2025-09-01 2025-09-30"
  "2025-08-01 2025-08-31"
  "2025-07-01 2025-07-31"
  "2025-06-01 2025-06-30"
  "2025-05-01 2025-05-31"
  "2025-04-01 2025-04-30"
  "2025-03-01 2025-03-31"
  "2025-02-01 2025-02-28"
  "2025-01-01 2025-01-31"
  "2024-12-01 2024-12-31"
  "2024-11-01 2024-11-30"
  "2024-10-01 2024-10-31"
  "2024-09-01 2024-09-30"
  "2024-08-01 2024-08-31"
  "2024-07-01 2024-07-31"
)

echo "[$(date -u +%FT%TZ)] D7 full-market form4 backfill START (${#months[@]} months, backward from 2025-11)" | tee -a "$LOG"
for m in "${months[@]}"; do
  # shellcheck disable=SC2086
  set -- $m
  start=$1; end=$2
  echo "[$(date -u +%FT%TZ)] >>> month $start..$end BEGIN" | tee -a "$LOG"
  t0=$(date +%s)
  "$PY" scripts/sec_edgar_form4_ingest.py --start-date "$start" --end-date "$end" --apply >> "$LOG" 2>&1
  rc=$?
  t1=$(date +%s)
  echo "[$(date -u +%FT%TZ)] <<< month $start..$end END rc=$rc elapsed=$((t1-t0))s" | tee -a "$LOG"
  echo "$start..$end rc=$rc $(date -u +%FT%TZ)" >> "$PROG"
done
echo "[$(date -u +%FT%TZ)] D7 backfill COMPLETE" | tee -a "$LOG"
