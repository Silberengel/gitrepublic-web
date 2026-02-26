/**
 * Repository announcement utilities
 * Extracts and processes announcement data
 */

import type { NostrEvent } from '$lib/types/nostr.js';

export interface RepoAnnouncementData {
  name: string;
  description: string;
  cloneUrls: string[];
  maintainers: string[];
  ownerPubkey: string;
  language?: string;
  topics: string[];
  website?: string;
  isPrivate: boolean;
}

/**
 * Extract repository data from announcement event
 */
export function extractRepoData(
  announcement: NostrEvent | null | undefined,
  fallbackRepo: string
): RepoAnnouncementData {
  if (!announcement) {
    return {
      name: fallbackRepo,
      description: '',
      cloneUrls: [],
      maintainers: [],
      ownerPubkey: '',
      topics: [],
      isPrivate: false
    };
  }

  const name = announcement.tags.find((t: string[]) => t[0] === 'name')?.[1] || fallbackRepo;
  const description = announcement.tags.find((t: string[]) => t[0] === 'description')?.[1] || '';
  const cloneUrls = announcement.tags
    .filter((t: string[]) => t[0] === 'clone')
    .flatMap((t: string[]) => t.slice(1))
    .filter((url: string) => url && typeof url === 'string') as string[];
  const maintainers = announcement.tags
    .filter((t: string[]) => t[0] === 'maintainers')
    .flatMap((t: string[]) => t.slice(1))
    .filter((m: string) => m && typeof m === 'string') as string[];
  const ownerPubkey = announcement.pubkey || '';
  const language = announcement.tags.find((t: string[]) => t[0] === 'language')?.[1];
  const topics = announcement.tags
    .filter((t: string[]) => t[0] === 't' && t[1] !== 'private')
    .map((t: string[]) => t[1])
    .filter((t: string) => t && typeof t === 'string') as string[];
  const website = announcement.tags.find((t: string[]) => t[0] === 'website')?.[1];
  const isPrivate = announcement.tags.some((t: string[]) =>
    (t[0] === 'private' && t[1] === 'true') || (t[0] === 't' && t[1] === 'private')
  ) || false;

  return {
    name,
    description,
    cloneUrls,
    maintainers,
    ownerPubkey,
    language,
    topics,
    website,
    isPrivate
  };
}

/**
 * Get safe page URL for SSR
 */
export function getSafePageUrl(
  pageData: { repoUrl?: string } | null,
  fallback?: () => string
): string {
  try {
    if (pageData?.repoUrl && typeof pageData.repoUrl === 'string' && pageData.repoUrl.trim()) {
      return pageData.repoUrl;
    }
    
    if (typeof window === 'undefined') {
      return '';
    }
    
    if (fallback) {
      try {
        return fallback();
      } catch {
        return '';
      }
    }
    
    if (window?.location?.protocol && window?.location?.host && window?.location?.pathname) {
      return `${window.location.protocol}//${window.location.host}${window.location.pathname}`;
    }
    
    return '';
  } catch {
    return '';
  }
}

/**
 * Get Twitter card type based on image availability
 */
export function getTwitterCardType(
  banner?: string | null,
  image?: string | null
): 'summary_large_image' | 'summary' {
  try {
    const hasImage = (banner && typeof banner === 'string' && banner.trim()) ||
                     (image && typeof image === 'string' && image.trim());
    return hasImage ? 'summary_large_image' : 'summary';
  } catch {
    return 'summary';
  }
}
