<#
  market_watch_cycle.ps1 — one cycle of the autonomous market monitor.

  Run by Windows Task Scheduler every ~30 min during US market hours (weekdays). Each cycle:
    1. (best-effort) confirm ClickHouse is reachable — the detector still runs on yfinance-only
       if CH is down, just with fewer SignalForge signals.
    2. market_watch.py    — deterministic change detector; writes reports/market_watch_latest.json.
    3. market_watch_alert.py — if that says material==true, push a plain-language alert to Telegram
       (Opus-enriched if the Claude CLI is available; deterministic otherwise). No-ops if quiet.

  Event-driven by design: a quiet cycle sends nothing. Output appended to logs\market_watch_<date>.log.
#>
$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\Pejman\Downloads\signalforge---technical-analysis-lab (1)'
Set-Location $repo
New-Item -ItemType Directory -Force -Path "$repo\logs" | Out-Null
$log = "$repo\logs\market_watch_$(Get-Date -Format yyyyMMdd).log"
function Log($m) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $m" | Tee-Object -FilePath $log -Append }

Log "=== market_watch cycle start ==="

# 1) CH reachable? (non-fatal — detector degrades to yfinance-only if not)
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab" `
       -Method Post -Body "SELECT 1" -TimeoutSec 5
  if ($r.Content.Trim() -eq '1') { Log "ClickHouse OK." } else { Log "ClickHouse odd response (continuing)." }
} catch { Log "ClickHouse not reachable (continuing on yfinance-only signals)." }

# 2) detector
& "$repo\.venv\Scripts\python.exe" "$repo\scripts\market_watch.py" *>> $log
Log "market_watch exit=$LASTEXITCODE"

# 3) alerter (self-gates on material flag)
& "$repo\.venv\Scripts\python.exe" "$repo\scripts\market_watch_alert.py" *>> $log
Log "market_watch_alert exit=$LASTEXITCODE"

Log "=== market_watch cycle done ==="
