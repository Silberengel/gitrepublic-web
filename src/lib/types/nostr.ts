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
  search?: string; // NIP-50: Search capability
}

export const KIND = {
  TEXT_NOTE: 1, // NIP-01: Text note (used for relay write proof fallback)
  CONTACT_LIST: 3, // NIP-02: Contact list - See /docs for GitRepublic usage documentation
  DELETION_REQUEST: 5, // NIP-09: Event deletion request
  REPO_ANNOUNCEMENT: 30617, // NIP-34: Repository announcement
  REPO_STATE: 30618, // NIP-34: Repository state
  PATCH: 1617, // NIP-34: Git patch
  PULL_REQUEST: 1618, // NIP-34: Pull request
  PULL_REQUEST_UPDATE: 1619, // NIP-34: Pull request update
  ISSUE: 1621, // NIP-34: Issue
  STATUS_OPEN: 1630, // NIP-34: Status open
  STATUS_APPLIED: 1631, // NIP-34: Status applied/merged
  STATUS_CLOSED: 1632, // NIP-34: Status closed
  STATUS_DRAFT: 1633, // NIP-34: Status draft
  COMMIT_SIGNATURE: 1640, // Custom: Git commit signature event
  OWNERSHIP_TRANSFER: 1641, // Custom: Repository ownership transfer event (non-replaceable for chain integrity)
  COMMENT: 1111, // NIP-22: Comment event
  BRANCH_PROTECTION: 30620, // Custom: Branch protection rules
  RELAY_LIST: 10002, // NIP-65: Relay list metadata
  NIP98_AUTH: 27235, // NIP-98: HTTP authentication event
  HIGHLIGHT: 9802, // NIP-84: Highlight event
  PUBLIC_MESSAGE: 24, // NIP-24: Public message (direct chat)
  SSH_KEY_ATTESTATION: 30001, // Custom: SSH key attestation (server-side only, not published to relays)
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
