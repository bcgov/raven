import type { Cluster } from '../types.js';

interface ReportInput {
  clusters: Cluster[];
  projects: string[];
  totalTickets: number;
  /**
   * Tickets that aren't in any surviving cluster — includes both tickets
   * with no peer above threshold AND tickets dropped by oversized-cluster
   * pruning. "Unclustered" rather than "unmatched" because the latter
   * implies "no match found" which isn't true for the pruning case.
   */
  unclusteredCount: number;
  baseUrl?: string;
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Escape a value for safe insertion in a markdown table cell.
 * Jira summaries can contain pipe characters and newlines; emitted raw,
 * they break table column alignment for every subsequent row.
 */
export function escapeCell(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
}

const SIGNAL_LABELS: Record<string, string> = {
  textSimilarity: 'Text Similarity',
  errorPattern: 'Error Pattern',
  componentLabel: 'Component/Label',
  affectedArea: 'Affected Area',
  temporalProximity: 'Temporal Proximity',
};

export function generateReport(input: ReportInput): string {
  const { clusters, projects, totalTickets, unclusteredCount, baseUrl } = input;
  const now = new Date().toISOString().slice(0, 10);
  const crossProjectCount = clusters.filter((c) => c.isCrossProject).length;
  const clusteredCount = clusters.reduce((sum, c) => sum + c.tickets.length, 0);

  const lines: string[] = [];

  lines.push(`# Bug Pattern Analysis Report`);
  lines.push(`Generated: ${now} | Projects: ${projects.join(', ')} | ${totalTickets} tickets analyzed`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- ${totalTickets} tickets analyzed`);
  lines.push(`- ${clusters.length} cluster${clusters.length !== 1 ? 's' : ''} identified (${clusteredCount} tickets clustered)`);
  lines.push(`- ${crossProjectCount} cross-project cluster${crossProjectCount !== 1 ? 's' : ''}`);
  lines.push(`- ${unclusteredCount} unclustered tickets`);
  lines.push('');

  if (clusters.length === 0) {
    lines.push('No patterns detected in the analyzed tickets.');
    return lines.join('\n');
  }

  lines.push('---');
  lines.push('');

  for (const cluster of clusters) {
    const crossTag = cluster.isCrossProject ? ', cross-project' : '';
    lines.push(`## Cluster ${cluster.id} \u2014 ${cluster.title} (${cluster.tickets.length} tickets${crossTag})`);
    lines.push('');
    lines.push(`**Confidence:** ${cluster.confidenceLevel} (avg score ${cluster.avgConfidence.toFixed(2)})`);

    const clusterProjects = [...new Set(cluster.tickets.map((t) => t.project))];
    lines.push(`**Projects:** ${clusterProjects.join(', ')}`);
    lines.push(`**Probable cause:** ${cluster.probableCause}`);
    lines.push(`**Suggested action:** ${cluster.suggestedAction}`);

    const signalLabels = cluster.matchingSignals
      .map((s) => SIGNAL_LABELS[s] ?? s)
      .join(', ');
    lines.push(`**Matching signals:** ${signalLabels}`);
    lines.push('');

    lines.push('| Ticket | Project | Summary | Created | Status |');
    lines.push('|--------|---------|---------|---------|--------|');
    for (const t of cluster.tickets) {
      const normalizedUrl = baseUrl?.replace(/\/+$/, '');
      const ticketRef = normalizedUrl ? `[${t.key}](${normalizedUrl}/browse/${t.key})` : t.key;
      lines.push(`| ${ticketRef} | ${escapeCell(t.project)} | ${escapeCell(t.summary)} | ${formatDate(t.created)} | ${escapeCell(t.status)} |`);
    }

    lines.push('');
  }

  return lines.join('\n');
}
