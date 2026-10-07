# RDCMNATION QUANTUM — Phase 2 Quick Start Guide

Use this guide to quickly understand how Phase 2 components work together.

---

## The Core Loop: How a Trade Gets Made

```
1. MARKET DATA arrives
   ↓
2. AI COUNCIL analyzes
   ↓
3. SNAPSHOT CAPTURED
   (What did QUANTUM see?)
   ↓
4. RISK ENGINE validates
   (Can we trade this safely?)
   ↓
5. DECISION CARD generated
   (Why are we doing this?)
   ↓
6. EXECUTION routed
   (SHADOW or LIVE mode)
   ↓
7. TRADE EXECUTED
   (Simulated or real)
   ↓
8. ALL SYSTEMS LOGGED
   (Permanent audit trail)
```

---

## Using Each Component

### 1. Risk Engine (Safety Firewall)

**Purpose:** No trade happens without passing 5 risk rules

```javascript
const RiskEngine = require('./services/risk-engine');
const engine = new RiskEngine();

const result = await engine.validateTrade({
  accountId: 'ACC_001',
  symbol: 'NVDA',
  side: 'BUY',
  quantity: 100,
  currentPrice: 145,
  account: {
    balance: 100000,
    cash: 50000,
    buyingPower: 100000,
    positions: {}
  },
  recentTrades: []
});

// Result:
// {
//   allowed: true/false,
//   score: 0-100,
//   violations: [ { rule, reason, severity } ],
//   reasoning: { ... }
// }

if (!result.allowed) {
  console.log('Trade blocked:', result.violations);
  return;
}
```

**The 5 Rules:**
1. Daily loss limit: Can't lose more than max per day
2. Position size: Can't put more than 5% in one trade
3. Portfolio exposure: Can't risk more than 50% total
4. Correlation: Don't add positions too similar to existing ones
5. Duplicates: Don't place same order twice in 60 seconds

---

### 2. Market Snapshot (What QUANTUM Saw)

**Purpose:** Capture complete market context at decision time

```javascript
const SnapshotService = require('./services/snapshot-service');
const service = new SnapshotService();

const result = await service.captureSnapshot({
  symbol: 'NVDA',
  decisionId: 'DECISION_001',
  marketData: {
    current: 145.50,
    open: 143,
    high: 146,
    low: 142,
    volume: 50000000,
    bid: 145.49,
    ask: 145.51
  },
  indicators: {
    sma20: 143.25,
    rsi14: 65,
    macd: 0.35
  },
  sentiment: {
    newsSentiment: 75,
    socialSentiment: 68
  },
  quantumScore: 82,
  confidence: 0.85
});

// Later: Review what QUANTUM saw
const snapshot = service.getSnapshotByDecision('DECISION_001');
const analysis = service.analyzeSnapshot(snapshot.snapshotId);

console.log(analysis);
// {
//   priceContext: { current: 145.50, aboveMA20: true, ... },
//   technicalSignals: [ "Above 20-day MA", "MACD Bullish", ... ],
//   volumeContext: { volume: 50000000, spread: 0.001%, ... },
//   sentiment: { news: 75, social: 68, combined: 71.5 },
//   marketRegime: { volatility: "normal", sentiment: "bullish" }
// }
```

---

### 3. Explainability Engine (Why This Trade?)

**Purpose:** Generate decision cards explaining every trade

```javascript
const ExplainabilityEngine = require('./services/explainability-engine');
const engine = new ExplainabilityEngine();

const card = engine.generateDecisionCard({
  decisionId: 'DECISION_001',
  symbol: 'NVDA',
  action: 'BUY',
  timestamp: new Date().toISOString(),
  aiScores: {
    technicalScore: 80,
    momentumScore: 75,
    volumeScore: 70,
    volatilityScore: 65,
    liquidityScore: 85,
    sentimentScore: 80,
    consensusScore: 75,
    riskScore: 70
  },
  riskAssessment: {
    violations: []
  },
  confidence: 0.82
});

console.log(card);
// {
//   decisionId: "DECISION_001",
//   symbol: "NVDA",
//   action: "BUY",
//   quantumScore: 76,        // 0-100
//   confidence: 82,           // 0-100
//   sentiment: "BULLISH",     // BULLISH | NEUTRAL | BEARISH
//   signals: {
//     technical: { score: 80, label: "STRONG", ... },
//     momentum: { score: 75, label: "STRONG", ... },
//     ...
//   },
//   reasoning: {
//     summary: "BULLISH signal for NVDA: Technical analysis shows bullish setup",
//     keyFactors: [ "Technical analysis...", "Strong momentum...", ... ],
//     recommendedAction: "BUY"
//   }
// }

// Export as markdown for trading log
const markdown = engine.exportDecisionCard(card.decisionId, 'markdown');
console.log(markdown);
// # Trade Decision: NVDA BUY
// **QUANTUM Score:** 76/100 | **Confidence:** 82% | **Sentiment:** BULLISH
// ## Reasoning
// ...
```

---

### 4. Execution Modes (LIVE vs SHADOW)

**Purpose:** Test safely in SHADOW mode, execute in LIVE

```javascript
const { ExecutionRouter, ExecutionMode } = require('./execution/execution-modes');

const router = new ExecutionRouter();
router.initialize({ brokerAdapter: null });

// Start in SHADOW (default, safe)
console.log(router.getMode()); // "SHADOW"

// Simulate an order (no broker call)
const result = await router.submitOrder({
  orderId: 'ORD_001',
  symbol: 'NVDA',
  side: 'BUY',
  quantity: 50,
  orderType: 'MARKET',
  currentMarketPrice: 145
});

console.log(result);
// {
//   success: true,
//   orderId: "ORD_001",
//   status: "FILLED",
//   executionPrice: 145.07,    // With realistic slippage
//   slippage: 0.07,
//   note: "SIMULATED - NOT SENT TO BROKER"
// }

// Later, after validation in paper trading:
router.switchMode(ExecutionMode.LIVE);
// Now orders go to real broker (requires explicit switch)
```

---

### 5. Health Check (System Monitoring)

**Purpose:** Know if services are healthy

```javascript
const HealthCheckSystem = require('./services/health-check');
const health = new HealthCheckSystem();

// Register services to monitor
health.registerService('risk-engine', async () => {
  // Your health check function
  return { responseTime: 10 };
});

health.registerService('market-data-feed', async () => {
  return { responseTime: 15 };
});

// Check all services
const result = await health.checkAllServices();

console.log(result);
// {
//   timestamp: "2026-10-07T05:30:00Z",
//   overallStatus: "HEALTHY",
//   services: {
//     "risk-engine": { serviceName, status: "HEALTHY", lastCheck, ... },
//     "market-data-feed": { serviceName, status: "HEALTHY", ... }
//   },
//   criticalIssues: []
// }

// Get system health anytime
const health = health.getSystemHealth();
console.log(`System status: ${health.overall}`); // "HEALTHY" | "DEGRADED" | "CRITICAL"
```

---

### 6. Service Recovery (Automatic Failover)

**Purpose:** Recover from failures gracefully

```javascript
const ServiceRecovery = require('./services/service-recovery');
const recovery = new ServiceRecovery();

// When a service fails:
const result = await recovery.handleServiceFailure(
  'market-data-feed',
  new Error('Connection lost'),
  { /* context */ }
);

console.log(result);
// {
//   serviceName: "market-data-feed",
//   recovered: true,           // Did it recover?
//   attempts: 2,               // How many tries?
//   action: "AUTO_RECOVERY_SUCCESS",
//   requiresApproval: false    // Does it need manual OK?
// }

// For critical services (risk engine, broker):
// - Auto-pause live trading
// - Require manual approval to resume
// - Logs everything to audit trail

// Resume trading after manual investigation:
recovery.resumeTrading('risk-engine', 'admin@example.com');
```

---

## End-to-End Workflow: One Complete Trade

```javascript
const RiskEngine = require('./services/risk-engine');
const SnapshotService = require('./services/snapshot-service');
const ExplainabilityEngine = require('./services/explainability-engine');
const { ExecutionRouter } = require('./execution/execution-modes');

// Initialize
const riskEngine = new RiskEngine();
const snapshots = new SnapshotService();
const explainability = new ExplainabilityEngine();
const execution = new ExecutionRouter();
execution.initialize({});

// ========== STEP 1: CAPTURE SNAPSHOT ==========
const snapshotResult = await snapshots.captureSnapshot({
  symbol: 'NVDA',
  decisionId: 'DECISION_WORKFLOW_001',
  marketData: {
    current: 145,
    volume: 50000000,
    bid: 144.99,
    ask: 145.01
  },
  indicators: { rsi14: 65, sma20: 143 },
  quantumScore: 82,
  confidence: 0.85
});

// ========== STEP 2: VALIDATE WITH RISK ENGINE ==========
const riskResult = await riskEngine.validateTrade({
  accountId: 'ACC_001',
  symbol: 'NVDA',
  side: 'BUY',
  quantity: 100,
  currentPrice: 145,
  account: {
    balance: 100000,
    cash: 50000,
    buyingPower: 100000,
    positions: {}
  },
  recentTrades: []
});

if (!riskResult.allowed) {
  console.log('BLOCKED:', riskResult.violations);
  return;
}

// ========== STEP 3: GENERATE DECISION CARD ==========
const card = explainability.generateDecisionCard({
  decisionId: 'DECISION_WORKFLOW_001',
  symbol: 'NVDA',
  action: 'BUY',
  timestamp: new Date().toISOString(),
  aiScores: {
    technicalScore: 80,
    momentumScore: 75,
    volumeScore: 70,
    volatilityScore: 65,
    liquidityScore: 85,
    sentimentScore: 80,
    consensusScore: 75,
    riskScore: riskResult.score
  },
  riskAssessment: { violations: [] },
  confidence: 0.85
});

console.log(`Decision: ${card.action} ${card.symbol}`);
console.log(`QUANTUM SCORE: ${card.quantumScore}/100`);
console.log(`Confidence: ${card.confidence}%`);
console.log(`Reasoning: ${card.reasoning.summary}`);

// ========== STEP 4: EXECUTE (SHADOW MODE = SAFE) ==========
const execution = await execution.submitOrder({
  orderId: 'ORDER_WORKFLOW_001',
  symbol: 'NVDA',
  side: 'BUY',
  quantity: 100,
  orderType: 'MARKET',
  currentMarketPrice: 145
});

if (execution.success) {
  console.log(`✅ Order executed at ${execution.executionPrice}`);
  console.log(`Slippage: ${execution.slippage} (realistic simulation)`);
  console.log(`Mode: ${execution.note}`); // "SIMULATED - NOT SENT TO BROKER"
}

// ========== ALL LOGGED ==========
// Risk validation logged ✅
// Snapshot captured ✅
// Decision card generated ✅
// Execution simulated ✅
// Everything in audit trail ✅
```

---

## Key Takeaways

| Component | Purpose | Default | Bypass Possible? |
|-----------|---------|---------|------------------|
| Risk Engine | Safety firewall | Every trade | ❌ NO (hardened) |
| Snapshot | Context capture | Every decision | ⚠️ Manual only |
| Explainability | Decision reasoning | Every trade | ✅ Yes (for research) |
| Execution | Order routing | SHADOW (safe) | ✅ Yes (manual switch to LIVE) |
| Health Check | System monitoring | Continuous | ✅ Yes (can disable) |
| Recovery | Failure handling | Automatic | ⚠️ Manual for critical services |

---

## Safety Checklist

Before running Phase 2:

- [ ] Default mode is SHADOW (not LIVE)
- [ ] Risk engine initialized with conservative limits
- [ ] Paper trading enabled
- [ ] Snapshots writing to log
- [ ] Decision cards being generated
- [ ] Health check monitoring active
- [ ] Emergency stop wired and tested
- [ ] Audit trail logging all events

Before switching to LIVE:

- [ ] 30+ days in SHADOW mode complete
- [ ] Zero data loss in logs
- [ ] Risk rules tested 10,000+ times
- [ ] Recovery tested and working
- [ ] Manual approval process defined
- [ ] Kill switch tested and working
- [ ] Broker adapter tested separately
- [ ] Risk limits set appropriately for account

---

## Debugging

**How to review a past trade:**

```javascript
// Get the snapshot that was captured
const snapshot = snapshots.getSnapshotByDecision('DECISION_001');

// Analyze what QUANTUM saw
const analysis = snapshots.analyzeSnapshot(snapshot.snapshotId);
console.log(analysis);
// See: price, technicals, volume, sentiment, regime

// Get the decision card
const card = explainability.getDecisionCard('DECISION_001');
console.log(card.reasoning);
// See: why decision was made

// Get execution details
// See: real price vs execution price
// See: actual slippage
// See: what broker returned
```

---

## Next Steps

1. Run Phase 2 in SHADOW mode for 30 days
2. Generate 10,000+ simulated trades
3. Verify all snapshots logged correctly
4. Review decision card reasoning
5. Validate risk rule accuracy
6. Test recovery procedures
7. Once confident: switch to Phase 3 (Intelligence systems)

Phase 2 is the foundation. Get it right. Run long. Then scale.

🚀 **Ready to build Phase 3!**
