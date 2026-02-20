<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import CodeEditor from '$lib/components/CodeEditor.svelte';
  import PRDetail from '$lib/components/PRDetail.svelte';
  import UserBadge from '$lib/components/UserBadge.svelte';
  import ForwardingConfig from '$lib/components/ForwardingConfig.svelte';
  import EventCopyButton from '$lib/components/EventCopyButton.svelte';
  import { getPublicKeyWithNIP07, isNIP07Available, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS, combineRelays } from '$lib/config.js';
  import { getUserRelays } from '$lib/services/nostr/user-relays.js';
  import { BookmarksService } from '$lib/services/nostr/bookmarks-service.js';
  import { KIND } from '$lib/types/nostr.js';
  import { nip19 } from 'nostr-tools';
  import { userStore } from '$lib/stores/user-store.js';
  import { generateVerificationFile, VERIFICATION_FILE_PATH } from '$lib/services/nostr/repo-verification.js';
  import type { NostrEvent } from '$lib/types/nostr.js';
  import { hasUnlimitedAccess } from '$lib/utils/user-access.js';

  // Get page data for OpenGraph metadata - use $derived to make it reactive
  const pageData = $derived($page.data as {
    title?: string;
    description?: string;
    image?: string;
    banner?: string;
    repoName?: string;
    repoDescription?: string;
    repoUrl?: string;
    repoCloneUrls?: string[];
    repoMaintainers?: string[];
    repoOwnerPubkey?: string;
    repoLanguage?: string;
    repoTopics?: string[];
    repoWebsite?: string;
    repoIsPrivate?: boolean;
    gitDomain?: string;
  });

  const npub = ($page.params as { npub?: string; repo?: string }).npub || '';
  const repo = ($page.params as { npub?: string; repo?: string }).repo || '';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let repoNotFound = $state(false); // Track if repository doesn't exist
  let files = $state<Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }>>([]);
  let currentPath = $state('');
  let currentFile = $state<string | null>(null);
  let fileContent = $state('');
  let fileLanguage = $state<'markdown' | 'asciidoc' | 'text'>('text');
  let editedContent = $state('');
  let hasChanges = $state(false);
  let saving = $state(false);
  let branches = $state<Array<string | { name: string; commit?: any }>>([]);
  let currentBranch = $state<string | null>(null);
  let defaultBranch = $state<string | null>(null);
  let commitMessage = $state('');
  let userPubkey = $state<string | null>(null);
  let userPubkeyHex = $state<string | null>(null);
  let showCommitDialog = $state(false);
  let activeTab = $state<'files' | 'history' | 'tags' | 'issues' | 'prs' | 'docs' | 'discussions'>('discussions');
  let showRepoMenu = $state(false);

  // Sync with userStore
  $effect(() => {
    const currentUser = $userStore;
    const wasLoggedIn = userPubkey !== null || userPubkeyHex !== null;
    
    if (currentUser.userPubkey && currentUser.userPubkeyHex) {
      const wasDifferent = userPubkey !== currentUser.userPubkey || userPubkeyHex !== currentUser.userPubkeyHex;
      userPubkey = currentUser.userPubkey;
      userPubkeyHex = currentUser.userPubkeyHex;
      
      // Reload data when user logs in or pubkey changes
      if (wasDifferent) {
        // Reset repoNotFound flag when user logs in, so we can retry loading
        repoNotFound = false;
        // Clear cached email and name when user changes
        cachedUserEmail = null;
        cachedUserName = null;
        
        checkMaintainerStatus().catch(err => console.warn('Failed to reload maintainer status after login:', err));
        loadBookmarkStatus().catch(err => console.warn('Failed to reload bookmark status after login:', err));
        // Recheck clone status after login (force refresh) - delay slightly to ensure auth headers are ready
        setTimeout(() => {
          checkCloneStatus(true).catch(err => console.warn('Failed to recheck clone status after login:', err));
        }, 100);
        // Reload all repository data with the new user context
        if (!loading) {
          loadBranches().catch(err => console.warn('Failed to reload branches after login:', err));
          loadFiles().catch(err => console.warn('Failed to reload files after login:', err));
          loadReadme().catch(err => console.warn('Failed to reload readme after login:', err));
          loadTags().catch(err => console.warn('Failed to reload tags after login:', err));
          // Reload discussions when user logs in (needs user context for relay selection)
          loadDiscussions().catch(err => console.warn('Failed to reload discussions after login:', err));
        }
      }
    } else {
      userPubkey = null;
      userPubkeyHex = null;
      // Clear cached email and name when user logs out
      cachedUserEmail = null;
      cachedUserName = null;
      
      // Reload data when user logs out to hide private content
      if (wasLoggedIn) {
        checkMaintainerStatus().catch(err => console.warn('Failed to reload maintainer status after logout:', err));
        loadBookmarkStatus().catch(err => console.warn('Failed to reload bookmark status after logout:', err));
        // If repo is private and user logged out, reload to trigger access check
        if (!loading && activeTab === 'files') {
          loadFiles().catch(err => console.warn('Failed to reload files after logout:', err));
        }
      }
    }
  });

  // Navigation stack for directories
  let pathStack = $state<string[]>([]);

  // New file creation
  let showCreateFileDialog = $state(false);
  let newFileName = $state('');
  let newFileContent = $state('');

  // Branch creation
  let showCreateBranchDialog = $state(false);
  let newBranchName = $state('');
  let newBranchFrom = $state<string | null>(null);

  // Commit history
  let commits = $state<Array<{ hash: string; message: string; author: string; date: string; files: string[] }>>([]);
  let loadingCommits = $state(false);
  let selectedCommit = $state<string | null>(null);
  let showDiff = $state(false);
  let diffData = $state<Array<{ file: string; additions: number; deletions: number; diff: string }>>([]);

  // Tags
  let tags = $state<Array<{ name: string; hash: string; message?: string }>>([]);
  let showCreateTagDialog = $state(false);
  let newTagName = $state('');
  let newTagMessage = $state('');
  let newTagRef = $state('HEAD');

  // Maintainer status
  let isMaintainer = $state(false);
  let loadingMaintainerStatus = $state(false);
  
  // Clone status
  let isRepoCloned = $state<boolean | null>(null); // null = unknown, true = cloned, false = not cloned
  let checkingCloneStatus = $state(false);
  let cloning = $state(false);
  let copyingCloneUrl = $state(false);
  
  // Helper: Check if repo needs to be cloned for write operations
  const needsClone = $derived(isRepoCloned === false);
  const cloneTooltip = 'Please clone this repo to use this feature.';
  
  // Copy clone URL to clipboard
  async function copyCloneUrl() {
    if (copyingCloneUrl) return;
    
    copyingCloneUrl = true;
    try {
      // Use the current page URL to get the correct host and port
      // This ensures we use the same domain/port the user is currently viewing
      const currentUrl = $page.url;
      const host = currentUrl.host; // Includes port if present (e.g., "localhost:5173")
      const protocol = currentUrl.protocol.slice(0, -1); // Remove trailing ":"
      
      // Use /api/git/ format for better compatibility with commit signing hook
      const cloneUrl = `${protocol}://${host}/api/git/${npub}/${repo}.git`;
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
      copyingCloneUrl = false;
    }
  }
  
  // Verification status
  let verificationStatus = $state<{ 
    verified: boolean; 
    error?: string; 
    message?: string;
    cloneVerifications?: Array<{ url: string; verified: boolean; ownerPubkey: string | null; error?: string }>;
  } | null>(null);
  let showVerificationDialog = $state(false);
  let verificationFileContent = $state<string | null>(null);
  let loadingVerification = $state(false);

  // Deletion request
  let deletingAnnouncement = $state(false);
  let announcementEventId = $state<string | null>(null);

  // Issues
  let issues = $state<Array<{ id: string; subject: string; content: string; status: string; author: string; created_at: number; kind: number }>>([]);
  let loadingIssues = $state(false);
  let showCreateIssueDialog = $state(false);
  let newIssueSubject = $state('');
  let newIssueContent = $state('');
  let newIssueLabels = $state<string[]>(['']);

  // Pull Requests
  let prs = $state<Array<{ id: string; subject: string; content: string; status: string; author: string; created_at: number; commitId?: string; kind: number }>>([]);
  let loadingPRs = $state(false);
  let showCreatePRDialog = $state(false);
  let newPRSubject = $state('');
  let newPRContent = $state('');
  let newPRCommitId = $state('');
  let newPRBranchName = $state('');
  let newPRLabels = $state<string[]>(['']);
  let selectedPR = $state<string | null>(null);

  // Documentation
  let documentationContent = $state<string | null>(null);
  let documentationHtml = $state<string | null>(null);
  let loadingDocs = $state(false);

  // Discussion threads
  let showCreateThreadDialog = $state(false);
  let newThreadTitle = $state('');
  let newThreadContent = $state('');
  let creatingThread = $state(false);
  
  // Thread replies
  let expandedThreads = $state<Set<string>>(new Set());
  let showReplyDialog = $state(false);
  let replyingToThread = $state<{ id: string; kind?: number; pubkey?: string; author: string } | null>(null);
  let replyingToComment = $state<{ id: string; kind?: number; pubkey?: string; author: string } | null>(null);
  let replyContent = $state('');
  let creatingReply = $state(false);

  // Discussions
  let discussions = $state<Array<{ 
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
    }> 
  }>>([]);
  let loadingDiscussions = $state(false);

  // README
  let readmeContent = $state<string | null>(null);
  let readmePath = $state<string | null>(null);
  let readmeIsMarkdown = $state(false);
  let loadingReadme = $state(false);
  let readmeHtml = $state<string>('');
  let highlightedFileContent = $state<string>('');

  // Fork
  let forkInfo = $state<{ isFork: boolean; originalRepo: { npub: string; repo: string } | null } | null>(null);
  let forking = $state(false);

  // Bookmarks
  let isBookmarked = $state(false);
  let loadingBookmark = $state(false);
  let bookmarksService: BookmarksService | null = null;
  let repoAddress = $state<string | null>(null);

  // Repository images
  let repoImage = $state<string | null>(null);
  let repoBanner = $state<string | null>(null);

  // Mobile view toggle for file list/file viewer
  let showFileListOnMobile = $state(true);

  async function loadReadme() {
    if (repoNotFound) return;
    loadingReadme = true;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/readme?ref=${currentBranch}`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        if (data.found) {
          readmeContent = data.content;
          readmePath = data.path;
          readmeIsMarkdown = data.isMarkdown;
          
          // Render markdown if needed
          if (readmeIsMarkdown && readmeContent) {
            const MarkdownIt = (await import('markdown-it')).default;
            const hljsModule = await import('highlight.js');
            const hljs = hljsModule.default || hljsModule;
            
            const md = new MarkdownIt({
              highlight: function (str: string, lang: string): string {
                if (lang && hljs.getLanguage(lang)) {
                  try {
                    return '<pre class="hljs"><code>' +
                           hljs.highlight(str, { language: lang }).value +
                           '</code></pre>';
                  } catch (err) {
                    // Fallback to escaped HTML if highlighting fails
                    // This is expected for unsupported languages
                  }
                }
                return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
              }
            });
            
            readmeHtml = md.render(readmeContent);
          }
        }
      }
    } catch (err) {
      console.error('Error loading README:', err);
    } finally {
      loadingReadme = false;
    }
  }

  // Map file extensions to highlight.js language names
  function getHighlightLanguage(ext: string): string {
    const langMap: Record<string, string> = {
      'js': 'javascript',
      'ts': 'typescript',
      'jsx': 'javascript',
      'tsx': 'typescript',
      'json': 'json',
      'css': 'css',
      'html': 'xml',
      'xml': 'xml',
      'yaml': 'yaml',
      'yml': 'yaml',
      'py': 'python',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'java': 'java',
      'c': 'c',
      'cpp': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
      'sh': 'bash',
      'bash': 'bash',
      'zsh': 'bash',
      'sql': 'sql',
      'php': 'php',
      'swift': 'swift',
      'kt': 'kotlin',
      'scala': 'scala',
      'r': 'r',
      'm': 'objectivec',
      'mm': 'objectivec',
      'vue': 'xml',
      'svelte': 'xml',
      'dockerfile': 'dockerfile',
      'toml': 'toml',
      'ini': 'ini',
      'conf': 'ini',
      'log': 'plaintext',
      'txt': 'plaintext',
      'md': 'markdown',
      'markdown': 'markdown',
      'mdown': 'markdown',
      'mkdn': 'markdown',
      'mkd': 'markdown',
      'mdwn': 'markdown',
      'adoc': 'asciidoc',
      'asciidoc': 'asciidoc',
      'ad': 'asciidoc',
    };
    return langMap[ext.toLowerCase()] || 'plaintext';
  }

  async function applySyntaxHighlighting(content: string, ext: string) {
    try {
      const hljsModule = await import('highlight.js');
      // highlight.js v11+ uses default export
      const hljs = hljsModule.default || hljsModule;
      const lang = getHighlightLanguage(ext);
      
      // Register Markdown language if needed (not in highlight.js by default)
      if (lang === 'markdown' && !hljs.getLanguage('markdown')) {
        hljs.registerLanguage('markdown', function(hljs) {
          return {
            name: 'Markdown',
            aliases: ['md', 'mkdown', 'mkd'],
            contains: [
              // Headers
              {
                className: 'section',
                begin: /^#{1,6}\s+/,
                relevance: 10
              },
              // Bold
              {
                className: 'strong',
                begin: /\*\*[^*]+\*\*/,
                relevance: 0
              },
              {
                className: 'strong',
                begin: /__[^_]+__/,
                relevance: 0
              },
              // Italic
              {
                className: 'emphasis',
                begin: /\*[^*]+\*/,
                relevance: 0
              },
              {
                className: 'emphasis',
                begin: /_[^_]+_/,
                relevance: 0
              },
              // Inline code
              {
                className: 'code',
                begin: /`[^`]+`/,
                relevance: 0
              },
              // Code blocks
              {
                className: 'code',
                begin: /^```[\w]*/,
                end: /^```$/,
                contains: [{ begin: /./ }]
              },
              // Links
              {
                className: 'link',
                begin: /\[/,
                end: /\]/,
                contains: [
                  {
                    className: 'string',
                    begin: /\(/,
                    end: /\)/
                  }
                ]
              },
              // Images
              {
                className: 'string',
                begin: /!\[/,
                end: /\]/
              },
              // Lists
              {
                className: 'bullet',
                begin: /^(\s*)([*+-]|\d+\.)\s+/,
                relevance: 0
              },
              // Blockquotes
              {
                className: 'quote',
                begin: /^>\s+/,
                relevance: 0
              },
              // Horizontal rules
              {
                className: 'horizontal_rule',
                begin: /^(\*{3,}|-{3,}|_{3,})$/,
                relevance: 0
              }
            ]
          };
        });
      }
      
      // Register AsciiDoc language if needed (not in highlight.js by default)
      if (lang === 'asciidoc' && !hljs.getLanguage('asciidoc')) {
        hljs.registerLanguage('asciidoc', function(hljs) {
          return {
            name: 'AsciiDoc',
            aliases: ['adoc', 'asciidoc', 'ad'],
            contains: [
              // Headers
              {
                className: 'section',
                begin: /^={1,6}\s+/,
                relevance: 10
              },
              // Bold
              {
                className: 'strong',
                begin: /\*\*[^*]+\*\*/,
                relevance: 0
              },
              // Italic
              {
                className: 'emphasis',
                begin: /_[^_]+_/,
                relevance: 0
              },
              // Inline code
              {
                className: 'code',
                begin: /`[^`]+`/,
                relevance: 0
              },
              // Code blocks
              {
                className: 'code',
                begin: /^----+$/,
                end: /^----+$/,
                contains: [{ begin: /./ }]
              },
              // Lists
              {
                className: 'bullet',
                begin: /^(\*+|\.+|-+)\s+/,
                relevance: 0
              },
              // Links
              {
                className: 'link',
                begin: /link:/,
                end: /\[/,
                contains: [{ begin: /\[/, end: /\]/ }]
              },
              // Comments
              {
                className: 'comment',
                begin: /^\/\/.*$/,
                relevance: 0
              },
              // Attributes
              {
                className: 'attr',
                begin: /^:.*:$/,
                relevance: 0
              }
            ]
          };
        });
      }
      
      // Apply highlighting
      if (lang === 'plaintext') {
        highlightedFileContent = `<pre><code class="hljs">${hljs.highlight(content, { language: 'plaintext' }).value}</code></pre>`;
      } else if (hljs.getLanguage(lang)) {
        highlightedFileContent = `<pre><code class="hljs language-${lang}">${hljs.highlight(content, { language: lang }).value}</code></pre>`;
      } else {
        // Fallback to auto-detection
        highlightedFileContent = `<pre><code class="hljs">${hljs.highlightAuto(content).value}</code></pre>`;
      }
    } catch (err) {
      console.error('Error applying syntax highlighting:', err);
      // Fallback to plain text
      highlightedFileContent = `<pre><code class="hljs">${content}</code></pre>`;
    }
  }

  async function loadForkInfo() {
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/fork`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        forkInfo = await response.json();
      }
    } catch (err) {
      console.error('Error loading fork info:', err);
    }
  }

  // Helper function to count all replies recursively (including nested ones)
  function countAllReplies(comments: Array<{ replies?: Array<any> }> | undefined): number {
    if (!comments || comments.length === 0) {
      return 0;
    }
    let count = comments.length;
    for (const comment of comments) {
      if (comment.replies && comment.replies.length > 0) {
        count += countAllReplies(comment.replies);
      }
    }
    return count;
  }

  async function checkCloneStatus(force: boolean = false) {
    if (checkingCloneStatus || (!force && isRepoCloned !== null)) return;
    
    checkingCloneStatus = true;
    try {
      // Check if repo exists locally by trying to fetch branches
      // 404 = repo not cloned, 403 = repo exists but access denied (cloned), 200 = cloned and accessible
      const response = await fetch(`/api/repos/${npub}/${repo}/branches`, {
        headers: buildApiHeaders()
      });
      // If response is 403, repo exists (cloned) but user doesn't have access
      // If response is 404, repo doesn't exist (not cloned)
      // If response is 200, repo exists and is accessible (cloned)
      const wasCloned = response.status !== 404;
      isRepoCloned = wasCloned;
      console.log(`[Clone Status] Repo ${wasCloned ? 'is cloned' : 'is not cloned'} (status: ${response.status})`);
    } catch (err) {
      // On error, assume not cloned
      console.warn('[Clone Status] Error checking clone status:', err);
      isRepoCloned = false;
    } finally {
      checkingCloneStatus = false;
    }
  }

  async function cloneRepository() {
    if (cloning) return;
    
    cloning = true;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/clone`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        }
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(errorData.message || `Failed to clone repository: ${response.statusText}`);
      }

      const data = await response.json();
      
      if (data.alreadyExists) {
        alert('Repository already exists locally.');
        // Force refresh clone status
        await checkCloneStatus(true);
      } else {
        alert('Repository cloned successfully! The repository is now available on this server.');
        // Force refresh clone status
        await checkCloneStatus(true);
        // Reload data to use the cloned repo instead of API
        await Promise.all([
          loadBranches(),
          loadFiles(currentPath),
          loadReadme(),
          loadTags(),
          loadCommitHistory()
        ]);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to clone repository';
      alert(`Error: ${errorMessage}`);
      console.error('Error cloning repository:', err);
    } finally {
      cloning = false;
    }
  }

  async function forkRepository() {
    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    forking = true;
    error = null;

    try {
      // Security: Truncate npub in logs
      const truncatedNpub = npub.length > 16 ? `${npub.slice(0, 12)}...` : npub;
      console.log(`[Fork UI] Starting fork of ${truncatedNpub}/${repo}...`);
      const response = await fetch(`/api/repos/${npub}/${repo}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({ userPubkey })
      });

      const data = await response.json();
      
      if (response.ok && data.success !== false) {
        const message = data.message || `Repository forked successfully! Published to ${data.fork?.publishedTo?.announcement || 0} relay(s).`;
        console.log(`[Fork UI] ✓ ${message}`);
        // Security: Truncate npub in logs
        const truncatedForkNpub = data.fork.npub.length > 16 ? `${data.fork.npub.slice(0, 12)}...` : data.fork.npub;
        console.log(`[Fork UI]   - Fork location: /repos/${truncatedForkNpub}/${data.fork.repo}`);
        console.log(`[Fork UI]   - Announcement ID: ${data.fork.announcementId}`);
        console.log(`[Fork UI]   - Ownership Transfer ID: ${data.fork.ownershipTransferId}`);
        
        alert(`✓ ${message}\n\nRedirecting to your fork...`);
        goto(`/repos/${data.fork.npub}/${data.fork.repo}`);
      } else {
        const errorMessage = data.error || 'Failed to fork repository';
        const errorDetails = data.details ? `\n\nDetails: ${data.details}` : '';
        const fullError = `${errorMessage}${errorDetails}`;
        
        console.error(`[Fork UI] ✗ Fork failed: ${errorMessage}`);
        if (data.details) {
          console.error(`[Fork UI] Details: ${data.details}`);
        }
        if (data.eventName) {
          console.error(`[Fork UI] Failed event: ${data.eventName}`);
        }
        
        error = fullError;
        alert(`✗ Fork failed!\n\n${fullError}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fork repository';
      console.error(`[Fork UI] ✗ Unexpected error: ${errorMessage}`, err);
      error = errorMessage;
      alert(`✗ Fork failed!\n\n${errorMessage}`);
    } finally {
      forking = false;
    }
  }

  async function loadDiscussions() {
    if (repoNotFound) return;
    loadingDiscussions = true;
    error = null;
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      // Fetch repo announcement to get chat-relay tags and announcement ID
      const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const events = await client.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkey],
          '#d': [repo],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        discussions = [];
        return;
      }

      const announcement = events[0];
      const chatRelays = announcement.tags
        .filter(t => t[0] === 'chat-relay')
        .flatMap(t => t.slice(1))
        .filter(url => url && typeof url === 'string') as string[];

      // Get default relays
      const { getGitUrl } = await import('$lib/config.js');
      const { DiscussionsService } = await import('$lib/services/nostr/discussions-service.js');
      
      // Get user's relays if available
      let userRelays: string[] = [];
      const currentUserPubkey = $userStore.userPubkey || userPubkey;
      if (currentUserPubkey) {
        try {
          const { outbox } = await getUserRelays(currentUserPubkey, client);
          userRelays = outbox;
        } catch (err) {
          console.warn('Failed to get user relays, using defaults:', err);
        }
      }

      // Combine all available relays: default + search + chat + user relays
      const allRelays = [...new Set([
        ...DEFAULT_NOSTR_RELAYS,
        ...DEFAULT_NOSTR_SEARCH_RELAYS,
        ...chatRelays,
        ...userRelays
      ])];
      
      console.log('[Discussions] Using all available relays for threads:', allRelays);
      console.log('[Discussions] Chat relays from announcement:', chatRelays);

      const discussionsService = new DiscussionsService(allRelays);
      const discussionEntries = await discussionsService.getDiscussions(
        repoOwnerPubkey,
        repo,
        announcement.id,
        announcement.pubkey,
        allRelays, // Use all relays for threads
        allRelays  // Use all relays for comments too
      );
      
      console.log('[Discussions] Found', discussionEntries.length, 'discussion entries');

      discussions = discussionEntries.map(entry => ({
        type: entry.type,
        id: entry.id,
        title: entry.title,
        content: entry.content,
        author: entry.author,
        createdAt: entry.createdAt,
        kind: entry.kind,
        pubkey: entry.pubkey,
        comments: entry.comments
      }));
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load discussions';
      console.error('Error loading discussions:', err);
    } finally {
      loadingDiscussions = false;
    }
  }


  async function createDiscussionThread() {
    if (!userPubkey || !userPubkeyHex) {
      error = 'You must be logged in to create a discussion thread';
      return;
    }

    if (!newThreadTitle.trim()) {
      error = 'Thread title is required';
      return;
    }

    creatingThread = true;
    error = null;

    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      // Get repo announcement to get the repo address
      const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const events = await client.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkey],
          '#d': [repo],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        throw new Error('Repository announcement not found');
      }

      const announcement = events[0];
      const repoAddress = `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${repo}`;

      // Get chat relays from announcement, or use default relays
      const chatRelays = announcement.tags
        .filter(t => t[0] === 'chat-relay')
        .flatMap(t => t.slice(1))
        .filter(url => url && typeof url === 'string') as string[];

      // Combine all available relays
      let allRelays = [...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS, ...chatRelays];
      if (userPubkey) {
        try {
          const { outbox } = await getUserRelays(userPubkey, client);
          allRelays = [...allRelays, ...outbox];
        } catch (err) {
          console.warn('Failed to get user relays:', err);
        }
      }
      allRelays = [...new Set(allRelays)]; // Deduplicate

      // Create kind 11 thread event
      const threadEventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.THREAD,
        pubkey: userPubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['a', repoAddress],
          ['title', newThreadTitle.trim()],
          ['t', 'repo']
        ],
        content: newThreadContent.trim() || ''
      };

      // Sign the event using NIP-07
      const signedEvent = await signEventWithNIP07(threadEventTemplate);

      // Publish to all available relays
      const publishClient = new NostrClient(allRelays);
      const result = await publishClient.publishEvent(signedEvent, allRelays);

      if (result.failed.length > 0 && result.success.length === 0) {
        throw new Error('Failed to publish thread to all relays');
      }

      // Clear form and close dialog
      newThreadTitle = '';
      newThreadContent = '';
      showCreateThreadDialog = false;

      // Reload discussions
      await loadDiscussions();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create discussion thread';
      console.error('Error creating discussion thread:', err);
    } finally {
      creatingThread = false;
    }
  }

  async function createThreadReply() {
    if (!userPubkey || !userPubkeyHex) {
      error = 'You must be logged in to reply';
      return;
    }

    if (!replyContent.trim()) {
      error = 'Reply content is required';
      return;
    }

    if (!replyingToThread && !replyingToComment) {
      error = 'Must reply to either a thread or a comment';
      return;
    }

    creatingReply = true;
    error = null;

    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      // Get repo announcement to get the repo address and relays
      const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const events = await client.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkey],
          '#d': [repo],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        throw new Error('Repository announcement not found');
      }

      const announcement = events[0];
      
      // Get chat relays from announcement, or use default relays
      const chatRelays = announcement.tags
        .filter(t => t[0] === 'chat-relay')
        .flatMap(t => t.slice(1))
        .filter(url => url && typeof url === 'string') as string[];

      // Combine all available relays
      let allRelays = [...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS, ...chatRelays];
      if (userPubkey) {
        try {
          const { outbox } = await getUserRelays(userPubkey, client);
          allRelays = [...allRelays, ...outbox];
        } catch (err) {
          console.warn('Failed to get user relays:', err);
        }
      }
      allRelays = [...new Set(allRelays)]; // Deduplicate

      let rootEventId: string;
      let rootKind: number;
      let rootPubkey: string;
      let parentEventId: string;
      let parentKind: number;
      let parentPubkey: string;

      if (replyingToComment) {
        // Replying to a comment - use the comment object we already have
        const comment = replyingToComment;
        
        // Determine root: if we have a thread, use it as root; otherwise use announcement
        if (replyingToThread) {
          rootEventId = replyingToThread.id;
          rootKind = replyingToThread.kind || KIND.THREAD;
          rootPubkey = replyingToThread.pubkey || replyingToThread.author;
        } else {
          // Comment is directly on announcement (in "Comments" pseudo-thread)
          rootEventId = announcement.id;
          rootKind = KIND.REPO_ANNOUNCEMENT;
          rootPubkey = announcement.pubkey;
        }

        // Parent is the comment we're replying to
        parentEventId = comment.id;
        parentKind = comment.kind || KIND.COMMENT;
        parentPubkey = comment.pubkey || comment.author;
      } else if (replyingToThread) {
        // Replying directly to a thread - use the thread object we already have
        rootEventId = replyingToThread.id;
        rootKind = replyingToThread.kind || KIND.THREAD;
        rootPubkey = replyingToThread.pubkey || replyingToThread.author;
        parentEventId = replyingToThread.id;
        parentKind = replyingToThread.kind || KIND.THREAD;
        parentPubkey = replyingToThread.pubkey || replyingToThread.author;
      } else {
        throw new Error('Must specify thread or comment to reply to');
      }

      // Create kind 1111 comment event
      const commentEventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.COMMENT,
        pubkey: userPubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['e', parentEventId, '', 'reply'], // Parent event
          ['k', parentKind.toString()], // Parent kind
          ['p', parentPubkey], // Parent pubkey
          ['E', rootEventId], // Root event
          ['K', rootKind.toString()], // Root kind
          ['P', rootPubkey] // Root pubkey
        ],
        content: replyContent.trim()
      };

      // Sign the event using NIP-07
      const signedEvent = await signEventWithNIP07(commentEventTemplate);

      // Publish to all available relays
      const publishClient = new NostrClient(allRelays);
      const result = await publishClient.publishEvent(signedEvent, allRelays);

      if (result.failed.length > 0 && result.success.length === 0) {
        throw new Error('Failed to publish reply to all relays');
      }

      // Save thread ID before clearing (for expanding after reload)
      const threadIdToExpand = replyingToThread?.id;

      // Clear form and close dialog
      replyContent = '';
      showReplyDialog = false;
      replyingToThread = null;
      replyingToComment = null;

      // Reload discussions to show the new reply
      await loadDiscussions();
      
      // Expand the thread if we were replying to a thread
      if (threadIdToExpand) {
        expandedThreads.add(threadIdToExpand);
        expandedThreads = new Set(expandedThreads); // Trigger reactivity
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create reply';
      console.error('Error creating reply:', err);
    } finally {
      creatingReply = false;
    }
  }

  function toggleThread(threadId: string) {
    if (expandedThreads.has(threadId)) {
      expandedThreads.delete(threadId);
    } else {
      expandedThreads.add(threadId);
    }
    // Trigger reactivity
    expandedThreads = new Set(expandedThreads);
  }

  async function loadDocumentation() {
    if (loadingDocs) return;
    // Only skip if we already have rendered HTML (successful load)
    if (documentationHtml !== null) return;
    
    loadingDocs = true;
    try {
      // Check if repo is private and user has access
      const data = $page.data as typeof pageData;
      if (data.repoIsPrivate) {
        // Check access via API
        const accessResponse = await fetch(`/api/repos/${npub}/${repo}/access`, {
          headers: buildApiHeaders()
        });
        if (accessResponse.ok) {
          const accessData = await accessResponse.json();
          if (!accessData.canView) {
            // User doesn't have access, don't load documentation
            loadingDocs = false;
            return;
          }
        } else {
          // Access check failed, don't load documentation
          loadingDocs = false;
          return;
        }
      }
      
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        const repoOwnerPubkey = decoded.data as string;
        const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
        
        // First, get the repo announcement to find the documentation tag
        const announcementEvents = await client.fetchEvents([
          {
            kinds: [KIND.REPO_ANNOUNCEMENT],
            authors: [repoOwnerPubkey],
            '#d': [repo],
            limit: 1
          }
        ]);

        if (announcementEvents.length === 0) {
          loadingDocs = false;
          return;
        }

        const announcement = announcementEvents[0];
        
        // Look for documentation tag in the announcement
        const documentationTag = announcement.tags.find(t => t[0] === 'documentation');
        
        let docKind: number | null = null;
        
        if (documentationTag && documentationTag[1]) {
          // Parse the a-tag format: kind:pubkey:identifier
          const docAddress = documentationTag[1];
          const parts = docAddress.split(':');
          
          if (parts.length >= 3) {
            docKind = parseInt(parts[0]);
            const docPubkey = parts[1];
            const docIdentifier = parts.slice(2).join(':'); // In case identifier contains ':'
            
            // Fetch the documentation event
            const docEvents = await client.fetchEvents([
              {
                kinds: [docKind],
                authors: [docPubkey],
                '#d': [docIdentifier],
                limit: 1
              }
            ]);
            
            if (docEvents.length > 0) {
              documentationContent = docEvents[0].content || null;
            } else {
              console.warn('Documentation event not found:', docAddress);
              documentationContent = null;
            }
          } else {
            console.warn('Invalid documentation tag format:', docAddress);
            documentationContent = null;
          }
        } else {
          // No documentation tag, try to use announcement content as fallback
          documentationContent = announcement.content || null;
        }
        
        // Render content based on kind: AsciiDoc for 30041 or 30818, Markdown otherwise
        if (documentationContent) {
          // Check if we should use AsciiDoc parser (kinds 30041 or 30818)
          const useAsciiDoc = docKind === 30041 || docKind === 30818;
          
          if (useAsciiDoc) {
            // Use AsciiDoc parser
            const Asciidoctor = (await import('@asciidoctor/core')).default;
            const asciidoctor = Asciidoctor();
            const converted = asciidoctor.convert(documentationContent, {
              safe: 'safe',
              attributes: {
                'source-highlighter': 'highlight.js'
              }
            });
            // Convert to string if it's a Document object
            documentationHtml = typeof converted === 'string' ? converted : String(converted);
          } else {
            // Use Markdown parser
            const MarkdownIt = (await import('markdown-it')).default;
            const hljsModule = await import('highlight.js');
            const hljs = hljsModule.default || hljsModule;
            
            const md = new MarkdownIt({
              highlight: function (str: string, lang: string): string {
                if (lang && hljs.getLanguage(lang)) {
                  try {
                    return hljs.highlight(str, { language: lang }).value;
                  } catch (__) {}
                }
                return '';
              }
            });
            
            documentationHtml = md.render(documentationContent);
          }
        } else {
          // No content found, clear HTML
          documentationHtml = null;
        }
      }
    } catch (err) {
      console.error('Error loading documentation:', err);
      documentationHtml = null;
    } finally {
      loadingDocs = false;
    }
  }

  async function loadRepoImages() {
    try {
      // Get images from page data (loaded from announcement)
      // Use $page.data directly to ensure we get the latest data
      const data = $page.data as typeof pageData;
      if (data.image) {
        repoImage = data.image;
        console.log('[Repo Images] Loaded image from pageData:', repoImage);
      }
      if (data.banner) {
        repoBanner = data.banner;
        console.log('[Repo Images] Loaded banner from pageData:', repoBanner);
      }

      // Also fetch from announcement directly as fallback (only if not private or user has access)
      if (!repoImage && !repoBanner) {
        const data = $page.data as typeof pageData;
        // Check access for private repos
        if (data.repoIsPrivate) {
          const headers: Record<string, string> = {};
          if (userPubkey) {
            try {
              const decoded = nip19.decode(userPubkey);
              if (decoded.type === 'npub') {
                headers['X-User-Pubkey'] = decoded.data as string;
              } else {
                headers['X-User-Pubkey'] = userPubkey;
              }
            } catch {
              headers['X-User-Pubkey'] = userPubkey;
            }
          }
          
          const accessResponse = await fetch(`/api/repos/${npub}/${repo}/access`, { headers });
          if (!accessResponse.ok) {
            // Access check failed, don't fetch images
            return;
          }
          const accessData = await accessResponse.json();
          if (!accessData.canView) {
            // User doesn't have access, don't fetch images
            return;
          }
        }
        
        const decoded = nip19.decode(npub);
        if (decoded.type === 'npub') {
          const repoOwnerPubkey = decoded.data as string;
          const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
          const events = await client.fetchEvents([
            {
              kinds: [30617], // REPO_ANNOUNCEMENT
              authors: [repoOwnerPubkey],
              '#d': [repo],
              limit: 1
            }
          ]);

          if (events.length > 0) {
            const announcement = events[0];
            const imageTag = announcement.tags.find((t: string[]) => t[0] === 'image');
            const bannerTag = announcement.tags.find((t: string[]) => t[0] === 'banner');
            
            if (imageTag?.[1]) {
              repoImage = imageTag[1];
              console.log('[Repo Images] Loaded image from announcement:', repoImage);
            }
            if (bannerTag?.[1]) {
              repoBanner = bannerTag[1];
              console.log('[Repo Images] Loaded banner from announcement:', repoBanner);
            }
          } else {
            console.log('[Repo Images] No announcement found');
          }
        }
      }
      
      if (!repoImage && !repoBanner) {
        console.log('[Repo Images] No images found in announcement');
      }
    } catch (err) {
      console.error('Error loading repo images:', err);
    }
  }

  // Reactively update images when pageData changes (only once, when data becomes available)
  $effect(() => {
    const data = $page.data as typeof pageData;
    // Only update if we have new data and don't already have the images set
    if (data.image && data.image !== repoImage) {
      repoImage = data.image;
      console.log('[Repo Images] Updated image from pageData (reactive):', repoImage);
    }
    if (data.banner && data.banner !== repoBanner) {
      repoBanner = data.banner;
      console.log('[Repo Images] Updated banner from pageData (reactive):', repoBanner);
    }
  });

  onMount(async () => {
    // Initialize bookmarks service
    bookmarksService = new BookmarksService(DEFAULT_NOSTR_SEARCH_RELAYS);
    
    // Decode npub to get repo owner pubkey for bookmark address
    try {
      const decoded = nip19.decode(npub);
      if (decoded.type === 'npub') {
        const repoOwnerPubkey = decoded.data as string;
        repoAddress = `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${repo}`;
      }
    } catch (err) {
      console.warn('Failed to decode npub for bookmark address:', err);
    }

    // Close menu when clicking outside
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (showRepoMenu && !target.closest('.repo-menu-container')) {
        showRepoMenu = false;
      }
    }

    document.addEventListener('click', handleClickOutside);

    await loadBranches();
    // Skip other API calls if repository doesn't exist
    if (repoNotFound) {
      loading = false;
      return;
    }
    // loadBranches() already handles setting currentBranch to the default branch
    await loadFiles();
    await checkAuth();
    await loadTags();
    await checkMaintainerStatus();
    await loadBookmarkStatus();
    
    // Check clone status (needed to disable write operations)
    await checkCloneStatus();
    await checkVerification();
    await loadReadme();
    await loadForkInfo();
    await loadRepoImages();
  });

  async function checkAuth() {
    // Check userStore first
    const currentUser = $userStore;
    if (currentUser.userPubkey && currentUser.userPubkeyHex) {
      userPubkey = currentUser.userPubkey;
      userPubkeyHex = currentUser.userPubkeyHex;
      // Recheck maintainer status and bookmark status after auth
      await checkMaintainerStatus();
      await loadBookmarkStatus();
      return;
    }
    
    // Fallback: try NIP-07 if store doesn't have it
    try {
      if (isNIP07Available()) {
        const pubkey = await getPublicKeyWithNIP07();
        userPubkey = pubkey;
        // Convert to hex if needed
        if (/^[0-9a-f]{64}$/i.test(pubkey)) {
          userPubkeyHex = pubkey.toLowerCase();
        } else {
          try {
            const decoded = nip19.decode(pubkey);
            if (decoded.type === 'npub') {
              userPubkeyHex = decoded.data as string;
            }
          } catch {
            userPubkeyHex = pubkey;
          }
        }
        // Recheck maintainer status and bookmark status after auth
        await checkMaintainerStatus();
        await loadBookmarkStatus();
      }
    } catch (err) {
      console.log('NIP-07 not available or user not connected');
      userPubkey = null;
      userPubkeyHex = null;
    }
  }

  async function login() {
    // Check userStore first
    const currentUser = $userStore;
    if (currentUser.userPubkey && currentUser.userPubkeyHex) {
      userPubkey = currentUser.userPubkey;
      userPubkeyHex = currentUser.userPubkeyHex;
      // Re-check maintainer status and bookmark status after login
      await checkMaintainerStatus();
      await loadBookmarkStatus();
      // Check for pending transfers (user is already logged in via store)
      if (userPubkeyHex) {
        try {
          const response = await fetch('/api/transfers/pending', {
            headers: {
              'X-User-Pubkey': userPubkeyHex
            }
          });
          if (response.ok) {
            const data = await response.json();
            if (data.pendingTransfers && data.pendingTransfers.length > 0) {
              window.dispatchEvent(new CustomEvent('pendingTransfers', { 
                detail: { transfers: data.pendingTransfers } 
              }));
            }
          }
        } catch (err) {
          console.error('Failed to check for pending transfers:', err);
        }
      }
      return;
    }
    
    // Fallback: try NIP-07 - need to check write access and update store
    try {
      if (!isNIP07Available()) {
        alert('NIP-07 extension not found. Please install a Nostr extension like Alby or nos2x.');
        return;
      }
      const pubkey = await getPublicKeyWithNIP07();
      let pubkeyHex: string;
      // Convert to hex if needed
      if (/^[0-9a-f]{64}$/i.test(pubkey)) {
        pubkeyHex = pubkey.toLowerCase();
        userPubkey = pubkey;
      } else {
        try {
          const decoded = nip19.decode(pubkey);
          if (decoded.type === 'npub') {
            pubkeyHex = decoded.data as string;
            userPubkey = pubkey;
          } else {
            throw new Error('Invalid pubkey format');
          }
        } catch {
          error = 'Invalid public key format';
          return;
        }
      }
      
      userPubkeyHex = pubkeyHex;
      
      // Check write access and update user store
      const { determineUserLevel } = await import('$lib/services/nostr/user-level-service.js');
      const levelResult = await determineUserLevel(userPubkey, userPubkeyHex);
      
      // Update user store with write access level
      userStore.setUser(
        levelResult.userPubkey,
        levelResult.userPubkeyHex,
        levelResult.level,
        levelResult.error || null
      );
      
      // Update activity tracking
      const { updateActivity } = await import('$lib/services/activity-tracker.js');
      updateActivity();
      
      // Check for pending transfer events
      if (userPubkeyHex) {
        try {
          const response = await fetch('/api/transfers/pending', {
            headers: {
              'X-User-Pubkey': userPubkeyHex
            }
          });
          if (response.ok) {
            const data = await response.json();
            if (data.pendingTransfers && data.pendingTransfers.length > 0) {
              window.dispatchEvent(new CustomEvent('pendingTransfers', { 
                detail: { transfers: data.pendingTransfers } 
              }));
            }
          }
        } catch (err) {
          console.error('Failed to check for pending transfers:', err);
        }
      }
      
      // Re-check maintainer status and bookmark status after login
      await checkMaintainerStatus();
      await loadBookmarkStatus();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to connect';
      console.error('Login error:', err);
    }
  }


  async function loadBookmarkStatus() {
    if (!userPubkey || !repoAddress || !bookmarksService) return;
    
    try {
      isBookmarked = await bookmarksService.isBookmarked(userPubkey, repoAddress);
    } catch (err) {
      console.warn('Failed to load bookmark status:', err);
    }
  }

  async function toggleBookmark() {
    if (!userPubkey || !repoAddress || !bookmarksService || loadingBookmark) return;
    
    loadingBookmark = true;
    try {
      // Get user's relays for publishing
      const { getUserRelays } = await import('$lib/services/nostr/user-relays.js');
      const allSearchRelays = [...new Set([...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS])];
      const fullRelayClient = new NostrClient(allSearchRelays);
      const { outbox, inbox } = await getUserRelays(userPubkey, fullRelayClient);
      const userRelays = combineRelays(outbox.length > 0 ? outbox : inbox, DEFAULT_NOSTR_RELAYS);
      
      let success = false;
      if (isBookmarked) {
        success = await bookmarksService.removeBookmark(userPubkey, repoAddress, userRelays);
      } else {
        success = await bookmarksService.addBookmark(userPubkey, repoAddress, userRelays);
      }
      
      if (success) {
        isBookmarked = !isBookmarked;
      } else {
        alert(`Failed to ${isBookmarked ? 'remove' : 'add'} bookmark. Please try again.`);
      }
    } catch (err) {
      console.error('Failed to toggle bookmark:', err);
      alert(`Failed to ${isBookmarked ? 'remove' : 'add'} bookmark: ${String(err)}`);
    } finally {
      loadingBookmark = false;
    }
  }

  async function checkMaintainerStatus() {
    if (repoNotFound || !userPubkey) {
      isMaintainer = false;
      return;
    }

    loadingMaintainerStatus = true;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/maintainers?userPubkey=${encodeURIComponent(userPubkey)}`);
      if (response.ok) {
        const data = await response.json();
        isMaintainer = data.isMaintainer || false;
      }
    } catch (err) {
      console.error('Failed to check maintainer status:', err);
      isMaintainer = false;
    } finally {
      loadingMaintainerStatus = false;
    }
  }

  async function checkVerification() {
    if (repoNotFound) return;
    loadingVerification = true;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/verify`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        console.log('[Verification] Response:', data);
        verificationStatus = data;
      } else {
        console.warn('[Verification] Response not OK:', response.status, response.statusText);
        verificationStatus = { verified: false, error: `Verification check failed: ${response.status}` };
      }
    } catch (err) {
      console.error('[Verification] Failed to check verification:', err);
      verificationStatus = { verified: false, error: 'Failed to check verification' };
    } finally {
      loadingVerification = false;
      console.log('[Verification] Status after check:', verificationStatus);
    }
  }

  async function generateVerificationFileForRepo() {
    if (!pageData.repoOwnerPubkey || !userPubkeyHex) {
      error = 'Unable to generate verification file: missing repository or user information';
      return;
    }

    try {
      // Fetch the repository announcement event
      const nostrClient = new NostrClient([...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])]);
      const events = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [pageData.repoOwnerPubkey],
          '#d': [repo],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        error = 'Repository announcement not found. Please ensure the repository is registered on Nostr.';
        return;
      }

      const announcement = events[0] as NostrEvent;
      verificationFileContent = generateVerificationFile(announcement, pageData.repoOwnerPubkey);
      showVerificationDialog = true;
    } catch (err) {
      console.error('Failed to generate verification file:', err);
      error = `Failed to generate verification file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  function copyVerificationToClipboard() {
    if (!verificationFileContent) return;
    
    navigator.clipboard.writeText(verificationFileContent).then(() => {
      alert('Verification file content copied to clipboard!');
    }).catch((err) => {
      console.error('Failed to copy:', err);
      alert('Failed to copy to clipboard. Please select and copy manually.');
    });
  }

  async function deleteAnnouncement() {
    if (!userPubkey || !userPubkeyHex) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    if (!pageData.repoOwnerPubkey || userPubkeyHex !== pageData.repoOwnerPubkey) {
      alert('Only the repository owner can delete the announcement');
      return;
    }

    if (!confirm('Are you sure you want to send a deletion request for this repository announcement? This will request relays to delete the announcement event. This action cannot be undone.')) {
      return;
    }

    deletingAnnouncement = true;
    error = null;

    try {
      // Fetch the repository announcement to get its event ID
      const nostrClient = new NostrClient([...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])]);
      const events = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [pageData.repoOwnerPubkey],
          '#d': [repo],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        throw new Error('Repository announcement not found');
      }

      const announcement = events[0];
      announcementEventId = announcement.id;

      // Get user relays
      const { outbox } = await getUserRelays(userPubkeyHex, nostrClient);
      const combinedRelays = combineRelays(outbox);

      // Create deletion request (NIP-09)
      const deletionRequestTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.DELETION_REQUEST,
        pubkey: userPubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        content: `Requesting deletion of repository announcement for ${repo}`,
        tags: [
          ['e', announcement.id], // Reference to the announcement event
          ['a', `${KIND.REPO_ANNOUNCEMENT}:${pageData.repoOwnerPubkey}:${repo}`], // Repository address
          ['k', KIND.REPO_ANNOUNCEMENT.toString()] // Kind of event being deleted
        ]
      };

      // Sign with NIP-07
      const signedDeletionRequest = await signEventWithNIP07(deletionRequestTemplate);

      // Publish to relays
      const publishResult = await nostrClient.publishEvent(signedDeletionRequest, combinedRelays);

      if (publishResult.success.length > 0) {
        alert(`Deletion request published successfully to ${publishResult.success.length} relay(s).`);
      } else {
        throw new Error(`Failed to publish deletion request to any relay. Errors: ${publishResult.failed.map(f => `${f.relay}: ${f.error}`).join('; ')}`);
      }
    } catch (err) {
      console.error('Failed to delete announcement:', err);
      error = err instanceof Error ? err.message : 'Failed to send deletion request';
      alert(error);
    } finally {
      deletingAnnouncement = false;
    }
  }

  function downloadVerificationFile() {
    if (!verificationFileContent) return;
    
    const blob = new Blob([verificationFileContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = VERIFICATION_FILE_PATH;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Helper function to build headers with user pubkey
  function buildApiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    // Use $userStore directly to ensure we get the latest value
    const currentUserPubkeyHex = $userStore.userPubkeyHex || userPubkeyHex;
    if (currentUserPubkeyHex) {
      headers['X-User-Pubkey'] = currentUserPubkeyHex;
      // Debug logging (remove in production)
      console.debug('[API Headers] Sending X-User-Pubkey:', currentUserPubkeyHex.substring(0, 16) + '...');
    } else {
      console.debug('[API Headers] No user pubkey available, sending request without X-User-Pubkey header');
    }
    return headers;
  }

  async function loadBranches() {
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/branches`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        branches = await response.json();
        if (branches.length > 0) {
          // Branches can be an array of objects with .name property or array of strings
          const branchNames = branches.map((b: any) => typeof b === 'string' ? b : b.name);
          
          // Fetch the actual default branch from the API
          try {
            const defaultBranchResponse = await fetch(`/api/repos/${npub}/${repo}/default-branch`, {
              headers: buildApiHeaders()
            });
            if (defaultBranchResponse.ok) {
              const defaultBranchData = await defaultBranchResponse.json();
              defaultBranch = defaultBranchData.defaultBranch || defaultBranchData.branch || null;
            }
          } catch (err) {
            console.warn('Failed to fetch default branch, using fallback logic:', err);
          }
          
          // Fallback: Detect default branch: prefer master, then main, then first branch
          if (!defaultBranch) {
            if (branchNames.includes('master')) {
              defaultBranch = 'master';
            } else if (branchNames.includes('main')) {
              defaultBranch = 'main';
            } else {
              defaultBranch = branchNames[0];
            }
          }
          
          // Only update currentBranch if it's not set or if the current branch doesn't exist
          if (!currentBranch || !branchNames.includes(currentBranch)) {
            currentBranch = defaultBranch;
          }
        }
      } else if (response.status === 404) {
        // Repository not provisioned yet - set error message and flag
        repoNotFound = true;
        error = `Repository not found. This repository exists in Nostr but hasn't been provisioned on this server yet. The server will automatically provision it soon, or you can contact the server administrator.`;
      } else if (response.status === 403) {
        // Access denied - don't set repoNotFound, allow retry after login
        const errorText = await response.text().catch(() => response.statusText);
        error = `Access denied: ${errorText}. You may need to log in or you may not have permission to view this repository.`;
        console.warn('[Branches] Access denied, user may need to log in');
      }
    } catch (err) {
      console.error('Failed to load branches:', err);
    }
  }

  async function loadFiles(path: string = '') {
    // Skip if repository doesn't exist
    if (repoNotFound) return;
    
    loading = true;
    error = null;
    try {
      const url = `/api/repos/${npub}/${repo}/tree?ref=${currentBranch}&path=${encodeURIComponent(path)}`;
      const response = await fetch(url, {
        headers: buildApiHeaders()
      });
      
      if (!response.ok) {
        if (response.status === 404) {
          repoNotFound = true;
          throw new Error(`Repository not found. This repository exists in Nostr but hasn't been provisioned on this server yet. The server will automatically provision it soon, or you can contact the server administrator.`);
        } else if (response.status === 403) {
          // 403 means access denied - don't set repoNotFound, just show error
          // This allows retry after login
          const accessDeniedError = new Error(`Access denied: ${response.statusText}. You may need to log in or you may not have permission to view this repository.`);
          // Log as info since this is normal client behavior (not logged in or no access)
          console.info('Access denied (normal behavior):', accessDeniedError.message);
          throw accessDeniedError;
        }
        throw new Error(`Failed to load files: ${response.statusText}`);
      }

      files = await response.json();
      currentPath = path;
      
      // Auto-load README if we're in the root directory and no file is currently selected
      if (path === '' && !currentFile) {
        const readmeFile = findReadmeFile(files);
        if (readmeFile) {
          // Small delay to ensure UI is ready
          setTimeout(() => {
            loadFile(readmeFile.path);
          }, 100);
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load files';
      // Only log as error if it's not a 403 (access denied), which is normal behavior
      if (err instanceof Error && err.message.includes('Access denied')) {
        // Already logged as info above, don't log again
      } else {
        console.error('Error loading files:', err);
      }
    } finally {
      loading = false;
    }
  }

  // Helper function to find README file in file list
  function findReadmeFile(fileList: Array<{ name: string; path: string; type: 'file' | 'directory' }>): { name: string; path: string; type: 'file' | 'directory' } | null {
    // Priority order for README files (most common first)
    const readmeExtensions = ['md', 'markdown', 'txt', 'adoc', 'asciidoc', 'rst', 'org'];
    
    // First, try to find README with extensions (prioritized order)
    for (const ext of readmeExtensions) {
      const readmeFile = fileList.find(file => 
        file.type === 'file' && 
        file.name.toLowerCase() === `readme.${ext}`
      );
      if (readmeFile) {
        return readmeFile;
      }
    }
    
    // Then check for README without extension
    const readmeNoExt = fileList.find(file => 
      file.type === 'file' && 
      file.name.toLowerCase() === 'readme'
    );
    if (readmeNoExt) {
      return readmeNoExt;
    }
    
    // Finally, check for any file starting with "readme." (case-insensitive)
    const readmeAny = fileList.find(file => 
      file.type === 'file' && 
      file.name.toLowerCase().startsWith('readme.')
    );
    if (readmeAny) {
      return readmeAny;
    }
    
    return null;
  }

  async function loadFile(filePath: string) {
    loading = true;
    error = null;
    try {
      // Ensure currentBranch is a string (branch name), not an object
      // If currentBranch is not set, use the first available branch or 'master' as fallback
      const branchName = typeof currentBranch === 'string' 
        ? currentBranch 
        : (typeof currentBranch === 'object' && currentBranch !== null && 'name' in currentBranch 
          ? (currentBranch as { name: string }).name 
          : (branches.length > 0 
            ? (typeof branches[0] === 'string' ? branches[0] : branches[0].name)
            : 'master'));
      const url = `/api/repos/${npub}/${repo}/file?path=${encodeURIComponent(filePath)}&ref=${branchName}`;
      const response = await fetch(url, {
        headers: buildApiHeaders()
      });
      
      if (!response.ok) {
        throw new Error(`Failed to load file: ${response.statusText}`);
      }

      const data = await response.json();
      fileContent = data.content;
      editedContent = data.content;
      currentFile = filePath;
      hasChanges = false;

      // Determine language from file extension
      const ext = filePath.split('.').pop()?.toLowerCase();
      if (ext === 'md' || ext === 'markdown') {
        fileLanguage = 'markdown';
      } else if (ext === 'adoc' || ext === 'asciidoc') {
        fileLanguage = 'asciidoc';
      } else {
        fileLanguage = 'text';
      }
      
      // Apply syntax highlighting for read-only view (non-maintainers)
      if (fileContent && !isMaintainer) {
        await applySyntaxHighlighting(fileContent, ext || '');
      }
      
      // Apply syntax highlighting to file content if not in editor
      if (fileContent && !isMaintainer) {
        // For read-only view, apply highlight.js
        await applySyntaxHighlighting(fileContent, ext || '');
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load file';
      console.error('Error loading file:', err);
    } finally {
      loading = false;
    }
  }

  function handleContentChange(value: string) {
    editedContent = value;
    hasChanges = value !== fileContent;
  }

  function handleFileClick(file: { name: string; path: string; type: 'file' | 'directory' }) {
    if (file.type === 'directory') {
      pathStack.push(currentPath);
      loadFiles(file.path);
    } else {
      loadFile(file.path);
      // On mobile, switch to file viewer when a file is clicked
      if (window.innerWidth <= 768) {
        showFileListOnMobile = false;
      }
    }
  }

  function handleBack() {
    if (pathStack.length > 0) {
      const parentPath = pathStack.pop() || '';
      loadFiles(parentPath);
    } else {
      loadFiles('');
    }
  }

  // Cache for user profile email and name
  let cachedUserEmail = $state<string | null>(null);
  let cachedUserName = $state<string | null>(null);
  let fetchingUserEmail = $state(false);
  let fetchingUserName = $state(false);

  async function getUserEmail(): Promise<string> {
    // Return cached email if available
    if (cachedUserEmail) {
      return cachedUserEmail;
    }

    // If no user pubkey, can't proceed
    if (!userPubkeyHex) {
      throw new Error('User not authenticated');
    }

    // Prevent concurrent fetches
    if (fetchingUserEmail) {
      // Wait a bit and retry (shouldn't happen, but just in case)
      await new Promise(resolve => setTimeout(resolve, 100));
      if (cachedUserEmail) {
        return cachedUserEmail;
      }
    }

    fetchingUserEmail = true;
    let nip05Email: string | null = null;
    
    try {
      const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const profileEvents = await client.fetchEvents([
        {
          kinds: [0], // Kind 0 = profile metadata
          authors: [userPubkeyHex],
          limit: 1
        }
      ]);

      if (profileEvents.length > 0) {
        const event = profileEvents[0];
        
        // First check tags (newer format where NIP-05 might be in tags)
        const nip05Tag = event.tags.find((tag: string[]) => 
          (tag[0] === 'nip05' || tag[0] === 'l') && tag[1]
        );
        if (nip05Tag && nip05Tag[1]) {
          nip05Email = nip05Tag[1];
        }
        
        // Also check JSON content (traditional format)
        if (!nip05Email) {
          try {
            const profile = JSON.parse(event.content);
            // NIP-05 is stored as 'nip05' in the profile JSON
            if (profile.nip05 && typeof profile.nip05 === 'string') {
              nip05Email = profile.nip05;
            }
          } catch {
            // Invalid JSON, ignore
          }
        }
      }
    } catch (err) {
      console.warn('Failed to fetch user profile for email:', err);
    } finally {
      fetchingUserEmail = false;
    }

    // Always prompt user for email address (they might want to use a different domain)
    // Always use userPubkeyHex to generate npub (userPubkey might be hex instead of npub)
    const npubFromPubkey = userPubkeyHex ? nip19.npubEncode(userPubkeyHex) : (userPubkey || 'unknown');
    const fallbackEmail = `${npubFromPubkey}@nostr`;
    const prefillEmail = nip05Email || fallbackEmail;
    
    // Prompt user for email address
    const userEmail = prompt(
      'Please enter your email address for git commits.\n\n' +
      'This will be used as the author email in your commits.\n' +
      'You can use any email address you prefer.',
      prefillEmail
    );

    if (userEmail && userEmail.trim()) {
      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (emailRegex.test(userEmail.trim())) {
        cachedUserEmail = userEmail.trim();
        return cachedUserEmail;
      } else {
        alert('Invalid email format. Using fallback email address.');
      }
    }

    // Use fallback if user cancelled or entered invalid email
    cachedUserEmail = fallbackEmail;
    return cachedUserEmail;
  }

  async function getUserName(): Promise<string> {
    // Return cached name if available
    if (cachedUserName) {
      return cachedUserName;
    }

    // If no user pubkey, can't proceed
    if (!userPubkeyHex) {
      throw new Error('User not authenticated');
    }

    // Prevent concurrent fetches
    if (fetchingUserName) {
      // Wait a bit and retry (shouldn't happen, but just in case)
      await new Promise(resolve => setTimeout(resolve, 100));
      if (cachedUserName) {
        return cachedUserName;
      }
    }

    fetchingUserName = true;
    let profileName: string | null = null;
    
    try {
      const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const profileEvents = await client.fetchEvents([
        {
          kinds: [0], // Kind 0 = profile metadata
          authors: [userPubkeyHex],
          limit: 1
        }
      ]);

      if (profileEvents.length > 0) {
        try {
          const profile = JSON.parse(profileEvents[0].content);
          // Name is stored as 'name' in the profile JSON
          if (profile.name && typeof profile.name === 'string') {
            profileName = profile.name;
          }
        } catch {
          // Invalid JSON, ignore
        }
      }
    } catch (err) {
      console.warn('Failed to fetch user profile for name:', err);
    } finally {
      fetchingUserName = false;
    }

    // Always prompt user for name (they might want to use a different name)
    // Always use userPubkeyHex to generate npub (userPubkey might be hex instead of npub)
    const npubFromPubkey = userPubkeyHex ? nip19.npubEncode(userPubkeyHex) : (userPubkey || 'unknown');
    const fallbackName = npubFromPubkey;
    const prefillName = profileName || fallbackName;
    
    // Prompt user for name
    const userName = prompt(
      'Please enter your name for git commits.\n\n' +
      'This will be used as the author name in your commits.\n' +
      'You can use any name you prefer.',
      prefillName
    );

    if (userName && userName.trim()) {
      cachedUserName = userName.trim();
      return cachedUserName;
    }

    // Use fallback if user cancelled
    cachedUserName = fallbackName;
    return cachedUserName;
  }

  async function saveFile() {
    if (!currentFile || !commitMessage.trim()) {
      alert('Please enter a commit message');
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension to save files');
      return;
    }

    // Validate branch selection
    if (!currentBranch || typeof currentBranch !== 'string') {
      alert('Please select a branch before saving the file');
      return;
    }

    saving = true;
    error = null;

    try {
      // Get user email and name (from profile or prompt)
      const authorEmail = await getUserEmail();
      const authorName = await getUserName();
      
      // Sign commit with NIP-07 (client-side)
      let commitSignatureEvent: NostrEvent | null = null;
      if (isNIP07Available()) {
        try {
          const { KIND } = await import('$lib/types/nostr.js');
          const timestamp = Math.floor(Date.now() / 1000);
          const eventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
            kind: KIND.COMMIT_SIGNATURE,
            pubkey: '', // Will be filled by NIP-07
            created_at: timestamp,
            tags: [
              ['author', authorName, authorEmail],
              ['message', commitMessage.trim()]
            ],
            content: `Signed commit: ${commitMessage.trim()}`
          };
          commitSignatureEvent = await signEventWithNIP07(eventTemplate);
        } catch (err) {
          console.warn('Failed to sign commit with NIP-07:', err);
          // Continue without signature if signing fails
        }
      }
      
      const response = await fetch(`/api/repos/${npub}/${repo}/file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          path: currentFile,
          content: editedContent,
          commitMessage: commitMessage.trim(),
          authorName: authorName,
          authorEmail: authorEmail,
          branch: currentBranch,
          userPubkey: userPubkey,
          commitSignatureEvent: commitSignatureEvent // Send the signed event to server
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: response.statusText }));
        const errorMessage = errorData.message || errorData.error || 'Failed to save file';
        throw new Error(errorMessage);
      }

      // Reload file to get updated content
      await loadFile(currentFile);
      commitMessage = '';
      showCommitDialog = false;
      alert('File saved successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to save file';
      console.error('Error saving file:', err);
    } finally {
      saving = false;
    }
  }

  async function handleBranchChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    currentBranch = target.value;
    
    // Reload all branch-dependent data
    const reloadPromises: Promise<void>[] = [];
    
    // Always reload files (and current file if open)
    if (currentFile) {
      reloadPromises.push(loadFile(currentFile).catch(err => console.warn('Failed to reload file after branch change:', err)));
    } else {
      reloadPromises.push(loadFiles(currentPath).catch(err => console.warn('Failed to reload files after branch change:', err)));
    }
    
    // Reload README (branch-specific)
    reloadPromises.push(loadReadme().catch(err => console.warn('Failed to reload README after branch change:', err)));
    
    // Reload commit history if history tab is active
    if (activeTab === 'history') {
      reloadPromises.push(loadCommitHistory().catch(err => console.warn('Failed to reload commit history after branch change:', err)));
    }
    
    // Reload documentation if docs tab is active (might be branch-specific)
    if (activeTab === 'docs') {
      // Reset documentation HTML to force reload
      documentationHtml = null;
      reloadPromises.push(loadDocumentation().catch(err => console.warn('Failed to reload documentation after branch change:', err)));
    }
    
    // Wait for all reloads to complete
    await Promise.all(reloadPromises);
  }

  async function createFile() {
    if (!newFileName.trim()) {
      alert('Please enter a file name');
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    // Validate branch selection
    if (!currentBranch || typeof currentBranch !== 'string') {
      alert('Please select a branch before creating the file');
      return;
    }

    saving = true;
    error = null;

    try {
      // Get user email and name (from profile or prompt)
      const authorEmail = await getUserEmail();
      const authorName = await getUserName();
      const filePath = currentPath ? `${currentPath}/${newFileName}` : newFileName;
      const commitMsg = `Create ${newFileName}`;
      
      // Sign commit with NIP-07 (client-side)
      let commitSignatureEvent: NostrEvent | null = null;
      if (isNIP07Available()) {
        try {
          const { KIND } = await import('$lib/types/nostr.js');
          const timestamp = Math.floor(Date.now() / 1000);
          const eventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
            kind: KIND.COMMIT_SIGNATURE,
            pubkey: '', // Will be filled by NIP-07
            created_at: timestamp,
            tags: [
              ['author', authorName, authorEmail],
              ['message', commitMsg]
            ],
            content: `Signed commit: ${commitMsg}`
          };
          commitSignatureEvent = await signEventWithNIP07(eventTemplate);
        } catch (err) {
          console.warn('Failed to sign commit with NIP-07:', err);
          // Continue without signature if signing fails
        }
      }
      
      const response = await fetch(`/api/repos/${npub}/${repo}/file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          path: filePath,
          content: newFileContent,
          commitMessage: commitMsg,
          authorName: authorName,
          authorEmail: authorEmail,
          branch: currentBranch,
          action: 'create',
          userPubkey: userPubkey,
          commitSignatureEvent: commitSignatureEvent // Send the signed event to server
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create file');
      }

      showCreateFileDialog = false;
      newFileName = '';
      newFileContent = '';
      await loadFiles(currentPath);
      alert('File created successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create file';
    } finally {
      saving = false;
    }
  }

  async function deleteFile(filePath: string) {
    if (!confirm(`Are you sure you want to delete ${filePath}?`)) {
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    // Validate branch selection
    if (!currentBranch || typeof currentBranch !== 'string') {
      alert('Please select a branch before deleting the file');
      return;
    }

    saving = true;
    error = null;

    try {
      // Get user email and name (from profile or prompt)
      const authorEmail = await getUserEmail();
      const authorName = await getUserName();
      const commitMsg = `Delete ${filePath}`;
      
      // Sign commit with NIP-07 (client-side)
      let commitSignatureEvent: NostrEvent | null = null;
      if (isNIP07Available()) {
        try {
          const { KIND } = await import('$lib/types/nostr.js');
          const timestamp = Math.floor(Date.now() / 1000);
          const eventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
            kind: KIND.COMMIT_SIGNATURE,
            pubkey: '', // Will be filled by NIP-07
            created_at: timestamp,
            tags: [
              ['author', authorName, authorEmail],
              ['message', commitMsg]
            ],
            content: `Signed commit: ${commitMsg}`
          };
          commitSignatureEvent = await signEventWithNIP07(eventTemplate);
        } catch (err) {
          console.warn('Failed to sign commit with NIP-07:', err);
          // Continue without signature if signing fails
        }
      }
      
      const response = await fetch(`/api/repos/${npub}/${repo}/file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          path: filePath,
          commitMessage: commitMsg,
          authorName: authorName,
          authorEmail: authorEmail,
          branch: currentBranch,
          action: 'delete',
          userPubkey: userPubkey,
          commitSignatureEvent: commitSignatureEvent // Send the signed event to server
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to delete file');
      }

      if (currentFile === filePath) {
        currentFile = null;
      }
      await loadFiles(currentPath);
      alert('File deleted successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to delete file';
    } finally {
      saving = false;
    }
  }

  async function createBranch() {
    if (!newBranchName.trim()) {
      alert('Please enter a branch name');
      return;
    }

    saving = true;
    error = null;

    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/branches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          branchName: newBranchName,
          fromBranch: newBranchFrom || currentBranch
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create branch');
      }

      showCreateBranchDialog = false;
      newBranchName = '';
      await loadBranches();
      alert('Branch created successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create branch';
    } finally {
      saving = false;
    }
  }

  async function deleteBranch(branchName: string) {
    if (!confirm(`Are you sure you want to delete the branch "${branchName}"? This action cannot be undone.`)) {
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    // Prevent deleting the current branch
    if (branchName === currentBranch) {
      alert('Cannot delete the currently selected branch. Please switch to a different branch first.');
      return;
    }

    saving = true;
    error = null;

    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/branches`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          branchName: branchName
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to delete branch');
      }

      await loadBranches();
      alert('Branch deleted successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to delete branch';
      alert(error);
    } finally {
      saving = false;
    }
  }

  async function loadCommitHistory() {
    loadingCommits = true;
    error = null;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/commits?branch=${currentBranch}&limit=50`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        // Normalize commits: API-based commits use 'sha', local commits use 'hash'
        commits = data.map((commit: any) => ({
          hash: commit.hash || commit.sha || '',
          message: commit.message || 'No message',
          author: commit.author || 'Unknown',
          date: commit.date || new Date().toISOString(),
          files: commit.files || []
        })).filter((commit: any) => commit.hash); // Filter out commits without hash
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load commit history';
    } finally {
      loadingCommits = false;
    }
  }

  async function viewDiff(commitHash: string) {
    loadingCommits = true;
    error = null;
    try {
      // Normalize commit hash (handle both 'hash' and 'sha' properties)
      const getCommitHash = (c: any) => c.hash || c.sha || '';
      const commitIndex = commits.findIndex(c => getCommitHash(c) === commitHash);
      const parentHash = commitIndex >= 0
        ? (commits[commitIndex + 1] ? getCommitHash(commits[commitIndex + 1]) : `${commitHash}^`)
        : `${commitHash}^`;
      
      const response = await fetch(`/api/repos/${npub}/${repo}/diff?from=${parentHash}&to=${commitHash}`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        diffData = await response.json();
        selectedCommit = commitHash;
        showDiff = true;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load diff';
    } finally {
      loadingCommits = false;
    }
  }

  async function loadTags() {
    if (repoNotFound) return;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/tags`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        tags = await response.json();
      }
    } catch (err) {
      console.error('Failed to load tags:', err);
    }
  }

  async function createTag() {
    if (!newTagName.trim()) {
      alert('Please enter a tag name');
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    saving = true;
    error = null;

    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          tagName: newTagName,
          ref: newTagRef,
          message: newTagMessage || undefined,
          userPubkey: userPubkey
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create tag');
      }

      showCreateTagDialog = false;
      newTagName = '';
      newTagMessage = '';
      await loadTags();
      alert('Tag created successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create tag';
    } finally {
      saving = false;
    }
  }

  async function loadIssues() {
    loadingIssues = true;
    error = null;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/issues`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        issues = data.map((issue: { id: string; tags: string[][]; content: string; status?: string; pubkey: string; created_at: number; kind?: number }) => ({
          id: issue.id,
          subject: issue.tags.find((t: string[]) => t[0] === 'subject')?.[1] || 'Untitled',
          content: issue.content,
          status: issue.status || 'open',
          author: issue.pubkey,
          created_at: issue.created_at,
          kind: issue.kind || KIND.ISSUE
        }));
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load issues';
    } finally {
      loadingIssues = false;
    }
  }

  async function createIssue() {
    if (!newIssueSubject.trim() || !newIssueContent.trim()) {
      alert('Please enter a subject and content');
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    saving = true;
    error = null;

    try {
      const { IssuesService } = await import('$lib/services/nostr/issues-service.js');
      
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      // Get user's relays and combine with defaults
      const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const { outbox } = await getUserRelays(userPubkey, tempClient);
      const combinedRelays = combineRelays(outbox);

      const issuesService = new IssuesService(combinedRelays);
      const issue = await issuesService.createIssue(
        repoOwnerPubkey,
        repo,
        newIssueSubject.trim(),
        newIssueContent.trim(),
        newIssueLabels.filter(l => l.trim())
      );

      showCreateIssueDialog = false;
      newIssueSubject = '';
      newIssueContent = '';
      newIssueLabels = [''];
      await loadIssues();
      alert('Issue created successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create issue';
      console.error('Error creating issue:', err);
    } finally {
      saving = false;
    }
  }

  async function loadPRs() {
    loadingPRs = true;
    error = null;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/prs`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        prs = data.map((pr: { id: string; tags: string[][]; content: string; status?: string; pubkey: string; created_at: number; commitId?: string; kind?: number }) => ({
          id: pr.id,
          subject: pr.tags.find((t: string[]) => t[0] === 'subject')?.[1] || 'Untitled',
          content: pr.content,
          status: pr.status || 'open',
          author: pr.pubkey,
          created_at: pr.created_at,
          commitId: pr.tags.find((t: string[]) => t[0] === 'c')?.[1],
          kind: pr.kind || KIND.PULL_REQUEST
        }));
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load pull requests';
    } finally {
      loadingPRs = false;
    }
  }

  async function createPR() {
    if (!newPRSubject.trim() || !newPRContent.trim() || !newPRCommitId.trim()) {
      alert('Please enter a subject, content, and commit ID');
      return;
    }

    if (!userPubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    saving = true;
    error = null;

    try {
      const { PRsService } = await import('$lib/services/nostr/prs-service.js');
      const { getGitUrl } = await import('$lib/config.js');
      
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      // Get user's relays and combine with defaults
      const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const { outbox } = await getUserRelays(userPubkey, tempClient);
      const combinedRelays = combineRelays(outbox);

      const cloneUrl = getGitUrl(npub, repo);
      const prsService = new PRsService(combinedRelays);
      const pr = await prsService.createPullRequest(
        repoOwnerPubkey,
        repo,
        newPRSubject.trim(),
        newPRContent.trim(),
        newPRCommitId.trim(),
        cloneUrl,
        newPRBranchName.trim() || undefined,
        newPRLabels.filter(l => l.trim())
      );

      showCreatePRDialog = false;
      newPRSubject = '';
      newPRContent = '';
      newPRCommitId = '';
      newPRBranchName = '';
      newPRLabels = [''];
      await loadPRs();
      alert('Pull request created successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create pull request';
      console.error('Error creating PR:', err);
    } finally {
      saving = false;
    }
  }

  // Only load tab content when tab actually changes, not on every render
  let lastTab = $state<string | null>(null);
  $effect(() => {
    if (activeTab !== lastTab) {
      lastTab = activeTab;
      if (activeTab === 'history') {
        loadCommitHistory();
      } else if (activeTab === 'tags') {
        loadTags();
      } else if (activeTab === 'issues') {
        loadIssues();
      } else if (activeTab === 'prs') {
        loadPRs();
      } else if (activeTab === 'docs') {
        loadDocumentation();
      } else if (activeTab === 'discussions') {
        loadDiscussions();
      }
    }
  });

  // Reload all branch-dependent data when branch changes
  let lastBranch = $state<string | null>(null);
  $effect(() => {
    if (currentBranch && currentBranch !== lastBranch) {
      lastBranch = currentBranch;
      
      // Reload README (always branch-specific)
      loadReadme().catch(err => console.warn('Failed to reload README after branch change:', err));
      
      // Reload files if files tab is active
      if (activeTab === 'files') {
        if (currentFile) {
          loadFile(currentFile).catch(err => console.warn('Failed to reload file after branch change:', err));
        } else {
          loadFiles(currentPath).catch(err => console.warn('Failed to reload files after branch change:', err));
        }
      }
      
      // Reload commit history if history tab is active
      if (activeTab === 'history') {
        loadCommitHistory().catch(err => console.warn('Failed to reload commit history after branch change:', err));
      }
      
      // Reload documentation if docs tab is active (reset to force reload)
      if (activeTab === 'docs') {
        documentationHtml = null;
        loadDocumentation().catch(err => console.warn('Failed to reload documentation after branch change:', err));
      }
    }
  });
</script>

<svelte:head>
  <title>{pageData.title || `${repo} - Repository`}</title>
  <meta name="description" content={pageData.description || `Repository: ${repo}`} />
  
  <!-- OpenGraph / Facebook -->
  <meta property="og:type" content="website" />
  <meta property="og:title" content={pageData.title || `${pageData.repoName || repo} - Repository`} />
  <meta property="og:description" content={pageData.description || pageData.repoDescription || `Repository: ${pageData.repoName || repo}`} />
  <meta property="og:url" content={pageData.repoUrl || `https://${$page.url.host}${$page.url.pathname}`} />
  {#if (pageData.image || repoImage) && String(pageData.image || repoImage).trim()}
    <meta property="og:image" content={pageData.image || repoImage} />
  {/if}
  {#if (pageData.banner || repoBanner) && String(pageData.banner || repoBanner).trim()}
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
  {/if}
  
  <!-- Twitter Card -->
  <meta name="twitter:card" content={repoBanner || repoImage ? "summary_large_image" : "summary"} />
  <meta name="twitter:title" content={pageData.title || `${pageData.repoName || repo} - Repository`} />
  <meta name="twitter:description" content={pageData.description || pageData.repoDescription || `Repository: ${pageData.repoName || repo}`} />
  {#if pageData.banner || repoBanner}
    <meta name="twitter:image" content={pageData.banner || repoBanner} />
  {:else if pageData.image || repoImage}
    <meta name="twitter:image" content={pageData.image || repoImage} />
  {/if}
</svelte:head>

<div class="container">
  <header>
    {#if repoBanner}
      <div class="repo-banner">
        <img src={repoBanner} alt="" onerror={(e) => { 
          console.error('[Repo Images] Failed to load banner:', repoBanner); 
          const target = e.target as HTMLImageElement;
          if (target) target.style.display = 'none';
        }} />
      </div>
    {/if}
    <div class="header-content">
      <div class="header-main">
        <div class="repo-title-section">
          {#if repoImage}
            <img src={repoImage} alt="" class="repo-image" onerror={(e) => { 
              console.error('[Repo Images] Failed to load image:', repoImage); 
              const target = e.target as HTMLImageElement;
              if (target) target.style.display = 'none';
            }} />
          {/if}
          <div class="repo-title-text">
            <div class="repo-title-with-menu">
              <h1>{pageData.repoName || repo}</h1>
              {#if userPubkey && repoAddress}
                <button
                  class="bookmark-icon-button"
                  class:bookmarked={isBookmarked}
                  onclick={() => { toggleBookmark(); }}
                  disabled={loadingBookmark}
                  title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
                  aria-label={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
                >
                  <img src="/icons/star.svg" alt="" class="icon-inline" />
                </button>
              {/if}
              {#if userPubkey}
                <div class="repo-menu-container">
                  <button 
                    class="repo-menu-button"
                    onclick={() => showRepoMenu = !showRepoMenu}
                    title="Repository actions"
                    aria-label="Repository actions"
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <circle cx="8" cy="3" r="1.5" fill="currentColor"/>
                      <circle cx="8" cy="8" r="1.5" fill="currentColor"/>
                      <circle cx="8" cy="13" r="1.5" fill="currentColor"/>
                    </svg>
                  </button>
                  {#if showRepoMenu}
                    <div 
                      class="repo-menu-dropdown" 
                      role="menu"
                      tabindex="-1"
                      onclick={(e) => e.stopPropagation()}
                      onkeydown={(e) => {
                        if (e.key === 'Escape') {
                          showRepoMenu = false;
                        }
                      }}
                    >
                      {#if userPubkey}
                        <button onclick={() => { forkRepository(); showRepoMenu = false; }} disabled={forking} class="repo-menu-item">
                          {forking ? 'Forking...' : 'Fork'}
                        </button>
                        {#if hasUnlimitedAccess($userStore.userLevel) && (isRepoCloned === false || (isRepoCloned === null && !checkingCloneStatus))}
                          <button 
                            onclick={() => { cloneRepository(); showRepoMenu = false; }} 
                            disabled={cloning || checkingCloneStatus} 
                            class="repo-menu-item"
                            title="Clone this repository to the server (privileged users only)"
                          >
                            {cloning ? 'Cloning...' : (checkingCloneStatus ? 'Checking...' : 'Clone to Server')}
                          </button>
                        {/if}
                        {#if isMaintainer}
                          <a href={`/signup?npub=${npub}&repo=${repo}`} class="repo-menu-item">Settings</a>
                        {/if}
                        {#if pageData.repoOwnerPubkey && userPubkeyHex === pageData.repoOwnerPubkey}
                          {#if verificationStatus?.verified !== true}
                            <button 
                              onclick={() => { generateVerificationFileForRepo(); showRepoMenu = false; }} 
                              class="repo-menu-item"
                              title="Generate verification file"
                            >
                              Generate Verification File
                            </button>
                          {/if}
                          <button 
                            onclick={() => { deleteAnnouncement(); showRepoMenu = false; }} 
                            disabled={deletingAnnouncement}
                            class="repo-menu-item repo-menu-item-danger"
                            title="Send deletion request for repository announcement (NIP-09)"
                          >
                            {deletingAnnouncement ? 'Deleting...' : 'Delete Announcement'}
                          </button>
                        {/if}
                        {#if isMaintainer}
                          <button 
                            onclick={() => {
                              if (!userPubkey || !isMaintainer || needsClone) return;
                              showCreateBranchDialog = true;
                              showRepoMenu = false;
                            }} 
                            class="repo-menu-item"
                            disabled={needsClone}
                            title={needsClone ? cloneTooltip : 'Create a new branch'}
                          >Create New Branch</button>
                        {/if}
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
            {#if pageData.repoDescription}
              <p class="repo-description-header">{pageData.repoDescription}</p>
            {:else}
              <p class="repo-description-header repo-description-placeholder">No description</p>
            {/if}
          </div>
        </div>
      <div class="repo-meta-info">
        {#if pageData.repoLanguage}
          <span class="repo-language">
            <img src="/icons/file-text.svg" alt="" class="icon-inline" />
            {pageData.repoLanguage}
          </span>
        {/if}
        {#if pageData.repoIsPrivate}
          <span class="repo-privacy-badge private">Private</span>
        {:else}
          <span class="repo-privacy-badge public">Public</span>
        {/if}
        {#if pageData.repoTopics && pageData.repoTopics.length > 0}
          <div class="repo-topics">
            {#each pageData.repoTopics as topic}
              <span class="topic-tag">{topic}</span>
            {/each}
          </div>
        {/if}
        {#if forkInfo?.isFork && forkInfo.originalRepo}
          <span class="fork-badge">Forked from <a href={`/repos/${forkInfo.originalRepo.npub}/${forkInfo.originalRepo.repo}`}>{forkInfo.originalRepo.repo}</a></span>
        {/if}
      </div>
      {#if pageData.repoOwnerPubkey || (pageData.repoMaintainers && pageData.repoMaintainers.length > 0)}
        <div class="repo-contributors">
          <span class="contributors-label">Contributors:</span>
          <div class="contributors-list">
            {#if pageData.repoOwnerPubkey}
              <a href={`/users/${npub}`} class="contributor-item">
                <UserBadge pubkey={pageData.repoOwnerPubkey} />
                <span class="contributor-badge owner">Owner</span>
              </a>
            {/if}
            {#if pageData.repoMaintainers}
              {#each pageData.repoMaintainers.filter(m => m !== pageData.repoOwnerPubkey) as maintainerPubkey}
                <a href={`/users/${nip19.npubEncode(maintainerPubkey)}`} class="contributor-item">
                  <UserBadge pubkey={maintainerPubkey} />
                  <span class="contributor-badge maintainer">Maintainer</span>
                </a>
              {/each}
            {/if}
          </div>
        </div>
      {/if}
      {#if pageData.repoWebsite}
        <div class="repo-website">
          <a href={pageData.repoWebsite} target="_blank" rel="noopener noreferrer">
            <img src="/icons/external-link.svg" alt="" class="icon-inline" />
            {pageData.repoWebsite}
          </a>
        </div>
      {/if}
      {#if pageData.repoCloneUrls && pageData.repoCloneUrls.length > 0}
        <div class="repo-clone-urls">
          <span class="clone-label">Clone:</span>
          {#each pageData.repoCloneUrls.slice(0, 3) as cloneUrl}
            {@const cloneVerification = verificationStatus?.cloneVerifications?.find(cv => {
              // Match URLs more flexibly (handle trailing slashes, http/https differences)
              const normalizeUrl = (url: string) => url.replace(/\/$/, '').toLowerCase().replace(/^https?:\/\//, '');
              const normalizedCv = normalizeUrl(cv.url);
              const normalizedClone = normalizeUrl(cloneUrl);
              const matches = normalizedCv === normalizedClone || 
                             normalizedCv.includes(normalizedClone) || 
                             normalizedClone.includes(normalizedCv);
              if (matches) {
                console.log('[Verification] Matched clone URL:', cloneUrl, 'with verification:', cv);
              }
              return matches;
            })}
            <div class="clone-url-wrapper">
              <code class="clone-url">{cloneUrl}</code>
              {#if loadingVerification}
                <span class="verification-badge loading" title="Checking verification...">
                  <span style="opacity: 0.5;">⋯</span>
                </span>
              {:else if cloneVerification !== undefined}
                <span 
                  class="verification-badge" 
                  class:verified={cloneVerification.verified} 
                  class:unverified={!cloneVerification.verified}
                  title={cloneVerification.verified ? 'Verified ownership' : (cloneVerification.error || 'Unverified')}
                >
                  {#if cloneVerification.verified}
                    <img src="/icons/check-circle.svg" alt="Verified" class="icon-inline" />
                  {:else}
                    <img src="/icons/alert-triangle.svg" alt="Unverified" class="icon-inline" />
                  {/if}
                </span>
              {:else if verificationStatus}
                {#if verificationStatus.cloneVerifications && verificationStatus.cloneVerifications.length > 0}
                  <span class="verification-badge unverified" title="Verification status unknown for this clone">
                    <img src="/icons/alert-triangle.svg" alt="Unknown" class="icon-inline" />
                  </span>
                {:else}
                  <span class="verification-badge unverified" title="Verification not available for this clone">
                    <img src="/icons/alert-triangle.svg" alt="Not verified" class="icon-inline" />
                  </span>
                {/if}
              {:else}
                <span class="verification-badge unverified" title="Verification not checked">
                  <img src="/icons/alert-triangle.svg" alt="Not checked" class="icon-inline" />
                </span>
              {/if}
            </div>
          {/each}
          {#if pageData.repoCloneUrls.length > 3}
            <span class="clone-more">+{pageData.repoCloneUrls.length - 3} more</span>
          {/if}
        </div>
      {/if}
      {#if pageData.repoOwnerPubkey && userPubkey === pageData.repoOwnerPubkey}
        <ForwardingConfig userPubkeyHex={pageData.repoOwnerPubkey} />
      {/if}
      </div>
      <div class="header-actions">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          {#if isRepoCloned === true}
            <button 
              onclick={copyCloneUrl} 
              disabled={copyingCloneUrl}
              class="clone-url-button"
              title="Copy clone URL to clipboard"
              style="padding: 0.5rem 1rem; font-size: 0.875rem; background: var(--button-primary, #3b82f6); color: var(--accent-text, #ffffff); border: none; border-radius: 0.25rem; cursor: pointer; display: flex; align-items: center; gap: 0.5rem;"
            >
              {#if copyingCloneUrl}
                <span>Copying...</span>
              {:else}
                <img src="/icons/copy.svg" alt="" class="icon-inline" style="width: 1rem; height: 1rem;" />
                <span>Clone</span>
              {/if}
            </button>
          {/if}
          {#if branches.length === 0 && !loading}
            <div class="branch-select branch-select-empty" title="No branches available">
              No branches detected
            </div>
          {:else}
            <select bind:value={currentBranch} onchange={handleBranchChange} class="branch-select" disabled={branches.length === 0 && loading}>
              {#if branches.length === 0}
                <!-- Show current branch even if branches haven't loaded yet -->
                <option value={currentBranch}>{currentBranch}{loading ? ' (loading...)' : ''}</option>
              {:else}
                {#each branches as branch}
                  {@const branchName = typeof branch === 'string' ? branch : (branch as { name: string }).name}
                  <option value={branchName}>{branchName}</option>
                {/each}
              {/if}
            </select>
          {/if}
          {#if isMaintainer && branches.length > 0 && currentBranch && branches.length > 1}
            {@const canDelete = defaultBranch !== null && currentBranch !== defaultBranch}
            {#if canDelete && currentBranch}
              <button 
                onclick={() => currentBranch && deleteBranch(currentBranch)} 
                class="delete-branch-button"
                disabled={saving}
                title="Delete current branch"
                style="padding: 0.25rem 0.5rem; font-size: 0.875rem; background: var(--error-text, #dc2626); color: #ffffff; border: none; border-radius: 0.25rem; cursor: pointer;"
              >×</button>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  </header>

  <main class="repo-view">
    {#if error}
      <div class="error">
        Error: {error}
      </div>
    {/if}

    <!-- Tabs -->
    <div class="tabs">
      <button 
        class="tab-button" 
        class:active={activeTab === 'discussions'}
        onclick={() => activeTab = 'discussions'}
      >
        Discussions
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'files'}
        onclick={() => activeTab = 'files'}
      >
        Files
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'history'}
        onclick={() => activeTab = 'history'}
      >
        History
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'tags'}
        onclick={() => activeTab = 'tags'}
      >
        Tags
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'issues'}
        onclick={() => activeTab = 'issues'}
      >
        Issues
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'prs'}
        onclick={() => activeTab = 'prs'}
      >
        Pull Requests
      </button>
      <button 
        class="tab-button" 
        class:active={activeTab === 'docs'}
        onclick={() => activeTab = 'docs'}
      >
        Docs
      </button>
    </div>

    <div class="repo-layout">
      <!-- File Tree Sidebar -->
      {#if activeTab === 'files'}
      <aside class="file-tree" class:hide-on-mobile={!showFileListOnMobile && activeTab === 'files'}>
        <div class="file-tree-header">
          <h2>Files</h2>
          <div class="file-tree-actions">
            {#if pathStack.length > 0 || currentPath}
              <button onclick={handleBack} class="back-button">← Back</button>
            {/if}
            {#if userPubkey && isMaintainer}
              <button 
                onclick={() => {
                  if (!userPubkey || !isMaintainer || needsClone) return;
                  showCreateFileDialog = true;
                }} 
                class="create-file-button"
                disabled={needsClone}
                title={needsClone ? cloneTooltip : 'Create a new file'}
              >+ New File</button>
            {/if}
            <button 
              onclick={() => showFileListOnMobile = !showFileListOnMobile} 
              class="mobile-toggle-button"
              title={showFileListOnMobile ? 'Show file viewer' : 'Show file list'}
            >
              {#if showFileListOnMobile}
                <img src="/icons/file-text.svg" alt="Show file viewer" class="icon-inline" />
              {:else}
                <img src="/icons/package.svg" alt="Show file list" class="icon-inline" />
              {/if}
            </button>
          </div>
        </div>
        {#if loading && !currentFile}
          <div class="loading">Loading files...</div>
        {:else}
          <ul class="file-list">
            {#each files as file}
              <li class="file-item" class:directory={file.type === 'directory'} class:selected={currentFile === file.path}>
                <button onclick={() => handleFileClick(file)} class="file-button">
                  {#if file.type === 'directory'}
                    <img src="/icons/package.svg" alt="Directory" class="icon-inline" />
                  {:else}
                    <img src="/icons/file-text.svg" alt="File" class="icon-inline" />
                  {/if}
                  {file.name}
                  {#if file.size !== undefined}
                    <span class="file-size">({(file.size / 1024).toFixed(1)} KB)</span>
                  {/if}
                </button>
                {#if userPubkey && isMaintainer && file.type === 'file'}
                  <button 
                    onclick={() => {
                      if (needsClone) return;
                      deleteFile(file.path);
                    }} 
                    class="delete-file-button" 
                    disabled={needsClone}
                    title={needsClone ? cloneTooltip : 'Delete file'}
                  >
                    <img src="/icons/x.svg" alt="Delete" class="icon-small" />
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
      {/if}

      <!-- Commit History View -->
      {#if activeTab === 'history'}
      <aside class="history-sidebar">
        <div class="history-header">
          <h2>Commit History</h2>
          <button onclick={loadCommitHistory} class="refresh-button">
            <img src="/icons/refresh-cw.svg" alt="" class="icon-inline" />
            Refresh
          </button>
        </div>
        {#if loadingCommits}
          <div class="loading">Loading commits...</div>
        {:else if commits.length === 0}
          <div class="empty">No commits found</div>
        {:else}
          <ul class="commit-list">
            {#each commits as commit}
              {@const commitHash = commit.hash || (commit as any).sha || ''}
              {#if commitHash}
                <li class="commit-item" class:selected={selectedCommit === commitHash}>
                  <button onclick={() => viewDiff(commitHash)} class="commit-button">
                    <div class="commit-hash">{commitHash.slice(0, 7)}</div>
                    <div class="commit-message">{commit.message || 'No message'}</div>
                    <div class="commit-meta">
                      <span>{commit.author || 'Unknown'}</span>
                      <span>{commit.date ? new Date(commit.date).toLocaleString() : 'Unknown date'}</span>
                    </div>
                  </button>
                </li>
              {/if}
            {/each}
          </ul>
        {/if}
      </aside>
      {/if}

      <!-- Tags View -->
      {#if activeTab === 'tags'}
      <aside class="tags-sidebar">
        <div class="tags-header">
          <h2>Tags</h2>
          {#if userPubkey && isMaintainer}
            <button 
              onclick={() => {
                if (!userPubkey || !isMaintainer || needsClone) return;
                showCreateTagDialog = true;
              }} 
              class="create-tag-button"
              disabled={needsClone}
              title={needsClone ? cloneTooltip : 'Create a new tag'}
            >+ New Tag</button>
          {/if}
        </div>
        {#if tags.length === 0}
          <div class="empty">No tags found</div>
        {:else}
          <ul class="tag-list">
            {#each tags as tag}
              {@const tagHash = tag.hash || ''}
              {#if tagHash}
                <li class="tag-item">
                  <div class="tag-name">{tag.name}</div>
                  <div class="tag-hash">{tagHash.slice(0, 7)}</div>
                  {#if tag.message}
                    <div class="tag-message">{tag.message}</div>
                  {/if}
                </li>
              {/if}
            {/each}
          </ul>
        {/if}
      </aside>
      {/if}

      <!-- Issues View -->
      {#if activeTab === 'issues'}
      <aside class="issues-sidebar">
        <div class="issues-header">
          <h2>Issues</h2>
          {#if userPubkey}
            <button onclick={() => {
              if (!userPubkey) return;
              showCreateIssueDialog = true;
            }} class="create-issue-button">+ New Issue</button>
          {/if}
        </div>
        {#if loadingIssues}
          <div class="loading">Loading issues...</div>
        {:else if issues.length === 0}
          <div class="empty">No issues found</div>
        {:else}
          <ul class="issue-list">
            {#each issues as issue}
              <li class="issue-item">
                <div class="issue-header">
                  <span class="issue-status" class:open={issue.status === 'open'} class:closed={issue.status === 'closed'} class:resolved={issue.status === 'resolved'}>
                    {issue.status}
                  </span>
                  <span class="issue-subject">{issue.subject}</span>
                </div>
                <div class="issue-meta">
                  <span>#{issue.id.slice(0, 7)}</span>
                  <span>{new Date(issue.created_at * 1000).toLocaleDateString()}</span>
                  <EventCopyButton eventId={issue.id} kind={issue.kind} pubkey={issue.author} />
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
      {/if}

      <!-- Pull Requests View -->
      {#if activeTab === 'prs'}
      <aside class="prs-sidebar">
        <div class="prs-header">
          <h2>Pull Requests</h2>
          {#if userPubkey}
            <button onclick={() => {
              if (!userPubkey) return;
              showCreatePRDialog = true;
            }} class="create-pr-button">+ New PR</button>
          {/if}
        </div>
        {#if loadingPRs}
          <div class="loading">Loading pull requests...</div>
        {:else if prs.length === 0}
          <div class="empty">No pull requests found</div>
        {:else}
          <ul class="pr-list">
            {#each prs as pr}
              <li class="pr-item">
                <div class="pr-header">
                  <span class="pr-status" class:open={pr.status === 'open'} class:closed={pr.status === 'closed'} class:merged={pr.status === 'merged'}>
                    {pr.status}
                  </span>
                  <span class="pr-subject">{pr.subject}</span>
                </div>
                <div class="pr-meta">
                  <span>#{pr.id.slice(0, 7)}</span>
                  {#if pr.commitId}
                    <span class="pr-commit">Commit: {pr.commitId.slice(0, 7)}</span>
                  {/if}
                  <span>{new Date(pr.created_at * 1000).toLocaleDateString()}</span>
                  <EventCopyButton eventId={pr.id} kind={pr.kind} pubkey={pr.author} />
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
      {/if}

      <!-- Editor Area / Diff View / README -->
      <div class="editor-area" class:hide-on-mobile={showFileListOnMobile && activeTab === 'files'}>
        {#if activeTab === 'files' && readmeContent && !currentFile}
          <div class="readme-section">
            <div class="readme-header">
              <h3>README</h3>
              <div class="readme-actions">
                <a href={`/api/repos/${npub}/${repo}/raw?path=${readmePath}`} target="_blank" class="raw-link">View Raw</a>
                <a href={`/api/repos/${npub}/${repo}/download?format=zip`} class="download-link">Download ZIP</a>
                <button 
                  onclick={() => showFileListOnMobile = !showFileListOnMobile} 
                  class="mobile-toggle-button"
                  title={showFileListOnMobile ? 'Show file viewer' : 'Show file list'}
                >
                  {#if showFileListOnMobile}
                    <img src="/icons/file-text.svg" alt="Show file viewer" class="icon-inline" />
                  {:else}
                    <img src="/icons/package.svg" alt="Show file list" class="icon-inline" />
                  {/if}
                </button>
              </div>
            </div>
            {#if loadingReadme}
              <div class="loading">Loading README...</div>
            {:else if readmeIsMarkdown && readmeHtml}
              <div class="readme-content markdown">
                {@html readmeHtml}
              </div>
            {:else if readmeContent}
              <div class="readme-content">
                <pre><code class="hljs language-text">{readmeContent}</code></pre>
              </div>
            {/if}
          </div>
        {/if}

        {#if activeTab === 'files' && currentFile}
          <div class="editor-header">
            <span class="file-path">{currentFile}</span>
            <div class="editor-actions">
              {#if hasChanges}
                <span class="unsaved-indicator">● Unsaved changes</span>
              {/if}
              {#if isMaintainer}
                <button 
                  onclick={() => {
                    if (!userPubkey || !isMaintainer || needsClone) return;
                    showCommitDialog = true;
                  }} 
                  disabled={!hasChanges || saving || needsClone} 
                  class="save-button"
                  title={needsClone ? cloneTooltip : (hasChanges ? 'Save changes' : 'No changes to save')}
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              {:else if userPubkey}
                <span class="non-maintainer-notice">Only maintainers can edit files. Submit a PR instead.</span>
              {/if}
              <button 
                onclick={() => showFileListOnMobile = !showFileListOnMobile} 
                class="mobile-toggle-button"
                title={showFileListOnMobile ? 'Show file viewer' : 'Show file list'}
              >
                {#if showFileListOnMobile}
                  <img src="/icons/file-text.svg" alt="Show file viewer" class="icon-inline" />
                {:else}
                  <img src="/icons/package.svg" alt="Show file list" class="icon-inline" />
                {/if}
              </button>
            </div>
          </div>
          
          {#if loading}
            <div class="loading">Loading file...</div>
          {:else}
            <div class="editor-container">
              {#if isMaintainer}
                <CodeEditor 
                  content={editedContent} 
                  language={fileLanguage}
                  onChange={handleContentChange}
                  readOnly={needsClone}
                />
              {:else}
                <div class="read-only-editor">
                  {#if highlightedFileContent}
                    {@html highlightedFileContent}
                  {:else}
                    <pre><code class="hljs">{fileContent}</code></pre>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        {:else if activeTab === 'files'}
          <div class="empty-state">
            <p>Select a file from the sidebar to view and edit it</p>
          </div>
        {/if}

        {#if activeTab === 'history' && showDiff}
          <div class="diff-view">
            <div class="diff-header">
              <h3>Diff for commit {selectedCommit?.slice(0, 7)}</h3>
              <button onclick={() => { showDiff = false; selectedCommit = null; }} class="close-button">×</button>
            </div>
            {#each diffData as diff}
              <div class="diff-file">
                <div class="diff-file-header">
                  <span class="diff-file-name">{diff.file}</span>
                  <span class="diff-stats">
                    <span class="additions">+{diff.additions}</span>
                    <span class="deletions">-{diff.deletions}</span>
                  </span>
                </div>
                <pre class="diff-content"><code>{diff.diff}</code></pre>
              </div>
            {/each}
          </div>
        {:else if activeTab === 'history'}
          <div class="empty-state">
            <p>Select a commit to view its diff</p>
          </div>
        {/if}

        {#if activeTab === 'tags'}
          <div class="empty-state">
            <p>Tags are displayed in the sidebar</p>
          </div>
        {/if}

        {#if activeTab === 'issues'}
          <div class="issues-content">
            {#if issues.length === 0}
              <div class="empty-state">
                <p>No issues found. Create one to get started!</p>
              </div>
            {:else}
              {#each issues as issue}
                <div class="issue-detail">
                  <h3>{issue.subject}</h3>
                  <div class="issue-meta-detail">
                    <span class="issue-status" class:open={issue.status === 'open'} class:closed={issue.status === 'closed'} class:resolved={issue.status === 'resolved'}>
                      {issue.status}
                    </span>
                    <span>Created {new Date(issue.created_at * 1000).toLocaleString()}</span>
                  </div>
                  <div class="issue-body">
                    {@html issue.content.replace(/\n/g, '<br>')}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        {/if}

        {#if activeTab === 'prs'}
          <div class="prs-content">
            {#if prs.length === 0}
              <div class="empty-state">
                <p>No pull requests found. Create one to get started!</p>
              </div>
            {:else if selectedPR}
              {#each prs.filter(p => p.id === selectedPR) as pr}
                {@const decoded = nip19.decode(npub)}
                {#if decoded.type === 'npub'}
                  {@const repoOwnerPubkey = decoded.data as string}
                  <PRDetail
                    {pr}
                    {npub}
                    {repo}
                    {repoOwnerPubkey}
                  />
                  <button onclick={() => selectedPR = null} class="back-btn">← Back to PR List</button>
                {/if}
              {/each}
            {:else}
              {#each prs as pr}
                <div 
                  class="pr-detail" 
                  role="button"
                  tabindex="0"
                  onclick={() => selectedPR = pr.id}
                  onkeydown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      selectedPR = pr.id;
                    }
                  }}
                  style="cursor: pointer;">
                  <h3>{pr.subject}</h3>
                  <div class="pr-meta-detail">
                    <span class="pr-status" class:open={pr.status === 'open'} class:closed={pr.status === 'closed'} class:merged={pr.status === 'merged'}>
                      {pr.status}
                    </span>
                    {#if pr.commitId}
                      <span>Commit: {pr.commitId.slice(0, 7)}</span>
                    {/if}
                    <span>Created {new Date(pr.created_at * 1000).toLocaleString()}</span>
                  </div>
                  <div class="pr-body">
                    {@html pr.content.replace(/\n/g, '<br>')}
                  </div>
                </div>
              {/each}
            {/if}
          </div>
        {/if}

        {#if activeTab === 'docs'}
          <div class="docs-content">
            {#if loadingDocs}
              <div class="loading">Loading documentation...</div>
            {:else if documentationHtml}
              <div class="documentation-body">
                {@html documentationHtml}
              </div>
            {:else if documentationContent === null}
              <div class="empty-state">
                <p>No documentation found for this repository.</p>
              </div>
            {:else}
              <div class="empty-state">
                <p>Documentation content is empty.</p>
              </div>
            {/if}
          </div>
        {/if}

        {#if activeTab === 'discussions'}
          <div class="discussions-content">
            <div class="discussions-header">
              <h2>Discussions</h2>
              <div class="discussions-actions">
                <button 
                  class="btn btn-secondary"
                  onclick={() => loadDiscussions()}
                  disabled={loadingDiscussions}
                  title="Refresh discussions"
                >
                  <img src="/icons/refresh-cw.svg" alt="" class="icon-inline" />
                  {loadingDiscussions ? 'Refreshing...' : 'Refresh'}
                </button>
                {#if userPubkey}
                  <button 
                    class="btn btn-primary"
                    onclick={() => showCreateThreadDialog = true}
                    disabled={creatingThread}
                  >
                    {creatingThread ? 'Creating...' : 'New Discussion Thread'}
                  </button>
                {/if}
              </div>
            </div>
            {#if loadingDiscussions}
              <div class="loading">Loading discussions...</div>
            {:else if discussions.length === 0}
              <div class="empty-state">
                <p>No discussions found. {#if userPubkey}Create a new discussion thread to get started!{:else}Log in to create a discussion thread.{/if}</p>
              </div>
            {:else}
              {#each discussions as discussion}
                {@const isExpanded = discussion.type === 'thread' && expandedThreads.has(discussion.id)}
                {@const hasComments = discussion.comments && discussion.comments.length > 0}
                <div class="discussion-item">
                  <div class="discussion-header">
                    <div class="discussion-title-row">
                      {#if discussion.type === 'thread'}
                        <button 
                          class="expand-button"
                          onclick={() => toggleThread(discussion.id)}
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? 'Collapse thread' : 'Expand thread'}
                        >
                          {isExpanded ? '▼' : '▶'}
                        </button>
                      {/if}
                      <h3>{discussion.title}</h3>
                    </div>
                    <div class="discussion-meta">
                      {#if discussion.type === 'thread'}
                        <span class="discussion-type">Thread</span>
                        {#if hasComments}
                          {@const totalReplies = countAllReplies(discussion.comments)}
                          <span class="comment-count">{totalReplies} {totalReplies === 1 ? 'reply' : 'replies'}</span>
                        {/if}
                      {:else}
                        <span class="discussion-type">Comments</span>
                      {/if}
                      <span>Created {new Date(discussion.createdAt * 1000).toLocaleString()}</span>
                      <EventCopyButton eventId={discussion.id} kind={discussion.kind} pubkey={discussion.pubkey} />
                      {#if discussion.type === 'thread' && userPubkey}
                        <button 
                          class="btn btn-small"
                          onclick={() => {
                            replyingToThread = { id: discussion.id, kind: discussion.kind, pubkey: discussion.pubkey, author: discussion.author };
                            replyingToComment = null;
                            showReplyDialog = true;
                          }}
                        >
                          Reply
                        </button>
                      {/if}
                    </div>
                  </div>
                  {#if discussion.content}
                    <div class="discussion-body">
                      <p>{discussion.content}</p>
                    </div>
                  {/if}
                  {#if discussion.type === 'thread' && isExpanded && hasComments}
                    {@const totalReplies = countAllReplies(discussion.comments)}
                    <div class="comments-section">
                      <h4>Replies ({totalReplies})</h4>
                      {#each discussion.comments! as comment}
                        <div class="comment-item">
                          <div class="comment-meta">
                            <UserBadge pubkey={comment.author} />
                            <span>{new Date(comment.createdAt * 1000).toLocaleString()}</span>
                            <EventCopyButton eventId={comment.id} kind={comment.kind} pubkey={comment.pubkey} />
                            {#if userPubkey}
                              <button 
                                class="btn btn-small"
                                onclick={() => {
                                  replyingToThread = { id: discussion.id, kind: discussion.kind, pubkey: discussion.pubkey, author: discussion.author };
                                  replyingToComment = { id: comment.id, kind: comment.kind, pubkey: comment.pubkey, author: comment.author };
                                  showReplyDialog = true;
                                }}
                              >
                                Reply
                              </button>
                            {/if}
                          </div>
                          <div class="comment-content">
                            <p>{comment.content}</p>
                          </div>
                          {#if comment.replies && comment.replies.length > 0}
                            <div class="nested-replies">
                              {#each comment.replies as reply}
                                <div class="comment-item nested-comment">
                                  <div class="comment-meta">
                                    <UserBadge pubkey={reply.author} />
                                    <span>{new Date(reply.createdAt * 1000).toLocaleString()}</span>
                                    <EventCopyButton eventId={reply.id} kind={reply.kind} pubkey={reply.pubkey} />
                                    {#if userPubkey}
                                      <button 
                                        class="btn btn-small"
                                        onclick={() => {
                                          replyingToThread = { id: discussion.id, kind: discussion.kind, pubkey: discussion.pubkey, author: discussion.author };
                                          replyingToComment = { id: reply.id, kind: reply.kind, pubkey: reply.pubkey, author: reply.author };
                                          showReplyDialog = true;
                                        }}
                                      >
                                        Reply
                                      </button>
                                    {/if}
                                  </div>
                                  <div class="comment-content">
                                    <p>{reply.content}</p>
                                  </div>
                                  {#if reply.replies && reply.replies.length > 0}
                                    <div class="nested-replies">
                                      {#each reply.replies as nestedReply}
                                        <div class="comment-item nested-comment">
                                          <div class="comment-meta">
                                            <UserBadge pubkey={nestedReply.author} />
                                            <span>{new Date(nestedReply.createdAt * 1000).toLocaleString()}</span>
                                            <EventCopyButton eventId={nestedReply.id} kind={nestedReply.kind} pubkey={nestedReply.pubkey} />
                                            {#if userPubkey}
                                              <button 
                                                class="btn btn-small"
                                                onclick={() => {
                                                  replyingToThread = { id: discussion.id, kind: discussion.kind, pubkey: discussion.pubkey, author: discussion.author };
                                                  replyingToComment = { id: nestedReply.id, kind: nestedReply.kind, pubkey: nestedReply.pubkey, author: nestedReply.author };
                                                  showReplyDialog = true;
                                                }}
                                              >
                                                Reply
                                              </button>
                                            {/if}
                                          </div>
                                          <div class="comment-content">
                                            <p>{nestedReply.content}</p>
                                          </div>
                                        </div>
                                      {/each}
                                    </div>
                                  {/if}
                                </div>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {:else if discussion.type === 'comments' && hasComments}
                    {@const totalReplies = countAllReplies(discussion.comments)}
                    <div class="comments-section">
                      <h4>Comments ({totalReplies})</h4>
                      {#each discussion.comments! as comment}
                        <div class="comment-item">
                          <div class="comment-meta">
                            <UserBadge pubkey={comment.author} />
                            <span>{new Date(comment.createdAt * 1000).toLocaleString()}</span>
                            <EventCopyButton eventId={comment.id} kind={comment.kind} pubkey={comment.pubkey} />
                            {#if userPubkey}
                              <button 
                                class="btn btn-small"
                                onclick={() => {
                                  replyingToThread = { id: discussion.id, kind: discussion.kind, pubkey: discussion.pubkey, author: discussion.author };
                                  replyingToComment = { id: comment.id, kind: comment.kind, pubkey: comment.pubkey, author: comment.author };
                                  showReplyDialog = true;
                                }}
                              >
                                Reply
                              </button>
                            {/if}
                          </div>
                          <div class="comment-content">
                            <p>{comment.content}</p>
                          </div>
                          {#if comment.replies && comment.replies.length > 0}
                            <div class="nested-replies">
                              {#each comment.replies as reply}
                                <div class="comment-item nested-comment">
                                  <div class="comment-meta">
                                    <UserBadge pubkey={reply.author} />
                                    <span>{new Date(reply.createdAt * 1000).toLocaleString()}</span>
                                    <EventCopyButton eventId={reply.id} kind={reply.kind} pubkey={reply.pubkey} />
                                    {#if userPubkey}
                                      <button 
                                        class="btn btn-small"
                                        onclick={() => {
                                          replyingToThread = { id: discussion.id, kind: discussion.kind, pubkey: discussion.pubkey, author: discussion.author };
                                          replyingToComment = { id: reply.id, kind: reply.kind, pubkey: reply.pubkey, author: reply.author };
                                          showReplyDialog = true;
                                        }}
                                      >
                                        Reply
                                      </button>
                                    {/if}
                                  </div>
                                  <div class="comment-content">
                                    <p>{reply.content}</p>
                                  </div>
                                  {#if reply.replies && reply.replies.length > 0}
                                    <div class="nested-replies">
                                      {#each reply.replies as nestedReply}
                                        <div class="comment-item nested-comment">
                                          <div class="comment-meta">
                                            <UserBadge pubkey={nestedReply.author} />
                                            <span>{new Date(nestedReply.createdAt * 1000).toLocaleString()}</span>
                                            <EventCopyButton eventId={nestedReply.id} kind={nestedReply.kind} pubkey={nestedReply.pubkey} />
                                            {#if userPubkey}
                                              <button 
                                                class="btn btn-small"
                                                onclick={() => {
                                                  replyingToThread = { id: discussion.id, kind: discussion.kind, pubkey: discussion.pubkey, author: discussion.author };
                                                  replyingToComment = { id: nestedReply.id, kind: nestedReply.kind, pubkey: nestedReply.pubkey, author: nestedReply.author };
                                                  showReplyDialog = true;
                                                }}
                                              >
                                                Reply
                                              </button>
                                            {/if}
                                          </div>
                                          <div class="comment-content">
                                            <p>{nestedReply.content}</p>
                                          </div>
                                        </div>
                                      {/each}
                                    </div>
                                  {/if}
                                </div>
                              {/each}
                            </div>
                          {/if}
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </main>

  <!-- Create File Dialog -->
  {#if showCreateFileDialog && userPubkey && isMaintainer}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new file"
      onclick={() => showCreateFileDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreateFileDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New File</h3>
        <label>
          File Name:
          <input type="text" bind:value={newFileName} placeholder="filename.md" />
        </label>
        <label>
          Content:
          <textarea bind:value={newFileContent} rows="10" placeholder="File content..."></textarea>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreateFileDialog = false} class="cancel-button">Cancel</button>
          <button 
            onclick={createFile} 
            disabled={!newFileName.trim() || saving || needsClone} 
            class="save-button"
            title={needsClone ? cloneTooltip : ''}
          >
            {saving ? 'Creating...' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Create Branch Dialog -->
  {#if showCreateBranchDialog && userPubkey && isMaintainer}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new branch"
      onclick={() => showCreateBranchDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreateBranchDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New Branch</h3>
        <label>
          Branch Name:
          <input type="text" bind:value={newBranchName} placeholder="feature/new-feature" />
        </label>
        <label>
          From Branch:
          <select bind:value={newBranchFrom}>
            {#each branches as branch}
              {@const branchName = typeof branch === 'string' ? branch : (branch as { name: string }).name}
              <option value={branchName}>{branchName}</option>
            {/each}
          </select>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreateBranchDialog = false} class="cancel-button">Cancel</button>
          <button 
            onclick={createBranch} 
            disabled={!newBranchName.trim() || saving || needsClone} 
            class="save-button"
            title={needsClone ? cloneTooltip : ''}
          >
            {saving ? 'Creating...' : 'Create Branch'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Create Tag Dialog -->
  {#if showCreateTagDialog && userPubkey && isMaintainer}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new tag"
      onclick={() => showCreateTagDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreateTagDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New Tag</h3>
        <label>
          Tag Name:
          <input type="text" bind:value={newTagName} placeholder="v1.0.0" />
        </label>
        <label>
          Reference (commit/branch):
          <input type="text" bind:value={newTagRef} placeholder="HEAD" />
        </label>
        <label>
          Message (optional, for annotated tag):
          <textarea bind:value={newTagMessage} rows="3" placeholder="Tag message..."></textarea>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreateTagDialog = false} class="cancel-button">Cancel</button>
          <button 
            onclick={createTag} 
            disabled={!newTagName.trim() || saving || needsClone} 
            class="save-button"
            title={needsClone ? cloneTooltip : ''}
          >
            {saving ? 'Creating...' : 'Create Tag'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Create Issue Dialog -->
  {#if showCreateIssueDialog && userPubkey}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new issue"
      onclick={() => showCreateIssueDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreateIssueDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New Issue</h3>
        <label>
          Subject:
          <input type="text" bind:value={newIssueSubject} placeholder="Issue title..." />
        </label>
        <label>
          Description:
          <textarea bind:value={newIssueContent} rows="10" placeholder="Describe the issue..."></textarea>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreateIssueDialog = false} class="cancel-button">Cancel</button>
          <button onclick={createIssue} disabled={!newIssueSubject.trim() || !newIssueContent.trim() || saving} class="save-button">
            {saving ? 'Creating...' : 'Create Issue'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Create Discussion Thread Dialog -->
  {#if showCreateThreadDialog && userPubkey}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new discussion thread"
      onclick={() => showCreateThreadDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreateThreadDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New Discussion Thread</h3>
        <label>
          Title:
          <input type="text" bind:value={newThreadTitle} placeholder="Thread title..." />
        </label>
        <label>
          Content:
          <textarea bind:value={newThreadContent} rows="10" placeholder="Start the discussion..."></textarea>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreateThreadDialog = false} class="cancel-button">Cancel</button>
          <button onclick={createDiscussionThread} disabled={!newThreadTitle.trim() || creatingThread} class="save-button">
            {creatingThread ? 'Creating...' : 'Create Thread'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Reply to Thread/Comment Dialog -->
  {#if showReplyDialog && userPubkey && (replyingToThread || replyingToComment)}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Reply to thread"
      onclick={() => {
        showReplyDialog = false;
        replyingToThread = null;
        replyingToComment = null;
        replyContent = '';
      }}
      onkeydown={(e) => e.key === 'Escape' && (showReplyDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>
          {#if replyingToComment}
            Reply to Comment
          {:else if replyingToThread}
            Reply to Thread
          {:else}
            Reply
          {/if}
        </h3>
        <label>
          Your Reply:
          <textarea bind:value={replyContent} rows="8" placeholder="Write your reply..."></textarea>
        </label>
        <div class="modal-actions">
          <button 
            onclick={() => {
              showReplyDialog = false;
              replyingToThread = null;
              replyingToComment = null;
              replyContent = '';
            }} 
            class="cancel-button"
          >
            Cancel
          </button>
          <button 
            onclick={() => createThreadReply()} 
            disabled={!replyContent.trim() || creatingReply} 
            class="save-button"
          >
            {creatingReply ? 'Posting...' : 'Post Reply'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Create PR Dialog -->
  {#if showCreatePRDialog && userPubkey}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new pull request"
      onclick={() => showCreatePRDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreatePRDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New Pull Request</h3>
        <label>
          Subject:
          <input type="text" bind:value={newPRSubject} placeholder="PR title..." />
        </label>
        <label>
          Description:
          <textarea bind:value={newPRContent} rows="8" placeholder="Describe your changes..."></textarea>
        </label>
        <label>
          Commit ID:
          <input type="text" bind:value={newPRCommitId} placeholder="Commit hash..." />
        </label>
        <label>
          Branch Name (optional):
          <input type="text" bind:value={newPRBranchName} placeholder="feature/new-feature" />
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreatePRDialog = false} class="cancel-button">Cancel</button>
          <button onclick={createPR} disabled={!newPRSubject.trim() || !newPRContent.trim() || !newPRCommitId.trim() || saving} class="save-button">
            {saving ? 'Creating...' : 'Create PR'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Commit Dialog -->
  {#if showCommitDialog && userPubkey && isMaintainer}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Commit changes"
      onclick={() => showCommitDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCommitDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Commit Changes</h3>
        <label>
          Commit Message:
          <textarea 
            bind:value={commitMessage} 
            placeholder="Describe your changes..."
            rows="4"
          ></textarea>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCommitDialog = false} class="cancel-button">Cancel</button>
          <button 
            onclick={saveFile} 
            disabled={!commitMessage.trim() || saving || needsClone} 
            class="save-button"
            title={needsClone ? cloneTooltip : ''}
          >
            {saving ? 'Saving...' : 'Commit & Save'}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Verification File Dialog -->
  {#if showVerificationDialog && verificationFileContent}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Repository verification file"
      onclick={() => showVerificationDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showVerificationDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal verification-modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <div class="modal-header">
          <h3>Repository Verification File</h3>
        </div>
        <div class="modal-body">
          <p class="verification-instructions">
            Create a file named <code>{VERIFICATION_FILE_PATH}</code> in the root of your git repository and paste the content below into it.
            Then commit and push the file to your repository.
          </p>
          <div class="verification-file-content">
            <div class="file-header">
              <span class="filename">{VERIFICATION_FILE_PATH}</span>
              <div class="file-actions">
                <button onclick={copyVerificationToClipboard} class="copy-button">Copy</button>
                <button onclick={downloadVerificationFile} class="download-button">Download</button>
              </div>
            </div>
            <pre class="file-content"><code>{verificationFileContent}</code></pre>
          </div>
        </div>
        <div class="modal-actions">
          <button onclick={() => showVerificationDialog = false} class="cancel-button">Close</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .container {
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  header {
    display: flex;
    flex-direction: column;
    border-bottom: 1px solid var(--border-color);
    background: var(--card-bg);
  }
  
  .header-content {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: flex-start;
    padding: 2rem 2rem 1.5rem 2rem;
    gap: 2rem;
    margin-top: 1rem;
  }
  
  .header-main {
    display: flex;
    flex-direction: column;
    flex: 1;
    gap: 1rem;
    min-width: 0;
    position: relative;
  }
  


  .repo-banner {
    width: 100%;
    height: 200px;
    overflow: hidden;
    background: var(--bg-secondary);
    margin-bottom: 0;
    position: relative;
  }
  
  .repo-banner::before {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(
      to bottom,
      transparent 0%,
      transparent 60%,
      var(--card-bg) 100%
    );
    z-index: 1;
    pointer-events: none;
  }
  
  .repo-banner::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(
      to right,
      transparent 0%,
      transparent 85%,
      var(--card-bg) 100%
    );
    z-index: 1;
    pointer-events: none;
  }

  .repo-banner img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .repo-title-section {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 0.5rem;
    width: 100%;
  }

  .repo-title-text {
    flex: 1;
    min-width: 0; /* Allow text to shrink */
  }

  .repo-title-with-menu {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .bookmark-icon-button {
    padding: 0.375rem;
    background: var(--card-bg);
    border: 2px solid var(--border-color);
    border-radius: 0.375rem;
    cursor: pointer;
    color: var(--text-primary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
  }

  .bookmark-icon-button:hover:not(:disabled) {
    background: var(--bg-secondary);
    border-color: var(--accent);
    color: var(--accent);
  }

  .bookmark-icon-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    border-color: var(--border-light);
  }

  .bookmark-icon-button.bookmarked {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-text, #ffffff);
  }

  .bookmark-icon-button.bookmarked:hover:not(:disabled) {
    background: var(--accent-hover);
    border-color: var(--accent-hover);
    opacity: 1;
  }

  .bookmark-icon-button .icon-inline {
    width: 1rem;
    height: 1rem;
    filter: brightness(0) saturate(100%) invert(1) !important; /* Default white for dark themes */
    opacity: 1 !important;
  }

  /* Light theme: black icon */
  :global([data-theme="light"]) .bookmark-icon-button .icon-inline {
    filter: brightness(0) saturate(100%) !important; /* Black in light theme */
    opacity: 1 !important;
  }

  /* Dark themes: white icon */
  :global([data-theme="dark"]) .bookmark-icon-button .icon-inline,
  :global([data-theme="black"]) .bookmark-icon-button .icon-inline {
    filter: brightness(0) saturate(100%) invert(1) !important; /* White in dark themes */
    opacity: 1 !important;
  }

  /* Hover: white for visibility */
  .bookmark-icon-button:hover:not(:disabled) .icon-inline {
    filter: brightness(0) saturate(100%) invert(1) !important;
    opacity: 1 !important;
  }

  /* Light theme hover: keep black */
  :global([data-theme="light"]) .bookmark-icon-button:hover:not(:disabled) .icon-inline {
    filter: brightness(0) saturate(100%) !important;
    opacity: 1 !important;
  }

  /* Bookmarked state: icon should be white (on accent background) */
  .bookmark-icon-button.bookmarked .icon-inline {
    filter: brightness(0) saturate(100%) invert(1) !important; /* White on accent background */
    opacity: 1 !important;
  }

  .repo-title-text h1 {
    margin: 0;
    word-wrap: break-word;
    color: var(--text-primary);
    font-weight: 600;
  }

  .repo-menu-container {
    position: relative;
  }

  .repo-menu-button {
    padding: 0.375rem;
    background: var(--card-bg);
    border: 2px solid var(--border-color);
    border-radius: 0.375rem;
    cursor: pointer;
    color: var(--text-primary);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
    width: 2rem;
    height: 2rem;
  }

  .repo-menu-button:hover {
    background: var(--bg-secondary);
    border-color: var(--accent);
    color: var(--accent);
  }

  .repo-menu-button svg {
    width: 16px;
    height: 16px;
  }

  .repo-menu-dropdown {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 0.5rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    min-width: 240px;
    white-space: nowrap;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .repo-menu-item {
    padding: 0.75rem 1rem;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-color);
    text-align: left;
    cursor: pointer;
    color: var(--text-primary);
    font-size: 0.875rem;
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease;
    text-decoration: none;
    display: block;
    width: 100%;
    white-space: nowrap;
  }

  .repo-menu-item:last-child {
    border-bottom: none;
  }

  .repo-menu-item:hover:not(:disabled) {
    background: var(--bg-secondary);
  }

  .repo-menu-item:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .repo-menu-item-danger {
    color: var(--error-text, #dc2626);
  }

  .repo-menu-item-danger:hover:not(:disabled) {
    background: var(--error-bg, rgba(220, 38, 38, 0.1));
  }

  .repo-image {
    width: 80px;
    height: 80px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
    display: block;
    background: var(--bg-secondary);
    border: 3px solid var(--card-bg);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }
  
  /* Position repo image over banner if banner exists */
  header:has(.repo-banner) .header-content {
    margin-top: -30px; /* Overlap banner slightly */
    position: relative;
    z-index: 2;
    padding-left: 2.5rem; /* Extra padding on left to create space from banner edge */
  }
  
  header:has(.repo-banner) .repo-image {
    border-color: var(--card-bg);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15);
  }
  
  /* Responsive design for smaller screens */
  .mobile-toggle-button {
    display: none; /* Hidden by default on desktop */
    padding: 0.5rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 4px;
    cursor: pointer;
    transition: background 0.2s;
    align-items: center;
    justify-content: center;
  }

  .mobile-toggle-button .icon-inline {
    width: 16px;
    height: 16px;
  }

  .mobile-toggle-button:hover {
    background: var(--bg-primary);
  }

  .hide-on-mobile {
    display: none;
  }

  @media (max-width: 768px) {
    .header-content {
      flex-direction: column;
      align-items: flex-start;
      gap: 1rem;
    }
    
    .header-actions {
      width: 100%;
      justify-content: flex-start;
      flex-wrap: wrap;
    }
    
    .repo-banner {
      height: 150px;
    }
    
    header:has(.repo-banner) .header-content {
      margin-top: -30px;
    }

    .repo-image {
      width: 60px;
      height: 60px;
    }

    /* Mobile toggle button visible on narrow screens */
    .mobile-toggle-button {
      display: inline-flex;
    }

    /* File tree and editor area full width and height on mobile */
    .file-tree {
      width: 100%;
      flex: 1 1 auto;
      min-height: 0;
      flex-basis: auto;
    }

    .editor-area {
      width: 100%;
      flex: 1;
      min-height: 0;
      max-height: none;
    }

    /* Hide the appropriate view based on toggle state */
    .file-tree.hide-on-mobile {
      display: none !important;
    }

    .editor-area.hide-on-mobile {
      display: none !important;
    }

    /* Stack layout on mobile */
    .repo-layout {
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }
    
    .repo-image {
      width: 64px;
      height: 64px;
    }
    
    .repo-title-text h1 {
      font-size: 1.5rem;
    }

    /* Editor header wraps on mobile */
    .editor-header {
      flex-wrap: wrap;
      gap: 0.25rem;
      padding: 0.5rem 0.75rem;
      align-items: flex-start;
    }

    .file-path {
      flex: 1 1 100%;
      min-width: 0;
      word-break: break-all;
      margin-bottom: 0;
      padding-bottom: 0;
    }

    .editor-actions {
      flex: 1 1 auto;
      justify-content: flex-end;
      min-width: 0;
      gap: 0.5rem;
    }

    .non-maintainer-notice {
      font-size: 0.7rem;
      flex: 1 1 100%;
      order: 2;
      margin-top: 0;
      padding-top: 0.25rem;
      line-height: 1.3;
    }

    /* Make tabs more readable and responsive on mobile */
    .tabs {
      padding: 0.5rem 0.75rem;
      gap: 0.5rem;
      -webkit-overflow-scrolling: touch;
      scroll-behavior: smooth;
      scroll-padding: 0.5rem;
    }

    .tab-button {
      padding: 0.5rem 0.875rem;
      font-size: 0.875rem;
      font-weight: 500;
      min-height: 2.5rem;
      border-bottom-width: 3px;
      touch-action: manipulation; /* Better touch response */
    }

    .tab-button.active {
      font-weight: 600;
      border-bottom-width: 3px;
    }

    /* Better visual feedback for touch */
    .tab-button:active {
      transform: scale(0.98);
      transition: transform 0.1s ease;
    }
  }

  /* Extra small screens - make tabs even more readable */
  @media (max-width: 480px) {
    .tabs {
      padding: 0.5rem;
      gap: 0.375rem;
    }

    .tab-button {
      padding: 0.625rem 0.75rem;
      font-size: 0.875rem;
      min-height: 2.75rem;
    }
  }

  /* Desktop: always show both file tree and editor */
  @media (min-width: 769px) {
    .file-tree.hide-on-mobile {
      display: flex;
    }

    .editor-area.hide-on-mobile {
      display: flex;
    }

    .mobile-toggle-button {
      display: none;
    }
  }

  .repo-image[src=""],
  .repo-image:not([src]) {
    display: none;
  }

  .repo-banner img[src=""],
  .repo-banner img:not([src]) {
    display: none;
  }

  .repo-description-header {
    margin: 0.25rem 0 0 0;
    color: var(--text-secondary);
    font-size: 0.9rem;
    line-height: 1.4;
    max-width: 100%;
    word-wrap: break-word;
  }

  .repo-description-placeholder {
    color: var(--text-secondary);
    font-style: italic;
    opacity: 0.8;
  }

  .fork-badge {
    padding: 0.25rem 0.5rem;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    border-radius: 4px;
    font-size: 0.85rem;
    margin-left: 0.5rem;
    font-weight: 600;
    border: 1px solid var(--accent);
  }

  .fork-badge a {
    color: var(--accent-text, #ffffff);
    text-decoration: none;
    font-weight: 600;
  }

  .fork-badge a:hover {
    text-decoration: underline;
    opacity: 1;
  }

  .repo-meta-info {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    margin-top: 0.5rem;
  }

  .repo-language {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.875rem;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .repo-language .icon-inline {
    opacity: 0.9;
  }

  .repo-privacy-badge {
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    border: 1px solid transparent;
  }

  .repo-privacy-badge.private {
    background: var(--error-bg);
    color: var(--error-text);
    border-color: var(--error-text);
  }

  .repo-privacy-badge.public {
    background: var(--success-bg);
    color: var(--success-text);
    border-color: var(--success-text);
  }

  .repo-topics {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .topic-tag {
    padding: 0.25rem 0.5rem;
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    border-radius: 0.25rem;
    font-size: 0.75rem;
    font-weight: 600;
    border: 1px solid var(--accent);
  }


  .repo-website {
    margin-top: 0.5rem;
    font-size: 0.875rem;
  }

  .repo-website a {
    color: var(--link-color);
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }

  .repo-website a:hover {
    text-decoration: underline;
  }

  .repo-clone-urls {
    margin-top: 0.5rem;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.75rem;
  }

  .clone-label {
    color: var(--text-muted);
    font-weight: 500;
  }

  .clone-url-wrapper {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
  }

  .clone-url {
    padding: 0.125rem 0.375rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.25rem;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-primary);
  }

  .clone-more {
    color: var(--text-muted);
    font-size: 0.75rem;
  }

  .repo-contributors {
    margin-top: 0.75rem;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
  }

  .contributors-label {
    font-size: 0.875rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .contributors-list {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .contributor-item {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    text-decoration: none;
    padding: 0.25rem 0.5rem;
    border-radius: 0.5rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    transition: all 0.2s ease;
  }

  .contributor-item:hover {
    border-color: var(--accent);
    background: var(--card-bg);
  }

  .contributor-badge {
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    white-space: nowrap;
    letter-spacing: 0.05em;
    border: 1px solid transparent;
    /* Ensure minimum size for touch targets */
    min-height: 1.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .contributor-badge.owner {
    /* High contrast colors for all themes */
    background: var(--bg-tertiary, #4a5568);
    color: var(--text-primary, #ffffff);
    border-color: var(--border-color, #2d3748);
  }


  .contributor-badge.maintainer {
    /* High contrast colors for all themes */
    background: var(--success-bg, #22543d);
    color: var(--success-text, #ffffff);
    border-color: var(--border-color, #1a202c);
  }


  header h1 {
    margin: 0;
    font-size: 1.5rem;
    color: var(--text-primary);
  }
  .header-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.75rem;
    flex-shrink: 0;
    flex-wrap: wrap;
  }

  .branch-select {
    padding: 0.5rem;
    border: 1px solid var(--input-border);
    border-radius: 0.25rem;
    background: var(--input-bg);
    color: var(--text-primary);
    font-family: 'IBM Plex Serif', serif;
  }

  .branch-select-empty {
    padding: 0.5rem;
    border: 1px solid var(--input-border);
    border-radius: 0.25rem;
    background: var(--input-bg);
    color: var(--text-muted);
    font-family: 'IBM Plex Serif', serif;
    opacity: 0.7;
    cursor: not-allowed;
    user-select: none;
  }


  .repo-view {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .repo-layout {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .file-tree {
    width: 300px;
    min-width: 300px;
    max-width: 300px;
    border-right: 1px solid var(--border-color);
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    flex: 0 0 300px; /* Fixed width, don't grow or shrink */
    min-height: 0; /* Allow flex child to shrink */
  }

  .file-tree-header {
    padding: 1rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .file-tree-header h2 {
    margin: 0;
    font-size: 1rem;
    color: var(--text-primary);
  }

  .back-button {
    padding: 0.25rem 0.5rem;
    font-size: 0.875rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 0.25rem;
    cursor: pointer;
    color: var(--text-primary);
    transition: background 0.2s ease;
  }

  .back-button:hover {
    background: var(--bg-secondary);
  }

  .file-list {
    list-style: none;
    padding: 0.5rem 0;
    margin: 0;
    overflow-y: auto;
    overflow-x: hidden;
    flex: 1;
    min-height: 0; /* Allows flex child to shrink below content size */
    width: 100%; /* Fill horizontal space */
  }

  .file-item {
    margin: 0;
  }

  .file-button {
    width: 100%;
    padding: 0.5rem 1rem;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-primary);
    font-weight: 500;
    transition: background 0.2s ease, color 0.2s ease;
    box-sizing: border-box;
  }

  .file-button:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .file-item.selected .file-button {
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    font-weight: 600;
  }

  .file-item.selected .file-button:hover {
    background: var(--accent-hover);
    color: var(--accent-text, #ffffff);
  }

  .file-size {
    color: var(--text-secondary);
    font-size: 0.75rem;
    margin-left: auto;
    opacity: 0.9;
  }

  .file-item.selected .file-size {
    color: var(--accent-text, #ffffff);
    opacity: 0.9;
  }

  .editor-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--card-bg);
    max-height: calc(200vh - 400px); /* Twice the original height */
  }

  .editor-header {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .file-path {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.875rem;
    color: var(--text-primary);
  }

  .editor-actions {
    display: flex;
    align-items: center;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .unsaved-indicator {
    color: var(--warning-text);
    font-size: 0.875rem;
  }

  .non-maintainer-notice {
    font-size: 0.75rem;
    color: var(--text-muted);
    white-space: normal;
    line-height: 1.4;
  }

  .save-button {
    padding: 0.5rem 1rem;
    background: var(--button-primary);
    color: var(--accent-text, #ffffff);
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
    font-size: 0.875rem;
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease;
  }

  .save-button:hover:not(:disabled) {
    background: var(--button-primary-hover);
  }

  .save-button:disabled {
    background: var(--text-muted);
    cursor: not-allowed;
    opacity: 0.6;
  }

  .editor-container {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0; /* Allows flex child to shrink below content size */
  }

  .empty-state {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }

  .loading {
    padding: 2rem;
    text-align: center;
    color: var(--text-muted);
  }

  .error {
    background: var(--error-bg);
    color: var(--error-text);
    padding: 1rem;
    margin: 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--error-text);
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    background: var(--card-bg);
    padding: 2rem;
    border-radius: 0.5rem;
    min-width: 400px;
    max-width: 600px;
    border: 1px solid var(--border-color);
  }

  .modal h3 {
    margin: 0 0 1rem 0;
    color: var(--text-primary);
  }

  .verification-modal {
    max-width: 800px;
    min-width: 600px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal-header {
    flex-shrink: 0;
    margin-bottom: 1rem;
  }

  .modal-body {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }

  .verification-instructions {
    color: var(--text-secondary);
    margin-bottom: 1rem;
    line-height: 1.6;
  }

  .verification-instructions code {
    background: var(--bg-secondary);
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-family: monospace;
    color: var(--accent);
  }

  .verification-file-content {
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    overflow: hidden;
    margin-bottom: 1rem;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
  }

  .file-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-color);
  }

  .filename {
    font-family: monospace;
    font-weight: 500;
    color: var(--text-primary);
  }

  .file-actions {
    display: flex;
    gap: 0.5rem;
  }

  .copy-button,
  .download-button {
    padding: 0.375rem 0.75rem;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border-color);
    border-radius: 0.25rem;
    font-size: 0.875rem;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .copy-button:hover,
  .download-button:hover {
    background: var(--bg-secondary);
    border-color: var(--accent);
  }

  .file-content {
    margin: 0;
    padding: 1rem;
    overflow-x: auto;
    overflow-y: auto;
    background: var(--bg-primary);
    max-height: 400px;
  }

  .file-content code {
    font-family: 'Courier New', monospace;
    font-size: 0.875rem;
    color: var(--text-primary);
    white-space: pre;
  }

  .modal label {
    display: block;
    margin-bottom: 1rem;
    color: var(--text-primary);
  }

  .modal input,
  .modal textarea,
  .modal select {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid var(--input-border);
    border-radius: 0.25rem;
    font-family: 'IBM Plex Serif', serif;
    background: var(--input-bg);
    color: var(--text-primary);
    margin-top: 0.5rem;
  }

  .modal input:focus,
  .modal textarea:focus,
  .modal select:focus {
    outline: none;
    border-color: var(--input-focus);
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
  }

  .cancel-button {
    padding: 0.5rem 1rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 0.25rem;
    cursor: pointer;
    color: var(--text-primary);
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease;
  }

  .cancel-button:hover {
    background: var(--bg-secondary);
  }

  .save-button {
    background: var(--button-primary);
    color: white;
  }

  .save-button:hover:not(:disabled) {
    background: var(--button-primary-hover);
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 0.25rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border-color);
    background: var(--card-bg);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    -webkit-overflow-scrolling: touch;
    scroll-behavior: smooth;
    position: relative;
  }

  .tabs::-webkit-scrollbar {
    height: 6px;
  }

  .tabs::-webkit-scrollbar-track {
    background: var(--bg-secondary);
  }

  .tabs::-webkit-scrollbar-thumb {
    background: var(--border-color);
    border-radius: 3px;
  }

  .tabs::-webkit-scrollbar-thumb:hover {
    background: var(--accent);
  }

  .tab-button {
    padding: 0.5rem 0.875rem;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--text-secondary);
    font-family: 'IBM Plex Serif', serif;
    transition: color 0.2s ease, border-color 0.2s ease, background 0.2s ease;
    white-space: nowrap;
    flex-shrink: 0;
    font-weight: 500;
    border-radius: 0.25rem 0.25rem 0 0;
  }

  .tab-button:hover {
    color: var(--text-primary);
    background: var(--bg-secondary);
  }

  .tab-button.active {
    color: var(--accent);
    border-bottom-color: var(--accent);
    font-weight: 600;
    background: var(--bg-secondary);
  }

  /* File tree actions */
  .file-tree-actions {
    display: flex;
    gap: 0.5rem;
  }

  .create-file-button, .create-tag-button {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    background: var(--button-primary);
    color: white;
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease;
  }

  .create-file-button:hover, .create-tag-button:hover {
    background: var(--button-primary-hover);
  }

  .delete-file-button {
    padding: 0.25rem;
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.75rem;
    opacity: 0.6;
  }

  .delete-file-button:hover {
    opacity: 1;
  }

  .file-item {
    display: flex;
    align-items: center;
  }

  .file-item .file-button {
    flex: 1;
  }

  /* History sidebar */
  .history-sidebar, .tags-sidebar {
    width: 300px;
    border-right: 1px solid var(--border-color);
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .history-header, .tags-header {
    padding: 1rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .history-header h2, .tags-header h2 {
    margin: 0;
    font-size: 1rem;
    color: var(--text-primary);
  }

  .refresh-button {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 0.25rem;
    cursor: pointer;
    color: var(--text-primary);
    transition: background 0.2s ease;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }

  .refresh-button:hover {
    background: var(--bg-secondary);
  }

  .refresh-button .icon-inline {
    width: 0.875rem;
    height: 0.875rem;
  }

  .commit-list, .tag-list {
    list-style: none;
    padding: 0;
    margin: 0;
    overflow-y: auto;
    flex: 1;
  }

  .commit-item, .tag-item {
    border-bottom: 1px solid var(--border-color);
  }

  .commit-button {
    width: 100%;
    padding: 0.75rem 1rem;
    text-align: left;
    background: none;
    border: none;
    cursor: pointer;
    display: block;
  }

  .commit-button:hover {
    background: var(--bg-tertiary);
  }

  .commit-item.selected .commit-button {
    background: var(--accent);
    color: var(--accent-text, #ffffff);
  }

  .commit-hash {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-bottom: 0.25rem;
  }

  .commit-message {
    font-weight: 500;
    margin-bottom: 0.25rem;
    color: var(--text-primary);
  }

  .commit-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
    display: flex;
    gap: 1rem;
  }

  .tag-item {
    padding: 0.75rem 1rem;
  }

  .tag-name {
    font-weight: 500;
    color: var(--link-color);
    margin-bottom: 0.25rem;
  }

  .tag-hash {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
    margin-bottom: 0.25rem;
  }

  .tag-message {
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  /* Diff view */
  .diff-view {
    flex: 1;
    overflow: auto;
    padding: 1rem;
  }

  .diff-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-color);
  }

  .diff-header h3 {
    margin: 0;
    color: var(--text-primary);
  }

  .close-button {
    padding: 0.25rem 0.5rem;
    background: var(--bg-tertiary);
    border: 1px solid var(--border-color);
    border-radius: 0.25rem;
    cursor: pointer;
    font-size: 1.25rem;
    line-height: 1;
    color: var(--text-primary);
    transition: background 0.2s ease;
  }

  .close-button:hover {
    background: var(--bg-secondary);
  }

  .diff-file {
    margin-bottom: 2rem;
  }

  .diff-file-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem;
    background: var(--bg-secondary);
    border-radius: 0.25rem;
    margin-bottom: 0.5rem;
  }

  .diff-file-name {
    font-family: 'IBM Plex Mono', monospace;
    font-weight: 500;
    color: var(--text-primary);
  }

  .diff-stats {
    display: flex;
    gap: 0.5rem;
  }

  .additions {
    color: var(--success-text);
  }

  .deletions {
    color: var(--error-text);
  }

  .diff-content {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    padding: 1rem;
    border-radius: 0.25rem;
    overflow-x: auto;
    font-size: 0.875rem;
    line-height: 1.5;
    border: 1px solid var(--border-color);
  }

  .diff-content code {
    font-family: 'IBM Plex Mono', monospace;
    white-space: pre;
  }

  .read-only-editor {
    height: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 1.5rem;
    min-height: 0; /* Allows flex child to shrink below content size */
  }

  .read-only-editor :global(.hljs) {
    padding: 1rem;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border-radius: 4px;
    overflow-x: auto;
    margin: 0;
    border: 1px solid var(--border-color);
  }

  .read-only-editor :global(pre) {
    margin: 0;
    padding: 0;
  }

  .read-only-editor :global(code) {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 14px;
    line-height: 1.5;
    display: block;
    white-space: pre;
  }

  .readme-section {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .readme-header {
    padding: 1rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }

  .readme-header h3 {
    margin: 0;
    font-size: 1.25rem;
    color: var(--text-primary);
  }

  .readme-actions {
    display: flex;
    gap: 1rem;
    align-items: center;
  }

  .discussions-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overflow-x: hidden;
    background: var(--card-bg);
    min-height: 0; /* Allows flex child to shrink below content size */
  }

  .discussions-header {
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }

  .discussions-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  .btn-secondary {
    padding: 0.5rem 1rem;
    background: var(--bg-secondary);
    border: 1px solid var(--border-color);
    border-radius: 0.25rem;
    color: var(--text-primary);
    cursor: pointer;
    font-size: 0.875rem;
    transition: background 0.2s;
  }

  .btn-secondary:hover:not(:disabled) {
    background: var(--bg-tertiary);
  }

  .btn-secondary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .discussions-header h2 {
    margin: 0;
    font-size: 1.25rem;
    color: var(--text-primary);
  }

  .discussion-item {
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--border-color);
  }

  .discussion-header {
    margin-bottom: 0.5rem;
  }

  .discussion-header h3 {
    margin: 0 0 0.25rem 0;
    font-size: 1.1rem;
    color: var(--text-primary);
  }

  .discussion-meta {
    display: flex;
    gap: 1rem;
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .discussion-type {
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    background: var(--bg-secondary);
    font-weight: 500;
  }

  .discussion-body {
    margin-top: 0.5rem;
    color: var(--text-primary);
    white-space: pre-wrap;
  }

  .discussion-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .expand-button {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 1.5rem;
    transition: color 0.2s;
  }

  .expand-button:hover {
    color: var(--text-primary);
  }

  .comment-count {
    font-weight: 500;
  }

  .btn-small {
    padding: 0.25rem 0.75rem;
    font-size: 0.875rem;
  }

  .comments-section {
    margin-top: 1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border-color);
  }

  .comments-section h4 {
    margin: 0 0 0.75rem 0;
    font-size: 0.9rem;
    color: var(--text-muted);
    font-weight: 500;
  }

  .comment-item {
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--border-light);
  }

  .comment-item:last-child {
    border-bottom: none;
  }

  .comment-meta {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .comment-content {
    color: var(--text-primary);
    white-space: pre-wrap;
    line-height: 1.5;
  }

  .nested-replies {
    margin-left: 2rem;
    margin-top: 0.75rem;
    padding-left: 1rem;
    border-left: 2px solid var(--border-light);
  }

  .nested-comment {
    margin-top: 0.75rem;
  }

  .readme-content {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 1.5rem;
    min-height: 0; /* Allows flex child to shrink below content size */
  }

  .readme-content.markdown {
    padding: 1.5rem;
  }

  .readme-content.markdown :global(h1),
  .readme-content.markdown :global(h2),
  .readme-content.markdown :global(h3),
  .readme-content.markdown :global(h4),
  .readme-content.markdown :global(h5),
  .readme-content.markdown :global(h6) {
    margin-top: 1.5rem;
    margin-bottom: 0.75rem;
    color: var(--text-primary);
  }

  .readme-content.markdown :global(p) {
    margin-bottom: 1rem;
    line-height: 1.6;
  }

  .readme-content.markdown :global(code) {
    background: var(--bg-secondary);
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.9em;
  }

  .readme-content.markdown :global(pre) {
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
    border: 1px solid var(--border-light);
    margin: 1rem 0;
  }

  .readme-content.markdown :global(pre code) {
    background: none;
    padding: 0;
  }

  .readme-content :global(.hljs) {
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
    border: 1px solid var(--border-light);
  }

  .readme-content :global(pre.hljs) {
    margin: 1rem 0;
  }

  /* Documentation */
  .docs-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--card-bg);
  }

  .documentation-body {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 1.5rem;
    min-height: 0;
  }

  .documentation-body :global(h1),
  .documentation-body :global(h2),
  .documentation-body :global(h3),
  .documentation-body :global(h4),
  .documentation-body :global(h5),
  .documentation-body :global(h6) {
    margin-top: 1.5rem;
    margin-bottom: 0.75rem;
    color: var(--text-primary);
  }

  .documentation-body :global(p) {
    margin-bottom: 1rem;
    line-height: 1.6;
  }

  .documentation-body :global(code) {
    background: var(--bg-secondary);
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.9em;
  }

  .documentation-body :global(pre) {
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
    border: 1px solid var(--border-light);
    margin: 1rem 0;
  }

  .documentation-body :global(pre code) {
    background: none;
    padding: 0;
  }

  .documentation-body :global(.hljs) {
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 4px;
    overflow-x: auto;
    border: 1px solid var(--border-light);
  }

  .documentation-body :global(pre.hljs) {
    margin: 1rem 0;
  }

  /* Issues and PRs */
  .issues-sidebar, .prs-sidebar {
    width: 300px;
    border-right: 1px solid var(--border-color);
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .issues-header, .prs-header {
    padding: 1rem;
    border-bottom: 1px solid var(--border-color);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .issues-header h2, .prs-header h2 {
    margin: 0;
    font-size: 1rem;
    color: var(--text-primary);
  }

  .create-issue-button, .create-pr-button {
    padding: 0.25rem 0.5rem;
    font-size: 0.75rem;
    background: var(--button-primary);
    color: white;
    border: none;
    border-radius: 0.25rem;
    cursor: pointer;
    font-family: 'IBM Plex Serif', serif;
    transition: background 0.2s ease;
  }

  .create-issue-button:hover, .create-pr-button:hover {
    background: var(--button-primary-hover);
  }

  .issue-list, .pr-list {
    list-style: none;
    padding: 0;
    margin: 0;
    overflow-y: auto;
    flex: 1;
  }

  .issue-item, .pr-item {
    padding: 0.75rem 1rem;
    border-bottom: 1px solid var(--border-color);
    cursor: pointer;
    transition: background 0.2s ease;
  }

  .issue-item:hover, .pr-item:hover {
    background: var(--bg-tertiary);
  }

  .issue-header, .pr-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .issue-status, .pr-status {
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    font-weight: 500;
    text-transform: uppercase;
  }

  .issue-status.open, .pr-status.open {
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    font-weight: 600;
  }

  .issue-status.closed, .pr-status.closed {
    background: var(--error-bg);
    color: var(--error-text);
  }

  .issue-status.resolved, .pr-status.merged {
    background: var(--success-bg);
    color: var(--success-text);
  }

  .issue-subject, .pr-subject {
    font-weight: 500;
    flex: 1;
    color: var(--text-primary);
  }

  .issue-meta, .pr-meta {
    font-size: 0.75rem;
    color: var(--text-muted);
    display: flex;
    gap: 0.75rem;
  }

  .pr-commit {
    font-family: 'IBM Plex Mono', monospace;
  }

  .issues-content, .prs-content {
    flex: 1;
    overflow-y: auto;
    padding: 2rem;
    background: var(--card-bg);
  }

  .issue-detail, .pr-detail {
    margin-bottom: 2rem;
    padding-bottom: 2rem;
    border-bottom: 1px solid var(--border-color);
  }

  .issue-detail h3, .pr-detail h3 {
    margin: 0 0 0.5rem 0;
    font-size: 1.5rem;
    color: var(--text-primary);
  }

  .issue-meta-detail, .pr-meta-detail {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
    font-size: 0.875rem;
    color: var(--text-muted);
  }

  .issue-body, .pr-body {
    line-height: 1.6;
    color: var(--text-primary);
  }

  .verification-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    font-size: 0.75rem;
    flex-shrink: 0;
  }

  .verification-badge.loading {
    opacity: 0.6;
  }

  .verification-badge.verified {
    color: var(--success-text, #10b981);
  }

  .verification-badge.unverified {
    color: var(--error-text, #f59e0b);
  }

  .verification-badge .icon-inline {
    width: 1em;
    height: 1em;
    margin: 0;
  }

  .icon-inline {
    width: 1em;
    height: 1em;
    vertical-align: middle;
    display: inline-block;
    margin-right: 0.25rem;
    /* Make icons visible on dark backgrounds by inverting to light */
    filter: brightness(0) saturate(100%) invert(1);
  }

  .icon-small {
    width: 16px;
    height: 16px;
    vertical-align: middle;
    /* Make icons visible on dark backgrounds by inverting to light */
    filter: brightness(0) saturate(100%) invert(1);
  }

  /* Theme-aware icon colors */

  .verification-badge.verified .icon-inline {
    /* Green checkmark for verified */
    filter: brightness(0) saturate(100%) invert(48%) sepia(79%) saturate(2476%) hue-rotate(86deg) brightness(118%) contrast(119%);
  }

  .verification-badge.unverified .icon-inline {
    /* Orange/yellow warning for unverified */
    filter: brightness(0) saturate(100%) invert(67%) sepia(93%) saturate(1352%) hue-rotate(358deg) brightness(102%) contrast(106%);
  }

  .file-button .icon-inline {
    filter: brightness(0) saturate(100%) invert(1);
    opacity: 0.7;
  }

  .delete-file-button .icon-small {
    /* Red for delete button */
    filter: brightness(0) saturate(100%) invert(27%) sepia(51%) saturate(2878%) hue-rotate(346deg) brightness(104%) contrast(97%);
  }

</style>
