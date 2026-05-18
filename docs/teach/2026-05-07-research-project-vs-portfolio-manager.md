# SignalForge is a research project, not a portfolio manager

**Source:** Park & Irwin (2007), *What Do We Know About the Profitability of
Technical Analysis?*, *Journal of Economic Surveys* 21(4), 786-826 — meta-
analysis. Sullivan, Timmermann & White (1999), *Data-Snooping, Technical
Trading Rule Performance, and the Bootstrap*, *Journal of Finance* 54(5).
López de Prado (2018), *Advances in Financial Machine Learning*, Ch. 11.
Bogle (2007), *The Little Book of Common Sense Investing* — buy-and-hold
case. Faber (2007), *A Quantitative Approach to Tactical Asset Allocation*,
*SSRN* — TAA framework. Project ADR-031 (regime-rotation rejected).

User-triggered context: 2026-05-07 the operator asked whether SignalForge
could be used to manage their personal retirement portfolio (~$373K
across 403(b), Rollover IRA, Roth, taxable, crypto), and whether it should
be used to do market-regime rotation across index funds and ETFs.

---

## Intuition

There's a category error that operators of systematic trading research
projects frequently make: conflating *the research apparatus* with *a
deployable portfolio manager*. The research apparatus generates and
validates hypotheses about systematic edges; a deployable portfolio
manager allocates real capital across a stack of investments according
to validated rules with operational guardrails.

These are different things. They share some math (statistics, optimization)
but they have different goals, different operational requirements, and
different consequences for being wrong. Confusing them is how retirement
accounts get destroyed by hobbyist quant projects.

This doc captures the bright line, with concrete tests for which side
of the line a question falls on.

## The bright line

**A research project answers the question:** *"Is there a real edge in
applying strategy X to universe Y, given methodology Z?"* It produces
verdicts (PROMOTE / REJECT / CONDITIONAL) and stays at the verdict
level. The artifacts are ADRs, teach-docs, deflated-Sharpe scores,
walk-forward results.

**A portfolio manager answers the question:** *"Given my current capital,
my time horizon, my tax situation, my risk tolerance, and the markets'
current state, how much of which investments should I hold and when
should I trade?"* It produces orders. The artifacts are positions,
fills, P&L, tax lots.

The first does NOT imply the second. A strategy can pass the research
gauntlet and still be unsuitable for portfolio deployment because:

- It hasn't been validated on the operator's actual universe (e.g.,
  validated on individual stocks, deployed on sector ETFs).
- It lacks position-sizing, stop-loss, or kill-switch infrastructure.
- It hasn't been operationally shaken down with real-time data.
- It hasn't been validated across the operator's relevant time horizon
  or regime distribution.
- The operator has tax / legal / liquidity / behavioural constraints
  that the research didn't model.

Each of those is enough to invalidate deployment even when the research
is sound.

## Concrete tests

When an operator asks "should I use SignalForge to manage my portfolio?"
the questions to walk through, in order:

### Q1 — Is the strategy validated on YOUR holdings' universe?

**SignalForge as of 2026-05-07** has validated (CONDITIONAL grade)
`mr_v1/p=14` and `trend_v1/p=30` on **60 US large/mid-cap individual
equities** at daily timeframe.

It has empirically REJECTED every other universe attempted (microcap
crypto, large-cap crypto, intraday Solana, mean-reversion on memecoins,
and 23/23 cells of volume-breakout strategies on Solana).

It has NOT been tested on:

- Sector ETFs (FTEC, XLK, FSPTX, etc.)
- Broad-market index funds (FXAIX, VTI, VOO)
- Large-cap growth indices (FSPGX, VUG)
- International equity (VDIPX, VXUS)
- Emerging markets (FPADX, VWO)
- Real estate (FSRNX, VNQ)
- Small-caps (FSSNX, VTWO)
- Bonds (FXNAX, BND)
- Thematic ETFs (ARK family, DRIV, IDRV, LIT)
- Treasury bills

**If your holdings include any of the above and you ask "can the strategy
trade these?", the answer is: not validated. ADRs 022-026 demonstrated
that strategies validated on one universe routinely fail on adjacent
universes — that empirical track record is decisive.**

### Q2 — Has the operational pipeline been shaken down?

The MVP daemon launched 2026-05-06. As of 2026-05-07 it has been live
for ~24 hours. The shakedown plan is **4-6 weeks** specifically to
surface operational issues that backtests cannot predict (data quality,
calendar arithmetic, fetch reliability, drift between live and backtest,
edge cases on holidays / partial bars / corporate actions).

Until the shakedown completes with clean operational data, the system
cannot be considered operationally validated regardless of how good its
research metrics look.

### Q3 — Is the position-sizing / risk-management layer built?

Per [docs/specs/position-sizing-and-kill-switch.md](../specs/position-sizing-and-kill-switch.md) — currently the answer is no. The MVP daemon
runs at 100%-of-capital per trade with no stop-loss. The minimum-viable
sizing layer (fixed-fractional 2%-risk-per-trade + ATR stops + concurrent-
position cap) is ~7 hours of focused implementation; the full version
with kill-switch monitor is ~12-15 hours.

**Without these, ANY real-money deployment is taking unbounded single-
trade tail risk.** Backtest worst single trade at the deployed thresholds
was -64.9%. On a $200K position, that's -$130K in one trade.

### Q4 — Has the strategy been tested on the operator's relevant regime
distribution?

Yfinance equity history extends to ~2014 for our universe. That's 12
years that includes one bull regime (post-2014), one V-shape (March 2020),
one Fed-tightening drawdown (2022). It does NOT include 2008 GFC, 2000-
2002 dot-com bust, or any sustained multi-year bear market.

The deferred Sharadar SEP integration extends to ~2000-2001 and adds
delisted-ticker survivorship correction. Until that integration is done,
the deployable claim is **conditioned on regimes resembling 2014-2026**
— which is an unusually benign window for long-only equity strategies.

For an operator with a 20+ year retirement horizon, this is a meaningful
gap.

### Q5 — Has the operator's specific question (e.g. "regime rotation")
been formally tested?

For "regime rotation across index funds based on broad market state" —
yes, in the project (ADR-031, Faber 2007 GTAA framework, SPY 200d MA
filter, 8 cells). Verdict: **REJECTED.**

For other regime measures (VIX, equicorrelation per Pollet-Wilson 2010,
HMM-learned regimes, realized-vol regimes) — partly tested. ADR-033
documents the rejection of equicorrelation. The others are deferred
follow-ups.

For tactical asset allocation across multiple sleeves (equity / bond /
international / commodities / cash) — completely untested in this
project. The academic literature (Park-Irwin 2007 meta-analysis of 95
studies) is mixed-to-negative on TAA after costs and selection-bias
correction.

**Asking "should I use this project to do TAA?" assumes the project has
demonstrated TAA edge. It hasn't. It has demonstrated the opposite for
the one TAA variant tested.**

## What the operator actually needs vs what SignalForge provides

A typical retirement-account operator asking these questions has needs
that SignalForge does NOT address:

| Operator need | SignalForge provides | Where to actually go |
|---|---|---|
| Asset allocation policy across sleeves | Nothing | Fee-only CFP / fiduciary RIA |
| Concentration-risk diagnosis | Nothing | Same |
| Tax-loss harvesting strategy | Nothing | CPA + financial advisor |
| Roth conversion ladder analysis | Nothing | Same |
| Estate planning across accounts | Nothing | Estate attorney + CPA |
| Bond ladder construction | Nothing | DIY with broker tools, or advisor |
| Behavioural coaching during volatility | Nothing | Advisor (this is where they earn their fee) |
| Tax-aware account-location optimization | Nothing | Advisor |
| Single-stock systematic alpha research | YES | This project |
| Two-strategy paper-trading observability | YES | This project's daemon + UI |
| Methodology-canon literacy / overfitting detection | YES | This project's teach-docs |

The entries marked YES are real and useful. They don't add up to a
portfolio manager. They add up to a research apparatus that will,
eventually, with significant additional work, *possibly* contribute one
small line item to a properly constructed portfolio.

## Why "but I have data and code" is the wrong reason to deploy

The temptation to use the project for the operator's actual portfolio
goes:

1. *I have the research apparatus working.*
2. *My portfolio has positions in things.*
3. *Therefore I should apply the apparatus to my portfolio.*

Each step in isolation seems fine. The chain is wrong because step 3
requires *the apparatus's validated outputs match the portfolio's
inputs*, which is exactly what step 1's validation does NOT establish.

The correct chain is:

1. *I have a research apparatus that validates strategies on a specific
   universe under specific assumptions.*
2. *My portfolio holds different things, has different tax/horizon
   constraints, and faces regime distributions the apparatus has not
   tested.*
3. *Therefore I must NOT apply the apparatus to my portfolio without
   building all the missing pieces (universe coverage, sizing, sizing,
   kill switches, tax awareness, etc.) AND validating the result on
   the new domain.*
4. *Until that gap is closed, the apparatus is research, not management.*

## The correct relationship between research and portfolio

Three levels of integration, in increasing maturity:

### Level 1 (current state) — research as education

The operator continues building the research project. Reads the teach-
docs. Internalises the methodology canon (López de Prado, Pardo,
Aronson, Harvey-Liu-Zhu). This makes them a *better consumer* of any
investment claims they encounter — including their own. The operator
pays for the project as a learning expense, treats it as a hobby that
sharpens financial literacy, and **manages their actual portfolio by
standard advisor-supported best practices** (written IPS, periodic
rebalancing, broad diversification, tax-aware account location).

This is where the operator should be right now.

### Level 2 (post-shakedown + post-Sharadar, 6-12 months out) — small
deployment

If the project's full validation gauntlet passes (shakedown clean,
Sharadar 25y holds, position-sizing layer built and tested, kill
switches operational), the operator MAY allocate a small line item —
**$5K-$10K total, never more than 1% of net worth** — to a real-money
version of the deployed cells. This is a "learning the operational
ropes" allocation, not a "this is now my edge" allocation. The dollar
amount is small enough that a 50% drawdown is recoverable from cash
flow within 6-12 months.

Most of the operator's portfolio remains under standard portfolio
construction. The research deployment is a single line item among
many.

### Level 3 (multi-year track record, 2+ years out) — scaled deployment

After the small deployment runs for 1-2 years and produces consistent
positive risk-adjusted returns vs a benchmark (SPY for long-only
equity strategies), the operator MAY scale allocation incrementally.
"Incrementally" means doubling per year at most, with hard caps based
on Kelly fractions and behavioural-tolerance limits. A reasonable
upper bound for a hobbyist quant project is **5-10% of net worth**,
not 50%.

This is years away from the current state.

## The hardest part of this lesson

For operators who have invested significant time and intellectual
capital in a research project, accepting that **the project's research
soundness does not authorise its portfolio deployment** is emotionally
hard. The work feels like it should be useful for the *actual* problem.
The methodology has been internalised; the data flows; the dashboards
work; the strategies have positive backtests. Surely it can run real
money?

The methodology answers: yes, *eventually*, with much more work, on a
small allocation. NOT now, on the operator's full retirement assets,
on universes the strategy hasn't been validated on.

Operators who skip the gap (research → small deployment → scaled
deployment) are the failure mode the entire methodology canon was
written to prevent. The reason López de Prado's *Advances in Financial
Machine Learning* dedicates two chapters (11, 16) to backtest
overfitting and deflated Sharpe is precisely because intelligent
operators routinely deploy under-validated strategies on real money
and discover the inflation post-hoc when the live results disappoint.

## Concrete operational guidance for the operator's specific situation

(2026-05-07 — operator has ~$373K across multiple accounts, FTEC at
75% of Rollover IRA, T-bills maturing imminently, tech-heavy across
all sleeves, asking about regime rotation.)

### Recommendations

1. **Continue SignalForge as a research project** through the 4-6 week
   shakedown. Read the four teach-docs from the 2026-05-07 reading
   list. Don't deploy real money.
2. **Engage a fee-only fiduciary CFP** for the portfolio questions.
   NAPFA, FeeOnlyNetwork, Garrett Planning Network are searchable
   directories. One-time financial plan ~$2-5K.
3. **Concentration risk on FTEC** is real and the operator's instinct
   is correct. Rebalancing inside an IRA has zero tax cost; the only
   barrier is operator discipline. Direction (reduce concentration) is
   supported by every modern portfolio theory textbook; magnitude and
   timing is what the CFP helps with.
4. **T-bill rollover** is a near-term mechanical decision: roll into
   new T-bills or short-duration CDs by default until a plan is in
   place. Resist the urge to deploy the $90K cash into market in one
   go without a written allocation policy.
5. **Tax-loss harvesting** the ~$1,955 in losers (AITX, ARKK, ARKF,
   IDRV, ARKW) is a standard year-end task. Watch wash-sale rules
   across all accounts including any spouse's. Replace with similar-
   but-not-substantially-identical to maintain exposure.
6. **Tech overlap across accounts** (FTEC + FSPTX + FOCPX + FXAIX's
   tech weight + thematic ETFs) is probably 50%+ of total portfolio.
   This is high concentration risk regardless of how well any single
   piece has done. The CFP will frame this as a written asset-
   allocation target.
7. **DO NOT** use SignalForge to time these decisions. It has not been
   validated to do so, and the one TAA variant the project tested
   (Faber GTAA per ADR-031) was empirically rejected.

### What the operator can legitimately do with SignalForge today

- Watch the daemon's daily output and learn what trade-frequency, win
  rate, drawdown look like in practice
- Read the teach-docs and become methodology-literate
- Identify when financial-media claims fail the DSR / PBO / HLZ tests
  (this skill alone has economic value over a 30-year investing
  horizon — it filters the noise)
- Eventually, after 6-12 months of clean operational data + the
  deferred follow-ups land, allocate a small ($5-10K) test sleeve to
  the validated cells

### What the operator should NOT do today

- Sell FTEC because the daemon said something
- Buy FTEC because the daemon said something
- Rotate index funds based on the project's signals
- Deploy more than $0 to a SignalForge-driven strategy
- Skip the fiduciary CFP step because "the project knows"

These are the same do's-and-don'ts that apply to *anyone* reading a
trading book or methodology paper. The do's are educational; the
don'ts are deployment-without-validation.

## Closing

The hardest part of writing this doc is acknowledging that it might
read as undermining the project we've been building. It's not. The
project has produced real intellectual artifacts — empirical evidence,
ADRs documenting rejections, methodology rigor that exceeds most retail
quant work. The work is genuinely valuable.

What the work is *not* is a substitute for portfolio management. The
two activities have different goals, different validation requirements,
and different consequences for being wrong. Conflating them is the
single biggest risk to the operator's actual financial wellbeing in
the near term.

This doc exists so future sessions starting from `/clear` will reach
the same conclusion without re-deriving it, and so the operator can
re-read it whenever the temptation to "deploy what we've built" returns.
