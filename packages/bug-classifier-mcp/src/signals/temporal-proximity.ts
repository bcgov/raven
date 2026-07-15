import type { Signal, Ticket } from '../types.js';
import { config } from '../config.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class TemporalProximitySignal implements Signal {
  name = 'temporalProximity';

  score(a: Ticket, b: Ticket): number {
    if (!a.created || !b.created) return 0;
    const dateA = new Date(a.created).getTime();
    const dateB = new Date(b.created).getTime();
    if (Number.isNaN(dateA) || Number.isNaN(dateB)) return 0;
    const diffDays = Math.abs(dateA - dateB) / MS_PER_DAY;
    const window = config.temporalWindowDays;

    if (diffDays >= window) return 0;

    return 1 - diffDays / window;
  }
}
