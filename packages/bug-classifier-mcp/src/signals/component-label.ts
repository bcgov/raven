import type { Signal, Ticket } from '../types.js';

/**
 * Normalizes a label by lowercasing and stripping hyphens, underscores, and spaces.
 */
export function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[-_\s]/g, '');
}

/**
 * Signal that scores ticket pairs based on shared labels, components, and duplicate links.
 * Returns 1.0 for explicitly duplicate-linked tickets, otherwise a Jaccard-style overlap score.
 */
export class ComponentLabelSignal implements Signal {
  name = 'componentLabel';
  // Memoize the normalized label/component Sets per ticket. scoreAllPairs
  // is O(n²); without this we re-lowercase and re-allocate Sets for every
  // pair. The ticket.labels / ticket.components arrays are invariant
  // across a single classify_bugs run.
  private labelCache = new Map<string, Set<string>>();
  private componentCache = new Map<string, Set<string>>();

  private getLabels(ticket: Ticket): Set<string> {
    if (!this.labelCache.has(ticket.key)) {
      this.labelCache.set(ticket.key, new Set(ticket.labels.map(normalizeLabel)));
    }
    return this.labelCache.get(ticket.key)!;
  }

  private getComponents(ticket: Ticket): Set<string> {
    if (!this.componentCache.has(ticket.key)) {
      this.componentCache.set(ticket.key, new Set(ticket.components.map((c) => c.toLowerCase())));
    }
    return this.componentCache.get(ticket.key)!;
  }

  score(a: Ticket, b: Ticket): number {
    if (a.duplicateLinks.includes(b.key) || b.duplicateLinks.includes(a.key)) {
      return 1.0;
    }

    const normalizedLabelsA = this.getLabels(a);
    const normalizedLabelsB = this.getLabels(b);
    const componentsA = this.getComponents(a);
    const componentsB = this.getComponents(b);

    let labelOverlap = 0;
    for (const l of normalizedLabelsA) {
      if (normalizedLabelsB.has(l)) labelOverlap++;
    }

    let componentOverlap = 0;
    for (const c of componentsA) {
      if (componentsB.has(c)) componentOverlap++;
    }

    const totalA = normalizedLabelsA.size + componentsA.size;
    const totalB = normalizedLabelsB.size + componentsB.size;
    const totalOverlap = labelOverlap + componentOverlap;

    if (totalA === 0 && totalB === 0) return 0;
    if (totalOverlap === 0) return 0;

    const minTotal = Math.min(totalA, totalB);
    return minTotal === 0 ? 0 : totalOverlap / minTotal;
  }
}
