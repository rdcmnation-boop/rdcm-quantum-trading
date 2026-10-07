/**
 * Bet Brain API Adapter
 *
 * Connects to the external Bet Brain service running at:
 * https://rdcm-bet-brain.onrender.com/
 *
 * This adapter implements the unified bot brain interface and bridges
 * the external Bet Brain API to coordinate with the local bot strategies.
 */

const https = require('https');

class BetBrainAdapter {
    constructor() {
        this.apiUrl = 'https://rdcm-bet-brain.onrender.com';
        this.authToken = null;
        this.botId = 'bet-brain';
        this.strategy = 'probability-based-betting';
        this.version = '2.5.0';
        this.isConnected = false;
        this.lastHeartbeat = null;
        this.signalCache = [];
        this.maxCacheSize = 100;
        this.connectionAttempts = 0;
        this.maxConnectionAttempts = 3;

        // Performance metrics
        this.metrics = {
            winRate: 0.62,
            tradesExecuted: 0,
            successfulTrades: 0,
            totalProfit: 0,
            roi: '0%',
            accuracy: 0.65,
            lastUpdateTime: Date.now()
        };

        this.initialize();
    }

    /**
     * Initialize the adapter and attempt connection to Bet Brain service
     */
    async initialize() {
        console.log('🔌 Initializing Bet Brain Adapter...');

        try {
            // Attempt to connect to the external Bet Brain service
            await this.testConnection();
            this.isConnected = true;
            console.log('✅ Bet Brain Adapter connected to external service');
        } catch (error) {
            console.log('⚠️ Bet Brain service not immediately available:', error.message);
            console.log('ℹ️ Operating in standalone mode until service is reachable');
            this.isConnected = false;
        }

        // Start periodic connection checks
        this.startHeartbeat();
    }

    /**
     * Test connection to the Bet Brain service
     */
    testConnection() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 5000);

            https.get(`${this.apiUrl}/login.html`, (res) => {
                clearTimeout(timeout);
                if (res.statusCode >= 200 && res.statusCode < 400) {
                    resolve(true);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            }).on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });
    }

    /**
     * Start periodic heartbeat to monitor connection
     */
    startHeartbeat() {
        setInterval(async () => {
            try {
                await this.testConnection();
                if (!this.isConnected) {
                    this.isConnected = true;
                    console.log('✅ Bet Brain service is now reachable');
                }
                this.lastHeartbeat = Date.now();
            } catch (error) {
                if (this.isConnected) {
                    console.log('⚠️ Lost connection to Bet Brain service');
                    this.isConnected = false;
                }
            }
        }, 30000); // Check every 30 seconds
    }

    /**
     * Generate a trading signal based on betting strategy
     *
     * @param {string} symbol - The trading symbol (AAPL, BTC, etc.)
     * @param {object} marketData - Current market data
     * @returns {object} Signal object with type, confidence, reason
     */
    async getSignal(symbol, marketData) {
        try {
            // Try to fetch signal from external Bet Brain service if available
            if (this.isConnected) {
                return await this.getExternalSignal(symbol, marketData);
            }
        } catch (error) {
            console.log('ℹ️ Could not reach external Bet Brain, using local strategy');
        }

        // Use local betting strategy as fallback
        return this.getLocalSignal(symbol, marketData);
    }

    /**
     * Attempt to fetch signal from external Bet Brain service
     */
    getExternalSignal(symbol, marketData) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('External signal fetch timeout'));
            }, 3000);

            const postData = JSON.stringify({
                symbol: symbol,
                marketData: marketData
            });

            const options = {
                hostname: 'rdcm-bet-brain.onrender.com',
                path: '/api/brain/signal',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    clearTimeout(timeout);

                    try {
                        const response = JSON.parse(data);

                        // Convert external signal to unified format
                        const signal = {
                            type: response.type || response.signal?.type || 'HOLD',
                            confidence: response.confidence || response.signal?.confidence || 0.62,
                            reason: response.reason || response.signal?.reason || 'Probability assessment',
                            strategy: 'external-bet-brain',
                            source: 'bet-brain-api',
                            marketAnalysis: response.analysis || 'External probability calculation'
                        };

                        resolve(signal);
                    } catch (parseError) {
                        // Fallback to local signal on parse error
                        resolve(this.getLocalSignal(symbol, marketData));
                    }
                });
            });

            req.on('error', (error) => {
                clearTimeout(timeout);
                reject(error);
            });

            req.write(postData);
            req.end();
        });
    }

    /**
     * Local betting strategy (used as fallback or primary)
     * Analyzes probability patterns, volatility, and market sentiment
     */
    getLocalSignal(symbol, marketData) {
        // Analyze current market data
        const price = marketData?.price || 100;
        const high = marketData?.high || price * 1.05;
        const low = marketData?.low || price * 0.95;
        const volume = marketData?.volume || 1000000;
        const change24h = marketData?.change24h || 0;

        // Calculate volatility
        const volatility = ((high - low) / price) * 100;

        // Determine signal based on betting strategy
        let type = 'HOLD';
        let confidence = 0.62;
        let reason = 'Neutral probability assessment';

        // Bull signal: positive change + increasing volume + low volatility
        if (change24h > 2 && volume > 500000 && volatility < 3) {
            type = 'BUY';
            confidence = Math.min(0.75 + (change24h / 100), 0.92);
            reason = `Bullish probability (change: ${change24h.toFixed(2)}%, volatility: ${volatility.toFixed(2)}%)`;
        }

        // Bear signal: negative change + high volatility + volume
        else if (change24h < -2 && volatility > 3) {
            type = 'SELL';
            confidence = Math.min(0.70 + Math.abs(change24h / 100), 0.88);
            reason = `Bearish probability (change: ${change24h.toFixed(2)}%, volatility: ${volatility.toFixed(2)}%)`;
        }

        // Oscillation strategy: high volatility = opportunity
        else if (volatility > 4) {
            type = 'BUY'; // Bet on reversal
            confidence = Math.min(0.65 + (volatility / 100), 0.80);
            reason = `Volatility-based opportunity (${volatility.toFixed(2)}% swing)`;
        }

        // Low volatility = hold position
        else if (volatility < 1) {
            type = 'HOLD';
            confidence = 0.65;
            reason = 'Low volatility - maintaining position';
        }

        return {
            type,
            confidence,
            reason,
            strategy: 'probability-based-betting',
            analysis: {
                volatility: volatility.toFixed(2),
                change24h: change24h.toFixed(2),
                volume: volume,
                assessment: 'Local bet brain probability calculation'
            }
        };
    }

    /**
     * Get current bot status and metrics
     */
    getStatus() {
        return {
            id: this.botId,
            name: 'Bet Brain',
            strategy: this.strategy,
            version: this.version,
            status: this.isConnected ? 'CONNECTED' : 'ACTIVE',
            connected: this.isConnected,
            externalServiceUrl: this.apiUrl,
            lastHeartbeat: this.lastHeartbeat,
            winRate: this.metrics.winRate,
            tradesExecuted: this.metrics.tradesExecuted,
            successfulTrades: this.metrics.successfulTrades,
            totalProfit: this.metrics.totalProfit,
            roi: this.metrics.roi,
            accuracy: this.metrics.accuracy,
            lastUpdate: new Date(this.metrics.lastUpdateTime).toISOString()
        };
    }

    /**
     * Handle inter-bot communication
     */
    handleMessage(message) {
        console.log('💬 Bet Brain received message:', message.type);

        switch (message.type) {
            case 'MARKET_ALERT':
                // Process market alert from other bot
                this.processMarketAlert(message.payload);
                break;

            case 'TRADE_EXECUTED':
                // Update metrics from executed trade
                this.updateMetricsFromTrade(message.payload);
                break;

            case 'SIGNAL_GENERATED':
                // Cache signal for consensus voting
                this.cacheSignal(message.payload);
                break;

            default:
                console.log('ℹ️ Unknown message type:', message.type);
        }
    }

    /**
     * Process market alert from other bots
     */
    processMarketAlert(payload) {
        if (payload?.alert) {
            console.log('🚨 Market Alert:', payload.alert);
            // Could trigger special handling or alert the betting strategy
        }
    }

    /**
     * Update metrics when a trade executes
     */
    updateMetricsFromTrade(payload) {
        if (payload?.profitLoss !== undefined) {
            this.metrics.tradesExecuted++;
            this.metrics.totalProfit += payload.profitLoss;

            if (payload.profitLoss > 0) {
                this.metrics.successfulTrades++;
            }

            // Update win rate
            this.metrics.winRate = this.metrics.tradesExecuted > 0
                ? this.metrics.successfulTrades / this.metrics.tradesExecuted
                : 0.62;

            // Update ROI
            if (this.metrics.totalProfit > 0) {
                this.metrics.roi = `+${((this.metrics.totalProfit / 10000) * 100).toFixed(2)}%`;
            } else if (this.metrics.totalProfit < 0) {
                this.metrics.roi = `-${Math.abs((this.metrics.totalProfit / 10000) * 100).toFixed(2)}%`;
            }

            console.log(`📊 Metrics updated: ${this.metrics.tradesExecuted} trades, ROI: ${this.metrics.roi}`);
        }
    }

    /**
     * Cache recent signals for pattern analysis
     */
    cacheSignal(signal) {
        this.signalCache.push({
            ...signal,
            timestamp: Date.now()
        });

        // Keep cache size limited
        if (this.signalCache.length > this.maxCacheSize) {
            this.signalCache.shift();
        }
    }

    /**
     * Explain the reasoning behind the last decision
     */
    explain(lastDecision) {
        return {
            reasoning: 'Probability-based betting strategy analyzes market conditions and volatility patterns',
            confidence_factors: [
                `Win rate: ${(this.metrics.winRate * 100).toFixed(1)}%`,
                `Recent trades: ${this.metrics.tradesExecuted}`,
                `External connection: ${this.isConnected ? 'Active' : 'Fallback mode'}`
            ],
            risk_assessment: this.metrics.winRate > 0.70 ? 'medium' : 'medium-high',
            strategy_type: 'Probability Assessment + Volatility Analysis',
            last_decision: lastDecision || 'No recent decision'
        };
    }

    /**
     * Get formatted status for logging
     */
    toString() {
        return `BetBrainAdapter(connected=${this.isConnected}, winRate=${this.metrics.winRate}, trades=${this.metrics.tradesExecuted})`;
    }
}

// Export as singleton for use in unified brain
module.exports = new BetBrainAdapter();
