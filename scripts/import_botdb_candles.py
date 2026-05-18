"""
One-shot import: bot.db.ohlcv_candles -> quantlab.candles (ClickHouse).
Stdlib only (sqlite3 + urllib). Read-only against bot.db.

FROZEN as of 2026-05-03 per ADR-005 (see MASTER.html §6).
Existing bot.db rows in quantlab.candles are grandfathered. No new imports.
The runtime guard in main() will refuse to run unless ADR005_OVERRIDE=1
is set in the environment. The override exists for explicit, documented
recovery scenarios only — not for "I forgot the rule."

Usage (BLOCKED — script will refuse without override):
    python scripts/import_botdb_candles.py --interval 1h           # ingest one
    python scripts/import_botdb_candles.py --interval 1h --limit 10000   # dry run
    python scripts/import_botdb_candles.py --all                   # 5m + 15m + 1h

ReplacingMergeTree(token_address, interval, timestamp) handles dedup on merge —
bot.db rows that share a key with existing quantlab rows will collapse to one.
"""
import os, sqlite3, json, time, sys, argparse, datetime as dt
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from base64 import b64encode

BOT_DB = r"C:\Users\Pejman\Desktop\PROJECTS\AIProjects\solana-smart-money-bot\bot.db"
CH_URL = "http://127.0.0.1:8123/"
CH_AUTH = b64encode(b"quantlab:quantlab").decode()
BATCH = 50_000
INTERVALS_DEFAULT = ("5m", "15m", "1h")  # skip 4h/1d (20 tokens each, thin)

def ch_post(query: str, body: bytes = b"") -> str:
    url = CH_URL + "?query=" + query.replace(" ", "+")
    req = Request(url, data=body, headers={
        "Authorization": "Basic " + CH_AUTH,
        "Content-Type": "application/octet-stream",
    })
    try:
        return urlopen(req, timeout=120).read().decode()
    except HTTPError as e:
        print(f"  CH error {e.code}: {e.read().decode()[:300]}", file=sys.stderr)
        raise

def ch_select(sql: str) -> str:
    return ch_post(sql + " FORMAT TabSeparated").strip()

def fmt_ts(epoch_sec: int) -> str:
    # ClickHouse DateTime64(3,'UTC') wants 'YYYY-MM-DD HH:MM:SS.fff' (no tz suffix).
    # Python's isoformat() emits '+00:00' which CH rejects in JSONEachRow.
    d = dt.datetime.fromtimestamp(epoch_sec, dt.UTC)
    return d.strftime("%Y-%m-%d %H:%M:%S.000")

def import_interval(src_cur, interval: str, limit: int | None = None) -> tuple[int, int]:
    where = "WHERE interval = ?"
    params: tuple = (interval,)
    sql = f"""
        SELECT token_mint, interval, timestamp, open, high, low, close, volume, source
        FROM ohlcv_candles {where}
        ORDER BY token_mint, timestamp
        {f'LIMIT {limit}' if limit else ''}
    """
    src_cur.execute(f"SELECT COUNT(*) FROM ohlcv_candles {where}", params)
    total = min(src_cur.fetchone()[0], limit or 10**12)
    if total == 0:
        print(f"  {interval}: nothing to ingest")
        return 0, 0

    print(f"  {interval}: streaming {total:,} rows...")
    src_cur.execute(sql, params)

    sent = 0
    skipped = 0
    batch: list[bytes] = []
    t0 = time.time()
    insert_url = "INSERT INTO quantlab.candles FORMAT JSONEachRow"

    for token_mint, iv, ts, o, h, l, c, v, source in src_cur:
        # Quality gate (mirrors what we already validated on a 200K sample)
        if not token_mint or ts is None or o is None or h is None or l is None or c is None:
            skipped += 1
            continue
        if o <= 0 or l <= 0 or h < l:
            skipped += 1
            continue
        row = {
            "token_address": token_mint,
            "interval": iv,
            "timestamp": fmt_ts(int(ts)),
            "open": float(o),
            "high": float(h),
            "low": float(l),
            "close": float(c),
            "volume": float(v) if v is not None else 0.0,
            "source": source or "botdb",
        }
        batch.append(json.dumps(row).encode() + b"\n")

        if len(batch) >= BATCH:
            ch_post(insert_url, b"".join(batch))
            sent += len(batch)
            elapsed = time.time() - t0
            eta = (total - sent) / max(1, sent / elapsed)
            print(f"    {sent:>10,} / {total:>10,}  ({sent*100/total:5.1f}%)  "
                  f"{sent/elapsed:>7,.0f} rows/s  ETA {eta:5.0f}s")
            batch.clear()

    if batch:
        ch_post(insert_url, b"".join(batch))
        sent += len(batch)

    elapsed = time.time() - t0
    print(f"  {interval}: ingested {sent:,} rows in {elapsed:.1f}s "
          f"({sent/max(elapsed,0.001):,.0f} rows/s), {skipped:,} skipped on quality")
    return sent, skipped

def main():
    if not os.environ.get("ADR005_OVERRIDE"):
        raise SystemExit(
            "ADR-005: bot.db imports are FROZEN. See MASTER.html §6 ADR-005.\n"
            "Existing bot.db rows in quantlab.candles are grandfathered; no new\n"
            "imports allowed because the source-project cost model and OOS\n"
            "methodology differ from SignalForge's and would contaminate validation.\n"
            "If you have a documented recovery reason, set ADR005_OVERRIDE=1 and re-run."
        )
    ap = argparse.ArgumentParser()
    ap.add_argument("--interval", choices=["5m","15m","1h","4h","1d"])
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--limit", type=int, default=None, help="row cap per interval (dry run)")
    ap.add_argument("--no-optimize", action="store_true")
    args = ap.parse_args()

    if not args.interval and not args.all:
        ap.error("pick --interval <iv> or --all")
    intervals = INTERVALS_DEFAULT if args.all else (args.interval,)

    before = int(ch_select("SELECT count() FROM quantlab.candles"))
    print(f"quantlab.candles before: {before:,} rows")

    src = sqlite3.connect(f"file:{BOT_DB}?mode=ro", uri=True, timeout=10)
    src.execute("PRAGMA query_only = ON")
    cur = src.cursor()

    total_sent = 0
    total_skipped = 0
    t0 = time.time()
    for iv in intervals:
        s, k = import_interval(cur, iv, args.limit)
        total_sent += s
        total_skipped += k

    src.close()

    after_raw = int(ch_select("SELECT count() FROM quantlab.candles"))
    print(f"\nquantlab.candles after raw insert: {after_raw:,} rows  (+{after_raw - before:,})")

    if not args.no_optimize:
        print("OPTIMIZE TABLE quantlab.candles FINAL  (collapses duplicate keys)...")
        ch_post("OPTIMIZE TABLE quantlab.candles FINAL")
        after_final = int(ch_select("SELECT count() FROM quantlab.candles FINAL"))
        print(f"quantlab.candles after FINAL: {after_final:,} rows")

    print(f"\nTotal: sent {total_sent:,} | skipped {total_skipped:,} | "
          f"wall {time.time()-t0:.1f}s")

if __name__ == "__main__":
    main()
