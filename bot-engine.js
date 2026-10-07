/**
 * AI Bot Trading Engine
 * Executes trading strategies and manages portfolio updates
 */

const marketDataService = require('./market-data-service');

class BotEngine {
    constructor() {
        this.activeBotsMap = new Map();
        this.tradeHistory = {};
        this.botStrategies = {
            autorule: new AutoRuleStrategy(),
            quantum: new QuantumAIStrategy(),
            mining: new MiningBotStrategy(),
            betting: new BetBrainStrategy()
        };
    }

    // Start bot trading
    async startBot(bot, userPortfolio, marketData) {
        const botKey = `${bot.user_id}-${bot.id}`;

        if (this.activeBotsMap.has(botKey)) {
            return { error: 'Bot already running' };
        }

        console.log(`🤖 Starting ${bot.name} (${bot.bot_type})`);

        const strategy = this.botStrategies[bot.bot_type];
        if (!strategy) {
            return { error: 'Unknown bot type' };
        }

        // Initialize bot state
        const botState = {
            bot,
            portfolio: { ...userPortfolio },
            capital: bot.config.capital || 1000,
            positions: [],
            trades: [],
            performance: bot.performance || {
                trades_executed: 0,
                wins: 0,
                losses: 0,
                total_profit: 0,
                win_rate: 0
            },
            startTime: new Date(),
            lastUpdate: new Date()
        };

        this.activeBotsMap.set(botKey, botState);
        this.tradeHistory[botKey] = [];

        // Start bot execution loop
        this.runBotLoop(botKey, strategy);

        return {
            success: true,
            message: `${bot.name} started`,
            capital: botState.capital
        };
    }

    // Stop bot trading
    stopBot(botId, userId) {
        const botKey = `${userId}-${botId}`;
        if (this.activeBotsMap.has(botKey)) {
            const botState = this.activeBotsMap.get(botKey);
            this.activeBotsMap.delete(botKey);

            console.log(`⏹️ Stopped ${botState.bot.name}`);

            return {
                success: true,
                performance: botState.performance,
                totalProfit: botState.performance.total_profit
            };
        }
        return { error: 'Bot not running' };
    }

    // Main bot execution loop
    runBotLoop(botKey, strategy) {
        const interval = setInterval(async () => {
            if (!this.activeBotsMap.has(botKey)) {
                clearInterval(interval);
                return;
            }

            const botState = this.activeBotsMap.get(botKey);

            try {
                // Get current market data
                const marketData = await marketDataService.getAllMarketData();

                // Execute strategy
                const signal = await strategy.analyze(marketData, botState);

                if (signal && signal.action) {
                    // Execute trade
                    const trade = this.executeTrade(botState, signal, marketData);

                    if (trade) {
                        botState.trades.push(trade);
                        this.tradeHistory[botKey].push(trade);
                        this.updateBotPerformance(botState, trade);

                        console.log(`📊 ${botState.bot.name}: ${trade.side.toUpperCase()} ${trade.quantity} ${trade.symbol} @ $${trade.price}`);
                    }
                }

                botState.lastUpdate = new Date();
            } catch (error) {
                console.error(`Bot error (${botKey}):`, error.message);
            }
        }, 10000); // Execute every 10 seconds
    }

    // Execute trade simulation
    executeTrade(botState, signal, marketData) {
        const { symbol, action, quantity, confidence } = signal;

        // Get price from market data
        let price = 0;
        if (marketData.stocks[symbol]) {
            price = parseFloat(marketData.stocks[symbol].price);
        } else if (marketData.crypto[symbol]) {
            price = parseFloat(marketData.crypto[symbol].price);
        }

        if (!price) return null;

        const tradeSize = quantity || Math.floor(botState.capital * 0.1 / price);
        const totalCost = tradeSize * price;

        // Check if bot has enough capital
        if (action === 'buy' && totalCost > botState.capital * 0.5) {
            return null; // Not enough capital
        }

        // Simulate trade execution
        const trade = {
            id: `TRADE-${Date.now()}`,
            symbol,
            side: action,
            quantity: tradeSize,
            price,
            cost: totalCost,
            confidence,
            timestamp: new Date().toISOString(),
            status: 'executed',
            entryPrice: price,
            exitPrice: null,
            profit: 0,
            profitPercent: 0
        };

        // Update capital
        if (action === 'buy') {
            botState.capital -= totalCost;
            // Add to positions
            const existing = botState.positions.find(p => p.symbol === symbol);
            if (existing) {
                existing.quantity += tradeSize;
                existing.avgPrice = (existing.avgPrice + price) / 2;
            } else {
                botState.positions.push({
                    symbol,
                    quantity: tradeSize,
                    avgPrice: price,
                    currentPrice: price
                });
            }
        } else if (action === 'sell') {
            const position = botState.positions.find(p => p.symbol === symbol);
            if (position) {
                trade.profit = (price - position.avgPrice) * position.quantity;
                trade.profitPercent = ((price - position.avgPrice) / position.avgPrice) * 100;

                botState.capital += totalCost + trade.profit;
                position.quantity -= tradeSize;

                if (position.quantity <= 0) {
                    botState.positions = botState.positions.filter(p => p.symbol !== symbol);
                }
            }
        }

        return trade;
    }

    // Update bot performance metrics
    updateBotPerformance(botState, trade) {
        botState.performance.trades_executed++;

        if (trade.side === 'sell') {
            if (trade.profit > 0) {
                botState.performance.wins++;
            } else if (trade.profit < 0) {
                botState.performance.losses++;
            }
            botState.performance.total_profit += trade.profit;
        }

        // Calculate win rate
        if (botState.performance.trades_executed > 0) {
            const winCount = botState.performance.wins + (botState.performance.trades_executed - botState.performance.wins - botState.performance.losses);
            botState.performance.win_rate = Math.round((botState.performance.wins / botState.performance.trades_executed) * 100);
        }
    }

    // Get bot status
    getBotStatus(botId, userId) {
        const botKey = `${userId}-${botId}`;
        const botState = this.activeBotsMap.get(botKey);

        if (!botState) {
            return { status: 'inactive' };
        }

        return {
            status: 'active',
            bot: botState.bot,
            performance: botState.performance,
            capital: botState.capital,
            positions: botState.positions,
            trades: botState.trades.slice(-10),
            uptime: Math.round((Date.now() - botState.startTime.getTime()) / 1000),
            lastUpdate: botState.lastUpdate
        };
    }

    // Get all active bots
    getActiveBots() {
        const active = [];
        this.activeBotsMap.forEach((botState, key) => {
            active.push({
                key,
                name: botState.bot.name,
                type: botState.bot.bot_type,
                performance: botState.performance,
                capital: botState.capital
            });
        });
        return active;
    }
}

// AutoRule Strategy - Momentum-based trading
class AutoRuleStrategy {
    async analyze(marketData, botState) {
        const symbols = Object.keys(marketData.stocks || {});
        const randomSymbol = symbols[Math.floor(Math.random() * symbols.length)];

        if (!randomSymbol) return null;

        const price = marketData.stocks[randomSymbol];
        const change = parseFloat(price.change24h);

        // Buy on positive momentum
        if (change > 1) {
            return {
                symbol: randomSymbol,
                action: 'buy',
                quantity: Math.floor(botState.capital * 0.05 / parseFloat(price.price)),
                confidence: Math.min(change * 10, 0.9)
            };
        }

        // Sell positions with negative momentum
        const position = botState.positions.find(p => p.symbol === randomSymbol);
        if (position && change < -1) {
            return {
                symbol: randomSymbol,
                action: 'sell',
                quantity: position.quantity,
                confidence: Math.abs(change) * 0.1
            };
        }

        return null;
    }
}

// Quantum AI Strategy - ML-based prediction
class QuantumAIStrategy {
    async analyze(marketData, botState) {
        // Simulate ML prediction
        const symbols = Object.keys(marketData.stocks || {});

        for (const symbol of symbols) {
            const price = marketData.stocks[symbol];
            const change = parseFloat(price.change24h);

            // Simulate ML confidence score (0-1)
            const confidence = Math.random() * 0.8 + 0.2;

            if (confidence > 0.65 && change > 0.5) {
                return {
                    symbol,
                    action: 'buy',
                    quantity: Math.floor(botState.capital * 0.08 / parseFloat(price.price)),
                    confidence
                };
            }

            const position = botState.positions.find(p => p.symbol === symbol);
            if (position && confidence > 0.7 && change < -0.5) {
                return {
                    symbol,
                    action: 'sell',
                    quantity: Math.floor(position.quantity * 0.5),
                    confidence
                };
            }
        }

        return null;
    }
}

// Mining Bot Strategy - Crypto mining optimization
class MiningBotStrategy {
    async analyze(marketData, botState) {
        const cryptos = marketData.crypto || {};

        // Find most profitable crypto
        let bestCrypto = null;
        let bestROI = 0;

        for (const [symbol, data] of Object.entries(cryptos)) {
            const roi = parseFloat(data.change24h);
            if (roi > bestROI) {
                bestROI = roi;
                bestCrypto = symbol;
            }
        }

        if (bestCrypto && bestROI > 0.5) {
            return {
                symbol: bestCrypto,
                action: 'buy',
                quantity: Math.floor(botState.capital * 0.1 / parseFloat(cryptos[bestCrypto].price)),
                confidence: Math.min(bestROI / 10, 0.95)
            };
        }

        return null;
    }
}

// Bet Brain Strategy - Sports betting AI
class BetBrainStrategy {
    async analyze(marketData, botState) {
        // Simulate betting signal generation
        const symbols = Object.keys(marketData.stocks || {});

        if (Math.random() > 0.7) { // 30% chance of bet
            const symbol = symbols[Math.floor(Math.random() * symbols.length)];
            const price = marketData.stocks[symbol];

            return {
                symbol,
                action: Math.random() > 0.5 ? 'buy' : 'sell',
                quantity: Math.floor(botState.capital * 0.02 / parseFloat(price.price)),
                confidence: 0.6 + Math.random() * 0.3
            };
        }

        return null;
    }
}

module.exports = new BotEngine();
