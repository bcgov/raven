import { stemmer } from 'stemmer';
import type { Signal, Ticket } from '../types.js';
import { getTicketText } from '../utils/ticket-text.js';

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'shall', 'can', 'need', 'dare',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she',
  'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his',
  'our', 'their', 'what', 'which', 'who', 'when', 'where', 'why', 'how',
  'not', 'no', 'nor', 'as', 'if', 'then', 'than', 'too', 'very', 'just',
  'about', 'above', 'after', 'again', 'all', 'also', 'am', 'any', 'because',
  'before', 'below', 'between', 'both', 'during', 'each', 'few', 'further',
  'get', 'got', 'here', 'into', 'more', 'most', 'other', 'out', 'own',
  'same', 'so', 'some', 'such', 'only', 'over', 'under', 'until', 'up',
]);

/** Returns stemmed tokens for similarity scoring */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map((w) => stemmer(w));
}

/** Returns unstemmed tokens for readable display (e.g., cluster titles) */
export function tokenizeRaw(text: string): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function getBigrams(tokens: string[]): Set<string> {
  const bigrams = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bigrams;
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class TextSimilaritySignal implements Signal {
  name = 'textSimilarity';

  // Memoize tokenization per ticket key to avoid re-tokenizing O(n) times per ticket
  private unigramCache = new Map<string, Set<string>>();
  private bigramCache = new Map<string, Set<string>>();

  private getUnigrams(ticket: Ticket): Set<string> {
    if (!this.unigramCache.has(ticket.key)) {
      this.unigramCache.set(ticket.key, new Set(tokenize(getTicketText(ticket))));
    }
    return this.unigramCache.get(ticket.key)!;
  }

  private getBigramsFor(ticket: Ticket): Set<string> {
    if (!this.bigramCache.has(ticket.key)) {
      const tokens = tokenize(getTicketText(ticket));
      this.bigramCache.set(ticket.key, getBigrams(tokens));
    }
    return this.bigramCache.get(ticket.key)!;
  }

  score(a: Ticket, b: Ticket): number {
    const unigramScore = jaccardSimilarity(this.getUnigrams(a), this.getUnigrams(b));
    const bigramScore = jaccardSimilarity(this.getBigramsFor(a), this.getBigramsFor(b));

    return Math.min(1, unigramScore * 0.7 + bigramScore * 0.3);
  }
}
