/**
 * Coinbase Broker Adapter
 *
 * Connects to Coinbase API for cryptocurrency trading
 * Executes real trades through your Coinbase account
 *
 * Get your credentials at: https://www.coinbase.com/settings/api
 * API Docs: https://docs.cloud.coinbase.com/
 */

const https = require('https');
const crypto = require('crypto');

class CoinbaseAdapter {
    constructor() {
        this.apiUrl = 'https://api.coinbase.com';
        this.apiKey = process.env.COINBASE_API_KEY || null;
        this.apiSecret = process.env.COINBASE_API_SECRET || null;
        this.passphrase = process.env.COINBASE_PASSPHRASE || null;
        this.botId = 'coinbase-broker';
        this.brokerName = 'Coinbase';
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
            availableFunds: 0,
            portfolioValue: 0
        };

        this.initialize();
    }

    /**
     * Sign request for Coinbase API (CB-ACCESS-SIGN)
     */
    signRequest(method, path, body = '') {
        const timestamp = Date.now() / 1000;
        const message = timestamp + method + path + body;

        const hmac = crypto.createHmac('sha256', Buffer.from(this.apiSecret, 'base64'));
        const signature = hmac.update(message).digest('base64');

        return {
            'CB-ACCESS-KEY': this.apiKey,
            'CB-ACCESS-SIGN': signature,
            'CB-ACCESS-TIMESTAMP': timestamp,
            'CB-ACCESS-PASSPHRASE': this.passphrase
        };
    }

    /**
     * Initialize the adapter and attempt connection to Coinbase
     */
    async initialize() {
        console.log('🔌 Initializing Coinbase Adapter...');

        if (!this.apiKey || !this.apiSecret || !this.passphrase) {
            console.log('⚠️ Coinbase credentials not configured');
            console.log('📝 Set environment variables:');
            console.log('   - COINBASE_API_KEY');
            console.log('   - COINBASE_API_SECRET');
            console.log('   - COINBASE_PASSPHRASE');
            console.log('🔗 Get credentials at: https://www.coinbase.com/settings/api');
            return;
        }

        try {
            await this.testConnection();
            this.isConnected = true;
            await this.getAccountInfo();
            console.log('✅ Coinbase Adapter connected');
        } catch (error) {
            console.log('⚠️ Coinbase connection failed:', error.message);
            this.isConnected = false;
        }

        this.startHeartbeat();
    }

    /**
     * Test connection to Coinbase API
     */
    testConnection() {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 5000);

            const path = '/api/v3/accounts';
            const headers = this.signRequest('GET', path);
            headers['Accept'] = 'application/json';

            const options = {
                hostname: 'api.coinbase.com',
                path: path,
                method: 'GET',
                headers: headers
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
     * Get account information from Coinbase
     */
    async getAccountInfo() {
        return new Promise((resolve, reject) => {
            const path = '/api/v3/accounts';
            const headers = this.signRequest('GET', path);
            headers['Accept'] = 'application/json';

            const options = {
                hostname: 'api.coinbase.com',
                path: path,
                method: 'GET',
                headers: headers
            };

            https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        if (json.accounts && json.accounts.length > 0) {
                            const account = json.accounts[0];
                            this.accountId = account.uuid;
                            this.metrics.availableFunds = parseFloat(account.available_balance?.amount || 0);
                            this.metrics.portfolioValue = parseFloat(account.hold?.amount || 0);
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
                    console.log('✅ Coinbase service is now reachable');
                }
                this.lastHeartbeat = Date.now();
            } catch (error) {
                if (this.isConnected) {
                    console.log('⚠️ Lost connection to Coinbase');
                    this.isConnected = false;
                }
            }
        }, 30000); // Check every 30 seconds
    }

    /**
     * Get current crypto prices from Coinbase
     */
    async getCryptoPrices(symbols) {
        return new Promise((resolve, reject) => {
            const symbolsParam = symbols.map(s => `${s}-USD`).join(',');
            const path = `/api/v3/brokerage/market/products/batch?product_ids=${symbolsParam}`;

            const headers = this.signRequest('GET', path);
            headers['Accept'] = 'application/json';

            const options = {
                hostname: 'api.coinbase.com',
                path: path,
                method: 'GET',
                headers: headers
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
     * Execute a trade on Coinbase
     */
    async executeTrade(symbol, side, quantity, orderType = 'MARKET') {
        if (!this.isConnected) {
            throw new Error('Coinbase not connected');
        }

        return new Promise((resolve, reject) => {
            const productId = `${symbol}-USD`;
            const tradeData = JSON.stringify({
                client_order_id: crypto.randomUUID(),
                product_id: productId,
                side: side.toUpperCase(), // 'BUY' or 'SELL'
                order_configuration: {
                    market_market_ioc: {
                        quote_size: quantity.toString()
                    }
                }
            });

            const path = '/api/v3/brokerage/orders';
            const headers = this.signRequest('POST', path, tradeData);
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(tradeData);

            const options = {
                hostname: 'api.coinbase.com',
                path: path,
                method: 'POST',
                headers: headers
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
            const path = '/api/v3/brokerage/portfolios';
            const headers = this.signRequest('GET', path);
            headers['Accept'] = 'application/json';

            const options = {
                hostname: 'api.coinbase.com',
                path: path,
                method: 'GET',
                headers: headers
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

module.exports = new CoinbaseAdapter();
