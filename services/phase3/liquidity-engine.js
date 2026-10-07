/**
 * RDCMNATION QUANTUM - Phase 3: Liquidity Engine
 *
 * PURPOSE: Ensure trades execute with minimal slippage
 *
 * Analyzes:
 * - Bid-ask spread (tightness of market)
 * - Order book depth (how much volume at current price)
 * - Average daily volume (historical liquidity)
 * - Time of day (liquidity changes through session)
 * - Volatility state (affects spread)
 *
 * GUARANTEES:
 * - Trades execute when liquidity is adequate
 * - Alerts when liquidity is poor
 * - Scales position size down if liquidity insufficient
 * - Never blocks Phase 2 decisions (advisory only)
 */

class LiquidityEngine {
  constructor(config = {}) {
    this.config = {
      minSpreadBps: config.minSpreadBps || 2, // Min 0.02% spread acceptable
      minOrderBookDepth: config.minOrderBookDepth || 50000, // $50k at best price
      minDailyVolume: config.minDailyVolume || 100000, // $100k min daily avg
      volatilitySpreadMultiplier: config.volatilitySpreadMultiplier || 1.5, // 1.5x spread in high vol
      ...config
    };

    // Market microstructure data
    this.symbolData = new Map();

    // Statistics
    this.stats = {
      checksRun: 0,
      alertsIssued: 0,
      positionsScaled: 0,
      highLiquidityTrades: 0,
      lowLiquidityTrades: 0
    };
  }

  /**
   * Update market microstructure data for a symbol
   *
   * @param {string} symbol - Ticker symbol
   * @param {Object} data - Market data
   * @param {number} data.bid - Best bid price
   * @param {number} data.ask - Best ask price
   * @param {number} data.bidSize - Volume at bid
   * @param {number} data.askSize - Volume at ask
   * @param {number} data.lastPrice - Last trade price
   * @param {number} data.volume - Daily volume
   * @param {number} data.avgVolume - 20-day average volume
   * @param {number} data.volatility - Current volatility (%)
   * @param {number} data.timestamp - Data timestamp
   */
  updateMarketData(symbol, data) {
    if (!this.symbolData.has(symbol)) {
      this.symbolData.set(symbol, {
        history: [],
        currentMetrics: null
      });
    }

    const symbolRecord = this.symbolData.get(symbol);

    // Calculate spread
    const spread = data.ask - data.bid;
    const spreadBps = (spread / data.lastPrice) * 10000; // Basis points

    // Calculate order book depth at best prices
    const bidDepth = data.bidSize * data.bid;
    const askDepth = data.askSize * data.ask;
    const totalDepth = bidDepth + askDepth;

    // Current metrics
    const metrics = {
      symbol,
      timestamp: data.timestamp || Date.now(),
      bid: data.bid,
      ask: data.ask,
      bidSize: data.bidSize,
      askSize: data.askSize,
      spread,
      spreadBps,
      orderBookDepth: totalDepth,
      bidDepth,
      askDepth,
      dailyVolume: data.volume || 0,
      avgVolume: data.avgVolume || 0,
      volatility: data.volatility || 0,
      liquidityScore: this._calculateLiquidityScore(spreadBps, totalDepth, data.avgVolume)
    };

    symbolRecord.currentMetrics = metrics;

    // Keep last 100 updates for time-series analysis
    symbolRecord.history.push(metrics);
    if (symbolRecord.history.length > 100) {
      symbolRecord.history.shift();
    }
  }

  /**
   * MAIN: Check if trade has adequate liquidity
   *
   * @param {string} symbol - Ticker symbol
   * @param {number} tradeSize - Dollar amount of trade
   * @param {string} side - 'BUY' or 'SELL'
   * @param {Object} context - Trading context
   * @returns {Object} Liquidity assessment
   */
  assessLiquidity(symbol, tradeSize, side, context = {}) {
    this.stats.checksRun++;

    const metrics = this.symbolData.get(symbol)?.currentMetrics;

    if (!metrics) {
      return {
        symbol,
        status: 'NO_DATA',
        allowed: false,
        reason: 'No market data available for symbol',
        liquidityScore: 0,
        recommendation: 'WAIT',
        warnings: ['No liquidity data - cannot assess']
      };
    }

    const assessment = {
      symbol,
      tradeSize,
      side,
      timestamp: Date.now(),
      metrics: {
        spreadBps: metrics.spreadBps,
        orderBookDepth: metrics.orderBookDepth,
        dailyVolume: metrics.dailyVolume,
        volatility: metrics.volatility
      },
      checks: {}
    };

    // CHECK 1: Spread tightness
    const expectedSpread = this._getExpectedSpread(metrics);
    const spreadOk = metrics.spreadBps <= expectedSpread;
    assessment.checks.spread = {
      passed: spreadOk,
      actual: metrics.spreadBps,
      expected: expectedSpread,
      severity: spreadOk ? 'OK' : (metrics.spreadBps > expectedSpread * 2 ? 'CRITICAL' : 'WARNING')
    };

    // CHECK 2: Order book depth
    const depthRequired = tradeSize * 0.5; // Need 50% of trade size at current price
    const depthOk = metrics.orderBookDepth >= depthRequired;
    assessment.checks.depth = {
      passed: depthOk,
      required: depthRequired,
      available: metrics.orderBookDepth,
      severity: depthOk ? 'OK' : (metrics.orderBookDepth < depthRequired * 0.5 ? 'CRITICAL' : 'WARNING')
    };

    // CHECK 3: Daily volume vs trade size
    const volumeRatio = tradeSize / metrics.dailyVolume;
    const volumeOk = volumeRatio < 0.05; // Trade shouldn't exceed 5% of daily volume
    assessment.checks.volume = {
      passed: volumeOk,
      tradeAsPercentOfVolume: (volumeRatio * 100).toFixed(2) + '%',
      severity: volumeOk ? 'OK' : (volumeRatio > 0.1 ? 'CRITICAL' : 'WARNING')
    };

    // CHECK 4: Market hours (optional)
    const timeOfDay = new Date().getHours();
    const marketHoursOk = timeOfDay >= 9.5 && timeOfDay <= 16; // 9:30-4:00 EST
    assessment.checks.marketHours = {
      passed: marketHoursOk,
      hour: timeOfDay,
      severity: marketHoursOk ? 'OK' : 'WARNING'
    };

    // Overall decision
    const criticalViolations = Object.values(assessment.checks)
      .filter(c => c.severity === 'CRITICAL').length;
    const warnings = Object.values(assessment.checks)
      .filter(c => c.severity === 'WARNING').length;

    assessment.status = criticalViolations > 0 ? 'POOR' : warnings > 0 ? 'ADEQUATE' : 'EXCELLENT';
    assessment.allowed = criticalViolations === 0;
    assessment.liquidityScore = metrics.liquidityScore;
    assessment.confidence = this._calculateConfidence(assessment.checks);

    // Recommendations
    if (!assessment.allowed) {
      assessment.recommendation = 'BLOCK';
      assessment.reason = `Liquidity check failed: ${criticalViolations} critical issues`;
      this.stats.alertsIssued++;
    } else if (warnings > 0) {
      assessment.recommendation = 'PROCEED_WITH_CAUTION';
      assessment.reason = `${warnings} liquidity warnings`;
    } else {
      assessment.recommendation = 'PROCEED';
      assessment.reason = 'Excellent liquidity conditions';
      this.stats.highLiquidityTrades++;
    }

    // Calculate position size adjustment if needed
    if (!depthOk) {
      const scaleFactor = metrics.orderBookDepth / depthRequired;
      assessment.positionScaleRecommendation = {
        currentSize: tradeSize,
        recommendedSize: tradeSize * Math.max(0.3, scaleFactor),
        scaleFactor: scaleFactor.toFixed(2),
        reason: 'Insufficient order book depth'
      };
      this.stats.positionsScaled++;
    }

    return assessment;
  }

  /**
   * Get expected spread based on volatility and symbol
   *
   * @private
   */
  _getExpectedSpread(metrics) {
    // Base spread
    let expectedSpread = this.config.minSpreadBps;

    // Adjust for volatility (high vol = wider spreads)
    const volMultiplier = 1 + (metrics.volatility / 20); // 20% vol = 1.0x multiplier
    expectedSpread *= volMultiplier;

    // Adjust for time of day (opening/closing = wider)
    const hour = new Date().getHours();
    if (hour < 10 || hour > 15) {
      expectedSpread *= 1.3; // 30% wider outside core hours
    }

    return expectedSpread;
  }

  /**
   * Calculate liquidity score (0-100)
   * Higher = more liquid
   *
   * @private
   */
  _calculateLiquidityScore(spreadBps, orderBookDepth, avgVolume) {
    let score = 100;

    // Penalize wide spreads
    if (spreadBps > 5) score -= 30;
    else if (spreadBps > 3) score -= 15;
    else if (spreadBps > 1) score -= 5;

    // Penalize shallow order books
    if (orderBookDepth < this.config.minOrderBookDepth) {
      const ratio = orderBookDepth / this.config.minOrderBookDepth;
      score -= (1 - ratio) * 30;
    }

    // Penalize low volume
    if (avgVolume < this.config.minDailyVolume) {
      const ratio = avgVolume / this.config.minDailyVolume;
      score -= (1 - ratio) * 20;
    }

    return Math.max(0, Math.min(100, Math.round(score)));
  }

  /**
   * Calculate confidence in liquidity assessment
   *
   * @private
   */
  _calculateConfidence(checks) {
    const allOk = Object.values(checks).every(c => c.passed);
    if (allOk) return 95;

    const passedCount = Object.values(checks).filter(c => c.passed).length;
    const totalCount = Object.keys(checks).length;

    return Math.round((passedCount / totalCount) * 100);
  }

  /**
   * Get liquidity trend for a symbol (improving or degrading)
   *
   * @param {string} symbol - Ticker symbol
   * @returns {Object} Trend analysis
   */
  getTrend(symbol) {
    const record = this.symbolData.get(symbol);

    if (!record || record.history.length < 2) {
      return {
        symbol,
        status: 'INSUFFICIENT_DATA',
        dataPoints: record?.history.length || 0
      };
    }

    const history = record.history;
    const recent = history.slice(-10); // Last 10 updates

    const avgSpreadRecent = recent.reduce((s, m) => s + m.spreadBps, 0) / recent.length;
    const avgSpreadOlder = history.slice(0, 10).reduce((s, m) => s + m.spreadBps, 0) / 10;

    const spreadTrend = avgSpreadRecent < avgSpreadOlder ? 'IMPROVING' : 'DEGRADING';

    const avgDepthRecent = recent.reduce((s, m) => s + m.orderBookDepth, 0) / recent.length;
    const avgDepthOlder = history.slice(0, 10).reduce((s, m) => s + m.orderBookDepth, 0) / 10;

    const depthTrend = avgDepthRecent > avgDepthOlder ? 'IMPROVING' : 'DEGRADING';

    return {
      symbol,
      spreadTrend,
      depthTrend,
      avgSpreadRecent: avgSpreadRecent.toFixed(2),
      avgDepthRecent: Math.round(avgDepthRecent),
      dataPoints: history.length
    };
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      symbolsTracked: this.symbolData.size
    };
  }

  /**
   * Get engine status
   */
  getStatus() {
    return {
      engineStatus: 'OPERATIONAL',
      symbolsTracked: this.symbolData.size,
      checksRun: this.stats.checksRun,
      alertsIssued: this.stats.alertsIssued,
      positionsScaled: this.stats.positionsScaled
    };
  }
}

module.exports = LiquidityEngine;
