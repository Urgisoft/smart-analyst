#!/usr/bin/env bash
# Resumable historical backfill for FINRA consolidated equity short interest.
#
# Usage: bash scripts/_backfill_finra_short_interest.sh [START_YM=2020-01]
#
# FINRA publishes short interest twice a month: a mid-month settlement (~15th) and
# an end-of-month settlement, each adjusted to a business day. We don't know the
# exact business-day-adjusted dates a priori, so per month we probe a small set of
# candidate dates (15/14/13 for mid; last/last-1/last-2 for end-of-month) via the
# ingest's --settlement-date. A candidate with no settlement returns HTTP 204 and
# is skipped cheaply; a real settlement triggers the full paged ~22k-row pull.
#
# Walks months BACKWARD from current to START_YM. Idempotent (ReplacingMergeTree
# keyed on settlement_date) + resumable (logs/backfill_finra_short_interest.progress).
set -u

START_YM="${1:-2020-01}"
PYBIN=".venv/Scripts/python.exe"
PY="scripts/finra_short_interest_ingest.py"
LOG="logs/backfill_finra_short_interest.log"
PROG="logs/backfill_finra_short_interest.progress"
mkdir -p logs

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
ymnum() { echo "${1//-/}"; }

echo "[$(ts)] === FINRA short-interest backfill START target=$START_YM ===" | tee -a "$LOG"

ym="$(date -u +%Y-%m)"
while [[ $(ymnum "$ym") -ge $(ymnum "$START_YM") ]]; do
  if grep -q "^$ym " "$PROG" 2>/dev/null; then
    ym="$(date -u -d "$ym-01 -1 month" +%Y-%m)"
    continue
  fi
  # last day of this month (e.g. 28/29/30/31)
  last="$(date -u -d "$ym-01 +1 month -1 day" +%d)"
  l1=$(printf %02d $((10#$last - 1)))
  l2=$(printf %02d $((10#$last - 2)))
  got=0
  for d in 15 14 13 "$last" "$l1" "$l2"; do
    cand="$ym-$(printf %02d $((10#$d)))"
    date -u -d "$cand" >/dev/null 2>&1 || continue
    out="$("$PYBIN" "$PY" --settlement-date "$cand" --apply 2>&1)"
    echo "$out" >> "$LOG"
    if echo "$out" | grep -qiE "wrote [0-9]+ rows|wrote [0-9,]+ rows"; then
      got=$((got + 1))
      echo "[$(ts)]   settlement $cand ingested" | tee -a "$LOG"
    fi
  done
  echo "$ym got=$got $(ts)" >> "$PROG"
  ym="$(date -u -d "$ym-01 -1 month" +%Y-%m)"
done

echo "[$(ts)] === FINRA short-interest backfill COMPLETE ===" | tee -a "$LOG"
