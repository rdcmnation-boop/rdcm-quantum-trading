/**
 * Broker Integration Service
 * Handles Robinhood and Coinbase OAuth connections
 */

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
            const response = await fetch(broker.tokenURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    grant_type: 'authorization_code',
                    code,
                    client_id: clientId,
                    client_secret: clientSecret,
                    redirect_uri: redirectURI
                })
            });

            const data = await response.json();

            return {
                accessToken: data.access_token,
                refreshToken: data.refresh_token || null,
                expiresIn: data.expires_in,
                tokenType: data.token_type,
                scope: data.scope
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
            const response = await fetch(`${broker.baseURL}${broker.endpoints.accounts}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json'
                }
            });

            return await response.json();
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
            const response = await fetch(`${broker.baseURL}${broker.endpoints.positions}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Accept': 'application/json'
                }
            });

            return await response.json();
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

            const response = await fetch(
                `${broker.baseURL}${broker.endpoints.orders}`,
                {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept': 'application/json',
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(orderData)
                }
            );

            const data = await response.json();

            return {
                orderId: data.id,
                status: data.status,
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
                fetch(`${broker.baseURL}${broker.endpoints.quotes}${symbol}/`, {
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Accept': 'application/json'
                    }
                }).then(r => r.json())
            );

            const responses = await Promise.all(promises);
            const prices = {};

            responses.forEach((data, index) => {
                prices[symbols[index]] = {
                    price: data.last_price,
                    ask: data.ask_price,
                    bid: data.bid_price,
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
