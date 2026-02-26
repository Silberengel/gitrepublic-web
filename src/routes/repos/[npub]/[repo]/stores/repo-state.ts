/**
 * Repository page state management
 * Centralized state to prevent memory leaks and improve performance
 */

export interface RepoState {
  // Loading states
  loading: boolean;
  error: string | null;
  repoNotFound: boolean;
  
  // File system state
  files: Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }>;
  currentPath: string;
  currentFile: string | null;
  fileContent: string;
  fileLanguage: 'markdown' | 'asciidoc' | 'text';
  editedContent: string;
  hasChanges: boolean;
  saving: boolean;
  
  // Branch state
  branches: Array<string | { name: string; commit?: any }>;
  currentBranch: string | null;
  defaultBranch: string | null;
  
  // Commit state
  commitMessage: string;
  showCommitDialog: boolean;
  
  // User state
  userPubkey: string | null;
  userPubkeyHex: string | null;
  
  // UI state
  activeTab: 'files' | 'history' | 'tags' | 'issues' | 'prs' | 'docs' | 'discussions' | 'patches' | 'releases' | 'code-search';
  showRepoMenu: boolean;
  
  // Navigation
  pathStack: string[];
  
  // File creation
  showCreateFileDialog: boolean;
  newFileName: string;
  newFileContent: string;
  
  // Branch creation
  showCreateBranchDialog: boolean;
  newBranchName: string;
  newBranchFrom: string | null;
  defaultBranchName: string;
  
  // Commit history
  commits: Array<{
    hash: string;
    message: string;
    author: string;
    date: string;
    files: string[];
    verification?: {
      valid: boolean;
      hasSignature?: boolean;
      error?: string;
      pubkey?: string;
      npub?: string;
      authorName?: string;
      authorEmail?: string;
      timestamp?: number;
      eventId?: string;
    };
  }>;
  loadingCommits: boolean;
  selectedCommit: string | null;
  showDiff: boolean;
  diffData: Array<{ file: string; additions: number; deletions: number; diff: string }>;
  verifyingCommits: Set<string>;
  
  // Tags
  tags: Array<{ name: string; hash: string; message?: string; date?: number }>;
  selectedTag: string | null;
  showCreateTagDialog: boolean;
  newTagName: string;
  newTagMessage: string;
  newTagRef: string;
  
  // Maintainer state
  isMaintainer: boolean;
  loadingMaintainerStatus: boolean;
  allMaintainers: Array<{ pubkey: string; isOwner: boolean }>;
  loadingMaintainers: boolean;
  maintainersLoaded: boolean;
  
  // Clone state
  isRepoCloned: boolean | null;
  checkingCloneStatus: boolean;
  cloning: boolean;
  copyingCloneUrl: boolean;
  apiFallbackAvailable: boolean | null;
  
  // Editor state
  wordWrap: boolean;
  
  // Component lifecycle
  isMounted: boolean;
}

export function createRepoState(): RepoState {
  return {
    loading: true,
    error: null,
    repoNotFound: false,
    files: [],
    currentPath: '',
    currentFile: null,
    fileContent: '',
    fileLanguage: 'text',
    editedContent: '',
    hasChanges: false,
    saving: false,
    branches: [],
    currentBranch: null,
    defaultBranch: null,
    commitMessage: '',
    showCommitDialog: false,
    userPubkey: null,
    userPubkeyHex: null,
    activeTab: 'files',
    showRepoMenu: false,
    pathStack: [],
    showCreateFileDialog: false,
    newFileName: '',
    newFileContent: '',
    showCreateBranchDialog: false,
    newBranchName: '',
    newBranchFrom: null,
    defaultBranchName: 'master',
    commits: [],
    loadingCommits: false,
    selectedCommit: null,
    showDiff: false,
    diffData: [],
    verifyingCommits: new Set(),
    tags: [],
    selectedTag: null,
    showCreateTagDialog: false,
    newTagName: '',
    newTagMessage: '',
    newTagRef: 'HEAD',
    isMaintainer: false,
    loadingMaintainerStatus: false,
    allMaintainers: [],
    loadingMaintainers: false,
    maintainersLoaded: false,
    isRepoCloned: null,
    checkingCloneStatus: false,
    cloning: false,
    copyingCloneUrl: false,
    apiFallbackAvailable: null,
    wordWrap: false,
    isMounted: true
  };
}

/**
 * Safely update state only if component is still mounted
 */
export function safeStateUpdate<T>(
  isMounted: boolean,
  updateFn: () => T
): T | null {
  if (!isMounted) return null;
  try {
    return updateFn();
  } catch (err) {
    if (isMounted) {
      console.warn('State update error (component may be destroying):', err);
    }
    return null;
  }
}
