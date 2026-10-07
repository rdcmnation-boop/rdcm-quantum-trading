/**
 * RDCMNATION QUANTUM - SaaS Integration
 * Integrates SaaS features into Express app
 */

const jwt = require('jsonwebtoken');

class QuantumSaaSIntegration {
  constructor(app, jwtSecret) {
    this.app = app;
    this.jwtSecret = jwtSecret;
    this.setupRoutes();
  }

  setupRoutes() {
    const { routes, quantumSaaS, verifyToken } = require('./quantum-saas-api');

    // ===== AUTH ENDPOINTS (No auth required) =====

    this.app.post('/api/auth/register', (req, res) => {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }

      // Check if user exists
      const user = Object.values(quantumSaaS.users).find(u => u.email === email);
      if (user) {
        return res.status(409).json({ error: 'User already exists' });
      }

      const result = quantumSaaS.registerUser(email, password);

      // Auto-create paper trading account
      const paperAccount = quantumSaaS.createAccount(result.userId, 'paper');

      // Generate JWT token
      const token = jwt.sign(
        { userId: result.userId, email },
        this.jwtSecret,
        { expiresIn: '7d' }
      );

      return res.status(201).json({
        ...result,
        token,
        paperTradingAccount: paperAccount.account?.accountId
      });
    });

    this.app.post('/api/auth/login', (req, res) => {
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
      }

      const result = quantumSaaS.loginUser(email, password);

      if (result.status === 'error') {
        return res.status(401).json(result);
      }

      // Generate JWT token from userId
      const token = jwt.sign(
        { userId: result.token, email }, // Using result.token as userId
        this.jwtSecret,
        { expiresIn: '7d' }
      );

      return res.json({
        status: 'success',
        token,
        userId: result.token,
        email
      });
    });

    // ===== PROTECTED ROUTES (Auth required) =====

    // Middleware to verify JWT token
    const authMiddleware = (req, res, next) => {
      const token = req.headers.authorization?.split(' ')[1];

      if (!token) {
        return res.status(401).json({ error: 'Missing authorization token' });
      }

      try {
        const decoded = jwt.verify(token, this.jwtSecret);
        req.userId = decoded.userId;
        req.email = decoded.email;
        next();
      } catch (error) {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
    };

    // ===== ACCOUNT MANAGEMENT =====

    this.app.post('/api/accounts', authMiddleware, (req, res) => {
      const userId = req.userId;
      const { accountType } = req.body;

      if (!accountType || !['paper', 'live'].includes(accountType)) {
        return res.status(400).json({ error: 'Account type must be "paper" or "live"' });
      }

      const result = quantumSaaS.createAccount(userId, accountType);

      if (result.status === 'error') {
        return res.status(400).json(result);
      }

      return res.status(201).json(result);
    });

    this.app.get('/api/accounts', authMiddleware, (req, res) => {
      const userId = req.userId;
      const user = quantumSaaS.getUser(userId);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.json({
        status: 'success',
        accounts: user.getAllAccounts().map(acc => ({
          accountId: acc.accountId,
          type: acc.type,
          balance: acc.balance,
          dailyPL: acc.dailyPL,
          totalPL: acc.totalPL,
          tradesCount: acc.trades.length,
          tradingEnabled: acc.tradingEnabled,
          createdAt: acc.createdAt
        }))
      });
    });

    // ===== BROKER MANAGEMENT =====

    this.app.post('/api/brokers/connect', authMiddleware, (req, res) => {
      const userId = req.userId;
      const { brokerType, apiKey, environment } = req.body;

      if (!brokerType || !apiKey) {
        return res.status(400).json({ error: 'Broker type and API key required' });
      }

      if (!['robinhood', 'coinbase', 'td', 'ibkr'].includes(brokerType)) {
        return res.status(400).json({ error: 'Unsupported broker type' });
      }

      const result = quantumSaaS.connectBroker(userId, brokerType, apiKey, environment || 'sandbox');

      if (result.status === 'error') {
        return res.status(400).json(result);
      }

      return res.status(201).json(result);
    });

    this.app.get('/api/brokers', authMiddleware, (req, res) => {
      const userId = req.userId;
      const user = quantumSaaS.getUser(userId);

      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      return res.json({
        status: 'success',
        brokers: Object.values(user.brokers).map(b => ({
          brokerId: b.brokerId,
          type: b.type,
          environment: b.environment,
          status: b.status,
          connectedAt: b.connectedAt,
          permissions: b.permissions
        }))
      });
    });

    // ===== TRADING EXECUTION =====

    this.app.post('/api/trading/execute', authMiddleware, (req, res) => {
      const userId = req.userId;
      const { accountId, signal, symbol, action, quantity, confidence, quantumScore, expectedPrice } = req.body;

      if (!accountId || !signal || !symbol || !quantity) {
        return res.status(400).json({ error: 'Missing required trade fields' });
      }

      const tradeSignal = {
        signal,
        symbol,
        action: action || 'BUY',
        quantity: parseInt(quantity),
        confidence: parseFloat(confidence) || 0.5,
        quantumScore: parseFloat(quantumScore) || 75,
        expectedPrice: parseFloat(expectedPrice) || 100
      };

      const result = quantumSaaS.executeTrade(userId, accountId, tradeSignal);

      if (result.status === 'blocked') {
        return res.status(403).json(result);
      }

      if (result.status === 'error') {
        return res.status(400).json(result);
      }

      return res.status(200).json(result);
    });

    // ===== AUDIT & MONITORING =====

    this.app.get('/api/audit-log', authMiddleware, (req, res) => {
      const userId = req.userId;
      const limit = parseInt(req.query.limit) || 50;

      const auditLog = quantumSaaS.getAuditLog(userId, limit);

      return res.json({
        status: 'success',
        auditLog,
        count: auditLog.length,
        user: req.email
      });
    });

    this.app.get('/api/admin/dashboard', authMiddleware, (req, res) => {
      // In production, verify user is admin
      const dashboard = quantumSaaS.getAdminDashboard();

      return res.json({
        status: 'success',
        dashboard,
        timestamp: new Date().toISOString()
      });
    });

    // ===== SUBSCRIPTION MANAGEMENT =====

    this.app.post('/api/subscription/upgrade', authMiddleware, (req, res) => {
      const userId = req.userId;
      const { tier } = req.body;

      if (!tier || !['free', 'basic', 'pro'].includes(tier)) {
        return res.status(400).json({ error: 'Invalid subscription tier: free, basic, or pro' });
      }

      const result = quantumSaaS.upgradeSubscription(userId, tier);

      if (result.status === 'error') {
        return res.status(400).json(result);
      }

      return res.json(result);
    });

    // ===== QUANTUM SCORE ENDPOINT (Public) =====

    this.app.get('/api/quantum-score', (req, res) => {
      // Example endpoint showing QUANTUM SCORE calculation
      const { symbol, momentum, trend, volume, volatility, liquidity, agreement, risk } = req.query;

      const score = this.calculateQuantumScore({
        momentum: parseFloat(momentum) || 0.5,
        trend: parseFloat(trend) || 0.5,
        volume: parseFloat(volume) || 0.5,
        volatility: parseFloat(volatility) || 0.5,
        liquidity: parseFloat(liquidity) || 0.5,
        agreement: parseFloat(agreement) || 0.5,
        risk: parseFloat(risk) || 0.5
      });

      const riskLevel = score >= 80 ? '🟢 STRONG' : score >= 60 ? '🟡 WATCH' : '🔴 AVOID';

      return res.json({
        symbol: symbol || 'AAPL',
        quantumScore: score,
        riskLevel,
        components: {
          momentum: parseFloat(momentum) || 0.5,
          trend: parseFloat(trend) || 0.5,
          volume: parseFloat(volume) || 0.5,
          volatility: parseFloat(volatility) || 0.5,
          liquidity: parseFloat(liquidity) || 0.5,
          strategiesAgreeing: Math.round(parseFloat(agreement) * 6 || 3),
          riskScore: parseFloat(risk) || 0.5
        }
      });
    });

    console.log('✅ RDCMNATION QUANTUM SaaS Platform initialized');
    console.log('   - User authentication enabled');
    console.log('   - Paper + Live trading accounts');
    console.log('   - Multi-broker support');
    console.log('   - Complete audit trails');
    console.log('   - Admin dashboard');
  }

  calculateQuantumScore(factors) {
    // Weighted calculation of QUANTUM SCORE
    const weights = {
      momentum: 0.20,
      trend: 0.20,
      volume: 0.15,
      volatility: 0.10,
      liquidity: 0.15,
      agreement: 0.15,
      risk: 0.05
    };

    let score = 0;
    for (const [factor, weight] of Object.entries(weights)) {
      score += (factors[factor] || 0.5) * weight * 100;
    }

    return Math.min(100, Math.max(0, Math.round(score)));
  }
}

module.exports = QuantumSaaSIntegration;
