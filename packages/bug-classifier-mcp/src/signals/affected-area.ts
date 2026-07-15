import type { Signal, Ticket } from '../types.js';
import { config } from '../config.js';
import { getTicketText } from '../utils/ticket-text.js';

/**
 * Returns the subset of project-specific keywords found in the given text.
 * Matching is case-insensitive AND word-boundary-aware — `road` won't match
 * `broad`, `file` won't match `profile`. Without word boundaries, ordinary
 * words inflated similarity and merged unrelated tickets.
 *
 * Returns an empty array when the project has no keyword dictionary.
 */
export function detectAreas(text: string, project: string): string[] {
  const keywords = config.projectKeywords[project];
  if (!keywords || keywords.length === 0) return [];

  const lower = text.toLowerCase();
  return keywords.filter((kw) => {
    // Escape regex metacharacters so phrases like "i/o" or keywords with `.` don't
    // form invalid or overly permissive patterns.
    const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${safe}\\b`, "i").test(lower);
  });
}

/** Signal that scores ticket pairs by overlap in project-domain keyword areas. */
export class AffectedAreaSignal implements Signal {
  name = 'affectedArea';
  // Memoize the detected-areas Set per ticket. scoreAllPairs runs O(n²)
  // comparisons, so without this cache we would rebuild the same ticket
  // text and re-run the keyword regexes for every pair (millions of times
  // at the documented 2000-ticket cap). Same pattern the text-similarity
  // and error-pattern signals already use.
  private cache = new Map<string, Set<string>>();

  private getAreas(ticket: Ticket): Set<string> {
    if (!this.cache.has(ticket.key)) {
      this.cache.set(ticket.key, new Set(detectAreas(getTicketText(ticket), ticket.project)));
    }
    return this.cache.get(ticket.key)!;
  }

  score(a: Ticket, b: Ticket): number {
    const areasA = this.getAreas(a);
    const areasB = this.getAreas(b);

    if (areasA.size === 0 || areasB.size === 0) return 0;

    let overlap = 0;
    for (const area of areasA) {
      if (areasB.has(area)) overlap++;
    }

    if (overlap === 0) return 0;

    const minSize = Math.min(areasA.size, areasB.size);
    return overlap / minSize;
  }
}
