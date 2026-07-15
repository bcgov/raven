import type { Signal, Ticket } from '../types.js';
import { getTicketText } from '../utils/ticket-text.js';

/**
 * Extracts known error patterns from a text string.
 * Returns uppercased pattern strings for consistent comparison.
 */
export function extractErrorPatterns(text: string): string[] {
  if (!text) return [];

  // Regexes created per-call to avoid shared mutable lastIndex state
  const patterns = [
    /\b(ORA-\d{4,5})\b/gi,
    /\b(HTTP\s*[45]\d{2})\b/gi,
    /\b(?:[a-z]+\.)+([A-Z]\w*(?:Exception|Error))\b/g,
    /\b([A-Z][a-z]+(?:[A-Z][a-z]+)*(?:Exception|Error))\b/g,
    /\b([A-Z][A-Z0-9_]+\.[A-Z][A-Z0-9_]+)\b/g,
    /\b(Msg\s+\d{3,})\b/gi,
    /\b(SQLSTATE\s*[A-Z0-9]{5})\b/gi,
  ];

  const found = new Set<string>();
  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      found.add(match[1].replace(/\s+/g, ' ').toUpperCase());
    }
  }
  return [...found];
}

/** Signal that scores ticket pairs by overlap in extracted error codes, exceptions, and table references. */
export class ErrorPatternSignal implements Signal {
  name = 'errorPattern';

  private cache = new Map<string, Set<string>>();

  private getPatterns(ticket: Ticket): Set<string> {
    if (!this.cache.has(ticket.key)) {
      this.cache.set(ticket.key, new Set(extractErrorPatterns(getTicketText(ticket, { includeAttachments: true }))));
    }
    return this.cache.get(ticket.key)!;
  }

  score(a: Ticket, b: Ticket): number {
    const patternsA = this.getPatterns(a);
    const patternsB = this.getPatterns(b);

    if (patternsA.size === 0 || patternsB.size === 0) return 0;

    let overlap = 0;
    for (const p of patternsA) {
      if (patternsB.has(p)) overlap++;
    }

    if (overlap === 0) return 0;

    const minSize = Math.min(patternsA.size, patternsB.size);
    return overlap / minSize;
  }
}
