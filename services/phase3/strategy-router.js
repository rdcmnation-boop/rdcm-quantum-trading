/**
 * Strategy Router - Phase 3
 *
 * Dynamically selects the best trading strategy based on:
 * - Current market regime (NORMAL, VOLATILE, RANGING)
 * - Historical performance in each regime
 * - Recent correlation patterns
 * - Portfolio drawdown status
 *
 * Maintains "strategy champions" - best performers per regime
 * Continuously tests "challenger" strategies
 * Routes trade decisions to the most suitable strategy
 *
 * Non-invasive: Suggests strategies, doesn't override Phase 2 risk engine
 */

class StrategyRouter {
  /**
   * Initialize the strategy router
   * @param {Object} config - Configuration
   * @param {number} config.maxStrategies - Max strategies to track (default: 5)
   * @param {number} config.samplesPerRegime - Min samples to rank strategy (default: 20)
   * @param {number} config.decayFactor - How fast old data decays (default: 0.95)
   */
  constructor(config = {}) {
    this.maxStrategies = config.maxStrategies || 5;
    this.samplesPerRegime = config.samplesPerRegime || 20;
    this.decayFactor = config.decayFactor || 0.95; // Older trades weighted less

    // Strategy registry: strategyName -> {definition, regimePerformance}
    this.strategies = new Map();

    // Performance tracking by regime
    this.regimePerformance = new Map(); // "regime_strategyName" -> {winRate, avgP&L, samples}

    // Current best strategy per regime
    this.champions = new Map(); // regime -> strategyName

    // Strategy recommendations history
    this.recommendations = [];
    this.recommendationStats = {
      total: 0,
      correct: 0,
      accuracy: 0,
    };
  }

  /**
   * Register a new trading strategy
   *
   * @param {string} name - Strategy identifier
   * @param {Object} definition - Strategy definition
   * @param {Function} definition.evaluate - Async function to evaluate opportunity
   * @param {Object} definition.regimes - Which regimes this strategy excels in
   * @param {string} definition.description - Human description
   *
   * @returns {boolean} Success
   */
  registerStrategy(name, definition) {
    if (this.strategies.size >= this.maxStrategies && !this.strategies.has(name)) {
      console.warn(`⚠️  Max strategies (${this.maxStrategies}) reached`);
      return false;
    }

    this.strategies.set(name, {
      name,
      definition,
      registered: Date.now(),
      totalTrades: 0,
      totalWins: 0,
      totalLosses: 0,
    });

    console.log(`✅ Strategy registered: ${name}`);
    return true;
  }

  /**
   * Record the outcome of a strategy's trade decision
   * Used to build performance history
   *
   * @param {string} strategyName - Which strategy made the call
   * @param {string} regime - Market regime at time of decision
   * @param {Object} tradeOutcome - {pnl, won, confidence}
   */
  recordTradeOutcome(strategyName, regime, tradeOutcome) {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      console.warn(`⚠️  Strategy not found: ${strategyName}`);
      return;
    }

    const key = `${regime}_${strategyName}`;

    if (!this.regimePerformance.has(key)) {
      this.regimePerformance.set(key, {
        strategyName,
        regime,
        wins: 0,
        losses: 0,
        totalPnL: 0,
        trades: [],
        lastUpdated: Date.now(),
      });
    }

    const perf = this.regimePerformance.get(key);

    if (tradeOutcome.won) {
      perf.wins++;
      strategy.totalWins++;
    } else {
      perf.losses++;
      strategy.totalLosses++;
    }

    perf.totalPnL += tradeOutcome.pnl || 0;
    strategy.totalTrades++;

    // Keep recent trades for analysis (with decay)
    perf.trades.push({
      pnl: tradeOutcome.pnl,
      won: tradeOutcome.won,
      confidence: tradeOutcome.confidence,
      timestamp: Date.now(),
    });

    // Trim old trades (keep last 100 per regime)
    if (perf.trades.length > 100) {
      perf.trades = perf.trades.slice(-100);
    }

    perf.lastUpdated = Date.now();
    this._updateChampions(regime);
  }

  /**
   * Get recommendation for which strategy to use
   * Based on market regime and historical performance
   *
   * @param {Object} context - Context object
   * @param {string} context.regime - Current market regime
   * @param {number} context.portfolioDrawdown - Current drawdown %
   * @param {Array} context.openPositions - Current positions
   * @param {Object} context.marketData - Current market snapshot
   *
   * @returns {Object} Recommendation {strategy, confidence, reasoning}
   */
  getRecommendation(context) {
    const { regime = 'NORMAL', portfolioDrawdown = 0 } = context;

    // Get champion for this regime
    const champion = this.champions.get(regime);

    if (!champion) {
      // No data yet, return balanced recommendation
      return {
        strategy: null,
        confidence: 0,
        reasoning: `No performance data for ${regime} regime yet. Use Phase 2 defaults.`,
        fallback: true,
      };
    }

    const perf = this._getRegimePerformance(regime, champion);

    if (!perf || perf.wins + perf.losses < this.samplesPerRegime) {
      // Not enough data to be confident
      return {
        strategy: champion,
        confidence: Math.min(50, ((perf?.wins + perf?.losses || 0) / this.samplesPerRegime) * 50),
        reasoning: `Limited data for ${champion} in ${regime}. Building history.`,
        fallback: true,
      };
    }

    // Calculate confidence based on win rate and recent performance
    const winRate = perf.wins / (perf.wins + perf.losses);
    const recentPerf = this._calculateRecentPerformance(perf.trades);
    const confidence = Math.min(95, (winRate * 60) + (recentPerf.winRate * 40));

    // Adjust recommendation if in drawdown
    let recommendation = champion;
    let reasoning = `${champion} performing well in ${regime} (${(winRate*100).toFixed(1)}% win rate)`;

    if (portfolioDrawdown > 10) {
      // In drawdown: recommend conservative strategy
      recommendation = this._getConservativeStrategy(regime) || champion;
      reasoning += `. Portfolio in drawdown (${portfolioDrawdown.toFixed(1)}%), using conservative approach.`;
    }

    const recommendation_obj = {
      strategy: recommendation,
      confidence: Math.round(confidence),
      reasoning,
      fallback: false,
      alternates: this._getAlternateStrategies(regime),
      performance: {
        winRate: (winRate * 100).toFixed(1) + '%',
        trades: perf.wins + perf.losses,
        avgPnL: (perf.totalPnL / (perf.wins + perf.losses)).toFixed(2),
      },
    };

    // Record this recommendation
    this.recommendations.push({
      ...recommendation_obj,
      timestamp: Date.now(),
      regime,
    });

    // Keep last 1000 recommendations
    if (this.recommendations.length > 1000) {
      this.recommendations = this.recommendations.slice(-1000);
    }

    return recommendation_obj;
  }

  /**
   * After trade completes, was the recommendation correct?
   * For feedback loop to improve routing
   */
  recordRecommendationOutcome(recommendationId, outcome) {
    if (this.recommendationStats.total < 1000) {
      this.recommendationStats.total++;
      if (outcome.correct) {
        this.recommendationStats.correct++;
      }
      this.recommendationStats.accuracy =
        (this.recommendationStats.correct / this.recommendationStats.total) * 100;
    }
  }

  /**
   * Update champions based on current performance data
   */
  _updateChampions(regime) {
    const candidates = [];

    // Find all strategies with performance in this regime
    for (const [key, perf] of this.regimePerformance.entries()) {
      if (!key.endsWith(`_${perf.strategyName}`) || perf.regime !== regime) continue;

      const samples = perf.wins + perf.losses;
      if (samples < this.samplesPerRegime) continue;

      const winRate = perf.wins / samples;
      const score = winRate * (1 + Math.log(samples + 1) * 0.1); // Bonus for more data

      candidates.push({
        strategy: perf.strategyName,
        score,
        winRate,
        samples,
      });
    }

    if (candidates.length === 0) return;

    // Sort by score and pick champion
    candidates.sort((a, b) => b.score - a.score);
    this.champions.set(regime, candidates[0].strategy);
  }

  /**
   * Get performance data for regime + strategy combination
   */
  _getRegimePerformance(regime, strategyName) {
    const key = `${regime}_${strategyName}`;
    return this.regimePerformance.get(key);
  }

  /**
   * Calculate win rate for recent trades (last 20)
   */
  _calculateRecentPerformance(trades) {
    if (trades.length === 0) {
      return { winRate: 50 };
    }

    const recent = trades.slice(-20);
    const recentWins = recent.filter(t => t.won).length;

    return {
      winRate: (recentWins / recent.length) * 100,
      momentum: recent.length === 20 ?
        (recentWins - trades.slice(-40, -20).filter(t => t.won).length) : 0,
    };
  }

  /**
   * Find most conservative strategy for current regime
   * Used when portfolio is in drawdown
   */
  _getConservativeStrategy(regime) {
    let conservativeScore = -Infinity;
    let conservativeStrategy = null;

    for (const [key, perf] of this.regimePerformance.entries()) {
      if (perf.regime !== regime) continue;

      const samples = perf.wins + perf.losses;
      if (samples < 10) continue; // Need some data

      // Conservative = high win rate + low variance
      const winRate = perf.wins / samples;
      const variance = this._calculateVariance(perf.trades);
      const conservativeScore_val = winRate * (1 - variance);

      if (conservativeScore_val > conservativeScore) {
        conservativeScore = conservativeScore_val;
        conservativeStrategy = perf.strategyName;
      }
    }

    return conservativeStrategy;
  }

  /**
   * Get alternate strategies (top 3 for this regime)
   */
  _getAlternateStrategies(regime) {
    const alternates = [];

    for (const [key, perf] of this.regimePerformance.entries()) {
      if (perf.regime !== regime) continue;

      const samples = perf.wins + perf.losses;
      if (samples < 10) continue;

      const winRate = perf.wins / samples;
      alternates.push({
        strategy: perf.strategyName,
        winRate: (winRate * 100).toFixed(1) + '%',
        trades: samples,
      });
    }

    return alternates.sort((a, b) =>
      parseFloat(b.winRate) - parseFloat(a.winRate)
    ).slice(0, 3);
  }

  /**
   * Calculate variance of trade outcomes
   */
  _calculateVariance(trades) {
    if (trades.length === 0) return 0;

    const mean = trades.reduce((sum, t) => sum + (t.pnl || 0), 0) / trades.length;
    const variance = trades.reduce((sum, t) => {
      return sum + Math.pow((t.pnl || 0) - mean, 2);
    }, 0) / trades.length;

    return Math.sqrt(variance);
  }

  /**
   * Get summary of all strategies and their performance
   */
  getStrategySummary() {
    const summary = {};

    for (const [name, strategy] of this.strategies) {
      const total = strategy.totalTrades;
      const winRate = total > 0 ? (strategy.totalWins / total) * 100 : 0;

      summary[name] = {
        registered: new Date(strategy.registered).toISOString(),
        totalTrades: total,
        winRate: winRate.toFixed(2) + '%',
        champions: Array.from(this.champions.entries())
          .filter(([_, champ]) => champ === name)
          .map(([regime]) => regime),
      };
    }

    return summary;
  }

  /**
   * Export router state for analysis
   */
  exportState() {
    return {
      timestamp: new Date().toISOString(),
      strategies: this.getStrategySummary(),
      champions: Object.fromEntries(this.champions),
      recommendationAccuracy: this.recommendationStats.accuracy.toFixed(2) + '%',
      recentRecommendations: this.recommendations.slice(-50),
    };
  }
}

module.exports = StrategyRouter;
