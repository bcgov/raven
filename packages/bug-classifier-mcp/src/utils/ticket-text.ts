import type { Ticket } from '../types.js';

interface GetTextOptions {
  includeAttachments?: boolean;
}

/** Concatenate ticket text fields for analysis.
 *  Use includeAttachments: true for signals that should search attachment content. */
export function getTicketText(ticket: Ticket, opts: GetTextOptions = {}): string {
  const parts = [ticket.summary, ticket.description, ...ticket.comments];
  if (opts.includeAttachments) {
    parts.push(...ticket.attachmentTexts);
  }
  return parts.join(' ');
}
