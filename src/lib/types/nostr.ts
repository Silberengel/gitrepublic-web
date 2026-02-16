/**
 * Nostr type definitions
 */

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#e'?: string[];
  '#p'?: string[];
  '#d'?: string[];
  '#a'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}

export const KIND = {
  REPO_ANNOUNCEMENT: 30617,
  REPO_STATE: 30618,
  PATCH: 1617,
  PULL_REQUEST: 1618,
  PULL_REQUEST_UPDATE: 1619,
  ISSUE: 1621,
  STATUS_OPEN: 1630,
  STATUS_APPLIED: 1631,
  STATUS_CLOSED: 1632,
  STATUS_DRAFT: 1633,
  COMMIT_SIGNATURE: 1640, // Git commit signature event
  OWNERSHIP_TRANSFER: 1641, // Repository ownership transfer event (non-replaceable for chain integrity)
  HIGHLIGHT: 9802, // NIP-84: Highlight event
  COMMENT: 1111, // NIP-22: Comment event
} as const;

export interface Issue extends NostrEvent {
  kind: typeof KIND.ISSUE;
}

export interface PullRequest extends NostrEvent {
  kind: typeof KIND.PULL_REQUEST;
}

export interface StatusEvent extends NostrEvent {
  kind: typeof KIND.STATUS_OPEN | typeof KIND.STATUS_APPLIED | typeof KIND.STATUS_CLOSED | typeof KIND.STATUS_DRAFT;
}
