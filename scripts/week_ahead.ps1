<#
  week_ahead.ps1 — weekly "week ahead" catalyst digest -> Telegram.

  Run by Windows Task Scheduler on Sunday evening so the operator starts the week knowing every
  scheduled catalyst (top-holding earnings + CPI / FOMC / jobs / PCE) in the next ~10 days.
  Awareness, not prediction. Logs to logs\week_ahead_<date>.log.
#>
$ErrorActionPreference = 'Continue'
$repo = 'C:\Users\Pejman\Downloads\signalforge---technical-analysis-lab (1)'
Set-Location $repo
New-Item -ItemType Directory -Force -Path "$repo\logs" | Out-Null
$log = "$repo\logs\week_ahead_$(Get-Date -Format yyyyMMdd).log"
"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  week_ahead start" | Tee-Object -FilePath $log -Append
# 1) Catalyst week-ahead (earnings + macro releases, next 10 days).
& "$repo\.venv\Scripts\python.exe" "$repo\scripts\catalyst_calendar.py" --push --days 10 *>> $log
"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  catalyst exit=$LASTEXITCODE" | Tee-Object -FilePath $log -Append
# 2) Sector landscape (descriptive relative-strength scan — diversification context, not a signal).
& "$repo\.venv\Scripts\python.exe" "$repo\scripts\sector_scan.py" --push *>> $log
"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  sector_scan exit=$LASTEXITCODE" | Tee-Object -FilePath $log -Append
# 3) Expected moves — what the options market is pricing this week + into near earnings (the market's
#    own priced range, not a prediction). Pairs with the catalyst calendar (when) -> how big.
& "$repo\.venv\Scripts\python.exe" "$repo\scripts\expected_move.py" --push *>> $log
"$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  expected_move exit=$LASTEXITCODE" | Tee-Object -FilePath $log -Append
