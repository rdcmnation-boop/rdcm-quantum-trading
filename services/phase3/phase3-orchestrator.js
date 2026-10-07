/**
 * Phase 3 Orchestrator
 *
 * Coordinates all Phase 3 intelligence systems
 * Integrates with Phase 2 for seamless operation
 * Manages data flow between components
 * Provides unified interface for Phase 2 to query Phase 3
 *
 * Non-invasive: Phase 2 risk engine always makes final decision
 */

const PerformanceAttributionEngine = require('./performance-attribution-engine');
const StrategyRouter = require('./strategy-router');
const CorrelationEngine = require('./correlation-engine');

class Phase3Orchestrator {
  /**
   * Initialize Phase 3 orchestrator
   * @param {Object} config - Configuration
   * @param {Object} config.phase2Engine - Reference to Phase 2 risk engine (read-only)
   * @param {Object} config.logger - Logger instance
   */
  constructor(config = {}) {
    this.phase2Engine = config.phase2Engine; // Read-only reference
    this.logger = config.logger || console;

    // Initialize all Phase 3 systems
    this.attribution = new PerformanceAttributionEngine(config.attribution);
    this.router = new StrategyRouter(config.router);
    this.correlation = new CorrelationEngine(config.correlation);

    // Operation statistics
    this.stats = {
      decisionsAnalyzed: 0,
      recommendationsIssued: 0,
      correlationAlerts: 0,
      attributionAnalyses: 0,
      startTime: Date.now(),
    };

    // State tracking
    this.state = 'INITIALIZING';
  }

  /**
   * Initialize Phase 3 after Phase 2 is ready
   * @returns {Promise<boolean>} Success
   */
  async initialize() {
    try {
      this.state = 'RUNNING';
      this.logger.log('✅ Phase 3 Orchestrator initialized');
      return true;
    } catch (error) {
      this.logger.error('❌ Phase 3 initialization failed:', error);
      this.state = 'ERROR';
      return false;
    }
  }

  /**
   * Analyze a trading decision (called after Phase 2 decision but before execution)
   * Returns advisory information only - Phase 2 makes final decision
   *
   * @param {Object} decision - Phase 2 decision card
   * @param {Object} context - Current market context
   * @returns {Object} Phase 3 analysis and recommendations
   */
  analyzeDecision(decision, context) {
    if (this.state !== 'RUNNING') {
      return { phase3Active: false, reason: 'Phase 3 not running' };
    }

    this.stats.decisionsAnalyzed++;

    const analysis = {
      timestamp: Date.now(),
      decisionId: decision.decisionId,
      phase3Active: true,
      recommendations: {},
      advisories: [],
      confidence: 0,
    };

    try {
      // 1. Get strategy recommendation
      const strategyRec = this.router.getRecommendation(context);
      analysis.recommendations.strategy = strategyRec;
      this.stats.recommendationsIssued++;

      // 2. Check correlation risk
      const positions = context.openPositions || [];
      const correlationRisk = this.correlation.analyzePositionRisk(
        decision.symbol,
        positions,
        context.regime
      );
      analysis.recommendations.correlation = correlationRisk;

      if (correlationRisk.warnings.length > 0) {
        analysis.advisories.push(...correlationRisk.warnings);
        this.stats.correlationAlerts += correlationRisk.warnings.length;
      }

      // 3. Calculate overall confidence
      const strategyConfidence = strategyRec.confidence || 0;
      const correlationConfidence = correlationRisk.riskLevel === 'LOW' ? 100 :
                                   correlationRisk.riskLevel === 'MEDIUM' ? 60 : 30;
      analysis.confidence = (strategyConfidence + correlationConfidence) / 2;

      // 4. Generate Phase 3 advisory
      analysis.advisory = this._generateAdvisory(analysis);

      return analysis;
    } catch (error) {
      this.logger.error('❌ Decision analysis error:', error);
      analysis.error = error.message;
      analysis.confidence = 0;
      return analysis;
    }
  }

  /**
   * Record a trade outcome (called after trade closes)
   * Feeds back to Phase 3 systems for learning
   *
   * @param {Object} trade - Completed trade
   * @param {string} trade.decisionId - Original decision ID
   * @param {number} trade.pnl - Profit/loss
   * @param {number} trade.pnlPercent - P&L as percentage
   * @param {string} trade.strategy - Which strategy was used
   * @param {string} trade.regime - Market regime during trade
   * @param {Object} trade.entry - Entry details
   * @param {Object} trade.exit - Exit details
   * @param {Array} trade.priceHistory - OHLCV data
   */
  recordTradeOutcome(trade) {
    try {
      // 1. Attribution: Why did this trade win/lose?
      const attribution = this.attribution.attributeTrade(trade);
      this.stats.attributionAnalyses++;

      if (attribution) {
        this.logger.log(`📊 Trade ${trade.decisionId}: ${attribution.analysis}`);
      }

      // 2. Strategy Router: Record for strategy performance ranking
      if (trade.strategy) {
        this.router.recordTradeOutcome(trade.strategy, trade.regime, {
          pnl: trade.pnl,
          won: trade.pnl > 0,
          confidence: trade.confidence,
        });
      }

      // 3. Correlation Engine: Update price data
      if (trade.exit && trade.exit.price) {
        this.correlation.updatePrice(trade.symbol, trade.exit.price, {
          sector: trade.sector,
          volatility: trade.exit.volatility,
          beta: trade.beta,
        });
      }

      return {
        success: true,
        attribution,
        strategyPerformance: this.router.getStrategySummary(),
      };
    } catch (error) {
      this.logger.error('❌ Trade outcome recording error:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update price data continuously (called each bar)
   * @param {Object} priceData - {symbol, open, high, low, close, volume, regime}
   */
  updateMarketData(priceData) {
    try {
      if (!priceData.symbol || priceData.close === undefined) {
        return;
      }

      // Update correlation engine with latest prices
      this.correlation.updatePrice(priceData.symbol, priceData.close, {
        sector: priceData.sector,
        volatility: priceData.volatility,
        beta: priceData.beta,
      });
    } catch (error) {
      this.logger.error('❌ Market data update error:', error);
    }
  }

  /**
   * Register a trading strategy for routing
   * @param {string} name - Strategy identifier
   * @param {Object} definition - Strategy definition
   */
  registerStrategy(name, definition) {
    return this.router.registerStrategy(name, definition);
  }

  /**
   * Generate natural language advisory from analysis
   */
  _generateAdvisory(analysis) {
    const { recommendations, advisories } = analysis;
    let advisory = '';

    // Strategy recommendation
    if (recommendations.strategy) {
      const strat = recommendations.strategy;
      advisory += `Strategy: Use ${strat.strategy} (${strat.confidence}% confidence). `;

      if (strat.fallback) {
        advisory += 'Note: Limited data, still building history. ';
      }
    }

    // Correlation risk
    if (recommendations.correlation) {
      const corr = recommendations.correlation;
      advisory += `Portfolio: ${corr.riskLevel} correlation risk. `;
      advisory += corr.recommendation + ' ';
    }

    // Alerts
    if (advisories.length > 0) {
      advisory += `⚠️  Alerts: ${advisories.map(a => a.message).join('; ')} `;
    }

    return advisory.trim();
  }

  /**
   * Get summary statistics
   */
  getSummaryStats() {
    const uptime = Date.now() - this.stats.startTime;
    return {
      state: this.state,
      uptime: `${(uptime / 1000 / 60).toFixed(1)} minutes`,
      decisionsAnalyzed: this.stats.decisionsAnalyzed,
      recommendationsIssued: this.stats.recommendationsIssued,
      correlationAlerts: this.stats.correlationAlerts,
      attributionAnalyses: this.stats.attributionAnalyses,

      attribution: this.attribution.getSummaryStats(),
      strategies: this.router.getStrategySummary(),
      correlation: this.correlation.exportState(),
    };
  }

  /**
   * Health check
   */
  getHealth() {
    return {
      state: this.state,
      components: {
        attribution: {
          status: this.attribution.attributions.size > 0 ? 'RUNNING' : 'IDLE',
          tradesAnalyzed: this.attribution.attributions.size,
        },
        router: {
          status: this.router.strategies.size > 0 ? 'RUNNING' : 'IDLE',
          strategiesRegistered: this.router.strategies.size,
        },
        correlation: {
          status: this.correlation.priceHistory.size > 0 ? 'RUNNING' : 'IDLE',
          symbolsTracked: this.correlation.priceHistory.size,
        },
      },
      timestamp: Date.now(),
    };
  }

  /**
   * Export complete state for analysis
   */
  exportState() {
    return {
      timestamp: new Date().toISOString(),
      summary: this.getSummaryStats(),
      health: this.getHealth(),
      attribution: this.attribution.exportAttributions(),
      strategies: this.router.exportState(),
      correlation: this.correlation.exportState(),
    };
  }

  /**
   * Shutdown Phase 3 gracefully
   */
  async shutdown() {
    this.state = 'SHUTTING_DOWN';

    // Export final state
    const finalState = this.exportState();
    this.logger.log('📊 Phase 3 Final State:', finalState);

    this.state = 'STOPPED';
    this.logger.log('✅ Phase 3 shutdown complete');

    return finalState;
  }
}

module.exports = Phase3Orchestrator;
