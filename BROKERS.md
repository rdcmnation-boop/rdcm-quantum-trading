# Broker Integrations

The RDCMNATION Quantum Trading Platform supports real trading execution through multiple broker APIs.

## Available Brokers

### 1. Robinhood (Crypto & Stocks)
**Status:** Ready for integration  
**API Docs:** https://docs.robinhood.com/crypto/trading/

#### Setup
1. Go to: https://robinhood.com/account/crypto
2. Generate API credentials
3. Set environment variable:
   ```bash
   export ROBINHOOD_AUTH_TOKEN="your-auth-token"
   ```

#### Features
- ✅ Crypto trading (BTC, ETH, etc.)
- ✅ Stock trading  
- ✅ Real-time account balances
- ✅ Order execution and tracking
- ✅ Position management

#### Usage
```javascript
const robinhood = require('./bots/robinhood-adapter');

// Check connection
console.log(robinhood.getStatus());

// Execute trade
await robinhood.executeTrade('BTC', 'buy', 0.1);

// Get prices
const prices = await robinhood.getCryptoPrices(['BTC', 'ETH']);
```

---

### 2. Coinbase (Advanced Trading)
**Status:** Ready for integration  
**API Docs:** https://docs.cloud.coinbase.com/

#### Setup
1. Go to: https://www.coinbase.com/settings/api
2. Create API key with trading permissions
3. Set environment variables:
   ```bash
   export COINBASE_API_KEY="your-api-key"
   export COINBASE_API_SECRET="your-api-secret"
   export COINBASE_PASSPHRASE="your-passphrase"
   ```

#### Features
- ✅ Cryptocurrency trading (BTC, ETH, etc.)
- ✅ Market and limit orders
- ✅ Portfolio management
- ✅ Real-time price feeds
- ✅ Advanced authentication (CB-ACCESS-SIGN)

#### Usage
```javascript
const coinbase = require('./bots/coinbase-adapter');

// Check connection
console.log(coinbase.getStatus());

// Execute trade
await coinbase.executeTrade('BTC', 'buy', 100); // $100 worth

// Get prices
const prices = await coinbase.getCryptoPrices(['BTC', 'ETH']);
```

---

## Broker Manager

Unified interface for managing multiple brokers with automatic fallback:

```javascript
const brokerManager = require('./bots/broker-manager');

// Register brokers
brokerManager.registerBroker('robinhood', robinhood);
brokerManager.registerBroker('coinbase', coinbase);

// Execute trade (uses best available broker)
await brokerManager.executeTrade('BTC', 'buy', 0.1);

// Execute on specific broker
await brokerManager.executeTrade('BTC', 'buy', 0.1, 'coinbase');

// Get connected brokers
console.log(brokerManager.getConnectedBrokers());

// Get broker status
console.log(brokerManager.getBrokerStatus());

// Get recent trades across all brokers
console.log(brokerManager.getRecentTrades(20));
```

---

## Fallback Strategy

The platform automatically falls back to alternative brokers if:
- Primary broker connection fails
- Trade execution fails
- Network timeout occurs

**Priority Order:**
1. Robinhood (primary)
2. Coinbase (secondary)

---

## Integration with Quantum Platform

The bot consensus system can now execute real trades:

1. **6-Bot Consensus** votes on trade decision
2. **Security Bot** validates the trade
3. **Broker Manager** routes to best available broker
4. **Robinhood/Coinbase** executes the real trade
5. **Activity Logger** records the execution

```
Bot Consensus → Security Validation → Broker Selection → Trade Execution
                                            ↓
                                    Robinhood (Primary)
                                    or Coinbase (Fallback)
```

---

## Environment Setup

Create a `.env` file:

```env
# Robinhood
ROBINHOOD_AUTH_TOKEN=your-auth-token

# Coinbase
COINBASE_API_KEY=your-api-key
COINBASE_API_SECRET=your-api-secret
COINBASE_PASSPHRASE=your-passphrase

# Platform
NODE_ENV=production
PORT=3000
JWT_SECRET=your-jwt-secret
```

Then start the platform:
```bash
node app-builtin.js
```

---

## Security Notes

- ✅ API keys are only stored in environment variables (not in code)
- ✅ All requests use HTTPS
- ✅ Coinbase uses HMAC-SHA256 signing for authentication
- ✅ Trade validation happens before execution
- ✅ Full audit trail logged for all trades

---

## Testing

### Test Robinhood Connection
```bash
curl -X GET http://localhost:3000/api/brokers/status
```

### Test Coinbase Connection  
```bash
curl -X GET http://localhost:3000/api/brokers/status
```

### Execute Test Trade (Paper Trading)
```bash
curl -X POST http://localhost:3000/api/brokers/trade \
  -H "Content-Type: application/json" \
  -d '{"symbol":"BTC","side":"buy","quantity":0.01,"broker":"coinbase"}'
```

---

## Next Steps

1. Get Robinhood credentials from: https://robinhood.com/account/crypto
2. Get Coinbase credentials from: https://www.coinbase.com/settings/api
3. Set environment variables
4. Restart platform: `node app-builtin.js`
5. Check broker status in dashboard
6. Enable real trading execution

**Status:** 🟡 Ready for credential setup
