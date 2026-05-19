# Alpaca onboarding — what operator decisions block Phase B

**Source:** Alpaca docs (alpaca.markets/docs), FINRA Rule 4210 (margin / PDT), and the C-12 SPEC at [docs/specs/live-trade-broker-integration.md](../specs/live-trade-broker-integration.md) §3.2 + §8.

---

## Intuition

Phase B of the C-12 broker-integration arc implements `AlpacaAdapter` —
the code that talks to Alpaca's REST API and turns the daemon's "open
position X" intent into a real broker order. That code can be written
autonomously, but it needs a real Alpaca account + API credentials to
actually run a smoke test against. You (the operator) create the
account and generate the keys; the assistant cannot, because the steps
involve identity verification and one-time-secret display.

Within "create the account" are three actual decisions the assistant
cannot make for you:

1. Paper-only account, or paper + live application now?
2. Cash account or margin account?
3. Paper-account synthetic balance (defaults to $100k; adjustable).

The first and third are minor. The second is load-bearing — it
determines whether short selling, same-day buying power, and the PDT
rule apply to your live account.

## Mechanism

### Account-type structures (the load-bearing decision)

US brokers offer two account types for individuals:

**Cash account.** Buy stock with already-settled cash. Sells settle T+1
(used to be T+2; the SEC's 2024 shift moved it to T+1 for US equities).
Until the cash from a sell settles, you can buy with it but not
re-sell that buy until the underlying sale settles. **No short
selling** (selling stock you don't own requires borrowing it, which is
a margin-account-only operation).

**Margin account.** Broker extends credit; you can buy with up to 2x
your cash (Reg T 50% initial margin). Enables **short selling** and
**same-day buying power** (sell at 10am, buy something else at 11am
with the proceeds). Two cost layers:

- **Interest.** Margin loans charge interest on the borrowed portion
  (typically 7-10% APR; tier-graduated). If you only buy with settled
  cash and never go on margin, you pay zero — but the account is
  structurally different.

- **PDT (Pattern Day Trader) rule.** FINRA Rule 4210. If you make ≥4
  day-trades (open + close in the same session) in 5 business days
  AND your equity is <$25,000 AND the account is a margin account,
  FINRA flags the account "PDT" and the broker is REQUIRED to freeze
  it for 90 days unless equity goes ≥$25k. Cash accounts are immune
  (because day-trading a cash account is naturally rate-limited by
  T+1 settlement).

### Why cash is the right default here

The two production-running strategies (`mean_reversion_v1` and
`trend_v1`) are long-only by construction — the daemon doesn't emit
short signals. Margin therefore buys you nothing today but adds:

- PDT exposure (if daemon cadence ever shortens or any strategy goes
  intraday).
- The cognitive overhead of knowing whether you're using settled cash
  or borrowed money on any given trade.
- A non-zero interest line in the P&L if the buying-power state ever
  goes negative.

The Vector Core "fewer features, robustly" rule applies: don't take on
the complexity of margin until a strategy actually needs it. Switching
cash → margin later is a single setting flip in the Alpaca dashboard
(may require a fresh application form). Switching margin → cash is
the same. Reversible.

### Paper sandbox vs live — orthogonal to account type

Alpaca's **paper sandbox** is a separate URL (`paper-api.alpaca.markets`)
that simulates the full API surface but never touches a real exchange.
You get your own paper keys, separate from live keys. Account-type
choices made for live (cash vs margin) apply to live only — the paper
sandbox is its own thing.

The daemon switches between them via one env var:

```
ALPACA_BASE_URL=https://paper-api.alpaca.markets   # paper sandbox
ALPACA_BASE_URL=https://api.alpaca.markets         # live
```

Phase B targets the paper sandbox exclusively. Phase E is the env-var
flip to live.

### Paper-account synthetic balance

The Alpaca paper sandbox defaults to $100,000 synthetic. Adjustable in
the dashboard. The C-12 SPEC's `PaperBrokerAdapter` also defaults to
$100k for its in-memory account snapshot. Keep them aligned to make
Phase B's smoke test results comparable between the two paper paths.

## Failure mode (when this breaks)

- **Opening a margin account when you didn't need shorts** — you take
  on PDT exposure and the cognitive overhead for no benefit. If a
  strategy never needs shorts, this is pure cost.

- **Opening only a cash account, then needing shorts later** — when a
  future strategy emits short signals, you must apply for a margin
  upgrade. Alpaca processes in 1-2 business days. You miss whatever
  shorts the strategy emits in that window.

- **Confusing the two "paper" concepts** — Vector Core has its own
  `source='paper'` (the daemon flag) which is **orthogonal** to
  Alpaca's `paper-api.*` sandbox. Combinations:

  | Vector Core source | Alpaca BASE_URL          | Meaning                                              |
  | ------------------ | ------------------------ | ---------------------------------------------------- |
  | `paper`            | (any — not consulted)    | Today's behavior. PaperBrokerAdapter; CH journal only. |
  | `live`             | `paper-api.alpaca.com`   | Phase B smoke. Routes through AlpacaAdapter against the paper sandbox; no real money. |
  | `live`             | `api.alpaca.com`         | Phase E. Real money.                                 |

  Conflating these in code comments or runbooks is the biggest landmine
  identified in the SPEC (§7 item 1). Use distinct names: "Alpaca paper
  sandbox" for Alpaca's, "Vector Core source=paper" for the daemon flag.

- **Forgetting to copy the API secret on creation** — Alpaca shows the
  secret exactly once at key-generation time. If you lose it, you can't
  retrieve it; you generate a new key pair. Not catastrophic but mildly
  annoying. Keep a password-manager entry for both API key and secret
  immediately after creating them.

- **Account application taking longer than expected for live** — KYC
  is normally instant for US residents, but can take 1-2 business days
  if Alpaca flags anything. If you plan to flip to live, start the
  live-account application early — applying does NOT commit you to
  funding or trading; you can apply now and use only the paper sandbox
  for months before Phase E.
