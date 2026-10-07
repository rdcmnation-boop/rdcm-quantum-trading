/**
 * RDCMNATION QUANTUM - Health Check System
 *
 * Continuous monitoring of all services.
 * Part of Priority 5: Automatic Recovery.
 */

class HealthCheckSystem {
  constructor() {
    this.services = new Map();
    this.healthHistory = [];
    this.config = {
      checkIntervalMs: 10000, // Check every 10 seconds
      timeoutMs: 5000, // 5 second timeout per check
      unhealthyThreshold: 2, // Mark unhealthy after 2 failures
      criticalServices: ['risk-engine', 'broker-adapter', 'execution-engine', 'data-feed']
    };
  }

  /**
   * Register a service for monitoring
   */
  registerService(serviceName, healthCheckFn) {
    this.services.set(serviceName, {
      name: serviceName,
      healthCheckFn,
      status: 'INITIALIZING',
      lastCheck: null,
      lastError: null,
      consecutiveFailures: 0,
      isCritical: this.config.criticalServices.includes(serviceName)
    });
  }

  /**
   * Perform health check on all services
   */
  async checkAllServices() {
    const results = {
      timestamp: new Date().toISOString(),
      overallStatus: 'HEALTHY',
      services: {},
      criticalIssues: []
    };

    for (const [serviceName, service] of this.services.entries()) {
      const checkResult = await this.checkService(serviceName, service);
      results.services[serviceName] = checkResult;

      // Determine overall status
      if (checkResult.status === 'UNHEALTHY') {
        results.overallStatus = 'DEGRADED';

        if (service.isCritical) {
          results.criticalIssues.push({
            service: serviceName,
            status: checkResult.status,
            error: checkResult.error,
            severity: 'CRITICAL'
          });
          results.overallStatus = 'CRITICAL';
        }
      }
    }

    // Store in history
    this.healthHistory.push(results);

    // Keep only last 100 checks
    if (this.healthHistory.length > 100) {
      this.healthHistory.shift();
    }

    return results;
  }

  /**
   * Check individual service
   */
  async checkService(serviceName, service) {
    try {
      console.log(`🔍 Health check: ${serviceName}...`);

      // Run health check with timeout
      const promise = service.healthCheckFn();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Health check timeout')), this.config.timeoutMs)
      );

      const result = await Promise.race([promise, timeoutPromise]);

      // Service is healthy
      service.status = 'HEALTHY';
      service.lastCheck = new Date().toISOString();
      service.lastError = null;
      service.consecutiveFailures = 0;

      console.log(`✅ ${serviceName} is healthy`);

      return {
        serviceName,
        status: 'HEALTHY',
        lastCheck: service.lastCheck,
        responseTime: result.responseTime || 'N/A'
      };

    } catch (error) {
      service.consecutiveFailures++;
      service.lastError = error.message;
      service.lastCheck = new Date().toISOString();

      // Determine status
      const status = service.consecutiveFailures >= this.config.unhealthyThreshold
        ? 'UNHEALTHY'
        : 'DEGRADED';

      service.status = status;

      console.warn(`⚠️ ${serviceName} health check failed: ${error.message}`);

      return {
        serviceName,
        status,
        error: error.message,
        consecutiveFailures: service.consecutiveFailures,
        lastCheck: service.lastCheck
      };
    }
  }

  /**
   * Get current system health
   */
  getSystemHealth() {
    const services = Array.from(this.services.values());

    const healthy = services.filter(s => s.status === 'HEALTHY').length;
    const degraded = services.filter(s => s.status === 'DEGRADED').length;
    const unhealthy = services.filter(s => s.status === 'UNHEALTHY').length;

    const criticalIssues = services
      .filter(s => s.isCritical && s.status !== 'HEALTHY')
      .map(s => ({
        service: s.name,
        status: s.status,
        error: s.lastError
      }));

    return {
      timestamp: new Date().toISOString(),
      overall: criticalIssues.length > 0 ? 'CRITICAL' : degraded > 0 ? 'DEGRADED' : 'HEALTHY',
      summary: {
        total: services.length,
        healthy,
        degraded,
        unhealthy
      },
      criticalIssues,
      services: Array.from(this.services.entries()).map(([name, svc]) => ({
        name,
        status: svc.status,
        isCritical: svc.isCritical,
        lastCheck: svc.lastCheck,
        consecutiveFailures: svc.consecutiveFailures
      }))
    };
  }

  /**
   * Get service status
   */
  getServiceStatus(serviceName) {
    const service = this.services.get(serviceName);
    if (!service) {
      return { error: 'Service not found' };
    }

    return {
      serviceName,
      status: service.status,
      lastCheck: service.lastCheck,
      lastError: service.lastError,
      consecutiveFailures: service.consecutiveFailures,
      isCritical: service.isCritical
    };
  }

  /**
   * Get health history
   */
  getHealthHistory(limit = 20) {
    return this.healthHistory.slice(-limit);
  }

  /**
   * Reset service health (after recovery)
   */
  resetServiceHealth(serviceName) {
    const service = this.services.get(serviceName);
    if (service) {
      service.consecutiveFailures = 0;
      service.lastError = null;
      service.status = 'INITIALIZING';
      console.log(`🔄 Reset health for ${serviceName}`);
    }
  }
}

module.exports = HealthCheckSystem;
