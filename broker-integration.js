/**
 * Broker Integration Service
 * Handles Robinhood and Coinbase OAuth connections
 */

const axios = require('axios');

class BrokerIntegration {
    constructor() {
        this.brokers = {
            robinhood: {
                name: 'Robinhood',
                baseURL: 'https://api.robinhood.com',
                authURL: 'https://api.robinhood.com/oauth2/authorize/',
                tokenURL: 'https://api.robinhood.com/oauth2/token/',
                scopes: ['read', 'write'],
                endpoints: {
                    accounts: '/accounts/',
                    positions: '/positions/',
                    orders: '/orders/',
                    quotes: '/quotes/'
                }
            },
            coinbase: {
                name: 'Coinbase',
                baseURL: 'https://api.coinbase.com',
                authURL: 'https://coinbase.com/oauth/authorize',
                tokenURL: 'https://api.coinbase.com/oauth/token',
                scopes: ['wallet:accounts:read', 'wallet:orders:create'],
                endpoints: {
                    accounts: '/v2/accounts',
                    deposits: '/v2/deposits',
                    orders: '/v2/orders',
                    prices: '/v2/prices'
                }
            }
        };
    }

    // Generate OAuth authorization URL
    getAuthorizationURL(brokerName, clientId, redirectURI) {
        const broker = this.brokers[brokerName];
        if (!broker) throw new Error(`Broker ${brokerName} not supported`);

        const params = new URLSearchParams({
            client_id: clientId,
            response_type: 'code',
            scope: broker.scopes.join(' '),
            redirect_uri: redirectURI,
            state: this.generateState()
        });

        return `${broker.authURL}?${params.toString()}`;
    }

    // Exchange authorization code for access token
    async exchangeCodeForToken(brokerName, code, clientId, clientSecret, redirectURI) {
        const broker = this.brokers[brokerName];
        if (!broker) throw new Error(`Broker ${brokerName} not supported`);

        try {
            const response = await axios.post(broker.tokenURL, {
                grant_type: 'authorization_code',
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectURI
            }, { timeout: 10000 });

            return {
                accessToken: response.data.access_token,
                refreshToken: response.data.refresh_token || null,
                expiresIn: response.data.expires_in,
                tokenType: response.data.token_type,
                scope: response.data.scope
            };
        } catch (error) {
            console.error(`Error exchanging code for ${brokerName}:`, error.message);
            throw error;
        }
    }

    // Get account information
    async getAccountInfo(brokerName, accessToken) {
        const broker = this.brokers[brokerName];
        if (!broker) throw new Error(`Broker ${brokerName} not supported`);

        try {
            const response = await axios.get(`${broker.baseURL}${broker.endpoints.accounts}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json'
                },
                timeout: 10000
            });

            return response.data;
        } catch (error) {
            console.error(`Error fetching account info from ${brokerName}:`, error.message);
            throw error;
        }
    }

    // Get positions/holdings
    async getPositions(brokerName, accessToken) {
        const broker = this.brokers[brokerName];
        if (!broker) throw new Error(`Broker ${brokerName} not supported`);

        try {
            const response = await axios.get(`${broker.baseURL}${broker.endpoints.positions}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json'
                },
                timeout: 10000
            });

            return response.data;
        } catch (error) {
            console.error(`Error fetching positions from ${brokerName}:`, error.message);
            return { positions: [] };
        }
    }

    // Place an order
    async placeOrder(brokerName, accessToken, orderParams) {
        const broker = this.brokers[brokerName];
        if (!broker) throw new Error(`Broker ${brokerName} not supported`);

        const {
            symbol,
            quantity,
            side, // 'buy' or 'sell'
            orderType, // 'market' or 'limit'
            limitPrice = null
        } = orderParams;

        try {
            const orderData = {
                symbol,
                quantity,
                side,
                type: orderType
            };

            if (orderType === 'limit' && limitPrice) {
                orderData.limit_price = limitPrice;
            }

            const response = await axios.post(
                `${broker.baseURL}${broker.endpoints.orders}`,
                orderData,
                {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    },
                    timeout: 10000
                }
            );

            return {
                orderId: response.data.id,
                status: response.data.status,
                symbol,
                quantity,
                side,
                orderType,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            console.error(`Error placing order on ${brokerName}:`, error.message);
            throw error;
        }
    }

    // Get price quotes
    async getPrices(brokerName, accessToken, symbols) {
        const broker = this.brokers[brokerName];
        if (!broker) throw new Error(`Broker ${brokerName} not supported`);

        try {
            const promises = symbols.map(symbol =>
                axios.get(`${broker.baseURL}${broker.endpoints.quotes}${symbol}/`, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept': 'application/json'
                    },
                    timeout: 10000
                })
            );

            const responses = await Promise.all(promises);
            const prices = {};

            responses.forEach((response, index) => {
                prices[symbols[index]] = {
                    price: response.data.last_price,
                    ask: response.data.ask_price,
                    bid: response.data.bid_price,
                    timestamp: new Date().toISOString()
                };
            });

            return prices;
        } catch (error) {
            console.error(`Error fetching prices from ${brokerName}:`, error.message);
            return {};
        }
    }

    // Validate broker credentials
    async validateCredentials(brokerName, accessToken) {
        try {
            const accountInfo = await this.getAccountInfo(brokerName, accessToken);
            return {
                valid: !!accountInfo,
                broker: brokerName,
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            return {
                valid: false,
                broker: brokerName,
                error: error.message
            };
        }
    }

    // Generate random state for OAuth
    generateState() {
        return Math.random().toString(36).substring(2, 15) +
               Math.random().toString(36).substring(2, 15);
    }
}

module.exports = new BrokerIntegration();
