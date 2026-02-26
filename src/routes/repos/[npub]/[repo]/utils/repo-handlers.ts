/**
 * Repository handler utilities
 * UI interaction handlers for repository operations
 */

import type { RepoState } from '../stores/repo-state.js';
import type { Page } from '@sveltejs/kit';

/**
 * Copy clone URL to clipboard
 */
export async function copyCloneUrl(
  state: RepoState,
  pageData: { gitDomain?: string } | undefined,
  pageUrl: Page['url'] | undefined
): Promise<void> {
  if (state.clone.copyingUrl) return;
  
  state.clone.copyingUrl = true;
  try {
    // Guard against SSR
    if (typeof window === 'undefined') return;
    if (!pageUrl) {
      return;
    }
    
    // Use gitDomain from page data if available, otherwise use current URL host
    // gitDomain is set from GIT_DOMAIN env var and is the actual production domain
    let host: string;
    let protocol: string;
    
    if (pageData?.gitDomain) {
      const gitDomain = pageData.gitDomain;
      // Check if gitDomain is localhost - if so, we should use the actual current domain
      const isLocalhost = gitDomain.startsWith('localhost') || gitDomain.startsWith('127.0.0.1');
      
      if (isLocalhost) {
        // During development, use the actual current domain from the URL
        host = pageUrl.host;
        protocol = pageUrl.protocol.slice(0, -1); // Remove trailing ":"
      } else {
        // Use the configured git domain (production)
        host = gitDomain;
        protocol = 'https'; // Production domains should use HTTPS
      }
    } else {
      // Fallback to current URL
      host = pageUrl.host;
      protocol = pageUrl.protocol.slice(0, -1);
    }
    
    // Use /api/git/ format for better compatibility with commit signing hook
    const cloneUrl = `${protocol}://${host}/api/git/${state.npub}/${state.repo}.git`;
    const cloneCommand = `git clone ${cloneUrl}`;
    
    // Try to use the Clipboard API
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(cloneCommand);
      alert(`Clone command copied to clipboard!\n\n${cloneCommand}`);
    } else {
      // Fallback: create a temporary textarea
      const textarea = document.createElement('textarea');
      textarea.value = cloneCommand;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      alert(`Clone command copied to clipboard!\n\n${cloneCommand}`);
    }
  } catch (err) {
    console.error('Failed to copy clone command:', err);
    alert('Failed to copy clone command to clipboard');
  } finally {
    state.clone.copyingUrl = false;
  }
}
