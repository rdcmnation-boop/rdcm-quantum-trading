/**
 * RDCMNATION QUANTUM - SaaS API Endpoints
 * REST API for multi-user platform features
 */

const { QuantumSaaS } = require('./quantum-saas-core');

// Initialize SaaS platform
const quantumSaaS = new QuantumSaaS();

// Middleware to verify token
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  req.token = token;
  next();
}

// ===== AUTH ENDPOINTS =====

function registerRoute(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const result = quantumSaaS.registerUser(email, password);

  // Auto-create paper trading account
  const userPaperAccount = quantumSaaS.createAccount(result.userId, 'paper');

  return res.status(201).json({
    ...result,
    paperTradingAccount: userPaperAccount.account
  });
}

function loginRoute(req, res) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const result = quantumSaaS.loginUser(email, password);

  if (result.status === 'error') {
    return res.status(401).json(result);
  }

  return res.json(result);
}

// ===== ACCOUNT ENDPOINTS =====

function createAccountRoute(req, res) {
  const userId = req.userId; // From token verification
  const { accountType } = req.body;

  if (!accountType) {
    return res.status(400).json({ error: 'Account type required (paper or live)' });
  }

  const result = quantumSaaS.createAccount(userId, accountType);

  if (result.status === 'error') {
    return res.status(400).json(result);
  }

  return res.status(201).json(result);
}

function getAccountsRoute(req, res) {
  const userId = req.userId;
  const user = quantumSaaS.getUser(userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.json({
    status: 'success',
    accounts: user.getAllAccounts()
  });
}

// ===== BROKER ENDPOINTS =====

function connectBrokerRoute(req, res) {
  const userId = req.userId;
  const { brokerType, apiKey, environment } = req.body;

  if (!brokerType || !apiKey) {
    return res.status(400).json({ error: 'Broker type and API key required' });
  }

  const result = quantumSaaS.connectBroker(userId, brokerType, apiKey, environment || 'sandbox');

  if (result.status === 'error') {
    return res.status(400).json(result);
  }

  return res.status(201).json(result);
}

function getBrokersRoute(req, res) {
  const userId = req.userId;
  const user = quantumSaaS.getUser(userId);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  return res.json({
    status: 'success',
    brokers: Object.values(user.brokers)
  });
}

// ===== TRADING ENDPOINTS =====

function executingTradeRoute(req, res) {
  const userId = req.userId;
  const { accountId, signal, symbol, action, quantity, confidence, quantumScore, expectedPrice } = req.body;

  if (!accountId || !signal || !symbol || !quantity) {
    return res.status(400).json({ error: 'Missing required trade fields' });
  }

  const tradeSignal = {
    signal,
    symbol,
    action,
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
}

// ===== AUDIT & MONITORING =====

function getAuditLogRoute(req, res) {
  const userId = req.userId;
  const limit = parseInt(req.query.limit) || 100;

  const auditLog = quantumSaaS.getAuditLog(userId, limit);

  return res.json({
    status: 'success',
    auditLog,
    count: auditLog.length
  });
}

function getAdminDashboardRoute(req, res) {
  // In production, verify user is admin
  const dashboard = quantumSaaS.getAdminDashboard();

  return res.json({
    status: 'success',
    dashboard
  });
}

// ===== SUBSCRIPTION =====

function upgradeSubscriptionRoute(req, res) {
  const userId = req.userId;
  const { tier } = req.body;

  if (!tier || !['free', 'basic', 'pro'].includes(tier)) {
    return res.status(400).json({ error: 'Invalid subscription tier' });
  }

  const result = quantumSaaS.upgradeSubscription(userId, tier);

  if (result.status === 'error') {
    return res.status(400).json(result);
  }

  return res.json(result);
}

// ===== EXPORT ALL ROUTES =====

module.exports = {
  routes: {
    // Auth
    'POST /auth/register': registerRoute,
    'POST /auth/login': loginRoute,

    // Accounts (requires auth)
    'POST /accounts': { middleware: [verifyToken], handler: createAccountRoute },
    'GET /accounts': { middleware: [verifyToken], handler: getAccountsRoute },

    // Brokers (requires auth)
    'POST /brokers/connect': { middleware: [verifyToken], handler: connectBrokerRoute },
    'GET /brokers': { middleware: [verifyToken], handler: getBrokersRoute },

    // Trading (requires auth)
    'POST /trading/execute': { middleware: [verifyToken], handler: executingTradeRoute },

    // Audit & Monitoring (requires auth)
    'GET /audit-log': { middleware: [verifyToken], handler: getAuditLogRoute },
    'GET /admin/dashboard': { middleware: [verifyToken], handler: getAdminDashboardRoute },

    // Subscriptions (requires auth)
    'POST /subscription/upgrade': { middleware: [verifyToken], handler: upgradeSubscriptionRoute }
  },

  quantumSaaS,
  verifyToken
};
