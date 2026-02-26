/**
 * Repository data hook
 * Manages loading and state for repository data
 */

import { page } from '$app/stores';
import type { RepoState } from '../stores/repo-state.js';
import logger from '$lib/services/logger.js';

export interface RepoPageData {
  title?: string;
  description?: string;
  image?: string;
  banner?: string;
  repoUrl?: string;
  announcement?: any;
  gitDomain?: string;
}

/**
 * Initialize repository data from page store
 */
export function useRepoData(
  state: RepoState,
  setPageData: (data: RepoPageData) => void
): void {
  // Update pageData from $page when available (client-side)
  if (typeof window === 'undefined' || !state.isMounted) return;
  
  try {
    page.subscribe(p => {
      if (p && state.isMounted) {
        const data = p.data as RepoPageData;
        if (data) {
          setPageData(data || {});
          logger.debug({ hasAnnouncement: !!data.announcement }, 'Page data loaded');
        }
      }
    });
  } catch (err) {
    if (state.isMounted) {
      logger.warn({ error: err }, 'Failed to update pageData');
    }
  }
}

/**
 * Extract repository parameters from page
 */
export function useRepoParams(
  state: RepoState,
  setNpub: (npub: string) => void,
  setRepo: (repo: string) => void
): void {
  if (typeof window === 'undefined' || !state.isMounted) return;
  
  try {
    page.subscribe(p => {
      if (p && state.isMounted) {
        const params = p.params as { npub?: string; repo?: string };
        if (params) {
          if (params.npub && params.npub !== state.npub) {
            setNpub(params.npub);
          }
          if (params.repo) {
            setRepo(params.repo);
          }
        }
      }
    });
  } catch {
    // If $page.params fails, try to parse from URL path
    if (!state.isMounted) return;
    try {
      if (typeof window !== 'undefined') {
        const pathParts = window.location.pathname.split('/').filter(Boolean);
        if (pathParts[0] === 'repos' && pathParts[1] && pathParts[2] && state.isMounted) {
          setNpub(pathParts[1]);
          setRepo(pathParts[2]);
        }
      }
    } catch {
      // Ignore errors - params will be set eventually
    }
  }
}
