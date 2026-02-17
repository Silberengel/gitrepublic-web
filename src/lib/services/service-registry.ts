/**
 * Service Registry
 * Provides singleton instances of commonly used services
 * Reduces memory usage and ensures consistent service configuration across API routes
 */

import { FileManager } from './git/file-manager.js';
import { RepoManager } from './git/repo-manager.js';
import { MaintainerService } from './nostr/maintainer-service.js';
import { NostrClient } from './nostr/nostr-client.js';
import { OwnershipTransferService } from './nostr/ownership-transfer-service.js';
import { BranchProtectionService } from './nostr/branch-protection-service.js';
import { IssuesService } from './nostr/issues-service.js';
import { ForkCountService } from './nostr/fork-count-service.js';
import { PRsService } from './nostr/prs-service.js';
import { HighlightsService } from './nostr/highlights-service.js';
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS } from '../config.js';

// Get repo root from environment or use default
const repoRoot = typeof process !== 'undefined' && process.env?.GIT_REPO_ROOT
  ? process.env.GIT_REPO_ROOT
  : '/repos';

// Lazy initialization - services are created on first access
let _fileManager: FileManager | null = null;
let _repoManager: RepoManager | null = null;
let _maintainerService: MaintainerService | null = null;
let _nostrClient: NostrClient | null = null;
let _nostrSearchClient: NostrClient | null = null;
let _ownershipTransferService: OwnershipTransferService | null = null;
let _branchProtectionService: BranchProtectionService | null = null;
let _issuesService: IssuesService | null = null;
let _forkCountService: ForkCountService | null = null;
let _prsService: PRsService | null = null;
let _highlightsService: HighlightsService | null = null;

/**
 * Get singleton FileManager instance
 */
export function getFileManager(): FileManager {
  if (!_fileManager) {
    _fileManager = new FileManager(repoRoot);
  }
  return _fileManager;
}

/**
 * Get singleton RepoManager instance
 */
export function getRepoManager(): RepoManager {
  if (!_repoManager) {
    _repoManager = new RepoManager(repoRoot);
  }
  return _repoManager;
}

/**
 * Get singleton MaintainerService instance
 */
export function getMaintainerService(): MaintainerService {
  if (!_maintainerService) {
    _maintainerService = new MaintainerService(DEFAULT_NOSTR_RELAYS);
  }
  return _maintainerService;
}

/**
 * Get singleton NostrClient instance (default relays)
 */
export function getNostrClient(): NostrClient {
  if (!_nostrClient) {
    _nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
  }
  return _nostrClient;
}

/**
 * Get singleton NostrClient instance (search relays)
 */
export function getNostrSearchClient(): NostrClient {
  if (!_nostrSearchClient) {
    _nostrSearchClient = new NostrClient(DEFAULT_NOSTR_SEARCH_RELAYS);
  }
  return _nostrSearchClient;
}

/**
 * Get singleton OwnershipTransferService instance
 */
export function getOwnershipTransferService(): OwnershipTransferService {
  if (!_ownershipTransferService) {
    _ownershipTransferService = new OwnershipTransferService(DEFAULT_NOSTR_RELAYS);
  }
  return _ownershipTransferService;
}

/**
 * Get singleton BranchProtectionService instance
 */
export function getBranchProtectionService(): BranchProtectionService {
  if (!_branchProtectionService) {
    _branchProtectionService = new BranchProtectionService(DEFAULT_NOSTR_RELAYS);
  }
  return _branchProtectionService;
}

/**
 * Get singleton IssuesService instance
 */
export function getIssuesService(): IssuesService {
  if (!_issuesService) {
    _issuesService = new IssuesService(DEFAULT_NOSTR_RELAYS);
  }
  return _issuesService;
}

/**
 * Get singleton ForkCountService instance
 */
export function getForkCountService(): ForkCountService {
  if (!_forkCountService) {
    _forkCountService = new ForkCountService(DEFAULT_NOSTR_RELAYS);
  }
  return _forkCountService;
}

/**
 * Get singleton PRsService instance
 */
export function getPRsService(): PRsService {
  if (!_prsService) {
    _prsService = new PRsService(DEFAULT_NOSTR_RELAYS);
  }
  return _prsService;
}

/**
 * Get singleton HighlightsService instance
 */
export function getHighlightsService(): HighlightsService {
  if (!_highlightsService) {
    _highlightsService = new HighlightsService(DEFAULT_NOSTR_RELAYS);
  }
  return _highlightsService;
}

// Convenience exports for direct access (common pattern)
export const fileManager = getFileManager();
export const repoManager = getRepoManager();
export const maintainerService = getMaintainerService();
export const nostrClient = getNostrClient();
export const nostrSearchClient = getNostrSearchClient();
export const ownershipTransferService = getOwnershipTransferService();
export const branchProtectionService = getBranchProtectionService();
export const issuesService = getIssuesService();
export const forkCountService = getForkCountService();
export const prsService = getPRsService();
export const highlightsService = getHighlightsService();
