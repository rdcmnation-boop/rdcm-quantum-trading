/**
 * RDCMNATION QUANTUM - Risk Validator
 * Implements the 5 core safety rules
 */

class RiskValidator {
  /**
   * RULE 1: Daily Loss Limit
   *
   * No single day losses can exceed threshold (e.g., -$500)
   * This prevents catastrophic drawdowns from a single bad day.
   */
  checkDailyLossLimit(tradeRequest, maxDailyLoss) {
    const { account, accountId } = tradeRequest;

    // Get current daily loss
    const dailyLoss = account.dailyPL || 0;

    // Calculate worst case: this trade loses immediately
    const worstCaseLoss = dailyLoss - (tradeRequest.quantity * tradeRequest.currentPrice * 0.05); // Assume 5% max loss

    if (worstCaseLoss < maxDailyLoss) {
      return {
        rule: 'DAILY_LOSS_LIMIT',
        severity: 'CRITICAL',
        reason: `Daily loss would exceed limit. Current: $${dailyLoss.toFixed(2)}, Limit: $${maxDailyLoss}, Worst case after trade: $${worstCaseLoss.toFixed(2)}`,
        currentLoss: dailyLoss,
        maxLimit: maxDailyLoss,
        worstCaseAfterTrade: worstCaseLoss
      };
    }

    return null; // No violation
  }

  /**
   * RULE 2: Max Position Size
   *
   * No single position can be more than X% of account balance.
   * Typical: 5% max per position
   *
   * This prevents putting too much capital into one stock.
   */
  checkPositionSize(tradeRequest, maxPositionPercent) {
    const { quantity, currentPrice, account } = tradeRequest;

    // Calculate position value
    const positionValue = quantity * currentPrice;
    const accountBalance = account.balance || account.buyingPower;
    const positionPercent = positionValue / accountBalance;

    // Check if exceeds max
    if (positionPercent > maxPositionPercent) {
      return {
        rule: 'MAX_POSITION_SIZE',
        severity: 'HIGH',
        reason: `Position size ${(positionPercent * 100).toFixed(2)}% exceeds max ${(maxPositionPercent * 100).toFixed(2)}%`,
        positionValue: positionValue,
        accountBalance: accountBalance,
        positionPercent: positionPercent,
        maxPercent: maxPositionPercent
      };
    }

    return null; // No violation
  }

  /**
   * RULE 3: Portfolio Exposure Limit
   *
   * Total exposure across ALL positions cannot exceed X% of buying power.
   * Typical: 50% max
   *
   * Prevents overleveraging the entire portfolio.
   */
  checkPortfolioExposure(tradeRequest, maxExposure) {
    const { quantity, currentPrice, account } = tradeRequest;

    // Calculate new exposure
    const tradeValue = quantity * currentPrice;
    const existingExposure = account.exposure || 0;
    const buyingPower = account.buyingPower || account.balance;

    // New total exposure
    const newExposure = (existingExposure + tradeValue) / buyingPower;

    if (newExposure > maxExposure) {
      return {
        rule: 'PORTFOLIO_EXPOSURE_LIMIT',
        severity: 'HIGH',
        reason: `Portfolio exposure would be ${(newExposure * 100).toFixed(2)}%, exceeds limit of ${(maxExposure * 100).toFixed(2)}%`,
        existingExposure: existingExposure,
        newTradeValue: tradeValue,
        totalExposure: existingExposure + tradeValue,
        buyingPower: buyingPower,
        exposurePercent: newExposure,
        maxExposure: maxExposure
      };
    }

    return null; // No violation
  }

  /**
   * RULE 4: Correlation Check
   *
   * Don't add positions that are too correlated with existing holdings.
   * High correlation = they move together = concentrated risk
   *
   * Typical: 0.85 max correlation
   */
  checkCorrelation(tradeRequest, maxCorrelation = 0.85) {
    const { symbol, account } = tradeRequest;

    // Get existing positions
    const positions = account.positions || {};

    // Simple correlation matrix (in production, use actual correlation data)
    // For now, we'll check against high-correlation sector groups
    const sectorCorrelations = {
      'NVDA': ['CUDA', 'INTC', 'AMD', 'ASML'],  // Semiconductors
      'TSLA': ['F', 'GM', 'NIO'],               // Auto
      'AAPL': ['MSFT', 'GOOGL'],                // Tech
      'XOM': ['CVX', 'COP', 'SLB'],             // Energy
      'JPM': ['BAC', 'WFC', 'GS'],              // Banking
      'BTC': ['ETH'],                            // Crypto
    };

    const correlated = sectorCorrelations[symbol.toUpperCase()] || [];

    // Check if any correlated symbols in current positions
    for (const held of Object.keys(positions)) {
      if (correlated.includes(held.toUpperCase())) {
        // Get correlation value (mock data for now)
        const correlation = 0.87; // Assume high correlation

        if (correlation > maxCorrelation) {
          return {
            rule: 'CORRELATION_CHECK',
            severity: 'MEDIUM',
            reason: `Proposed ${symbol} is too correlated (${correlation.toFixed(2)}) with existing position ${held}`,
            newSymbol: symbol,
            existingSymbol: held,
            correlation: correlation,
            maxAllowed: maxCorrelation,
            suggestion: `Consider reducing ${held} position before adding ${symbol}`
          };
        }
      }
    }

    return null; // No violation
  }

  /**
   * RULE 5: Duplicate Detection
   *
   * Don't place the same order twice in quick succession.
   * Typical: 60 second minimum between same symbol buys
   *
   * Prevents accidental double-orders and system glitches.
   */
  checkDuplicate(tradeRequest, timeWindowSeconds = 60) {
    const { symbol, side, quantity, recentTrades = [] } = tradeRequest;

    const now = new Date();
    const timeWindow = timeWindowSeconds * 1000; // Convert to ms

    // Check recent trades for duplicates
    for (const recentTrade of recentTrades) {
      const timeSinceOrder = now - new Date(recentTrade.timestamp);

      if (
        recentTrade.symbol === symbol &&
        recentTrade.side === side &&
        recentTrade.quantity === quantity &&
        timeSinceOrder < timeWindow
      ) {
        return {
          rule: 'DUPLICATE_DETECTION',
          severity: 'CRITICAL',
          reason: `Duplicate order detected: same ${side} ${quantity} ${symbol} ${Math.round(timeSinceOrder / 1000)}s ago`,
          previousOrderTime: recentTrade.timestamp,
          secondsSinceOrder: Math.round(timeSinceOrder / 1000),
          minTimeRequired: timeWindowSeconds,
          suggestion: 'This order is likely a system error or duplicate submission'
        };
      }
    }

    return null; // No violation
  }

  /**
   * Calculate overall risk score for a trade
   * Takes into account all factors without blocking
   * Returns 0-100 where 100 = safest
   */
  calculateRiskScore(tradeRequest, rules) {
    let score = 100;

    // Each factor reduces score if present
    const dailyLossViolation = this.checkDailyLossLimit(tradeRequest, rules.maxDailyLoss);
    if (dailyLossViolation) score -= 30;

    const positionSizeViolation = this.checkPositionSize(tradeRequest, rules.maxPositionPercent);
    if (positionSizeViolation) score -= 25;

    const exposureViolation = this.checkPortfolioExposure(tradeRequest, rules.maxExposure);
    if (exposureViolation) score -= 20;

    const correlationViolation = this.checkCorrelation(tradeRequest, rules.maxCorrelation);
    if (correlationViolation) score -= 15;

    const duplicateViolation = this.checkDuplicate(tradeRequest, rules.duplicateTimeWindow);
    if (duplicateViolation) score -= 40;

    return Math.max(0, Math.min(100, score));
  }
}

module.exports = RiskValidator;
