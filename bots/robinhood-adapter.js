/**
 * Robinhood Broker Adapter
 *
 * Connects to Robinhood API for crypto and stock trading
 * Executes real trades through your Robinhood account
 *
 * Get your credentials at: https://robinhood.com/account/crypto
 */

const https = require('https');

class RobinhoodAdapter {
    constructor() {
        this.apiUrl = 'https://api.robinhood.com';
        this.authToken = process.env.ROBINHOOD_AUTH_TOKEN || null;
        this.botId = 'robinhood-broker';
        this.brokerName = 'Robinhood';
        this.version = '1.0.0';
        this.isConnected = false;
        this.lastHeartbeat = null;

        // Account info
        this.accountId = null;
        this.balance = 0;
        this.portfolio = [];
        this.positions = {};

        // Performance metrics
        this.metrics = {
            tradesExecuted: 0,
            successfulTrades: 0,
            failedTrades: 0,
            totalProfit: 0,
            roi: '0%',
            buyingPower: 0,
            portfolioValue: 0
        };

        this.initialize();
    }

    /**
     * Initialize the adapter and attempt connection to Robinhood
     */
    async initialize() {
        console.log('🔌 Initializing Robinhood Adapter...');

        if (!this.authToken) {
            console.log('⚠️ Robinhood auth token not configured');
            console.log('📝 Set ROBINHOOD_AUTH_TOKEN environment variable');
            console.log('🔗 Get token at: https://robinhood.com/account/crypto');
            return;
        }

        try {
            await this.testConnection();
            this.isConnected = true;
            await this.getAccountInfo();
            console.log('✅ Robinhood Adapter connected');
        } catch (error) {
            console.log('⚠️ Robinhood connection failed:', error.message);
            this.isConnected = false;
        }

        this.startHeartbeat();
    }

    /**
     * Test connection to Robinhood API
     */
    testConnection() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 5000);

            const options = {
                hostname: 'api.robinhood.com',
                path: '/api-token-auth/',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.authToken}`,
                    'Accept': 'application/json'
                }
            };

            https.request(options, (res) => {
                clearTimeout(timeout);
                if (res.statusCode >= 200 && res.statusCode < 400) {
                    resolve(true);
                } else {
                    reject(new Error(`HTTP ${res.statusCode}`));
                }
            }).on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            }).end();
        });
    }

    /**
     * Get account information from Robinhood
     */
    async getAccountInfo() {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.robinhood.com',
                path: '/api/accounts/',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.authToken}`,
                    'Accept': 'application/json'
                }
            };

            https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.results && json.results.length > 0) {
                            const account = json.results[0];
                            this.accountId = account.account_number;
                            this.metrics.buyingPower = parseFloat(account.buying_power || 0);
                            this.metrics.portfolioValue = parseFloat(account.equity_value || 0);
                            resolve(account);
                        } else {
                            reject(new Error('No accounts found'));
                        }
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', reject).end();
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
                    console.log('✅ Robinhood service is now reachable');
                }
                this.lastHeartbeat = Date.now();
            } catch (error) {
                if (this.isConnected) {
                    console.log('⚠️ Lost connection to Robinhood');
                    this.isConnected = false;
                }
            }
        }, 30000); // Check every 30 seconds
    }

    /**
     * Get current crypto prices from Robinhood
     */
    async getCryptoPrices(symbols) {
        return new Promise((resolve, reject) => {
            const symbolsParam = symbols.join(',');
            const options = {
                hostname: 'api.robinhood.com',
                path: `/api/crypto/quotes/?symbols=${symbolsParam}`,
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.authToken}`,
                    'Accept': 'application/json'
                }
            };

            https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', reject).end();
        });
    }

    /**
     * Execute a trade on Robinhood
     */
    async executeTrade(symbol, side, quantity, orderType = 'market') {
        if (!this.isConnected) {
            throw new Error('Robinhood not connected');
        }

        return new Promise((resolve, reject) => {
            const tradeData = JSON.stringify({
                quantity: quantity.toString(),
                side: side.toLowerCase(), // 'buy' or 'sell'
                symbol: symbol,
                order_type: orderType,
                time_in_force: 'gfd' // good for day
            });

            const options = {
                hostname: 'api.robinhood.com',
                path: '/api/orders/',
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.authToken}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(tradeData)
                }
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const response = JSON.parse(data);
                        this.metrics.tradesExecuted++;
                        if (res.statusCode === 201) {
                            this.metrics.successfulTrades++;
                        } else {
                            this.metrics.failedTrades++;
                        }
                        resolve(response);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.write(tradeData);
            req.end();
        });
    }

    /**
     * Get open positions
     */
    async getPositions() {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.robinhood.com',
                path: '/api/positions/',
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.authToken}`,
                    'Accept': 'application/json'
                }
            };

            https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                });
            }).on('error', reject).end();
        });
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            broker: this.brokerName,
            connected: this.isConnected,
            accountId: this.accountId,
            metrics: this.metrics,
            lastHeartbeat: this.lastHeartbeat,
            version: this.version
        };
    }
}

module.exports = new RobinhoodAdapter();
