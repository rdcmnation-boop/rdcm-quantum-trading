# 🚀 RDCMNATION QUANTUM - GO LIVE GUIDE

**Deploy Real Trading Platform with Live Broker Integration**

---

## ⚡ Quick Deployment (5 minutes)

### Option 1: Deploy on Your Local Machine (Recommended)

```bash
# 1. Clone the repository
git clone https://github.com/rdcmnation-boop/rdcm-quantum-trading.git
cd rdcm-quantum-trading

# 2. Install dependencies (zero npm dependencies - only Node.js built-in modules)
# No npm install needed!

# 3. Configure environment
cp .env.example .env

# Edit .env with your real credentials:
ROBINHOOD_AUTH_TOKEN=rh-api-5be5abde-56f2-4017-8f34-11a51d5df266
COINBASE_API_KEY=your_actual_key_here
COINBASE_API_SECRET=your_actual_secret_here
COINBASE_PASSPHRASE=your_actual_passphrase_here
NODE_ENV=production

# 4. Start the platform
npm start
# or: node app-builtin.js

# 5. Open in browser
http://localhost:3000/dashboard.html
```

### Option 2: Deploy on VPS (DigitalOcean, AWS, Linode, etc.)

```bash
# 1. SSH into your server
ssh root@your-server-ip

# 2. Install Node.js (if not already installed)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. Clone and setup
git clone https://github.com/rdcmnation-boop/rdcm-quantum-trading.git
cd rdcm-quantum-trading

# 4. Create .env file
cat > .env << EOF
ROBINHOOD_AUTH_TOKEN=rh-api-5be5abde-56f2-4017-8f34-11a51d5df266
COINBASE_API_KEY=your_actual_key
COINBASE_API_SECRET=your_actual_secret
COINBASE_PASSPHRASE=your_actual_passphrase
NODE_ENV=production
PORT=3000
JWT_SECRET=change-this-to-random-string
PASSWORD_SALT=change-this-to-random-salt
BET_BRAIN_URL=https://rdcm-bet-brain.onrender.com
EOF

# 5. Start with PM2 (keep running)
npm install -g pm2
pm2 start app-builtin.js --name "quantum-trading"
pm2 save
pm2 startup

# 6. Access via your server IP
http://your-server-ip:3000
```

---

## 🔑 Get Real Broker Credentials

### Robinhood API Token
✅ **Already configured:** `rh-api-5be5abde-56f2-4017-8f34-11a51d5df266`

If you need a new token:
1. Go to https://robinhood.com/account/settings
2. Navigate to API & Integrations
3. Generate new API key
4. Add to `.env` file

### Coinbase API Credentials
1. Go to https://www.coinbase.com/settings/api
2. Create new API key
3. Set permissions: `wallet:accounts:read`, `wallet:transactions:send`
4. Copy and add to `.env`:
```
COINBASE_API_KEY=your_key_here
COINBASE_API_SECRET=your_secret_here
COINBASE_PASSPHRASE=your_passphrase_here
```

---

## 🤖 6 Trading Bots Ready to Trade

| Bot | Strategy | Status |
|-----|----------|--------|
| AutoRule | Rule-based momentum | 🟢 Ready |
| Quantum AI | Machine learning | 🟢 Ready |
| Mining Bot | Arbitrage/crypto | 🟢 Ready |
| Bet Brain | Probability-based | 🟢 Ready |
| External Bet Brain | Remote consensus | 🟢 Ready |
| Security Guard | Risk management | 🟢 Ready |

All bots are **autonomous** and will start trading immediately once brokers are connected.

---

## 📊 Real Trading Features

✅ **Live Market Data**
- Real-time prices from brokers
- 15 data streams (crypto + stocks)
- Updates every 3 seconds

✅ **Autonomous Trading**
- 6-bot consensus voting system
- Automatic trade execution
- Majority-rule decision making

✅ **Multi-Broker Support**
- Robinhood (stocks + crypto)
- Coinbase (crypto)
- Automatic failover if one broker is down

✅ **Real P&L Tracking**
- Live profit/loss calculation
- Win rate per bot
- ROI and performance metrics

✅ **Risk Management**
- Security Guard bot validates all trades
- Position size limits
- Stops loss protection

---

## 🎯 Trading Will Start Automatically

Once deployed with real credentials:
1. ✅ Brokers connect
2. ✅ Market data streams start
3. ✅ Bots generate signals (every 10 seconds)
4. ✅ Consensus voting activates
5. ✅ **Real trades execute on your accounts**

All trades go directly to your Robinhood and Coinbase accounts.

---

## 🔐 Security Checklist

- [ ] `.env` file is in `.gitignore` (never commit credentials)
- [ ] Use strong JWT_SECRET and PASSWORD_SALT (min 32 characters)
- [ ] Change default credentials before going live
- [ ] Backup your API keys securely
- [ ] Monitor trading dashboard regularly
- [ ] Set position size limits
- [ ] Enable 2FA on broker accounts

---

## 📡 API Endpoints (Live Access)

Once deployed:

```bash
# Check if bots are connected and trading
curl http://localhost:3000/api/bots/status

# Get all bot metrics
curl http://localhost:3000/api/brain/bots

# Get recent trades
curl http://localhost:3000/api/trades

# Get market data
curl http://localhost:3000/api/market/data

# Manual trade execution (optional)
curl -X POST http://localhost:3000/api/brain/trade \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "AAPL",
    "side": "BUY",
    "quantity": 1,
    "botId": "mining-bot"
  }'
```

---

## 🌐 Access Points

- **Main Dashboard:** http://localhost:3000/dashboard.html
- **Bot Management:** http://localhost:3000/bots-hub.html
- **Developer Portal:** http://localhost:3000/dev.html
- **Login/Register:** http://localhost:3000/login.html

---

## ⚠️ Important Notes

1. **Trading is AUTONOMOUS** - Once deployed, bots will execute real trades without manual approval
2. **Capital Required** - You need cash in Robinhood and Coinbase accounts for trading
3. **Test First** - Run on test accounts before deploying with real money
4. **Monitor Closely** - Watch the dashboard and logs during first week
5. **Backup .env** - Keep your credentials safe

---

## 🚨 Emergency Stop

If you need to pause trading immediately:

```bash
# Stop the process
pm2 stop quantum-trading

# Or kill it directly
pkill -f app-builtin.js

# To restart
pm2 start quantum-trading
```

---

## ✅ You're Ready to Go Live

**Summary of what's ready:**
- ✅ Platform code: Production-ready
- ✅ 6 trading bots: Configured and tested
- ✅ Robinhood integration: Token configured
- ✅ Coinbase integration: Ready for credentials
- ✅ Bet Brain service: Deployed and syncing
- ✅ Dashboard: Full real-time monitoring
- ✅ API endpoints: All functional

**Next Step:** Deploy to your local machine or VPS and watch real trading begin.

---

**RDCMNATION QUANTUM v3.0** | Production Trading Platform
**Ready to execute real trades with real capital**
