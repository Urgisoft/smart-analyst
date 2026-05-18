"""
walk_forward_cluster.py — chronological walk-forward orchestrator for the
weekly cluster pipeline.

For each Monday in [--start-week, --end-week], runs (in order):
    1. compute_token_features_weekly.py  — features for week W
    2. cluster_tokens_weekly.py          — HDBSCAN + GMM-BIC fit for W

Idempotent. Both target tables are ReplacingMergeTree, so re-runs collapse
on (token_address, week_start, feature_version) and (week_start, method,
fit_id) respectively. By default, weeks with existing features are skipped
in step 1 and weeks with an existing hdbscan diagnostic row are skipped in
step 2; pass --force to ignore existing rows.

Strict chronological order is LOAD-BEARING: cluster_tokens_weekly.py's
admission rule (apply_admission_rule, n_weeks_required=3) reads prior
membership rows, so a week W's admission decision depends on weeks
W-1 and W-2 having already been written. Out-of-order processing silently
reduces admitted-token counts.

CLI:
    python scripts/walk_forward_cluster.py \\
        --start-week 2024-07-15 \\
        --end-week   2026-04-27 \\
        [--feature-version v1]            # default
        [--min-cluster-size 15]           # default — production per ADR-014
        [--min-samples 8]                 # default — production per ADR-014
        [--seed 42]                       # default
        [--force]                         # recompute even if rows exist
        [--skip-features]                 # cluster-only mode
        [--skip-cluster]                  # features-only mode
        [--dry-run]                       # log what would happen, do not invoke

Side effects:
    - Subprocess invocations of the two underlying CLIs.
    - Writes logs/walk_forward_<start>_<end>.jsonl with per-week timings + status.
    - Each underlying script writes its own logs/features_<week>.jsonl etc.

References:
- AFML §11 (López de Prado) — walk-forward backtest design.
- Pardo (2008) §6 — chronological re-fit invariant for any rolling-parameter scheme.
- ADR-014 — locked-in HDBSCAN params (min_cluster_size=15, min_samples=8).
- HANDOFF.md (2026-05-04) — fork 1 ("walk-forward historical cluster fits").

What could break this:
- A subprocess that hangs (e.g. ClickHouse stalls under load) will block the
  whole sweep. No timeout is set; user can Ctrl-C, fix, and resume from the
  last-completed week (idempotent skip handles re-entry).
- If --force is used with --start-week earlier than the existing data, the
  admission-rule history is repopulated chronologically and earlier weeks'
  membership rows are re-extended — consistent, but the orphan amber chip
  on Panel A may keep firing until manual cleanup of stale fit_ids.
- ReplacingMergeTree FINAL collapse is by computed_at, so re-runs always
  shadow older rows for the same key — but the older rows persist in the
  parts file until OPTIMIZE TABLE … FINAL.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse


REPO_ROOT = Path(__file__).resolve().parent.parent
FEATURES_SCRIPT = REPO_ROOT / "scripts" / "compute_token_features_weekly.py"
CLUSTER_SCRIPT = REPO_ROOT / "scripts" / "cluster_tokens_weekly.py"
LOG_DIR = REPO_ROOT / "logs"


def _generate_mondays(start: date, end: date) -> list[date]:
    """Inclusive list of Mondays in [start, end]. Both must already be Mondays."""
    if start.weekday() != 0:
        raise ValueError(f"--start-week {start.isoformat()} is not a Monday (weekday={start.weekday()})")
    if end.weekday() != 0:
        raise ValueError(f"--end-week {end.isoformat()} is not a Monday (weekday={end.weekday()})")
    if end < start:
        raise ValueError(f"--end-week {end.isoformat()} is before --start-week {start.isoformat()}")
    out: list[date] = []
    cur = start
    while cur <= end:
        out.append(cur)
        cur = cur + timedelta(weeks=1)
    return out


def _ch_client():  # type: ignore[no-untyped-def]
    """Lazy-import a clickhouse-connect client. Mirrors cluster_tokens_weekly._ch_client."""
    import clickhouse_connect  # type: ignore[import-not-found]
    url = os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:8123/")
    parsed = urlparse(url)
    return clickhouse_connect.get_client(
        host=parsed.hostname or "127.0.0.1",
        port=parsed.port or 8123,
        username=os.environ.get("CLICKHOUSE_USER", "quantlab"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", "quantlab"),
    )


def _features_exist(client, week: date, feature_version: str) -> int:  # type: ignore[no-untyped-def]
    """Row count for (week_start, feature_version) in token_features_weekly."""
    sql = f"""
        SELECT count() FROM quantlab.token_features_weekly FINAL
        WHERE week_start = toDate('{week.isoformat()}')
          AND feature_version = '{feature_version}'
    """
    rows = client.query(sql).result_rows
    return int(rows[0][0]) if rows else 0


def _cluster_exists(client, week: date) -> int:  # type: ignore[no-untyped-def]
    """Row count for (week_start, method='hdbscan') in cluster_diagnostics_weekly."""
    sql = f"""
        SELECT count() FROM quantlab.cluster_diagnostics_weekly
        WHERE week_start = toDate('{week.isoformat()}') AND method = 'hdbscan'
    """
    rows = client.query(sql).result_rows
    return int(rows[0][0]) if rows else 0


def _python_executable() -> str:
    """Python interpreter to use for subprocess invocations.

    Prefers the same interpreter we're running under (sys.executable) — this
    is the venv's Python if the user invoked us via .venv/Scripts/python.exe.
    """
    return sys.executable


def _run_features(week: date, feature_version: str, dry_run: bool) -> tuple[bool, float, str]:
    """Returns (ok, wallclock_seconds, stderr_tail)."""
    cmd = [
        _python_executable(),
        str(FEATURES_SCRIPT),
        "--week-start", week.isoformat(),
        "--feature-version", feature_version,
    ]
    if dry_run:
        cmd.append("--dry-run")
    t0 = time.time()
    try:
        proc = subprocess.run(
            cmd, cwd=str(REPO_ROOT), capture_output=True, text=True, check=False,
        )
        wall = time.time() - t0
        stderr_tail = "\n".join(proc.stderr.splitlines()[-5:]) if proc.stderr else ""
        return (proc.returncode == 0, wall, stderr_tail)
    except (OSError, subprocess.SubprocessError) as e:
        return (False, time.time() - t0, f"subprocess failed: {type(e).__name__}: {e}")


def _run_cluster(
    week: date,
    feature_version: str,
    min_cluster_size: int,
    min_samples: int,
    seed: int,
    dry_run: bool,
) -> tuple[bool, float, str]:
    cmd = [
        _python_executable(),
        str(CLUSTER_SCRIPT),
        "--week-start", week.isoformat(),
        "--feature-version", feature_version,
        "--min-cluster-size", str(min_cluster_size),
        "--min-samples", str(min_samples),
        "--seed", str(seed),
    ]
    if dry_run:
        cmd.append("--dry-run")
    t0 = time.time()
    try:
        proc = subprocess.run(
            cmd, cwd=str(REPO_ROOT), capture_output=True, text=True, check=False,
        )
        wall = time.time() - t0
        stderr_tail = "\n".join(proc.stderr.splitlines()[-8:]) if proc.stderr else ""
        return (proc.returncode == 0, wall, stderr_tail)
    except (OSError, subprocess.SubprocessError) as e:
        return (False, time.time() - t0, f"subprocess failed: {type(e).__name__}: {e}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start-week", required=True, help="ISO Monday, YYYY-MM-DD")
    parser.add_argument("--end-week", required=True, help="ISO Monday, YYYY-MM-DD (inclusive)")
    parser.add_argument("--feature-version", default="v1")
    parser.add_argument("--min-cluster-size", type=int, default=15,
                        help="HDBSCAN min_cluster_size (production default 15 per ADR-014)")
    parser.add_argument("--min-samples", type=int, default=8,
                        help="HDBSCAN min_samples (production default 8 per ADR-014)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--force", action="store_true",
                        help="Recompute even if rows already exist for the week")
    parser.add_argument("--skip-features", action="store_true",
                        help="Cluster-only mode (assumes features already correct)")
    parser.add_argument("--skip-cluster", action="store_true",
                        help="Features-only mode (no cluster fit)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Pass --dry-run to underlying scripts")
    args = parser.parse_args()

    start = date.fromisoformat(args.start_week)
    end = date.fromisoformat(args.end_week)

    weeks = _generate_mondays(start, end)
    print(f"[walk-forward] {len(weeks)} weeks: {start.isoformat()} → {end.isoformat()}",
          file=sys.stderr)
    print(f"[walk-forward] params: feature_version={args.feature_version} "
          f"min_cluster_size={args.min_cluster_size} min_samples={args.min_samples} "
          f"seed={args.seed} force={args.force} dry_run={args.dry_run}",
          file=sys.stderr)

    # DB existence checks need a client. In dry-run, we still want to surface
    # the skip/run decision for transparency, so build the client either way.
    client = _ch_client()

    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"walk_forward_{start.isoformat()}_{end.isoformat()}.jsonl"

    n_features_run = n_features_skip = 0
    n_cluster_run = n_cluster_skip = 0
    n_failures = 0
    sweep_t0 = time.time()

    with log_path.open("a", encoding="utf-8") as logf:
        for i, week in enumerate(weeks, start=1):
            week_iso = week.isoformat()
            week_log: dict[str, object] = {"week_start": week_iso, "step": []}

            # --- Step 1: features ---
            if args.skip_features:
                print(f"[{i}/{len(weeks)}] {week_iso} features: SKIPPED (--skip-features)",
                      file=sys.stderr)
                week_log["step"].append({"phase": "features", "action": "skip_flag"})
            else:
                existing_feat = _features_exist(client, week, args.feature_version)
                if existing_feat > 0 and not args.force:
                    print(f"[{i}/{len(weeks)}] {week_iso} features: SKIP "
                          f"({existing_feat} rows exist — pass --force to recompute)",
                          file=sys.stderr)
                    n_features_skip += 1
                    week_log["step"].append({
                        "phase": "features", "action": "skip_existing",
                        "existing_rows": existing_feat,
                    })
                else:
                    print(f"[{i}/{len(weeks)}] {week_iso} features: RUN "
                          f"(existing={existing_feat}, force={args.force})", file=sys.stderr)
                    ok, wall, tail = _run_features(week, args.feature_version, args.dry_run)
                    n_features_run += 1
                    if not ok:
                        n_failures += 1
                        print(f"  → FAIL ({wall:.1f}s)\n{tail}", file=sys.stderr)
                    else:
                        print(f"  → OK ({wall:.1f}s)", file=sys.stderr)
                    week_log["step"].append({
                        "phase": "features", "action": "run",
                        "ok": ok, "wallclock_s": round(wall, 2), "stderr_tail": tail,
                    })

            # --- Step 2: cluster ---
            if args.skip_cluster:
                print(f"[{i}/{len(weeks)}] {week_iso} cluster: SKIPPED (--skip-cluster)",
                      file=sys.stderr)
                week_log["step"].append({"phase": "cluster", "action": "skip_flag"})
            else:
                existing_clus = _cluster_exists(client, week)
                if existing_clus > 0 and not args.force:
                    print(f"[{i}/{len(weeks)}] {week_iso} cluster: SKIP "
                          f"({existing_clus} hdbscan diag rows exist)", file=sys.stderr)
                    n_cluster_skip += 1
                    week_log["step"].append({
                        "phase": "cluster", "action": "skip_existing",
                        "existing_rows": existing_clus,
                    })
                else:
                    print(f"[{i}/{len(weeks)}] {week_iso} cluster: RUN "
                          f"(existing={existing_clus}, force={args.force})", file=sys.stderr)
                    ok, wall, tail = _run_cluster(
                        week, args.feature_version, args.min_cluster_size,
                        args.min_samples, args.seed, args.dry_run,
                    )
                    n_cluster_run += 1
                    if not ok:
                        n_failures += 1
                        print(f"  → FAIL ({wall:.1f}s)\n{tail}", file=sys.stderr)
                    else:
                        print(f"  → OK ({wall:.1f}s)\n  {tail}", file=sys.stderr)
                    week_log["step"].append({
                        "phase": "cluster", "action": "run",
                        "ok": ok, "wallclock_s": round(wall, 2), "stderr_tail": tail,
                    })

            logf.write(json.dumps(week_log) + "\n")
            logf.flush()

    sweep_wall = time.time() - sweep_t0
    print("─" * 60, file=sys.stderr)
    print(f"[walk-forward] DONE in {sweep_wall:.1f}s", file=sys.stderr)
    print(f"  features: run={n_features_run} skip={n_features_skip}", file=sys.stderr)
    print(f"  cluster:  run={n_cluster_run} skip={n_cluster_skip}", file=sys.stderr)
    print(f"  failures: {n_failures}", file=sys.stderr)
    print(f"  log: {log_path}", file=sys.stderr)
    return 0 if n_failures == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
