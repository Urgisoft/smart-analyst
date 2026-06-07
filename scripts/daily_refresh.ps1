<#
  daily_refresh.ps1 — autonomous daily data refresh for SignalForge.

  Run by Windows Task Scheduler once a day. Refreshes everything that has a
  daily cadence so the dashboard is current without manual intervention:
    1. npm run daemon:daily  — candles, FRED/CBOE/macro, all 9 composites,
       regime classifier, paper-trading cells. (FINRA/EDGAR self-gate by cadence.)
    2. polygon grouped-daily — equity_daily_polygon (single-stock technicals,
       incl. FTEC). Fetches a trailing window; idempotent (ReplacingMergeTree),
       and 403s on not-yet-published days are expected + non-fatal.

  Telegram is OFF here to avoid alert noise; flip --no-telegram off once you
  want push alerts. Output is appended to logs\daily_refresh_<date>.log.

  Prereqs the scheduler depends on: machine powered on (or set "wake to run"),
  Docker Desktop running with the quantlab-clickhouse container up (restart
  policy = unless-stopped handles reboots once Docker starts).
#>
$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\Pejman\Downloads\signalforge---technical-analysis-lab (1)'
Set-Location $repo
New-Item -ItemType Directory -Force -Path "$repo\logs" | Out-Null
$log = "$repo\logs\daily_refresh_$(Get-Date -Format yyyyMMdd).log"

function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Tee-Object -FilePath $log -Append }

Log "=== daily_refresh start ==="

# 0) ClickHouse reachable? (Docker may still be spinning up after a reboot.)
$chOk = $false
for ($i = 0; $i -lt 6; $i++) {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" `
         -Method Post -Body "SELECT 1" -TimeoutSec 5
    if ($r.Content.Trim() -eq '1') { $chOk = $true; break }
  } catch { Start-Sleep -Seconds 10 }
}
if (-not $chOk) { Log "ABORT: ClickHouse not reachable after retries (is Docker running?)."; exit 1 }
Log "ClickHouse OK."

# 1) Daily daemon (candles + macro + composites + paper cells).
Log "Running daemon:daily ..."
& npm run daemon:daily -- --no-telegram *>> $log
Log "daemon:daily exit=$LASTEXITCODE"

# 2) Polygon equity panel (single-stock technicals). Trailing 5-day window;
#    idempotent. A 403 on a not-yet-published day is expected (exit 3) and OK.
$end   = (Get-Date).ToString('yyyy-MM-dd')
$start = (Get-Date).AddDays(-5).ToString('yyyy-MM-dd')
Log "Running polygon ingest $start .. $end ..."
& "$repo\.venv\Scripts\python.exe" "$repo\scripts\polygon_grouped_daily_ingest.py" --start-date $start --end-date $end --apply *>> $log
Log "polygon ingest exit=$LASTEXITCODE (3 = hit a not-yet-published day; expected)"

# 3) Deterministic FTEC / AI-sector decision-support brief -> reports/ + Telegram.
Log "Running ftec_daily_brief ..."
& "$repo\.venv\Scripts\python.exe" "$repo\scripts\ftec_daily_brief.py" *>> $log
Log "ftec_daily_brief exit=$LASTEXITCODE"

# 4) Sell-off & stabilization monitor + escalation-risk read -> reports/ (no urgent push, per spec).
Log "Running selloff_monitor ..."
& "$repo\.venv\Scripts\python.exe" "$repo\scripts\selloff_monitor.py" *>> $log
Log "selloff_monitor exit=$LASTEXITCODE"

# 5) Data-integrity reconciliation: every stored number vs independent online sources + freshness +
#    plausibility. Pushes a detailed integrity report to Telegram (--push). Detect+report only.
Log "Running reconcile ..."
& "$repo\.venv\Scripts\python.exe" "$repo\scripts\reconcile.py" --push *>> $log
Log "reconcile exit=$LASTEXITCODE"

Log "=== daily_refresh done ==="
