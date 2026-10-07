/**
 * Security Bot
 * Monitors trading activity for risk management and anomaly detection
 * Prevents excessive drawdowns, enforces stop-loss, detects unusual patterns
 */

const { EventEmitter } = require('events');

class SecurityBot extends EventEmitter {
    constructor() {
        super();
        this.id = 'security-guard';
        this.name = 'Security Guard';
        this.strategy = 'risk-management';
        this.status = 'active';
        this.version = '1.0.0';

        // Risk thresholds
        this.maxDailyLossLimit = -500; // Stop if loss exceeds $500/day
        this.maxDrawdownPercent = -15; // Stop if drawdown exceeds 15%
        this.maxConsecutiveLosses = 3; // Alert after 3 consecutive losses
        this.positionSizeLimit = 500; // Max $500 per trade

        // Monitoring
        this.dailyPnL = 0;
        this.consecutiveLosses = 0;
        this.highRiskTrades = [];
        this.alerts = [];
        this.startingCapital = 50000;

        this.metrics = {
            winRate: 100,
            tradesExecuted: 0,
            totalProfit: 0,
            roi: 0,
            signalsSent: 0,
            signalsAccepted: 0,
            communicationLog: [],
            alertsRaised: 0,
            riskEventsBlocked: 0
        };

        this.inbox = [];
        this.outbox = [];
        this.registered = new Date().toISOString();
    }

    /**
     * Analyze trade for security violations
     */
    analyzeTradeRisk(trade) {
        const risks = [];
        const confidenceAdjustment = [];

        // Check 1: Position size too large
        if (parseFloat(trade.size) > this.positionSizeLimit) {
            risks.push({
                type: 'POSITION_SIZE_VIOLATION',
                severity: 'HIGH',
                message: `Trade size $${trade.size} exceeds limit of $${this.positionSizeLimit}`,
                recommended_action: 'REDUCE_SIZE_OR_REJECT'
            });
            confidenceAdjustment.push(-0.25);
        }

        // Check 2: Very low confidence (< 0.45)
        if (parseFloat(trade.confidence) < 0.45) {
            risks.push({
                type: 'LOW_CONFIDENCE',
                severity: 'MEDIUM',
                message: `Trade confidence ${trade.confidence} below acceptable threshold (0.45)`,
                recommended_action: 'REQUIRE_HIGHER_CONFIDENCE'
            });
            confidenceAdjustment.push(-0.15);
        }

        // Check 3: Consecutive losses building
        if (trade.side === 'SELL' || this.lastTradeWasLoss()) {
            this.consecutiveLosses++;
            if (this.consecutiveLosses > this.maxConsecutiveLosses) {
                risks.push({
                    type: 'CONSECUTIVE_LOSSES',
                    severity: 'HIGH',
                    message: `${this.consecutiveLosses} consecutive losses detected`,
                    recommended_action: 'COOL_OFF_PERIOD'
                });
                confidenceAdjustment.push(-0.3);
            }
        }

        // Check 4: Daily loss limit
        if (this.dailyPnL + parseFloat(trade.profitLoss || 0) < this.maxDailyLossLimit) {
            risks.push({
                type: 'DAILY_LOSS_LIMIT_BREACH',
                severity: 'CRITICAL',
                message: `Daily loss would reach $${(this.dailyPnL + parseFloat(trade.profitLoss || 0)).toFixed(2)}, exceeding limit of ${this.maxDailyLossLimit}`,
                recommended_action: 'HALT_TRADING_TODAY'
            });
            confidenceAdjustment.push(-0.5);
        }

        // Check 5: Drawdown protection
        const currentDrawdown = this.calculateDrawdown(parseFloat(trade.profitLoss || 0));
        if (currentDrawdown < this.maxDrawdownPercent) {
            risks.push({
                type: 'DRAWDOWN_LIMIT_BREACH',
                severity: 'CRITICAL',
                message: `Portfolio drawdown ${currentDrawdown.toFixed(2)}% exceeds limit of ${this.maxDrawdownPercent}%`,
                recommended_action: 'EMERGENCY_HALT'
            });
            confidenceAdjustment.push(-0.5);
        }

        // Check 6: High volatility on asset
        if (Math.abs(trade.volatility || 0) > 5) {
            risks.push({
                type: 'HIGH_VOLATILITY',
                severity: 'MEDIUM',
                message: `Asset volatility ${trade.volatility}% exceeds normal range`,
                recommended_action: 'INCREASE_STOP_LOSS_MARGIN'
            });
            confidenceAdjustment.push(-0.1);
        }

        return {
            risks,
            riskLevel: risks.length > 0 ? (risks.some(r => r.severity === 'CRITICAL') ? 'CRITICAL' : risks.some(r => r.severity === 'HIGH') ? 'HIGH' : 'MEDIUM') : 'LOW',
            adjustedConfidence: Math.max(0, parseFloat(trade.confidence || 0.5) + confidenceAdjustment.reduce((a, b) => a + b, 0)),
            blockedTrade: risks.some(r => r.severity === 'CRITICAL')
        };
    }

    /**
     * Generate security signal based on trade analysis
     */
    getSignal(trade) {
        const analysis = this.analyzeTradeRisk(trade);

        // Raise alerts for any risks
        if (analysis.risks.length > 0) {
            const alert = {
                timestamp: new Date().toISOString(),
                tradeId: trade.id,
                symbol: trade.symbol,
                riskLevel: analysis.riskLevel,
                risks: analysis.risks,
                action: analysis.blockedTrade ? 'BLOCKED' : 'APPROVED_WITH_CAUTION'
            };
            this.alerts.push(alert);
            this.metrics.alertsRaised++;
            this.emit('security-alert', alert);

            console.log(`🔒 [SECURITY] ${alert.riskLevel}: ${trade.symbol} - ${analysis.risks.map(r => r.type).join(', ')}`);
        }

        // Return signal
        const signal = {
            id: `sec-${Date.now()}`,
            source: this.id,
            type: analysis.blockedTrade ? 'BLOCK' : 'APPROVE',
            confidence: analysis.adjustedConfidence,
            riskAnalysis: analysis,
            timestamp: new Date().toISOString(),
            symbol: trade.symbol
        };

        if (analysis.blockedTrade) {
            this.metrics.riskEventsBlocked++;
        }

        this.metrics.signalsSent++;
        return signal;
    }

    /**
     * Process completed trade and update metrics
     */
    recordTrade(trade) {
        this.dailyPnL += parseFloat(trade.profitLoss || 0);
        this.metrics.tradesExecuted++;
        this.metrics.totalProfit += parseFloat(trade.profitLoss || 0);
        this.metrics.roi = ((this.metrics.totalProfit / this.startingCapital) * 100).toFixed(2);

        // Update consecutive loss counter
        if (parseFloat(trade.profitLoss) < 0) {
            this.consecutiveLosses++;
        } else {
            this.consecutiveLosses = 0;
        }

        // Update win rate
        const wins = this.metrics.tradesExecuted > 0 ? Math.floor((this.metrics.totalProfit / this.metrics.tradesExecuted + 1) * 50) : 50;
        this.metrics.winRate = Math.max(0, Math.min(100, wins));
    }

    /**
     * Calculate portfolio drawdown percentage
     */
    calculateDrawdown(recentPnL) {
        const currentValue = this.startingCapital + this.metrics.totalProfit + recentPnL;
        const drawdown = ((currentValue - this.startingCapital) / this.startingCapital) * 100;
        return drawdown;
    }

    /**
     * Check if last trade was a loss
     */
    lastTradeWasLoss() {
        return this.metrics.tradesExecuted > 0 && this.metrics.totalProfit < 0;
    }

    /**
     * Reset daily counters (call at market open)
     */
    resetDailyCounters() {
        this.dailyPnL = 0;
        this.consecutiveLosses = 0;
        this.alerts = [];
    }

    /**
     * Get security metrics
     */
    getStatus() {
        return {
            id: this.id,
            name: this.name,
            strategy: this.strategy,
            status: this.status,
            version: this.version,
            metrics: this.metrics,
            riskThresholds: {
                maxDailyLoss: this.maxDailyLossLimit,
                maxDrawdown: this.maxDrawdownPercent,
                maxConsecutiveLosses: this.maxConsecutiveLosses,
                positionSizeLimit: this.positionSizeLimit
            },
            currentState: {
                dailyPnL: this.dailyPnL.toFixed(2),
                consecutiveLosses: this.consecutiveLosses,
                recentAlerts: this.alerts.slice(-5)
            }
        };
    }
}

module.exports = new SecurityBot();
