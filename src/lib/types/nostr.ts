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
  '#e'?: string[]; // Lowercase: event references (parent in NIP-22)
  '#p'?: string[]; // Lowercase: pubkey references (parent in NIP-22)
  '#d'?: string[];
  '#a'?: string[]; // Lowercase: address references (parent in NIP-22)
  '#E'?: string[]; // Uppercase: root event references (NIP-22)
  '#K'?: string[]; // Uppercase: root kind references (NIP-22)
  '#P'?: string[]; // Uppercase: root pubkey references (NIP-22)
  '#A'?: string[]; // Uppercase: root address references (NIP-22)
  '#I'?: string[]; // Uppercase: root I-tag references (NIP-22)
  '#i'?: string[]; // Lowercase: parent I-tag references (NIP-22)
  '#q'?: string[]; // Quoted event references (NIP-18, NIP-21, NIP-22, NIP-24)
  since?: number;
  until?: number;
  limit?: number;
  search?: string; // NIP-50: Search capability
}

export const KIND = {
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
  THREAD: 11, // NIP-7D: Discussion thread
  BRANCH_PROTECTION: 30620, // Custom: Branch protection rules
  RELAY_LIST: 10002, // NIP-65: Relay list metadata
  BOOKMARKS: 10003, // NIP-51: Bookmarks list
  NIP98_AUTH: 27235, // NIP-98: HTTP authentication event
  HIGHLIGHT: 9802, // NIP-84: Highlight event
  PUBLIC_MESSAGE: 24, // NIP-24: Public message (direct chat)
  PROFILE_METADATA: 0, // NIP-01: User metadata
  REPOST: 6, // NIP-18: Repost
} as const;

/**
 * Kind range definitions per NIP-01
 * https://github.com/nostr-protocol/nips/blob/master/01.md
 */
export const KIND_RANGES = {
  /**
   * Regular events: 1000 <= n < 10000 || 4 <= n < 45 || n == 1 || n == 2
   * All expected to be stored by relays
   * Note: Special cases and ranges are handled in isRegularKind()
   */
  REGULAR: {
    MIN: 1,
    MAX: 9999,
    // Special cases: n == 1 || n == 2
    // Ranges: 4 <= n < 45, 1000 <= n < 10000
    // (handled separately in isRegularKind())
  },
  /**
   * Replaceable events: 10000 <= n < 20000 || n == 0 || n == 3
   * Only the latest event for each (pubkey, kind) combination is stored
   * Note: Special cases n == 0 and n == 3 are handled separately in isReplaceableKind()
   */
  REPLACEABLE: {
    MIN: 10000,
    MAX: 19999,
    // Special cases: n == 0 || n == 3 (handled separately in isReplaceableKind())
    // Continuous range: 10000 <= n < 20000
  },
  /**
   * Ephemeral events: 20000 <= n < 30000
   * Not expected to be stored by relays
   */
  EPHEMERAL: {
    MIN: 20000,
    MAX: 29999,
  },
  /**
   * Addressable events: 30000 <= n < 40000
   * Addressable by (kind, pubkey, d-tag), only latest stored
   */
  ADDRESSABLE: {
    MIN: 30000,
    MAX: 39999,
  },
} as const;

/**
 * Check if a kind is in the regular range per NIP-01
 */
export function isRegularKind(kind: number): boolean {
  return (
    kind === 1 ||
    kind === 2 ||
    (kind >= 4 && kind < 45) ||
    (kind >= 1000 && kind < 10000)
  );
}

/**
 * Check if a kind is replaceable per NIP-01
 */
export function isReplaceableKind(kind: number): boolean {
  return (
    kind === 0 ||
    kind === 3 ||
    (kind >= 10000 && kind < 20000)
  );
}

/**
 * Check if a kind is ephemeral per NIP-01
 */
export function isEphemeralKind(kind: number): boolean {
  return kind >= KIND_RANGES.EPHEMERAL.MIN && kind < KIND_RANGES.EPHEMERAL.MAX;
}

/**
 * Check if a kind is addressable per NIP-01
 */
export function isAddressableKind(kind: number): boolean {
  return kind >= KIND_RANGES.ADDRESSABLE.MIN && kind < KIND_RANGES.ADDRESSABLE.MAX;
}

export interface Issue extends NostrEvent {
  kind: typeof KIND.ISSUE;
}

export interface PullRequest extends NostrEvent {
  kind: typeof KIND.PULL_REQUEST;
}

export interface StatusEvent extends NostrEvent {
  kind: typeof KIND.STATUS_OPEN | typeof KIND.STATUS_APPLIED | typeof KIND.STATUS_CLOSED | typeof KIND.STATUS_DRAFT;
}
