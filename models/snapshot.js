/**
 * RDCMNATION QUANTUM - Market Snapshot Model
 *
 * Captures complete market state at decision time.
 * Enables: "What did QUANTUM see when making this decision?"
 */

class MarketSnapshot {
  /**
   * Create a snapshot of market conditions
   * Timestamp: when snapshot was taken
   * Symbol: what was being evaluated
   * Data: complete market context
   */
  constructor(data = {}) {
    // Metadata
    this.snapshotId = this.generateId();
    this.timestamp = data.timestamp || new Date().toISOString();
    this.symbol = data.symbol || null;
    this.decisionId = data.decisionId || null;

    // Price Data
    this.priceData = {
      current: data.current || 0,
      open: data.open || 0,
      high: data.high || 0,
      low: data.low || 0,
      close: data.close || 0,
      previousClose: data.previousClose || 0
    };

    // Volume & Liquidity
    this.volumeData = {
      volume: data.volume || 0,
      avgVolume30Day: data.avgVolume30Day || 0,
      volumePercent: data.volumePercent || 0, // % of 30-day average
      bid: data.bid || 0,
      ask: data.ask || 0,
      bidSize: data.bidSize || 0,
      askSize: data.askSize || 0,
      spread: data.spread || 0,
      spreadPercent: data.spreadPercent || 0
    };

    // Technical Indicators
    this.technicalData = {
      sma20: data.sma20 || 0,
      sma50: data.sma50 || 0,
      sma200: data.sma200 || 0,
      ema12: data.ema12 || 0,
      ema26: data.ema26 || 0,
      macd: data.macd || 0,
      signal: data.signal || 0,
      histogram: data.histogram || 0,
      rsi14: data.rsi14 || 0,
      stochasticK: data.stochasticK || 0,
      stochasticD: data.stochasticD || 0,
      bollingerUpper: data.bollingerUpper || 0,
      bollingerLower: data.bollingerLower || 0,
      bollingerMiddle: data.bollingerMiddle || 0,
      atr: data.atr || 0
    };

    // Volatility & Momentum
    this.volatilityData = {
      dailyReturn: data.dailyReturn || 0,
      volatility20Day: data.volatility20Day || 0,
      volatility52Week: data.volatility52Week || 0,
      beta: data.beta || 0,
      momentum: data.momentum || 0, // Price momentum indicator
      rate: data.rate || 0 // Rate of change
    };

    // Market Context
    this.marketContext = {
      marketOpen: data.marketOpen || false,
      preMarket: data.preMarket || false,
      afterHours: data.afterHours || false,
      dayOfWeek: data.dayOfWeek || new Date().getDay(),
      timeOfDay: data.timeOfDay || new Date().getHours(),
      volumeProfile: data.volumeProfile || 'normal', // high/normal/low
      volatilityRegime: data.volatilityRegime || 'normal', // low/normal/high/extreme
      marketSentiment: data.marketSentiment || 'neutral' // bullish/neutral/bearish
    };

    // Sentiment & News
    this.sentimentData = {
      newsSentiment: data.newsSentiment || 0, // -100 to +100
      socialSentiment: data.socialSentiment || 0, // -100 to +100
      analytistRating: data.analytistRating || 0, // 1-5
      earningsDate: data.earningsDate || null,
      nextEarnings: data.nextEarnings || null,
      recentNews: data.recentNews || []
    };

    // Portfolio Context
    this.portfolioContext = {
      currentHoldings: data.currentHoldings || {}, // symbol -> quantity
      portfolioExposure: data.portfolioExposure || 0,
      portfolioBeta: data.portfolioBeta || 0,
      correlationWithPortfolio: data.correlationWithPortfolio || 0,
      dailyPL: data.dailyPL || 0,
      cashAvailable: data.cashAvailable || 0
    };

    // Broader Market Context
    this.broaderMarketData = {
      sp500Price: data.sp500Price || 0,
      sp500Change: data.sp500Change || 0,
      nasdaqPrice: data.nasdaqPrice || 0,
      nasdaqChange: data.nasdaqChange || 0,
      vixIndex: data.vixIndex || 0,
      sector: data.sector || null,
      sectorPerformance: data.sectorPerformance || 0,
      industryPerformance: data.industryPerformance || 0
    };

    // AI Signal Data
    this.signalData = {
      signals: data.signals || {}, // key -> signal details
      quantumScore: data.quantumScore || 0,
      confidence: data.confidence || 0
    };

    // Quality metrics
    this.quality = {
      dataCompleteness: data.dataCompleteness || 100, // % of fields populated
      dataRecency: data.dataRecency || 0, // ms since data update
      dataSource: data.dataSource || 'market-feed',
      verified: data.verified || false
    };
  }

  /**
   * Generate unique snapshot ID
   */
  generateId() {
    return `SNAP_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get snapshot summary for quick review
   */
  getSummary() {
    return {
      snapshotId: this.snapshotId,
      timestamp: this.timestamp,
      symbol: this.symbol,
      price: this.priceData.current,
      volume: this.volumeData.volume,
      technicalSignals: this.getTechnicalSignalsSummary(),
      sentimentScore: this.sentimentData.newsSentiment,
      quantumScore: this.signalData.quantumScore,
      marketRegime: this.marketContext.volatilityRegime,
      portfolioImpact: {
        exposure: this.portfolioContext.portfolioExposure,
        correlation: this.portfolioContext.correlationWithPortfolio
      }
    };
  }

  /**
   * Get technical signals summary
   */
  getTechnicalSignalsSummary() {
    const signals = [];

    // Trend signals
    if (this.priceData.current > this.technicalData.sma20) {
      signals.push('Above 20-day MA');
    }
    if (this.technicalData.rsi14 > 70) {
      signals.push('Overbought (RSI > 70)');
    } else if (this.technicalData.rsi14 < 30) {
      signals.push('Oversold (RSI < 30)');
    }

    // Momentum signals
    if (this.technicalData.macd > this.technicalData.signal) {
      signals.push('MACD Bullish');
    } else if (this.technicalData.macd < this.technicalData.signal) {
      signals.push('MACD Bearish');
    }

    return signals;
  }

  /**
   * Export snapshot to JSON (for database/audit trail)
   */
  toJSON() {
    return {
      snapshotId: this.snapshotId,
      timestamp: this.timestamp,
      symbol: this.symbol,
      decisionId: this.decisionId,
      priceData: this.priceData,
      volumeData: this.volumeData,
      technicalData: this.technicalData,
      volatilityData: this.volatilityData,
      marketContext: this.marketContext,
      sentimentData: this.sentimentData,
      portfolioContext: this.portfolioContext,
      broaderMarketData: this.broaderMarketData,
      signalData: this.signalData,
      quality: this.quality,
      exportedAt: new Date().toISOString()
    };
  }

  /**
   * Validate snapshot data quality
   */
  validate() {
    const issues = [];

    // Must have symbol
    if (!this.symbol) {
      issues.push('Missing symbol');
    }

    // Must have valid timestamp
    if (!this.timestamp || isNaN(new Date(this.timestamp).getTime())) {
      issues.push('Invalid timestamp');
    }

    // Price must be positive
    if (this.priceData.current <= 0) {
      issues.push('Invalid current price');
    }

    // Volume should be non-negative
    if (this.volumeData.volume < 0) {
      issues.push('Negative volume');
    }

    return {
      valid: issues.length === 0,
      issues: issues,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Compare two snapshots (e.g., price movement since last signal)
   */
  static compareSnapshots(snapshot1, snapshot2) {
    return {
      timeElapsed: new Date(snapshot2.timestamp) - new Date(snapshot1.timestamp),
      priceChange: snapshot2.priceData.current - snapshot1.priceData.current,
      priceChangePercent: ((snapshot2.priceData.current - snapshot1.priceData.current) / snapshot1.priceData.current * 100),
      volumeChange: snapshot2.volumeData.volume - snapshot1.volumeData.volume,
      rsiChange: snapshot2.technicalData.rsi14 - snapshot1.technicalData.rsi14,
      sentimentChange: snapshot2.sentimentData.newsSentiment - snapshot1.sentimentData.newsSentiment
    };
  }
}

module.exports = MarketSnapshot;
