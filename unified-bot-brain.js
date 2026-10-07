/**
 * Unified Bot Brain Controller
 * Coordinates all trading bot strategies with real-time inter-bot communication
 * Supports plugin integration of external bot implementations
 */

const { EventEmitter } = require('events');

class BotSignal {
    constructor(source, type, data) {
        this.id = Date.now() + Math.random().toString(36).substr(2, 9);
        this.source = source;
        this.type = type; // 'BUY', 'SELL', 'HOLD', 'ALERT'
        this.data = data;
        this.timestamp = new Date().toISOString();
        this.confidence = data.confidence || 0.5;
        this.priority = data.priority || 'normal';
    }
}

class UnifiedBotBrain extends EventEmitter {
    constructor() {
        super();
        this.mainBrainId = 'main-brain-ai-engine';
        this.bots = new Map();
        this.signals = [];
        this.trades = [];
        this.aiMetrics = {
            totalDecisions: 0,
            correctPredictions: 0,
            accuracy: 0,
            learningRate: 0.89,
            lastUpdate: new Date().toISOString()
        };
        this.communications = [];
        this.maxSignalHistory = 1000;
        this.initialize();
    }

    initialize() {
        // Initialize the 4 core bot strategies
        this.registerBot({
            id: 'autorule-ai',
            name: 'AutoRule',
            strategy: 'rule-based',
            version: '2.1.0',
            winRate: 67,
            tradesExecuted: 128,
            profit: 5420,
            status: 'active'
        });

        this.registerBot({
            id: 'quantum-ai',
            name: 'Quantum AI',
            strategy: 'machine-learning',
            version: '3.0.1',
            winRate: 71,
            tradesExecuted: 95,
            profit: 7830,
            status: 'active'
        });

        this.registerBot({
            id: 'mining-bot',
            name: 'Mining Bot',
            strategy: 'arbitrage',
            version: '1.8.2',
            winRate: 85,
            tradesExecuted: 42,
            profit: 3920,
            status: 'active'
        });

        this.registerBot({
            id: 'bet-brain',
            name: 'Bet Brain',
            strategy: 'probability-based',
            version: '2.5.0',
            winRate: 62,
            tradesExecuted: 156,
            profit: 4210,
            status: 'active'
        });

        console.log('✅ Unified Bot Brain initialized with 4 core strategies');
        this.emit('brain-initialized', { botCount: this.bots.size });
    }

    registerBot(botConfig) {
        const bot = {
            ...botConfig,
            registered: new Date().toISOString(),
            metrics: {
                winRate: botConfig.winRate,
                tradesExecuted: botConfig.tradesExecuted,
                totalProfit: botConfig.profit,
                roi: ((botConfig.profit / 10000) * 100).toFixed(2), // Assuming $10k starting
                signalsSent: 0,
                signalsAccepted: 0,
                communicationLog: []
            },
            inbox: [],
            outbox: []
        };
        this.bots.set(bot.id, bot);
        console.log(`✅ Bot registered: ${bot.name} (${bot.id})`);
        return bot;
    }

    // Register external bot implementations (for rdcm-bet-brain, autorule-ai-brain, etc.)
    registerExternalBot(filePath, botId, botConfig) {
        try {
            // Load and parse external bot implementation
            const externalBot = require(filePath);
            if (!externalBot || typeof externalBot.getSignal !== 'function') {
                throw new Error('External bot must export getSignal() function');
            }

            const bot = {
                id: botId,
                name: botConfig.name || botId,
                strategy: botConfig.strategy || 'external',
                version: botConfig.version || '1.0.0',
                status: 'active',
                isExternal: true,
                implementation: externalBot,
                registered: new Date().toISOString(),
                metrics: {
                    winRate: 0,
                    tradesExecuted: 0,
                    totalProfit: 0,
                    roi: 0,
                    signalsSent: 0,
                    signalsAccepted: 0,
                    communicationLog: []
                },
                inbox: [],
                outbox: []
            };

            this.bots.set(bot.id, bot);
            console.log(`✅ External bot registered: ${bot.name}`);
            this.emit('external-bot-registered', bot);
            return bot;
        } catch (error) {
            console.error(`❌ Failed to register external bot: ${error.message}`);
            throw error;
        }
    }

    // Core bot decision making
    generateSignal(botId, symbol, type, confidence, reason, additionalData = {}) {
        const bot = this.bots.get(botId);
        if (!bot) throw new Error(`Bot ${botId} not found`);

        const signal = new BotSignal(botId, type, {
            symbol,
            confidence,
            reason,
            strategy: bot.strategy,
            ...additionalData
        });

        // Store signal
        this.signals.push(signal);
        if (this.signals.length > this.maxSignalHistory) {
            this.signals.shift();
        }

        bot.metrics.signalsSent++;
        this.emit('signal-generated', signal);
        return signal;
    }

    // Inter-bot communication
    sendMessage(fromBotId, toBotId, messageType, payload) {
        const fromBot = this.bots.get(fromBotId);
        const toBot = this.bots.get(toBotId);

        if (!fromBot || !toBot) throw new Error('Bot not found');

        const message = {
            id: Date.now() + Math.random().toString(36).substr(2, 9),
            from: fromBotId,
            to: toBotId,
            type: messageType,
            payload,
            timestamp: new Date().toISOString(),
            status: 'sent'
        };

        toBot.inbox.push(message);
        fromBot.outbox.push(message);
        this.communications.push(message);

        // Keep communication log manageable
        if (this.communications.length > this.maxSignalHistory * 2) {
            this.communications.shift();
        }

        this.emit('message-sent', message);
        return message;
    }

    // Broadcast to all bots
    broadcastMessage(fromBotId, messageType, payload) {
        const messages = [];
        for (const [botId, bot] of this.bots) {
            if (botId !== fromBotId) {
                const msg = this.sendMessage(fromBotId, botId, messageType, payload);
                messages.push(msg);
            }
        }
        return messages;
    }

    // Consensus-based decision making
    getConsensusSignal(symbol) {
        const relevantSignals = this.signals.filter(s =>
            s.data.symbol === symbol &&
            new Date(s.timestamp) > new Date(Date.now() - 5000) // Last 5 seconds
        );

        if (relevantSignals.length === 0) return null;

        const buyCount = relevantSignals.filter(s => s.type === 'BUY').length;
        const sellCount = relevantSignals.filter(s => s.type === 'SELL').length;
        const holdCount = relevantSignals.filter(s => s.type === 'HOLD').length;
        const avgConfidence = relevantSignals.reduce((sum, s) => sum + s.confidence, 0) / relevantSignals.length;

        let type = 'HOLD';
        if (buyCount > sellCount && buyCount > holdCount) type = 'BUY';
        if (sellCount > buyCount && sellCount > holdCount) type = 'SELL';

        const consensusSignal = {
            symbol,
            type,
            confidence: avgConfidence,
            votingResults: { buy: buyCount, sell: sellCount, hold: holdCount },
            signalCount: relevantSignals.length,
            botVotes: relevantSignals.map(s => ({ bot: s.source, type: s.type, confidence: s.confidence })),
            timestamp: new Date().toISOString()
        };

        this.emit('consensus-reached', consensusSignal);
        return consensusSignal;
    }

    // Execute trade with bot approval
    executeTrade(symbol, side, quantity, price, triggeredBy, reason) {
        const trade = {
            id: Date.now(),
            symbol,
            side,
            quantity,
            price,
            triggeredBy,
            reason,
            status: 'executed',
            timestamp: new Date().toISOString(),
            profitLoss: Math.random() * 1000 - 500 // Simulated P&L
        };

        this.trades.push(trade);

        // Update bot metrics
        const bot = this.bots.get(triggeredBy);
        if (bot) {
            bot.metrics.tradesExecuted++;
            bot.metrics.totalProfit += trade.profitLoss;
            bot.metrics.roi = ((bot.metrics.totalProfit / 10000) * 100).toFixed(2);
        }

        // Update AI metrics
        this.aiMetrics.totalDecisions++;
        if (trade.profitLoss > 0) this.aiMetrics.correctPredictions++;
        this.aiMetrics.accuracy = ((this.aiMetrics.correctPredictions / this.aiMetrics.totalDecisions) * 100).toFixed(2);
        this.aiMetrics.lastUpdate = new Date().toISOString();

        // Notify all bots of trade execution
        this.broadcastMessage('main-brain', 'TRADE_EXECUTED', {
            tradeId: trade.id,
            symbol,
            side,
            quantity,
            price,
            profitLoss: trade.profitLoss
        });

        this.emit('trade-executed', trade);
        return trade;
    }

    // Get bot status
    getBotStatus(botId) {
        const bot = this.bots.get(botId);
        if (!bot) return null;

        return {
            id: bot.id,
            name: bot.name,
            strategy: bot.strategy,
            version: bot.version,
            status: bot.status,
            isExternal: bot.isExternal || false,
            metrics: bot.metrics,
            inboxCount: bot.inbox.length,
            outboxCount: bot.outbox.length,
            lastSignal: this.signals.reverse().find(s => s.source === botId) || null
        };
    }

    // Get all bots status
    getAllBotsStatus() {
        const status = [];
        for (const [botId, bot] of this.bots) {
            status.push(this.getBotStatus(botId));
        }
        return status;
    }

    // Get AI Brain metrics
    getAIMetrics() {
        return {
            brainId: this.mainBrainId,
            status: 'active',
            botsConnected: this.bots.size,
            dataStreams: 23,
            totalDecisions: this.aiMetrics.totalDecisions,
            correctPredictions: this.aiMetrics.correctPredictions,
            accuracy: parseFloat(this.aiMetrics.accuracy),
            learningRate: this.aiMetrics.learningRate,
            marketAnalysis: 'real-time',
            decisionsPerMinute: Math.floor(this.aiMetrics.totalDecisions / Math.max(1, (Date.now() - 0) / 60000)),
            totalSignals: this.signals.length,
            totalCommunications: this.communications.length,
            totalTrades: this.trades.length,
            totalProfit: this.trades.reduce((sum, t) => sum + t.profitLoss, 0),
            lastUpdate: this.aiMetrics.lastUpdate
        };
    }

    // Get communication log
    getCommunicationLog(fromBotId = null, toBotId = null, limit = 50) {
        let log = this.communications;
        if (fromBotId) log = log.filter(c => c.from === fromBotId);
        if (toBotId) log = log.filter(c => c.to === toBotId);
        return log.slice(-limit);
    }

    // Simulate bot decisions
    simulateDecision(botId, symbol) {
        const bot = this.bots.get(botId);
        if (!bot) throw new Error(`Bot ${botId} not found`);

        const rand = Math.random();
        let type, reason;

        if (rand < 0.35) {
            type = 'BUY';
            reason = `Positive signals detected on ${symbol}`;
        } else if (rand < 0.65) {
            type = 'SELL';
            reason = `Negative momentum on ${symbol}`;
        } else {
            type = 'HOLD';
            reason = `Neutral market conditions for ${symbol}`;
        }

        const confidence = 0.4 + Math.random() * 0.5;
        const signal = this.generateSignal(botId, symbol, type, confidence, reason);

        // Bot communication (share insights with other bots)
        this.broadcastMessage(botId, 'MARKET_SIGNAL', {
            symbol,
            type,
            confidence,
            reasoning: reason
        });

        return signal;
    }

    // Training/optimization simulation
    trainModel() {
        const trainingData = {
            epoch: Date.now(),
            previousAccuracy: parseFloat(this.aiMetrics.accuracy),
            tradesAnalyzed: this.trades.length,
            improvementRate: Math.random() * 5
        };

        this.aiMetrics.learningRate = Math.min(1, this.aiMetrics.learningRate + (Math.random() * 0.1 - 0.02));
        this.aiMetrics.lastUpdate = new Date().toISOString();

        this.emit('model-trained', trainingData);
        return trainingData;
    }

    // Reset metrics
    resetMetrics() {
        this.aiMetrics.totalDecisions = 0;
        this.aiMetrics.correctPredictions = 0;
        this.aiMetrics.accuracy = 0;
        this.signals = [];
        this.trades = [];
        this.communications = [];

        for (const bot of this.bots.values()) {
            bot.metrics.tradesExecuted = 0;
            bot.metrics.totalProfit = 0;
            bot.metrics.roi = 0;
            bot.metrics.signalsSent = 0;
            bot.metrics.signalsAccepted = 0;
            bot.inbox = [];
            bot.outbox = [];
        }

        this.emit('metrics-reset', { timestamp: new Date().toISOString() });
    }

    // Export bot brain state
    exportState() {
        return {
            brainId: this.mainBrainId,
            timestamp: new Date().toISOString(),
            bots: Array.from(this.bots.entries()).map(([id, bot]) => ({
                id: bot.id,
                name: bot.name,
                status: bot.status,
                metrics: bot.metrics
            })),
            aiMetrics: this.aiMetrics,
            recentSignals: this.signals.slice(-20),
            recentTrades: this.trades.slice(-20),
            recentCommunications: this.communications.slice(-20)
        };
    }
}

// Create singleton instance
const unifiedBrain = new UnifiedBotBrain();

module.exports = unifiedBrain;
