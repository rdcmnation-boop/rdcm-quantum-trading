/**
 * RDCMNATION QUANTUM v3.0 - Trading Platform (Built-in Modules Only)
 * Uses only Node.js built-in modules - no npm dependencies required
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const unifiedBrain = require('./unified-bot-brain');
const marketNewsService = require('./market-news-service');

// Simple .env parser
function loadEnv() {
    const env = {};
    try {
        const envPath = path.join(__dirname, '.env');
        if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            content.split('\n').forEach(line => {
                const [key, value] = line.split('=');
                if (key && value) env[key.trim()] = value.trim();
            });
        }
    } catch (e) {
        console.log('No .env file found, using defaults');
    }
    return env;
}

const envVars = loadEnv();
const PORT = parseInt(envVars.PORT || '3000');
const JWT_SECRET = envVars.JWT_SECRET || 'quantum-secret-key-change-in-production';
const PASSWORD_SALT = envVars.PASSWORD_SALT || 'default-salt';

// ============= UTILITY FUNCTIONS =============
function hashPassword(password) {
    return crypto.createHash('sha256').update(password + PASSWORD_SALT).digest('hex');
}

function verifyPassword(password, hash) {
    return hashPassword(password) === hash;
}

// Minimal JWT implementation
function generateJWT(userId) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64');
    const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })).toString('base64');
    const signature = crypto
        .createHmac('sha256', JWT_SECRET)
        .update(`${header}.${payload}`)
        .digest('base64');
    return `${header}.${payload}.${signature}`;
}

function verifyJWT(token) {
    try {
        const [header, payload, signature] = token.split('.');
        const expectedSig = crypto
            .createHmac('sha256', JWT_SECRET)
            .update(`${header}.${payload}`)
            .digest('base64');
        if (signature !== expectedSig) return null;
        const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
        if (decoded.exp < Date.now()) return null;
        return decoded;
    } catch (e) {
        return null;
    }
}

// ============= IN-MEMORY STORE =============
const store = {
    users: [],
    portfolios: [],
    orders: [],
    brokerTokens: {},
    customBots: [],
    botStrategies: ['AutoRule (Momentum)', 'Quantum AI (ML)', 'Arbitrage Scanner', 'Volatility Trader']
};

let nextUserId = 1, nextOrderId = 1, nextBotId = 1;

// ============= MARKET DATA SERVICE =============
class MarketDataService {
    constructor() {
        this.stockPrices = this.generateStockPrices();
        this.cryptoPrices = {};
    }

    generateStockPrices() {
        const basePrice = {
            AAPL: 150, MSFT: 380, GOOGL: 140, NVDA: 875, AMZN: 180,
            TSLA: 200, JPM: 195, GS: 380, XOM: 115, JNJ: 155
        };

        const stocks = {};
        for (const [symbol, baseP] of Object.entries(basePrice)) {
            const volatility = (Math.random() - 0.5) * 10;
            const priceChange = (volatility / 100) * baseP;
            const currentPrice = baseP + priceChange;
            stocks[symbol] = {
                price: parseFloat(currentPrice.toFixed(2)),
                change24h: parseFloat(volatility.toFixed(2)),
                high: parseFloat((currentPrice * 1.03).toFixed(2)),
                low: parseFloat((currentPrice * 0.97).toFixed(2)),
                volume: Math.floor(Math.random() * 5000000) + 1000000,
                timestamp: new Date().toISOString()
            };
        }
        return stocks;
    }

    getCryptoPrices() {
        return {
            BTC: { price: 42500 + Math.random() * 1000, change24h: 2.5, market_cap: 850000000000 },
            ETH: { price: 2300 + Math.random() * 100, change24h: 1.8, market_cap: 280000000000 },
            XRP: { price: 2.1 + Math.random() * 0.2, change24h: -0.5, market_cap: 110000000000 },
            DOGE: { price: 0.35 + Math.random() * 0.05, change24h: 1.2, market_cap: 50000000000 },
            SOL: { price: 145 + Math.random() * 10, change24h: 3.2, market_cap: 62000000000 }
        };
    }

    getFormattedPrices() {
        const formatted = { stocks: {}, crypto: {} };
        for (const [symbol, data] of Object.entries(this.stockPrices)) {
            formatted.stocks[symbol] = {
                symbol,
                price: `$${data.price.toFixed(2)}`,
                change: data.change24h.toFixed(2),
                indicator: data.change24h > 0 ? '📈' : data.change24h < 0 ? '📉' : '➡️',
                high: `$${data.high}`,
                low: `$${data.low}`,
                volume: data.volume
            };
        }
        this.cryptoPrices = this.getCryptoPrices();
        for (const [symbol, data] of Object.entries(this.cryptoPrices)) {
            formatted.crypto[symbol] = {
                symbol,
                price: `$${data.price.toFixed(2)}`,
                change: data.change24h.toFixed(2),
                indicator: data.change24h > 0 ? '🟢' : data.change24h < 0 ? '🔴' : '⚪',
                marketCap: `$${(data.market_cap / 1e9).toFixed(2)}B`
            };
        }
        return formatted;
    }

    getAllMarketData() {
        return {
            stocks: this.stockPrices,
            crypto: this.cryptoPrices,
            timestamp: new Date().toISOString()
        };
    }
}

const marketService = new MarketDataService();

// ============= SIMPLE HTTP SERVER =============
const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }

    // Parse URL and body
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    let body = '';

    // Collect POST/PUT body
    req.on('data', chunk => { body += chunk; });

    req.on('end', () => {
        try {
            let jsonBody = {};
            if (body && (req.method === 'POST' || req.method === 'PUT')) {
                jsonBody = JSON.parse(body);
            }

            // ============= ROUTES =============

            // Static files
            if (pathname === '/' || pathname === '') {
                const filePath = path.join(__dirname, 'login.html');
                if (fs.existsSync(filePath)) {
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    return res.end(fs.readFileSync(filePath));
                }
            }

            if (pathname.endsWith('.html') || pathname.endsWith('.css') || pathname.endsWith('.js')) {
                const filePath = path.join(__dirname, pathname);
                if (fs.existsSync(filePath)) {
                    const ext = pathname.split('.').pop();
                    const contentType = {
                        'html': 'text/html',
                        'css': 'text/css',
                        'js': 'application/javascript'
                    }[ext] || 'text/plain';
                    res.writeHead(200, { 'Content-Type': contentType });
                    return res.end(fs.readFileSync(filePath));
                }
            }

            // ============= AUTH ENDPOINTS =============
            if (pathname === '/api/auth/register' && req.method === 'POST') {
                const { email, password, full_name } = jsonBody;
                if (!email || !password) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Email and password required' }));
                }
                if (store.users.find(u => u.email === email)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Email already exists' }));
                }
                const userId = nextUserId++;
                const password_hash = hashPassword(password);
                store.users.push({ id: userId, email, password_hash, full_name: full_name || email, created_at: new Date().toISOString() });
                const token = generateJWT(userId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, userId, email, token }));
            }

            if (pathname === '/api/auth/login' && req.method === 'POST') {
                const { email, password } = jsonBody;
                if (!email || !password) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Email and password required' }));
                }
                const user = store.users.find(u => u.email === email);
                if (!user || !verifyPassword(password, user.password_hash)) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Invalid credentials' }));
                }
                const token = generateJWT(user.id);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, userId: user.id, email: user.email, token }));
            }

            // ============= MARKET DATA ENDPOINTS =============
            if (pathname === '/api/market/prices' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    stocks: marketService.stockPrices,
                    crypto: marketService.cryptoPrices,
                    timestamp: new Date().toISOString()
                }));
            }

            if (pathname === '/api/market/formatted-prices' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(marketService.getFormattedPrices()));
            }

            // ============= MARKET NEWS ENDPOINTS =============
            if (pathname === '/api/market/news' && req.method === 'GET') {
                const limit = parseInt(url.searchParams.get('limit')) || 20;
                const news = marketNewsService.getLatestNews(limit);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    articles: news,
                    total: news.length,
                    timestamp: new Date().toISOString()
                }));
            }

            if (pathname === '/api/market/news/summary' && req.method === 'GET') {
                const summary = marketNewsService.getSummary();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(summary));
            }

            if (pathname === '/api/market/news/search' && req.method === 'GET') {
                const query = url.searchParams.get('q');
                if (!query) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Search query required' }));
                }
                const results = marketNewsService.searchNews(query);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    query: query,
                    results: results,
                    count: results.length,
                    timestamp: new Date().toISOString()
                }));
            }

            if (pathname === '/api/market/news/symbol' && req.method === 'GET') {
                const symbol = url.searchParams.get('symbol');
                if (!symbol) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Symbol required' }));
                }
                const news = marketNewsService.getNewsBySymbol(symbol);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    symbol: symbol,
                    articles: news,
                    count: news.length,
                    timestamp: new Date().toISOString()
                }));
            }

            if (pathname === '/api/market/news/sentiment' && req.method === 'GET') {
                const sentiment = marketNewsService.analyzeSentiment();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    sentiment_analysis: sentiment,
                    timestamp: new Date().toISOString()
                }));
            }

            if (pathname === '/api/market/news/high-impact' && req.method === 'GET') {
                const highImpact = marketNewsService.getHighImpactNews();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    articles: highImpact,
                    count: highImpact.length,
                    timestamp: new Date().toISOString()
                }));
            }

            // ============= BOT ENDPOINTS =============
            if (pathname === '/api/bots/status' && req.method === 'GET') {
                const bots = [
                    { id: 1, name: 'AutoRule', status: 'active', winRate: 67, trades: 128, profit: 5420 },
                    { id: 2, name: 'Quantum AI', status: 'active', winRate: 71, trades: 95, profit: 7830 },
                    { id: 3, name: 'Mining Bot', status: 'active', winRate: 85, trades: 42, profit: 3920 },
                    { id: 4, name: 'Bet Brain', status: 'active', winRate: 62, trades: 156, profit: 4210 }
                ];
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ bots, timestamp: new Date().toISOString() }));
            }

            if (pathname === '/api/bots/start' && req.method === 'POST') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, message: 'Bot started', botId: jsonBody.botId }));
            }

            if (pathname === '/api/bots/stop' && req.method === 'POST') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, message: 'Bot stopped', botId: jsonBody.botId }));
            }

            if (pathname === '/api/system/status' && req.method === 'GET') {
                const metrics = unifiedBrain.getAIMetrics();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(metrics));
            }

            // ============= UNIFIED BOT BRAIN ENDPOINTS =============
            if (pathname === '/api/brain/metrics' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(unifiedBrain.getAIMetrics()));
            }

            if (pathname === '/api/brain/bots' && req.method === 'GET') {
                const botsStatus = unifiedBrain.getAllBotsStatus();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ bots: botsStatus, timestamp: new Date().toISOString() }));
            }

            if (pathname === '/api/brain/bot-status' && req.method === 'GET') {
                const botId = url.searchParams.get('botId');
                const status = unifiedBrain.getBotStatus(botId);
                if (!status) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Bot not found' }));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(status));
            }

            if (pathname === '/api/brain/signal' && req.method === 'POST') {
                const { botId, symbol, type, confidence, reason } = jsonBody;
                if (!botId || !symbol || !type) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Missing required fields' }));
                }
                try {
                    const signal = unifiedBrain.generateSignal(botId, symbol, type, confidence || 0.5, reason || '');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, signal }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: e.message }));
                }
            }

            if (pathname === '/api/brain/consensus' && req.method === 'GET') {
                const symbol = url.searchParams.get('symbol');
                if (!symbol) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Symbol required' }));
                }
                const consensus = unifiedBrain.getConsensusSignal(symbol);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(consensus || { error: 'No recent signals' }));
            }

            if (pathname === '/api/brain/trade' && req.method === 'POST') {
                const { symbol, side, quantity, price, botId, reason } = jsonBody;
                if (!symbol || !side || !quantity || !botId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Missing required fields' }));
                }
                try {
                    const trade = unifiedBrain.executeTrade(symbol, side, quantity, price || 0, botId, reason || '');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ success: true, trade }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: e.message }));
                }
            }

            if (pathname === '/api/brain/communications' && req.method === 'GET') {
                const fromBot = url.searchParams.get('from');
                const toBot = url.searchParams.get('to');
                const limit = parseInt(url.searchParams.get('limit')) || 50;
                const log = unifiedBrain.getCommunicationLog(fromBot, toBot, limit);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ communications: log, total: log.length }));
            }

            if (pathname === '/api/brain/train' && req.method === 'POST') {
                const result = unifiedBrain.trainModel();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, trainingResult: result }));
            }

            if (pathname === '/api/brain/reset' && req.method === 'POST') {
                unifiedBrain.resetMetrics();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, message: 'Metrics reset' }));
            }

            if (pathname === '/api/brain/state' && req.method === 'GET') {
                const state = unifiedBrain.exportState();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(state));
            }

            // ============= CUSTOM BOT MANAGEMENT ENDPOINTS =============
            if (pathname === '/api/bots/strategies' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    strategies: store.botStrategies,
                    timestamp: new Date().toISOString()
                }));
            }

            if (pathname === '/api/bots/create' && req.method === 'POST') {
                const { userId, botName, strategy, initialCapital } = jsonBody;
                if (!botName || !strategy || !initialCapital) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Bot name, strategy, and initial capital required' }));
                }
                const botId = `custom-bot-${nextBotId++}`;
                const newBot = {
                    id: botId,
                    userId: userId || 1,
                    name: botName,
                    strategy: strategy,
                    capital: initialCapital,
                    currentValue: initialCapital,
                    winRate: 0.55,
                    tradesExecuted: 0,
                    profitLoss: 0,
                    status: 'active',
                    createdAt: new Date().toISOString(),
                    lastTradeAt: null
                };
                store.customBots.push(newBot);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, bot: newBot }));
            }

            if (pathname === '/api/bots/list' && req.method === 'GET') {
                const userId = url.searchParams.get('userId');
                const bots = userId
                    ? store.customBots.filter(b => b.userId === parseInt(userId))
                    : store.customBots;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    bots: bots,
                    total: bots.length,
                    timestamp: new Date().toISOString()
                }));
            }

            if (pathname === '/api/bots/get' && req.method === 'GET') {
                const botId = url.searchParams.get('botId');
                const bot = store.customBots.find(b => b.id === botId);
                if (!bot) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Bot not found' }));
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(bot));
            }

            if (pathname === '/api/bots/update' && req.method === 'PUT') {
                const { botId, status } = jsonBody;
                const bot = store.customBots.find(b => b.id === botId);
                if (!bot) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Bot not found' }));
                }
                if (status) bot.status = status;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, bot }));
            }

            // ============= SERVER-SENT EVENTS (REAL-TIME STREAMING) =============
            if (pathname === '/api/stream/brain-updates' && req.method === 'GET') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });

                // Send initial data
                res.write(`data: ${JSON.stringify(unifiedBrain.getAIMetrics())}\n\n`);

                // Send updates every 2 seconds
                const interval = setInterval(() => {
                    if (res.writable) {
                        res.write(`data: ${JSON.stringify(unifiedBrain.getAIMetrics())}\n\n`);
                    } else {
                        clearInterval(interval);
                    }
                }, 2000);

                // Cleanup on disconnect
                req.on('close', () => clearInterval(interval));
                return;
            }

            if (pathname === '/api/stream/market-updates' && req.method === 'GET') {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });

                res.write(`data: ${JSON.stringify(marketService.getFormattedPrices())}\n\n`);

                const interval = setInterval(() => {
                    if (res.writable) {
                        marketService.stockPrices = marketService.generateStockPrices();
                        res.write(`data: ${JSON.stringify(marketService.getFormattedPrices())}\n\n`);
                    } else {
                        clearInterval(interval);
                    }
                }, 3000);

                req.on('close', () => clearInterval(interval));
                return;
            }

            // 404
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not found' }));

        } catch (error) {
            console.error('Error:', error);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
        }
    });
});

// ============= STARTUP =============
server.listen(PORT, () => {
    console.log(`🚀 RDCMNATION QUANTUM Trading Platform running on port ${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}/dashboard.html`);
    console.log(`🔐 Login: http://localhost:${PORT}/login.html`);
    console.log(`👨‍💻 Developer Portal: http://localhost:${PORT}/dev.html`);
    console.log(`🤖 Bots Hub: http://localhost:${PORT}/bots-hub.html`);
    console.log(`✅ Platform initialized successfully`);

    // ============= REGISTER EXTERNAL BOT BRAINS =============

    // Register Bet Brain adapter (connects to external service at https://rdcm-bet-brain.onrender.com/)
    try {
        const betBrainAdapter = require('./bots/bet-brain-adapter');
        unifiedBrain.registerExternalBot(
            './bots/bet-brain-adapter.js',
            'external-bet-brain',
            {
                name: 'Bet Brain (External)',
                strategy: 'probability-based-betting',
                version: '2.5.0',
                externalService: 'https://rdcm-bet-brain.onrender.com/',
                isExternal: true
            }
        );
        console.log('✅ External Bet Brain adapter registered successfully');
        console.log('🌐 Connected to: https://rdcm-bet-brain.onrender.com/');
    } catch (error) {
        console.warn('⚠️ Could not register Bet Brain adapter:', error.message);
    }

    console.log('\n📈 Trading System initialized:');
    const metrics = unifiedBrain.getAIMetrics();
    console.log(`   • Bots Connected: ${metrics.botsConnected}/5`);
    console.log(`   • Market Data Streams: 15 (10 crypto + 5 stocks)`);
    console.log(`   • Learning Rate: ${metrics.learningRate}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    server.close(() => process.exit(0));
});

module.exports = server;
