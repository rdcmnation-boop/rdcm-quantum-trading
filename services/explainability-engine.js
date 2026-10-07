/**
 * RDCMNATION QUANTUM - Explainability Engine
 *
 * Generates decision cards explaining "Why did QUANTUM recommend this trade?"
 * Every decision includes complete reasoning chain.
 */

class ExplainabilityEngine {
  constructor(config = {}) {
    this.config = config;
    this.decisionCards = new Map();
    this.stats = {
      totalDecisions: 0,
      cardsByReason: {},
      avgConfidence: 0
    };
  }

  /**
   * MAIN: Generate decision card for a trade recommendation
   * Called immediately after AI Council produces a decision
   */
  generateDecisionCard(decisionContext) {
    const {
      decisionId,
      symbol,
      action, // BUY / SELL / HOLD
      timestamp,
      snapshot,
      aiScores,
      riskAssessment,
      executionPlan,
      confidence
    } = decisionContext;

    // Calculate QUANTUM SCORE (0-100)
    const quantumScore = this.calculateQuantumScore(aiScores);

    // Determine sentiment
    const sentiment = this.determineSentiment(quantumScore, aiScores);

    // Build signals breakdown
    const signalsBreakdown = this.buildSignalsBreakdown(aiScores);

    // Risk assessment reasoning
    const riskReasoning = this.buildRiskReasoning(riskAssessment);

    // Generate natural language reasoning
    const reasoning = this.generateReasoning({
      symbol,
      action,
      quantumScore,
      sentiment,
      aiScores,
      riskAssessment,
      snapshot
    });

    // Build decision card
    const card = {
      // Metadata
      decisionId: decisionId,
      symbol: symbol,
      action: action,
      timestamp: timestamp || new Date().toISOString(),

      // Main scoring
      quantumScore: quantumScore,
      confidence: confidence || this.calculateConfidence(aiScores),
      sentiment: sentiment,

      // Signals breakdown
      signals: signalsBreakdown,

      // Risk assessment
      riskAssessment: riskReasoning,

      // Execution plan
      executionPlan: executionPlan || {},

      // Natural language reasoning
      reasoning: reasoning,

      // Decision chain (for audit)
      decisionChain: {
        aiCouncilScores: aiScores,
        weightedVotes: this.calculateWeightedVotes(aiScores),
        riskEngine: {
          status: riskAssessment?.violations?.length === 0 ? 'APPROVED' : 'BLOCKED',
          violations: riskAssessment?.violations || []
        }
      },

      // Metadata
      generatedAt: new Date().toISOString(),
      version: '1.0'
    };

    // Store card
    this.decisionCards.set(decisionId, card);
    this.updateStats(card);

    console.log(`🎯 Decision card generated: ${symbol} ${action} - QUANTUM Score: ${quantumScore} - Confidence: ${confidence?.toFixed(0)}%`);

    return card;
  }

  /**
   * Calculate QUANTUM SCORE from 8 input factors
   *
   * Factors:
   * 1. Technical Score (20%)
   * 2. Momentum Score (20%)
   * 3. Volume Score (15%)
   * 4. Volatility Score (10%)
   * 5. Liquidity Score (10%)
   * 6. Sentiment Score (15%)
   * 7. Consensus Score (5%)
   * 8. Risk Score (5%)
   */
  calculateQuantumScore(aiScores = {}) {
    const {
      technicalScore = 50,
      momentumScore = 50,
      volumeScore = 50,
      volatilityScore = 50,
      liquidityScore = 50,
      sentimentScore = 50,
      consensusScore = 50,
      riskScore = 50
    } = aiScores;

    const weighted =
      (technicalScore * 0.20) +
      (momentumScore * 0.20) +
      (volumeScore * 0.15) +
      (volatilityScore * 0.10) +
      (liquidityScore * 0.10) +
      (sentimentScore * 0.15) +
      (consensusScore * 0.05) +
      (riskScore * 0.05);

    return Math.round(Math.min(100, Math.max(0, weighted)));
  }

  /**
   * Determine sentiment: Bullish / Neutral / Bearish
   */
  determineSentiment(quantumScore, aiScores = {}) {
    if (quantumScore >= 65) {
      return 'BULLISH';
    } else if (quantumScore >= 45) {
      return 'NEUTRAL';
    } else {
      return 'BEARISH';
    }
  }

  /**
   * Build signals breakdown showing contribution of each factor
   */
  buildSignalsBreakdown(aiScores = {}) {
    const {
      technicalScore = 50,
      momentumScore = 50,
      volumeScore = 50,
      volatilityScore = 50,
      liquidityScore = 50,
      sentimentScore = 50,
      consensusScore = 50,
      riskScore = 50
    } = aiScores;

    return {
      technical: {
        score: technicalScore,
        label: this.scoreToLabel(technicalScore),
        weight: '20%',
        description: 'Chart patterns, moving averages, support/resistance'
      },
      momentum: {
        score: momentumScore,
        label: this.scoreToLabel(momentumScore),
        weight: '20%',
        description: 'Price momentum, rate of change, trend continuation'
      },
      volume: {
        score: volumeScore,
        label: this.scoreToLabel(volumeScore),
        weight: '15%',
        description: 'Volume analysis, liquidity conditions, market participation'
      },
      volatility: {
        score: volatilityScore,
        label: this.scoreToLabel(volatilityScore),
        weight: '10%',
        description: 'VIX, ATR, price volatility regime'
      },
      liquidity: {
        score: liquidityScore,
        label: this.scoreToLabel(liquidityScore),
        weight: '10%',
        description: 'Bid-ask spread, order book depth, execution quality'
      },
      sentiment: {
        score: sentimentScore,
        label: this.scoreToLabel(sentimentScore),
        weight: '15%',
        description: 'News sentiment, social sentiment, analyst ratings'
      },
      consensus: {
        score: consensusScore,
        label: this.scoreToLabel(consensusScore),
        weight: '5%',
        description: 'Agreement between AI agents, external consensus'
      },
      risk: {
        score: riskScore,
        label: this.scoreToLabel(riskScore),
        weight: '5%',
        description: 'Position sizing, portfolio correlation, drawdown risk'
      }
    };
  }

  /**
   * Convert score to label
   */
  scoreToLabel(score) {
    if (score >= 80) return 'VERY_STRONG';
    if (score >= 65) return 'STRONG';
    if (score >= 50) return 'MODERATE';
    if (score >= 35) return 'WEAK';
    return 'VERY_WEAK';
  }

  /**
   * Build risk assessment reasoning
   */
  buildRiskReasoning(riskAssessment = {}) {
    return {
      dailyLoss: {
        passed: !riskAssessment?.dailyLossViolation,
        reason: riskAssessment?.dailyLossViolation || 'Within daily loss limit'
      },
      positionSize: {
        passed: !riskAssessment?.positionSizeViolation,
        reason: riskAssessment?.positionSizeViolation || 'Position size acceptable'
      },
      portfolioExposure: {
        passed: !riskAssessment?.exposureViolation,
        reason: riskAssessment?.exposureViolation || 'Portfolio exposure within limits'
      },
      correlation: {
        passed: !riskAssessment?.correlationViolation,
        reason: riskAssessment?.correlationViolation || 'Correlation risk acceptable'
      },
      liquidity: {
        passed: !riskAssessment?.liquidityViolation,
        reason: riskAssessment?.liquidityViolation || 'Sufficient liquidity available'
      },
      overallRisk: {
        level: riskAssessment?.riskLevel || 'MEDIUM',
        status: riskAssessment?.violations?.length === 0 ? 'APPROVED' : 'BLOCKED',
        violations: riskAssessment?.violations || []
      }
    };
  }

  /**
   * Calculate confidence score
   */
  calculateConfidence(aiScores = {}) {
    const scores = Object.values(aiScores);
    if (scores.length === 0) return 0;

    // Confidence is based on:
    // 1. Average score (higher is more confident)
    // 2. Agreement between scores (low variance = higher confidence)

    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((sum, score) => sum + Math.pow(score - avg, 2), 0) / scores.length;
    const agreement = Math.max(0, 100 - variance); // High agreement = high confidence

    const confidence = (avg + agreement) / 2;
    return Math.round(Math.min(100, Math.max(0, confidence)));
  }

  /**
   * Calculate weighted votes (majority rules but with confidence)
   */
  calculateWeightedVotes(aiScores = {}) {
    const scores = Object.entries(aiScores);
    const bullishCount = scores.filter(([_, score]) => score > 50).length;
    const bearishCount = scores.filter(([_, score]) => score <= 50).length;

    return {
      bullish: bullishCount,
      bearish: bearishCount,
      majority: bullishCount > bearishCount ? 'BULLISH' : 'BEARISH',
      consensus: Math.abs(bullishCount - bearishCount) <= 1
    };
  }

  /**
   * Generate natural language reasoning
   */
  generateReasoning(context) {
    const { symbol, action, quantumScore, sentiment, aiScores, riskAssessment, snapshot } = context;

    const reasons = [];

    // Add technical reasons
    if (aiScores.technicalScore > 60) {
      reasons.push(`Technical analysis shows ${sentiment === 'BULLISH' ? 'bullish' : 'bearish'} setup`);
    }

    // Add momentum reasons
    if (aiScores.momentumScore > 60) {
      reasons.push(`Strong momentum signal in favor of ${action}`);
    }

    // Add sentiment reasons
    if (aiScores.sentimentScore > 60) {
      reasons.push(`Positive sentiment from news and social media`);
    }

    // Add volume reasons
    if (aiScores.volumeScore > 60) {
      reasons.push(`High volume confirmation supports the setup`);
    }

    if (reasons.length === 0) {
      reasons.push(`Confluence of multiple moderate signals suggests ${action}`);
    }

    // Add risk notes
    if (riskAssessment?.riskLevel === 'HIGH') {
      reasons.push(`⚠️ Note: This trade carries elevated risk`);
    }

    return {
      summary: `${sentiment} signal for ${symbol}: ${reasons[0]}`,
      keyFactors: reasons,
      quantumScoreInterpretation: this.interpretQuantumScore(quantumScore),
      recommendedAction: action,
      confidenceNote: this.getConfidenceNote(this.calculateConfidence(aiScores))
    };
  }

  /**
   * Interpret QUANTUM SCORE value
   */
  interpretQuantumScore(score) {
    if (score >= 85) {
      return 'Very strong signal - high conviction recommendation';
    } else if (score >= 70) {
      return 'Strong signal - good conviction recommendation';
    } else if (score >= 55) {
      return 'Moderate signal - reasonable setup';
    } else if (score >= 40) {
      return 'Weak signal - proceed with caution';
    } else {
      return 'Very weak signal - recommend passing on this opportunity';
    }
  }

  /**
   * Get confidence note for user
   */
  getConfidenceNote(confidence) {
    if (confidence >= 80) {
      return 'High confidence - AI council strongly aligned';
    } else if (confidence >= 60) {
      return 'Moderate confidence - Most AI agents agree';
    } else if (confidence >= 40) {
      return 'Low confidence - Mixed signals from AI council';
    } else {
      return 'Very low confidence - AI council disagrees significantly';
    }
  }

  /**
   * Export decision card as JSON
   */
  exportDecisionCard(decisionId, format = 'json') {
    const card = this.decisionCards.get(decisionId);
    if (!card) {
      return { error: 'Decision card not found' };
    }

    if (format === 'json') {
      return card;
    } else if (format === 'markdown') {
      return this.cardToMarkdown(card);
    } else if (format === 'text') {
      return this.cardToText(card);
    }
  }

  /**
   * Convert decision card to markdown (for logging/display)
   */
  cardToMarkdown(card) {
    const { symbol, action, quantumScore, confidence, sentiment, signals, reasoning, riskAssessment } = card;

    let md = `# Trade Decision: ${symbol} ${action}\n\n`;
    md += `**QUANTUM Score:** ${quantumScore}/100 | **Confidence:** ${confidence}% | **Sentiment:** ${sentiment}\n\n`;

    md += `## Reasoning\n${reasoning.summary}\n\n`;
    md += `${reasoning.keyFactors.map(f => `- ${f}`).join('\n')}\n\n`;

    md += `## Signal Breakdown\n`;
    Object.entries(signals).forEach(([key, signal]) => {
      md += `- **${key}:** ${signal.score}/100 (${signal.label})\n`;
    });

    md += `\n## Risk Assessment\n`;
    md += `- Daily Loss: ${riskAssessment.dailyLoss.passed ? '✅' : '❌'}\n`;
    md += `- Position Size: ${riskAssessment.positionSize.passed ? '✅' : '❌'}\n`;
    md += `- Exposure: ${riskAssessment.portfolioExposure.passed ? '✅' : '❌'}\n`;
    md += `- Risk Level: ${riskAssessment.overallRisk.level}\n`;

    return md;
  }

  /**
   * Convert decision card to plain text
   */
  cardToText(card) {
    const { symbol, action, quantumScore, confidence, sentiment, reasoning } = card;

    return `
TRADE DECISION CARD
${symbol} ${action}

QUANTUM SCORE: ${quantumScore}/100
CONFIDENCE: ${confidence}%
SENTIMENT: ${sentiment}

REASONING:
${reasoning.summary}

KEY FACTORS:
${reasoning.keyFactors.map(f => `  • ${f}`).join('\n')}

RECOMMENDATION: ${action}
${reasoning.confidenceNote}
    `.trim();
  }

  /**
   * Get decision card
   */
  getDecisionCard(decisionId) {
    return this.decisionCards.get(decisionId);
  }

  /**
   * Get all decision cards (for review/analysis)
   */
  getAllDecisionCards(limit = 100) {
    return Array.from(this.decisionCards.values()).slice(-limit);
  }

  /**
   * Update statistics
   */
  updateStats(card) {
    this.stats.totalDecisions++;
    const reason = card.reasoning.summary.substring(0, 50);
    this.stats.cardsByReason[reason] = (this.stats.cardsByReason[reason] || 0) + 1;

    // Update average confidence
    const allCards = Array.from(this.decisionCards.values());
    const avgConfidence = allCards.reduce((sum, c) => sum + c.confidence, 0) / allCards.length;
    this.stats.avgConfidence = Math.round(avgConfidence);
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      ...this.stats,
      totalCardsCached: this.decisionCards.size
    };
  }
}

module.exports = ExplainabilityEngine;
