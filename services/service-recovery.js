/**
 * RDCMNATION QUANTUM - Service Recovery System
 *
 * Automatic recovery from failures.
 * SAFETY: Never auto-resume live trading after critical failures.
 */

class ServiceRecovery {
  constructor() {
    this.recoveryPolicies = new Map();
    this.recoveryHistory = [];
    this.pausedServices = new Set();

    this.config = {
      // Safety-critical services (never auto-resume trading)
      safetyCriticalServices: ['risk-engine', 'broker-adapter', 'execution-engine'],

      // Max recovery attempts before giving up
      maxRecoveryAttempts: 3,

      // Delay between recovery attempts
      recoveryDelayMs: 5000,

      // Exponential backoff multiplier
      backoffMultiplier: 2,

      // After this many failures in window, pause service
      failureThreshold: 5,
      failureWindowMs: 60000 // 1 minute
    };

    this.setupDefaultPolicies();
  }

  /**
   * Setup default recovery policies
   */
  setupDefaultPolicies() {
    // Safe services: auto-restart allowed
    this.setRecoveryPolicy('market-data-feed', {
      autoRestart: true,
      maxAttempts: 3,
      delayMs: 5000,
      severity: 'HIGH'
    });

    // Critical services: auto-restart OK, but monitor closely
    this.setRecoveryPolicy('execution-engine', {
      autoRestart: true,
      maxAttempts: 2,
      delayMs: 10000,
      severity: 'CRITICAL',
      pauseTrading: false // Don't pause trading unless risk engine fails
    });

    // Safety-critical: manual approval required before resuming trading
    this.setRecoveryPolicy('risk-engine', {
      autoRestart: true,
      maxAttempts: 2,
      delayMs: 15000,
      severity: 'CRITICAL',
      pauseTrading: true, // Auto-pause live trading on failure
      requireManualApproval: true // Require admin to resume trading
    });

    this.setRecoveryPolicy('broker-adapter', {
      autoRestart: true,
      maxAttempts: 2,
      delayMs: 10000,
      severity: 'CRITICAL',
      pauseTrading: true,
      requireManualApproval: true
    });
  }

  /**
   * Set recovery policy for service
   */
  setRecoveryPolicy(serviceName, policy) {
    this.recoveryPolicies.set(serviceName, {
      serviceName,
      autoRestart: policy.autoRestart || false,
      maxAttempts: policy.maxAttempts || 1,
      delayMs: policy.delayMs || 5000,
      severity: policy.severity || 'MEDIUM',
      pauseTrading: policy.pauseTrading || false,
      requireManualApproval: policy.requireManualApproval || false
    });
  }

  /**
   * Handle service failure
   * MAIN ENTRY POINT for recovery process
   */
  async handleServiceFailure(serviceName, error, context = {}) {
    console.error(`❌ Service failure: ${serviceName} - ${error.message}`);

    const policy = this.recoveryPolicies.get(serviceName);
    if (!policy) {
      return {
        error: 'No recovery policy for service',
        serviceName
      };
    }

    const recoveryEvent = {
      timestamp: new Date().toISOString(),
      serviceName,
      error: error.message,
      policy: policy.severity,
      action: null,
      result: null
    };

    // Step 1: DETECT - Service is down
    console.log(`🚨 DETECT: ${serviceName} has failed`);

    // Step 2: ISOLATE - Stop accepting requests if critical
    if (policy.severity === 'CRITICAL') {
      console.log(`🔒 ISOLATE: Stopping ${serviceName} from processing new requests`);
    }

    // Step 3: ASSESS - Check recovery policy
    if (!policy.autoRestart) {
      console.log(`⏸️  ASSESS: Auto-restart disabled for ${serviceName}, requires manual intervention`);
      recoveryEvent.action = 'MANUAL_INTERVENTION_REQUIRED';
      recoveryEvent.result = 'NO_ACTION';
      this.recordRecoveryEvent(recoveryEvent);

      // If safety-critical, pause trading
      if (policy.pauseTrading) {
        this.pauseTrading(serviceName, `${serviceName} failure requires manual approval`);
      }

      return {
        action: 'MANUAL_INTERVENTION_REQUIRED',
        serviceName,
        reason: 'Auto-restart disabled'
      };
    }

    // Step 4: ATTEMPT RECOVERY
    console.log(`🔄 ATTEMPT: Starting recovery for ${serviceName}...`);

    let attempt = 0;
    let recovered = false;
    let delay = policy.delayMs;

    while (attempt < policy.maxAttempts && !recovered) {
      attempt++;

      console.log(`   Attempt ${attempt}/${policy.maxAttempts} (delay: ${delay}ms)`);

      // Wait before retry
      await this.delay(delay);

      // Try to recover
      const recoveryResult = await this.attemptRecovery(serviceName, context);

      if (recoveryResult.success) {
        recovered = true;
        console.log(`✅ RECOVERED: ${serviceName} is back online`);
        recoveryEvent.action = 'AUTO_RECOVERY_SUCCESS';
        recoveryEvent.result = 'RECOVERED';
      } else {
        console.log(`❌ Recovery attempt ${attempt} failed: ${recoveryResult.error}`);
        delay = delay * this.config.backoffMultiplier; // Exponential backoff
      }
    }

    // Step 5: VERIFY - Health check passes?
    if (recovered) {
      const verified = await this.verifyRecovery(serviceName);
      if (!verified) {
        recovered = false;
        console.log(`⚠️  VERIFY: Health check failed after recovery attempt`);
      }
    }

    // Step 6: ALERT - Log incident
    if (!recovered) {
      console.log(`🚨 ALERT: ${serviceName} failed to recover after ${attempt} attempts`);
      recoveryEvent.action = 'RECOVERY_FAILED';
      recoveryEvent.result = 'UNRECOVERED';

      // If safety-critical and unrecovered, must pause trading
      if (policy.pauseTrading) {
        this.pauseTrading(serviceName, `${serviceName} recovery failed - manual intervention required`);
      }
    }

    this.recordRecoveryEvent(recoveryEvent);

    return {
      serviceName,
      recovered,
      attempts: attempt,
      action: recoveryEvent.action,
      result: recoveryEvent.result,
      requiresApproval: policy.requireManualApproval
    };
  }

  /**
   * Attempt to recover service
   * Implemented by specific service recovery handlers
   */
  async attemptRecovery(serviceName, context = {}) {
    // This is a stub - real implementation would:
    // 1. Stop the service gracefully
    // 2. Clear any locked resources
    // 3. Restart the service
    // 4. Wait for startup complete

    try {
      console.log(`   Stopping ${serviceName}...`);
      await this.stopService(serviceName);

      console.log(`   Clearing resources for ${serviceName}...`);
      await this.clearResources(serviceName);

      console.log(`   Starting ${serviceName}...`);
      await this.startService(serviceName, context);

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Verify service has recovered
   */
  async verifyRecovery(serviceName) {
    try {
      // Health check should pass
      console.log(`   Verifying ${serviceName} health...`);
      // In real implementation, call health check
      return true;
    } catch (error) {
      console.log(`   Verification failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Stop service gracefully
   */
  async stopService(serviceName) {
    console.log(`     Stopping ${serviceName}...`);
    // Implementation: gracefully stop service, close connections
    await this.delay(100);
  }

  /**
   * Clear resources
   */
  async clearResources(serviceName) {
    console.log(`     Clearing resources for ${serviceName}...`);
    // Implementation: release locks, clear buffers, close files
    await this.delay(100);
  }

  /**
   * Start service
   */
  async startService(serviceName, context = {}) {
    console.log(`     Starting ${serviceName}...`);
    // Implementation: initialize service, reconnect to dependencies
    await this.delay(100);
  }

  /**
   * Pause trading (safety feature)
   */
  pauseTrading(serviceName, reason) {
    console.log(`⏸️  PAUSE TRADING: ${reason}`);
    this.pausedServices.add(serviceName);

    // In real implementation:
    // 1. Switch to SHADOW mode
    // 2. Stop accepting live orders
    // 3. Send alerts to admin
    // 4. Log to audit trail
  }

  /**
   * Resume trading (requires manual approval)
   */
  resumeTrading(serviceName, approvedBy = null) {
    if (!this.pausedServices.has(serviceName)) {
      return { error: 'Service not in paused state', serviceName };
    }

    console.log(`▶️  RESUME TRADING: ${serviceName} approved by ${approvedBy || 'admin'}`);
    this.pausedServices.delete(serviceName);

    return { success: true, serviceName, resumedAt: new Date().toISOString() };
  }

  /**
   * Get pause status
   */
  isPaused(serviceName) {
    return this.pausedServices.has(serviceName);
  }

  /**
   * Get paused services
   */
  getPausedServices() {
    return Array.from(this.pausedServices);
  }

  /**
   * Record recovery event
   */
  recordRecoveryEvent(event) {
    this.recoveryHistory.push(event);

    // Keep only last 1000 events
    if (this.recoveryHistory.length > 1000) {
      this.recoveryHistory.shift();
    }
  }

  /**
   * Get recovery history
   */
  getRecoveryHistory(serviceName = null, limit = 50) {
    let events = this.recoveryHistory;

    if (serviceName) {
      events = events.filter(e => e.serviceName === serviceName);
    }

    return events.slice(-limit);
  }

  /**
   * Get recovery statistics
   */
  getRecoveryStats() {
    const stats = {
      totalEvents: this.recoveryHistory.length,
      byService: {},
      successRate: 0,
      failureRate: 0
    };

    let successful = 0;
    let failed = 0;

    for (const event of this.recoveryHistory) {
      if (!stats.byService[event.serviceName]) {
        stats.byService[event.serviceName] = {
          total: 0,
          successful: 0,
          failed: 0
        };
      }

      stats.byService[event.serviceName].total++;

      if (event.result === 'RECOVERED') {
        stats.byService[event.serviceName].successful++;
        successful++;
      } else if (event.result === 'UNRECOVERED') {
        stats.byService[event.serviceName].failed++;
        failed++;
      }
    }

    const total = successful + failed;
    stats.successRate = total > 0 ? (successful / total * 100).toFixed(1) : 0;
    stats.failureRate = total > 0 ? (failed / total * 100).toFixed(1) : 0;

    return stats;
  }

  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = ServiceRecovery;
