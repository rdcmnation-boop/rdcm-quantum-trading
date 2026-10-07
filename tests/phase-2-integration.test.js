/**
 * RDCMNATION QUANTUM - Phase 2 Integration Tests
 *
 * Validates: Risk Engine + Market Snapshots + Explainability + Execution Modes
 * All components working together in paper trading mode
 */

const RiskEngine = require('../services/risk-engine');
const RiskValidator = require('../services/risk-validator');
const RiskRules = require('../services/risk-rules');
const SnapshotService = require('../services/snapshot-service');
const MarketSnapshot = require('../models/snapshot');
const ExplainabilityEngine = require('../services/explainability-engine');
const { ExecutionRouter, ExecutionMode } = require('../execution/execution-modes');
const HealthCheckSystem = require('../services/health-check');
const ServiceRecovery = require('../services/service-recovery');

// ============================================================================
// PHASE 2 TEST SUITE
// ============================================================================

class Phase2TestSuite {
  constructor() {
    this.results = [];
    this.passed = 0;
    this.failed = 0;
  }

  // ========== HELPER METHODS ==========

  test(name, testFn) {
    try {
      testFn();
      this.passed++;
      console.log(`✅ ${name}`);
      this.results.push({ name, status: 'PASS' });
    } catch (error) {
      this.failed++;
      console.error(`❌ ${name}: ${error.message}`);
      this.results.push({ name, status: 'FAIL', error: error.message });
    }
  }

  assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
  }

  assertTrue(value, message) {
    if (!value) throw new Error(`${message}: expected true`);
  }

  assertFalse(value, message) {
    if (value) throw new Error(`${message}: expected false`);
  }

  assertExists(value, message) {
    if (!value) throw new Error(`${message}: value does not exist`);
  }

  // ========== RISK ENGINE TESTS ==========

  testRiskEngineBasics() {
    console.log('\n📋 RISK ENGINE TESTS\n');

    this.test('RiskEngine initializes with metrics', () => {
      const engine = new RiskEngine();
      this.assertExists(engine.getStatus(), 'Status should exist');
      const status = engine.getStatus();
      this.assertEqual(status.emergencyStop, false, 'Emergency stop should be off');
    });

    this.test('RiskEngine tracks daily P&L', () => {
      const engine = new RiskEngine();
      engine.updateRiskMetrics({ dailyPL: -150 });
      const metrics = engine.getRiskMetrics();
      this.assertEqual(metrics.dailyPL, -150, 'Daily P&L tracking');
    });

    this.test('RiskEngine emergency stop works', () => {
      const engine = new RiskEngine();
      engine.activateEmergencyStop('TEST', 'Testing emergency stop');
      const status = engine.getStatus();
      this.assertTrue(status.emergencyStop, 'Emergency stop should be active');
    });

    this.test('RiskEngine audit logging works', () => {
      const engine = new RiskEngine();
      const validationResult = {
        symbol: 'NVDA',
        passed: true,
        score: 85
      };
      engine.logValidation(validationResult);
      const log = engine.getAuditLog();
      this.assertTrue(log.length > 0, 'Audit log should have entries');
    });
  }

  testRiskValidation() {
    console.log('\n🛡️ RISK VALIDATION TESTS\n');

    this.test('Daily loss limit validation works', () => {
      const validator = new RiskValidator();
      const tradeRequest = {
        symbol: 'NVDA',
        quantity: 100,
        currentPrice: 145,
        account: {
          dailyPL: -400,
          balance: 50000
        }
      };

      const violation = validator.checkDailyLossLimit(tradeRequest, -500);
      // -400 + (100 * 145 * 0.05) = -400 - 725 = -1125 (exceeds -500 limit)
      this.assertExists(violation, 'Should detect daily loss violation');
    });

    this.test('Position size validation works', () => {
      const validator = new RiskValidator();
      const tradeRequest = {
        quantity: 500,
        currentPrice: 100,
        account: { balance: 10000 }
      };

      const violation = validator.checkPositionSize(tradeRequest, 0.05); // 5% max
      // 500 * 100 = 50000 / 10000 = 500% (way over 5%)
      this.assertExists(violation, 'Should detect oversized position');
    });

    this.test('Correlation check works', () => {
      const validator = new RiskValidator();
      const tradeRequest = {
        symbol: 'AMD',
        account: {
          positions: { NVDA: 100, INTC: 50 }
        }
      };

      const violation = validator.checkCorrelation(tradeRequest, 0.85);
      // AMD is highly correlated with NVDA/INTC (semiconductors)
      this.assertExists(violation, 'Should detect high correlation');
    });

    this.test('Duplicate detection works', () => {
      const validator = new RiskValidator();
      const now = new Date();
      const recentTrades = [
        {
          symbol: 'NVDA',
          side: 'BUY',
          quantity: 50,
          timestamp: now.toISOString()
        }
      ];

      const tradeRequest = {
        symbol: 'NVDA',
        side: 'BUY',
        quantity: 50,
        recentTrades: recentTrades
      };

      const violation = validator.checkDuplicate(tradeRequest, 60);
      this.assertExists(violation, 'Should detect duplicate order');
    });

    this.test('Risk scoring calculates correctly', () => {
      const validator = new RiskValidator();
      const tradeRequest = {
        symbol: 'NVDA',
        quantity: 10,
        currentPrice: 150,
        account: {
          balance: 100000,
          dailyPL: -50,
          exposure: 25000,
          positions: {}
        }
      };

      const rules = {
        maxDailyLoss: -500,
        maxPositionPercent: 0.05,
        maxExposure: 0.50,
        maxCorrelation: 0.85,
        duplicateTimeWindow: 60
      };

      const score = validator.calculateRiskScore(tradeRequest, rules);
      this.assertTrue(score >= 0 && score <= 100, 'Risk score should be 0-100');
    });
  }

  testRiskRules() {
    console.log('\n⚙️ RISK RULES TESTS\n');

    this.test('Risk rules have tier overrides', () => {
      const rules = new RiskRules();
      const freeRules = rules.getTierRules('free');
      const proRules = rules.getTierRules('pro');

      this.assertTrue(freeRules.maxDailyLoss > proRules.maxDailyLoss, 'Free tier should have tighter daily loss limit');
    });

    this.test('Paper trading rules are looser', () => {
      const rules = new RiskRules();
      const liveRules = rules.getAccountTypeRules('live');
      const paperRules = rules.getAccountTypeRules('paper');

      this.assertTrue(paperRules.maxExposure > liveRules.maxExposure, 'Paper trading should allow more exposure');
    });

    this.test('Rule validation catches issues', () => {
      const rules = new RiskRules();
      // Set invalid rule
      rules.updateRule('maxDailyLoss', 500); // Should be negative
      const validation = rules.validateRules();

      this.assertFalse(validation.valid, 'Validation should catch positive daily loss');
      this.assertTrue(validation.issues.length > 0, 'Should list issues');
    });
  }

  // ========== SNAPSHOT TESTS ==========

  testMarketSnapshots() {
    console.log('\n📸 MARKET SNAPSHOT TESTS\n');

    this.test('Snapshot captures market data correctly', () => {
      const snapshot = new MarketSnapshot({
        symbol: 'NVDA',
        current: 145.50,
        volume: 50000000,
        rsi14: 65,
        sma20: 143.25
      });

      this.assertEqual(snapshot.symbol, 'NVDA', 'Symbol should be captured');
      this.assertEqual(snapshot.priceData.current, 145.50, 'Price should be captured');
      this.assertEqual(snapshot.volumeData.volume, 50000000, 'Volume should be captured');
    });

    this.test('Snapshot validation works', () => {
      const snapshot = new MarketSnapshot({
        symbol: 'NVDA',
        current: 145,
        volume: 1000000
      });

      const validation = snapshot.validate();
      this.assertTrue(validation.valid, 'Valid snapshot should pass validation');
    });

    this.test('Snapshot comparison works', () => {
      const snap1 = new MarketSnapshot({
        symbol: 'NVDA',
        timestamp: new Date('2026-10-07T14:00:00Z').toISOString(),
        current: 145,
        rsi14: 60
      });

      const snap2 = new MarketSnapshot({
        symbol: 'NVDA',
        timestamp: new Date('2026-10-07T14:05:00Z').toISOString(),
        current: 147,
        rsi14: 65
      });

      const comparison = MarketSnapshot.compareSnapshots(snap1, snap2);
      this.assertEqual(comparison.priceChange, 2, 'Price change should be 2');
      this.assertTrue(comparison.timeElapsed > 0, 'Time elapsed should be positive');
    });
  }

  testSnapshotService() {
    console.log('\n📸 SNAPSHOT SERVICE TESTS\n');

    this.test('Snapshot service captures decision context', async () => {
      const service = new SnapshotService();
      const result = await service.captureSnapshot({
        symbol: 'NVDA',
        decisionId: 'DEC_001',
        marketData: {
          current: 145,
          volume: 50000000,
          bid: 144.99,
          ask: 145.01
        },
        indicators: {
          rsi14: 65,
          sma20: 143
        },
        quantumScore: 85,
        confidence: 0.82
      });

      this.assertTrue(result.success, 'Snapshot should be captured successfully');
      this.assertExists(result.snapshotId, 'Should return snapshot ID');
    });

    this.test('Snapshot retrieval by decision works', async () => {
      const service = new SnapshotService();
      await service.captureSnapshot({
        symbol: 'NVDA',
        decisionId: 'DEC_002',
        marketData: { current: 145 }
      });

      const snapshot = service.getSnapshotByDecision('DEC_002');
      this.assertExists(snapshot, 'Should retrieve snapshot by decision ID');
      this.assertEqual(snapshot.symbol, 'NVDA', 'Retrieved snapshot should have correct symbol');
    });

    this.test('Snapshot analysis works', async () => {
      const service = new SnapshotService();
      const result = await service.captureSnapshot({
        symbol: 'NVDA',
        decisionId: 'DEC_003',
        marketData: {
          current: 145,
          open: 143,
          high: 146,
          low: 142
        },
        indicators: {
          rsi14: 65,
          sma20: 143,
          sma50: 140
        }
      });

      const analysis = service.analyzeSnapshot(result.snapshotId);
      this.assertExists(analysis.priceContext, 'Analysis should include price context');
      this.assertExists(analysis.technicalSignals, 'Analysis should include technical signals');
    });
  }

  // ========== EXPLAINABILITY TESTS ==========

  testExplainability() {
    console.log('\n💡 EXPLAINABILITY ENGINE TESTS\n');

    this.test('Decision card generates with QUANTUM SCORE', () => {
      const engine = new ExplainabilityEngine();
      const card = engine.generateDecisionCard({
        decisionId: 'DECISION_001',
        symbol: 'NVDA',
        action: 'BUY',
        timestamp: new Date().toISOString(),
        aiScores: {
          technicalScore: 80,
          momentumScore: 75,
          volumeScore: 70,
          volatilityScore: 65,
          liquidityScore: 85,
          sentimentScore: 80,
          consensusScore: 75,
          riskScore: 70
        },
        riskAssessment: {
          violations: []
        },
        confidence: 82
      });

      this.assertExists(card.quantumScore, 'Should calculate QUANTUM SCORE');
      this.assertTrue(card.quantumScore >= 0 && card.quantumScore <= 100, 'QUANTUM SCORE should be 0-100');
      this.assertEqual(card.sentiment, 'BULLISH', 'High score should be BULLISH');
    });

    this.test('Decision card export to markdown works', () => {
      const engine = new ExplainabilityEngine();
      const card = engine.generateDecisionCard({
        decisionId: 'DECISION_002',
        symbol: 'TSLA',
        action: 'SELL',
        timestamp: new Date().toISOString(),
        aiScores: {
          technicalScore: 35,
          momentumScore: 40,
          volumeScore: 45,
          volatilityScore: 50,
          liquidityScore: 60,
          sentimentScore: 30,
          consensusScore: 35,
          riskScore: 50
        },
        riskAssessment: {
          violations: []
        },
        confidence: 45
      });

      const markdown = engine.exportDecisionCard(card.decisionId, 'markdown');
      this.assertTrue(markdown.includes('TSLA'), 'Markdown should include symbol');
      this.assertTrue(markdown.includes('SELL'), 'Markdown should include action');
    });

    this.test('Confidence calculation works', () => {
      const engine = new ExplainabilityEngine();

      // High agreement = high confidence
      const highConfidence = engine.calculateConfidence({
        score1: 80,
        score2: 82,
        score3: 79,
        score4: 81
      });

      // Low agreement = low confidence
      const lowConfidence = engine.calculateConfidence({
        score1: 20,
        score2: 80,
        score3: 30,
        score4: 90
      });

      this.assertTrue(highConfidence > lowConfidence, 'High agreement should give higher confidence');
    });
  }

  // ========== EXECUTION MODE TESTS ==========

  testExecutionModes() {
    console.log('\n🔄 EXECUTION MODE TESTS\n');

    this.test('Execution mode constants are valid', () => {
      this.assertTrue(ExecutionMode.isValid('LIVE'), 'LIVE should be valid');
      this.assertTrue(ExecutionMode.isValid('SHADOW'), 'SHADOW should be valid');
      this.assertTrue(ExecutionMode.isValid('SIMULATION'), 'SIMULATION should be valid');
      this.assertFalse(ExecutionMode.isValid('INVALID'), 'Invalid mode should not be valid');
    });

    this.test('Shadow executor simulates orders', async () => {
      const { ShadowExecutor } = require('../execution/execution-modes');
      const executor = new ShadowExecutor();

      const result = await executor.submitOrder({
        orderId: 'ORDER_001',
        symbol: 'NVDA',
        side: 'BUY',
        quantity: 100,
        orderType: 'MARKET',
        currentMarketPrice: 145
      });

      this.assertTrue(result.success, 'Shadow order should succeed');
      this.assertTrue(result.note.includes('SIMULATED'), 'Should indicate simulated order');
      this.assertExists(result.executionPrice, 'Should have execution price');
    });

    this.test('Execution router switches modes', () => {
      const { ExecutionRouter } = require('../execution/execution-modes');
      const router = new ExecutionRouter();

      router.initialize({});

      this.assertEqual(router.getMode(), ExecutionMode.SHADOW, 'Default mode should be SHADOW');

      router.switchMode(ExecutionMode.SIMULATION);
      this.assertEqual(router.getMode(), ExecutionMode.SIMULATION, 'Mode should switch to SIMULATION');
    });
  }

  // ========== HEALTH CHECK TESTS ==========

  testHealthCheck() {
    console.log('\n🏥 HEALTH CHECK TESTS\n');

    this.test('Health check system registers services', () => {
      const health = new HealthCheckSystem();

      health.registerService('risk-engine', async () => {
        return { responseTime: 10 };
      });

      const status = health.getServiceStatus('risk-engine');
      this.assertExists(status, 'Service should be registered');
      this.assertEqual(status.serviceName, 'risk-engine', 'Service name should match');
    });

    this.test('System health aggregation works', async () => {
      const health = new HealthCheckSystem();

      health.registerService('service-1', async () => {
        return { responseTime: 10 };
      });

      health.registerService('service-2', async () => {
        throw new Error('Service down');
      });

      const result = await health.checkAllServices();
      this.assertEqual(result.services['service-1'].status, 'HEALTHY', 'Healthy service should report healthy');
      this.assertTrue(['UNHEALTHY', 'DEGRADED'].includes(result.services['service-2'].status), 'Failed service should report failure');
    });
  }

  // ========== SERVICE RECOVERY TESTS ==========

  testServiceRecovery() {
    console.log('\n🔄 SERVICE RECOVERY TESTS\n');

    this.test('Recovery policies configured', () => {
      const recovery = new ServiceRecovery();

      const policy = recovery.recoveryPolicies.get('risk-engine');
      this.assertExists(policy, 'Risk engine recovery policy should exist');
      this.assertTrue(policy.pauseTrading, 'Risk engine should pause trading on failure');
      this.assertTrue(policy.requireManualApproval, 'Risk engine should require manual approval');
    });

    this.test('Pause and resume trading works', () => {
      const recovery = new ServiceRecovery();

      recovery.pauseTrading('risk-engine', 'Test pause');
      this.assertTrue(recovery.isPaused('risk-engine'), 'Service should be paused');

      recovery.resumeTrading('risk-engine', 'admin');
      this.assertFalse(recovery.isPaused('risk-engine'), 'Service should be resumed');
    });

    this.test('Recovery statistics tracked', () => {
      const recovery = new ServiceRecovery();

      recovery.recordRecoveryEvent({
        serviceName: 'test-service',
        error: 'Test error',
        result: 'RECOVERED'
      });

      const stats = recovery.getRecoveryStats();
      this.assertTrue(stats.totalEvents > 0, 'Should track recovery events');
      this.assertExists(stats.byService['test-service'], 'Should track by service');
    });
  }

  // ========== INTEGRATION TEST ==========

  testFullIntegration() {
    console.log('\n🔗 FULL INTEGRATION TEST\n');

    this.test('Risk → Snapshot → Decision → Execution flow works', async () => {
      // Setup
      const riskEngine = new RiskEngine();
      const snapshotService = new SnapshotService();
      const explainabilityEngine = new ExplainabilityEngine();
      const executionRouter = new ExecutionRouter();
      executionRouter.initialize({});

      // Step 1: Risk validation
      const tradeRequest = {
        symbol: 'NVDA',
        quantity: 50,
        currentPrice: 145,
        account: { balance: 100000, dailyPL: -100, exposure: 20000 }
      };

      const validator = new RiskValidator();
      const riskScore = validator.calculateRiskScore(tradeRequest, {
        maxDailyLoss: -500,
        maxPositionPercent: 0.05,
        maxExposure: 0.50,
        maxCorrelation: 0.85,
        duplicateTimeWindow: 60
      });

      this.assertTrue(riskScore > 0, 'Risk validation should pass');

      // Step 2: Capture snapshot
      const snapshotResult = await snapshotService.captureSnapshot({
        symbol: 'NVDA',
        decisionId: 'INTEGRATION_001',
        marketData: {
          current: 145,
          volume: 50000000,
          bid: 144.99,
          ask: 145.01
        },
        quantumScore: 82,
        confidence: 0.80
      });

      this.assertTrue(snapshotResult.success, 'Snapshot capture should succeed');

      // Step 3: Generate decision card
      const card = explainabilityEngine.generateDecisionCard({
        decisionId: 'INTEGRATION_001',
        symbol: 'NVDA',
        action: 'BUY',
        timestamp: new Date().toISOString(),
        aiScores: {
          technicalScore: 80,
          momentumScore: 75,
          volumeScore: 70,
          volatilityScore: 65,
          liquidityScore: 85,
          sentimentScore: 80,
          consensusScore: 75,
          riskScore: riskScore
        },
        riskAssessment: { violations: [] },
        confidence: 80
      });

      this.assertExists(card.quantumScore, 'Decision card should have QUANTUM SCORE');

      // Step 4: Execute in shadow mode
      const execution = await executionRouter.submitOrder({
        orderId: 'ORDER_INTEGRATION_001',
        symbol: 'NVDA',
        side: 'BUY',
        quantity: 50,
        orderType: 'MARKET',
        currentMarketPrice: 145
      });

      this.assertTrue(execution.success, 'Execution should succeed in shadow mode');
      this.assertTrue(execution.note.includes('SIMULATED'), 'Should be simulated in shadow mode');

      console.log('\n✨ Full integration test passed!');
    });
  }

  // ========== RUN ALL TESTS ==========

  runAll() {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║      RDCMNATION QUANTUM - PHASE 2 TEST SUITE               ║
║      Foundation Layer: Risk + Snapshots + Explainability   ║
╚════════════════════════════════════════════════════════════╝
    `);

    this.testRiskEngineBasics();
    this.testRiskValidation();
    this.testRiskRules();
    this.testMarketSnapshots();
    this.testSnapshotService();
    this.testExplainability();
    this.testExecutionModes();
    this.testHealthCheck();
    this.testServiceRecovery();
    this.testFullIntegration();

    this.printSummary();
  }

  printSummary() {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║                    TEST SUMMARY                            ║
╚════════════════════════════════════════════════════════════╝

Total Tests:  ${this.passed + this.failed}
✅ Passed:   ${this.passed}
❌ Failed:   ${this.failed}
Success Rate: ${((this.passed / (this.passed + this.failed)) * 100).toFixed(1)}%

${this.failed === 0 ? '🎉 ALL TESTS PASSED! Phase 2 foundation is solid.' : '⚠️  Some tests failed. Review above for details.'}
    `);
  }
}

// ============================================================================
// RUN TESTS
// ============================================================================

if (require.main === module) {
  const suite = new Phase2TestSuite();
  suite.runAll();
}

module.exports = Phase2TestSuite;
