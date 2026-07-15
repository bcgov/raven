import type { Ticket } from '../types.js';

/**
 * Strips Jira wiki markup from a string, returning plain text.
 * Handles null/undefined input defensively (returns empty string).
 */
export function stripWikiMarkup(text: string): string {
  if (!text) return '';

  return text
    // headings: h1. through h6.
    .replace(/^h[1-6]\.\s*/gm, '')
    // bold
    .replace(/\*([^*]+)\*/g, '$1')
    // italic — only when underscores are NOT adjacent to word characters,
    // so identifiers like ABC_DEF_GHI or ORA_ERR_123 are preserved (otherwise
    // the inner _DEF_ would match and collapse the token's internals).
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    // links: [text|url] or [url]
    .replace(/\[([^|]+)\|[^\]]+\]/g, '$1')
    .replace(/\[([^\]]+)\]/g, '$1')
    // code blocks
    .replace(/\{code(?::[^}]*)?\}([\s\S]*?)\{code\}/g, '$1')
    // noformat blocks
    .replace(/\{noformat\}([\s\S]*?)\{noformat\}/g, '$1')
    // panels
    .replace(/\{panel(?::[^}]*)?\}([\s\S]*?)\{panel\}/g, '$1')
    // color macros
    .replace(/\{color:[^}]*\}([\s\S]*?)\{color\}/g, '$1')
    // superscript
    .replace(/\^([^^]+)\^/g, '$1')
    .trim();
}

interface RawIssueLink {
  type?: { name?: string };
  outwardIssue?: { key?: string };
  inwardIssue?: { key?: string };
}

/**
 * Parses a raw Jira API issue response into a normalised Ticket object.
 * All fields are extracted defensively — null/missing values fall back to
 * safe defaults so callers never receive undefined.
 */
export function parseRawTicket(raw: Record<string, unknown>): Ticket {
  const fields = (raw.fields ?? {}) as Record<string, unknown>;

  const issuelinks = (Array.isArray(fields.issuelinks) ? fields.issuelinks : []) as RawIssueLink[];
  const duplicateLinks: string[] = [];
  for (const link of issuelinks) {
    const typeName = link.type?.name?.toLowerCase() ?? '';
    if (typeName.includes('duplicate')) {
      if (link.outwardIssue?.key) duplicateLinks.push(link.outwardIssue.key);
      if (link.inwardIssue?.key) duplicateLinks.push(link.inwardIssue.key);
    }
  }

  const commentSection = fields.comment as Record<string, unknown> | null | undefined;
  const rawComments = (commentSection && Array.isArray(commentSection.comments)
    ? commentSection.comments
    : []) as Array<{ body?: string }>;
  const comments = rawComments
    .map((c) => stripWikiMarkup(c.body ?? ''))
    .filter((c) => c.length > 0);

  const rawComponents = (Array.isArray(fields.components) ? fields.components : []) as Array<{ name?: string }>;
  const priority = fields.priority as { name?: string } | null | undefined;
  const project = fields.project as { key?: string } | null | undefined;
  const issuetype = fields.issuetype as { name?: string } | null | undefined;
  const status = fields.status as { name?: string } | null | undefined;

  return {
    key: raw.key as string,
    project: project?.key ?? '',
    summary: (fields.summary as string) ?? '',
    description: stripWikiMarkup((fields.description as string) ?? ''),
    issueType: issuetype?.name ?? 'Unknown',
    labels: Array.isArray(fields.labels) ? (fields.labels as string[]) : [],
    components: rawComponents.map((c) => c.name ?? '').filter(Boolean),
    priority: priority?.name ?? 'Unknown',
    status: status?.name ?? 'Unknown',
    created: (fields.created as string) ?? '',
    resolved: (fields.resolutiondate as string) ?? null,
    comments,
    attachmentTexts: [],
    duplicateLinks,
  };
}
