/**
 * RDCMNATION QUANTUM - Market Simulator
 *
 * Generates realistic market data for paper trading validation.
 * NOT for backtesting (historical replay).
 * FOR: Continuous validation of Phase 2 systems in production-like conditions.
 *
 * Features:
 * - Synthetic OHLCV data with realistic patterns
 * - Technical indicator calculation (MA, RSI, MACD, Bollinger Bands)
 * - Market regime detection (trending, ranging, volatile)
 * - Sentiment simulation (news, social, analyst ratings)
 * - Volume profile modeling
 * - Correlation between symbols
 */

const crypto = require('crypto');

class MarketSimulator {
  constructor(config = {}) {
    this.config = {
      symbols: config.symbols || ['NVDA', 'AAPL', 'SPY', 'QQQ', 'TSLA'],
      timeframeMs: config.timeframeMs || 300000, // 5-minute bars
      basePrices: config.basePrices || {
        NVDA: 145,
        AAPL: 230,
        SPY: 580,
        QQQ: 450,
        TSLA: 280
      },
      volatility: config.volatility || 0.015, // 1.5% daily
      trendBias: config.trendBias || 0.0001, // Slight upward bias
      correlations: config.correlations || {
        'SPY': { 'NVDA': 0.72, 'AAPL': 0.68, 'TSLA': 0.65, 'QQQ': 0.88 },
        'QQQ': { 'NVDA': 0.81, 'AAPL': 0.75, 'TSLA': 0.70, 'SPY': 0.88 }
      }
    };

    this.marketState = new Map();
    this.technicalIndicators = new Map();
    this.regime = 'NORMAL';
    this.regimeBias = 0;
    this.ticks = 0;

    this.initializeMarket();
  }

  /**
   * Initialize market state for each symbol
   */
  initializeMarket() {
    for (const symbol of this.config.symbols) {
      const price = this.config.basePrices[symbol];
      this.marketState.set(symbol, {
        symbol,
        open: price,
        high: price * 1.01,
        low: price * 0.99,
        close: price,
        volume: Math.floor(Math.random() * 50000000) + 10000000,
        bid: price - 0.01,
        ask: price + 0.01,
        lastUpdate: Date.now(),
        history: []
      });

      this.technicalIndicators.set(symbol, {
        sma20: price,
        sma50: price,
        rsi14: 50,
        macd: 0,
        macdSignal: 0,
        bbUpper: price * 1.02,
        bbMiddle: price,
        bbLower: price * 0.98,
        atr14: price * 0.02,
        beta: 1.0
      });
    }
  }

  /**
   * Generate next market bar (5 minutes forward)
   */
  generateNextBar() {
    const bars = new Map();

    for (const symbol of this.config.symbols) {
      const state = this.marketState.get(symbol);
      const indicators = this.technicalIndicators.get(symbol);

      // Get previous close
      const prevClose = state.close;

      // Market regime influences volatility
      const regimeMultiplier = this.regime === 'VOLATILE' ? 2.0 : this.regime === 'RANGING' ? 0.5 : 1.0;
      const currentVol = this.config.volatility * regimeMultiplier;

      // Generate return with trend bias and correlation
      let returnValue = (Math.random() - 0.5) * currentVol * 2;
      returnValue += this.config.trendBias;
      returnValue += this.regimeBias * 0.001;

      // Apply correlation to tech stocks
      if (symbol === 'NVDA' || symbol === 'AAPL' || symbol === 'TSLA') {
        const qqq = this.marketState.get('QQQ');
        if (qqq) {
          const indexReturn = (qqq.close - qqq.open) / qqq.open;
          const correlation = this.config.correlations['QQQ']?.[symbol] || 0.7;
          returnValue = returnValue * (1 - correlation) + indexReturn * correlation;
        }
      }

      // Calculate new price
      const open = prevClose;
      const close = prevClose * (1 + returnValue);
      const high = Math.max(open, close) * (1 + Math.abs(Math.random() * 0.005));
      const low = Math.min(open, close) * (1 - Math.abs(Math.random() * 0.005));
      const volume = Math.floor(Math.random() * 50000000) + 10000000;

      // Volume spike on large moves
      if (Math.abs(returnValue) > 0.02) {
        volume *= 1.5;
      }

      // Update spreads based on regime and volume
      const spread = this.regime === 'VOLATILE' ? 0.03 : 0.01;
      const bid = close - spread / 2;
      const ask = close + spread / 2;

      // Update state
      state.open = open;
      state.high = high;
      state.low = low;
      state.close = close;
      state.volume = volume;
      state.bid = bid;
      state.ask = ask;
      state.lastUpdate = Date.now();

      // Keep history (last 100 bars)
      state.history.push({ open, high, low, close, volume });
      if (state.history.length > 100) {
        state.history.shift();
      }

      // Update technical indicators
      this.updateTechnicalIndicators(symbol, indicators, state.history);

      bars.set(symbol, {
        symbol,
        current: {
          open,
          high,
          low,
          close,
          volume,
          bid,
          ask,
          timestamp: new Date().toISOString()
        },
        indicators,
        regime: this.regime
      });
    }

    // Update regime occasionally (stays same 80% of time)
    this.ticks++;
    if (this.ticks % 20 === 0) {
      this.updateRegime();
    }

    return bars;
  }

  /**
   * Update technical indicators from price history
   */
  updateTechnicalIndicators(symbol, indicators, history) {
    if (history.length < 20) return;

    const closes = history.map(b => b.close);
    const highs = history.map(b => b.high);
    const lows = history.map(b => b.low);

    // SMA 20
    indicators.sma20 = closes.slice(-20).reduce((a, b) => a + b) / 20;

    // SMA 50 (use available data)
    if (closes.length >= 50) {
      indicators.sma50 = closes.slice(-50).reduce((a, b) => a + b) / 50;
    }

    // RSI 14
    indicators.rsi14 = this.calculateRSI(closes);

    // MACD
    const macd = this.calculateMACD(closes);
    indicators.macd = macd.macd;
    indicators.macdSignal = macd.signal;

    // Bollinger Bands
    const bb = this.calculateBollingerBands(closes);
    indicators.bbUpper = bb.upper;
    indicators.bbMiddle = bb.middle;
    indicators.bbLower = bb.lower;

    // ATR 14
    indicators.atr14 = this.calculateATR(highs, lows, closes);
  }

  /**
   * Calculate RSI
   */
  calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;

    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate MACD
   */
  calculateMACD(closes) {
    if (closes.length < 26) return { macd: 0, signal: 0 };

    const ema12 = this.calculateEMA(closes, 12);
    const ema26 = this.calculateEMA(closes, 26);
    const macd = ema12 - ema26;

    // Signal line (9-period EMA of MACD)
    // Simplified: use MACD value as proxy
    const signal = macd * 0.9; // Simplified

    return { macd, signal };
  }

  /**
   * Calculate Bollinger Bands
   */
  calculateBollingerBands(closes, period = 20, stdDev = 2) {
    if (closes.length < period) return { upper: closes[closes.length - 1], middle: closes[closes.length - 1], lower: closes[closes.length - 1] };

    const recent = closes.slice(-period);
    const middle = recent.reduce((a, b) => a + b) / period;
    const variance = recent.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
    const std = Math.sqrt(variance);

    return {
      upper: middle + (std * stdDev),
      middle,
      lower: middle - (std * stdDev)
    };
  }

  /**
   * Calculate ATR
   */
  calculateATR(highs, lows, closes, period = 14) {
    if (highs.length < period) return 0;

    let tr = 0;
    for (let i = Math.max(0, highs.length - period); i < highs.length; i++) {
      const h = highs[i];
      const l = lows[i];
      const pc = i > 0 ? closes[i - 1] : closes[i];
      const tr1 = h - l;
      const tr2 = Math.abs(h - pc);
      const tr3 = Math.abs(l - pc);
      tr += Math.max(tr1, tr2, tr3);
    }

    return tr / period;
  }

  /**
   * Calculate EMA (simplified)
   */
  calculateEMA(closes, period) {
    if (closes.length < period) return closes[closes.length - 1];

    const recent = closes.slice(-period);
    const sma = recent.reduce((a, b) => a + b) / period;
    const multiplier = 2 / (period + 1);
    return sma; // Simplified for paper trading
  }

  /**
   * Update market regime
   */
  updateRegime() {
    const rand = Math.random();
    if (rand < 0.1) {
      this.regime = 'VOLATILE';
      this.regimeBias = (Math.random() - 0.5) * 0.001;
    } else if (rand < 0.3) {
      this.regime = 'RANGING';
      this.regimeBias = 0;
    } else {
      this.regime = 'NORMAL';
      this.regimeBias = this.config.trendBias;
    }
  }

  /**
   * Get current market data for all symbols
   */
  getMarketData() {
    const data = {};
    for (const [symbol, state] of this.marketState) {
      data[symbol] = {
        symbol,
        price: state.close,
        open: state.open,
        high: state.high,
        low: state.low,
        volume: state.volume,
        bid: state.bid,
        ask: state.ask,
        indicators: this.technicalIndicators.get(symbol),
        regime: this.regime
      };
    }
    return data;
  }

  /**
   * Get specific market data for symbol
   */
  getMarketDataForSymbol(symbol) {
    return this.getMarketData()[symbol];
  }

  /**
   * Simulate market sentiment (news, social)
   */
  generateSentiment() {
    const sentiments = {};
    for (const symbol of this.config.symbols) {
      const state = this.marketState.get(symbol);
      const returnFromOpen = (state.close - state.open) / state.open;

      // Sentiment biased by price movement
      const newsSentiment = Math.max(-100, Math.min(100, 50 + returnFromOpen * 500));
      const socialSentiment = Math.max(-100, Math.min(100, 50 + returnFromOpen * 400 + (Math.random() - 0.5) * 50));

      sentiments[symbol] = {
        newsSentiment: Math.round(newsSentiment),
        socialSentiment: Math.round(socialSentiment),
        analystRating: 3 + (Math.random() - 0.5) // 2.5-3.5 (neutral range)
      };
    }
    return sentiments;
  }

  /**
   * Get simulator status
   */
  getStatus() {
    return {
      ticks: this.ticks,
      regime: this.regime,
      symbols: this.config.symbols.length,
      marketDataAvailable: this.getMarketData(),
      technicalIndicatorsCalculated: this.technicalIndicators.size
    };
  }
}

module.exports = MarketSimulator;
