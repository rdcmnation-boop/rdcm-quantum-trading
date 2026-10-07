/**
 * RDCMNATION QUANTUM - Phase 3: Drawdown Recovery Engine
 *
 * PURPOSE: Manage risk during portfolio drawdowns
 *
 * Tracks:
 * - Current drawdown from peak
 * - Drawdown severity (SHALLOW, MODERATE, SEVERE, CRITICAL)
 * - Recovery trajectory
 * - Optimal recovery strategy per severity level
 *
 * Actions (advisory to Phase 2):
 * - SHALLOW (< 5%): Continue normal trading
 * - MODERATE (5-10%): Reduce position sizes by 20%
 * - SEVERE (10-20%): Reduce position sizes by 50%, use mean-reversion strategies
 * - CRITICAL (> 20%): Reduce to cash, wait for mean reversion setup
 *
 * GUARANTEES:
 * - Protects capital during downturns
 * - Suggests recovery strategies
 * - Never forces trades (advisory only to Phase 2)
 * - Tracks recovery speed for learning
 */

class DrawdownRecoveryEngine {
  constructor(config = {}) {
    this.config = {
      peakThreshold: config.peakThreshold || 100000, // Track peaks >= $100k
      recoveryTarget: config.recoveryTarget || 0.95, // 95% of peak = recovery
      checkFrequency: config.checkFrequency || 60000, // Check every 60 seconds
      ...config
    };

    // Drawdown tracking
    this.peak = {
      value: 0,
      timestamp: null,
      date: null
    };

    this.current = {
      value: 0,
      timestamp: null,
      drawdown: 0,
      drawdownPercent: 0,
      severity: 'HEALTHY',
      lastUpdate: null
    };

    // Recovery tracking
    this.recoveryData = {
      timeToPeak: null,
      daysInDrawdown: 0,
      recoveryEvents: [],
      averageRecoveryTime: 0
    };

    // Statistics
    this.stats = {
      peaksRecorded: 0,
      drawdownsDetected: 0,
      recoveriesCompleted: 0,
      currentStreak: 0 // Consecutive trading days
    };

    // History for analysis
    this.history = [];
    this.recoveryStrategies = this._initializeRecoveryStrategies();
  }

  /**
   * Update current portfolio value
   * Should be called every trading cycle
   *
   * @param {number} portfolioValue - Current total portfolio value
   * @param {Object} context - Trading context
   * @returns {Object} Drawdown status
   */
  updatePortfolioValue(portfolioValue, context = {}) {
    const now = Date.now();
    const timestamp = new Date();

    // Initialize peak if needed
    if (this.peak.value === 0 || portfolioValue > this.peak.value) {
      this.peak.value = portfolioValue;
      this.peak.timestamp = now;
      this.peak.date = timestamp;
      this.stats.peaksRecorded++;
    }

    // Calculate current drawdown
    const drawdown = this.peak.value - portfolioValue;
    const drawdownPercent = (drawdown / this.peak.value) * 100;

    // Determine severity
    const severity = this._calculateSeverity(drawdownPercent);

    // Update current status
    const previousSeverity = this.current.severity;
    this.current = {
      value: portfolioValue,
      timestamp: now,
      drawdown,
      drawdownPercent: drawdownPercent.toFixed(2),
      severity,
      peakValue: this.peak.value,
      daysFromPeak: Math.floor((now - this.peak.timestamp) / (1000 * 60 * 60 * 24)),
      lastUpdate: timestamp.toISOString()
    };

    // Check for drawdown event (no draw → draw)
    if (previousSeverity === 'HEALTHY' && severity !== 'HEALTHY') {
      this.stats.drawdownsDetected++;
      console.log(`⚠️  DRAWDOWN DETECTED: ${severity} (${drawdownPercent.toFixed(1)}%)`);
    }

    // Check for recovery (draw → no draw)
    if (previousSeverity !== 'HEALTHY' && severity === 'HEALTHY') {
      this.stats.recoveriesCompleted++;
      this.recoveryData.recoveryEvents.push({
        timestamp: now,
        previousSeverity,
        recoveryTime: now - this.peak.timestamp,
        daysToRecover: Math.floor((now - this.peak.timestamp) / (1000 * 60 * 60 * 24))
      });
      this._updateAverageRecoveryTime();
      console.log(`✅ RECOVERY COMPLETE: Back to peak after ${this.current.daysFromPeak} days`);
    }

    // Store history
    this.history.push({
      timestamp: now,
      value: portfolioValue,
      severity,
      drawdownPercent
    });

    if (this.history.length > 500) {
      this.history.shift();
    }

    return this.current;
  }

  /**
   * MAIN: Get recovery recommendation
   *
   * @returns {Object} Strategy recommendation
   */
  getRecoveryRecommendation() {
    const severity = this.current.severity;
    const strategy = this.recoveryStrategies[severity];

    return {
      severity,
      drawdownPercent: this.current.drawdownPercent,
      daysInDrawdown: this.current.daysFromPeak,
      recommendation: {
        positionScaleFactor: strategy.positionScaleFactor,
        preferredStrategies: strategy.preferredStrategies,
        riskLevel: strategy.riskLevel,
        actions: strategy.actions,
        reasoning: this._generateReasoning(severity)
      },
      urgency: this._calculateUrgency(severity, this.current.daysFromPeak),
      recoveryTarget: {
        targetValue: (this.peak.value * this.config.recoveryTarget).toFixed(2),
        currentValue: this.current.value.toFixed(2),
        gainNeeded: ((this.peak.value * this.config.recoveryTarget) - this.current.value).toFixed(2)
      }
    };
  }

  /**
   * Analyze recovery trajectory (is recovery on track?)
   *
   * @returns {Object} Recovery trajectory analysis
   */
  getRecoveryTrajectory() {
    if (this.current.severity === 'HEALTHY') {
      return {
        status: 'NOT_IN_DRAWDOWN',
        currentDrawdown: 0
      };
    }

    const recentHistory = this.history.slice(-20); // Last 20 data points
    if (recentHistory.length < 5) {
      return {
        status: 'INSUFFICIENT_DATA',
        dataPoints: recentHistory.length
      };
    }

    // Calculate trend
    const oldestValue = recentHistory[0].value;
    const newestValue = recentHistory[recentHistory.length - 1].value;
    const trend = newestValue > oldestValue ? 'IMPROVING' : 'DEGRADING';

    // Calculate velocity (how fast recovering)
    const timeDelta = recentHistory[recentHistory.length - 1].timestamp - recentHistory[0].timestamp;
    const valueDelta = newestValue - oldestValue;
    const recoveryVelocity = (valueDelta / timeDelta) * 1000 * 60 * 60; // $ per hour

    // Estimate days to full recovery
    const gainNeeded = this.peak.value - this.current.value;
    const daysToRecovery = gainNeeded > 0 ? Math.ceil(gainNeeded / (recoveryVelocity * 8)) : 0; // 8 trading hours

    return {
      status: 'ANALYZING',
      trend,
      recoveryVelocity: recoveryVelocity.toFixed(2) + ' $/hour',
      estimatedDaysToRecovery: Math.max(0, daysToRecovery),
      recentGain: valueDelta.toFixed(2),
      percentGained: ((valueDelta / oldestValue) * 100).toFixed(2) + '%'
    };
  }

  /**
   * Calculate severity based on drawdown percentage
   *
   * @private
   */
  _calculateSeverity(drawdownPercent) {
    if (drawdownPercent <= 0) return 'HEALTHY';
    if (drawdownPercent < 5) return 'SHALLOW';
    if (drawdownPercent < 10) return 'MODERATE';
    if (drawdownPercent < 20) return 'SEVERE';
    return 'CRITICAL';
  }

  /**
   * Initialize recovery strategies per severity
   *
   * @private
   */
  _initializeRecoveryStrategies() {
    return {
      HEALTHY: {
        positionScaleFactor: 1.0,
        preferredStrategies: ['MOMENTUM', 'MEAN_REVERSION', 'TREND_FOLLOWING'],
        riskLevel: 'NORMAL',
        actions: [
          'Continue normal trading',
          'Maintain position sizes',
          'Use all available strategies'
        ]
      },

      SHALLOW: {
        positionScaleFactor: 0.8,
        preferredStrategies: ['MEAN_REVERSION', 'VALUE'],
        riskLevel: 'LOW',
        actions: [
          'Reduce position sizes by 20%',
          'Focus on mean reversion setups',
          'Avoid aggressive momentum trades'
        ]
      },

      MODERATE: {
        positionScaleFactor: 0.5,
        preferredStrategies: ['MEAN_REVERSION', 'VALUE', 'DIVIDEND_YIELD'],
        riskLevel: 'VERY_LOW',
        actions: [
          'Reduce position sizes by 50%',
          'Shift to defensive strategies',
          'Increase position exits (take profits quickly)',
          'Reduce leverage'
        ]
      },

      SEVERE: {
        positionScaleFactor: 0.3,
        preferredStrategies: ['MEAN_REVERSION', 'DEFENSIVE', 'CASH'],
        riskLevel: 'MINIMAL',
        actions: [
          'Reduce position sizes by 70%',
          'Close losing positions',
          'Shift to cash/bonds',
          'Focus only on highest-conviction trades'
        ]
      },

      CRITICAL: {
        positionScaleFactor: 0.0,
        preferredStrategies: ['CASH', 'WAIT'],
        riskLevel: 'NONE',
        actions: [
          'Reduce to cash (stop trading)',
          'Preserve remaining capital',
          'Wait for mean reversion setup',
          'Protect against further losses'
        ]
      }
    };
  }

  /**
   * Generate reasoning for recommendation
   *
   * @private
   */
  _generateReasoning(severity) {
    const reasons = {
      HEALTHY: 'Portfolio at peak. Continue normal trading operations.',
      SHALLOW: 'Minor drawdown (<5%). Slight caution advised. Use defensive strategies.',
      MODERATE: 'Moderate drawdown (5-10%). Significant risk reduction needed.',
      SEVERE: 'Severe drawdown (10-20%). Shift to capital preservation mode.',
      CRITICAL: 'Critical drawdown (>20%). Stop trading, wait for recovery setup.'
    };

    return reasons[severity] || 'Unknown state';
  }

  /**
   * Calculate urgency (how soon should we act)
   *
   * @private
   */
  _calculateUrgency(severity, daysInDrawdown) {
    if (severity === 'HEALTHY') return 'NONE';
    if (severity === 'SHALLOW' && daysInDrawdown < 30) return 'LOW';
    if (severity === 'MODERATE' && daysInDrawdown < 14) return 'MEDIUM';
    if (severity === 'SEVERE') return 'HIGH';
    if (severity === 'CRITICAL') return 'CRITICAL';
    return 'MEDIUM';
  }

  /**
   * Update average recovery time
   *
   * @private
   */
  _updateAverageRecoveryTime() {
    if (this.recoveryData.recoveryEvents.length === 0) return;

    const totalTime = this.recoveryData.recoveryEvents.reduce((sum, e) => sum + e.recoveryTime, 0);
    this.recoveryData.averageRecoveryTime = totalTime / this.recoveryData.recoveryEvents.length;
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      currentDrawdownPercent: this.current.drawdownPercent,
      currentSeverity: this.current.severity,
      totalRecoveryEvents: this.recoveryData.recoveryEvents.length,
      averageRecoveryTimeMs: Math.round(this.recoveryData.averageRecoveryTime),
      averageRecoveryDays: Math.round(this.recoveryData.averageRecoveryTime / (1000 * 60 * 60 * 24))
    };
  }

  /**
   * Get engine status
   */
  getStatus() {
    return {
      engineStatus: 'OPERATIONAL',
      currentSeverity: this.current.severity,
      drawdownPercent: this.current.drawdownPercent,
      daysFromPeak: this.current.daysFromPeak,
      peakValue: this.peak.value,
      recoveryEventsRecorded: this.recoveryData.recoveryEvents.length
    };
  }

  /**
   * Reset peak (manual override, use carefully)
   */
  resetPeak(newPeakValue) {
    this.peak = {
      value: newPeakValue,
      timestamp: Date.now(),
      date: new Date()
    };
    this.stats.peaksRecorded++;
  }
}

module.exports = DrawdownRecoveryEngine;
