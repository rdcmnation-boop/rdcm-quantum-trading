/**
 * RDCMNATION QUANTUM - Paper Trading Engine
 *
 * Continuous validation harness for Phase 2 foundation.
 *
 * Purpose:
 * 1. Run Phase 2 systems in production-like conditions
 * 2. Generate decisions and execution logs
 * 3. Track performance and risk metrics
 * 4. Validate all systems working together
 * 5. Collect data for Phase 3 Intelligence systems
 *
 * Flow:
 * - Market simulator generates OHLCV + sentiment
 * - Risk engine validates each decision
 * - Snapshot captures complete market context
 * - Explainability generates decision card
 * - Execution routes to SHADOW mode (safe)
 * - All logged to audit trail
 */

const MarketSimulator = require('./market-simulator');
const RiskEngine = require('../services/risk-engine');
const SnapshotService = require('../services/snapshot-service');
const ExplainabilityEngine = require('../services/explainability-engine');
const { ExecutionRouter } = require('../execution/execution-modes');

class PaperTradingEngine {
  constructor(config = {}) {
    this.config = {
      accountId: config.accountId || 'PAPER_TRADING_001',
      initialBalance: config.initialBalance || 100000,
      maxPositions: config.maxPositions || 10,
      symbols: config.symbols || ['NVDA', 'AAPL', 'SPY', 'QQQ', 'TSLA'],
      ...config
    };

    // Initialize components
    this.market = new MarketSimulator({ symbols: this.config.symbols });
    this.riskEngine = new RiskEngine();
    this.snapshots = new SnapshotService();
    this.explainability = new ExplainabilityEngine();
    this.execution = new ExecutionRouter();
    this.execution.initialize({});

    // Portfolio state
    this.portfolio = {
      accountId: this.config.accountId,
      balance: this.config.initialBalance,
      cash: this.config.initialBalance,
      positions: {}, // { symbol: { quantity, avgCost, currentValue } }
      buyingPower: this.config.initialBalance,
      totalValue: this.config.initialBalance,
      dailyPL: 0,
      totalPL: 0
    };

    // Trading history
    this.trades = [];
    this.decisions = [];
    this.riskViolations = [];
    this.systemMetrics = {
      totalDecisionsEvaluated: 0,
      tradesExecuted: 0,
      tradesBlocked: 0,
      riskScore: 100,
      averageConfidence: 0,
      marketRegimeDistribution: {}
    };

    // Health tracking
    this.sessionStartTime = new Date();
    this.tickCount = 0;
  }

  /**
   * Run one trading cycle (5 minutes of market time)
   * MAIN ENTRY POINT
   */
  async runCycle() {
    this.tickCount++;

    try {
      // Step 1: Generate next market bar
      const marketBars = this.market.generateNextBar();
      const marketData = this.market.getMarketData();

      // Step 2: Generate trading signals for each symbol
      for (const symbol of this.config.symbols) {
        await this.evaluateSignal(symbol, marketData[symbol]);
      }

      // Step 3: Update portfolio metrics
      this.updatePortfolioMetrics(marketData);

      // Step 4: Check health of all systems
      await this.checkSystemHealth();

      return {
        success: true,
        tick: this.tickCount,
        timestamp: new Date().toISOString(),
        portfolio: this.portfolio,
        systemMetrics: this.systemMetrics
      };
    } catch (error) {
      console.error(`❌ Paper trading cycle failed: ${error.message}`);
      return {
        success: false,
        tick: this.tickCount,
        error: error.message
      };
    }
  }

  /**
   * Evaluate signal for a symbol and potentially generate trade
   */
  async evaluateSignal(symbol, marketData) {
    if (!marketData) return;

    this.systemMetrics.totalDecisionsEvaluated++;

    // Generate AI council scores (simplified for paper trading)
    const aiScores = this.generateAIScores(marketData);

    // Generate sentiment
    const sentiment = this.market.generateSentiment()[symbol] || {};

    // Step 1: CAPTURE SNAPSHOT
    const decisionId = `DECISION_${this.tickCount}_${symbol}`;
    const snapshotResult = await this.snapshots.captureSnapshot({
      symbol,
      decisionId,
      marketData: {
        current: marketData.price,
        open: marketData.open,
        high: marketData.high,
        low: marketData.low,
        volume: marketData.volume,
        bid: marketData.bid,
        ask: marketData.ask
      },
      indicators: marketData.indicators,
      sentiment: {
        newsSentiment: sentiment.newsSentiment || 50,
        socialSentiment: sentiment.socialSentiment || 50
      },
      quantumScore: aiScores.consensusScore,
      confidence: aiScores.confidence
    });

    // Step 2: VALIDATE WITH RISK ENGINE
    const tradeRequest = this.buildTradeRequest(symbol, marketData, aiScores);
    const riskResult = await this.riskEngine.validateTrade(tradeRequest);

    if (!riskResult.allowed) {
      this.systemMetrics.tradesBlocked++;
      this.riskViolations.push({
        timestamp: new Date().toISOString(),
        symbol,
        violations: riskResult.violations,
        decisionId
      });
      return; // Trade blocked
    }

    // Step 3: GENERATE DECISION CARD
    const card = this.explainability.generateDecisionCard({
      decisionId,
      symbol,
      action: aiScores.action,
      timestamp: new Date().toISOString(),
      aiScores,
      riskAssessment: {
        violations: riskResult.violations
      },
      confidence: aiScores.confidence
    });

    // Step 4: EXECUTE (SHADOW MODE = SAFE)
    const executionResult = await this.execution.submitOrder({
      orderId: decisionId,
      symbol,
      side: card.action,
      quantity: Math.abs(aiScores.suggestedQuantity),
      orderType: 'MARKET',
      currentMarketPrice: marketData.price
    });

    if (executionResult.success) {
      this.systemMetrics.tradesExecuted++;

      // Record trade
      const trade = {
        tradeId: decisionId,
        symbol,
        side: card.action,
        quantity: aiScores.suggestedQuantity,
        price: executionResult.executionPrice,
        slippage: executionResult.slippage,
        timestamp: new Date().toISOString(),
        quantumScore: card.quantumScore,
        confidence: card.confidence,
        sentiment: card.sentiment,
        riskScore: riskResult.score
      };

      this.trades.push(trade);
      this.decisions.push({
        decisionId,
        ...card,
        riskAssessment: riskResult
      });

      // Update portfolio (in shadow mode, tracking only)
      this.updatePortfolioForTrade(trade, executionResult);
    }
  }

  /**
   * Generate simplified AI council scores
   */
  generateAIScores(marketData) {
    const indicators = marketData.indicators || {};
    const priceChangePercent = ((marketData.price - marketData.open) / marketData.open) * 100;

    // Technical score: RSI, MA crossover
    const technicalScore = this.calculateTechnicalScore(indicators, marketData);

    // Momentum score: price movement, volume
    const volumeRatio = marketData.volume / 30000000; // Normalized
    const momentumScore = Math.max(0, Math.min(100, 50 + priceChangePercent * 10 + volumeRatio * 20));

    // Volume score: high volume is bullish
    const volumeScore = Math.min(100, volumeRatio * 60 + 30);

    // Volatility score: ATR-based
    const atr = indicators.atr14 || (marketData.price * 0.02);
    const volatilityScore = Math.min(100, (atr / marketData.price) * 5000);

    // Liquidity score: tight spreads, high volume
    const spread = marketData.ask - marketData.bid;
    const spreadPercent = (spread / marketData.price) * 100;
    const liquidityScore = Math.max(0, 100 - spreadPercent * 100);

    // Sentiment score: from market movement
    const sentimentScore = 50 + priceChangePercent * 5;

    // Consensus score: average of all
    const consensusScore = (
      technicalScore * 0.25 +
      momentumScore * 0.25 +
      volumeScore * 0.15 +
      volatilityScore * 0.1 +
      liquidityScore * 0.1 +
      Math.max(0, Math.min(100, sentimentScore)) * 0.15
    );

    // Confidence based on agreement between scores
    const scores = [technicalScore, momentumScore, volumeScore, volatilityScore, liquidityScore];
    const variance = this.calculateVariance(scores);
    const confidence = Math.max(0, Math.min(100, 100 - variance / 10));

    // Determine action
    const action = consensusScore > 65 ? 'BUY' : consensusScore < 35 ? 'SELL' : 'HOLD';

    // Position size (% of buying power)
    const positionPercent = Math.min(5, (consensusScore - 50) / 10); // 0-5%
    const suggestedQuantity = action === 'HOLD' ? 0 : Math.floor((this.portfolio.buyingPower * positionPercent / 100) / marketData.price);

    return {
      technicalScore: Math.round(technicalScore),
      momentumScore: Math.round(momentumScore),
      volumeScore: Math.round(volumeScore),
      volatilityScore: Math.round(volatilityScore),
      liquidityScore: Math.round(liquidityScore),
      sentimentScore: Math.round(Math.max(0, Math.min(100, sentimentScore))),
      consensusScore: Math.round(consensusScore),
      riskScore: 75, // Placeholder
      confidence: Math.round(confidence),
      action,
      suggestedQuantity,
      reasoning: `${action} signal: Technical=${Math.round(technicalScore)}, Momentum=${Math.round(momentumScore)}, Volume=${Math.round(volumeScore)}`
    };
  }

  /**
   * Calculate technical score
   */
  calculateTechnicalScore(indicators, marketData) {
    const rsi = indicators.rsi14 || 50;
    const aboveMa = marketData.price > (indicators.sma20 || marketData.price) ? 20 : -20;
    const macdBullish = (indicators.macd || 0) > (indicators.macdSignal || 0) ? 15 : -15;

    // RSI extreme levels are signals
    let rsiScore = 50;
    if (rsi < 30) rsiScore = 70; // Oversold = bullish
    if (rsi > 70) rsiScore = 30; // Overbought = bearish
    else rsiScore = rsi / 100 * 60 + 20; // Neutral range

    return Math.max(0, Math.min(100, rsiScore + aboveMa + macdBullish));
  }

  /**
   * Calculate variance of scores
   */
  calculateVariance(values) {
    const mean = values.reduce((a, b) => a + b) / values.length;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Build trade request for risk engine
   */
  buildTradeRequest(symbol, marketData, aiScores) {
    const quantity = Math.abs(aiScores.suggestedQuantity);
    const side = aiScores.action;

    return {
      accountId: this.config.accountId,
      symbol,
      side,
      quantity,
      currentPrice: marketData.price,
      account: {
        balance: this.portfolio.balance,
        cash: this.portfolio.cash,
        buyingPower: this.portfolio.buyingPower,
        positions: this.portfolio.positions
      },
      recentTrades: this.trades.slice(-5)
    };
  }

  /**
   * Update portfolio after trade
   */
  updatePortfolioForTrade(trade, execution) {
    const { symbol, side, quantity, price } = trade;
    const cost = quantity * execution.executionPrice;

    if (side === 'BUY') {
      if (!this.portfolio.positions[symbol]) {
        this.portfolio.positions[symbol] = {
          quantity: 0,
          avgCost: 0,
          currentValue: 0
        };
      }

      const pos = this.portfolio.positions[symbol];
      const totalCost = pos.quantity * pos.avgCost + cost;
      pos.quantity += quantity;
      pos.avgCost = totalCost / pos.quantity;
      pos.currentValue = pos.quantity * price;

      this.portfolio.cash -= cost;
    } else if (side === 'SELL' && this.portfolio.positions[symbol]) {
      const pos = this.portfolio.positions[symbol];
      const proceeds = quantity * execution.executionPrice;
      const gain = proceeds - (quantity * pos.avgCost);

      pos.quantity -= quantity;
      pos.currentValue = pos.quantity * price;

      if (pos.quantity === 0) {
        delete this.portfolio.positions[symbol];
      }

      this.portfolio.cash += proceeds;
      this.portfolio.totalPL += gain;
    }

    this.portfolio.buyingPower = this.portfolio.cash;
  }

  /**
   * Update portfolio metrics from current market prices
   */
  updatePortfolioMetrics(marketData) {
    let positionValue = 0;

    for (const [symbol, position] of Object.entries(this.portfolio.positions)) {
      if (marketData[symbol]) {
        position.currentValue = position.quantity * marketData[symbol].price;
        positionValue += position.currentValue;
      }
    }

    this.portfolio.totalValue = this.portfolio.cash + positionValue;
    this.portfolio.dailyPL = this.portfolio.totalValue - this.config.initialBalance;

    // Update system metric
    this.systemMetrics.riskScore = this.riskEngine.getStatus().overallStatus === 'HEALTHY' ? 100 : 75;
  }

  /**
   * Check system health
   */
  async checkSystemHealth() {
    // Track market regime
    const regime = this.market.regime;
    if (!this.systemMetrics.marketRegimeDistribution[regime]) {
      this.systemMetrics.marketRegimeDistribution[regime] = 0;
    }
    this.systemMetrics.marketRegimeDistribution[regime]++;

    // Update average confidence
    if (this.decisions.length > 0) {
      const avgConfidence = this.decisions.reduce((sum, d) => sum + d.confidence, 0) / this.decisions.length;
      this.systemMetrics.averageConfidence = Math.round(avgConfidence);
    }
  }

  /**
   * Get session report
   */
  getSessionReport() {
    const duration = (new Date() - this.sessionStartTime) / 1000 / 60; // minutes
    const roi = ((this.portfolio.totalValue - this.config.initialBalance) / this.config.initialBalance) * 100;

    return {
      sessionStart: this.sessionStartTime.toISOString(),
      duration: `${Math.round(duration)} minutes`,
      ticks: this.tickCount,
      portfolio: this.portfolio,
      systemMetrics: this.systemMetrics,
      trading: {
        tradesExecuted: this.systemMetrics.tradesExecuted,
        tradesBlocked: this.systemMetrics.tradesBlocked,
        blockRate: this.systemMetrics.tradesBlocked / (this.systemMetrics.tradesExecuted + this.systemMetrics.tradesBlocked) || 0,
        totalDecisionsEvaluated: this.systemMetrics.totalDecisionsEvaluated,
        executionRate: this.systemMetrics.tradesExecuted / this.systemMetrics.totalDecisionsEvaluated
      },
      performance: {
        roi: `${roi.toFixed(2)}%`,
        dailyPL: `$${this.portfolio.dailyPL.toFixed(2)}`,
        totalValue: `$${this.portfolio.totalValue.toFixed(2)}`
      },
      risk: {
        violations: this.riskViolations.length,
        avgRiskScore: this.systemMetrics.riskScore,
        avgConfidence: this.systemMetrics.averageConfidence
      },
      marketRegime: this.systemMetrics.marketRegimeDistribution
    };
  }

  /**
   * Export all trading decisions to log
   */
  exportDecisionLog() {
    return {
      sessionId: `${this.sessionStartTime.getTime()}`,
      accountId: this.config.accountId,
      decisions: this.decisions,
      trades: this.trades,
      violations: this.riskViolations,
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * Get status
   */
  getStatus() {
    return {
      running: true,
      tick: this.tickCount,
      portfolio: this.portfolio,
      systemMetrics: this.systemMetrics,
      market: this.market.getStatus()
    };
  }
}

module.exports = PaperTradingEngine;
