#!/usr/bin/env node

/**
 * Phase 4 Paper Trading Validation Runner
 * Tests Phase 2+3+4 integration in PAPER mode (safe)
 */

const Phase4LiveHarness = require('./harness/phase4-live-harness');

async function main() {
  console.log('🚀 RDCMNATION QUANTUM - Phase 4 Paper Trading Validation\n');

  // Parse command line arguments
  const args = process.argv.slice(2);
  const cyclesArg = args.find(a => a.startsWith('--cycles'));
  const cycles = cyclesArg ? parseInt(cyclesArg.split('=')[1]) : 100;

  // Create and run harness
  const harness = new Phase4LiveHarness({
    mode: 'PAPER',
    cycles: cycles,
    initialCapital: 10000,  // $10,000 for more realistic position sizing
    symbols: ['NVDA', 'AAPL', 'SPY', 'QQQ', 'TSLA'],
    verbose: true,
    brokerToken: 'demo_token_' + Date.now(), // Demo token for paper mode
    brokerUsername: 'demo_user',
    brokerPassword: 'demo_pass',
    maxPositionSize: 0.15   // 15% per position for paper testing
  });

  try {
    const result = await harness.run();

    console.log('\n' + '='.repeat(70));
    console.log('📊 VALIDATION REPORT');
    console.log('='.repeat(70));
    console.log(JSON.stringify(result.report, null, 2));

    console.log('\n' + '='.repeat(70));
    console.log('✅ PHASE 4 PAPER TRADING VALIDATION COMPLETE');
    console.log('='.repeat(70));

    process.exit(0);
  } catch (error) {
    console.error('\n❌ Validation failed:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

main();
