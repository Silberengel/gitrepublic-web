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
  since?: number;
  until?: number;
  limit?: number;
}

export const KIND = {
  REPO_ANNOUNCEMENT: 30617,
} as const;
