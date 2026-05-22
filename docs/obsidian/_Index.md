---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: index
---

# SignalForge — Master Index

> **What this is.** A research-grade systematic trading lab. Backtests across thousands of (strategy × parameter × ticker × interval) cells, ranks them with overfitting-corrected metrics (Deflated Sharpe, PBO via CSCV), and routes the survivors through a 4-gate trade-execution pipeline that ends in paper-traded equity positions.
>
> **Read first.** [[README]] · `Architecture.canvas` (open in Obsidian) · [.claude/HANDOFF.md](../../.claude/HANDOFF.md)

## The full pipeline (end-state)

```mermaid
flowchart TD
    subgraph SRC["Data sources (external)"]
        YF["Yahoo Finance<br/>(equity OHLCV)"]
        FRED["FRED<br/>(T10Y2Y curve)"]
        CBOE["CBOE<br/>(P/C ratio, 2003-2019)"]
        STOOQ["Stooq<br/>(breadth, gated)"]
        WIKI["Wikipedia<br/>(S&P 500 history)"]
        DEX["DEX APIs<br/>(Jupiter/Kraken/Coinbase)"]
    end

    subgraph ING["Ingest (scripts/)"]
        EQI["fetch_daily_yfinance.py"]
        FRI["fred_ingest.py"]
        CBI["cboe_putcall_ingest.py"]
        CONS["macro_refresh_constituents.py<br/>+ macro_compute_breadth.py"]
        CRY["jupiter/kraken/coinbase_backfill.ts"]
    end

    subgraph CH["ClickHouse (quantlab.*)"]
        CAN[("candles<br/>+ daily_candles")]
        MI[("macro_indicators_*<br/>(fred, cboe)")]
        MB[("macro_breadth")]
        MR[("macro_regimes<br/>(phase1_v3)")]
        BR[("bt_runs<br/>+ bt_runs_regime")]
        BT[("bt_trades")]
        AL[("cell_allowlist")]
        PT[("paper_trading_positions<br/>+ daemon_runs")]
    end

    subgraph CLASS["Regime classifier"]
        V3["macro_regime_v3.ts<br/>6 categories → red/orange/yellow/green"]
    end

    subgraph BT_ENG["Backtest engine"]
        BB["batch_backtest.ts<br/>(strategy × param × ticker × interval)"]
        STRAT["Strategies<br/>(mr_v1, trend_v1, xsmom, vb…)"]
        SCORE["Scoring<br/>(DSR, PBO/CSCV, HLZ haircut)"]
        ALLOW["populate_cell_allowlist.ts"]
    end

    subgraph GATES["Trade execution pipeline (4 gates)"]
        G1["Gate 1<br/>Allowlist lookup"]
        G2["Gate 2<br/>Regime conditional"]
        G3["Gate 3<br/>ML probability<br/>(DEFERRED)"]
        G4["Gate 4<br/>LLM validator<br/>(DEFERRED)"]
    end

    subgraph DAE["Daemon — daily_signal_daemon.ts"]
        D1["[macro-fetch]"]
        D2["[macro-classify-v3]"]
        D3["[evaluate strategies × allowlist]"]
        D4["[emit positions + Telegram]"]
    end

    subgraph OPS["Paper trading & monitoring"]
        PR["_paper_trading_review.ts"]
        AU["audit_positions.ts"]
        OB["operator_brief.ts<br/>(morning brief)"]
        KILL["paper_trading_kill_criteria.ts<br/>(A1-A5)"]
    end

    subgraph UI["Dashboard (React + Vite)"]
        APP["App.tsx → /#/regime"]
        PANELS["RegimeApp / PaperTradingApp /<br/>ClusterDashboard / ValidatorApp"]
        MAS["MASTER.html<br/>(roadmap doc)"]
    end

    YF --> EQI --> CAN
    FRED --> FRI --> MI
    CBOE --> CBI --> MI
    STOOQ --> CONS --> MB
    WIKI --> CONS
    DEX --> CRY --> CAN

    CAN --> BB
    BB --> STRAT --> BR
    BR --> BT
    BR --> SCORE --> ALLOW --> AL

    MI --> V3
    MB --> V3
    CAN --> V3
    V3 --> MR

    AL --> G1
    MR --> G2
    G1 --> G2 --> G3 --> G4

    D1 --> D2 --> D3 --> D4
    D2 -.uses.-> V3
    D3 -.uses.-> G1
    D3 -.uses.-> G2
    D4 --> PT

    PT --> PR
    PT --> AU
    PT --> OB
    PT --> KILL

    MR --> APP
    PT --> APP
    BR --> APP
    APP --> PANELS

    classDef src fill:#1f2937,stroke:#94a3b8,color:#e5e7eb
    classDef ch fill:#1e3a8a,stroke:#60a5fa,color:#dbeafe
    classDef gate fill:#7c2d12,stroke:#fb923c,color:#fed7aa
    classDef dae fill:#14532d,stroke:#4ade80,color:#bbf7d0
    classDef ui fill:#581c87,stroke:#c084fc,color:#e9d5ff

    class YF,FRED,CBOE,STOOQ,WIKI,DEX src
    class CAN,MI,MB,MR,BR,BT,AL,PT ch
    class G1,G2,G3,G4 gate
    class D1,D2,D3,D4 dae
    class APP,PANELS,MAS ui
```

## Layers (top-down)

1. **[[01 - Data Ingestion]]** — pulling raw OHLCV + macro indicators + breadth from external sources into ClickHouse.
2. **[[02 - Storage (ClickHouse)]]** — the `quantlab.*` schema; who writes each table, who reads it.
3. **[[03 - Backtest Engine]]** — sweeping the (strategy × param × ticker × interval) grid; scoring with overfitting-corrected metrics; promoting survivors into the allowlist.
4. **[[04 - Regime Classifier (phase1_v3)]]** — a daily red/orange/yellow/green label on the macro tape, driven by 6 categorical risk-off arms.
5. **[[05 - Trade Execution Pipeline]]** — the 4-gate veto chain that decides whether a fresh "BUY" signal becomes a real position.
6. **[[06 - Daemon (daily cadence)]]** — the scheduled job that re-runs the pipeline every market day.
7. **[[07 - Paper Trading & Monitoring]]** — Track A live shakedown, kill criteria, morning brief, position audits.
8. **[[08 - Dashboard UI]]** — the React frontend that visualises all of the above.

## Working notes & playbooks

- **[[gaps/README|Gaps — Phase 9+ candidate components]]** — 8 cross-layer refinement candidates (strategy demotion, earnings calendar, drawdown response, capital deployment ramp, cross-strategy correlation, cross-asset signals, event-driven filings, executive departure). Documentation only; none authorized for build. Companion to the Layer-0-only [Phase 9 spec](../specs/regime-classifier-phase9-candidates.md).
- **[[symbol-analysis/README|Symbol Analysis Playbook]]** — 7-dimension worksheet methodology for evaluating any stock/ETF/fund: what-is-it, fundamentals, valuation, technicals, sentiment/options, structure, macro fit → decision framework. Use [[symbol-analysis/quick-screen|quick-screen]] for a 15-minute pass; duplicate [[symbol-analysis/worksheet-template|worksheet-template]] for a full analysis.

## North star

> _Deflated Sharpe of 1.2 with low PBO beats inflated PF of 3. Always._
>
> — Vector Core operating rule

Read [[99 - Glossary]] if any term in the diagram is unfamiliar.
