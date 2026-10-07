# RDCMNATION QUANTUM - Deployment Guide

**Deploy Phase 2 Validation + Phase 3 Intelligence to Render.com**

---

## Quick Start: Deploy to Render in 5 Minutes

### Step 1: Connect GitHub Repository
1. Go to [render.com](https://render.com)
2. Sign in (or create account)
3. Click "New +" → "Web Service"
4. Connect your GitHub repository (rdcm-quantum-trading)
5. Select `main` branch

### Step 2: Configure Deployment
The `render.yaml` file in the repo contains all settings. Render will auto-detect it.

**Or manually configure:**
- **Name:** `quantum-validation`
- **Environment:** Docker
- **Region:** Oregon (or your preference)
- **Plan:** Standard ($7/month base)
- **Auto-deploy:** ✅ Enabled

### Step 3: Set Environment Variables
In Render dashboard → Environment:

```
NODE_ENV=production
QUANTUM_MODE=VALIDATION
PHASE2_CYCLES=10000
PHASE2_FAST=true
PHASE3_ENABLED=true
LOG_LEVEL=info
```

See `.env.example` for all available variables.

### Step 4: Deploy
Click "Deploy" → Render builds Docker image and starts QUANTUM

**Deployment time:** ~2-3 minutes  
**Status:** Check "Logs" tab in Render dashboard

---

## What Gets Deployed

### Phase 2: Foundation (Running)
- Risk Engine - Validates every trade decision
- Market Snapshots - Captures 50+ data points
- Explainability Engine - QUANTUM SCORE generation
- Execution Modes - SHADOW (paper), LIVE, SIMULATION
- Health Check - Service monitoring
- Service Recovery - Graceful failure handling
- Validation Harness - Orchestrates continuous testing

### Phase 3: Intelligence (Running)
- Performance Attribution Engine - Analyzes why trades win/lose
- Strategy Router - Selects best strategy per regime
- Correlation Engine - Detects hidden portfolio risks
- Phase 3 Orchestrator - Coordinates all systems

### Continuous Operation
- **Cycles:** 10,000 per deployment (can increase)
- **Duration:** ~2 minutes per run
- **Output:** Reports saved to `/reports` disk
- **Auto-restart:** Enabled if service crashes

---

## Monitoring & Logs

### View Logs
**In Render Dashboard:**
1. Go to your service
2. Click "Logs" tab
3. See real-time output from validation harness

**Example output:**
```
🚀 RDCMNATION QUANTUM - Phase 2 Validation Harness
📊 Running 10000 cycles...
💰 Account Balance: $100000
📈 Symbols: NVDA, AAPL, SPY, QQQ, TSLA
🔄 Mode: SHADOW (paper trading, no broker calls)
```

### Health Checks
Render automatically checks service health every 30 seconds. 
Service restarts automatically if unhealthy.

### Access Reports
Reports are saved to persistent disk at `/app/reports`:
```
validation-2026-10-07T15-30-00.json
validation-2026-10-07T16-45-00.json
... (one per cycle run)
```

Download via Render dashboard → Files.

---

## Scaling Configuration

### Start: Small
- **Plan:** Standard ($7/month)
- **Instances:** 1
- **Cycles:** 10,000
- **Memory:** 512 MB

After validation proves stability (30+ days):

### Scale: Medium
- **Plan:** Pro ($12/month)
- **Instances:** 2 (redundancy)
- **Cycles:** 100,000 (longer validation runs)
- **Memory:** 1 GB

Update in `render.yaml`:
```yaml
scaling:
  minInstances: 2
  maxInstances: 2
```

Then redeploy.

---

## Accessing Reports & Data

### Via Render Dashboard
1. Your service → "Disks" tab
2. Mount points:
   - `/app/reports` (10 GB) - Validation reports
   - `/app/logs` (5 GB) - System logs

### Download Reports
```bash
# View report filenames
ls -la /app/reports/

# Download latest report (from your terminal)
scp render:/app/reports/validation-*.json ./
```

### Analyze Reports
Each report contains:
- Portfolio performance metrics
- Trading activity (executed/blocked trades)
- Risk management data
- All 7 validation checkpoints
- Decision and trade history

Use for:
- ✅ Verify system is working
- ✅ Analyze performance trends
- ✅ Feed data to Phase 3 learning systems
- ✅ Compliance documentation

---

## Troubleshooting

### Service Won't Start
**Error:** "Build failed" or "Container won't start"

**Solutions:**
1. Check `Logs` tab - shows build/startup errors
2. Verify `package.json` dependencies are installed locally
3. Ensure `Dockerfile` exists in repo root
4. Try manual rebuild in Render dashboard

### High Memory Usage
**Error:** "Out of memory" crashes

**Solutions:**
1. Reduce `PHASE2_CYCLES` in environment variables
2. Upgrade to Pro plan (1 GB → 2 GB memory)
3. Enable garbage collection: `NODE_OPTIONS=--max-old-space-size=1024`

### Slow Deployment
**Issue:** Takes >5 minutes to deploy

**Solutions:**
1. Normal first time (includes npm install)
2. Subsequent deploys faster (~30 seconds)
3. Check if building large dependencies

### Reports Not Saving
**Error:** Can't access reports in `/app/reports`

**Solutions:**
1. Check disk mount is enabled in Render dashboard
2. Verify service has write permissions
3. Check available disk space (10 GB limit)

---

## Advanced: Enable Live Trading

⚠️ **Only after 30+ days of validation!**

### Step 1: Broker Integration
Set environment variables:
```
BROKER_TYPE=robinhood  # or alpaca, etc
BROKER_API_KEY=xxx
BROKER_API_SECRET=xxx
```

### Step 2: Switch Mode
```
QUANTUM_MODE=LIVE  # ← Changes from VALIDATION
```

### Step 3: Start Small
```
INITIAL_BALANCE=1000  # Start with small capital
```

### Step 4: Monitor
- Watch logs continuously
- Check reports every cycle
- Set up Slack alerts for anomalies
- Be ready to kill switch

### Kill Switch
If anything goes wrong:
```bash
QUANTUM_MODE=SHADOW  # Revert to paper trading
# OR
# Stop service in Render dashboard
```

---

## Costs

### Monthly Estimate
| Item | Cost |
|------|------|
| Render Web Service (Standard) | $7 |
| Disk Storage (10 GB reports) | $2 |
| Disk Storage (5 GB logs) | $1 |
| **Total** | **~$10/month** |

Scales up only if you upgrade plan or add instances.

---

## Next Steps

1. **Deploy now:** Push `main` branch with deployment files
2. **Watch validation:** Check logs in Render dashboard
3. **Analyze reports:** Download after first cycle
4. **Monitor for 30+ days:** Ensure continuous stability
5. **Then consider:** Live trading (if validation passes)

---

## Files for Deployment

```
/
├── Dockerfile              ← Docker container config
├── render.yaml            ← Render deployment config
├── .env.example           ← Environment variables template
├── DEPLOYMENT_GUIDE.md    ← This file
├── package.json           ← Node dependencies
├── harness/               ← Validation harness
├── services/              ← Phase 2 + Phase 3 systems
└── ... (rest of code)
```

All files needed are in the repo. Just push and deploy!

---

## Getting Help

**Render Support:** https://render.com/support  
**QUANTUM Docs:** See `START_HERE.md`, `PHASE_2_COMPLETE_SUMMARY.md`, `PHASE_3_INTELLIGENCE_SYSTEMS.md`  
**Issue Tracker:** Check your repo issues/discussions

---

**Ready? Push to GitHub and deploy to Render!** 🚀
