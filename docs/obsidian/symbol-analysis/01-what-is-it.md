# 01 — What Is This Thing?

> First job: actually understand what you're looking at. Different security types require different analysis. Many bad decisions trace back to evaluating a security with the wrong framework.

## Determine the security type

| Type | How to recognize | What matters most |
|------|------------------|-------------------|
| Individual stock | Single company ticker (NVDA, AAPL) | Business fundamentals, competitive position, management |
| Sector ETF | Tracks an index of one sector (FTEC, XLF) | Concentration, index methodology, sector outlook |
| Broad market ETF | Tracks total market or major index (VTI, VOO) | Expense ratio, tracking error, factor exposures |
| Active mutual fund | Has a manager making decisions | Manager tenure, active share, fees vs alpha |
| Bond fund / ETF | Holds debt instruments (BND, AGG) | Duration, credit quality, yield |
| Leveraged / inverse ETF | Returns multiplied or inverted (TQQQ, SQQQ) | Decay, suitable only for short holds |
| Commodity ETF | Tracks physical commodity (GLD, USO) | Storage costs, contango/backwardation |

## Pull the basic facts

**Source:** Brokerage research page (Fidelity, Schwab) or Morningstar or the fund's own website.

**Capture:**
- Full legal name and ticker
- Sponsor / issuer (Fidelity, Vanguard, BlackRock, etc.)
- Inception date (how long has it existed)
- Total assets / market cap (size matters for liquidity and stability)
- Expense ratio (for funds) or no expense (for stocks)
- Structure: open-ended, closed-end, ETF, ADR, etc.
- Index tracked (for index funds) and methodology (e.g., the 25/50 rule on FTEC)
- Tax structure: K-1 issuer (commodities, MLPs), 1099 issuer (most ETFs/stocks)

## Critical questions at this stage

**Is this thing diversified or concentrated?**
A sector ETF is structurally concentrated (FTEC is 99.78% tech). A broad market ETF isn't (VTI is ~25% tech). Concentration changes everything downstream.

**Does my analytical framework match this security type?**
Analyzing a leveraged ETF using long-term fundamentals is a category error. Analyzing a sector ETF using individual stock metrics is also a category error.

**Is this even the right vehicle for my goal?**
If you want broad US market exposure, FTEC is the wrong tool regardless of how good it looks on individual metrics.

## Next

→ [[02-fundamentals]]
