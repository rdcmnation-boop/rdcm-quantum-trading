/**
 * Correlation Engine - Phase 3
 *
 * Detects hidden correlation risks in the portfolio by:
 * - Tracking rolling correlations between positions
 * - Identifying sector/market factor exposure
 * - Warning when apparently uncorrelated trades are actually correlated
 * - Suggesting position adjustments to reduce systematic risk
 * - Testing correlations across different time windows
 *
 * Feeds into Phase 2 risk engine as an advisory (risk engine still makes final call)
 * Helps Phase 3 Strategy Router understand regime-specific correlations
 *
 * Non-invasive: Informs but never blocks trades
 */

class CorrelationEngine {
  /**
   * Initialize correlation engine
   * @param {Object} config - Configuration
   * @param {number} config.lookbackPeriods - Bars of history for correlation (default: 50)
   * @param {number} config.correlationThreshold - Alert threshold (default: 0.7)
   * @param {number} config.maxCacheSize - Max position history to cache (default: 1000)
   */
  constructor(config = {}) {
    this.lookbackPeriods = config.lookbackPeriods || 50;
    this.correlationThreshold = config.correlationThreshold || 0.7;
    this.maxCacheSize = config.maxCacheSize || 1000;

    // Price history cache: symbol -> [price, price, ...]
    this.priceHistory = new Map();

    // Computed correlations: "SYMBOL1_SYMBOL2" -> {correlation, lastUpdated, regime}
    this.correlationMatrix = new Map();

    // Position risk profiles: symbol -> {sector, beta, volatility}
    this.riskProfiles = new Map();

    // Correlation alerts history
    this.alerts = [];
  }

  /**
   * Update price data for a symbol
   * @param {string} symbol - Stock ticker
   * @param {number} price - Current price
   * @param {Object} metadata - Additional metadata
   * @param {string} metadata.sector - Stock sector
   * @param {number} metadata.volatility - Current volatility
   * @param {number} metadata.beta - Beta to market
   */
  updatePrice(symbol, price, metadata = {}) {
    if (!this.priceHistory.has(symbol)) {
      this.priceHistory.set(symbol, []);
    }

    const history = this.priceHistory.get(symbol);
    history.push(price);

    // Keep only recent history
    if (history.length > this.maxCacheSize) {
      history.shift();
    }

    // Update risk profile
    this.riskProfiles.set(symbol, {
      symbol,
      sector: metadata.sector || 'UNKNOWN',
      volatility: metadata.volatility || 0,
      beta: metadata.beta || 1.0,
      lastUpdate: Date.now(),
    });
  }

  /**
   * Calculate correlation between two symbols
   * @param {string} symbol1 - First symbol
   * @param {string} symbol2 - Second symbol
   * @param {string} regime - Current market regime (for context)
   *
   * @returns {Object} {correlation, confidence, regime, details}
   */
  getCorrelation(symbol1, symbol2, regime = 'NORMAL') {
    const cacheKey = this._getCacheKey(symbol1, symbol2);
    const cached = this.correlationMatrix.get(cacheKey);

    // Return cached if fresh (updated within last bar)
    if (cached && cached.regime === regime && Date.now() - cached.lastUpdated < 5000) {
      return cached;
    }

    const hist1 = this.priceHistory.get(symbol1) || [];
    const hist2 = this.priceHistory.get(symbol2) || [];

    if (hist1.length < 2 || hist2.length < 2) {
      return {
        correlation: 0,
        confidence: 0,
        regime,
        reasoning: 'Insufficient data',
        alert: null,
      };
    }

    // Use most recent lookback periods
    const recent1 = hist1.slice(-this.lookbackPeriods);
    const recent2 = hist2.slice(-this.lookbackPeriods);

    // Calculate returns (% change)
    const returns1 = this._calculateReturns(recent1);
    const returns2 = this._calculateReturns(recent2);

    // Pearson correlation of returns
    const correlation = this._calculatePearsonCorrelation(returns1, returns2);
    const confidence = Math.min(95, (returns1.length / this.lookbackPeriods) * 100);

    // Generate alert if needed
    let alert = null;
    if (Math.abs(correlation) > this.correlationThreshold) {
      alert = {
        level: Math.abs(correlation) > 0.85 ? 'HIGH' : 'MEDIUM',
        message: `${symbol1} and ${symbol2} are highly correlated (${(correlation*100).toFixed(1)}%)`,
        recommendation: `Consider reducing ${symbol2} position size to lower portfolio risk`,
        timestamp: Date.now(),
      };

      this.alerts.push(alert);
      if (this.alerts.length > 100) {
        this.alerts = this.alerts.slice(-100);
      }
    }

    const result = {
      symbol1,
      symbol2,
      correlation: Number(correlation.toFixed(3)),
      confidence: Number(confidence.toFixed(1)),
      regime,
      details: {
        samplesUsed: returns1.length,
        lookbackBars: this.lookbackPeriods,
        regime,
        sector1: this.riskProfiles.get(symbol1)?.sector,
        sector2: this.riskProfiles.get(symbol2)?.sector,
      },
      alert,
      reasoning: this._generateReasoning(correlation, symbol1, symbol2),
      lastUpdated: Date.now(),
    };

    // Cache it
    this.correlationMatrix.set(cacheKey, result);

    return result;
  }

  /**
   * Analyze correlation of a proposed trade with existing positions
   * @param {string} newSymbol - Symbol of new position
   * @param {Array} existingPositions - [{symbol, shares}, ...]
   * @param {string} regime - Current market regime
   *
   * @returns {Object} Risk assessment {totalExposure, warnings, recommendation}
   */
  analyzePositionRisk(newSymbol, existingPositions = [], regime = 'NORMAL') {
    const correlations = [];
    const warnings = [];

    // Check correlation against each existing position
    for (const pos of existingPositions) {
      const corr = this.getCorrelation(newSymbol, pos.symbol, regime);
      correlations.push({
        against: pos.symbol,
        shares: pos.shares,
        correlation: corr.correlation,
      });

      if (corr.alert) {
        warnings.push(corr.alert);
      }
    }

    // Calculate weighted exposure
    const totalExposure = this._calculateExposure(newSymbol, correlations, existingPositions);

    return {
      newSymbol,
      correlations,
      totalExposure: totalExposure.toFixed(2),
      riskLevel: totalExposure > 0.8 ? 'HIGH' : totalExposure > 0.5 ? 'MEDIUM' : 'LOW',
      warnings,
      recommendation: this._getRecommendation(totalExposure, warnings),
      regime,
    };
  }

  /**
   * Get full correlation matrix for current portfolio
   * @param {Array} positions - Current positions [{symbol, shares}, ...]
   *
   * @returns {Object} Correlation matrix and diagnostics
   */
  getPortfolioCorrelations(positions) {
    if (positions.length === 0) {
      return { positions: 0, correlations: [], summary: 'Empty portfolio' };
    }

    const symbols = positions.map(p => p.symbol);
    const matrix = [];

    // Generate correlations for all pairs
    for (let i = 0; i < symbols.length; i++) {
      for (let j = i + 1; j < symbols.length; j++) {
        const corr = this.getCorrelation(symbols[i], symbols[j]);
        matrix.push({
          pair: `${symbols[i]}-${symbols[j]}`,
          correlation: corr.correlation,
          confidence: corr.confidence,
        });
      }
    }

    // Calculate portfolio correlation "stress"
    const correlations = matrix.map(m => Math.abs(m.correlation));
    const avgCorr = correlations.reduce((a, b) => a + b, 0) / correlations.length;
    const highCorr = correlations.filter(c => c > this.correlationThreshold).length;

    return {
      positions: symbols.length,
      pairCount: matrix.length,
      avgCorrelation: avgCorr.toFixed(3),
      highCorrelationPairs: highCorr,
      matrix,
      portfolioRisk: highCorr > (matrix.length * 0.3) ? 'HIGH' :
                     highCorr > 0 ? 'MEDIUM' : 'LOW',
      recommendation: this._getPortfolioRecommendation(matrix, highCorr),
    };
  }

  /**
   * Detect sector-level clustering risk
   * Are we accidentally overexposed to one sector?
   */
  detectSectorRisk(positions) {
    const sectorExposure = {};

    for (const pos of positions) {
      const profile = this.riskProfiles.get(pos.symbol);
      const sector = profile?.sector || 'UNKNOWN';

      if (!sectorExposure[sector]) {
        sectorExposure[sector] = { count: 0, totalShares: 0 };
      }

      sectorExposure[sector].count++;
      sectorExposure[sector].totalShares += pos.shares;
    }

    // Identify concentrated sectors
    const sectors = Object.entries(sectorExposure)
      .map(([sector, data]) => ({
        sector,
        positions: data.count,
        concentration: (data.count / positions.length) * 100,
      }))
      .sort((a, b) => b.concentration - a.concentration);

    return {
      totalSectors: sectors.length,
      sectors,
      topSector: sectors[0],
      warning: sectors[0]?.concentration > 50 ?
        `Overexposed to ${sectors[0].sector} sector (${sectors[0].concentration.toFixed(1)}%)` :
        null,
    };
  }

  /**
   * Calculate returns from price history
   */
  _calculateReturns(prices) {
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i-1]) / prices[i-1]);
    }
    return returns;
  }

  /**
   * Calculate Pearson correlation between two arrays
   */
  _calculatePearsonCorrelation(x, y) {
    if (x.length === 0 || y.length === 0) return 0;
    if (x.length !== y.length) return 0;

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
   * Get cache key for symbol pair
   */
  _getCacheKey(symbol1, symbol2) {
    return [symbol1, symbol2].sort().join('_');
  }

  /**
   * Generate reasoning for correlation
   */
  _generateReasoning(correlation, symbol1, symbol2) {
    if (Math.abs(correlation) < 0.3) {
      return `${symbol1} and ${symbol2} move independently`;
    } else if (Math.abs(correlation) < 0.7) {
      return `${symbol1} and ${symbol2} show moderate correlation`;
    } else if (correlation > 0.7) {
      return `${symbol1} and ${symbol2} move together (positive correlation)`;
    } else {
      return `${symbol1} and ${symbol2} move opposite (negative correlation)`;
    }
  }

  /**
   * Calculate portfolio exposure (0-1 scale)
   */
  _calculateExposure(symbol, correlations, positions) {
    const totalShares = positions.reduce((sum, p) => sum + p.shares, 0) || 1;
    let exposure = 0;

    for (const corr of correlations) {
      const weight = corr.shares / totalShares;
      exposure += Math.abs(corr.correlation) * weight;
    }

    return Math.min(1, exposure);
  }

  /**
   * Get trade recommendation
   */
  _getRecommendation(exposure, warnings) {
    if (exposure > 0.8) {
      return 'REJECT: High correlation risk. Position would increase portfolio correlation beyond safe levels.';
    } else if (exposure > 0.5) {
      return 'CAUTION: Consider reducing position size to lower portfolio correlation.';
    } else if (warnings.length > 0) {
      return 'PROCEED: Trade acceptable, but monitor correlation with high-correlated positions.';
    } else {
      return 'APPROVED: Low correlation risk. Position diversifies portfolio well.';
    }
  }

  /**
   * Portfolio correlation recommendation
   */
  _getPortfolioRecommendation(matrix, highCorrPairs) {
    if (highCorrPairs === 0) {
      return 'Portfolio well-diversified. Maintain current positions.';
    } else if (highCorrPairs > (matrix.length * 0.3)) {
      return 'Portfolio has clustering risk. Consider reducing correlated positions.';
    } else {
      return 'Monitor correlation. Some high-correlated pairs present but manageable.';
    }
  }

  /**
   * Export engine state
   */
  exportState() {
    return {
      timestamp: new Date().toISOString(),
      symbolsTracked: this.priceHistory.size,
      correlationsComputed: this.correlationMatrix.size,
      recentAlerts: this.alerts.slice(-20),
    };
  }
}

module.exports = CorrelationEngine;
