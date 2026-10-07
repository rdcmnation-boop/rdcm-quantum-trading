# Phase 2 Validation Harness - Quick Reference

📍 **Status:** Ready to run | All systems validated ✅ | Phase 3 ready 🚀

---

## What This Is

A complete paper trading validation system that runs Phase 2 components continuously and verifies:

- ✅ Risk engine blocks risky trades
- ✅ Market snapshots capture 50+ data points per decision
- ✅ Every decision is explainable with QUANTUM SCORE
- ✅ Execution runs safely in SHADOW mode (no broker calls)
- ✅ Zero data loss in logs or databases
- ✅ All systems coordinate properly

## Start Here

### Run a Quick Test (30 seconds)
```bash
node harness/run-validation.js --cycles 1000
```

### Run Extended Test (2 minutes)
```bash
node harness/run-validation.js --cycles 10000 --fast
```

### Run Long Validation (15 minutes)
```bash
node harness/run-validation.js --cycles 432000 --fast --report-every 5000
```

## What Happens When You Run It

1. **Market Simulator** generates realistic OHLCV + sentiment data
2. **Paper Trading Engine** runs the full workflow for ~5,000 market opportunities
3. **Risk Engine** validates each potential trade (blocks ~97%)
4. **Snapshots** capture complete market context for all decisions
5. **Explainability** generates QUANTUM SCORE for each signal
6. **Execution** safely simulates orders (SHADOW mode)
7. **All systems log** everything to audit trail

Output: Comprehensive report showing:
- Portfolio performance
- Risk metrics
- Trade execution stats
- Validation checkpoints
- Market regime distribution

## Files

```
harness/
├── market-simulator.js          (Generates realistic market data)
├── paper-trading-engine.js      (Runs trading workflow)
├── validation-harness.js        (Orchestrates validation)
└── run-validation.js            (CLI entry point)

PHASE_2_VALIDATION_GUIDE.md      (Comprehensive guide)
VALIDATION_HARNESS_README.md     (This file)
```

## Key Points

### Why We Run This

- **Prove Phase 2 works** in production-like conditions
- **Validate all systems** work together correctly
- **Generate data** for Phase 3 systems
- **Ensure zero data loss** over extended periods
- **Document behavior** for compliance/audit

### What It's NOT

❌ NOT a backtest system (uses simulated market data, not historical)  
❌ NOT a prediction tool (paper profits ≠ live profits)  
❌ NOT testing Phase 3 features (Phase 2 only)  

### What It IS

✅ System validation under realistic conditions  
✅ Continuous testing during development  
✅ Compliance documentation  
✅ Foundation for Phase 3 testing  

## Quick Examples

```bash
# Quick smoke test (does everything still work?)
node harness/run-validation.js --cycles 1000 --fast

# Daily CI/CD validation
node harness/run-validation.js --cycles 100000 --fast --report-every 10000

# Overnight stress test
node harness/run-validation.js --cycles 1000000 --fast --no-save

# With custom symbols
node harness/run-validation.js --cycles 5000 --symbols "AAPL,MSFT,GOOGL"

# With smaller balance (test with less capital)
node harness/run-validation.js --cycles 5000 --balance 10000

# Slow mode with detailed output
node harness/run-validation.js --cycles 500 --slow
```

## Reading the Report

After completion:

```
📊 Portfolio Performance: $103,247.50 (ROI: +3.25%)
📈 Trading: 1,250 executed, 46,000 blocked
🛡️ Risk: 153 violations caught, 95/100 avg score
✅ Validation: All 7 checks passed
```

### What Each Metric Means

| Metric | Good Range | What It Means |
|--------|-----------|---------------|
| Block Rate | 90-99% | Risk engine is properly restrictive |
| Execution Rate | 1-10% | Percentage of signals that pass risk checks |
| Avg Confidence | 60-90% | System is moderate-to-high confidence |
| Risk Score | 80-100 | All systems healthy and coordinated |
| Data Integrity | ✅ | Zero data loss, all trades logged |

## Reported Files

Each run saves a detailed JSON report:

```
reports/validation-2026-10-07T15-30-00.json
```

Contains:
- Full metrics breakdown
- Trading history (last 100 trades)
- Decision log (last 100 decisions)
- Risk violations (last 50)
- Market regime data

Access to verify:
- ✅ Risk engine working correctly
- ✅ Snapshots captured
- ✅ Decisions explainable
- ✅ Execution in SHADOW mode

## Next Phase

Once validation passes:

1. **Phase 3 - Intelligence Systems**
   - Performance Attribution Engine
   - Strategy Router
   - Correlation Engine
   - Liquidity Engine
   - Drawdown Recovery Mode

2. **Continuous Monitoring**
   - Run harness periodically
   - Alert on failures
   - Track trends

3. **Live Trading Prep**
   - 30+ days in paper mode
   - Validate zero data loss
   - Test kill switches

---

**See PHASE_2_VALIDATION_GUIDE.md for comprehensive documentation.**

🚀 Phase 2 foundation is validated and ready for Phase 3!
