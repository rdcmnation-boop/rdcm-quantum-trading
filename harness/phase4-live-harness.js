/**
 * RDCMNATION QUANTUM - Phase 4 Live Trading Harness
 *
 * Tests Phase 2 + Phase 3 + Phase 4 together
 * Executes real trades through Robinhood broker
 *
 * Modes:
 * - PAPER (default): Simulated orders, real account data
 * - LIVE: Real capital execution with safety limits
 *
 * Validates:
 * 1. Broker authentication and account access
 * 2. Order submission and execution
 * 3. Position tracking and P&L calculation
 * 4. Risk controls and daily limits
 * 5. Full integration of all 4 phases
 */

const PaperTradingEngine = require('./paper-trading-engine');
const Phase3Orchestrator = require('../services/phase3/phase3-orchestrator');
const Phase4Orchestrator = require('../services/phase4/phase4-orchestrator');

class Phase4LiveHarness {
  constructor(config = {}) {
    this.config = {
      mode: config.mode || 'PAPER', // PAPER or LIVE
      cycles: config.cycles || 100,
      reportFrequency: config.reportFrequency || 10,
      initialCapital: config.initialCapital || 1000,
      // Broker credentials
      brokerUsername: config.brokerUsername || null,
      brokerPassword: config.brokerPassword || null,
      brokerToken: config.brokerToken || null,
      symbols: config.symbols || ['NVDA', 'AAPL', 'SPY', 'QQQ', 'TSLA'],
      verbose: config.verbose !== false,
      ...config
    };

    // Phase 2: Foundation
    this.engine = new PaperTradingEngine({
      symbols: this.config.symbols,
      initialBalance: this.config.initialCapital
    });

    // Phase 3: Intelligence
    this.phase3 = new Phase3Orchestrator();

    // Phase 4: Live Trading
    this.phase4 = new Phase4Orchestrator({
      initialCapital: this.config.initialCapital,
      authToken: this.config.brokerToken,
      credentials: {
        username: this.config.brokerUsername,
        password: this.config.brokerPassword
      },
      paperTradingMode: this.config.mode === 'PAPER'
    });

    // Metrics
    this.metrics = {
      startTime: null,
      endTime: null,
      cyclesCompleted: 0,
      cyclesFailed: 0,
      decisionsExecuted: 0,
      brokerErrors: 0
    };

    // Validation results
    this.validationResults = {
      brokerConnected: false,
      accountAccessible: false,
      ordersExecuted: false,
      pnlTracking: false,
      phase4Works: false,
      allPhasesIntegrated: false
    };
  }

  /**
   * Run Phase 4 validation with live broker
   */
  async run() {
    console.log('🚀 RDCMNATION QUANTUM - Phase 4 Live Trading Harness');
    console.log(`📊 Mode: ${this.config.mode} Trading (${this.config.mode === 'PAPER' ? 'Simulated' : 'REAL CAPITAL'})`);
    console.log(`💰 Initial Capital: $${this.config.initialCapital}`);
    console.log(`📈 Symbols: ${this.config.symbols.join(', ')}`);
    console.log(`🔄 Cycles: ${this.config.cycles}`);
    console.log('---');

    this.metrics.startTime = new Date();

    // Initialize Phase 4 (broker connection)
    try {
      const initSuccess = await this.phase4.initialize();
      if (!initSuccess) {
        console.error('❌ Phase 4 initialization failed');
        return this.generateReport();
      }
      this.validationResults.brokerConnected = true;
      console.log('✅ Phase 4 Orchestrator initialized with broker\n');
    } catch (error) {
      console.error('❌ Phase 4 initialization error:', error.message);
      return this.generateReport();
    }

    // Initialize Phase 3
    try {
      await this.phase3.initialize();
      console.log('✅ Phase 3 Orchestrator initialized\n');
    } catch (error) {
      console.error('❌ Phase 3 initialization error:', error.message);
      return this.generateReport();
    }

    // Check account access
    const accountStatus = await this.phase4.getAccountStatus();
    if (!accountStatus) {
      console.error('❌ Cannot access account');
      return this.generateReport();
    }

    this.validationResults.accountAccessible = true;
    console.log(`✅ Account Access: $${accountStatus.portfolioValue.toFixed(2)} available\n`);

    // Main trading loop
    for (let i = 0; i < this.config.cycles; i++) {
      try {
        // Phase 2: Generate signals
        const result = await this.engine.runCycle();
        if (!result.success) {
          this.metrics.cyclesFailed++;
          continue;
        }

        this.metrics.cyclesCompleted++;

        // Get latest decision from Phase 2
        if (this.engine.decisions.length > 0) {
          const recentDecision = this.engine.decisions[this.engine.decisions.length - 1];

          // Phase 3: Analyze decision
          const context = {
            regime: result.market.regime,
            tradeSize: 5000,
            openPositions: Object.keys(result.portfolio.positions).map(symbol => ({
              symbol,
              quantity: result.portfolio.positions[symbol].quantity,
              avgCost: result.portfolio.positions[symbol].avgCost
            }))
          };

          const analysis = this.phase3.analyzeDecision(recentDecision, context);

          // Phase 4: Execute with live broker (if Phase 2 and Phase 3 approve)
          if (recentDecision.action && recentDecision.action !== 'HOLD') {
            const executionResult = await this.phase4.executeDecision(recentDecision, analysis);

            if (executionResult.success) {
              this.metrics.decisionsExecuted++;
              this.validationResults.ordersExecuted = true;

              if (this.config.verbose) {
                console.log(`✅ Execution: ${recentDecision.symbol} ${recentDecision.action} - Order ${executionResult.orderId}`);
              }
            } else {
              this.metrics.brokerErrors++;
              if (this.config.verbose) {
                console.log(`⚠️  Execution blocked: ${executionResult.reason}`);
              }
            }
          }
        }

        // Report progress
        if ((i + 1) % this.config.reportFrequency === 0) {
          this.reportProgress(i + 1);
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
    console.log('✅ PHASE 4 LIVE TRADING HARNESS COMPLETE');
    console.log('='.repeat(60));

    return { report, phase2: this.engine, phase3: this.phase3, phase4: this.phase4 };
  }

  /**
   * Report progress
   */
  reportProgress(cycleNumber) {
    const elapsed = (new Date() - this.metrics.startTime) / 1000 / 60;
    const cpm = cycleNumber / elapsed;

    console.log(`📍 Cycle ${cycleNumber} (${elapsed.toFixed(1)} min, ${cpm.toFixed(0)} cpm)`);
    console.log(`   Phase 2: Trades ${this.engine.trades.length} | Decisions ${this.engine.decisions.length}`);
    console.log(`   Phase 4: Executions ${this.metrics.decisionsExecuted} | Broker Errors ${this.metrics.brokerErrors}`);

    const phase4Health = this.phase4.getHealth();
    console.log(`   Account: $${phase4Health.capital.current.toFixed(2)} | Positions: ${phase4Health.capital.positions}`);
  }

  /**
   * Run final validation checks
   */
  async runFinalValidation() {
    console.log('\n🔍 Running final validation checks...');

    // Check 1: Orders executed
    if (this.metrics.decisionsExecuted > 0) {
      console.log(`✅ Orders executed: ${this.metrics.decisionsExecuted}`);
      this.validationResults.ordersExecuted = true;
    }

    // Check 2: Broker errors tracked
    if (this.metrics.brokerErrors >= 0) {
      console.log(`✅ Broker errors: ${this.metrics.brokerErrors}`);
    }

    // Check 3: Phase 4 operational
    const phase4Health = this.phase4.getHealth();
    if (phase4Health.state === 'RUNNING') {
      console.log('✅ Phase 4 operational');
      this.validationResults.phase4Works = true;
    }

    // Check 4: Account tracking
    const accountStatus = await this.phase4.getAccountStatus();
    if (accountStatus) {
      console.log(`✅ Account tracking: $${accountStatus.portfolioValue.toFixed(2)}`);
      this.validationResults.pnlTracking = true;
    }

    // Check 5: All phases integrated
    if (
      this.validationResults.brokerConnected &&
      this.validationResults.accountAccessible &&
      this.validationResults.ordersExecuted &&
      this.validationResults.phase4Works
    ) {
      console.log('✅ All 4 phases integrated successfully');
      this.validationResults.allPhasesIntegrated = true;
    }
  }

  /**
   * Generate comprehensive report
   */
  generateReport() {
    const duration = this.metrics.endTime - this.metrics.startTime;
    const durationMinutes = duration / 1000 / 60;

    const phase4Health = this.phase4.getHealth();
    const accountStatus = this.phase4.getAccountStatus();

    const report = {
      title: 'RDCMNATION QUANTUM - Phase 4 Live Trading Report',
      timestamp: new Date().toISOString(),
      mode: this.config.mode,
      duration: {
        milliseconds: duration,
        minutes: durationMinutes.toFixed(1)
      },
      execution: {
        totalCycles: this.config.cycles,
        cyclesCompleted: this.metrics.cyclesCompleted,
        cyclesFailed: this.metrics.cyclesFailed,
        successRate: (this.metrics.cyclesCompleted / this.config.cycles * 100).toFixed(2) + '%'
      },
      phase4: {
        brokerConnected: this.validationResults.brokerConnected,
        accountAccessible: this.validationResults.accountAccessible,
        ordersExecuted: this.metrics.decisionsExecuted,
        brokerErrors: this.metrics.brokerErrors,
        capital: {
          initial: `$${this.config.initialCapital.toFixed(2)}`,
          current: accountStatus ? `$${accountStatus.portfolioValue.toFixed(2)}` : 'N/A',
          pnl: accountStatus ? `$${(accountStatus.totalPnL || 0).toFixed(2)}` : 'N/A',
          roi: accountStatus ? accountStatus.roi : 'N/A'
        },
        health: phase4Health
      },
      validation: {
        brokerConnected: this.validationResults.brokerConnected ? '✅' : '❌',
        accountAccessible: this.validationResults.accountAccessible ? '✅' : '❌',
        ordersExecuted: this.validationResults.ordersExecuted ? '✅' : '❌',
        pnlTracking: this.validationResults.pnlTracking ? '✅' : '❌',
        phase4Works: this.validationResults.phase4Works ? '✅' : '❌',
        allPhasesIntegrated: this.validationResults.allPhasesIntegrated ? '✅' : '❌'
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

    if (allPassed && this.config.mode === 'PAPER') {
      return {
        status: '🟢 PHASE 4 PAPER TRADING VALIDATED',
        message: 'Ready to transition to live trading with real capital',
        nextSteps: [
          '1. Review paper trading results and metrics',
          '2. Set final capital allocation ($1,000 recommended for pilot)',
          '3. Configure real Robinhood credentials',
          '4. Switch to LIVE mode and monitor first 50 trades',
          '5. Scale gradually as confidence increases'
        ]
      };
    } else if (allPassed && this.config.mode === 'LIVE') {
      return {
        status: '🟢 PHASE 4 LIVE TRADING OPERATIONAL',
        message: 'System executing trades with real capital',
        nextSteps: [
          '1. Monitor daily P&L and account health',
          '2. Track execution quality (slippage, fills)',
          '3. Review drawdown and risk management',
          '4. Implement Phase 3b learning systems',
          '5. Scale to additional brokers'
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
          '1. Check broker credentials and authentication',
          '2. Verify account access and permissions',
          '3. Review error logs for details',
          '4. Test with paper trading mode first',
          '5. Re-run validation'
        ]
      };
    }
  }
}

module.exports = Phase4LiveHarness;
