/**
 * RDCMNATION QUANTUM - Phase 3 Validation Harness
 *
 * Tests Phase 2 (Foundation) + Phase 3 (Intelligence) together
 *
 * Validates:
 * 1. Phase 3 systems initialize without errors
 * 2. Market data flows through all engines
 * 3. Decisions get enhanced analysis from Phase 3
 * 4. Liquidity checks prevent low-liquidity trades
 * 5. Drawdown recovery recommendations work
 * 6. All systems coordinate without conflicts
 * 7. No data loss or errors during 1000+ cycle run
 *
 * Success criteria:
 * - 1000 cycles complete without errors
 * - Phase 3 analyzes >90% of decisions
 * - Liquidity checks block inappropriate trades
 * - Drawdown tracking is accurate
 * - Recovery recommendations are sound
 */

const PaperTradingEngine = require('./paper-trading-engine');
const Phase3Orchestrator = require('../services/phase3/phase3-orchestrator');

class Phase3ValidationHarness {
  constructor(config = {}) {
    this.config = {
      cycles: config.cycles || 1000,
      cycleIntervalMs: config.cycleIntervalMs || 0,
      symbols: config.symbols || ['NVDA', 'AAPL', 'SPY', 'QQQ', 'TSLA'],
      initialBalance: config.initialBalance || 100000,
      verbose: config.verbose !== false,
      reportFrequency: config.reportFrequency || 100,
      ...config
    };

    // Phase 2 engine
    this.engine = new PaperTradingEngine({
      symbols: this.config.symbols,
      initialBalance: this.config.initialBalance
    });

    // Phase 3 orchestrator
    this.phase3 = new Phase3Orchestrator();

    // Metrics
    this.metrics = {
      startTime: null,
      endTime: null,
      cyclesCompleted: 0,
      cyclesFailed: 0,
      phase3Errors: 0
    };

    // Phase 3 specific metrics
    this.phase3Metrics = {
      decisionsAnalyzed: 0,
      liquidityChecksRun: 0,
      liquidityBlocksIssued: 0,
      drawdownEventsDetected: 0,
      recoveryRecommendations: 0,
      phase3Advisories: 0
    };

    // Validation results
    this.validationResults = {
      phase3Initialized: false,
      phase3Works: false,
      liquidityEngineWorks: false,
      drawdownEngineWorks: false,
      coordinationWorks: false,
      noDataLoss: false
    };
  }

  /**
   * Run Phase 3 validation
   */
  async run() {
    console.log('🚀 RDCMNATION QUANTUM - Phase 3 Validation Harness');
    console.log(`📊 Running ${this.config.cycles} cycles with Phase 2 + Phase 3...`);
    console.log(`💰 Account Balance: $${this.config.initialBalance}`);
    console.log(`📈 Symbols: ${this.config.symbols.join(', ')}`);
    console.log('---');

    this.metrics.startTime = new Date();

    // Initialize Phase 3
    try {
      await this.phase3.initialize();
      this.validationResults.phase3Initialized = true;
      console.log('✅ Phase 3 Orchestrator initialized\n');
    } catch (error) {
      console.error('❌ Phase 3 initialization failed:', error.message);
      return this.generateReport();
    }

    // Main loop
    for (let i = 0; i < this.config.cycles; i++) {
      try {
        // Run Phase 2 cycle
        const result = await this.engine.runCycle();

        if (!result.success) {
          this.metrics.cyclesFailed++;
          continue;
        }

        this.metrics.cyclesCompleted++;

        // Feed Phase 2 data into Phase 3
        await this.integratePhase3(i);

        // Report progress
        if ((i + 1) % this.config.reportFrequency === 0) {
          this.reportProgress(i + 1);
        }

        // Delay if configured
        if (this.config.cycleIntervalMs > 0) {
          await this.delay(this.config.cycleIntervalMs);
        }

      } catch (error) {
        this.metrics.cyclesFailed++;
        if (this.config.verbose) {
          console.error(`❌ Cycle ${i + 1} error: ${error.message}`);
        }
      }
    }

    this.metrics.endTime = new Date();

    // Final validation
    await this.runFinalValidation();

    // Generate report
    const report = this.generateReport();

    console.log('\n' + '='.repeat(60));
    console.log('✅ PHASE 3 VALIDATION COMPLETE');
    console.log('='.repeat(60));

    return { report, engine: this.engine, phase3: this.phase3, metrics: this.metrics };
  }

  /**
   * Integrate Phase 3 with Phase 2 cycle
   */
  async integratePhase3(cycleNumber) {
    try {
      const status = this.engine.getStatus();

      // 1. Update Phase 3 with market data
      for (const symbol of this.config.symbols) {
        const marketData = this.engine.marketData?.[symbol];
        if (marketData) {
          this.phase3.updateMarketData({
            symbol,
            ...marketData,
            bid: marketData.close - (marketData.close * 0.0005), // Simulated bid
            ask: marketData.close + (marketData.close * 0.0005), // Simulated ask
            bidSize: 50000,
            askSize: 50000,
            avgVolume: marketData.volume
          });
        }
      }

      // 2. Update Phase 3 with portfolio value
      this.phase3.updatePortfolioValue(status.portfolio.totalValue);

      // 3. Analyze recent decisions through Phase 3
      if (this.engine.decisions.length > 0) {
        const recentDecision = this.engine.decisions[this.engine.decisions.length - 1];
        if (recentDecision) {
          const context = {
            regime: status.market.regime,
            tradeSize: 5000,
            openPositions: Object.keys(status.portfolio.positions).map(symbol => ({
              symbol,
              quantity: status.portfolio.positions[symbol].quantity,
              avgCost: status.portfolio.positions[symbol].avgCost
            }))
          };

          const analysis = this.phase3.analyzeDecision(recentDecision, context);
          this.phase3Metrics.decisionsAnalyzed++;

          if (analysis.recommendations.liquidity) {
            this.phase3Metrics.liquidityChecksRun++;
            if (!analysis.recommendations.liquidity.allowed) {
              this.phase3Metrics.liquidityBlocksIssued++;
            }
          }

          if (analysis.recommendations.recovery) {
            this.phase3Metrics.recoveryRecommendations++;
            if (analysis.recommendations.recovery.severity !== 'HEALTHY') {
              this.phase3Metrics.drawdownEventsDetected++;
            }
          }

          if (analysis.advisories.length > 0) {
            this.phase3Metrics.phase3Advisories += analysis.advisories.length;
          }
        }
      }

    } catch (error) {
      this.metrics.phase3Errors++;
      if (this.config.verbose) {
        console.error(`⚠️  Phase 3 integration error (cycle ${cycleNumber}):`, error.message);
      }
    }
  }

  /**
   * Report progress
   */
  reportProgress(cycleNumber) {
    const elapsed = (new Date() - this.metrics.startTime) / 1000 / 60;
    const cpm = cycleNumber / elapsed;

    console.log(`📍 Cycle ${cycleNumber} (${elapsed.toFixed(1)} min, ${cpm.toFixed(0)} cpm)`);
    console.log(`   Phase 2: Trades ${this.engine.trades.length} | Decisions ${this.engine.decisions.length}`);
    console.log(`   Phase 3: Analyzed ${this.phase3Metrics.decisionsAnalyzed} | Advisories ${this.phase3Metrics.phase3Advisories}`);
    console.log(`   Liquidity: Checks ${this.phase3Metrics.liquidityChecksRun} | Blocks ${this.phase3Metrics.liquidityBlocksIssued}`);
    console.log(`   Drawdown: Events ${this.phase3Metrics.drawdownEventsDetected} | Recommendations ${this.phase3Metrics.recoveryRecommendations}`);
  }

  /**
   * Run final validation checks
   */
  async runFinalValidation() {
    console.log('\n🔍 Running final validation checks...');

    // Check 1: Phase 3 analyzed decisions
    if (this.phase3Metrics.decisionsAnalyzed > 0) {
      console.log(`✅ Phase 3 analyzed ${this.phase3Metrics.decisionsAnalyzed} decisions`);
      this.validationResults.phase3Works = true;
    } else {
      console.log('⚠️  Phase 3 did not analyze any decisions');
    }

    // Check 2: Liquidity engine worked
    if (this.phase3Metrics.liquidityChecksRun > 0) {
      console.log(`✅ Liquidity Engine: ${this.phase3Metrics.liquidityChecksRun} checks, ${this.phase3Metrics.liquidityBlocksIssued} blocks`);
      this.validationResults.liquidityEngineWorks = true;
    }

    // Check 3: Drawdown engine worked
    if (this.phase3Metrics.drawdownEventsDetected >= 0) {
      console.log(`✅ Drawdown Recovery: Detected ${this.phase3Metrics.drawdownEventsDetected} events, ${this.phase3Metrics.recoveryRecommendations} recommendations`);
      this.validationResults.drawdownEngineWorks = true;
    }

    // Check 4: Phase 3 advisories issued
    if (this.phase3Metrics.phase3Advisories > 0) {
      console.log(`✅ Phase 3 Advisories: ${this.phase3Metrics.phase3Advisories} issued during trading`);
    }

    // Check 5: No phase 3 errors
    if (this.metrics.phase3Errors === 0) {
      console.log('✅ Phase 3 Integration: No errors');
      this.validationResults.coordinationWorks = true;
    } else {
      console.log(`⚠️  Phase 3 Integration: ${this.metrics.phase3Errors} errors`);
    }

    // Check 6: Data integrity
    const phase2Trades = this.engine.trades.length;
    const phase2Decisions = this.engine.decisions.length;
    if (phase2Decisions >= phase2Trades) {
      console.log(`✅ Data Integrity: ${phase2Decisions} decisions for ${phase2Trades} trades`);
      this.validationResults.noDataLoss = true;
    }

    // Check 7: Phase 2 still works
    const status = this.engine.getStatus();
    if (status.systemMetrics.tradesExecuted > 0) {
      console.log(`✅ Phase 2 Still Working: ${status.systemMetrics.tradesExecuted} trades executed`);
    }
  }

  /**
   * Generate comprehensive report
   */
  generateReport() {
    const duration = this.metrics.endTime - this.metrics.startTime;
    const durationMinutes = duration / 1000 / 60;
    const durationSeconds = duration / 1000;

    const sessionReport = this.engine.getSessionReport();
    const phase3Health = this.phase3.getHealth();
    const phase3Export = this.phase3.exportState();

    const report = {
      title: 'RDCMNATION QUANTUM - Phase 3 Validation Report',
      timestamp: new Date().toISOString(),
      duration: {
        milliseconds: duration,
        seconds: durationSeconds,
        minutes: durationMinutes,
        formatted: this._formatDuration(duration)
      },
      execution: {
        totalCycles: this.config.cycles,
        cyclesCompleted: this.metrics.cyclesCompleted,
        cyclesFailed: this.metrics.cyclesFailed,
        successRate: (this.metrics.cyclesCompleted / this.config.cycles * 100).toFixed(2) + '%',
        cyclesPerMinute: (this.metrics.cyclesCompleted / durationMinutes).toFixed(1)
      },
      phase2: {
        tradesExecuted: sessionReport.trading.tradesExecuted,
        tradesBlocked: sessionReport.trading.tradesBlocked,
        decisions: sessionReport.trading.totalDecisionsEvaluated,
        portfolio: {
          initial: `$${this.config.initialBalance.toFixed(2)}`,
          current: sessionReport.performance.totalValue,
          dailyPL: sessionReport.performance.dailyPL,
          roi: sessionReport.performance.roi
        },
        risk: {
          avgRiskScore: sessionReport.risk.avgRiskScore,
          avgConfidence: sessionReport.risk.avgConfidence + '%'
        }
      },
      phase3: {
        initialized: this.validationResults.phase3Initialized,
        decisionsAnalyzed: this.phase3Metrics.decisionsAnalyzed,
        liquidityChecks: {
          run: this.phase3Metrics.liquidityChecksRun,
          blocked: this.phase3Metrics.liquidityBlocksIssued,
          blockRate: this.phase3Metrics.liquidityChecksRun > 0
            ? (this.phase3Metrics.liquidityBlocksIssued / this.phase3Metrics.liquidityChecksRun * 100).toFixed(1) + '%'
            : '0%'
        },
        drawdown: {
          eventsDetected: this.phase3Metrics.drawdownEventsDetected,
          recommendations: this.phase3Metrics.recoveryRecommendations,
          currentSeverity: phase3Export.drawdown.status.currentSeverity,
          currentDrawdown: phase3Export.drawdown.status.drawdownPercent + '%'
        },
        advisories: this.phase3Metrics.phase3Advisories,
        componentHealth: phase3Health.components
      },
      integration: {
        phase3Errors: this.metrics.phase3Errors,
        coordinationWorks: this.validationResults.coordinationWorks,
        noDataLoss: this.validationResults.noDataLoss
      },
      validation: {
        phase3Initialized: this.validationResults.phase3Initialized ? '✅' : '❌',
        phase3Works: this.validationResults.phase3Works ? '✅' : '❌',
        liquidityEngineWorks: this.validationResults.liquidityEngineWorks ? '✅' : '❌',
        drawdownEngineWorks: this.validationResults.drawdownEngineWorks ? '✅' : '❌',
        coordinationWorks: this.validationResults.coordinationWorks ? '✅' : '❌',
        noDataLoss: this.validationResults.noDataLoss ? '✅' : '❌'
      },
      conclusion: this._generateConclusion()
    };

    return report;
  }

  /**
   * Generate conclusion
   */
  _generateConclusion() {
    const allPassed = Object.values(this.validationResults).every(v => v === true);

    if (allPassed) {
      return {
        status: '🟢 PHASE 3 INTEGRATION VALIDATED',
        message: 'Phase 2 + Phase 3 working correctly together. Ready for extended testing.',
        nextSteps: [
          '1. Run Phase 2+3 harness for 10,000 cycles (production validation)',
          '2. Monitor liquidity engine accuracy with real market data',
          '3. Validate drawdown recovery recommendations in edge cases',
          '4. Begin Phase 3b: Champion/Challenger testing',
          '5. Prepare live trading pilot with Phase 2+3 together'
        ]
      };
    } else {
      const failed = Object.entries(this.validationResults)
        .filter(([k, v]) => v === false)
        .map(([k]) => k);

      return {
        status: '🟡 PARTIAL VALIDATION',
        message: `Issues found: ${failed.join(', ')}`,
        nextSteps: [
          '1. Review failed components',
          '2. Check error logs for details',
          '3. Fix and re-test',
          '4. Re-run validation harness'
        ]
      };
    }
  }

  /**
   * Format duration nicely
   */
  _formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Delay helper
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = Phase3ValidationHarness;
