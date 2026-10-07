/**
 * RDCMNATION QUANTUM - Market Snapshot Service
 *
 * Captures market snapshots at every trading decision point.
 * Creates permanent record: "What did QUANTUM see when it made this trade?"
 */

const MarketSnapshot = require('../models/snapshot');

class SnapshotService {
  constructor(config = {}) {
    this.config = config;
    this.snapshots = new Map(); // In-memory snapshot cache
    this.snapshotsByDecision = new Map(); // Link decisions to snapshots
    this.snapshotsBySymbol = new Map(); // Quick lookup by symbol

    // Statistics
    this.stats = {
      capturedAt: new Date().toISOString(),
      totalSnapshots: 0,
      snapshotsBySymbol: {},
      lastCapture: null,
      captureErrors: 0
    };
  }

  /**
   * MAIN METHOD: Capture snapshot when trade signal arrives
   * Called at decision time, before risk validation
   */
  async captureSnapshot(decisionContext) {
    try {
      const {
        symbol,
        decisionId,
        marketData,
        indicators,
        sentiment,
        portfolio,
        broadMarket,
        signals,
        quantumScore,
        confidence
      } = decisionContext;

      // Validate required fields
      if (!symbol || !decisionId) {
        return {
          error: 'Missing required fields (symbol, decisionId)',
          timestamp: new Date().toISOString()
        };
      }

      // Build snapshot from market data
      const snapshot = new MarketSnapshot({
        timestamp: new Date().toISOString(),
        symbol: symbol,
        decisionId: decisionId,

        // Price data
        current: marketData?.current || 0,
        open: marketData?.open || 0,
        high: marketData?.high || 0,
        low: marketData?.low || 0,
        close: marketData?.close || 0,
        previousClose: marketData?.previousClose || 0,

        // Volume
        volume: marketData?.volume || 0,
        avgVolume30Day: marketData?.avgVolume30Day || 0,
        volumePercent: marketData?.volumePercent || 0,
        bid: marketData?.bid || 0,
        ask: marketData?.ask || 0,
        bidSize: marketData?.bidSize || 0,
        askSize: marketData?.askSize || 0,
        spread: marketData?.spread || 0,
        spreadPercent: marketData?.spreadPercent || 0,

        // Technical
        sma20: indicators?.sma20 || 0,
        sma50: indicators?.sma50 || 0,
        sma200: indicators?.sma200 || 0,
        ema12: indicators?.ema12 || 0,
        ema26: indicators?.ema26 || 0,
        macd: indicators?.macd || 0,
        signal: indicators?.signal || 0,
        histogram: indicators?.histogram || 0,
        rsi14: indicators?.rsi14 || 0,
        stochasticK: indicators?.stochasticK || 0,
        stochasticD: indicators?.stochasticD || 0,
        bollingerUpper: indicators?.bollingerUpper || 0,
        bollingerLower: indicators?.bollingerLower || 0,
        bollingerMiddle: indicators?.bollingerMiddle || 0,
        atr: indicators?.atr || 0,

        // Volatility
        dailyReturn: indicators?.dailyReturn || 0,
        volatility20Day: indicators?.volatility20Day || 0,
        volatility52Week: indicators?.volatility52Week || 0,
        beta: indicators?.beta || 0,
        momentum: indicators?.momentum || 0,
        rate: indicators?.rate || 0,

        // Market context
        marketOpen: marketData?.marketOpen || false,
        preMarket: marketData?.preMarket || false,
        afterHours: marketData?.afterHours || false,
        dayOfWeek: marketData?.dayOfWeek || new Date().getDay(),
        timeOfDay: marketData?.timeOfDay || new Date().getHours(),
        volumeProfile: marketData?.volumeProfile || 'normal',
        volatilityRegime: marketData?.volatilityRegime || 'normal',
        marketSentiment: marketData?.marketSentiment || 'neutral',

        // Sentiment
        newsSentiment: sentiment?.newsSentiment || 0,
        socialSentiment: sentiment?.socialSentiment || 0,
        analytistRating: sentiment?.analytistRating || 0,
        earningsDate: sentiment?.earningsDate || null,
        nextEarnings: sentiment?.nextEarnings || null,
        recentNews: sentiment?.recentNews || [],

        // Portfolio
        currentHoldings: portfolio?.holdings || {},
        portfolioExposure: portfolio?.exposure || 0,
        portfolioBeta: portfolio?.beta || 0,
        correlationWithPortfolio: portfolio?.correlation || 0,
        dailyPL: portfolio?.dailyPL || 0,
        cashAvailable: portfolio?.cash || 0,

        // Broader market
        sp500Price: broadMarket?.sp500Price || 0,
        sp500Change: broadMarket?.sp500Change || 0,
        nasdaqPrice: broadMarket?.nasdaqPrice || 0,
        nasdaqChange: broadMarket?.nasdaqChange || 0,
        vixIndex: broadMarket?.vixIndex || 0,
        sector: broadMarket?.sector || null,
        sectorPerformance: broadMarket?.sectorPerformance || 0,
        industryPerformance: broadMarket?.industryPerformance || 0,

        // Signal data
        signals: signals || {},
        quantumScore: quantumScore || 0,
        confidence: confidence || 0,

        // Quality
        dataCompleteness: 100,
        dataRecency: 0,
        dataSource: 'market-feed',
        verified: true
      });

      // Validate snapshot
      const validation = snapshot.validate();
      if (!validation.valid) {
        console.warn(`⚠️  Snapshot validation issues for ${symbol}:`, validation.issues);
      }

      // Store snapshot
      this.snapshots.set(snapshot.snapshotId, snapshot);
      this.snapshotsByDecision.set(decisionId, snapshot.snapshotId);

      // Index by symbol for quick access
      if (!this.snapshotsBySymbol.has(symbol)) {
        this.snapshotsBySymbol.set(symbol, []);
      }
      this.snapshotsBySymbol.get(symbol).push(snapshot.snapshotId);

      // Update statistics
      this.stats.totalSnapshots++;
      this.stats.snapshotsBySymbol[symbol] = (this.stats.snapshotsBySymbol[symbol] || 0) + 1;
      this.stats.lastCapture = snapshot.timestamp;

      console.log(`📸 Snapshot captured: ${symbol} (Decision: ${decisionId}) - QUANTUM Score: ${quantumScore}`);

      return {
        success: true,
        snapshotId: snapshot.snapshotId,
        symbol: symbol,
        decisionId: decisionId,
        quantumScore: quantumScore,
        timestamp: snapshot.timestamp
      };

    } catch (error) {
      this.stats.captureErrors++;
      console.error(`❌ Snapshot capture error:`, error.message);
      return {
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Retrieve snapshot for a decision
   * Used when reviewing why a trade was made
   */
  getSnapshotByDecision(decisionId) {
    const snapshotId = this.snapshotsByDecision.get(decisionId);
    if (!snapshotId) {
      return null;
    }
    return this.snapshots.get(snapshotId);
  }

  /**
   * Retrieve all snapshots for a symbol
   * Used for analysis: "What conditions triggered trades in NVDA?"
   */
  getSnapshotsBySymbol(symbol, limit = 50) {
    const snapshotIds = this.snapshotsBySymbol.get(symbol) || [];

    // Get most recent snapshots
    const recent = snapshotIds.slice(-limit);
    return recent.map(id => this.snapshots.get(id));
  }

  /**
   * Get snapshot by ID
   */
  getSnapshot(snapshotId) {
    return this.snapshots.get(snapshotId);
  }

  /**
   * Analyze snapshot: "What was the market context?"
   */
  analyzeSnapshot(snapshotId) {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      return { error: 'Snapshot not found' };
    }

    const analysis = {
      symbol: snapshot.symbol,
      timestamp: snapshot.timestamp,
      decisionId: snapshot.decisionId,

      priceContext: {
        current: snapshot.priceData.current,
        dayRange: `${snapshot.priceData.low.toFixed(2)} - ${snapshot.priceData.high.toFixed(2)}`,
        aboveMA20: snapshot.priceData.current > snapshot.technicalData.sma20,
        aboveMA50: snapshot.priceData.current > snapshot.technicalData.sma50,
        aboveMA200: snapshot.priceData.current > snapshot.technicalData.sma200
      },

      technicalSignals: snapshot.getTechnicalSignalsSummary(),

      volumeContext: {
        volume: snapshot.volumeData.volume,
        avgVolume: snapshot.volumeData.avgVolume30Day,
        volumePercent: snapshot.volumeData.volumePercent.toFixed(1),
        spread: snapshot.volumeData.spreadPercent.toFixed(3)
      },

      sentiment: {
        news: snapshot.sentimentData.newsSentiment,
        social: snapshot.sentimentData.socialSentiment,
        combined: (snapshot.sentimentData.newsSentiment + snapshot.sentimentData.socialSentiment) / 2
      },

      marketRegime: {
        volatility: snapshot.marketContext.volatilityRegime,
        sentiment: snapshot.marketContext.marketSentiment,
        broadMarket: `SPX: ${snapshot.broaderMarketData.sp500Change > 0 ? '↑' : '↓'} ${Math.abs(snapshot.broaderMarketData.sp500Change).toFixed(2)}%`,
        vix: snapshot.broaderMarketData.vixIndex.toFixed(2)
      },

      portfolio: {
        exposure: `${(snapshot.portfolioContext.portfolioExposure * 100).toFixed(1)}%`,
        correlation: snapshot.portfolioContext.correlationWithPortfolio.toFixed(2),
        dailyPL: `$${snapshot.portfolioContext.dailyPL.toFixed(2)}`
      },

      decisionSignals: {
        quantumScore: snapshot.signalData.quantumScore,
        confidence: snapshot.signalData.confidence,
        signals: Object.keys(snapshot.signalData.signals || {})
      }
    };

    return analysis;
  }

  /**
   * Compare market conditions across snapshots
   * "How did market conditions change between signal 1 and signal 2?"
   */
  compareSnapshots(snapshotId1, snapshotId2) {
    const snap1 = this.snapshots.get(snapshotId1);
    const snap2 = this.snapshots.get(snapshotId2);

    if (!snap1 || !snap2) {
      return { error: 'One or both snapshots not found' };
    }

    const comparison = MarketSnapshot.compareSnapshots(snap1, snap2);

    return {
      symbol: snap1.symbol,
      timeWindow: {
        from: snap1.timestamp,
        to: snap2.timestamp,
        elapsedSeconds: Math.round(comparison.timeElapsed / 1000)
      },

      priceMovement: {
        change: comparison.priceChange.toFixed(2),
        changePercent: comparison.priceChangePercent.toFixed(3),
        direction: comparison.priceChange > 0 ? '↑' : '↓'
      },

      volumeChange: comparison.volumeChange,
      rsiChange: comparison.rsiChange.toFixed(2),
      sentimentChange: comparison.sentimentChange.toFixed(0),

      technicalTrend: {
        before: snap1.getTechnicalSignalsSummary(),
        after: snap2.getTechnicalSignalsSummary()
      }
    };
  }

  /**
   * Export snapshots for database storage
   * Called by audit trail or data persistence layer
   */
  exportSnapshots(filter = {}) {
    const { symbol = null, limit = 100 } = filter;

    let snapshotsToExport = [];

    if (symbol) {
      const snapshotIds = this.snapshotsBySymbol.get(symbol) || [];
      snapshotsToExport = snapshotIds
        .slice(-limit)
        .map(id => this.snapshots.get(id));
    } else {
      snapshotsToExport = Array.from(this.snapshots.values()).slice(-limit);
    }

    return snapshotsToExport.map(snap => snap.toJSON());
  }

  /**
   * Get service statistics
   */
  getStats() {
    return {
      ...this.stats,
      cacheSize: this.snapshots.size,
      symbolsCaptured: Object.keys(this.stats.snapshotsBySymbol).length
    };
  }

  /**
   * Clear old snapshots (maintenance)
   * Keeps only recent snapshots in memory, persists to DB
   */
  archiveOldSnapshots(keepRecent = 10000) {
    const toArchive = [];
    const snapshotArray = Array.from(this.snapshots.values())
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    if (snapshotArray.length > keepRecent) {
      const archiveCount = snapshotArray.length - keepRecent;

      for (let i = 0; i < archiveCount; i++) {
        const snap = snapshotArray[i];
        toArchive.push(snap.toJSON());

        // Remove from cache
        this.snapshots.delete(snap.snapshotId);
        this.snapshotsByDecision.delete(snap.decisionId);
      }
    }

    return {
      archived: toArchive.length,
      remaining: this.snapshots.size,
      archiveData: toArchive
    };
  }
}

module.exports = SnapshotService;
