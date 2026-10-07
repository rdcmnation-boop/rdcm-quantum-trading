#!/usr/bin/env node

/**
 * RDCMNATION QUANTUM - Run Paper Trading Validation
 *
 * Usage:
 *   node harness/run-validation.js [options]
 *
 * Examples:
 *   node harness/run-validation.js --cycles 1000 --balance 100000
 *   node harness/run-validation.js --cycles 10000 --report-every 500
 *   node harness/run-validation.js --cycles 500 --fast
 */

const ValidationHarness = require('./validation-harness');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    cycles: 1000,
    reportFrequency: 100,
    cycleIntervalMs: 0,
    initialBalance: 100000,
    symbols: ['NVDA', 'AAPL', 'SPY', 'QQQ', 'TSLA'],
    verbose: true,
    saveReport: true
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--cycles' && args[i + 1]) {
      config.cycles = parseInt(args[++i]);
    } else if (arg === '--balance' && args[i + 1]) {
      config.initialBalance = parseInt(args[++i]);
    } else if (arg === '--symbols' && args[i + 1]) {
      config.symbols = args[++i].split(',');
    } else if (arg === '--report-every' && args[i + 1]) {
      config.reportFrequency = parseInt(args[++i]);
    } else if (arg === '--delay' && args[i + 1]) {
      config.cycleIntervalMs = parseInt(args[++i]);
    } else if (arg === '--fast') {
      config.cycleIntervalMs = 0;
      config.reportFrequency = 200;
    } else if (arg === '--slow') {
      config.cycleIntervalMs = 100;
      config.reportFrequency = 50;
    } else if (arg === '--quiet') {
      config.verbose = false;
    } else if (arg === '--no-save') {
      config.saveReport = false;
    } else if (arg === '--help' || arg === '-h') {
      showHelp();
      process.exit(0);
    }
  }

  return config;
}

/**
 * Show help
 */
function showHelp() {
  console.log(`
RDCMNATION QUANTUM - Phase 2 Validation Harness

Usage:
  node harness/run-validation.js [options]

Options:
  --cycles <number>         Number of trading cycles (default: 1000)
  --balance <number>        Initial account balance (default: 100000)
  --symbols <sym1,sym2>     Symbols to trade (default: NVDA,AAPL,SPY,QQQ,TSLA)
  --report-every <n>        Report progress every N cycles (default: 100)
  --delay <ms>              Delay between cycles in ms (default: 0)
  --fast                    Run as fast as possible (0 delay, 200 report freq)
  --slow                    Run slowly with 100ms delay and frequent reports
  --quiet                   Suppress verbose logging
  --no-save                 Don't save report to file
  --help, -h                Show this help message

Examples:
  # Quick test (1000 cycles)
  node harness/run-validation.js --cycles 1000

  # Extended validation (10000 cycles, fast)
  node harness/run-validation.js --cycles 10000 --fast

  # 30-day equivalent (432,000 cycles = 100 per day)
  node harness/run-validation.js --cycles 432000 --fast --report-every 1000

  # Slow mode with detailed reporting
  node harness/run-validation.js --cycles 500 --slow

  # Custom symbols
  node harness/run-validation.js --cycles 1000 --symbols "AAPL,MSFT,GOOGL"
`);
}

/**
 * Save report to file
 */
function saveReport(report, engine) {
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const reportDir = path.join(__dirname, '../reports');

  // Create reports directory if it doesn't exist
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const filename = `validation-${timestamp}.json`;
  const filepath = path.join(reportDir, filename);

  const fullReport = {
    ...report,
    sessionLog: {
      trades: engine.trades.slice(-100), // Last 100 trades
      decisions: engine.decisions.slice(-100), // Last 100 decisions
      violations: engine.riskViolations.slice(-50) // Last 50 violations
    }
  };

  fs.writeFileSync(filepath, JSON.stringify(fullReport, null, 2));

  console.log(`\n📁 Report saved to: ${filepath}`);
  return filepath;
}

/**
 * Main entry point
 */
async function main() {
  const config = parseArgs();

  console.log('\n' + '='.repeat(70));
  console.log('🚀 RDCMNATION QUANTUM - Phase 2 Validation Harness');
  console.log('='.repeat(70));

  console.log('\n⚙️  Configuration:');
  console.log(`   Cycles: ${config.cycles}`);
  console.log(`   Initial Balance: $${config.initialBalance}`);
  console.log(`   Symbols: ${config.symbols.join(', ')}`);
  console.log(`   Report Frequency: Every ${config.reportFrequency} cycles`);
  console.log(`   Mode: ${config.cycleIntervalMs === 0 ? 'FAST (0 delay)' : `SLOW (${config.cycleIntervalMs}ms delay)`}`);
  console.log(`   Save Report: ${config.saveReport ? 'Yes' : 'No'}`);

  console.log('\n🔄 Starting validation...\n');

  const startTime = Date.now();
  const harness = new ValidationHarness(config);

  try {
    const result = await harness.run();
    const endTime = Date.now();
    const totalSeconds = (endTime - startTime) / 1000;

    // Print detailed report
    harness.printReport(result.report);

    // Save report if requested
    if (config.saveReport) {
      const filepath = saveReport(result.report, result.engine);
    }

    console.log(`\n⏱️  Total Runtime: ${(totalSeconds).toFixed(1)} seconds`);
    console.log(`📊 Average: ${(totalSeconds / config.cycles * 1000).toFixed(2)}ms per cycle`);

    // Exit with success
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Validation harness failed:');
    console.error(error);
    process.exit(1);
  }
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
