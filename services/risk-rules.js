/**
 * RDCMNATION QUANTUM - Risk Rules Configuration
 *
 * Defines the actual limits for each risk rule.
 * These can vary by subscription tier and account type.
 */

class RiskRules {
  constructor(config = {}) {
    // Apply configuration with defaults
    this.config = this.mergeConfig(config);

    // Audit when rules are created/updated
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
    this.version = '1.0';
  }

  /**
   * Default rules (conservative, for all accounts)
   */
  getDefaultRules() {
    return {
      // RULE 1: Daily Loss Limit
      // Maximum loss allowed in a single day
      maxDailyLoss: -500, // Can lose up to $500/day
      dailyLossCheckTime: 'market-open', // Reset at market open

      // RULE 2: Max Position Size
      // Maximum size of any single position
      maxPositionPercent: 0.05, // 5% of account balance

      // RULE 3: Portfolio Exposure
      // Maximum total exposure across all positions
      maxExposure: 0.50, // 50% of buying power

      // RULE 4: Correlation Check
      // Maximum correlation with existing positions
      maxCorrelation: 0.85, // Don't add positions > 85% correlated

      // RULE 5: Duplicate Detection
      // Time window to detect duplicate orders
      duplicateTimeWindow: 60, // 60 second window

      // Additional safety rules
      minPositionSize: 1, // Minimum shares/units per order
      maxOrdersPerDay: 100, // Maximum orders per day
      maxDrawdown: 0.20, // Maximum cumulative drawdown (20%)


      // Trading hours (only allow trades during market hours)
      tradingHoursOnly: true,
      marketOpenTime: '09:30',
      marketCloseTime: '16:00',

      // Before/after hours
      allowPreMarket: false,
      allowAfterHours: false
    };
  }

  /**
   * Tier-based rule overrides
   * Different subscription tiers get different limits
   */
  getTierRules(tier = 'free') {
    const baseRules = this.getDefaultRules();

    const tierOverrides = {
      'free': {
        maxDailyLoss: -200,        // Tighter daily loss
        maxPositionPercent: 0.03,  // Smaller positions
        maxExposure: 0.30,         // Lower exposure
        maxOrdersPerDay: 10        // Limited orders
      },

      'basic': {
        maxDailyLoss: -500,
        maxPositionPercent: 0.05,
        maxExposure: 0.50,
        maxOrdersPerDay: 50
      },

      'pro': {
        maxDailyLoss: -1000,       // Looser limits
        maxPositionPercent: 0.10,  // Larger positions
        maxExposure: 0.70,         // Higher exposure
        maxOrdersPerDay: 200       // More orders
      },

      'enterprise': {
        maxDailyLoss: -5000,       // Very loose
        maxPositionPercent: 0.20,  // Large positions
        maxExposure: 0.90,         // High exposure
        maxOrdersPerDay: 1000      // Many orders
      }
    };

    return {
      ...baseRules,
      ...(tierOverrides[tier] || {})
    };
  }

  /**
   * Account-type specific overrides
   * Paper trading vs live trading
   */
  getAccountTypeRules(accountType = 'paper') {
    const baseRules = this.getDefaultRules();

    if (accountType === 'paper') {
      return {
        ...baseRules,
        // Paper trading can be more aggressive for testing
        maxDailyLoss: -10000,      // Large losses OK in paper
        maxPositionPercent: 0.50,  // Test large positions
        maxExposure: 1.00,         // Test leveraging
        tradingHoursOnly: false    // Test 24/7 in paper
      };
    }

    // Live trading is more conservative
    return baseRules;
  }

  /**
   * Merge provided config with defaults
   */
  mergeConfig(userConfig) {
    const defaults = this.getDefaultRules();

    return {
      ...defaults,
      ...userConfig
    };
  }

  /**
   * Get combined rules for specific account
   * Considers: tier + account type + custom overrides
   */
  getAccountRules(account = {}) {
    const { tier = 'free', type = 'paper', customRules = {} } = account;

    // Start with tier rules
    let rules = this.getTierRules(tier);

    // Apply account type overrides
    const typeRules = this.getAccountTypeRules(type);
    rules = { ...rules, ...typeRules };

    // Apply account-specific custom rules
    rules = { ...rules, ...customRules };

    return rules;
  }

  /**
   * Update a specific rule (requires reason and audit)
   */
  updateRule(ruleName, newValue, reason = '') {
    if (!this.config.hasOwnProperty(ruleName)) {
      return {
        error: `Rule "${ruleName}" not found`,
        availableRules: Object.keys(this.config)
      };
    }

    const oldValue = this.config[ruleName];
    this.config[ruleName] = newValue;
    this.updatedAt = new Date().toISOString();

    const update = {
      timestamp: this.updatedAt,
      rule: ruleName,
      oldValue,
      newValue,
      reason,
      severity: this.getRuleUpdateSeverity(ruleName, oldValue, newValue)
    };

    console.log(`🔧 Risk rule updated: ${ruleName}`);
    console.log(`   Old: ${oldValue} → New: ${newValue}`);
    if (reason) console.log(`   Reason: ${reason}`);

    return update;
  }

  /**
   * Determine severity of rule change
   */
  getRuleUpdateSeverity(ruleName, oldValue, newValue) {
    // Loosening limits on risky rules is high severity
    if (
      (ruleName === 'maxDailyLoss' && newValue > oldValue) ||
      (ruleName === 'maxExposure' && newValue > oldValue) ||
      (ruleName === 'maxPositionPercent' && newValue > oldValue)
    ) {
      return 'HIGH'; // Allowing more risk
    }

    // Tightening limits is medium severity
    if (
      (ruleName === 'maxDailyLoss' && newValue < oldValue) ||
      (ruleName === 'maxExposure' && newValue < oldValue)
    ) {
      return 'MEDIUM'; // Increasing safety
    }

    return 'LOW';
  }

  /**
   * Get active rules (non-null, non-default values)
   */
  getActiveRules() {
    const defaults = this.getDefaultRules();
    const active = [];

    for (const [key, value] of Object.entries(this.config)) {
      if (value !== defaults[key]) {
        active.push({
          rule: key,
          value: value,
          default: defaults[key],
          isCustom: true
        });
      }
    }

    return active;
  }

  /**
   * Export rules for audit/compliance
   */
  exportRules() {
    return {
      exportedAt: new Date().toISOString(),
      version: this.version,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      rules: this.config,
      activeCustomRules: this.getActiveRules()
    };
  }

  /**
   * Validate that rule values are sensible
   */
  validateRules() {
    const issues = [];

    // Daily loss should be negative
    if (this.config.maxDailyLoss > 0) {
      issues.push({
        severity: 'ERROR',
        rule: 'maxDailyLoss',
        issue: 'Daily loss limit should be negative',
        current: this.config.maxDailyLoss,
        suggestion: 'Set to negative value (e.g., -500)'
      });
    }

    // Position size should be between 0-1
    if (this.config.maxPositionPercent < 0 || this.config.maxPositionPercent > 1) {
      issues.push({
        severity: 'ERROR',
        rule: 'maxPositionPercent',
        issue: 'Position size should be 0-100%',
        current: this.config.maxPositionPercent,
        suggestion: 'Set to value between 0 and 1'
      });
    }

    // Exposure should be less than 1 for normal accounts
    if (this.config.maxExposure > 2) {
      issues.push({
        severity: 'WARNING',
        rule: 'maxExposure',
        issue: 'Very high exposure allowed',
        current: this.config.maxExposure,
        suggestion: 'For most accounts, keep below 1.0 (100%)'
      });
    }

    // Correlation should be 0-1
    if (this.config.maxCorrelation < 0 || this.config.maxCorrelation > 1) {
      issues.push({
        severity: 'ERROR',
        rule: 'maxCorrelation',
        issue: 'Correlation should be 0-1',
        current: this.config.maxCorrelation,
        suggestion: 'Set to value between 0 and 1'
      });
    }

    return {
      valid: issues.length === 0,
      issues,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Get rules documentation
   */
  getDocumentation() {
    return {
      'maxDailyLoss': {
        description: 'Maximum loss allowed in a single trading day (negative value)',
        example: -500,
        unit: 'dollars',
        typical: '-$200 to -$5000 depending on account size'
      },
      'maxPositionPercent': {
        description: 'Maximum size of any single position relative to account balance',
        example: 0.05,
        unit: 'percentage (0-1)',
        typical: '3-10% for most accounts'
      },
      'maxExposure': {
        description: 'Maximum total exposure across all positions',
        example: 0.50,
        unit: 'percentage (0-1)',
        typical: '30-70% for normal accounts'
      },
      'maxCorrelation': {
        description: 'Maximum correlation allowed between new and existing positions',
        example: 0.85,
        unit: 'correlation (0-1)',
        typical: '0.70-0.85'
      },
      'duplicateTimeWindow': {
        description: 'Time window to detect duplicate orders',
        example: 60,
        unit: 'seconds',
        typical: '30-120 seconds'
      }
    };
  }
}

module.exports = RiskRules;
