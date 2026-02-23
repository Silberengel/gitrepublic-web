/**
 * Service for testing clone URL reachability
 * Checks if git clone URLs are accessible and responding
 */

import logger from '../logger.js';

/**
 * Git server type classification
 * 
 * Note: Both 'git' and 'grasp' servers use the same git smart HTTP protocol.
 * The distinction is informational:
 * - 'git': Regular git server (GitHub, GitLab, Gitea, etc.)
 * - 'grasp': GRASP server (git server + Nostr relay + GRASP features)
 * - 'unknown': Could not determine (shouldn't happen in practice)
 */
export type GitServerType = 'git' | 'grasp' | 'unknown';

export interface ReachabilityResult {
  url: string;
  reachable: boolean;
  error?: string;
  checkedAt: number;
  serverType: GitServerType;
}

/**
 * Check if a URL has npub in the path (potential GRASP server pattern)
 * Note: This alone doesn't make it a GRASP server - need to check relays tag too
 */
function hasNpubInPath(url: string): boolean {
  // GRASP URLs have npub (starts with npub1) in the path
  return /\/npub1[a-z0-9]+/i.test(url);
}

/**
 * Extract base domain from a URL (hostname without protocol)
 */
function getBaseDomain(url: string): string | null {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname;
  } catch {
    return null;
  }
}

/**
 * Extract base domain from a relay URL (wss:// or ws://)
 */
function getRelayBaseDomain(relayUrl: string): string | null {
  try {
    // Remove ws:// or wss:// prefix
    const httpUrl = relayUrl.replace(/^wss?:\/\//, 'https://');
    return getBaseDomain(httpUrl);
  } catch {
    return null;
  }
}

/**
 * Check if a clone URL's domain matches any relay URL from the relays tag
 * This is the proper way to identify GRASP servers per GRASP-01 spec
 */
function isGraspServer(cloneUrl: string, relayUrls: string[]): boolean {
  // Must have npub in path AND matching relay URL
  if (!hasNpubInPath(cloneUrl)) {
    return false;
  }
  
  const cloneDomain = getBaseDomain(cloneUrl);
  if (!cloneDomain) {
    return false;
  }
  
  // Check if any relay URL matches the clone URL's domain
  for (const relayUrl of relayUrls) {
    const relayDomain = getRelayBaseDomain(relayUrl);
    if (relayDomain && relayDomain === cloneDomain) {
      return true;
    }
  }
  
  return false;
}

/**
 * Detect server type from URL, response, and optional relays tags
 * 
 * Per GRASP-01 spec: A GRASP server is identified by:
 * 1. Clone URL pattern: [http|https]://<grasp-path>/<valid-npub>/<string>.git
 * 2. AND relays tag: [ws/wss]://<grasp-path> (matching the clone URL's domain)
 * 
 * Note: Both GRASP and regular git servers use the same git protocol.
 * We distinguish them for informational purposes (user awareness, future GRASP-specific features).
 * 
 * @param url - The clone URL
 * @param relayUrls - Optional array of relay URLs from the announcement's relays tag
 * @param response - Optional HTTP response (for future header-based detection)
 * @returns Server type: 'grasp' if both URL pattern and relay match, 'git' otherwise
 */
function detectServerType(
  url: string, 
  relayUrls?: string[], 
  response?: Response
): GitServerType {
  // If we have relay URLs, use proper GRASP detection
  if (relayUrls && relayUrls.length > 0) {
    if (isGraspServer(url, relayUrls)) {
      return 'grasp';
    }
  } else {
    // Fallback: if URL has npub but no relays context, we can't be sure
    // But we'll still check the pattern for informational purposes
    // (This handles cases where relays tag isn't available)
    if (hasNpubInPath(url)) {
      // Without relays tag, we can't definitively say it's GRASP
      // But it might be, so we'll mark it as 'git' (not GRASP) to be conservative
      // The CLI has better context, so it can make this determination
    }
  }
  
  // Could also check response headers for GRASP indicators in the future
  // (e.g., NIP-11 document, GRASP-specific headers)
  // For now, if it's not GRASP by proper detection, assume regular git server
  return 'git';
}

/**
 * Test if a clone URL is reachable
 * Attempts to connect to the URL and check if it responds
 * 
 * @param url - The clone URL to test
 * @param timeout - Timeout in milliseconds (default: 5000)
 * @param relayUrls - Optional array of relay URLs from announcement's relays tag (for GRASP detection)
 * @returns Promise resolving to reachability result
 */
export async function testCloneUrlReachability(
  url: string,
  timeout: number = 5000,
  relayUrls?: string[]
): Promise<ReachabilityResult> {
  const startTime = Date.now();
  
  try {
    // Parse URL to extract base URL for testing
    const urlObj = new URL(url);
    
    // For git URLs, we test the base domain
    // Try to fetch info/refs endpoint (lightweight git protocol check)
    const testUrl = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}/info/refs?service=git-upload-pack`;
    
    // Use AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    try {
      // Use fetch with timeout and proper error handling
      // Note: fetch is available in Node.js 18+ and browsers
      const response = await fetch(testUrl, {
        method: 'GET',
        signal: controller.signal,
        // Don't follow redirects - we want to know if the server responds
        redirect: 'manual',
        // Set a reasonable timeout
        headers: {
          'User-Agent': 'GitRepublic/1.0',
          'Accept': '*/*'
        }
      } as RequestInit);
      
      clearTimeout(timeoutId);
      
      // Consider reachable if we get any response (even 404 means server is up)
      // 200, 401, 403, 404 all mean the server is reachable
      // 500 might mean server is up but has issues, still consider reachable
      const isReachable = response.status < 600; // Any valid HTTP status means reachable
      
      // Detect server type
      const serverType = detectServerType(url, relayUrls, response);
      
      return {
        url,
        reachable: isReachable,
        error: isReachable ? undefined : `HTTP ${response.status}`,
        checkedAt: Date.now(),
        serverType
      };
    } catch (fetchError: unknown) {
      clearTimeout(timeoutId);
      
      // Handle abort (timeout)
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        const serverType = detectServerType(url, relayUrls);
        return {
          url,
          reachable: false,
          error: 'Timeout',
          checkedAt: Date.now(),
          serverType
        };
      }
      
      // Handle network errors
      if (fetchError instanceof TypeError) {
        // Usually means DNS resolution failed or connection refused
        const serverType = detectServerType(url, relayUrls);
        return {
          url,
          reachable: false,
          error: 'Network error (DNS or connection failed)',
          checkedAt: Date.now(),
          serverType
        };
      }
      
      // Other errors
      const serverType = detectServerType(url, relayUrls);
      return {
        url,
        reachable: false,
        error: fetchError instanceof Error ? fetchError.message : String(fetchError),
        checkedAt: Date.now(),
        serverType
      };
    }
  } catch (urlError) {
    // Invalid URL format
    const serverType = detectServerType(url, relayUrls);
    return {
      url,
      reachable: false,
      error: urlError instanceof Error ? urlError.message : 'Invalid URL format',
      checkedAt: Date.now(),
      serverType
    };
  }
}

/**
 * Test multiple clone URLs in parallel
 * 
 * @param urls - Array of clone URLs to test
 * @param timeout - Timeout per URL in milliseconds (default: 5000)
 * @param relayUrls - Optional array of relay URLs from announcement's relays tag (for GRASP detection)
 * @returns Promise resolving to array of reachability results
 */
export async function testCloneUrlsReachability(
  urls: string[],
  timeout: number = 5000,
  relayUrls?: string[]
): Promise<ReachabilityResult[]> {
  // Test all URLs in parallel
  const results = await Promise.allSettled(
    urls.map(url => testCloneUrlReachability(url, timeout, relayUrls))
  );
  
  // Convert settled results to reachability results
  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      const url = urls[index];
      return {
        url,
        reachable: false,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        checkedAt: Date.now(),
        serverType: detectServerType(url, relayUrls)
      };
    }
  });
}

/**
 * Cache for reachability results
 * Key: URL, Value: { result, expiresAt }
 */
const reachabilityCache = new Map<string, { result: ReachabilityResult; expiresAt: number }>();

/**
 * Cache duration: 5 minutes
 */
const CACHE_DURATION_MS = 5 * 60 * 1000;

/**
 * Get cached reachability result or test if not cached/expired
 * 
 * @param url - The clone URL to check
 * @param timeout - Timeout in milliseconds (default: 5000)
 * @param forceRefresh - Force refresh even if cached (default: false)
 * @param relayUrls - Optional array of relay URLs from announcement's relays tag (for GRASP detection)
 * @returns Promise resolving to reachability result
 */
export async function getCloneUrlReachability(
  url: string,
  timeout: number = 5000,
  forceRefresh: boolean = false,
  relayUrls?: string[]
): Promise<ReachabilityResult> {
  const now = Date.now();
  const cached = reachabilityCache.get(url);
  
  // Return cached result if valid and not forcing refresh
  // Note: We cache by URL only, so serverType might be incorrect if relayUrls change
  // But this is acceptable since relayUrls rarely change for a given repo
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return cached.result;
  }
  
  // Test reachability
  const result = await testCloneUrlReachability(url, timeout, relayUrls);
  
  // Cache the result
  reachabilityCache.set(url, {
    result,
    expiresAt: now + CACHE_DURATION_MS
  });
  
  return result;
}

/**
 * Get reachability for multiple URLs with caching
 * 
 * @param urls - Array of clone URLs to check
 * @param timeout - Timeout per URL in milliseconds (default: 5000)
 * @param forceRefresh - Force refresh even if cached (default: false)
 * @param relayUrls - Optional array of relay URLs from announcement's relays tag (for GRASP detection)
 * @returns Promise resolving to array of reachability results
 */
export async function getCloneUrlsReachability(
  urls: string[],
  timeout: number = 5000,
  forceRefresh: boolean = false,
  relayUrls?: string[]
): Promise<ReachabilityResult[]> {
  const now = Date.now();
  const results: ReachabilityResult[] = [];
  const urlsToTest: string[] = [];
  const urlIndices: number[] = [];
  
  // Check cache for each URL
  urls.forEach((url, index) => {
    const cached = reachabilityCache.get(url);
    
    if (!forceRefresh && cached && cached.expiresAt > now) {
      // Use cached result
      results[index] = cached.result;
    } else {
      // Need to test
      urlsToTest.push(url);
      urlIndices.push(index);
    }
  });
  
  // Test URLs that aren't cached
  if (urlsToTest.length > 0) {
    const testResults = await testCloneUrlsReachability(urlsToTest, timeout, relayUrls);
    
    // Store results and cache them
    testResults.forEach((result, testIndex) => {
      const originalIndex = urlIndices[testIndex];
      results[originalIndex] = result;
      
      // Cache the result
      reachabilityCache.set(result.url, {
        result,
        expiresAt: now + CACHE_DURATION_MS
      });
    });
  }
  
  return results;
}

/**
 * Clear reachability cache
 */
export function clearReachabilityCache(): void {
  reachabilityCache.clear();
}

/**
 * Clear expired entries from cache
 */
export function clearExpiredCacheEntries(): void {
  const now = Date.now();
  for (const [url, cached] of reachabilityCache.entries()) {
    if (cached.expiresAt <= now) {
      reachabilityCache.delete(url);
    }
  }
}
