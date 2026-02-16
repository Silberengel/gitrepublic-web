/**
 * Application configuration
 * Centralized config that can be overridden by environment variables
 */

/**
 * Git domain for repository URLs
 * Defaults to localhost:6543, can be overridden by GIT_DOMAIN env var
 */
export const GIT_DOMAIN = 
  typeof process !== 'undefined' && process.env?.GIT_DOMAIN
    ? process.env.GIT_DOMAIN
    : 'localhost:6543';

/**
 * Get the full git URL for a repository
 */
export function getGitUrl(npub: string, repoName: string): string {
  const protocol = GIT_DOMAIN.startsWith('localhost') ? 'http' : 'https';
  return `${protocol}://${GIT_DOMAIN}/${npub}/${repoName}.git`;
}
