/**
 * Shared utility for triggering repo polls
 * This provides a consistent interface for triggering polls from anywhere in the codebase
 */

import { getRepoPollingService } from '../services/service-registry.js';
import logger from '../services/logger.js';

/**
 * Trigger a repo poll
 * This is the single source of truth for triggering polls
 * @param context Optional context string for logging (e.g., 'user-verification', 'manual-refresh')
 * @returns Promise that resolves when poll is triggered (not when it completes)
 */
export async function triggerRepoPoll(context?: string): Promise<void> {
  const pollingService = getRepoPollingService();
  
  if (!pollingService) {
    logger.warn({ context }, 'Poll request received but polling service not initialized');
    throw new Error('Polling service not available');
  }
  
  // Trigger poll asynchronously (non-blocking)
  // The poll will complete in the background
  pollingService.triggerPoll().catch((err) => {
    logger.error({ error: err, context }, 'Failed to trigger poll');
  });
  
  logger.info({ context }, 'Repo poll triggered');
}
