/**
 * Customer Activity Logger
 * Tracks all customer activity for transparency and compliance
 * Logs trades, decisions, alerts, and portfolio changes
 */

class CustomerActivityLogger {
    constructor() {
        this.activities = []; // Activity log
        this.maxActivityHistory = 10000;
        this.sessionLogs = new Map(); // Per-user session logs
    }

    /**
     * Log a customer activity
     */
    logActivity(userId, activityType, details) {
        const activity = {
            id: `act-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            userId,
            activityType, // 'LOGIN', 'LOGOUT', 'TRADE_EXECUTED', 'TRADE_REJECTED', 'ALERT_RAISED', 'POSITION_CHANGE', 'SETTING_CHANGE'
            details,
            timestamp: new Date().toISOString(),
            ipAddress: details.ipAddress || 'unknown',
            userAgent: details.userAgent || 'unknown'
        };

        this.activities.push(activity);

        // Keep history manageable
        if (this.activities.length > this.maxActivityHistory) {
            this.activities.shift();
        }

        return activity;
    }

    /**
     * Log trade execution with full context
     */
    logTradeExecution(userId, trade, botDecisions, confidence) {
        return this.logActivity(userId, 'TRADE_EXECUTED', {
            tradeId: trade.id,
            symbol: trade.symbol,
            side: trade.side,
            size: trade.size,
            profitLoss: trade.profitLoss,
            confidence: confidence,
            triggeredBy: trade.triggeredBy,
            botVotes: botDecisions
        });
    }

    /**
     * Log trade rejection
     */
    logTradeRejection(userId, trade, reason, riskAnalysis) {
        return this.logActivity(userId, 'TRADE_REJECTED', {
            tradeId: trade.id,
            symbol: trade.symbol,
            side: trade.side,
            size: trade.size,
            reason,
            riskAnalysis
        });
    }

    /**
     * Log security alert
     */
    logSecurityAlert(userId, alert) {
        return this.logActivity(userId, 'ALERT_RAISED', {
            alertId: alert.timestamp,
            severity: alert.riskLevel,
            riskTypes: alert.risks.map(r => r.type),
            message: alert.risks.map(r => r.message).join('; ')
        });
    }

    /**
     * Log portfolio change
     */
    logPortfolioChange(userId, change) {
        return this.logActivity(userId, 'POSITION_CHANGE', {
            symbol: change.symbol,
            previousQuantity: change.previousQuantity,
            newQuantity: change.newQuantity,
            changeReason: change.reason // 'TRADE_EXECUTED', 'LIQUIDATION', 'MANUAL_ADJUSTMENT'
        });
    }

    /**
     * Log user login
     */
    logLogin(userId, ipAddress, userAgent) {
        return this.logActivity(userId, 'LOGIN', {
            ipAddress,
            userAgent,
            timestamp: new Date().toISOString()
        });
    }

    /**
     * Log user logout
     */
    logLogout(userId, sessionDuration) {
        return this.logActivity(userId, 'LOGOUT', {
            sessionDurationSeconds: sessionDuration
        });
    }

    /**
     * Log setting change
     */
    logSettingChange(userId, settingKey, oldValue, newValue) {
        return this.logActivity(userId, 'SETTING_CHANGE', {
            settingKey,
            oldValue,
            newValue
        });
    }

    /**
     * Log bot performance metrics for user
     */
    logBotMetrics(userId, botMetrics) {
        return this.logActivity(userId, 'BOT_METRICS_UPDATE', {
            botsActive: botMetrics.botsActive,
            totalTrades: botMetrics.totalTrades,
            totalProfit: botMetrics.totalProfit,
            winRate: botMetrics.winRate
        });
    }

    /**
     * Get user activity history
     */
    getUserActivity(userId, limit = 100, activityType = null) {
        let userActivities = this.activities.filter(a => a.userId === userId);

        if (activityType) {
            userActivities = userActivities.filter(a => a.activityType === activityType);
        }

        return userActivities.slice(-limit).reverse();
    }

    /**
     * Get activity summary for user (last 24 hours)
     */
    getUserActivitySummary(userId) {
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const userActivities = this.activities.filter(a =>
            a.userId === userId &&
            a.timestamp > twentyFourHoursAgo
        );

        const summary = {
            totalActivities: userActivities.length,
            trades: userActivities.filter(a => a.activityType === 'TRADE_EXECUTED').length,
            rejections: userActivities.filter(a => a.activityType === 'TRADE_REJECTED').length,
            alerts: userActivities.filter(a => a.activityType === 'ALERT_RAISED').length,
            logins: userActivities.filter(a => a.activityType === 'LOGIN').length,
            activities: userActivities.slice(0, 10) // Last 10 activities
        };

        return summary;
    }

    /**
     * Get trading performance from activity log
     */
    getTradingPerformance(userId, limit = 100) {
        const trades = this.getUserActivity(userId, limit, 'TRADE_EXECUTED');

        if (trades.length === 0) {
            return {
                totalTrades: 0,
                winningTrades: 0,
                losingTrades: 0,
                winRate: 0,
                totalPnL: 0,
                avgPnL: 0
            };
        }

        const pnLValues = trades.map(t => parseFloat(t.details.profitLoss || 0));
        const wins = pnLValues.filter(p => p > 0).length;
        const losses = pnLValues.filter(p => p < 0).length;
        const totalPnL = pnLValues.reduce((a, b) => a + b, 0);

        return {
            totalTrades: trades.length,
            winningTrades: wins,
            losingTrades: losses,
            winRate: ((wins / trades.length) * 100).toFixed(2),
            totalPnL: totalPnL.toFixed(2),
            avgPnL: (totalPnL / trades.length).toFixed(2),
            recentTrades: trades.slice(0, 10)
        };
    }

    /**
     * Export audit trail for compliance
     */
    getAuditTrail(userId, startDate, endDate) {
        return this.activities.filter(a =>
            a.userId === userId &&
            a.timestamp >= startDate &&
            a.timestamp <= endDate
        ).map(a => ({
            timestamp: a.timestamp,
            activityType: a.activityType,
            details: a.details
        }));
    }

    /**
     * Get all activities for admin (limited)
     */
    getAllActivities(limit = 1000) {
        return this.activities.slice(-limit).reverse();
    }

    /**
     * Get activities by type for analytics
     */
    getActivitiesByType(activityType, limit = 500) {
        return this.activities
            .filter(a => a.activityType === activityType)
            .slice(-limit)
            .reverse();
    }

    /**
     * Calculate statistics
     */
    getStatistics() {
        const uniqueUsers = new Set(this.activities.map(a => a.userId)).size;
        const totalActivities = this.activities.length;
        const tradesExecuted = this.activities.filter(a => a.activityType === 'TRADE_EXECUTED').length;
        const tradesRejected = this.activities.filter(a => a.activityType === 'TRADE_REJECTED').length;
        const alertsRaised = this.activities.filter(a => a.activityType === 'ALERT_RAISED').length;

        return {
            uniqueUsers,
            totalActivities,
            tradesExecuted,
            tradesRejected,
            alertsRaised,
            conversionRate: tradesExecuted / (tradesExecuted + tradesRejected) * 100 || 0
        };
    }
}

module.exports = new CustomerActivityLogger();
