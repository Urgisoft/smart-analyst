"""
SEC EDGAR bulk **Form 345** insider-data-set ingest -> quantlab.insider_trades
(+ quantlab.insider_ciks). A ~1000× faster replacement for the per-filing
EDGAR-XML crawl in `scripts/sec_edgar_form4_ingest.py`, with the SAME
EDGAR-canonical provenance.

WHY BULK
--------
The D7 full-market backfill (lengthen `insider_trades` over 2024-07…2025-11)
was running as a ~15-25h per-filing XML crawl (one HTTP body-fetch per filing).
SEC publishes the exact same Form 4 data as bulk quarterly ZIPs:

    https://www.sec.gov/files/structureddata/data/insider-transactions-data-sets/{YYYY}q{N}_form345.zip

(~8 MB each, 2019q1→present). One ZIP carries an entire quarter of filings as
tab-separated tables; parsing it is minutes, not hours. This script ingests
those ZIPs into the SAME `quantlab.insider_trades` table the XML path writes,
with byte-compatible row shapes so ReplacingMergeTree collapses bulk rows
against any existing XML-path rows for the same filing.

CANONICAL-SOURCE EQUIVALENCE (load-bearing — ADR-052 D1)
--------------------------------------------------------
Rows written here carry `source = 'sec_edgar_form4_xml'` — the SAME canonical
tag the per-filing XML path uses. This is deliberate and correct:

  ADR-052 D1 gates the cluster-identity path on the *source of the
  reporting-person identity* — it requires the EDGAR-canonical reporting-person
  CIK and rejects only synthetic-identity sources (e.g. Finnhub's
  `person_cik` name-hash, S96-145). It does NOT gate on the *fetch mechanism*.

  Bulk Form 345 rows carry the real EDGAR reporting-person CIK
  (`REPORTINGOWNER.RPTOWNERCIK`) — the identical canonical identity the XML path
  extracts from `<rptOwnerCik>`. They therefore belong to the SAME canonical
  equivalence class and MUST carry the same `source` tag so they automatically
  count in every downstream canonical-source filter AND the coverage-floor
  query with ZERO composite/repository change. Introducing a NEW source value
  would silently exclude bulk rows from those filters (a coverage bug) and would
  require touching every canonical-source filter site. Do NOT do that.

MAPPING (one row per non-derivative transaction)
------------------------------------------------
Three bulk TSVs are joined on ACCESSION_NUMBER:
  SUBMISSION.tsv     — one row per filing (FILING_DATE, DOCUMENT_TYPE, issuer)
  NONDERIV_TRANS.tsv — one row per non-derivative transaction
  REPORTINGOWNER.tsv — one+ rows per filing (reporting person CIK + relationship)

  accession        ← ACCESSION_NUMBER
  transaction_id   ← 0-based index within the accession, NONDERIV_TRANS_SK ASC
                     (mirrors the XML path's document-order index — see
                     `assign_transaction_ids`; the cross-check MEASURES the
                     overlap)
  issuer_cik       ← cik10(SUBMISSION.ISSUERCIK)
  issuer_ticker    ← SUBMISSION.ISSUERTRADINGSYMBOL.upper()
  person_cik       ← cik10(first REPORTINGOWNER.RPTOWNERCIK)  (XML path uses the
                     first reporting owner; most filings have exactly one)
  person_name      ← first REPORTINGOWNER.RPTOWNERNAME
  role_flags       ← parse first owner's RPTOWNER_RELATIONSHIP into the bitmask
                     (Director=1, Officer=2, TenPercentOwner=4, Other=8)
  transaction_code ← NONDERIV_TRANS.TRANS_CODE  (ALL codes stored; composite
                     filters {P,S} downstream — F4-4 / S93-37)
  transaction_date ← parse NONDERIV_TRANS.TRANS_DATE (DD-MON-YYYY); missing /
                     unparseable → 1970-01-01 sentinel; clamped to CH-Date range
  accepted_at      ← parse SUBMISSION.FILING_DATE (DD-MON-YYYY) → DateTime at
                     00:00:00 (the F4-10 anti-leak anchor; same day-granularity
                     the XML path stores)
  shares           ← float(TRANS_SHARES or 0)   (defensive)
  price_per_share  ← float(TRANS_PRICEPERSHARE or 0)
  dollar_amount    ← shares * price_per_share   (computed at ingest)
  filing_url       ← '' (best-effort; not load-bearing — the XML path stores the
                     primary-doc URL, so this differs, but `filing_url` is NOT
                     part of the dedup key or any read path)
  source           ← 'sec_edgar_form4_xml'  (see CANONICAL-SOURCE above)

Restricted to DOCUMENT_TYPE ∈ {'4','4/A'} (Form 3/5 excluded — matches the XML
path's form filter).

Idempotent per the existing `quantlab.insider_trades`
ReplacingMergeTree(ingested_at) ORDER BY (issuer_cik, accession, transaction_id)
— re-runs / overlap with XML-path rows collapse on merge; the latest
ingested_at wins.

CONVENTIONS REUSED from `scripts/sec_edgar_form4_ingest.py` (do not reinvent):
  - `cik10` normalization                            (from _sec_edgar_helpers)
  - the role_flags bitmask constants                 (mirrored below)
  - `ensure_insider_trades_table` / `ensure_insider_ciks_table`
                                                      (imported, CREATE IF NOT
                                                       EXISTS — no DDL added)
  - `write_insider_trades` / `write_insider_ciks`     (imported)
  - the CH-Date clamp + `ch_client`                   (imported / mirrored)
  - the (issuer_cik, accession, transaction_id) dedup key

DATA-SOURCE POLICY (CLAUDE.md): SEC EDGAR / structured-data sets are a free,
pre-authorized source. SEC requires a contact-info User-Agent on every request.
Download failures + per-row schema-validation failures raise / warn loudly; a
single bad row never crashes the batch (warn-and-continue), but a structurally
invalid TSV (missing required header) is a loud FATAL — no silent partial.

USAGE
-----
  # dry-run + cross-check (THIS cycle — no CH write):
  .venv/Scripts/python.exe scripts/sec_edgar_form345_bulk_ingest.py \\
        --quarters 2025q4 --dry-run --cross-check-month 2025-12

  # quarter range:
  .venv/Scripts/python.exe scripts/sec_edgar_form345_bulk_ingest.py \\
        --start-quarter 2024q3 --end-quarter 2025q4 --dry-run

  # apply (NOT this cycle — orchestrator applies after reviewing the cross-check):
  .venv/Scripts/python.exe scripts/sec_edgar_form345_bulk_ingest.py \\
        --quarters 2025q4 --apply
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import io
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

# Make the sibling helpers + XML-path ingest importable when this script is run
# as `python scripts/sec_edgar_form345_bulk_ingest.py` (no package context).
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from _sec_edgar_helpers import cik10  # noqa: E402  (sys.path manipulation above)

# REUSE the XML-path writers + table-DDL + CH client verbatim (no DDL added; no
# reinvention). These are the exact same functions the per-filing crawl uses.
import sec_edgar_form4_ingest as _xmlpath  # noqa: E402

ch_client = _xmlpath.ch_client
ensure_insider_trades_table = _xmlpath.ensure_insider_trades_table
ensure_insider_ciks_table = _xmlpath.ensure_insider_ciks_table
write_insider_trades = _xmlpath.write_insider_trades
write_insider_ciks = _xmlpath.write_insider_ciks


# ── Configuration ────────────────────────────────────────────────────────────

# SEC requires a contact-info User-Agent on every request. Purpose-tagged so
# EDGAR access logs distinguish bulk-set traffic from the per-filing crawl.
DEFAULT_USER_AGENT = "SignalForge/form345-bulk-ingest u0249898@gmail.com"

# Bulk Form 345 data-set URL template (verified live 2026-05-30).
BULK_ZIP_URL_TEMPLATE = (
    "https://www.sec.gov/files/structureddata/data/"
    "insider-transactions-data-sets/{quarter}_form345.zip"
)

# Gitignored download cache (skip re-download if the ZIP is already present).
CACHE_DIR = _SCRIPT_DIR.parent / "logs" / "_form345_cache"

# Canonical-source tag — SAME as the XML path. See module docstring
# CANONICAL-SOURCE EQUIVALENCE. Mirrors the DEFAULT in
# `ensure_insider_trades_table`'s DDL (`source ... DEFAULT 'sec_edgar_form4_xml'`).
CANONICAL_SOURCE = "sec_edgar_form4_xml"

# Form filter — match the XML path (exclude Form 3 / Form 5).
FORM4_DOCUMENT_TYPES = frozenset({"4", "4/A"})

# Insider role bitmask (mirrors scripts/sec_edgar_form4_ingest.py F4-3 / SPEC §6.2).
ROLE_BIT_DIRECTOR = 1 << 0          # 1
ROLE_BIT_OFFICER = 1 << 1           # 2
ROLE_BIT_TEN_PCT_OWNER = 1 << 2     # 4
ROLE_BIT_OTHER = 1 << 3             # 8

# CH `Date` column range clamp (mirrors the XML path's defensive posture; the
# CH Date type is unsigned-days-from-epoch and rejects out-of-range values).
_CH_DATE_MIN = _dt.date(1970, 1, 1)
_CH_DATE_MAX = _dt.date(2149, 6, 6)
_DATE_SENTINEL = _dt.date(1970, 1, 1)

# DD-MON-YYYY month-abbreviation table. The SEC bulk sets emit ENGLISH
# upper-case month abbreviations (e.g. "31-OCT-2025"). We parse with an
# explicit table rather than `strptime("%d-%b-%Y")` so the parser is
# locale-INDEPENDENT (the SSGA-adapter watch-out S96 #7 flagged strptime
# month-name locale drift on non-English Windows).
_MONTHS = {
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9, "OCT": 10, "NOV": 11, "DEC": 12,
}


# ── Pure parse helpers (unit-pinned) ─────────────────────────────────────────

def parse_ddmonyyyy(s: str) -> _dt.date | None:
    """Parse a SEC bulk `DD-MON-YYYY` date (e.g. '31-OCT-2025').

    Locale-independent (explicit month table). Returns None on any malformed /
    empty input — callers substitute the 1970-01-01 sentinel (transaction_date)
    or skip the row (filing_date, which is the anti-leak anchor and must be real).
    """
    if not s:
        return None
    parts = s.strip().upper().split("-")
    if len(parts) != 3:
        return None
    day_s, mon_s, year_s = parts
    mon = _MONTHS.get(mon_s)
    if mon is None:
        return None
    try:
        return _dt.date(int(year_s), mon, int(day_s))
    except (ValueError, TypeError):
        return None


def clamp_ch_date(d: _dt.date) -> _dt.date:
    """Clamp a date into the CH `Date` representable range (mirrors XML path)."""
    if d < _CH_DATE_MIN:
        return _CH_DATE_MIN
    if d > _CH_DATE_MAX:
        return _CH_DATE_MAX
    return d


def parse_float_or_zero(s: str) -> float:
    """Defensive float parse — empty / unparseable → 0.0 (matches XML path)."""
    if s is None:
        return 0.0
    s = s.strip()
    if not s:
        return 0.0
    try:
        return float(s)
    except (ValueError, TypeError):
        return 0.0


def parse_role_flags(relationship: str) -> int:
    """Parse a bulk `RPTOWNER_RELATIONSHIP` free-text combo into the role bitmask.

    The bulk field is a comma-separated combo of canonical tokens
    (`Director`, `Officer`, `TenPercentOwner`, `Other`) — e.g. `Officer`,
    `Director,Officer`, `Director,Officer,TenPercentOwner`. Parsed
    case-insensitively via substring match so cosmetic upstream variants
    ("10% Owner", "Ten Percent Owner") still map:

      contains "director"             → ROLE_BIT_DIRECTOR        (1)
      contains "officer"              → ROLE_BIT_OFFICER         (2)
      contains "ten" or "10%"         → ROLE_BIT_TEN_PCT_OWNER   (4)
      contains "other"                → ROLE_BIT_OTHER           (8)

    Matches the XML path's per-boolean bitmask (parse_role_flags in
    sec_edgar_form4_ingest.py reads <isDirector>/<isOfficer>/... booleans; the
    bulk free-text is the same information in string form).
    """
    if not relationship:
        return 0
    lower = relationship.lower()
    flags = 0
    if "director" in lower:
        flags |= ROLE_BIT_DIRECTOR
    if "officer" in lower:
        flags |= ROLE_BIT_OFFICER
    if "ten" in lower or "10%" in lower:
        flags |= ROLE_BIT_TEN_PCT_OWNER
    if "other" in lower:
        flags |= ROLE_BIT_OTHER
    return flags


def assign_transaction_ids(
    sks_for_accession: list[str],
) -> dict[str, int]:
    """Assign a 0-based `transaction_id` per non-derivative transaction within
    one accession, ordered by `NONDERIV_TRANS_SK` ASCending.

    Returns {sk -> transaction_id}. The XML path indexes transactions in
    document order (the order `<nonDerivativeTransaction>` elements appear in
    the Form 4 XML). The bulk set has no explicit document-order column; we use
    NONDERIV_TRANS_SK (a monotonically-increasing SEC surrogate key) ascending
    as the best available proxy. The cross-check MEASURES whether this matches
    the XML path's numbering (the key-overlap %).

    SKs are compared numerically when they parse as ints (the observed form),
    falling back to lexical for safety.
    """
    def _sk_key(sk: str):
        try:
            return (0, int(sk))
        except (ValueError, TypeError):
            return (1, sk)

    ordered = sorted(sks_for_accession, key=_sk_key)
    return {sk: idx for idx, sk in enumerate(ordered)}


# ── TSV reading (header-name → index, robust to column reordering) ────────────

def _read_tsv_rows(raw: bytes, required_headers: tuple[str, ...], label: str):
    """Yield each TSV data row as a dict keyed by header name.

    Uses csv.reader(delimiter='\\t') for correctness (handles quoted fields).
    Validates that every `required_headers` entry is present — a missing
    required header is a LOUD FATAL (raises ValueError), never a silent partial
    (data-source policy: schema-validate on every fetch).
    """
    text = raw.decode("utf-8", errors="replace")
    reader = csv.reader(io.StringIO(text), delimiter="\t")
    try:
        header = next(reader)
    except StopIteration:
        raise ValueError(f"{label}: empty TSV (no header row)")
    idx = {name: i for i, name in enumerate(header)}
    missing = [h for h in required_headers if h not in idx]
    if missing:
        raise ValueError(
            f"{label}: bulk schema drift — missing required column(s) {missing}. "
            f"Found headers: {header}"
        )
    n = len(header)
    for row in reader:
        # Defensive: a short row (fewer cells than the header) is padded with
        # "" so a single malformed line never IndexErrors the batch.
        if len(row) < n:
            row = row + [""] * (n - len(row))
        yield {name: row[i] for name, i in idx.items()}


# ── ZIP download + extract ────────────────────────────────────────────────────

def quarter_zip_path(quarter: str) -> Path:
    """Local cache path for a quarter's ZIP."""
    return CACHE_DIR / f"{quarter}_form345.zip"


def download_quarter_zip(
    quarter: str,
    user_agent: str,
    *,
    opener=None,
) -> Path:
    """Download (or reuse cached) the bulk Form 345 ZIP for a quarter.

    Skips the download if the ZIP is already present in CACHE_DIR. Raises loudly
    on HTTP / URL error (no silent partial). `opener` is a test seam — a
    callable(url, user_agent) -> bytes.
    """
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dest = quarter_zip_path(quarter)
    if dest.exists() and dest.stat().st_size > 0:
        print(f"[form345-bulk] using cached ZIP {dest} ({dest.stat().st_size} bytes)")
        return dest
    url = BULK_ZIP_URL_TEMPLATE.format(quarter=quarter)
    print(f"[form345-bulk] downloading {url}")
    if opener is not None:
        body = opener(url, user_agent)
    else:
        req = urllib.request.Request(url, headers={"User-Agent": user_agent})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read()
        except urllib.error.HTTPError as e:
            raise RuntimeError(
                f"[form345-bulk] FATAL: HTTP {e.code} downloading {url}. "
                f"The quarter may not be published yet, or the URL pattern "
                f"may have changed. Verify at "
                f"https://www.sec.gov/dera/data/form-345 ."
            ) from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"[form345-bulk] FATAL: URL error downloading {url}: {e}") from e
    dest.write_bytes(body)
    print(f"[form345-bulk] cached {dest} ({len(body)} bytes)")
    return dest


# ── Quarter parse ──────────────────────────────────────────────────────────────

def parse_quarter_zip(zip_path: Path) -> tuple[list[dict], list[dict], dict]:
    """Parse one quarter ZIP into (trade_rows, insider_entries, stats).

    trade_rows: list of dicts shaped for `write_insider_trades` (same columns
                the XML-path builder emits, plus 'source').
    insider_entries: list of {"person_cik", "name"} for `write_insider_ciks`,
                     deduped on person_cik.
    stats: diagnostics dict (counts, multi-owner filings, schema notes).
    """
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
        for required in ("SUBMISSION.tsv", "NONDERIV_TRANS.tsv", "REPORTINGOWNER.tsv"):
            if required not in names:
                raise ValueError(
                    f"[form345-bulk] FATAL: {zip_path.name} missing {required} "
                    f"(found {sorted(names)})"
                )
        sub_raw = zf.read("SUBMISSION.tsv")
        trans_raw = zf.read("NONDERIV_TRANS.tsv")
        owner_raw = zf.read("REPORTINGOWNER.tsv")

    # ── SUBMISSION: accession -> filing metadata (Form 4 / 4-A only) ──────────
    submissions: dict[str, dict] = {}
    sub_total = 0
    sub_dropped_no_date = 0
    for r in _read_tsv_rows(
        sub_raw,
        ("ACCESSION_NUMBER", "FILING_DATE", "DOCUMENT_TYPE", "ISSUERCIK",
         "ISSUERTRADINGSYMBOL"),
        "SUBMISSION.tsv",
    ):
        sub_total += 1
        if r["DOCUMENT_TYPE"] not in FORM4_DOCUMENT_TYPES:
            continue
        acc = r["ACCESSION_NUMBER"].strip()
        if not acc:
            continue
        filing_date = parse_ddmonyyyy(r["FILING_DATE"])
        if filing_date is None:
            # accepted_at is the F4-10 anti-leak anchor — it MUST be real.
            # A Form 4 with no parseable FILING_DATE is dropped (loud count).
            sub_dropped_no_date += 1
            continue
        submissions[acc] = {
            "issuer_cik": cik10(r["ISSUERCIK"]),
            "issuer_ticker": (r["ISSUERTRADINGSYMBOL"] or "").strip().upper(),
            "accepted_at": _dt.datetime(filing_date.year, filing_date.month, filing_date.day),
        }

    # ── REPORTINGOWNER: accession -> first reporting owner ───────────────────
    # The XML path uses the FIRST reporting owner. The bulk TSV has no explicit
    # owner-order column; the first row encountered for an accession is taken as
    # "first" (stable file order). We also count multi-owner filings.
    first_owner: dict[str, dict] = {}
    owner_counts: dict[str, int] = {}
    for r in _read_tsv_rows(
        owner_raw,
        ("ACCESSION_NUMBER", "RPTOWNERCIK", "RPTOWNERNAME", "RPTOWNER_RELATIONSHIP"),
        "REPORTINGOWNER.tsv",
    ):
        acc = r["ACCESSION_NUMBER"].strip()
        if not acc:
            continue
        owner_counts[acc] = owner_counts.get(acc, 0) + 1
        if acc not in first_owner:
            first_owner[acc] = {
                "person_cik": cik10(r["RPTOWNERCIK"]),
                "person_name": (r["RPTOWNERNAME"] or "").strip(),
                "role_flags": parse_role_flags(r["RPTOWNER_RELATIONSHIP"]),
            }
    multi_owner_filings = sum(1 for c in owner_counts.values() if c > 1)

    # ── NONDERIV_TRANS: collect per-accession, assign transaction_ids ────────
    # First pass: gather (sk, fields) per accession to assign deterministic
    # 0-based ids by SK ASC. Only accessions present in `submissions`
    # (Form 4 / 4-A with a parseable filing date) are kept.
    per_acc_txns: dict[str, list[dict]] = {}
    trans_total = 0
    skipped_no_submission = 0
    for r in _read_tsv_rows(
        trans_raw,
        ("ACCESSION_NUMBER", "NONDERIV_TRANS_SK", "TRANS_DATE", "TRANS_CODE",
         "TRANS_SHARES", "TRANS_PRICEPERSHARE"),
        "NONDERIV_TRANS.tsv",
    ):
        trans_total += 1
        acc = r["ACCESSION_NUMBER"].strip()
        if not acc or acc not in submissions:
            skipped_no_submission += 1
            continue
        per_acc_txns.setdefault(acc, []).append({
            "sk": r["NONDERIV_TRANS_SK"].strip(),
            "transaction_code": (r["TRANS_CODE"] or "").strip(),
            "transaction_date_raw": r["TRANS_DATE"],
            "shares": parse_float_or_zero(r["TRANS_SHARES"]),
            "price_per_share": parse_float_or_zero(r["TRANS_PRICEPERSHARE"]),
        })

    # Second pass: build the canonical trade rows.
    trade_rows: list[dict] = []
    insider_cache: dict[str, dict] = {}
    accessions_missing_owner = 0
    for acc, txns in per_acc_txns.items():
        sub = submissions[acc]
        owner = first_owner.get(acc)
        if owner is None:
            # A NONDERIV_TRANS row whose accession has no REPORTINGOWNER row.
            # Rare/malformed; person_cik would be empty -> the composite's
            # distinct-person count would treat it as identity-less. Skip the
            # filing (count it) rather than emit identity-less rows.
            accessions_missing_owner += 1
            continue
        id_map = assign_transaction_ids([t["sk"] for t in txns])
        person_cik = owner["person_cik"]
        person_name = owner["person_name"]
        role_flags = owner["role_flags"]
        if person_cik and person_cik not in insider_cache:
            insider_cache[person_cik] = {"person_cik": person_cik, "name": person_name}
        for t in txns:
            txn_date = parse_ddmonyyyy(t["transaction_date_raw"]) or _DATE_SENTINEL
            txn_date = clamp_ch_date(txn_date)
            shares = t["shares"]
            price = t["price_per_share"]
            trade_rows.append({
                "accession": acc,
                "transaction_id": id_map[t["sk"]],
                "issuer_cik": sub["issuer_cik"],
                "issuer_ticker": sub["issuer_ticker"],
                "person_cik": person_cik,
                "role_flags": role_flags,
                "transaction_code": t["transaction_code"],
                "transaction_date": txn_date,
                "accepted_at": sub["accepted_at"],
                "shares": shares,
                "price_per_share": price,
                "dollar_amount": shares * price,
                "filing_url": "",
                "source": CANONICAL_SOURCE,
            })

    stats = {
        "submission_total_rows": sub_total,
        "submission_form4_kept": len(submissions),
        "submission_dropped_no_date": sub_dropped_no_date,
        "reporting_owner_accessions": len(owner_counts),
        "multi_owner_filings": multi_owner_filings,
        "nonderiv_total_rows": trans_total,
        "nonderiv_skipped_no_submission": skipped_no_submission,
        "accessions_missing_owner": accessions_missing_owner,
        "trade_rows_built": len(trade_rows),
        "unique_insiders": len(insider_cache),
    }
    return trade_rows, list(insider_cache.values()), stats


def expand_quarters(start_q: str, end_q: str) -> list[str]:
    """Inclusive list of 'YYYYqN' quarters from start_q to end_q."""
    def _parse(q: str) -> tuple[int, int]:
        q = q.strip().lower()
        if "q" not in q:
            raise ValueError(f"bad quarter spec {q!r} (expected e.g. 2025q4)")
        y, n = q.split("q", 1)
        return int(y), int(n)

    sy, sn = _parse(start_q)
    ey, en = _parse(end_q)
    out: list[str] = []
    y, n = sy, sn
    while (y, n) <= (ey, en):
        out.append(f"{y}q{n}")
        n += 1
        if n > 4:
            n = 1
            y += 1
    return out


# ── Cross-check (dry-run only) ────────────────────────────────────────────────

def _filing_month(row: dict) -> str:
    """The YYYY-MM of a built row's accepted_at (filing month)."""
    a = row["accepted_at"]
    return f"{a.year:04d}-{a.month:02d}"


def run_cross_check(trade_rows: list[dict], month: str, stats_all: dict) -> None:
    """Compare bulk rows for FILING-month `month` against existing
    quantlab.insider_trades rows for the same month. Read-only.

    Prints the 4 deliverable items:
      1. bulk row count vs existing row count for the month
      2. distinct (issuer_cik, accession, transaction_id) keys:
         |bulk∩existing|, |bulk∖existing|, |existing∖bulk|
      3. sample of 10 shared accessions: do shares/price/transaction_code/
         accepted_at agree?
      4. count of multi-reporting-owner filings (from parse stats)
    """
    print("\n" + "=" * 72)
    print(f"CROSS-CHECK — filing month {month} (bulk vs existing insider_trades)")
    print("=" * 72)

    bulk_month = [r for r in trade_rows if _filing_month(r) == month]
    bulk_keys = {
        (r["issuer_cik"], r["accession"], r["transaction_id"]) for r in bulk_month
    }

    try:
        client = ch_client()
    except Exception as e:  # noqa: BLE001 — surface CH-down loudly, don't crash
        print(f"[form345-bulk] CROSS-CHECK SKIPPED: cannot connect to ClickHouse: {e}")
        print("  (Is the quantlab-clickhouse container up at 127.0.0.1:8123?)")
        return

    start = f"{month}-01"
    # Month-end via first-of-next-month exclusive bound.
    y, m = int(month[:4]), int(month[5:7])
    if m == 12:
        nxt = f"{y + 1:04d}-01-01"
    else:
        nxt = f"{y:04d}-{m + 1:02d}-01"

    # (1) existing row count for the filing month (accepted_at-based, the same
    #     anchor the bulk rows use; full-market — no source filter, mirroring
    #     the canonical equivalence-class read path).
    existing_count_q = client.query(
        """
        SELECT count() AS c
        FROM quantlab.insider_trades FINAL
        WHERE accepted_at >= {start:DateTime} AND accepted_at < {nxt:DateTime}
        """,
        parameters={"start": f"{start} 00:00:00", "nxt": f"{nxt} 00:00:00"},
    )
    existing_count = int(existing_count_q.result_rows[0][0]) if existing_count_q.result_rows else 0

    print(f"\n[1] ROW COUNTS for filing month {month}:")
    print(f"    bulk rows produced       : {len(bulk_month)}")
    print(f"    existing insider_trades  : {existing_count}")
    if existing_count:
        print(f"    bulk / existing ratio    : {len(bulk_month) / existing_count:.3f}")

    # (2) key-set overlap. Pull existing keys for the month.
    existing_keys_q = client.query(
        """
        SELECT issuer_cik, accession, transaction_id
        FROM quantlab.insider_trades FINAL
        WHERE accepted_at >= {start:DateTime} AND accepted_at < {nxt:DateTime}
        """,
        parameters={"start": f"{start} 00:00:00", "nxt": f"{nxt} 00:00:00"},
    )
    existing_keys = {
        (str(r[0]), str(r[1]), int(r[2])) for r in existing_keys_q.result_rows
    }
    inter = bulk_keys & existing_keys
    bulk_only = bulk_keys - existing_keys
    existing_only = existing_keys - bulk_keys
    print(f"\n[2] DISTINCT (issuer_cik, accession, transaction_id) KEY OVERLAP:")
    print(f"    |bulk keys|              : {len(bulk_keys)}")
    print(f"    |existing keys|          : {len(existing_keys)}")
    print(f"    |bulk INTERSECT existing|: {len(inter)}")
    print(f"    |bulk MINUS existing|    : {len(bulk_only)}")
    print(f"    |existing MINUS bulk|    : {len(existing_only)}")
    if bulk_keys:
        print(f"    overlap %% of bulk        : {100.0 * len(inter) / len(bulk_keys):.2f}%")
    if existing_keys:
        print(f"    overlap %% of existing    : {100.0 * len(inter) / len(existing_keys):.2f}%")

    # (3) field agreement on a sample of 10 SHARED accessions.
    shared_accessions = sorted({k[1] for k in inter})[:10]
    print(f"\n[3] FIELD AGREEMENT on {len(shared_accessions)} shared accessions:")
    if not shared_accessions:
        print("    (no shared accessions — see [2] overlap; cannot field-compare)")
    else:
        # Index bulk rows by full key for the sampled accessions.
        sampled_set = set(shared_accessions)
        bulk_by_key = {
            (r["issuer_cik"], r["accession"], r["transaction_id"]): r
            for r in bulk_month
            if r["accession"] in sampled_set
        }
        ex_q = client.query(
            """
            SELECT issuer_cik, accession, transaction_id,
                   transaction_code, shares, price_per_share, toString(accepted_at)
            FROM quantlab.insider_trades FINAL
            WHERE accession IN {accs:Array(String)}
            """,
            parameters={"accs": shared_accessions},
        )
        agree = 0
        disagree = 0
        disagreements: list[str] = []
        for row in ex_q.result_rows:
            key = (str(row[0]), str(row[1]), int(row[2]))
            b = bulk_by_key.get(key)
            if b is None:
                continue
            ex_code, ex_shares, ex_price, ex_acc_at = row[3], float(row[4]), float(row[5]), row[6]
            code_ok = (b["transaction_code"] or "") == (ex_code or "")
            shares_ok = abs(b["shares"] - ex_shares) < 1e-6
            price_ok = abs(b["price_per_share"] - ex_price) < 1e-6
            # accepted_at: bulk stores 00:00:00 (day-granularity). Compare on
            # the DATE part — the XML path also stores day-granularity, but a
            # historical XML row may carry the full acceptance timestamp.
            ex_date = str(ex_acc_at)[:10]
            b_date = b["accepted_at"].strftime("%Y-%m-%d")
            date_ok = ex_date == b_date
            if code_ok and shares_ok and price_ok and date_ok:
                agree += 1
            else:
                disagree += 1
                if len(disagreements) < 10:
                    disagreements.append(
                        f"      key={key} code(b={b['transaction_code']!r} e={ex_code!r} ok={code_ok}) "
                        f"shares(b={b['shares']} e={ex_shares} ok={shares_ok}) "
                        f"price(b={b['price_per_share']} e={ex_price} ok={price_ok}) "
                        f"acc_at(b={b_date} e={ex_date} ok={date_ok})"
                    )
        print(f"    transactions compared    : {agree + disagree}")
        print(f"    FULL agreement (4 fields): {agree}")
        print(f"    disagreements            : {disagree}")
        for d in disagreements:
            print(d)

    # (4) multi-reporting-owner filings (parse-time stat).
    print(f"\n[4] MULTI-REPORTING-OWNER FILINGS (whole parsed set):")
    print(f"    multi-owner filings      : {stats_all.get('multi_owner_filings', 0)}")
    print(f"    total owner-accessions   : {stats_all.get('reporting_owner_accessions', 0)}")
    print(f"    accessions missing owner : {stats_all.get('accessions_missing_owner', 0)}")
    print("=" * 72 + "\n")


# ── Argparse + main ────────────────────────────────────────────────────────────

def parse_args(argv=None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--quarters", type=str, default=None,
        help="Comma-separated list of quarters, e.g. '2025q4' or '2024q3,2024q4'.",
    )
    p.add_argument(
        "--start-quarter", type=str, default=None,
        help="Start quarter for a range, e.g. '2024q3' (with --end-quarter).",
    )
    p.add_argument(
        "--end-quarter", type=str, default=None,
        help="End quarter for a range, e.g. '2025q4' (with --start-quarter).",
    )
    p.add_argument(
        "--user-agent", type=str, default=DEFAULT_USER_AGENT,
        help=f"User-Agent header for SEC requests. Default: {DEFAULT_USER_AGENT!r}.",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Download + parse + report; NO CH write (default).",
    )
    p.add_argument(
        "--apply", action="store_true",
        help="Write to CH (idempotent via ReplacingMergeTree). "
             "Without this flag, the script defaults to dry-run.",
    )
    p.add_argument(
        "--cross-check-month", type=str, default=None,
        help="In dry-run, compare produced rows for this FILING month "
             "(YYYY-MM) against existing quantlab.insider_trades. Read-only.",
    )
    return p.parse_args(argv)


def resolve_quarters(args: argparse.Namespace) -> list[str]:
    if args.quarters:
        return [q.strip().lower() for q in args.quarters.split(",") if q.strip()]
    if args.start_quarter and args.end_quarter:
        return expand_quarters(args.start_quarter, args.end_quarter)
    raise SystemExit(
        "[form345-bulk] FATAL: specify --quarters OR (--start-quarter + --end-quarter)."
    )


def main(argv=None) -> int:
    args = parse_args(argv)
    apply_mode = bool(args.apply) and not bool(args.dry_run)
    quarters = resolve_quarters(args)
    print(f"[form345-bulk] quarters: {quarters} | mode: {'APPLY' if apply_mode else 'DRY-RUN'}")

    all_trade_rows: list[dict] = []
    all_insiders: dict[str, dict] = {}
    agg_stats: dict[str, int] = {}

    for q in quarters:
        try:
            zip_path = download_quarter_zip(q, args.user_agent)
        except RuntimeError as e:
            print(str(e), file=sys.stderr)
            return 3
        try:
            rows, insiders, stats = parse_quarter_zip(zip_path)
        except (ValueError, zipfile.BadZipFile) as e:
            print(f"[form345-bulk] FATAL parsing {q}: {e}", file=sys.stderr)
            return 4
        print(
            f"[form345-bulk] {q}: SUBMISSION rows={stats['submission_total_rows']} "
            f"(Form4 kept={stats['submission_form4_kept']}, "
            f"dropped no-date={stats['submission_dropped_no_date']}); "
            f"NONDERIV rows={stats['nonderiv_total_rows']} "
            f"(skipped no-submission={stats['nonderiv_skipped_no_submission']}); "
            f"trade rows built={stats['trade_rows_built']}; "
            f"unique insiders={stats['unique_insiders']}; "
            f"multi-owner filings={stats['multi_owner_filings']}; "
            f"accessions missing owner={stats['accessions_missing_owner']}"
        )
        all_trade_rows.extend(rows)
        for ins in insiders:
            all_insiders.setdefault(ins["person_cik"], ins)
        for k, v in stats.items():
            agg_stats[k] = agg_stats.get(k, 0) + v

    print(
        f"[form345-bulk] TOTAL across {len(quarters)} quarter(s): "
        f"{len(all_trade_rows)} trade rows | {len(all_insiders)} unique insiders"
    )

    if args.cross_check_month:
        run_cross_check(all_trade_rows, args.cross_check_month, agg_stats)

    if not apply_mode:
        print("[form345-bulk] dry-run — NO CH write. Use --apply to persist.")
        if all_trade_rows:
            s = all_trade_rows[0]
            print(
                f"[form345-bulk] sample row: accession={s['accession']} "
                f"txn_id={s['transaction_id']} issuer={s['issuer_ticker']} "
                f"person_cik={s['person_cik']} code={s['transaction_code']} "
                f"accepted={s['accepted_at']} shares={s['shares']} "
                f"price={s['price_per_share']} source={s['source']}"
            )
        return 0

    # Apply mode (NOT run this cycle — orchestrator gates after cross-check).
    client = ch_client()
    ensure_insider_trades_table(client)
    ensure_insider_ciks_table(client)
    written = write_insider_trades(client, all_trade_rows)
    insiders_written = write_insider_ciks(client, list(all_insiders.values()))
    print(
        f"[form345-bulk] OK | wrote {written} rows to quantlab.insider_trades "
        f"| cached {insiders_written} insider CIK entries"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
