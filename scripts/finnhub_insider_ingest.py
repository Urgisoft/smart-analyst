"""
Finnhub insider-transactions ingest -> quantlab.insider_trades (+ insider_ciks).

WHY THIS EXISTS (Cycle 32, s96 #26): the direct SEC EDGAR Form 4 backfill
(`sec_edgar_form4_ingest.py`) is throttled by EDGAR's fair-access limiter on
sustained bulk access — HTTP 429/503 storms after ~3h exhaust the retry pack
and silently skip filings, producing incomplete months. Finnhub re-distributes
the SAME SEC Section-16 data (each row carries `source: "sec"` + the SEC
accession as `id`) via a managed API: ONE call per symbol returns the full
multi-year history, ~500 calls cover the whole S&P 500 in ~10 min, and Finnhub
manages its own rate limits. Operator directed this source (financial-hub MCP
is Finnhub-backed); this ingest uses the same API directly because bulk ETL is
ill-suited to conversational MCP tool calls.

SOURCE: https://finnhub.io/api/v1/stock/insider-transactions?symbol=..&from=..&to=..
Free-tier key via env FINNHUB_API_KEY (the operator's key lives in the Cline
financial-hub MCP config). Free tier: 60 calls/min — the ingest paces itself.

MAPPING to insider_trades (schema parity with the EDGAR ingest):
  accession        <- id (the SEC accession number)
  transaction_id   <- deterministic per-accession counter (rows sorted stably)
  issuer_cik       <- resolved from symbol via quantlab.cik_ticker_map
  issuer_ticker    <- symbol (uppercased)
  person_cik       <- SYNTHETIC: "FH" + sha1(normalized name)[:10]. Finnhub does
                      NOT expose the reporting person's CIK, only the name. The
                      composite's F4-2 cluster-distinctness counts distinct
                      person_cik; a name-derived deterministic id makes "distinct
                      person_cik" == "distinct insider name". Edge cases: two
                      different people sharing a name merge (rare in S&P 500);
                      one person with name-spelling variants splits. Acceptable
                      v1 approximation — documented in HANDOFF (S96-145).
  role_flags       <- 0. Finnhub does not expose Section-16 role bits; the v1
                      composite weights all roles 1.0 (F4-3) so this is inert.
  transaction_code <- transactionCode (P/S/A/F/G/M/J/...; composite filters P/S)
  transaction_date <- transactionDate (clamped to CH-Date range, S96-143)
  accepted_at      <- filingDate at 00:00 (Finnhub's closest acceptance proxy;
                      the F4-10 anti-leak windowing uses accepted_at)
  shares           <- abs(change)  (change is the signed transaction delta)
  price_per_share  <- transactionPrice
  dollar_amount    <- abs(change) * transactionPrice
  filing_url       <- constructed EDGAR index URL (forensic ref)
  source           <- "finnhub"

CROSS-SOURCE DEDUP (no destructive deletes): EDGAR's failure mode skips WHOLE
filings (a 429-exhausted body-fetch returns zero rows for that accession), so
every filing EDGAR DID fetch is complete. Therefore we skip any Finnhub row
whose accession already exists in insider_trades — the existing EDGAR data
(complete per-filing) wins, Finnhub fills only the missing filings. Result: a
complete union with zero double-counting. ReplacingMergeTree on
(issuer_cik, accession, transaction_id) handles intra-source idempotency.

Usage:
  .venv/Scripts/python.exe scripts/finnhub_insider_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/finnhub_insider_ingest.py --apply
  .venv/Scripts/python.exe scripts/finnhub_insider_ingest.py \
        --from-date 2024-01-01 --to-date 2026-05-22 --apply
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import clickhouse_connect

FINNHUB_BASE = "https://finnhub.io/api/v1/stock/insider-transactions"
SOURCE_LABEL = "finnhub"
# CH `Date` representable range (S96-143).
_CH_DATE_MIN = _dt.date(1970, 1, 1)
_CH_DATE_MAX = _dt.date(2149, 6, 6)
# Free tier = 60 calls/min. Pace at ~1 call / 1.1s with margin.
_RATE_SLEEP_SEC = 1.1
_MAX_RETRIES = 4


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument("--from-date", type=lambda s: _dt.date.fromisoformat(s),
                   default=_dt.date(2024, 1, 1),
                   help="Inclusive start (YYYY-MM-DD). Default 2024-01-01 "
                        "(covers the 2y baseline of the earliest 2026 snapshot).")
    p.add_argument("--to-date", type=lambda s: _dt.date.fromisoformat(s),
                   default=_dt.date.today(),
                   help="Inclusive end (YYYY-MM-DD). Default today.")
    p.add_argument("--symbols", type=str, default=None,
                   help="Comma-separated symbols (overrides the SP500 universe). "
                        "Mainly for testing a single name.")
    p.add_argument("--since", type=lambda s: _dt.date.fromisoformat(s),
                   default=_dt.date(2023, 6, 1),
                   help="sp500_constituents membership cutoff for the symbol "
                        "universe (default 2023-06-01). Ignored if --symbols set.")
    p.add_argument("--no-skip-existing", action="store_true",
                   help="Do NOT skip accessions already present (default skips, "
                        "for clean cross-source dedup vs EDGAR rows).")
    p.add_argument("--dry-run", action="store_true",
                   help="Fetch + map + count; no CH write (default).")
    p.add_argument("--apply", action="store_true", help="Write to CH.")
    return p.parse_args()


def ch_client():
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
        database="quantlab",
    )


def synth_person_cik(name: str) -> str:
    """Deterministic synthetic person id from the insider name (Finnhub has no
    reporting-person CIK). Stable across runs so cluster-distinctness + dedup
    are reproducible."""
    norm = " ".join((name or "").strip().upper().split())
    return "FH" + hashlib.sha1(norm.encode("utf-8")).hexdigest()[:10]


def clamp_date(d: _dt.date) -> _dt.date:
    return d if _CH_DATE_MIN <= d <= _CH_DATE_MAX else _CH_DATE_MIN


def load_sp500_universe(client, since: _dt.date) -> list[tuple[str, str]]:
    """Return [(ticker, issuer_cik)] for S&P 500 members since `since`,
    resolved through cik_ticker_map. Same universe as the EDGAR allowlist."""
    rows = client.query(
        """
        SELECT c.t AS ticker, m.cik AS cik
        FROM (
          SELECT DISTINCT upper(ticker) AS t
          FROM quantlab.sp500_constituents FINAL
          WHERE effective_date >= {since:Date}
        ) c
        INNER JOIN (
          SELECT upper(ticker) AS t, cik
          FROM quantlab.cik_ticker_map FINAL
          WHERE cik != ''
        ) m ON m.t = c.t
        ORDER BY ticker
        """,
        parameters={"since": since},
    ).result_rows
    return [(r[0], r[1]) for r in rows]


def load_existing_accessions(client) -> set[str]:
    rows = client.query(
        "SELECT DISTINCT accession FROM quantlab.insider_trades"
    ).result_rows
    return {r[0] for r in rows}


def fetch_finnhub_insider(symbol: str, frm: _dt.date, to: _dt.date, token: str) -> list[dict]:
    """One call returns the full window for a symbol. Retries on 429/5xx."""
    qs = urllib.parse.urlencode({
        "symbol": symbol, "from": frm.isoformat(), "to": to.isoformat(), "token": token,
    })
    url = f"{FINNHUB_BASE}?{qs}"
    delay = 1.0
    for attempt in range(_MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SignalForge/finnhub-ingest"})
            with urllib.request.urlopen(req, timeout=30) as r:
                doc = json.loads(r.read().decode("utf-8", errors="replace"))
            if not isinstance(doc, dict) or "data" not in doc:
                raise ValueError(f"Finnhub schema changed for {symbol}: keys={sorted(doc) if isinstance(doc, dict) else type(doc)}")
            return doc.get("data") or []
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < _MAX_RETRIES - 1:
                time.sleep(delay)
                delay *= 2
                continue
            raise
    return []


def map_rows(symbol: str, issuer_cik: str, raw: list[dict]) -> tuple[list[dict], dict[str, str]]:
    """Map Finnhub rows -> insider_trades dicts + {person_cik: name}. Assigns a
    deterministic per-accession transaction_id (rows sorted stably first)."""
    by_acc: dict[str, list[dict]] = {}
    for x in raw:
        by_acc.setdefault(str(x.get("id", "")), []).append(x)
    out: list[dict] = []
    names: dict[str, str] = {}
    cik_int = str(int(issuer_cik)) if issuer_cik and issuer_cik.isdigit() else issuer_cik.lstrip("0")
    for acc, items in by_acc.items():
        if not acc:
            continue
        items_sorted = sorted(
            items,
            key=lambda r: (str(r.get("transactionDate", "")), str(r.get("transactionCode", "")),
                           float(r.get("change", 0) or 0), float(r.get("transactionPrice", 0) or 0),
                           str(r.get("name", ""))),
        )
        acc_nodash = acc.replace("-", "")
        filing_url = f"https://www.sec.gov/Archives/edgar/data/{cik_int}/{acc_nodash}/" if cik_int else ""
        for tid, x in enumerate(items_sorted):
            name = str(x.get("name", "")).strip()
            pcik = synth_person_cik(name)
            names[pcik] = name
            try:
                tdate = clamp_date(_dt.date.fromisoformat(str(x.get("transactionDate", ""))[:10]))
            except ValueError:
                tdate = _CH_DATE_MIN
            try:
                fdate = _dt.datetime.fromisoformat(str(x.get("filingDate", ""))[:10])
            except ValueError:
                fdate = _dt.datetime(1970, 1, 1)
            change = float(x.get("change", 0) or 0)
            price = float(x.get("transactionPrice", 0) or 0)
            shares = abs(change)
            out.append({
                "accession": acc,
                "transaction_id": tid,
                "issuer_cik": issuer_cik,
                "issuer_ticker": symbol.upper(),
                "person_cik": pcik,
                "role_flags": 0,
                "transaction_code": str(x.get("transactionCode", "")),
                "transaction_date": tdate,
                "accepted_at": fdate,
                "shares": shares,
                "price_per_share": price,
                "dollar_amount": shares * price,
                "filing_url": filing_url,
                "source": SOURCE_LABEL,
            })
    return out, names


_INSERT_COLS = [
    "accession", "transaction_id", "issuer_cik", "issuer_ticker", "person_cik",
    "role_flags", "transaction_code", "transaction_date", "accepted_at",
    "shares", "price_per_share", "dollar_amount", "filing_url", "source",
]


def main() -> int:
    args = parse_args()
    apply = bool(args.apply) and not args.dry_run
    token = os.getenv("FINNHUB_API_KEY", "").strip()
    if not token:
        print("[finnhub] FATAL: set FINNHUB_API_KEY env var (operator's Finnhub key).", file=sys.stderr)
        return 2

    client = ch_client()
    if args.symbols:
        # Resolve provided symbols to CIKs via cik_ticker_map.
        syms = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
        cmap = {r[0]: r[1] for r in client.query(
            "SELECT upper(ticker), cik FROM quantlab.cik_ticker_map FINAL WHERE cik != ''"
        ).result_rows}
        universe = [(s, cmap.get(s, "")) for s in syms]
    else:
        universe = load_sp500_universe(client, args.since)
    print(f"[finnhub] universe: {len(universe)} symbols | window {args.from_date}..{args.to_date}")

    existing = set() if args.no_skip_existing else load_existing_accessions(client)
    print(f"[finnhub] existing accessions to dedup against: {len(existing):,}")

    all_rows: list[dict] = []
    all_names: dict[str, str] = {}
    skipped_acc = 0
    empty_syms = 0
    errors = 0
    t0 = time.time()
    for i, (sym, cik) in enumerate(universe):
        try:
            raw = fetch_finnhub_insider(sym, args.from_date, args.to_date, token)
        except Exception as e:  # noqa: BLE001 — one bad symbol must not kill the run
            print(f"[finnhub] WARN {sym}: {type(e).__name__}: {e}", file=sys.stderr)
            errors += 1
            time.sleep(_RATE_SLEEP_SEC)
            continue
        if not raw:
            empty_syms += 1
        rows, names = map_rows(sym, cik, raw)
        kept = []
        for r in rows:
            if r["accession"] in existing:
                skipped_acc += 1
                continue
            kept.append(r)
            existing.add(r["accession"])  # avoid intra-run dup across symbols
        all_rows.extend(kept)
        all_names.update(names)
        if (i + 1) % 50 == 0:
            print(f"[finnhub] {i+1}/{len(universe)} symbols | {len(all_rows):,} new rows | {time.time()-t0:.0f}s")
        time.sleep(_RATE_SLEEP_SEC)

    print(f"[finnhub] DONE fetch: {len(all_rows):,} new rows | {len(all_names):,} insiders | "
          f"skipped {skipped_acc:,} rows on existing accessions | "
          f"{empty_syms} empty symbols | {errors} fetch errors")

    if not apply:
        if all_rows:
            print(f"[finnhub] dry-run sample: {json.dumps({k: str(v) for k, v in all_rows[0].items()}, indent=2)}")
        print("[finnhub] dry-run — no CH write. Use --apply to persist.")
        return 0

    if all_rows:
        data = [[r[c] for c in _INSERT_COLS] for r in all_rows]
        client.insert("insider_trades", data, column_names=_INSERT_COLS, database="quantlab")
    if all_names:
        ndata = [[pcik, nm, SOURCE_LABEL] for pcik, nm in all_names.items()]
        client.insert("insider_ciks", ndata, column_names=["person_cik", "name", "source"], database="quantlab")
    print(f"[finnhub] OK | wrote {len(all_rows):,} insider_trades rows + {len(all_names):,} insider_ciks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
