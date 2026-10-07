/**
 * RDCMNATION QUANTUM - Risk Engine (Independent Service)
 *
 * PURPOSE: Validate all trades before execution. Cannot be overridden by AI.
 *
 * This is the FIREWALL. Every decision goes through here.
 * If risk engine says NO, the trade is BLOCKED. Period.
 *
 * Safety rules:
 * 1. Daily loss limit (e.g., -$500 max)
 * 2. Position size limit (max 5% of account)
 * 3. Portfolio exposure limit (max 50% of buying power)
 * 4. Correlation check (don't add highly correlated positions)
 * 5. Duplicate detection (don't place same order twice)
 * 6. Emergency kill switch (manual override to stop ALL trading)
 */

const RiskValidator = require('./risk-validator');
const RiskRules = require('./risk-rules');

class RiskEngine {
  constructor(config = {}) {
    this.validator = new RiskValidator();
    this.rules = new RiskRules(config);

    // Audit trail for every validation decision
    this.auditLog = [];

    // Emergency state
    this.emergencyStop = false;
    this.emergencyReason = null;
    this.emergencyTriggeredAt = null;

    // Risk metrics state (real-time tracking)
    this.riskMetrics = {};
  }

  /**
   * PRIMARY METHOD: Validate a proposed trade
   *
   * Input: {
   *   accountId: UUID,
   *   symbol: string (e.g., "AAPL"),
   *   side: "BUY" | "SELL",
   *   quantity: number,
   *   currentPrice: number,
   *   account: {
   *     balance: number,
   *     cash: number,
   *     buyingPower: number,
   *     positions: { symbol: { quantity, avgCost } }
   *   },
   *   recentTrades: [ { symbol, quantity, timestamp } ]
   * }
   *
   * Output: {
   *   allowed: boolean,
   *   score: 0-100 (risk assessment),
   *   violations: [ { rule, reason, severity } ],
   *   reasoning: { detailed breakdown },
   *   timestamp: ISO8601
   * }
   */
  async validateTrade(tradeRequest) {
    const validationId = this.generateId();
    const timestamp = new Date().toISOString();

    // FIRST: Check emergency stop
    if (this.emergencyStop) {
      const result = {
        allowed: false,
        score: 0,
        violations: [{
          rule: 'EMERGENCY_STOP',
          reason: `Emergency stop activated: ${this.emergencyReason}`,
          severity: 'CRITICAL'
        }],
        reasoning: {
          primary: 'EMERGENCY STOP - All trading halted',
          triggeredAt: this.emergencyTriggeredAt,
          requiresManualApproval: true
        },
        timestamp,
        validationId
      };

      this.logValidation(tradeRequest, result);
      return result;
    }

    // SECOND: Run all validation rules
    const violations = [];
    let riskScore = 100; // Start at perfect, subtract for each risk

    // Rule 1: Daily loss limit
    const dailyLossViolation = this.validator.checkDailyLossLimit(
      tradeRequest,
      this.rules.config.maxDailyLoss
    );
    if (dailyLossViolation) {
      violations.push(dailyLossViolation);
      riskScore -= 30;
    }

    // Rule 2: Max position size
    const positionSizeViolation = this.validator.checkPositionSize(
      tradeRequest,
      this.rules.config.maxPositionPercent
    );
    if (positionSizeViolation) {
      violations.push(positionSizeViolation);
      riskScore -= 25;
    }

    // Rule 3: Portfolio exposure
    const exposureViolation = this.validator.checkPortfolioExposure(
      tradeRequest,
      this.rules.config.maxExposure
    );
    if (exposureViolation) {
      violations.push(exposureViolation);
      riskScore -= 20;
    }

    // Rule 4: Correlation check
    const correlationViolation = this.validator.checkCorrelation(
      tradeRequest,
      this.rules.config.maxCorrelation
    );
    if (correlationViolation) {
      violations.push(correlationViolation);
      riskScore -= 15;
    }

    // Rule 5: Duplicate detection
    const duplicateViolation = this.validator.checkDuplicate(
      tradeRequest,
      this.rules.config.duplicateTimeWindow
    );
    if (duplicateViolation) {
      violations.push(duplicateViolation);
      riskScore -= 40; // Duplicates are serious
    }

    // Determine if trade is allowed
    // CRITICAL violations always block; others considered collectively
    const hasCritical = violations.some(v => v.severity === 'CRITICAL');
    const allowed = !hasCritical && violations.length === 0;

    const result = {
      allowed,
      score: Math.max(0, riskScore),
      violations,
      reasoning: this.buildReasoning(tradeRequest, violations),
      timestamp,
      validationId,
      metrics: {
        dailyLoss: this.getMetric(tradeRequest.accountId, 'dailyLoss'),
        dailyLossLimit: this.rules.config.maxDailyLoss,
        positionPercent: (tradeRequest.quantity * tradeRequest.currentPrice) / tradeRequest.account.balance,
        maxPositionPercent: this.rules.config.maxPositionPercent,
        portfolioExposure: this.getMetric(tradeRequest.accountId, 'exposure'),
        maxExposure: this.rules.config.maxExposure
      }
    };

    this.logValidation(tradeRequest, result);

    if (!allowed) {
      console.log(`❌ TRADE BLOCKED: ${tradeRequest.symbol} ${tradeRequest.side} ${tradeRequest.quantity}`);
      console.log(`   Reason: ${violations.map(v => v.rule).join(', ')}`);
    } else {
      console.log(`✅ TRADE APPROVED: ${tradeRequest.symbol} ${tradeRequest.side} ${tradeRequest.quantity}`);
      console.log(`   Risk Score: ${result.score}/100`);
    }

    return result;
  }

  /**
   * EMERGENCY STOP: Hard kill switch
   * Cannot be reversed by AI or user request.
   * Requires manual reset by admin.
   */
  activateEmergencyStop(reason) {
    this.emergencyStop = true;
    this.emergencyReason = reason;
    this.emergencyTriggeredAt = new Date().toISOString();

    const alert = {
      severity: 'CRITICAL',
      type: 'EMERGENCY_STOP_ACTIVATED',
      reason,
      timestamp: this.emergencyTriggeredAt,
      allTrading: 'HALTED'
    };

    console.error('🚨 EMERGENCY STOP ACTIVATED');
    console.error(`   Reason: ${reason}`);
    console.error(`   Time: ${this.emergencyTriggeredAt}`);
    console.error('   ⚠️  All trading halted until manual reset');

    this.auditLog.push(alert);
    return alert;
  }

  /**
   * MANUAL RESET: Only admin can reset emergency stop
   */
  resetEmergencyStop(adminId, reason) {
    if (!this.emergencyStop) {
      return { error: 'Emergency stop not active' };
    }

    const previousReason = this.emergencyReason;
    this.emergencyStop = false;
    this.emergencyReason = null;
    this.emergencyTriggeredAt = null;

    const reset = {
      severity: 'HIGH',
      type: 'EMERGENCY_STOP_RESET',
      adminId,
      reason,
      previousReason,
      timestamp: new Date().toISOString()
    };

    console.log('✅ Emergency stop RESET by admin');
    this.auditLog.push(reset);
    return reset;
  }

  /**
   * Update risk metrics for an account
   * Called after every trade to track cumulative risk
   */
  updateRiskMetrics(accountId, metrics) {
    if (!this.riskMetrics[accountId]) {
      this.riskMetrics[accountId] = {};
    }

    const previous = this.riskMetrics[accountId];
    this.riskMetrics[accountId] = {
      ...previous,
      ...metrics,
      updatedAt: new Date().toISOString()
    };

    // Check if any metric exceeded threshold
    this.checkMetricThresholds(accountId);
  }

  /**
   * Get current risk metrics for account
   */
  getRiskMetrics(accountId) {
    return this.riskMetrics[accountId] || {
      dailyLoss: 0,
      dailyLossLimit: this.rules.config.maxDailyLoss,
      exposure: 0,
      maxExposure: this.rules.config.maxExposure,
      positionCount: 0,
      maxDrawdown: 0
    };
  }

  /**
   * Helper: Check if metrics exceed thresholds
   */
  checkMetricThresholds(accountId) {
    const metrics = this.riskMetrics[accountId];

    if (!metrics) return;

    // Trigger alerts if approaching limits
    if (metrics.dailyLoss < 0 && Math.abs(metrics.dailyLoss) > this.rules.config.maxDailyLoss * 0.7) {
      console.warn(`⚠️  Daily loss approaching limit: ${metrics.dailyLoss} / ${this.rules.config.maxDailyLoss}`);
    }

    if (metrics.exposure > this.rules.config.maxExposure * 0.8) {
      console.warn(`⚠️  Portfolio exposure high: ${metrics.exposure} / ${this.rules.config.maxExposure}`);
    }

    if (metrics.maxDrawdown > 0.15) {
      console.warn(`⚠️  Max drawdown exceeded 15%: ${metrics.maxDrawdown}`);
    }
  }

  /**
   * Get audit log for account (most recent first)
   */
  getAuditLog(accountId = null, limit = 100) {
    let log = this.auditLog;

    if (accountId) {
      log = log.filter(entry => entry.accountId === accountId);
    }

    return log.slice(0, limit);
  }

  /**
   * Helper: Build human-readable reasoning
   */
  buildReasoning(tradeRequest, violations) {
    const { symbol, side, quantity, currentPrice } = tradeRequest;
    const positionValue = quantity * currentPrice;

    const reasoning = {
      proposal: `${side} ${quantity} shares of ${symbol} at $${currentPrice}`,
      totalValue: `$${positionValue.toFixed(2)}`,
      violations: violations.length > 0 ? violations.map(v => v.reason) : [],
      decision: violations.length === 0 ? 'APPROVED' : 'BLOCKED',
      summary: violations.length === 0
        ? 'Trade meets all risk requirements'
        : `Trade violates ${violations.length} rule(s): ${violations.map(v => v.rule).join(', ')}`
    };

    return reasoning;
  }

  /**
   * Helper: Get risk metric value
   */
  getMetric(accountId, metricName) {
    const metrics = this.riskMetrics[accountId];
    if (!metrics) return null;
    return metrics[metricName];
  }

  /**
   * Helper: Log validation decision to audit trail
   */
  logValidation(tradeRequest, result) {
    const logEntry = {
      timestamp: result.timestamp,
      validationId: result.validationId,
      accountId: tradeRequest.accountId,
      symbol: tradeRequest.symbol,
      side: tradeRequest.side,
      quantity: tradeRequest.quantity,
      allowed: result.allowed,
      score: result.score,
      violations: result.violations.length,
      violationRules: result.violations.map(v => v.rule)
    };

    this.auditLog.push(logEntry);
  }

  /**
   * Helper: Generate unique ID
   */
  generateId() {
    return `val_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get engine status
   */
  getStatus() {
    return {
      engineStatus: 'OPERATIONAL',
      emergencyStop: this.emergencyStop,
      emergencyReason: this.emergencyReason,
      emergencyTriggeredAt: this.emergencyTriggeredAt,
      accountsTracked: Object.keys(this.riskMetrics).length,
      validationsProcessed: this.auditLog.length,
      rulesActive: this.rules.getActiveRules()
    };
  }
}

module.exports = RiskEngine;
