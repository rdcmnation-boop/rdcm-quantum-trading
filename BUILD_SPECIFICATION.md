# RDCMNATION QUANTUM - Build Specification

**Status:** Architecture Locked | Ready for Implementation  
**Version:** 1.0  
**Last Updated:** 2026-10-07

---

## 🏗️ System Architecture

```
MARKET DATA LAYER
├─ Real-time feeds (15+ feeds)
├─ News/sentiment data
├─ Economic calendar
└─ Data validation & normalization

↓

INTELLIGENCE LAYER
├─ AutoRule (Momentum)
├─ Quantum AI (ML)
├─ Mining Bot (Arbitrage)
├─ Bet Brain (Probability)
├─ Security Guard (Risk)
└─ External Consensus

↓

MASTER DECISION ENGINE
├─ Signal Fusion
├─ QUANTUM SCORE (0-100)
└─ Confidence calculation

↓

RISK ENGINE (Independent Service)
├─ Position validation
├─ Portfolio limits
├─ Daily loss protection
├─ Emergency kill switch
└─ Correlation checks

↓

EXECUTION LAYER
├─ Order validation
├─ Broker adapter selection
├─ Slippage tracking
└─ Fill reconciliation

↓

BROKER ADAPTERS (Pluggable)
├─ Robinhood
├─ Alpaca
├─ Coinbase
├─ TD Ameritrade
└─ Interactive Brokers

↓

MONITORING & LEARNING
├─ Trade journal
├─ Performance attribution
├─ Strategy backtesting
└─ Feedback loop
```

---

## 📊 Database Schema

### Users Table
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR UNIQUE NOT NULL,
  password_hash VARCHAR NOT NULL,
  subscription_tier VARCHAR (free|basic|pro|enterprise),
  created_at TIMESTAMP,
  last_login TIMESTAMP,
  2fa_enabled BOOLEAN,
  status VARCHAR (active|suspended|deleted)
);
```

### Accounts Table
```sql
CREATE TABLE accounts (
  id UUID PRIMARY KEY,
  user_id UUID FOREIGN KEY,
  type VARCHAR (paper|live),
  broker_id VARCHAR,
  balance DECIMAL(18,2),
  buying_power DECIMAL(18,2),
  created_at TIMESTAMP,
  trading_enabled BOOLEAN,
  status VARCHAR
);
```

### Brokers Table
```sql
CREATE TABLE brokers (
  id UUID PRIMARY KEY,
  user_id UUID FOREIGN KEY,
  broker_type VARCHAR (robinhood|alpaca|coinbase|td|ibkr),
  environment VARCHAR (sandbox|live),
  api_key_encrypted VARCHAR,
  status VARCHAR (connected|disconnected|error),
  last_sync TIMESTAMP,
  permissions JSON
);
```

### Strategies Table
```sql
CREATE TABLE strategies (
  id UUID PRIMARY KEY,
  name VARCHAR NOT NULL,
  type VARCHAR (momentum|ml|arbitrage|probability),
  version VARCHAR,
  enabled BOOLEAN,
  weight DECIMAL(3,2),
  performance JSON,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

### Trades Table
```sql
CREATE TABLE trades (
  id UUID PRIMARY KEY,
  account_id UUID FOREIGN KEY,
  symbol VARCHAR NOT NULL,
  side VARCHAR (BUY|SELL),
  quantity INTEGER,
  order_id VARCHAR,
  status VARCHAR (pending|filled|partial|canceled),
  entry_price DECIMAL(10,2),
  exit_price DECIMAL(10,2),
  pnl DECIMAL(18,2),
  signal_source VARCHAR (auto_rule|quantum_ai|mining_bot|bet_brain),
  quantum_score DECIMAL(3,0),
  executed_at TIMESTAMP,
  closed_at TIMESTAMP
);
```

### Audit Log Table
```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY,
  user_id UUID,
  account_id UUID,
  event_type VARCHAR,
  timestamp TIMESTAMP,
  data JSON,
  severity VARCHAR (info|warning|error)
);
```

### Risk Metrics Table
```sql
CREATE TABLE risk_metrics (
  id UUID PRIMARY KEY,
  account_id UUID FOREIGN KEY,
  daily_pnl DECIMAL(18,2),
  daily_loss DECIMAL(18,2),
  max_daily_loss DECIMAL(18,2),
  portfolio_exposure DECIMAL(5,2),
  max_exposure DECIMAL(5,2),
  max_position_size DECIMAL(5,2),
  current_drawdown DECIMAL(5,2),
  max_drawdown DECIMAL(5,2),
  updated_at TIMESTAMP
);
```

### Orders Table
```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY,
  trade_id UUID FOREIGN KEY,
  broker_order_id VARCHAR,
  symbol VARCHAR,
  quantity INTEGER,
  type VARCHAR (market|limit),
  status VARCHAR,
  filled_quantity INTEGER,
  average_price DECIMAL(10,2),
  submitted_at TIMESTAMP,
  filled_at TIMESTAMP
);
```

---

## 🔧 Backend Services

### 1. Market Data Service
**Purpose:** Aggregate real-time market data  
**Endpoints:**
```
GET /feeds/markets - List active feeds
GET /feeds/quote/:symbol - Current price
GET /feeds/historical/:symbol - Historical data
POST /feeds/validate - Validate data quality
```

**Responsibilities:**
- Connect to 15+ market data sources
- Normalize data across sources
- Detect duplicates/stale feeds
- Calculate market regimes

---

### 2. Intelligence Service
**Purpose:** Run AI/bot strategies  
**Endpoints:**
```
POST /intelligence/signal - Generate trading signal
GET /intelligence/consensus - Master bot agreement
GET /intelligence/performance - Bot performance metrics
```

**Responsibilities:**
- Execute AutoRule, Quantum AI, Mining Bot, etc.
- Calculate consensus scores
- Track bot performance
- Version control strategies

---

### 3. Decision Engine Service
**Purpose:** Fuse signals into trade decisions  
**Endpoints:**
```
POST /decision/evaluate - Score trade opportunity
GET /decision/score/:symbol - Current QUANTUM SCORE
GET /decision/rationale - Why did system recommend this?
```

**Responsibilities:**
- Combine bot signals
- Calculate QUANTUM SCORE (0-100)
- Generate trading recommendation
- Explain decision rationale

---

### 4. Risk Engine Service (INDEPENDENT)
**Purpose:** Validate all trades before execution  
**Endpoints:**
```
POST /risk/validate - Approve or block trade
GET /risk/metrics/:account - Account risk status
POST /risk/emergency-stop - Kill switch
```

**Responsibilities:**
- Check position size limits
- Monitor daily loss
- Track portfolio exposure
- Detect correlations
- **CANNOT be overridden by AI**

---

### 5. Order Execution Service
**Purpose:** Route orders to brokers  
**Endpoints:**
```
POST /execution/place-order - Submit order
GET /execution/status/:order_id - Order status
POST /execution/cancel/:order_id - Cancel order
```

**Responsibilities:**
- Order validation
- Duplicate detection
- Broker adapter selection
- Slippage tracking
- Fill confirmation

---

### 6. Broker Adapter Service
**Purpose:** Abstract broker implementations  
**Endpoints:**
```
GET /broker/quote/:symbol - Get price
POST /broker/order - Place order
GET /broker/positions - Get holdings
GET /broker/account - Account info
```

**Responsibilities:**
- Robinhood API calls
- Alpaca integration
- Coinbase crypto
- TD Ameritrade
- Interactive Brokers

---

### 7. Reconciliation Service
**Purpose:** Verify reality vs database  
**Endpoints:**
```
POST /reconciliation/check - Compare with broker
GET /reconciliation/discrepancies - List mismatches
POST /reconciliation/sync - Fix discrepancies
```

**Responsibilities:**
- Compare local state with broker
- Detect missing orders
- Identify position mismatches
- Alert on anomalies

---

### 8. Backtesting Service
**Purpose:** Test strategies historically  
**Endpoints:**
```
POST /backtest/run - Start backtest
GET /backtest/results/:id - Results
GET /backtest/performance - Metrics
```

**Responsibilities:**
- Historical data replay
- Trade simulation
- Performance calculation
- Walk-forward testing

---

### 9. Analytics Service
**Purpose:** Performance analysis & learning  
**Endpoints:**
```
GET /analytics/performance - Overall metrics
GET /analytics/attribution - Which bot made money?
GET /analytics/regime - Market condition analysis
POST /analytics/journal - Trade journal entry
```

**Responsibilities:**
- Calculate Sharpe ratio
- Attribution analysis
- Market regime detection
- Learning feedback

---

## 📡 API Contracts

### Authentication
```
POST /auth/register
{
  email: string,
  password: string
}

Response:
{
  userId: UUID,
  token: JWT,
  paperTradingAccount: UUID
}
```

### Place Order (Protected)
```
POST /trading/execute
Authorization: Bearer <TOKEN>
{
  accountId: UUID,
  symbol: string,
  action: "BUY" | "SELL",
  quantity: number,
  confidence: 0-1,
  quantumScore: 0-100
}

Response:
{
  status: "success" | "blocked" | "error",
  trade: {
    tradeId: UUID,
    symbol: string,
    quantumScore: number,
    timestamp: ISO8601,
    quantumScore: 87
  }
}
```

### Get Risk Status (Protected)
```
GET /risk/metrics/:accountId
Authorization: Bearer <TOKEN>

Response:
{
  dailyPnL: -$234,
  dailyLoss: $234,
  maxDailyLoss: $500,
  exposure: 45%,
  maxExposure: 50%,
  status: "healthy" | "warning" | "critical"
}
```

### Get QUANTUM SCORE
```
GET /quantum-score?symbol=AAPL&momentum=0.8&trend=0.7&volume=0.9

Response:
{
  symbol: "AAPL",
  quantumScore: 87,
  riskLevel: "🟢 STRONG",
  components: {
    momentum: 92,
    trend: 88,
    volume: 81,
    volatility: 79,
    liquidity: 95,
    strategiesAgreeing: 5,
    riskScore: 0.8
  }
}
```

---

## 🤖 Bot Interface

Each bot implements this interface:

```javascript
class TradingBot {
  async analyze(marketData) {
    // Returns: { signal, confidence, rationale }
    return {
      signal: "BUY",
      confidence: 0.87,
      reasoning: "Momentum breakout with high volume",
      score: 82
    };
  }

  async getPerformance() {
    // Returns: { totalTrades, winRate, profit, sharpeRatio }
    return {
      totalTrades: 142,
      winRate: 0.72,
      profit: $8420,
      sharpeRatio: 1.8
    };
  }

  async getVersion() {
    return "AutoRule v1.4";
  }
}
```

---

## 🛡️ Risk Engine Rules

```javascript
class RiskValidator {
  validate(trade, account) {
    // Rule 1: Daily loss limit
    if (account.dailyLoss > account.maxDailyLoss)
      return { blocked: true, reason: "Daily loss limit exceeded" };

    // Rule 2: Max position size
    const positionValue = trade.quantity * trade.price;
    const positionPercent = positionValue / account.balance;
    if (positionPercent > 0.05)
      return { blocked: true, reason: "Position exceeds 5% max" };

    // Rule 3: Portfolio exposure
    if (account.exposure > 0.50)
      return { blocked: true, reason: "Portfolio exposure exceeds 50%" };

    // Rule 4: Correlation check
    const correlation = calculateCorrelation(trade.symbol, account.positions);
    if (correlation > 0.85)
      return { blocked: true, reason: "Too correlated with existing holdings" };

    // Rule 5: Duplicate orders
    if (isDuplicate(trade, account.recentOrders))
      return { blocked: true, reason: "Duplicate order detected" };

    return { blocked: false, approved: true };
  }

  emergencyStop() {
    // Hard kill switch - no AI override
    return { allTrading: false, reason: "Emergency stop activated" };
  }
}
```

---

## 📱 Frontend Components

### Dashboard
- **Portfolio widget** - Cash, positions, P&L
- **Bot status** - Real-time bot states
- **QUANTUM SCORE display** - Current opportunity scores
- **Audit log** - Trade decision trail
- **Risk metrics** - Daily loss, exposure, drawdown

### Paper Trading
- Simulate trades with $100K
- Same logic as live
- Full audit trail
- No real capital at risk

### Strategy Marketplace
- Pre-built strategies
- User-created strategies
- Backtest results
- Performance comparison

### Backtest Studio
- Asset selector
- Date range picker
- Starting capital
- Results visualization
- Walk-forward validation

### Account Settings
- Connect broker
- Manage subscriptions
- 2FA setup
- API key management

---

## 🔄 Data Flow

### Trade Execution Flow
```
1. Market Data arrives
   ↓
2. Intelligence Service processes (AutoRule, Quantum AI, etc.)
   ↓
3. Signals flow to Master Decision Engine
   ↓
4. Decision Engine calculates QUANTUM SCORE
   ↓
5. Recommendation sent to Risk Engine
   ↓
6. Risk Engine validates (blocks or approves)
   ↓
7. If approved → Order Execution Service
   ↓
8. Broker Adapter routes to Robinhood/Alpaca/etc
   ↓
9. Broker executes trade
   ↓
10. Confirmation → Audit Log
   ↓
11. Trade recorded in database
   ↓
12. Analytics Service learns from outcome
```

### Reconciliation Flow
```
Scheduled every 5 minutes:
1. Reconciliation Service reads local trades
2. Queries broker for current state
3. Compares positions/fills
4. If mismatch detected → alert
5. If major discrepancy → pause trading until resolved
```

### Learning Flow
```
End of each trading day:
1. Analytics Service calculates metrics
2. Per-bot performance analysis
3. Strategy attribution
4. Market regime analysis
5. Feedback loop → Strategy Router adjusts weights
6. Next day: bots weighted by yesterday's performance
```

---

## 🚀 Deployment Pipeline

```
Dev Branch
    ↓
Tests pass
    ↓
Merge to main
    ↓
Docker build
    ↓
Deploy to staging (paper trading)
    ↓
Run backtests
    ↓
Run paper trading (48 hours)
    ↓
If stable → Deploy to production
    ↓
Enable live trading (small position size first)
    ↓
Monitor 5 days
    ↓
Gradually increase position size
```

---

## 🔐 Security Layer

```
Frontend → API Gateway
   ↓
   JWT token validation
   ↓
   Rate limiting (100 req/min)
   ↓
   Request signing
   ↓
   Backend Service
   ↓
   Database (encrypted)
   ↓
   Broker secrets in vault (never logged)
   ↓
   Audit log (all actions)
```

---

## 📈 Success Metrics

### Platform Health
- Uptime: 99.5%+
- API latency: <100ms
- Broker connection: 99%+
- Reconciliation pass rate: 99.9%+

### Trading Performance
- Win rate: 65%+
- Sharpe ratio: 1.5+
- Max drawdown: <15%
- Monthly return: 5-15%

### User Engagement
- Active users (monthly)
- Subscription conversion rate
- Customer lifetime value
- Support ticket resolution

---

## 🎯 Phase Implementation

**Phase 1 (Complete):**
- SaaS foundation (users, accounts, auth)
- Paper trading
- Broker connection center

**Phase 2 (Next):**
- Risk Engine (independent service)
- Order Execution Service
- Broker Adapters (Robinhood, Alpaca)

**Phase 3:**
- Decision Engine (signal fusion, QUANTUM SCORE)
- Backtesting Service
- Analytics Service

**Phase 4:**
- Additional brokers (Coinbase, TD, IBKR)
- Mobile app
- Quantum Memory

**Phase 5:**
- Strategy Lab (visual builder)
- Bot Championship
- White-label SaaS

---

**Architecture locked and ready to build.** ✅

Next: Assign development tasks to implement each service.
