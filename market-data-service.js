/**
 * Live Market Data Service
 * Pulls real-time prices from CoinGecko and financial APIs
 */

const axios = require('axios');

class MarketDataService {
    constructor() {
        this.stockPrices = {};
        this.cryptoPrices = {};
        this.newsFeeds = [];
        this.updateInterval = 30000; // Update every 30 seconds
    }

    // Get live crypto prices from CoinGecko (free, no auth needed)
    async getCryptoPrices() {
        try {
            const response = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
                params: {
                    ids: 'bitcoin,ethereum,ripple,cardano,solana',
                    vs_currencies: 'usd',
                    include_market_cap: true,
                    include_24hr_vol: true,
                    include_24hr_change: true
                },
                timeout: 5000
            });

            this.cryptoPrices = {
                BTC: {
                    price: response.data.bitcoin?.usd || 0,
                    change24h: response.data.bitcoin?.usd_24h_change || 0,
                    market_cap: response.data.bitcoin?.usd_market_cap || 0
                },
                ETH: {
                    price: response.data.ethereum?.usd || 0,
                    change24h: response.data.ethereum?.usd_24h_change || 0,
                    market_cap: response.data.ethereum?.usd_market_cap || 0
                },
                XRP: {
                    price: response.data.ripple?.usd || 0,
                    change24h: response.data.ripple?.usd_24h_change || 0,
                    market_cap: response.data.ripple?.usd_market_cap || 0
                },
                ADA: {
                    price: response.data.cardano?.usd || 0,
                    change24h: response.data.cardano?.usd_24h_change || 0,
                    market_cap: response.data.cardano?.usd_market_cap || 0
                },
                SOL: {
                    price: response.data.solana?.usd || 0,
                    change24h: response.data.solana?.usd_24h_change || 0,
                    market_cap: response.data.solana?.usd_market_cap || 0
                }
            };

            return this.cryptoPrices;
        } catch (error) {
            console.error('Error fetching crypto prices:', error.message);
            return this.cryptoPrices;
        }
    }

    // Get live stock prices (mock for now - Alpha Vantage requires API key)
    getStockPrices() {
        // Simulated live stock data with realistic fluctuations
        const basePrice = { AAPL: 150, TSLA: 200, GOOGL: 140, MSFT: 380, AMZN: 180 };

        this.stockPrices = {};
        for (const [symbol, price] of Object.entries(basePrice)) {
            const change = (Math.random() - 0.5) * 4; // -2% to +2% fluctuation
            this.stockPrices[symbol] = {
                price: (price + change).toFixed(2),
                change24h: (change / price * 100).toFixed(2),
                high: (price * 1.05).toFixed(2),
                low: (price * 0.95).toFixed(2)
            };
        }
        return this.stockPrices;
    }

    // Get financial news from free news API
    async getFinancialNews() {
        try {
            const response = await axios.get('https://newsapi.org/v2/everything', {
                params: {
                    q: '(cryptocurrency OR trading OR stock market) AND (Bitcoin OR Ethereum OR stocks)',
                    sortBy: 'publishedAt',
                    language: 'en',
                    pageSize: 10,
                    apiKey: process.env.NEWS_API_KEY || 'demo'
                },
                timeout: 5000
            });

            this.newsFeeds = (response.data.articles || []).map(article => ({
                title: article.title,
                description: article.description,
                url: article.url,
                image: article.urlToImage,
                source: article.source.name,
                publishedAt: article.publishedAt,
                sentiment: this.analyzeSentiment(article.title)
            }));

            return this.newsFeeds;
        } catch (error) {
            console.error('Error fetching news:', error.message);
            // Return mock news if API fails
            return this.getMockNews();
        }
    }

    // Mock news for demo
    getMockNews() {
        return [
            {
                title: 'Bitcoin Surges Above $45,000 on Institutional Buying',
                description: 'Major institutional investors entering the market drive Bitcoin price higher',
                source: 'Crypto News Daily',
                sentiment: 'positive',
                publishedAt: new Date().toISOString()
            },
            {
                title: 'Ethereum 2.0 Upgrade Boosts Network Activity',
                description: 'Latest upgrade shows promise for improved scalability',
                source: 'Crypto News Daily',
                sentiment: 'positive',
                publishedAt: new Date(Date.now() - 3600000).toISOString()
            },
            {
                title: 'Market Volatility Continues as Fed Signals Policy Hold',
                description: 'Trading volatility remains high amid macro uncertainty',
                source: 'Market Watch',
                sentiment: 'neutral',
                publishedAt: new Date(Date.now() - 7200000).toISOString()
            }
        ];
    }

    // Simple sentiment analysis
    analyzeSentiment(text) {
        const positive = ['surge', 'rise', 'gain', 'bull', 'up', 'strong', 'rally'];
        const negative = ['fall', 'drop', 'loss', 'bear', 'down', 'weak', 'crash'];

        const textLower = text.toLowerCase();
        const posCount = positive.filter(word => textLower.includes(word)).length;
        const negCount = negative.filter(word => textLower.includes(word)).length;

        if (posCount > negCount) return 'positive';
        if (negCount > posCount) return 'negative';
        return 'neutral';
    }

    // Get all market data
    async getAllMarketData() {
        await this.getCryptoPrices();
        this.getStockPrices();
        // Don't fetch news every time to avoid rate limits

        return {
            stocks: this.stockPrices,
            crypto: this.cryptoPrices,
            timestamp: new Date().toISOString()
        };
    }

    // Start periodic updates
    startUpdates(callback) {
        setInterval(async () => {
            const data = await this.getAllMarketData();
            callback(data);
        }, this.updateInterval);
    }
}

module.exports = new MarketDataService();
