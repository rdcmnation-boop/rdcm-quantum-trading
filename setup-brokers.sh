#!/bin/bash

echo "🔌 RDCMNATION Quantum Trading - Broker Setup"
echo "============================================"
echo ""

# Create .env file if it doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env
    echo "✅ Created .env from template"
else
    echo "ℹ️  .env already exists"
fi

echo ""
echo "📝 STEP 1: Robinhood Setup"
echo "========================="
echo "1. Open: https://robinhood.com/account/crypto"
echo "2. Generate API auth token"
echo "3. Copy the token and paste below:"
echo ""
read -p "Enter ROBINHOOD_AUTH_TOKEN: " RH_TOKEN

if [ ! -z "$RH_TOKEN" ]; then
    sed -i "s/ROBINHOOD_AUTH_TOKEN=.*/ROBINHOOD_AUTH_TOKEN=$RH_TOKEN/" .env
    echo "✅ Robinhood auth token saved"
else
    echo "⚠️  Skipped Robinhood"
fi

echo ""
echo "📝 STEP 2: Coinbase Setup"
echo "========================"
echo "1. Open: https://www.coinbase.com/settings/api"
echo "2. Create API key with trading permissions"
echo "3. Copy and paste the three values below:"
echo ""
read -p "Enter COINBASE_API_KEY: " CB_KEY
read -p "Enter COINBASE_API_SECRET: " CB_SECRET
read -p "Enter COINBASE_PASSPHRASE: " CB_PASS

if [ ! -z "$CB_KEY" ] && [ ! -z "$CB_SECRET" ] && [ ! -z "$CB_PASS" ]; then
    sed -i "s/COINBASE_API_KEY=.*/COINBASE_API_KEY=$CB_KEY/" .env
    sed -i "s/COINBASE_API_SECRET=.*/COINBASE_API_SECRET=$CB_SECRET/" .env
    sed -i "s/COINBASE_PASSPHRASE=.*/COINBASE_PASSPHRASE=$CB_PASS/" .env
    echo "✅ Coinbase credentials saved"
else
    echo "⚠️  Skipped Coinbase"
fi

echo ""
echo "✅ Setup complete!"
echo ""
echo "Your .env file is configured. Start the platform with:"
echo "   node app-builtin.js"
echo ""
echo "Then check broker status at:"
echo "   http://localhost:3000/api/brokers/status"
