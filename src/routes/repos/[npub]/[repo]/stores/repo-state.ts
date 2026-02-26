/**
 * Repository page state management
 * Optimized: Consolidated redundant patterns, grouped related data
 * Uses runes-compatible structure for $state
 */

import type { NostrEvent } from '$lib/types/nostr.js';

// Consolidated loading states - more efficient than individual flags
export interface LoadingStates {
  main: boolean;
  readme: boolean;
  commits: boolean;
  issues: boolean;
  issueReplies: boolean;
  prs: boolean;
  patches: boolean;
  patchHighlights: boolean;
  docs: boolean;
  discussions: boolean;
  releases: boolean;
  codeSearch: boolean;
  bookmark: boolean;
  maintainerStatus: boolean;
  maintainers: boolean;
  reachability: boolean;
  verification: boolean;
  repoNotFound: boolean;
}

// Consolidated dialog states - single source of truth
export type DialogType = 
  | 'createFile' 
  | 'createBranch' 
  | 'createTag' 
  | 'createRelease' 
  | 'createIssue' 
  | 'createPR' 
  | 'createPatch' 
  | 'createThread' 
  | 'reply' 
  | 'commit' 
  | 'verification' 
  | 'cloneUrlVerification' 
  | 'patchHighlight' 
  | 'patchComment'
  | null;

// Consolidated selected items
export interface SelectedItems {
  commit: string | null;
  tag: string | null;
  issue: string | null;
  pr: string | null;
  patch: string | null;
  discussion: string | null;
}

// Form data grouped by domain
export interface FileFormData {
  fileName: string;
  content: string;
}

export interface BranchFormData {
  name: string;
  from: string | null;
  defaultName: string;
}

export interface TagFormData {
  name: string;
  message: string;
  ref: string;
}

export interface IssueFormData {
  subject: string;
  content: string;
  labels: string[];
}

export interface PRFormData {
  subject: string;
  content: string;
  commitId: string;
  branchName: string;
  labels: string[];
}

export interface PatchFormData {
  content: string;
  subject: string;
}

export interface ReleaseFormData {
  tagName: string;
  tagHash: string;
  notes: string;
  isDraft: boolean;
  isPrerelease: boolean;
}

export interface DiscussionFormData {
  threadTitle: string;
  threadContent: string;
  replyContent: string;
}

export interface PatchHighlightFormData {
  text: string;
  startLine: number;
  endLine: number;
  startPos: number;
  endPos: number;
  comment: string;
}

export interface PatchCommentFormData {
  content: string;
  replyingTo: string | null;
}

// Status update tracking
export interface StatusUpdates {
  issue: Record<string, boolean>;
  patch: Record<string, boolean>;
}

// Main state interface
export interface RepoState {
  // Page/routing
  pageData: {
    title?: string;
    description?: string;
    image?: string;
    banner?: string;
    repoUrl?: string;
    announcement?: NostrEvent;
    gitDomain?: string;
  };
  npub: string;
  repo: string;
  
  // Core loading/error
  loading: LoadingStates;
  error: string | null;
  repoNotFound: boolean;
  
  // File system
  files: {
    list: Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }>;
    currentPath: string;
    currentFile: string | null;
    content: string;
    language: 'markdown' | 'asciidoc' | 'text';
    editedContent: string;
    hasChanges: boolean;
    pathStack: string[];
  };
  
  // File preview/display
  preview: {
    readme: {
      content: string | null;
      path: string | null;
      isMarkdown: boolean;
      html: string;
    };
    file: {
      highlightedContent: string;
      html: string;
      showPreview: boolean;
      isImage: boolean;
      imageUrl: string | null;
    };
    copying: boolean;
  };
  
  // Git operations
  git: {
    branches: Array<string | { name: string; commit?: any }>;
    currentBranch: string | null;
    defaultBranch: string | null;
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
    selectedCommit: string | null;
    showDiff: boolean;
    diffData: Array<{ file: string; additions: number; deletions: number; diff: string }>;
    verifyingCommits: Set<string>;
    tags: Array<{ name: string; hash: string; message?: string; date?: number }>;
    selectedTag: string | null;
  };
  
  // Forms
  forms: {
    file: FileFormData;
    branch: BranchFormData;
    tag: TagFormData;
    issue: IssueFormData;
    pr: PRFormData;
    patch: PatchFormData;
    release: ReleaseFormData;
    discussion: DiscussionFormData;
    patchHighlight: PatchHighlightFormData;
    patchComment: PatchCommentFormData;
    commit: {
      message: string;
    };
  };
  
  // Data collections
  issues: Array<{
    id: string;
    subject: string;
    content: string;
    status: string;
    author: string;
    created_at: number;
    kind: number;
    tags?: string[][];
  }>;
  issueReplies: Array<{
    id: string;
    content: string;
    author: string;
    created_at: number;
    tags: string[][];
  }>;
  
  prs: Array<{
    id: string;
    subject: string;
    content: string;
    status: string;
    author: string;
    created_at: number;
    commitId?: string;
    kind: number;
  }>;
  
  patches: Array<{
    id: string;
    subject: string;
    content: string;
    status: string;
    author: string;
    created_at: number;
    kind: number;
    description?: string;
    tags?: string[][];
  }>;
  
  patchHighlights: Array<{
    id: string;
    content: string;
    pubkey: string;
    created_at: number;
    highlightedContent?: string;
    file?: string;
    lineStart?: number;
    lineEnd?: number;
    comment?: string;
    comments?: Array<{
      id: string;
      content: string;
      pubkey: string;
      created_at: number;
      [key: string]: unknown;
    }>;
    sourceEventId?: string;
    [key: string]: unknown;
  }>;
  
  patchComments: Array<{
    id: string;
    content: string;
    pubkey: string;
    created_at: number;
    [key: string]: unknown;
  }>;
  
  discussions: Array<{
    type: 'thread' | 'comments';
    id: string;
    title: string;
    content: string;
    author: string;
    createdAt: number;
    kind?: number;
    pubkey?: string;
    comments?: Array<{
      id: string;
      content: string;
      author: string;
      createdAt: number;
      kind?: number;
      pubkey?: string;
      replies?: Array<{
        id: string;
        content: string;
        author: string;
        createdAt: number;
        kind?: number;
        pubkey?: string;
        replies?: Array<{
          id: string;
          content: string;
          author: string;
          createdAt: number;
          kind?: number;
          pubkey?: string;
        }>;
      }>;
    }>;
  }>;
  
  releases: Array<{
    id: string;
    tagName: string;
    tagHash?: string;
    releaseNotes?: string;
    isDraft?: boolean;
    isPrerelease?: boolean;
    created_at: number;
    pubkey: string;
  }>;
  
  // Status updates
  statusUpdates: StatusUpdates;
  
  // Selected items
  selected: SelectedItems;
  
  // Dialog state
  openDialog: DialogType;
  
  // Creating flags (consolidated)
  creating: {
    patch: boolean;
    thread: boolean;
    reply: boolean;
    release: boolean;
    patchHighlight: boolean;
    patchComment: boolean;
    announcement: boolean;
  };
  
  // User state
  user: {
    pubkey: string | null;
    pubkeyHex: string | null;
  };
  
  // UI state
  ui: {
    activeTab: 'files' | 'history' | 'tags' | 'issues' | 'prs' | 'docs' | 'discussions' | 'patches' | 'releases' | 'code-search';
    showRepoMenu: boolean;
    showFileListOnMobile: boolean;
    showLeftPanelOnMobile: boolean;
    wordWrap: boolean;
    expandedThreads: Set<string>;
  };
  
  // Maintainer state
  maintainers: {
    isMaintainer: boolean;
    all: Array<{ pubkey: string; isOwner: boolean }>;
    loaded: boolean;
    effectRan: boolean;
    lastRepoKey: string | null;
  };
  
  // Clone state
  clone: {
    isCloned: boolean | null;
    checking: boolean;
    cloning: boolean;
    copyingUrl: boolean;
    apiFallbackAvailable: boolean | null;
    urlsExpanded: boolean;
    showAllUrls: boolean;
    reachability: Map<string, { reachable: boolean; error?: string; checkedAt: number; serverType: 'git' | 'grasp' | 'unknown' }>;
    checkingReachability: Set<string>;
  };
  
  // Verification
  verification: {
    status: {
      verified: boolean;
      error?: string;
      message?: string;
      cloneVerifications?: Array<{ url: string; verified: boolean; ownerPubkey: string | null; error?: string }>;
    } | null;
    fileContent: string | null;
    selectedCloneUrl: string | null;
  };
  
  // Documentation
  docs: {
    content: string | null;
    html: string | null;
    kind: number | null;
  };
  
  // Code search
  codeSearch: {
    query: string;
    results: Array<{
      file: string;
      line: number;
      content: string;
      branch?: string;
      repo?: string;
    }>;
    scope: 'repo' | 'all';
  };
  
  // Fork/Bookmark
  fork: {
    info: { isFork: boolean; originalRepo: { npub: string; repo: string } | null } | null;
    forking: boolean;
  };
  bookmark: {
    isBookmarked: boolean;
  };
  
  // Repo metadata
  metadata: {
    address: string | null;
    image: string | null;
    banner: string | null;
    ownerPubkey: string | null;
    readmeAutoLoadAttempted: boolean;
  };
  
  // Discussion state
  discussion: {
    replyingToThread: { id: string; kind?: number; pubkey?: string; author: string } | null;
    replyingToComment: { id: string; kind?: number; pubkey?: string; author: string } | null;
    events: Map<string, NostrEvent>;
    nostrLinkEvents: Map<string, NostrEvent>;
    nostrLinkProfiles: Map<string, string>; // npub -> pubkey hex
  };
  
  // Patch editor
  patchEditor: any; // CodeEditor component instance
  
  // Operations
  saving: boolean;
  
  // Component lifecycle
  isMounted: boolean;
}

export function createRepoState(): RepoState {
  return {
    pageData: {},
    npub: '',
    repo: '',
    loading: {
      main: true,
      readme: false,
      commits: false,
      issues: false,
      issueReplies: false,
      prs: false,
      patches: false,
      patchHighlights: false,
      docs: false,
      discussions: false,
      releases: false,
      codeSearch: false,
      bookmark: false,
      maintainerStatus: false,
      maintainers: false,
      reachability: false,
      verification: false,
      repoNotFound: false
    },
    error: null,
    repoNotFound: false,
    files: {
      list: [],
      currentPath: '',
      currentFile: null,
      content: '',
      language: 'text',
      editedContent: '',
      hasChanges: false,
      pathStack: []
    },
    preview: {
      readme: {
        content: null,
        path: null,
        isMarkdown: false,
        html: ''
      },
      file: {
        highlightedContent: '',
        html: '',
        showPreview: true,
        isImage: false,
        imageUrl: null
      },
      copying: false
    },
    git: {
      branches: [],
      currentBranch: null,
      defaultBranch: null,
      commits: [],
      selectedCommit: null,
      showDiff: false,
      diffData: [],
      verifyingCommits: new Set(),
      tags: [],
      selectedTag: null
    },
    forms: {
      file: { fileName: '', content: '' },
      branch: { name: '', from: null, defaultName: 'master' },
      tag: { name: '', message: '', ref: 'HEAD' },
      issue: { subject: '', content: '', labels: [''] },
      pr: { subject: '', content: '', commitId: '', branchName: '', labels: [''] },
      patch: { content: '', subject: '' },
      release: { tagName: '', tagHash: '', notes: '', isDraft: false, isPrerelease: false },
      discussion: { threadTitle: '', threadContent: '', replyContent: '' },
      patchHighlight: { text: '', startLine: 0, endLine: 0, startPos: 0, endPos: 0, comment: '' },
      patchComment: { content: '', replyingTo: null },
      commit: { message: '' }
    },
    issues: [],
    issueReplies: [],
    prs: [],
    patches: [],
    patchHighlights: [],
    patchComments: [],
    discussions: [],
    releases: [],
    statusUpdates: {
      issue: {},
      patch: {}
    },
    selected: {
      commit: null,
      tag: null,
      issue: null,
      pr: null,
      patch: null,
      discussion: null
    },
    openDialog: null,
    creating: {
      patch: false,
      thread: false,
      reply: false,
      release: false,
      patchHighlight: false,
      patchComment: false,
      announcement: false
    },
    user: {
      pubkey: null,
      pubkeyHex: null
    },
    ui: {
      activeTab: 'files',
      showRepoMenu: false,
      showFileListOnMobile: true,
      showLeftPanelOnMobile: true,
      wordWrap: false,
      expandedThreads: new Set()
    },
    maintainers: {
      isMaintainer: false,
      all: [],
      loaded: false,
      effectRan: false,
      lastRepoKey: null
    },
    clone: {
      isCloned: null,
      checking: false,
      cloning: false,
      copyingUrl: false,
      apiFallbackAvailable: null,
      urlsExpanded: false,
      showAllUrls: false,
      reachability: new Map(),
      checkingReachability: new Set()
    },
    verification: {
      status: null,
      fileContent: null,
      selectedCloneUrl: null
    },
    docs: {
      content: null,
      html: null,
      kind: null
    },
    codeSearch: {
      query: '',
      results: [],
      scope: 'repo'
    },
    fork: {
      info: null,
      forking: false
    },
    bookmark: {
      isBookmarked: false
    },
    metadata: {
      address: null,
      image: null,
      banner: null,
      ownerPubkey: null,
      readmeAutoLoadAttempted: false
    },
    discussion: {
      replyingToThread: null,
      replyingToComment: null,
      events: new Map(),
      nostrLinkEvents: new Map(),
      nostrLinkProfiles: new Map()
    },
    patchEditor: null,
    saving: false,
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
