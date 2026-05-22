"""
SEC EDGAR Schedule 13D / 13G activist-stake ingest -> quantlab.schedule_13d_g_filings
(+ quantlab.cik_ticker_map issuer-side cache).

SPEC: docs/specs/schedule-13d-13g-activist-stake.md §2.2 (XD-1..XD-15) + §4.1
      (inputs) + §6 (DDL) + §9.3 (tests) + §10 (Phase XD13-A1).
ADR:  docs/specs/adr-043-13d-13g-activist-stake-research.md (six canon-thin
      forks XD-1..XD-6 resolved at SPEC time).

Sibling of `scripts/sec_edgar_form4_ingest.py` (gap #7 F4-A1) and
`scripts/sec_edgar_8k_event_ingest.py` (gap #7 EK-A1). Per SPEC XD-11, this
script reuses the gap #7/8 EDGAR helpers (rate-limit, User-Agent, 429 retry,
acceptance-date filter, CIK→submissions-API resolver) — no XML body parsing
(per XD-3 — v1 reads SEC-structural envelope only).

Architecture:

  1. EDGAR Full-Text Search API (efts.sec.gov/LATEST/search-index) → list of
     Schedule 13D/G filings filtered to `forms=SC 13D,SC 13D/A,SC 13G,SC 13G/A`.
     Response is JSON.
  2. For each filing: extract (accession, issuer_cik, filer_cik, form_type,
     accepted_at, period_of_report, filing_url) from the search hit envelope.
     The cover-page body is NEVER fetched in v1 (XD-3 — no Item 4 NLP, no
     ownership-% extraction).
  3. Issuer CIK → ticker resolution via the EDGAR Submissions API
     (data.sec.gov/submissions/CIK{cik10}.json). Reused issuer-side cache
     `quantlab.cik_ticker_map` (shared with gap #7 EK/F4 + gap #8 — DDL
     byte-shared per SPEC EDF-4).
  4. Filer CIK → name resolution OPTIONAL in v1 via `--resolve-filer-names`
     (XD-12). Default `false` leaves `filer_name = ''`; v2 ADR (XD-2) will
     introduce a dedicated `quantlab.activist_filers` reputation table once
     Phase B reveals form-type-only is too coarse.
  5. Per XD-1 + XD-7, the activist-vs-passive proxy is form-type-only
     (SC 13D ⇒ active intent; SC 13G ⇒ passive intent). No Item 4 free-text
     parsing in v1.
  6. Per XD-4, amendments (SC 13D/A, SC 13G/A) are stored ADDITIVELY with
     `is_amendment = 1`. No retrospective linking to original filings.
  7. Per XD-14, idempotent on `(issuer_cik, accession)`. ReplacingMergeTree
     (ingested_at) — re-runs collapse duplicates.

Per SPEC EDF-5 / XD-7, the acceptance-date anti-leak filter applies: filings
with `accepted_at > snapshot_date` are rejected at the search-parse layer
(same helper as EK-A1 / F4-A1). NEVER use `period_of_report` for window
membership — for SC 13G, that field can predate `accepted_at` by up to 45d.

Per SPEC §11 watch-out #4, `issuer_cik ≠ filer_cik` at every layer. The full-
text-search `ciks` array contains BOTH; the filer is derived from the
accession-number leading 10 digits (EDGAR's storage-CIK convention), and the
issuer is the first ciks[] entry that DOESN'T match the filer. Confusing the
two corrupts `distinct_13d_filers_90d` and breaks any future filer-reputation
work.

EDGAR rate-limit / 429-retry / fetch / acceptance-date / submissions-resolve
helpers live in scripts/_sec_edgar_helpers.py. Reused with the EK-A1 / F4-A1 /
gap #8 scripts.

Operator paths (matching EK-A1 / F4-A1):

  1. `--url <url>`         — try a specific search URL (overrides built-in).
  2. `--from-file <path>`  — ingest a locally-downloaded JSON response.
  3. Default               — attempt the built-in URL; log clear instructions
                              on 404 / format failure.

Usage
-----
  .venv/Scripts/python.exe scripts/sec_edgar_13d_g_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/sec_edgar_13d_g_ingest.py --apply
  .venv/Scripts/python.exe scripts/sec_edgar_13d_g_ingest.py \\
        --start-date 2026-04-01 --end-date 2026-05-22 --apply
  .venv/Scripts/python.exe scripts/sec_edgar_13d_g_ingest.py \\
        --from-file C:/Users/Pejman/Downloads/edgar_13dg_2026-05-22.json --apply
  .venv/Scripts/python.exe scripts/sec_edgar_13d_g_ingest.py \\
        --resolve-filer-names --apply
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import time  # noqa: F401  (test-compat: patch.object(xd13g.time, "sleep", …))
import urllib.error
import urllib.parse
import urllib.request  # noqa: F401  (test-compat: patch.object(xd13g.urllib.request, …))
from pathlib import Path

import clickhouse_connect

# Make the sibling helpers module importable when this script is run as
# `python scripts/sec_edgar_13d_g_ingest.py` (no package context).
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from _sec_edgar_helpers import (  # noqa: E402  (sys.path manipulation above)
    EDGAR_SEARCH_BASE,
    EDGAR_SUBMISSIONS_URL,
    SEC_RATE_LIMIT_BACKOFF_SEC,
    SEC_RATE_LIMIT_MAX_RETRIES,
    SEC_RATE_LIMIT_RPS,
    cik10,
    ensure_cik_ticker_map_table,
    fetch_edgar,
    filter_by_acceptance_date,
    parse_edgar_search_response,
    parse_submissions_response,
    submissions_url,
    write_cik_ticker_map,
    _parse_edgar_datetime,
)


# ── Configuration (13D/G-specific) ───────────────────────────────────────────

# SEC requires a contact-info User-Agent on every request. Operator-overridable.
# Tagged with this script's purpose so EDGAR access logs distinguish 13D/G
# ingest traffic from the gap #8 / EK-A1 / F4-A1 streams.
DEFAULT_USER_AGENT = "SignalForge/schedule-13d-g-ingest u0249898@gmail.com"

# Per XD-1 + XD-12: the v1 form-type set. SC 13D ⇒ active intent declared
# by filer; SC 13G ⇒ passive intent declared by filer. Amendments (/A) are
# stored additively per XD-4 with `is_amendment = 1`.
DEFAULT_FORMS_13D_G = ("SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A")


# ── Argparse ─────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--url",
        type=str,
        default=None,
        help="Override URL to fetch the EDGAR full-text search response from. "
             "If not set, the script builds one from EDGAR_SEARCH_BASE + the "
             "supplied --start-date / --end-date window with "
             "forms=SC 13D,SC 13D/A,SC 13G,SC 13G/A.",
    )
    p.add_argument(
        "--from-file",
        type=str,
        default=None,
        help="Path to a locally-downloaded EDGAR JSON response. Skips network "
             "fetch. Useful when the operator manually downloads via a browser "
             "while the API endpoint is under revision.",
    )
    p.add_argument(
        "--start-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Start of date range (YYYY-MM-DD, inclusive). Default = 90 days "
             "before today, matching the SPEC XD-6 / EDF-6 90d rolling window. "
             "First --apply run may want to widen to ~6mo to populate the "
             "aggregate baseline at faster pace than 60d-daemon-only cold-start.",
    )
    p.add_argument(
        "--end-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="End of date range (YYYY-MM-DD, inclusive). Default = today.",
    )
    p.add_argument(
        "--user-agent",
        type=str,
        default=DEFAULT_USER_AGENT,
        help=f"User-Agent header for EDGAR requests. SEC REQUIRES a contact-info "
             f"User-Agent; without it requests will 403. Default: {DEFAULT_USER_AGENT!r}.",
    )
    p.add_argument(
        "--snapshot-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Snapshot date for the SPEC EDF-5 / XD-7 acceptance-date filter "
             "(YYYY-MM-DD). Filings with `accepted_at > snapshot_date` are "
             "rejected to prevent look-ahead leakage. Default = today.",
    )
    p.add_argument(
        "--resolve-filer-names",
        action="store_true",
        help="Per XD-12: when set, resolve filer CIK → name via submissions API "
             "and populate `filer_name`. Default OFF — adds N+1 submissions-API "
             "calls per ingest cycle. v2 ADR (XD-2) will lift this to a "
             "dedicated reputation table.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch + parse + count; no CH write (default).",
    )
    p.add_argument(
        "--apply",
        action="store_true",
        help="Write to CH. Without this flag, the script defaults to dry-run.",
    )
    return p.parse_args()


# ── URL construction (forms=SC 13D,SC 13D/A,SC 13G,SC 13G/A) ────────────────

def build_schedule_13d_g_search_url(
    base: str,
    start_date: _dt.date,
    end_date: _dt.date,
    forms: str = "SC 13D,SC 13D/A,SC 13G,SC 13G/A",
) -> str:
    """Build an EDGAR full-text search URL filtered to Schedule 13D/G filings.

    Per XD-1, the v1 universe is exactly the four form types. EDGAR's
    full-text search accepts comma-separated form filters; the "SC " prefix
    + the "/A" suffix are part of the form identifier (not a separator).

    Args:
      base:       EDGAR_SEARCH_BASE (overridable for test fixtures).
      start_date: inclusive YYYY-MM-DD lower bound.
      end_date:   inclusive YYYY-MM-DD upper bound.
      forms:      form filter (default = all four 13D/G variants).
    """
    params = {
        "forms": forms,
        "dateRange": "custom",
        "startdt": start_date.isoformat(),
        "enddt": end_date.isoformat(),
    }
    return f"{base}?{urllib.parse.urlencode(params)}"


# ── 13D/G-specific CIK extraction (XD-7 + §11 watch-out #4) ──────────────────

def extract_issuer_and_filer_ciks(
    accession: str,
    ciks_all: list[str],
) -> tuple[str, str]:
    """Extract (issuer_cik, filer_cik) from a 13D/G search-response item.

    EDGAR storage convention for 13D/G: the leading 10 digits of the accession
    number identify the CIK of the entity that owns the filing storage path —
    for Schedule 13D/G, this is the FILER (the beneficial owner doing the
    filing). The `ciks` array in the full-text search index contains ALL CIKs
    associated with the filing, which for 13D/G is the filer PLUS the issuer
    (subject of the filing).

    Strategy:
      1. filer_cik = accession leading 10 digits (zero-padded).
      2. issuer_cik = first CIK in `ciks_all` that is NOT the filer_cik.
      3. Degenerate fallback: if `ciks_all` contains only the filer or is
         empty, issuer_cik = filer_cik (rare; logged at row layer).

    Per SPEC §11 watch-out #4, confusing the two corrupts
    `distinct_13d_filers_90d` and breaks any future filer-reputation work
    (XD-2 v2 ADR). v1 ingest is the single source of truth for the split.

    Args:
      accession:  e.g. "0001234567-26-300001" — the canonical EDGAR accession.
      ciks_all:   the full deduped CIK list from the search-response item,
                  already 10-digit zero-padded (per parse_edgar_search_response).

    Returns:
      (issuer_cik, filer_cik) — both 10-digit zero-padded strings.
    """
    filer_cik_raw = accession.split("-", 1)[0] if accession else "0"
    filer_cik = cik10(filer_cik_raw)

    issuer_cik = ""
    for raw_c in ciks_all:
        padded = cik10(raw_c)
        if padded != filer_cik:
            issuer_cik = padded
            break

    if not issuer_cik:
        # Degenerate: only one CIK or all match the filer. Use ciks_all[0] if
        # any, else the filer itself (preserves the row for forensic access).
        if ciks_all:
            issuer_cik = cik10(ciks_all[0])
        else:
            issuer_cik = filer_cik

    return issuer_cik, filer_cik


# ── CIK→ticker / filer-name resolvers (local wrappers; test-patchable) ───────

def resolve_cik_to_ticker(
    cik: str,
    user_agent: str,
    cache: dict[str, dict] | None = None,
) -> dict:
    """Issuer-side CIK→ticker resolution.

    Local wrapper so `patch.object(xd13g, "fetch_edgar", …)` in tests reaches
    the underlying call (identical pattern to EK-A1 / F4-A1 / gap #8).
    """
    key = cik10(cik)
    if cache is not None and key in cache:
        return cache[key]
    url = submissions_url(key)
    raw = fetch_edgar(url, user_agent=user_agent)
    parsed = parse_submissions_response(raw)
    if cache is not None:
        cache[key] = parsed
    return parsed


def resolve_filer_cik_to_name(
    filer_cik: str,
    user_agent: str,
    cache: dict[str, dict] | None = None,
) -> dict:
    """Filer-side CIK→name resolution (XD-12 — optional, gated by CLI flag).

    Reads the same EDGAR submissions-API endpoint as the issuer resolver.
    For institutional filers (Vanguard, BlackRock, hedge funds, etc.) the
    `name` field carries the entity name. For natural-person filers (a rare
    13G case), it carries the person's full name.

    Returns:
      { "filer_cik": "0001234567", "name": "Vanguard Group Inc" }

    Per XD-2, the filer-reputation classifier itself is deferred to v2 ADR;
    the v1 ingest only POPULATES `filer_name` so v2 has interpretable data
    to draw on. v1's composite weights all filers 1.0.
    """
    key = cik10(filer_cik)
    if cache is not None and key in cache:
        return cache[key]
    url = submissions_url(key)
    raw = fetch_edgar(url, user_agent=user_agent)
    parsed = parse_submissions_response(raw)
    out = {"filer_cik": key, "name": parsed.get("company_name", "")}
    if cache is not None:
        cache[key] = out
    return out


# ── ClickHouse client + table DDL ────────────────────────────────────────────

def ch_client():
    """Match credential defaults used by the other Python ingest scripts."""
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
        database=os.getenv("CLICKHOUSE_DATABASE", "quantlab"),
    )


def ensure_schedule_13d_g_filings_table(client) -> None:
    """Create quantlab.schedule_13d_g_filings if missing.

    Schema per SPEC §6: one row per (issuer_cik, accession). A single 13D
    filing on a single issuer expands to one row; amendments (SC 13D/A,
    SC 13G/A) each count as their own row with `is_amendment = 1`.
    ReplacingMergeTree(ingested_at) means re-runs are safe; the LATEST
    insert wins per key.

    DDL byte-identical to `scripts/migrate_create_schedule_13d_g_filings.ts`'s
    `PLANNED_DDL` constant — drift between them would surface as silent
    schema divergence between lazy-create (ingest) and operator-applied
    migration. Drift check at the migration's test layer.
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.schedule_13d_g_filings (
            accession             String,
            issuer_cik            String,
            filer_cik             String,
            filer_name            String DEFAULT '',
            issuer_ticker         LowCardinality(String) DEFAULT '',
            form_type             LowCardinality(String),
            is_amendment          UInt8 DEFAULT 0,
            accepted_at           DateTime,
            period_of_report      Date,
            filing_url            String DEFAULT '',
            source                LowCardinality(String) DEFAULT 'sec_edgar_full_text_search',
            ingested_at           DateTime DEFAULT now()
        ) ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (issuer_cik, accession)
        SETTINGS index_granularity = 1024
    """)


# ── Row builder ──────────────────────────────────────────────────────────────

def build_schedule_13d_g_rows(
    filings: list[dict],
    ticker_resolver,
    filer_name_resolver=None,
) -> tuple[list[dict], list[dict]]:
    """Expand each filing into one schedule_13d_g_filings row.

    `ticker_resolver(issuer_cik) -> dict` is called once per unique issuer
    CIK to populate `issuer_ticker`. Cached by the caller.

    `filer_name_resolver(filer_cik) -> dict` is optional. When set (i.e.
    `--resolve-filer-names`), it's called once per unique filer CIK to
    populate `filer_name`. When None (default), `filer_name` stays ''.

    Returns:
      (rows, issuer_entries)
        rows:           list of dicts shaped for write_schedule_13d_g_filings
        issuer_entries: list of {"cik", "ticker", "former_tickers", "company_name"}
                        shaped for write_cik_ticker_map (reuses existing table)

    Per XD-7 / XD-14: one row per (issuer_cik, accession). The accession is
    globally unique per filing; amendments produce new accessions.
    """
    rows: list[dict] = []
    issuer_cache: dict[str, dict] = {}
    filer_name_cache: dict[str, dict] = {}
    for f in filings:
        accession = f.get("accession", "")
        if not accession:
            continue

        # Per XD-7 + §11 watch-out #4: split issuer_cik from filer_cik.
        ciks_all = f.get("ciks_all") or ([f.get("cik", "")] if f.get("cik") else [])
        issuer_cik, filer_cik = extract_issuer_and_filer_ciks(accession, ciks_all)

        # Issuer-side ticker resolution (cache by CIK).
        if issuer_cik in issuer_cache:
            issuer_info = issuer_cache[issuer_cik]
        else:
            issuer_info = ticker_resolver(issuer_cik) or {}
            issuer_cache[issuer_cik] = issuer_info
        issuer_ticker = (issuer_info.get("ticker") or "").upper()

        # Filer-side name resolution (optional — XD-12 gated by CLI flag).
        filer_name = ""
        if filer_name_resolver is not None and filer_cik:
            if filer_cik in filer_name_cache:
                filer_info = filer_name_cache[filer_cik]
            else:
                filer_info = filer_name_resolver(filer_cik) or {}
                filer_name_cache[filer_cik] = filer_info
            filer_name = filer_info.get("name", "") or ""

        form_type = f.get("form_type", "")
        # Per XD-4 + §11 watch-out #5: is_amendment derived ONLY from the
        # form_type suffix. EDGAR exposes form type as the full string
        # including '/A'; some JSON responses have a separate `is_amendment`
        # field but it is NOT universally populated. Suffix is canonical.
        is_amendment = 1 if form_type.endswith("/A") else 0

        rows.append({
            "accession": accession,
            "issuer_cik": issuer_cik,
            "filer_cik": filer_cik,
            "filer_name": filer_name,
            "issuer_ticker": issuer_ticker,
            "form_type": form_type,
            "is_amendment": is_amendment,
            "accepted_at": f["accepted_at"],
            "period_of_report": f.get("period_of_report") or _dt.date(1970, 1, 1),
            "filing_url": f.get("filing_url", ""),
        })

    issuer_entries = list(issuer_cache.values())
    return rows, issuer_entries


# ── Writers ──────────────────────────────────────────────────────────────────

def write_schedule_13d_g_filings(client, rows: list[dict]) -> int:
    """Insert rows into quantlab.schedule_13d_g_filings. Returns rows written.

    Idempotent per ReplacingMergeTree(ingested_at) + the (issuer_cik,
    accession) ORDER BY — re-runs collapse duplicates after merges; the
    most-recent ingested_at wins.
    """
    if not rows:
        return 0
    columns = [
        "accession", "issuer_cik", "filer_cik", "filer_name",
        "issuer_ticker", "form_type", "is_amendment",
        "accepted_at", "period_of_report", "filing_url",
    ]
    data = [[r[c] for c in columns] for r in rows]
    client.insert("schedule_13d_g_filings", data, column_names=columns)
    return len(rows)


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    args = parse_args()
    apply_mode = bool(args.apply) and not bool(args.dry_run)

    end_date = args.end_date or _dt.date.today()
    start_date = args.start_date or (end_date - _dt.timedelta(days=90))
    snapshot_date = args.snapshot_date or end_date

    # Resolve the JSON source: --from-file > --url > computed-default
    if args.from_file:
        path = Path(args.from_file)
        if not path.exists():
            print(f"[edgar-13d-g] FATAL: --from-file path does not exist: {path}", file=sys.stderr)
            return 2
        json_bytes = path.read_bytes()
        source_for_log = str(path.name)
    else:
        url = args.url or build_schedule_13d_g_search_url(EDGAR_SEARCH_BASE, start_date, end_date)
        print(f"[edgar-13d-g] fetching {url}")
        try:
            json_bytes = fetch_edgar(url, user_agent=args.user_agent)
        except urllib.error.HTTPError as e:
            print(
                f"[edgar-13d-g] FATAL: HTTP {e.code} fetching {url}. "
                f"\nThe EDGAR full-text search endpoint may have moved or the "
                f"query syntax may have changed. Operator paths:"
                f"\n  1. Pass --url <verified-url> with the corrected endpoint."
                f"\n  2. Download the JSON manually via browser + pass --from-file <path>."
                f"\n  3. Narrow --start-date to reduce response size."
                f"\nEDGAR full-text search is documented at "
                f"https://www.sec.gov/edgar/sec-api-documentation .",
                file=sys.stderr,
            )
            return 3
        except urllib.error.URLError as e:
            print(f"[edgar-13d-g] FATAL: URL error fetching {url}: {e}", file=sys.stderr)
            return 3
        source_for_log = url

    print(f"[edgar-13d-g] parsing JSON ({len(json_bytes)} bytes, source={source_for_log})")
    try:
        filings = parse_edgar_search_response(json_bytes)
    except (ValueError, json.JSONDecodeError) as e:
        print(f"[edgar-13d-g] FATAL: JSON parse failed: {e}", file=sys.stderr)
        return 4

    # Per XD-1 + SPEC §9.3 T-XD13I-12: restrict to Schedule 13D/G form types
    # at parse time. The search URL already filters, but --from-file responses
    # or --url overrides may include other form types.
    filings = [f for f in filings if f["form_type"] in DEFAULT_FORMS_13D_G]
    print(f"[edgar-13d-g] parsed {len(filings)} Schedule 13D/G filings from search response")

    # SPEC EDF-5 / XD-7: acceptance-date filter — load-bearing anti-leak gate.
    filings_in_window = filter_by_acceptance_date(filings, snapshot_date)
    rejected = len(filings) - len(filings_in_window)
    if rejected > 0:
        print(f"[edgar-13d-g] filtered out {rejected} filings with accepted_at > {snapshot_date} (EDF-5 / XD-7 anti-leak)")

    if not apply_mode:
        print("[edgar-13d-g] dry-run — no CH write, no submissions-API resolves. Use --apply to persist.")
        if filings_in_window:
            sample = filings_in_window[0]
            issuer_cik, filer_cik = extract_issuer_and_filer_ciks(
                sample["accession"], sample.get("ciks_all") or [sample.get("cik", "")],
            )
            print(
                f"[edgar-13d-g] sample filing: issuer_cik={issuer_cik} filer_cik={filer_cik} "
                f"accession={sample['accession']} form={sample['form_type']} accepted={sample['accepted_at']}"
            )
        return 0

    # Apply mode: resolve issuer CIKs (+ optional filer names), build rows.
    issuer_cache: dict[str, dict] = {}
    filer_name_cache: dict[str, dict] = {}

    def _ticker_for(cik: str) -> dict:
        try:
            return resolve_cik_to_ticker(cik, user_agent=args.user_agent, cache=issuer_cache)
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"[edgar-13d-g] WARN issuer CIK→ticker resolve failed for {cik}: {e}", file=sys.stderr)
            return {"cik": cik10(cik), "ticker": "", "former_tickers": [], "company_name": ""}

    def _filer_name_for(filer_cik: str) -> dict:
        try:
            return resolve_filer_cik_to_name(filer_cik, user_agent=args.user_agent, cache=filer_name_cache)
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"[edgar-13d-g] WARN filer CIK→name resolve failed for {filer_cik}: {e}", file=sys.stderr)
            return {"filer_cik": cik10(filer_cik), "name": ""}

    filer_resolver = _filer_name_for if args.resolve_filer_names else None
    rows, _issuer_entries = build_schedule_13d_g_rows(
        filings_in_window, _ticker_for, filer_resolver,
    )
    print(f"[edgar-13d-g] built {len(rows)} 13D/G filing rows ({len(issuer_cache)} unique issuers)")

    client = ch_client()
    ensure_schedule_13d_g_filings_table(client)
    ensure_cik_ticker_map_table(client)
    written = write_schedule_13d_g_filings(client, rows)
    issuers_written = write_cik_ticker_map(client, issuer_cache.values())
    print(
        f"[edgar-13d-g] OK | wrote {written} rows to quantlab.schedule_13d_g_filings "
        f"| cached {issuers_written} issuer CIK→ticker entries"
        + (f" | resolved {len(filer_name_cache)} filer names" if args.resolve_filer_names else "")
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
