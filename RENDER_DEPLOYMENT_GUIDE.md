# 🚀 Render Deployment Guide - RDCMNATION Quantum Trading

## Quick Start - Deploy to Render in 5 Minutes

### Prerequisites
- GitHub account with repo: `https://github.com/rdcmnation-boop/rdcm-quantum-trading`
- Render account: `https://render.com/`
- Active Robinhood API credentials (stored in `.env`)

---

## Step 1: Create New Web Service on Render

1. Go to https://render.com/ and log in
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub account if not already connected
4. Select: `rdcm-quantum-trading` repository
5. Configure:
   - **Name:** `rdcm-quantum-trading` (or your preferred name)
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** `Pro` (recommended for real trading) or `Free` (for testing)

---

## Step 2: Set Environment Variables

In Render dashboard, go to **Environment** tab and add these variables:

| Variable | Value | Notes |
|----------|-------|-------|
| `NODE_ENV` | `production` | Required |
| `PORT` | `3000` | Default, Render auto-assigns |
| `ROBINHOOD_AUTH_TOKEN` | `rh-api-5be5abde-56f2-4017-8f34-11a51d5df266` | From .env |
| `ROBINHOOD_PRIVATE_KEY` | (paste full RSA key) | From .env |
| `ROBINHOOD_API_SECRET` | `EiqOecq8u0eGLr6sIETZ/sRe+ta25ArLZmoM/oRk3gQ=` | From .env |
| `JWT_SECRET` | (from .env) | Keep secure |
| `PASSWORD_SALT` | (from .env) | Keep secure |
| `BET_BRAIN_URL` | `https://rdcm-bet-brain.onrender.com` | Existing service |

**⚠️ SECURITY WARNING:** 
- These are real trading credentials
- Never commit `.env` to git
- Use Render's environment variables for secrets
- Consider rotating credentials periodically

---

## Step 3: Deploy

1. Click **"Create Web Service"**
2. Render will:
   - Clone the repository
   - Install dependencies (`npm install`)
   - Start the application (`npm start`)
   - Deploy to live URL

3. Monitor deployment in **Logs** tab
4. Once deployed, you'll get a URL like: `https://rdcm-quantum-trading-xxxxx.onrender.com`

---

## Step 4: Verify Deployment

Test your live platform:

```bash
# Check health
curl https://rdcm-quantum-trading-xxxxx.onrender.com/api/health

# Expected response:
# {
#   "status": "ok",
#   "platform": "RDCMNATION Quantum Trading v3.0",
#   "timestamp": "2026-10-07T00:00:00Z"
# }
```

Access the dashboard:
```
https://rdcm-quantum-trading-xxxxx.onrender.com/dashboard.html
```

---

## Step 5: Start Real Trading

Once deployed, your platform will:

✅ **Run 6 AI trading bots** in consensus
- AutoRule (Momentum)
- Quantum AI (ML-based)
- Mining Bot (Arbitrage)
- Bet Brain (Probability)
- Security Guard (Risk Management)
- External Bet Brain (Remote Consensus)

✅ **Execute real orders** on Robinhood
- Using real API credentials
- Market orders with 10-second execution cycle
- Risk-managed by Security Bot

✅ **Monitor 15 market feeds**
- 10 crypto (BTC, ETH, etc.)
- 5 stocks (AAPL, GOOGL, MSFT, TSLA, AMZN)

✅ **Live API endpoints**
- `/api/bots/status` - Real-time bot metrics
- `/api/trades/history` - Execution history
- `/dashboard.html` - Live web dashboard

---

## Troubleshooting

### Build Fails
```
Error: Cannot find module 'express'
```
→ Solution: Ensure `npm install` completes. Check `package.json` exists.

### Application Won't Start
```
Error: ENOENT: no such file or directory, open '.env'
```
→ Solution: Set all environment variables in Render dashboard (don't rely on .env file)

### Robinhood API Errors
```
⚠️ Robinhood API error: 401 - Unauthorized
```
→ Solution: Verify `ROBINHOOD_AUTH_TOKEN` is correct and not expired. Test locally first.

### Dashboard Shows No Data
```
API returned 403
```
→ Solution: Check Bet Brain service is accessible at `BET_BRAIN_URL`. Bots fall back to standalone mode.

---

## Monitoring & Maintenance

### View Live Logs
```bash
# In Render dashboard, click service → "Logs" tab
# Real-time output:
# 🚀 RDCMNATION QUANTUM Trading Platform running on port 3000
# 📈 Trading System initialized: Bots Connected: 6/6
# 📤 Executing REAL trade on Robinhood: BUY 4 AAPL
# 💹 Trade Executed: BUY AAPL | Confidence: 0.66 | P&L: $0.00
```

### Auto-Restart on Failure
- Render automatically restarts services if they crash
- Monitor health endpoint for stability

### Scale Up for Volume
- Upgrade from Free to Pro plan for:
  - Persistent storage (if database features added)
  - More stable uptime
  - Higher API rate limits

---

## Production Checklist

- ✅ Environment variables set in Render (not .env)
- ✅ Robinhood API token valid and has trading permissions
- ✅ Bet Brain service accessible and running
- ✅ Node version ≥16 (Render default compatible)
- ✅ npm dependencies installable
- ✅ Health endpoint responding: `/api/health`
- ✅ Live logs show "✅ Platform initialized successfully"
- ✅ Bots are active: "Bots Connected: 6/6"
- ✅ Real trades executing: "Executing REAL trade on Robinhood"

---

## Next Steps

After deployment:
1. **Monitor** live trading via `/dashboard.html`
2. **Verify** real trades in Robinhood account
3. **Adjust** bot strategies via bot settings
4. **Scale** to additional brokers (Coinbase, etc.)
5. **Optimize** based on live performance metrics

---

## Support

For issues or questions:
- Check `/api/health` endpoint
- Review Render logs for error messages
- Verify all environment variables are set
- Test locally with `node app-builtin.js`

---

**Status:** Ready for live cloud deployment ✅
**Version:** RDCMNATION Quantum v3.0
**Real Trading:** Enabled with Robinhood API
**Last Updated:** 2026-10-07
