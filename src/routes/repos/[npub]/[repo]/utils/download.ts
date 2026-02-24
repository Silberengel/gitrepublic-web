/**
 * Download utility for repository downloads
 * Handles downloading repository archives with proper error handling and logging
 */

import { get } from 'svelte/store';
import { userStore } from '$lib/stores/user-store.js';
import logger from '$lib/services/logger.js';

interface DownloadOptions {
  npub: string;
  repo: string;
  ref?: string;
  filename?: string;
}

let isDownloading = false;

/**
 * Builds API headers with user pubkey for authenticated requests
 */
function buildApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const currentUser = get(userStore);
  const currentUserPubkeyHex = currentUser?.userPubkeyHex;
  if (currentUserPubkeyHex) {
    headers['X-User-Pubkey'] = currentUserPubkeyHex;
    logger.debug({ pubkey: currentUserPubkeyHex.substring(0, 16) + '...' }, '[Download] Sending X-User-Pubkey header');
  } else {
    logger.debug('[Download] No user pubkey available, sending request without X-User-Pubkey header');
  }
  return headers;
}

/**
 * Downloads a repository archive (ZIP or TAR.GZ)
 * @param options Download options including npub, repo, ref, and filename
 * @returns Promise that resolves when download is initiated
 */
export async function downloadRepository(options: DownloadOptions): Promise<void> {
  const { npub, repo, ref, filename } = options;
  
  if (typeof window === 'undefined') {
    logger.warn('[Download] Attempted download in SSR context');
    return;
  }

  // Prevent multiple simultaneous downloads
  if (isDownloading) {
    logger.debug('[Download] Download already in progress, skipping...');
    return;
  }
  isDownloading = true;
  
  // Prevent page navigation during download
  const preventReloadHandler = (e: BeforeUnloadEvent) => {
    if (!isDownloading) {
      return;
    }
    e.preventDefault();
    e.returnValue = '';
    return '';
  };
  
  window.addEventListener('beforeunload', preventReloadHandler);

  try {
    // Build download URL
    const params = new URLSearchParams();
    if (ref) {
      params.set('ref', ref);
    }
    params.set('format', 'zip');
    const downloadUrl = `/api/repos/${npub}/${repo}/download?${params.toString()}`;
    
    logger.info({ url: downloadUrl, ref }, '[Download] Starting download');
    
    // Fetch with proper headers
    const response = await fetch(downloadUrl, {
      method: 'GET',
      credentials: 'same-origin',
      headers: buildApiHeaders()
    });
    
    logger.debug({ status: response.status, statusText: response.statusText }, '[Download] Response received');
    
    if (!response.ok) {
      // Try to get error message from response
      let errorMessage = `Download failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.message) {
          errorMessage = errorData.message;
        } else if (errorData.error) {
          errorMessage = errorData.error;
        }
      } catch {
        // If response is not JSON, use status text
        try {
          const text = await response.text();
          if (text) {
            errorMessage = text.substring(0, 200); // Limit length
          }
        } catch {
          // Ignore text parsing errors
        }
      }
      logger.error({ error: errorMessage, status: response.status }, '[Download] Download failed');
      throw new Error(errorMessage);
    }
    
    // Check content type
    const contentType = response.headers.get('content-type');
    if (!contentType || (!contentType.includes('zip') && !contentType.includes('octet-stream'))) {
      logger.warn({ contentType }, '[Download] Unexpected content type');
    }
    
    logger.debug('[Download] Converting to blob...');
    const blob = await response.blob();
    logger.debug({ size: blob.size }, '[Download] Blob created');
    
    if (blob.size === 0) {
      throw new Error('Downloaded file is empty');
    }
    
    // Use File System Access API if available (most reliable, no navigation)
    const downloadFileName = filename || `${repo}${ref ? `-${ref}` : ''}.zip`;
    
    if ('showSaveFilePicker' in window) {
      try {
        // @ts-ignore - File System Access API
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: downloadFileName,
          types: [{
            description: 'ZIP files',
            accept: { 'application/zip': ['.zip'] }
          }]
        });
        
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        
        logger.info('[Download] File saved using File System Access API');
        return; // Success, exit early - no navigation possible
      } catch (saveErr: any) {
        // User cancelled or API not fully supported
        if (saveErr.name === 'AbortError') {
          logger.debug('[Download] User cancelled file save');
          return;
        }
        logger.debug({ error: saveErr }, '[Download] File System Access API failed, using fallback');
      }
    }
    
    // Use direct link method (more reliable, works with CSP)
    const url = window.URL.createObjectURL(blob);
    logger.debug('[Download] Created blob URL, using direct link method');
    
    // Create a temporary link element and trigger download
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadFileName;
    link.style.display = 'none';
    link.setAttribute('download', downloadFileName); // Ensure download attribute is set
    
    // Append to body temporarily
    document.body.appendChild(link);
    
    // Use requestAnimationFrame to ensure DOM is ready
    requestAnimationFrame(() => {
      try {
        // Trigger click
        link.click();
        logger.debug('[Download] Download triggered via direct link');
        
        // Clean up after a short delay
        setTimeout(() => {
          try {
            if (link.parentNode) {
              document.body.removeChild(link);
            }
            // Revoke blob URL after a delay to ensure download started
            setTimeout(() => {
              window.URL.revokeObjectURL(url);
              logger.debug('[Download] Cleaned up link and blob URL');
            }, 1000);
          } catch (cleanupErr) {
            logger.error({ error: cleanupErr }, '[Download] Cleanup error');
            // Still try to revoke the URL
            try {
              window.URL.revokeObjectURL(url);
            } catch (revokeErr) {
              logger.error({ error: revokeErr }, '[Download] Failed to revoke blob URL');
            }
          }
        }, 100);
      } catch (clickErr) {
        logger.error({ error: clickErr }, '[Download] Error triggering download');
        // Clean up on error
        try {
          if (link.parentNode) {
            document.body.removeChild(link);
          }
          window.URL.revokeObjectURL(url);
        } catch (cleanupErr) {
          logger.error({ error: cleanupErr }, '[Download] Cleanup error after click failure');
        }
        throw new Error('Failed to trigger download');
      }
    });
    
    logger.info('[Download] Download initiated successfully');
  } catch (err) {
    logger.error({ error: err, npub, repo, ref }, '[Download] Download error');
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Show user-friendly error message
    alert(`Download failed: ${errorMessage}`);
    // Don't re-throw - handle error gracefully to prevent page navigation issues
  } finally {
    // Remove beforeunload listener
    try {
      window.removeEventListener('beforeunload', preventReloadHandler);
    } catch (removeErr) {
      logger.warn({ error: removeErr }, '[Download] Error removing beforeunload listener');
    }
    
    // Reset download flag after a delay
    setTimeout(() => {
      isDownloading = false;
    }, 3000); // Longer delay to ensure download completed
  }
  
}
