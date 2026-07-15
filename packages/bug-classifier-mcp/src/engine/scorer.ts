import type { Signal, Ticket, ScoredPair } from '../types.js';
import { config } from '../config.js';
import { TextSimilaritySignal } from '../signals/text-similarity.js';
import { ErrorPatternSignal } from '../signals/error-pattern.js';
import { ComponentLabelSignal } from '../signals/component-label.js';
import { AffectedAreaSignal } from '../signals/affected-area.js';
import { TemporalProximitySignal } from '../signals/temporal-proximity.js';

interface WeightedSignal {
  signal: Signal;
  weight: number;
}

/**
 * Build a fresh set of signal instances. Several signals memoize derived
 * data (token sets, error pattern sets) by `ticket.key`, so reusing a
 * single instance across runs would return stale results when a ticket
 * changes in Jira between calls. Instantiating per-call ties cache
 * lifetime to a single classify_bugs invocation.
 */
function buildSignals(): WeightedSignal[] {
  return [
    { signal: new TextSimilaritySignal(), weight: config.signalWeights.textSimilarity },
    { signal: new ErrorPatternSignal(), weight: config.signalWeights.errorPattern },
    { signal: new ComponentLabelSignal(), weight: config.signalWeights.componentLabel },
    { signal: new AffectedAreaSignal(), weight: config.signalWeights.affectedArea },
    { signal: new TemporalProximitySignal(), weight: config.signalWeights.temporalProximity },
  ];
}

export function scorePair(
  a: Ticket,
  b: Ticket,
  signals: WeightedSignal[] = buildSignals(),
): ScoredPair {
  const signalScores: Record<string, number> = {};
  let totalScore = 0;

  for (const { signal, weight } of signals) {
    const s = signal.score(a, b);
    signalScores[signal.name] = s;
    totalScore += s * weight;
  }

  return {
    ticketA: a.key,
    ticketB: b.key,
    score: Math.min(1, totalScore),
    signalScores,
  };
}

export function scoreAllPairs(tickets: Ticket[], threshold: number): ScoredPair[] {
  const signals = buildSignals();
  const results: ScoredPair[] = [];

  for (let i = 0; i < tickets.length; i++) {
    for (let j = i + 1; j < tickets.length; j++) {
      const pair = scorePair(tickets[i], tickets[j], signals);
      if (pair.score >= threshold) {
        results.push(pair);
      }
    }
  }

  return results;
}
