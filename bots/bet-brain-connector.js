/**
 * Bet Brain Connector
 *
 * Connects local quantum trading system to remote Bet Brain service
 * Handles trade recommendations, consensus, and real-time sync
 */

const http = require('http');
const https = require('https');

class BetBrainConnector {
    constructor(betBrainUrl = 'https://rdcm-bet-brain.onrender.com') {
        this.betBrainUrl = betBrainUrl;
        this.isConnected = false;
        this.lastSync = null;
        this.syncInterval = null;
        this.tradeQueue = [];
        this.metrics = {
            syncAttempts: 0,
            successfulSyncs: 0,
            failedSyncs: 0,
            tradesForwarded: 0
        };

        this.initialize();
    }

    /**
     * Initialize and test connection to Bet Brain
     */
    async initialize() {
        console.log('🔌 Initializing Bet Brain Connector...');
        try {
            await this.testConnection();
            this.isConnected = true;
            console.log('✅ Bet Brain Connector initialized');
            this.startSyncCycle();
        } catch (error) {
            console.log('⚠️ Bet Brain service unavailable:', error.message);
            console.log('ℹ️ Local quantum trading will continue in standalone mode');
            this.isConnected = false;
        }
    }

    /**
     * Test connection to Bet Brain service
     */
    testConnection() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 5000);

            const urlObj = new URL(this.betBrainUrl);
            const options = {
                hostname: urlObj.hostname,
                path: '/',
                method: 'HEAD',
                timeout: 5000
            };

            const protocol = urlObj.protocol === 'https:' ? https : http;

            const req = protocol.request(options, (res) => {
                clearTimeout(timeout);
                if (res.statusCode >= 200 && res.statusCode < 400) {
                    resolve(true);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            });

            req.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });

            req.on('timeout', () => {
                clearTimeout(timeout);
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.end();
        });
    }

    /**
     * Start periodic sync cycle with Bet Brain
     */
    startSyncCycle() {
        if (this.syncInterval) return;

        this.syncInterval = setInterval(async () => {
            try {
                await this.syncWithBetBrain();
            } catch (error) {
                this.metrics.failedSyncs++;
                if (this.metrics.failedSyncs > 3) {
                    console.log('⚠️ Bet Brain sync failures, falling back to standalone mode');
                    this.isConnected = false;
                }
            }
        }, 30000); // Sync every 30 seconds
    }

    /**
     * Sync trading data with Bet Brain service
     */
    async syncWithBetBrain() {
        if (!this.isConnected) return;

        this.metrics.syncAttempts++;

        const syncData = {
            timestamp: new Date().toISOString(),
            tradeQueue: this.tradeQueue,
            metrics: this.metrics,
            source: 'quantum-local'
        };

        try {
            const response = await this.makeRequest('POST', '/api/quantum/sync', syncData);
            this.metrics.successfulSyncs++;
            this.lastSync = new Date().toISOString();

            // Process any recommendations from Bet Brain
            if (response && response.recommendations) {
                this.processRecommendations(response.recommendations);
            }

            return response;
        } catch (error) {
            this.metrics.failedSyncs++;
            throw error;
        }
    }

    /**
     * Process trade recommendations from Bet Brain
     */
    processRecommendations(recommendations) {
        if (!Array.isArray(recommendations)) return;

        recommendations.forEach(rec => {
            if (rec.symbol && rec.side && rec.confidence) {
                console.log(`🎯 Bet Brain Recommendation: ${rec.side} ${rec.symbol} (${rec.confidence})`);
                this.tradeQueue.push({
                    ...rec,
                    source: 'bet-brain',
                    timestamp: new Date().toISOString()
                });
            }
        });
    }

    /**
     * Forward trade to Bet Brain for logging
     */
    async forwardTrade(trade) {
        if (!this.isConnected) return null;

        try {
            const response = await this.makeRequest('POST', '/api/quantum/trades', {
                ...trade,
                timestamp: new Date().toISOString(),
                source: 'quantum-local'
            });

            this.metrics.tradesForwarded++;
            return response;
        } catch (error) {
            console.log('⚠️ Failed to forward trade to Bet Brain:', error.message);
            return null;
        }
    }

    /**
     * Make HTTP request to Bet Brain
     */
    makeRequest(method, path, data = null) {
        return new Promise((resolve, reject) => {
            const urlObj = new URL(this.betBrainUrl);
            const fullPath = path.startsWith('/') ? path : '/' + path;

            const options = {
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: fullPath,
                method: method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'User-Agent': 'QuantumTradingPlatform/1.0'
                },
                timeout: 10000
            };

            const protocol = urlObj.protocol === 'https:' ? https : http;

            const req = protocol.request(options, (res) => {
                let responseData = '';

                res.on('data', (chunk) => {
                    responseData += chunk;
                });

                res.on('end', () => {
                    try {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            const parsed = responseData ? JSON.parse(responseData) : null;
                            resolve(parsed);
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${responseData.substring(0, 100)}`));
                        }
                    } catch (error) {
                        reject(error);
                    }
                });
            });

            req.on('error', (err) => {
                reject(err);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            if (data) {
                req.write(JSON.stringify(data));
            }

            req.end();
        });
    }

    /**
     * Get connector status
     */
    getStatus() {
        return {
            connected: this.isConnected,
            betBrainUrl: this.betBrainUrl,
            lastSync: this.lastSync,
            queuedTrades: this.tradeQueue.length,
            metrics: this.metrics
        };
    }

    /**
     * Disconnect from Bet Brain
     */
    disconnect() {
        if (this.syncInterval) {
            clearInterval(this.syncInterval);
            this.syncInterval = null;
        }
        this.isConnected = false;
        console.log('🔌 Bet Brain Connector disconnected');
    }
}

module.exports = new BetBrainConnector();
