import type { Ticket, ScoredPair, Cluster } from '../types.js';
import { config } from '../config.js';
import { tokenizeRaw } from '../signals/text-similarity.js';
import { extractErrorPatterns } from '../signals/error-pattern.js';

/** Union-Find for connected components */
class UnionFind {
  private parent: Map<string, string> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    let current = x;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }

  components(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(key);
    }
    return groups;
  }
}

function pruneOversizedCluster(
  clusterTickets: Ticket[],
  clusterEdges: ScoredPair[],
  maxSize: number,
  ticketMap: Map<string, Ticket>,
): { tickets: Ticket[]; edges: ScoredPair[] }[] {
  const sortedEdges = [...clusterEdges].sort((a, b) => a.score - b.score);
  let activeEdges = [...sortedEdges];

  while (activeEdges.length > 0) {
    const uf = new UnionFind();
    for (const e of activeEdges) {
      uf.union(e.ticketA, e.ticketB);
    }
    const components = uf.components();
    const oversized = [...components.values()].some((keys) => keys.length > maxSize);
    if (!oversized) break;

    activeEdges = activeEdges.slice(1);

    const nextUf = new UnionFind();
    for (const e of activeEdges) {
      nextUf.union(e.ticketA, e.ticketB);
    }
    const nextComponents = nextUf.components();
    const allSingletons = [...nextComponents.values()].every((keys) => keys.length <= 1);
    if (allSingletons) break;
  }

  const finalUf = new UnionFind();
  for (const e of activeEdges) {
    finalUf.union(e.ticketA, e.ticketB);
  }

  const finalComponents = finalUf.components();

  const edgesByRoot = new Map<string, ScoredPair[]>();
  for (const e of activeEdges) {
    const root = finalUf.find(e.ticketA);
    if (!edgesByRoot.has(root)) edgesByRoot.set(root, []);
    edgesByRoot.get(root)!.push(e);
  }

  const result: { tickets: Ticket[]; edges: ScoredPair[] }[] = [];

  for (const [root, keys] of finalComponents) {
    const subTickets = keys
      .map((k) => ticketMap.get(k))
      .filter((t): t is Ticket => t !== undefined);

    if (subTickets.length < 2) continue;

    result.push({
      tickets: subTickets,
      edges: edgesByRoot.get(root) ?? [],
    });
  }

  // If pruning produced no usable sub-clusters (everything fell to
  // singletons), DROP the oversized cluster — its tickets become
  // unmatched. Restoring the original would defeat the purpose of the
  // size guard: a noisy star/chain-shaped cluster over the warning
  // threshold would survive completely unmodified, exactly the case
  // the guard is meant to tame.
  return result;
}

function getDominantSignal(edges: ScoredPair[]): string {
  // Apply the same weights the scorer uses, so the dominant signal we
  // report for the cluster matches the signal that actually drove the
  // pair score above the threshold. With raw scores, a heavily-weighted
  // but moderate signal (e.g., errorPattern at 0.25) could be reported
  // as dominant over a lower-weighted but high-scoring signal. That
  // would surface a misleading title/probable cause/suggested action.
  const weights = config.signalWeights as Record<string, number>;
  const totals: Record<string, number> = {};
  for (const edge of edges) {
    for (const [name, score] of Object.entries(edge.signalScores)) {
      const w = weights[name] ?? 0;
      totals[name] = (totals[name] ?? 0) + score * w;
    }
  }
  let best = '';
  let bestScore = -1;
  for (const [name, total] of Object.entries(totals)) {
    if (total > bestScore) {
      best = name;
      bestScore = total;
    }
  }
  return best;
}

function deriveTitle(tickets: Ticket[], dominantSignal: string): string {
  if (dominantSignal === 'errorPattern') {
    const patternCounts = new Map<string, number>();
    for (const t of tickets) {
      // The errorPattern *signal* scores against attachment text too. Title
      // generation must look at the same text source, otherwise a cluster
      // grouped by an attached log gets a misleading fallback title from
      // summary/description/comments alone.
      const attachments = t.attachmentTexts ?? [];
      const text = [t.summary, t.description, ...t.comments, ...attachments].join('\n');
      for (const p of extractErrorPatterns(text)) {
        patternCounts.set(p, (patternCounts.get(p) ?? 0) + 1);
      }
    }
    if (patternCounts.size > 0) {
      const sorted = [...patternCounts.entries()].sort((a, b) => b[1] - a[1]);
      return sorted[0][0];
    }
  }

  const bigramCounts = new Map<string, number>();
  for (const t of tickets) {
    const text = [t.summary, t.description].join(' ');
    const tokens = tokenizeRaw(text);
    const seen = new Set<string>();
    for (let i = 0; i < tokens.length - 1; i++) {
      const bigram = `${tokens[i]} ${tokens[i + 1]}`;
      if (!seen.has(bigram)) {
        seen.add(bigram);
        bigramCounts.set(bigram, (bigramCounts.get(bigram) ?? 0) + 1);
      }
    }
  }

  const threshold = tickets.length * 0.5;
  const topBigram = [...bigramCounts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1])[0];

  if (topBigram) return topBigram[0];

  const tokenCounts = new Map<string, number>();
  for (const t of tickets) {
    const text = [t.summary, t.description].join(' ');
    const seen = new Set<string>();
    for (const token of tokenizeRaw(text)) {
      if (!seen.has(token)) {
        seen.add(token);
        tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
      }
    }
  }

  const topTokens = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([token]) => token);

  return topTokens.join(' / ') || 'Unnamed cluster';
}

function deriveProbableCause(dominantSignal: string, title: string, tickets: Ticket[]): string {
  switch (dominantSignal) {
    case 'errorPattern':
      return `Recurring error: ${title}`;
    case 'textSimilarity':
      return `Recurring issue: ${title}`;
    case 'temporalProximity': {
      const dates = tickets.map((t) => t.created).sort();
      return `Simultaneous failures around ${dates[0].slice(0, 10)}`;
    }
    case 'componentLabel':
      return `Shared component/label pattern: ${title}`;
    case 'affectedArea':
      return `Recurring issue in area: ${title}`;
    default:
      return `Pattern detected: ${title}`;
  }
}

function deriveSuggestedAction(dominantSignal: string, cluster: { tickets: Ticket[]; isCrossProject: boolean; title: string }): string {
  const projects = [...new Set(cluster.tickets.map((t) => t.project))];
  const projectList = projects.join(', ');

  if (cluster.isCrossProject) {
    return `Investigate shared service or component across ${projectList} related to "${cluster.title}"`;
  }

  switch (dominantSignal) {
    case 'errorPattern':
      return `Investigate root cause of ${cluster.title} in ${projectList}`;
    case 'textSimilarity':
      return `Review module related to "${cluster.title}" for systemic issues`;
    case 'temporalProximity':
      return `Check deployments and batch jobs around the time of these failures`;
    case 'componentLabel':
      return `Review shared component for underlying defect`;
    case 'affectedArea':
      return `Review the ${cluster.title} area for recurring defects`;
    default:
      return `Investigate shared root cause across ${cluster.tickets.length} related tickets`;
  }
}

/**
 * Builds clusters from scored ticket pairs using Union-Find connected components.
 * Clusters are ranked by: cross-project DESC, size DESC, recency DESC, confidence DESC.
 */
export function buildClusters(tickets: Ticket[], pairs: ScoredPair[]): Cluster[] {
  if (pairs.length === 0) return [];

  const ticketMap = new Map(tickets.map((t) => [t.key, t]));
  const uf = new UnionFind();

  for (const pair of pairs) {
    uf.union(pair.ticketA, pair.ticketB);
  }

  const components = uf.components();
  const pairsByCluster = new Map<string, ScoredPair[]>();
  for (const pair of pairs) {
    const root = uf.find(pair.ticketA);
    if (!pairsByCluster.has(root)) pairsByCluster.set(root, []);
    pairsByCluster.get(root)!.push(pair);
  }

  type RawCluster = { tickets: Ticket[]; edges: ScoredPair[] };
  const rawClusters: RawCluster[] = [];

  for (const [root, keys] of components) {
    if (keys.length < 2) continue;

    const clusterTickets = keys
      .map((k) => ticketMap.get(k))
      .filter((t): t is Ticket => t !== undefined);

    if (clusterTickets.length < 2) continue;

    const edges = pairsByCluster.get(root) ?? [];
    rawClusters.push({ tickets: clusterTickets, edges });
  }

  const prunedClusters: RawCluster[] = [];
  for (const raw of rawClusters) {
    if (raw.tickets.length > config.clusterSizeWarning) {
      const subClusters = pruneOversizedCluster(
        raw.tickets,
        raw.edges,
        config.clusterSizeWarning,
        ticketMap,
      );
      prunedClusters.push(...subClusters);
    } else {
      prunedClusters.push(raw);
    }
  }

  const clusters: Cluster[] = [];
  let id = 1;

  for (const { tickets: clusterTickets, edges } of prunedClusters) {
    if (clusterTickets.length < 2) continue;

    const avgConfidence = edges.length > 0
      ? edges.reduce((sum, e) => sum + e.score, 0) / edges.length
      : 0;

    const { high, medium } = config.confidenceThresholds;
    const confidenceLevel = avgConfidence >= high ? 'High' : avgConfidence >= medium ? 'Medium' : 'Low';

    const projects = new Set(clusterTickets.map((t) => t.project));
    const isCrossProject = projects.size > 1;

    const dates = clusterTickets.map((t) => t.created).sort();
    const mostRecentDate = dates[dates.length - 1];

    const dominantSignal = getDominantSignal(edges);
    const title = deriveTitle(clusterTickets, dominantSignal);
    const probableCause = deriveProbableCause(dominantSignal, title, clusterTickets);
    const suggestedAction = deriveSuggestedAction(dominantSignal, { tickets: clusterTickets, isCrossProject, title });

    const signalTotals: Record<string, number> = {};
    const signalCounts: Record<string, number> = {};
    for (const edge of edges) {
      for (const [name, score] of Object.entries(edge.signalScores)) {
        signalTotals[name] = (signalTotals[name] ?? 0) + score;
        signalCounts[name] = (signalCounts[name] ?? 0) + 1;
      }
    }
    const matchingSignals = Object.entries(signalTotals)
      .filter(([name]) => (signalTotals[name] / (signalCounts[name] || 1)) > 0)
      .map(([name]) => name);

    clusters.push({
      id: id++,
      tickets: clusterTickets,
      avgConfidence,
      confidenceLevel,
      isCrossProject,
      mostRecentDate,
      title,
      dominantSignal,
      probableCause,
      suggestedAction,
      matchingSignals,
      edges,
    });
  }

  clusters.sort((a, b) => {
    if (a.isCrossProject !== b.isCrossProject) return a.isCrossProject ? -1 : 1;
    if (a.tickets.length !== b.tickets.length) return b.tickets.length - a.tickets.length;
    if (a.mostRecentDate !== b.mostRecentDate) return a.mostRecentDate > b.mostRecentDate ? -1 : 1;
    return b.avgConfidence - a.avgConfidence;
  });

  clusters.forEach((c, i) => { c.id = i + 1; });

  return clusters;
}
