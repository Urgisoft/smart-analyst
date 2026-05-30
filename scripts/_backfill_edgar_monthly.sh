#!/usr/bin/env bash
# Resumable monthly historical backfill for EDGAR 8-K composites.
#
# Usage: bash scripts/_backfill_edgar_monthly.sh <exec-departure|8k-event> [START_YM=2020-01]
#
# Walks months BACKWARD from the current month to START_YM (inclusive), running
# the composite's ingest --apply over each [first..last]-of-month window. Backward
# so each completed month extends the admitted block contiguously back from the
# already-present recent coverage — partial progress is durable + useful.
#
# Idempotent: the ingests write to ReplacingMergeTree tables keyed per filing, so
# re-running a month is safe (dedups on merge). Resumable: completed months are
# recorded in logs/backfill_<kind>.progress; a relaunch skips them. EDGAR transient
# HTTP 429/500s are handled by the shared helper's exponential-backoff retry.
set -u

KIND="${1:?usage: _backfill_edgar_monthly.sh <exec-departure|8k-event> [START_YM]}"
START_YM="${2:-2020-01}"

case "$KIND" in
  exec-departure) PY="scripts/sec_edgar_8k_item_5_02_ingest.py" ;;
  8k-event)       PY="scripts/sec_edgar_8k_event_ingest.py" ;;
  *) echo "unknown kind: $KIND (expected exec-departure|8k-event)" >&2; exit 2 ;;
esac

PYBIN=".venv/Scripts/python.exe"
LOG="logs/backfill_${KIND}.log"
PROG="logs/backfill_${KIND}.progress"
mkdir -p logs

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
ymnum() { echo "${1//-/}"; }   # 2021-01 -> 202101 (integer-comparable)

echo "[$(ts)] === EDGAR backfill START kind=$KIND target=$START_YM ===" | tee -a "$LOG"

ym="$(date -u +%Y-%m)"
while [[ $(ymnum "$ym") -ge $(ymnum "$START_YM") ]]; do
  if grep -q "^$ym " "$PROG" 2>/dev/null; then
    ym="$(date -u -d "$ym-01 -1 month" +%Y-%m)"
    continue
  fi
  s="$ym-01"
  e="$(date -u -d "$s +1 month -1 day" +%Y-%m-%d)"
  echo "[$(ts)] >>> $KIND $s..$e BEGIN" | tee -a "$LOG"
  "$PYBIN" "$PY" --start-date "$s" --end-date "$e" --apply >> "$LOG" 2>&1
  rc=$?
  echo "$ym rc=$rc $(ts)" >> "$PROG"
  echo "[$(ts)] <<< $KIND $s..$e END rc=$rc" | tee -a "$LOG"
  ym="$(date -u -d "$s -1 month" +%Y-%m)"
done

echo "[$(ts)] === EDGAR backfill $KIND COMPLETE ===" | tee -a "$LOG"
