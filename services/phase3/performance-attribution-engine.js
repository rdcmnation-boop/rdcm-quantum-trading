/**
 * Performance Attribution Engine - Phase 3
 *
 * Analyzes why each trade wins or loses by attributing P&L to:
 * - Entry timing (was the entry well-timed?)
 * - Exit timing (did we exit at the right moment?)
 * - Position sizing (was the size appropriate?)
 * - Market regime (did regime change hurt/help?)
 * - Technical factors (did technical indicators work?)
 * - Risk management (did risk rules protect us?)
 *
 * Uses this analysis to:
 * 1. Understand which factors drive profits
 * 2. Identify patterns in winning vs losing trades
 * 3. Feed back to Strategy Router for regime selection
 * 4. Improve Model A/B testing in Phase 3b
 *
 * Non-invasive: Reads Phase 2 decisions, doesn't modify them
 */

class PerformanceAttributionEngine {
  /**
   * Initialize the attribution engine
   * @param {Object} config - Configuration object
   * @param {number} config.minHoldingPeriod - Minimum bars to hold (default: 1)
   * @param {number} config.attributionWindow - Bars to analyze for attribution (default: 50)
   * @param {number} config.regressionSamples - Samples for regression analysis (default: 100)
   */
  constructor(config = {}) {
    this.minHoldingPeriod = config.minHoldingPeriod || 1;
    this.attributionWindow = config.attributionWindow || 50;
    this.regressionSamples = config.regressionSamples || 100;

    // Attribution results cache
    this.attributions = new Map(); // decisionId -> attribution data
    this.factorWeights = new Map(); // factor -> average weight contribution
    this.tradeCorrelations = new Map(); // factor -> correlation to P&L

    // Performance summaries
    this.winRate = 0;
    this.avgWinSize = 0;
    this.avgLossSize = 0;
    this.profitFactor = 0;
    this.attributionStats = {};
  }

  /**
   * Analyze a closed trade and attribute P&L to contributing factors
   *
   * @param {Object} trade - The completed trade
   * @param {Object} trade.decisionId - Unique decision identifier
   * @param {Object} trade.decision - The original decision card
   * @param {Object} trade.entry - Entry details {price, time, regime, snapshot}
   * @param {Object} trade.exit - Exit details {price, time, regime, snapshot}
   * @param {number} trade.shares - Number of shares traded
   * @param {number} trade.pnl - Profit/loss from trade
   * @param {number} trade.pnlPercent - P&L as percentage
   * @param {Array} trade.priceHistory - OHLCV data from entry to exit
   * @param {Array} trade.technicalHistory - Technical indicators over period
   *
   * @returns {Object} Attribution breakdown {factors, dominantFactor, confidence}
   */
  attributeTrade(trade) {
    if (!trade.decisionId || !trade.entry || !trade.exit) {
      console.warn('⚠️  Cannot attribute incomplete trade');
      return null;
    }

    const attribution = {
      decisionId: trade.decisionId,
      timestamp: Date.now(),
      tradeType: trade.decision.type, // BUY or SELL
      pnl: trade.pnl,
      pnlPercent: trade.pnlPercent,
      holdingBars: trade.exit.time - trade.entry.time,

      // Factor contributions
      factors: {
        entryTiming: this._attributeEntryTiming(trade),
        exitTiming: this._attributeExitTiming(trade),
        positionSizing: this._attributePositionSizing(trade),
        technicalFactor: this._attributeTechnicalFactor(trade),
        regimeShift: this._attributeRegimeShift(trade),
        riskManagement: this._attributeRiskManagement(trade),
        volatilityImpact: this._attributeVolatilityImpact(trade),
      },

      // Summary stats
      dominantFactor: null,
      secondaryFactor: null,
      confidence: 0,
      analysis: '',
    };

    // Calculate which factor was most important
    const factors = Object.entries(attribution.factors)
      .map(([name, data]) => ({name, weight: Math.abs(data.contribution)}))
      .sort((a, b) => b.weight - a.weight);

    if (factors.length > 0) {
      attribution.dominantFactor = factors[0].name;
      attribution.dominantFactor_weight = factors[0].weight;

      if (factors.length > 1) {
        attribution.secondaryFactor = factors[1].name;
        attribution.secondaryFactor_weight = factors[1].weight;
      }

      // Confidence: how well do the factors explain the trade?
      const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
      attribution.confidence = totalWeight > 0 ?
        (factors[0].weight / totalWeight) * 100 : 0;
    }

    // Generate natural language analysis
    attribution.analysis = this._generateAnalysis(attribution);

    // Cache the attribution
    this.attributions.set(trade.decisionId, attribution);

    // Update running statistics
    this._updateStatistics();

    return attribution;
  }

  /**
   * Attribute P&L to entry timing quality
   * Did we enter at a good price relative to the move?
   */
  _attributeEntryTiming(trade) {
    const entryPrice = trade.entry.price;
    const priceHistory = trade.priceHistory || [];

    if (priceHistory.length < 2) {
      return { contribution: 0, score: 50, reasoning: 'Insufficient data' };
    }

    // Find the best and worst price after entry
    const futureHigh = Math.max(...priceHistory.slice(1).map(p => p.high));
    const futureLow = Math.min(...priceHistory.slice(1).map(p => p.low));

    // Entry quality: did we buy near the low or sell near the high?
    const entryQualityScore = trade.decision.type === 'BUY' ?
      100 * (1 - (entryPrice - futureLow) / (futureHigh - futureLow)) :
      100 * (1 - (futureHigh - entryPrice) / (futureHigh - futureLow));

    const timingContribution = (entryQualityScore - 50) * 0.01; // Scale to ±1

    return {
      contribution: timingContribution,
      score: Math.max(0, Math.min(100, entryQualityScore)),
      reasoning: entryQualityScore > 75 ? 'Excellent entry' :
                 entryQualityScore > 50 ? 'Good entry timing' :
                 'Suboptimal entry timing',
    };
  }

  /**
   * Attribute P&L to exit timing quality
   * Did we hold until the peak (or bottom for shorts)?
   */
  _attributeExitTiming(trade) {
    const exitPrice = trade.exit.price;
    const priceHistory = trade.priceHistory || [];

    if (priceHistory.length < 2) {
      return { contribution: 0, score: 50, reasoning: 'Insufficient data' };
    }

    // For BUY: how close to the high did we exit?
    // For SELL: how close to the low did we exit?
    const maxPrice = Math.max(...priceHistory.map(p => p.high));
    const minPrice = Math.min(...priceHistory.map(p => p.low));

    const exitQualityScore = trade.decision.type === 'BUY' ?
      100 * (exitPrice - minPrice) / (maxPrice - minPrice) :
      100 * (maxPrice - exitPrice) / (maxPrice - minPrice);

    const timingContribution = (exitQualityScore - 50) * 0.01;

    return {
      contribution: timingContribution,
      score: Math.max(0, Math.min(100, exitQualityScore)),
      reasoning: exitQualityScore > 75 ? 'Excellent exit timing' :
                 exitQualityScore > 50 ? 'Good exit' :
                 'Early exit (left money on table)',
    };
  }

  /**
   * Attribute P&L to position sizing appropriateness
   * Was the size well-calibrated to the opportunity?
   */
  _attributePositionSizing(trade) {
    const riskScore = trade.decision.riskScore || 100;
    const sizingConfidence = trade.decision.confidenceLevel || 0;

    // Higher risk score but appropriate to confidence = good sizing
    const sizingScore = Math.min(100, riskScore * (0.5 + sizingConfidence / 100));
    const contribution = (sizingScore - 50) * 0.005; // Smaller weight than timing

    return {
      contribution: contribution,
      score: sizingScore,
      reasoning: sizingScore > 80 ? 'Right-sized for confidence level' :
                 sizingScore > 50 ? 'Acceptable sizing' :
                 'Over-sized relative to confidence',
    };
  }

  /**
   * Attribute P&L to technical factor effectiveness
   * Did the technical indicators that triggered the trade perform?
   */
  _attributeTechnicalFactor(trade) {
    const quantumScore = trade.decision.quantumScore || 50;
    const technicalComponent = trade.decision.technicalScore || 0;

    // If technical score was high and trade won, give it credit
    const technicalContribution = (technicalComponent * 0.01) * (trade.pnl > 0 ? 1 : -1);

    return {
      contribution: technicalContribution,
      score: Math.max(0, Math.min(100, technicalComponent)),
      reasoning: technicalComponent > 70 && trade.pnl > 0 ? 'Technical setup worked' :
                 technicalComponent > 70 && trade.pnl < 0 ? 'Technical setup failed' :
                 'Moderate technical conviction',
    };
  }

  /**
   * Attribute P&L to market regime shifts
   * Did a regime change (NORMAL → VOLATILE) hurt/help the trade?
   */
  _attributeRegimeShift(trade) {
    const entryRegime = trade.entry.regime;
    const exitRegime = trade.exit.regime;

    if (!entryRegime || !exitRegime) {
      return { contribution: 0, score: 50, reasoning: 'Regime data unavailable' };
    }

    // Regime changes that hurt: entering in NORMAL, exiting in VOLATILE
    const regimeChanged = entryRegime !== exitRegime;
    const regimeImpact = regimeChanged ?
      (exitRegime === 'VOLATILE' ? -0.1 : 0.05) : 0;

    return {
      contribution: regimeImpact,
      score: regimeChanged ? 40 : 75,
      reasoning: regimeChanged ?
        `Regime shifted from ${entryRegime} to ${exitRegime}` :
        `Held through stable ${entryRegime} regime`,
    };
  }

  /**
   * Attribute P&L to risk management effectiveness
   * Did our stop losses and position limits help?
   */
  _attributeRiskManagement(trade) {
    const riskScore = trade.decision.riskScore || 100;
    const maxDrawdown = trade.maxDrawdown || 0;

    // If risk score was high and we didn't hit stop loss, risk management worked
    const riskManagementScore = riskScore * (1 - Math.abs(maxDrawdown) / 100);
    const contribution = (riskManagementScore - 50) * 0.005;

    return {
      contribution: contribution,
      score: riskManagementScore,
      reasoning: riskScore > 90 ? 'Strong risk management held losses' :
                 'Moderate risk controls',
    };
  }

  /**
   * Attribute P&L to volatility changes
   * Did increasing/decreasing volatility help or hurt?
   */
  _attributeVolatilityImpact(trade) {
    const entryVol = trade.entry.volatility || 20;
    const exitVol = trade.exit.volatility || 20;
    const volChange = (exitVol - entryVol) / entryVol;

    // For BUY: increasing volatility helps (more upside), decreasing hurts
    // For SELL: opposite
    const volImpact = trade.decision.type === 'BUY' ? volChange * 0.05 : -volChange * 0.05;

    return {
      contribution: volImpact,
      score: 50 + (volImpact * 100),
      reasoning: Math.abs(volChange) > 0.1 ?
        `Volatility ${exitVol > entryVol ? 'increased' : 'decreased'} ${Math.abs(volChange*100).toFixed(1)}%` :
        'Volatility remained stable',
    };
  }

  /**
   * Generate natural language explanation of the trade
   */
  _generateAnalysis(attribution) {
    const { pnlPercent, dominantFactor, factors, confidence } = attribution;
    const factor = factors[dominantFactor];

    if (!factor) return 'Insufficient data for analysis';

    const direction = pnlPercent > 0 ? 'profitable' : 'losing';
    const amount = Math.abs(pnlPercent).toFixed(2);

    return `${direction.charAt(0).toUpperCase() + direction.slice(1)} trade (${amount}%). ` +
           `Primary driver: ${dominantFactor.replace(/([A-Z])/g, ' $1').toLowerCase()} ` +
           `(${factor.reasoning}). ` +
           `Analysis confidence: ${Math.round(confidence)}%.`;
  }

  /**
   * Update running statistics about all trades
   */
  _updateStatistics() {
    const trades = Array.from(this.attributions.values());

    if (trades.length === 0) return;

    const winningTrades = trades.filter(t => t.pnl > 0);
    const losingTrades = trades.filter(t => t.pnl < 0);

    this.winRate = (winningTrades.length / trades.length) * 100;
    this.avgWinSize = winningTrades.length > 0 ?
      winningTrades.reduce((sum, t) => sum + t.pnl, 0) / winningTrades.length : 0;
    this.avgLossSize = losingTrades.length > 0 ?
      losingTrades.reduce((sum, t) => sum + t.pnl, 0) / losingTrades.length : 0;
    this.profitFactor = Math.abs(this.avgWinSize) > 0 ?
      Math.abs(this.avgWinSize) / Math.abs(this.avgLossSize) : 0;

    // Calculate average contribution by factor
    for (const factor of Object.keys(trades[0]?.factors || {})) {
      const avg = trades.reduce((sum, t) => sum + (t.factors[factor]?.contribution || 0), 0) / trades.length;
      this.factorWeights.set(factor, avg);
    }
  }

  /**
   * Get attribution for a specific trade
   */
  getAttribution(decisionId) {
    return this.attributions.get(decisionId);
  }

  /**
   * Get summary statistics about all analyzed trades
   */
  getSummaryStats() {
    return {
      tradesAnalyzed: this.attributions.size,
      winRate: this.winRate.toFixed(2) + '%',
      avgWinSize: this.avgWinSize.toFixed(2),
      avgLossSize: this.avgLossSize.toFixed(2),
      profitFactor: this.profitFactor.toFixed(2),
      factorWeights: Object.fromEntries(this.factorWeights),
    };
  }

  /**
   * Identify which factors correlate best with winning trades
   * Returns ranked list of factors by correlation to P&L
   */
  getFactorCorrelations() {
    const trades = Array.from(this.attributions.values());
    if (trades.length < 10) {
      return { error: 'Need at least 10 trades for correlation analysis' };
    }

    const factors = Object.keys(trades[0]?.factors || {});
    const correlations = [];

    for (const factor of factors) {
      const factorValues = trades.map(t => t.factors[factor]?.contribution || 0);
      const pnlValues = trades.map(t => t.pnl);

      const correlation = this._calculatePearsonCorrelation(factorValues, pnlValues);
      correlations.push({ factor, correlation });
    }

    return correlations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  }

  /**
   * Calculate Pearson correlation coefficient between two arrays
   */
  _calculatePearsonCorrelation(x, y) {
    const n = x.length;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let sumSqX = 0;
    let sumSqY = 0;

    for (let i = 0; i < n; i++) {
      const dx = x[i] - meanX;
      const dy = y[i] - meanY;
      numerator += dx * dy;
      sumSqX += dx * dx;
      sumSqY += dy * dy;
    }

    if (sumSqX === 0 || sumSqY === 0) return 0;
    return numerator / Math.sqrt(sumSqX * sumSqY);
  }

  /**
   * Export attribution data for analysis
   */
  exportAttributions() {
    return {
      timestamp: new Date().toISOString(),
      summary: this.getSummaryStats(),
      correlations: this.getFactorCorrelations(),
      recentTrades: Array.from(this.attributions.values()).slice(-100),
    };
  }
}

module.exports = PerformanceAttributionEngine;
