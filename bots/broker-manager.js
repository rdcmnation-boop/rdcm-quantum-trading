/**
 * Broker Manager
 *
 * Coordinates multiple broker adapters (Robinhood, Coinbase, etc.)
 * Executes trades across brokers with fallback strategy
 * Tracks performance across all brokers
 */

class BrokerManager {
    constructor() {
        this.brokers = {};
        this.activeBroker = null;
        this.brokerPriority = ['robinhood', 'coinbase'];
        this.tradeHistory = [];
        this.maxHistorySize = 1000;

        // Aggregate metrics
        this.aggregateMetrics = {
            totalTrades: 0,
            successfulTrades: 0,
            failedTrades: 0,
            totalProfit: 0,
            totalLoss: 0,
            winRate: 0,
            roi: '0%'
        };

        this.initialize();
    }

    /**
     * Register a broker adapter
     */
    registerBroker(name, adapter) {
        this.brokers[name.toLowerCase()] = adapter;
        console.log(`✅ Registered broker: ${name}`);

        // Set first connected broker as active
        if (!this.activeBroker && adapter.isConnected) {
            this.activeBroker = name.toLowerCase();
            console.log(`🎯 Active broker: ${name}`);
        }
    }

    /**
     * Initialize brokers
     */
    async initialize() {
        console.log('🔌 Initializing Broker Manager...');
        console.log(`📊 Available brokers: ${Object.keys(this.brokers).length}`);
    }

    /**
     * Get list of connected brokers
     */
    getConnectedBrokers() {
        return Object.entries(this.brokers)
            .filter(([_, broker]) => broker.isConnected)
            .map(([name, broker]) => ({
                name: name,
                connected: true,
                metrics: broker.metrics
            }));
    }

    /**
     * Get best available broker
     */
    getBestBroker() {
        const connected = this.getConnectedBrokers();
        if (connected.length === 0) return null;

        // Return first in priority that's connected
        for (const brokerName of this.brokerPriority) {
            if (connected.find(b => b.name === brokerName)) {
                return this.brokers[brokerName];
            }
        }

        return this.brokers[connected[0].name];
    }

    /**
     * Execute trade with broker fallback
     */
    async executeTrade(symbol, side, quantity, brokerName = null) {
        let broker;

        if (brokerName) {
            broker = this.brokers[brokerName.toLowerCase()];
            if (!broker) {
                throw new Error(`Broker not found: ${brokerName}`);
            }
        } else {
            broker = this.getBestBroker();
            if (!broker) {
                throw new Error('No connected brokers available');
            }
        }

        try {
            console.log(`📤 Executing ${side} ${quantity} ${symbol} on ${broker.brokerName}...`);

            const result = await broker.executeTrade(symbol, side, quantity);

            this.aggregateMetrics.totalTrades++;
            if (result.status === 'filled' || result.status === 'open') {
                this.aggregateMetrics.successfulTrades++;
            } else {
                this.aggregateMetrics.failedTrades++;
            }

            // Log trade
            this.tradeHistory.push({
                timestamp: Date.now(),
                broker: broker.brokerName,
                symbol,
                side,
                quantity,
                result
            });

            if (this.tradeHistory.length > this.maxHistorySize) {
                this.tradeHistory.shift();
            }

            return {
                success: true,
                broker: broker.brokerName,
                trade: result
            };
        } catch (error) {
            console.log(`❌ Trade failed on ${broker.brokerName}: ${error.message}`);
            this.aggregateMetrics.failedTrades++;

            // Try fallback brokers
            if (!brokerName) {
                console.log('🔄 Attempting fallback broker...');
                for (const fallbackName of this.brokerPriority) {
                    if (fallbackName !== broker.botId) {
                        const fallback = this.brokers[fallbackName];
                        if (fallback && fallback.isConnected) {
                            try {
                                return await this.executeTrade(symbol, side, quantity, fallbackName);
                            } catch (e) {
                                console.log(`⚠️ Fallback ${fallbackName} also failed`);
                            }
                        }
                    }
                }
            }

            throw error;
        }
    }

    /**
     * Get crypto prices from best available broker
     */
    async getCryptoPrices(symbols) {
        const broker = this.getBestBroker();
        if (!broker) {
            throw new Error('No connected brokers available');
        }

        try {
            return await broker.getCryptoPrices(symbols);
        } catch (error) {
            console.log(`Error getting prices from ${broker.brokerName}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get positions from broker
     */
    async getPositions(brokerName = null) {
        let broker;

        if (brokerName) {
            broker = this.brokers[brokerName.toLowerCase()];
        } else {
            broker = this.getBestBroker();
        }

        if (!broker) {
            throw new Error('No connected brokers available');
        }

        try {
            return await broker.getPositions();
        } catch (error) {
            console.log(`Error getting positions: ${error.message}`);
            throw error;
        }
    }

    /**
     * Get broker status
     */
    getBrokerStatus(brokerName = null) {
        if (brokerName) {
            const broker = this.brokers[brokerName.toLowerCase()];
            return broker ? broker.getStatus() : null;
        }

        return {
            activeBroker: this.activeBroker,
            brokers: this.getConnectedBrokers(),
            aggregateMetrics: this.aggregateMetrics,
            tradeHistoryCount: this.tradeHistory.length
        };
    }

    /**
     * Get recent trades
     */
    getRecentTrades(limit = 20) {
        return this.tradeHistory.slice(-limit).reverse();
    }

    /**
     * Calculate aggregate metrics
     */
    updateAggregateMetrics() {
        const total = this.aggregateMetrics.totalTrades;
        if (total > 0) {
            this.aggregateMetrics.winRate = (
                (this.aggregateMetrics.successfulTrades / total) * 100
            ).toFixed(2) + '%';
        }
    }
}

module.exports = new BrokerManager();
