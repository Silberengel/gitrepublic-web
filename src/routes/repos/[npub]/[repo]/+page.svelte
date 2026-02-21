<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import CodeEditor from '$lib/components/CodeEditor.svelte';
  import PRDetail from '$lib/components/PRDetail.svelte';
  import UserBadge from '$lib/components/UserBadge.svelte';
  import EventCopyButton from '$lib/components/EventCopyButton.svelte';
  import RepoHeaderEnhanced from '$lib/components/RepoHeaderEnhanced.svelte';
  import RepoTabs from '$lib/components/RepoTabs.svelte';
  import NostrLinkRenderer from '$lib/components/NostrLinkRenderer.svelte';
  import '$lib/styles/repo.css';
  import { getPublicKeyWithNIP07, isNIP07Available, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS, combineRelays } from '$lib/config.js';
  import { getUserRelays } from '$lib/services/nostr/user-relays.js';
  import { BookmarksService } from '$lib/services/nostr/bookmarks-service.js';
  import { KIND } from '$lib/types/nostr.js';
  import { nip19 } from 'nostr-tools';
  import { userStore } from '$lib/stores/user-store.js';
  import { settingsStore } from '$lib/services/settings-store.js';
  // Note: Announcements are now stored in nostr/repo-events.jsonl, not .nostr-announcement
  import type { NostrEvent } from '$lib/types/nostr.js';
  import { hasUnlimitedAccess } from '$lib/utils/user-access.js';
  import { fetchUserEmail, fetchUserName } from '$lib/utils/user-profile.js';

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
  
  // Auto-save
  let autoSaveInterval: ReturnType<typeof setInterval> | null = null;

  // Load maintainers when page data changes (only once per repo, with guard)
  let lastRepoKey = $state<string | null>(null);
  let maintainersEffectRan = $state(false);
  
  $effect(() => {
    const data = $page.data as typeof pageData;
    const currentRepoKey = `${npub}/${repo}`;
    
    // Reset flags if repo changed
    if (currentRepoKey !== lastRepoKey) {
      maintainersLoaded = false;
      maintainersEffectRan = false;
      lastRepoKey = currentRepoKey;
    }
    
    // Only load if:
    // 1. We have page data
    // 2. Effect hasn't run yet for this repo
    // 3. We're not currently loading
    if ((data.repoOwnerPubkey || (data.repoMaintainers && data.repoMaintainers.length > 0)) && 
        !maintainersEffectRan && 
        !loadingMaintainers) {
      maintainersEffectRan = true; // Mark as ran to prevent re-running
      maintainersLoaded = true; // Set flag before loading to prevent concurrent calls
      loadAllMaintainers().catch(err => {
        maintainersLoaded = false; // Reset on error so we can retry
        maintainersEffectRan = false; // Allow retry
        console.warn('Failed to load maintainers:', err);
      });
    }
  });

  // Watch for auto-save setting changes
  $effect(() => {
    // Check auto-save setting and update interval (async, but don't await)
    settingsStore.getSettings().then(settings => {
      if (settings.autoSave && !autoSaveInterval) {
        // Auto-save was enabled, set it up
        setupAutoSave();
      } else if (!settings.autoSave && autoSaveInterval) {
        // Auto-save was disabled, clear interval
        if (autoSaveInterval) {
          clearInterval(autoSaveInterval);
          autoSaveInterval = null;
        }
      }
    }).catch(err => {
      console.warn('Failed to check auto-save setting:', err);
    });
  });

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
        // Reset flags to allow reload
        maintainersLoaded = false;
        maintainersEffectRan = false;
        lastRepoKey = null;
        loadAllMaintainers().catch(err => console.warn('Failed to reload maintainers after login:', err));
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
        // Reset flags to allow reload
        maintainersLoaded = false;
        maintainersEffectRan = false;
        lastRepoKey = null;
        loadAllMaintainers().catch(err => console.warn('Failed to reload maintainers after logout:', err));
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
  let defaultBranchName = $state('master'); // Default branch from settings

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
  
  // All maintainers (including owner) for display
  let allMaintainers = $state<Array<{ pubkey: string; isOwner: boolean }>>([]);
  let loadingMaintainers = $state(false);
  let maintainersLoaded = $state(false); // Guard to prevent repeated loads
  
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
  let updatingIssueStatus = $state<Record<string, boolean>>({});

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

  // Patches
  let showCreatePatchDialog = $state(false);
  let newPatchContent = $state('');
  let newPatchSubject = $state('');
  let creatingPatch = $state(false);

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

  // Discussion events cache for reply/quote blurbs
  let discussionEvents = $state<Map<string, NostrEvent>>(new Map());
  
  // Nostr link cache for embedded events and profiles
  let nostrLinkEvents = $state<Map<string, NostrEvent>>(new Map());
  let nostrLinkProfiles = $state<Map<string, string>>(new Map()); // npub -> pubkey hex

  // Parse nostr: links from content and extract IDs/pubkeys
  function parseNostrLinks(content: string): Array<{ type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'profile'; value: string; start: number; end: number }> {
    const links: Array<{ type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'profile'; value: string; start: number; end: number }> = [];
    const nostrLinkRegex = /nostr:(nevent1|naddr1|note1|npub1|profile1)[a-zA-Z0-9]+/g;
    let match;
    
    while ((match = nostrLinkRegex.exec(content)) !== null) {
      const fullMatch = match[0];
      const prefix = match[1];
      let type: 'nevent' | 'naddr' | 'note1' | 'npub' | 'profile';
      
      if (prefix === 'nevent1') type = 'nevent';
      else if (prefix === 'naddr1') type = 'naddr';
      else if (prefix === 'note1') type = 'note1';
      else if (prefix === 'npub1') type = 'npub';
      else if (prefix === 'profile1') type = 'profile';
      else continue;
      
      links.push({
        type,
        value: fullMatch,
        start: match.index,
        end: match.index + fullMatch.length
      });
    }
    
    return links;
  }

  // Load events/profiles from nostr: links
  async function loadNostrLinks(content: string) {
    const links = parseNostrLinks(content);
    if (links.length === 0) return;

    const eventIds: string[] = [];
    const aTags: string[] = [];
    const npubs: string[] = [];

    for (const link of links) {
      try {
        if (link.type === 'nevent' || link.type === 'note1') {
          const decoded = nip19.decode(link.value.replace('nostr:', ''));
          if (decoded.type === 'nevent') {
            eventIds.push(decoded.data.id);
          } else if (decoded.type === 'note') {
            eventIds.push(decoded.data as string);
          }
        } else if (link.type === 'naddr') {
          const decoded = nip19.decode(link.value.replace('nostr:', ''));
          if (decoded.type === 'naddr') {
            const aTag = `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`;
            aTags.push(aTag);
          }
        } else if (link.type === 'npub' || link.type === 'profile') {
          const decoded = nip19.decode(link.value.replace('nostr:', ''));
          if (decoded.type === 'npub') {
            npubs.push(link.value);
            nostrLinkProfiles.set(link.value, decoded.data as string);
          }
        }
      } catch {
        // Invalid nostr link, skip
      }
    }

    // Fetch events
    if (eventIds.length > 0) {
      try {
        const events = await Promise.race([
          nostrClient.fetchEvents([{ ids: eventIds, limit: eventIds.length }]),
          new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
        ]);
        
        for (const event of events) {
          nostrLinkEvents.set(event.id, event);
        }
      } catch {
        // Ignore fetch errors
      }
    }

    // Fetch a-tag events
    if (aTags.length > 0) {
      for (const aTag of aTags) {
        const parts = aTag.split(':');
        if (parts.length === 3) {
          try {
            const kind = parseInt(parts[0]);
            const pubkey = parts[1];
            const dTag = parts[2];
            const events = await Promise.race([
              nostrClient.fetchEvents([{ kinds: [kind], authors: [pubkey], '#d': [dTag], limit: 1 }]),
              new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
            ]);
            
            if (events.length > 0) {
              nostrLinkEvents.set(events[0].id, events[0]);
            }
          } catch {
            // Ignore fetch errors
          }
        }
      }
    }
  }

  // Get event from nostr: link
  function getEventFromNostrLink(link: string): NostrEvent | undefined {
    try {
      if (link.startsWith('nostr:nevent1') || link.startsWith('nostr:note1')) {
        const decoded = nip19.decode(link.replace('nostr:', ''));
        if (decoded.type === 'nevent') {
          return nostrLinkEvents.get(decoded.data.id);
        } else if (decoded.type === 'note') {
          return nostrLinkEvents.get(decoded.data as string);
        }
      } else if (link.startsWith('nostr:naddr1')) {
        const decoded = nip19.decode(link.replace('nostr:', ''));
        if (decoded.type === 'naddr') {
          const eventId = `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`;
          return Array.from(nostrLinkEvents.values()).find(e => {
            const dTag = e.tags.find(t => t[0] === 'd')?.[1];
            return e.kind === decoded.data.kind && 
                   e.pubkey === decoded.data.pubkey && 
                   dTag === decoded.data.identifier;
          });
        }
      }
    } catch {
      // Invalid link
    }
    return undefined;
  }

  // Get pubkey from nostr: npub/profile link
  function getPubkeyFromNostrLink(link: string): string | undefined {
    return nostrLinkProfiles.get(link);
  }

  // Process content with nostr links into parts for rendering
  function processContentWithNostrLinks(content: string): Array<{ type: 'text' | 'event' | 'profile' | 'placeholder'; value: string; event?: NostrEvent; pubkey?: string }> {
    const links = parseNostrLinks(content);
    if (links.length === 0) {
      return [{ type: 'text', value: content }];
    }

    const parts: Array<{ type: 'text' | 'event' | 'profile' | 'placeholder'; value: string; event?: NostrEvent; pubkey?: string }> = [];
    let lastIndex = 0;

    for (const link of links) {
      // Add text before link
      if (link.start > lastIndex) {
        const textPart = content.slice(lastIndex, link.start);
        if (textPart) {
          parts.push({ type: 'text', value: textPart });
        }
      }

      // Add link
      const event = getEventFromNostrLink(link.value);
      const pubkey = getPubkeyFromNostrLink(link.value);
      if (event) {
        parts.push({ type: 'event', value: link.value, event });
      } else if (pubkey) {
        parts.push({ type: 'profile', value: link.value, pubkey });
      } else {
        parts.push({ type: 'placeholder', value: link.value });
      }

      lastIndex = link.end;
    }

    // Add remaining text
    if (lastIndex < content.length) {
      const textPart = content.slice(lastIndex);
      if (textPart) {
        parts.push({ type: 'text', value: textPart });
      }
    }

    return parts;
  }

  // Load full events for discussions and comments to get tags for blurbs
  async function loadDiscussionEvents(discussionsList: typeof discussions) {
    const eventIds = new Set<string>();
    
    // Collect all event IDs
    for (const discussion of discussionsList) {
      if (discussion.id) {
        eventIds.add(discussion.id);
      }
      if (discussion.comments) {
        for (const comment of discussion.comments) {
          if (comment.id) {
            eventIds.add(comment.id);
          }
          if (comment.replies) {
            for (const reply of comment.replies) {
              if (reply.id) {
                eventIds.add(reply.id);
              }
              if (reply.replies) {
                for (const nestedReply of reply.replies) {
                  if (nestedReply.id) {
                    eventIds.add(nestedReply.id);
                  }
                }
              }
            }
          }
        }
      }
    }

    if (eventIds.size === 0) return;

    try {
      const events = await Promise.race([
        nostrClient.fetchEvents([{ ids: Array.from(eventIds), limit: eventIds.size }]),
        new Promise<NostrEvent[]>((resolve) => setTimeout(() => resolve([]), 10000))
      ]);
      
      for (const event of events) {
        discussionEvents.set(event.id, event);
      }
    } catch {
      // Ignore fetch errors
    }
  }

  // Get discussion event by ID
  function getDiscussionEvent(eventId: string): NostrEvent | undefined {
    return discussionEvents.get(eventId);
  }

  // Get referenced event from discussion event (e-tag, a-tag, q-tag)
  function getReferencedEventFromDiscussion(event: NostrEvent): NostrEvent | undefined {
    // Check e-tag
    const eTag = event.tags.find(t => t[0] === 'e' && t[1])?.[1];
    if (eTag) {
      const referenced = discussionEvents.get(eTag);
      if (referenced) return referenced;
    }
    
    // Check a-tag
    const aTag = event.tags.find(t => t[0] === 'a' && t[1])?.[1];
    if (aTag) {
      const parts = aTag.split(':');
      if (parts.length === 3) {
        const kind = parseInt(parts[0]);
        const pubkey = parts[1];
        const dTag = parts[2];
        return Array.from(discussionEvents.values()).find(e => 
          e.kind === kind && 
          e.pubkey === pubkey && 
          e.tags.find(t => t[0] === 'd' && t[1] === dTag)
        );
      }
    }
    
    // Check q-tag
    const qTag = event.tags.find(t => t[0] === 'q' && t[1])?.[1];
    if (qTag) {
      return discussionEvents.get(qTag);
    }
    
    return undefined;
  }

  // Format time for discussions
  function formatDiscussionTime(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  }

  // Create a nostrClient instance for fetching events
  let nostrClient = new NostrClient(DEFAULT_NOSTR_RELAYS);

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

  // Repository owner pubkey (decoded from npub)
  let repoOwnerPubkey = $state<string | null>(null);

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

      // Fetch full events for discussions and comments to get tags for blurbs
      await loadDiscussionEvents(discussions);
      
      // Fetch nostr: links from discussion content
      for (const discussion of discussions) {
        if (discussion.content) {
          await loadNostrLinks(discussion.content);
        }
        if (discussion.comments) {
          for (const comment of discussion.comments) {
            if (comment.content) {
              await loadNostrLinks(comment.content);
            }
            if (comment.replies) {
              for (const reply of comment.replies) {
                if (reply.content) {
                  await loadNostrLinks(reply.content);
                }
                if (reply.replies) {
                  for (const nestedReply of reply.replies) {
                    if (nestedReply.content) {
                      await loadNostrLinks(nestedReply.content);
                    }
                  }
                }
              }
            }
          }
        }
      }
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
      nostrClient = client; // Store for use in other functions
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
        repoOwnerPubkey = decoded.data as string;
        repoAddress = `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${repo}`;
      }
    } catch (err) {
      console.warn('Failed to decode npub for bookmark address:', err);
    }

    // Close menu when clicking outside (handled by RepoHeaderEnhanced component)
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (showRepoMenu && !target.closest('.repo-header')) {
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
    await loadAllMaintainers();
    
    // Check clone status (needed to disable write operations)
    await checkCloneStatus();
    await checkVerification();
    await loadReadme();
    await loadForkInfo();
    await loadRepoImages();
    
    // Set up auto-save if enabled
    setupAutoSave().catch(err => console.warn('Failed to setup auto-save:', err));
  });
  
  // Cleanup on destroy
  onDestroy(() => {
    if (autoSaveInterval) {
      clearInterval(autoSaveInterval);
      autoSaveInterval = null;
    }
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

  async function loadAllMaintainers() {
    if (repoNotFound || loadingMaintainers) return;
    
    loadingMaintainers = true;
    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/maintainers`);
      if (response.ok) {
        const data = await response.json();
        const owner = data.owner;
        const maintainers = data.maintainers || [];
        
        // Create array with all maintainers, marking the owner
        const allMaintainersList: Array<{ pubkey: string; isOwner: boolean }> = [];
        const seen = new Set<string>();
        const ownerLower = owner?.toLowerCase();
        
        // Process all maintainers, marking owner and deduplicating
        for (const maintainer of maintainers) {
          const maintainerLower = maintainer.toLowerCase();
          
          // Skip if we've already added this pubkey (case-insensitive check)
          if (seen.has(maintainerLower)) {
            continue;
          }
          
          // Mark as seen
          seen.add(maintainerLower);
          
          // Determine if this is the owner
          const isOwner = ownerLower && maintainerLower === ownerLower;
          
          // Add to list
          allMaintainersList.push({ 
            pubkey: maintainer, 
            isOwner: !!isOwner
          });
        }
        
        // Sort: owner first, then other maintainers
        allMaintainersList.sort((a, b) => {
          if (a.isOwner && !b.isOwner) return -1;
          if (!a.isOwner && b.isOwner) return 1;
          return 0;
        });
        
        // Ensure owner is always included (in case they weren't in maintainers list)
        if (owner && !seen.has(ownerLower)) {
          allMaintainersList.unshift({ pubkey: owner, isOwner: true });
        }
        
        allMaintainers = allMaintainersList;
      }
    } catch (err) {
      console.error('Failed to load maintainers:', err);
      maintainersLoaded = false; // Reset flag on error
      // Fallback to pageData if available
      if (pageData.repoOwnerPubkey) {
        allMaintainers = [{ pubkey: pageData.repoOwnerPubkey, isOwner: true }];
        if (pageData.repoMaintainers) {
          for (const maintainer of pageData.repoMaintainers) {
            if (maintainer.toLowerCase() !== pageData.repoOwnerPubkey.toLowerCase()) {
              allMaintainers.push({ pubkey: maintainer, isOwner: false });
            }
          }
        }
      }
    } finally {
      loadingMaintainers = false;
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

  async function generateAnnouncementFileForRepo() {
    if (!pageData.repoOwnerPubkey || !userPubkeyHex) {
      error = 'Unable to generate announcement file: missing repository or user information';
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
      // Generate announcement event JSON (for download/reference)
      verificationFileContent = JSON.stringify(announcement, null, 2) + '\n';
      showVerificationDialog = true;
    } catch (err) {
      console.error('Failed to generate announcement file:', err);
      error = `Failed to generate announcement file: ${err instanceof Error ? err.message : String(err)}`;
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
    a.download = 'announcement-event.json';
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
    // Check settings store first
    try {
      const settings = await settingsStore.getSettings();
      if (settings.userEmail && settings.userEmail.trim()) {
        cachedUserEmail = settings.userEmail.trim();
        return cachedUserEmail;
      }
    } catch (err) {
      console.warn('Failed to get userEmail from settings:', err);
    }

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
    let prefillEmail: string;
    
    try {
      // Fetch from kind 0 event (cache or relays)
      prefillEmail = await fetchUserEmail(userPubkeyHex, userPubkey || undefined, DEFAULT_NOSTR_RELAYS);
    } catch (err) {
      console.warn('Failed to fetch user profile for email:', err);
      // Fallback to shortenednpub@gitrepublic.web
      const npubFromPubkey = userPubkeyHex ? nip19.npubEncode(userPubkeyHex) : (userPubkey || 'unknown');
      const shortenedNpub = npubFromPubkey.substring(0, 20);
      prefillEmail = `${shortenedNpub}@gitrepublic.web`;
    } finally {
      fetchingUserEmail = false;
    }
    
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
        // Save to settings store
        settingsStore.setSetting('userEmail', cachedUserEmail).catch(console.error);
        return cachedUserEmail;
      } else {
        alert('Invalid email format. Using fallback email address.');
      }
    }

    // Use fallback if user cancelled or entered invalid email
    cachedUserEmail = prefillEmail;
    return cachedUserEmail;
  }

  async function getUserName(): Promise<string> {
    // Check settings store first
    try {
      const settings = await settingsStore.getSettings();
      if (settings.userName && settings.userName.trim()) {
        cachedUserName = settings.userName.trim();
        return cachedUserName;
      }
    } catch (err) {
      console.warn('Failed to get userName from settings:', err);
    }

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
    let prefillName: string;
    
    try {
      // Fetch from kind 0 event (cache or relays)
      prefillName = await fetchUserName(userPubkeyHex, userPubkey || undefined, DEFAULT_NOSTR_RELAYS);
    } catch (err) {
      console.warn('Failed to fetch user profile for name:', err);
      // Fallback to shortened npub (20 chars)
      const npubFromPubkey = userPubkeyHex ? nip19.npubEncode(userPubkeyHex) : (userPubkey || 'unknown');
      prefillName = npubFromPubkey.substring(0, 20);
    } finally {
      fetchingUserName = false;
    }
    
    // Prompt user for name
    const userName = prompt(
      'Please enter your name for git commits.\n\n' +
      'This will be used as the author name in your commits.\n' +
      'You can use any name you prefer.',
      prefillName
    );

    if (userName && userName.trim()) {
      cachedUserName = userName.trim();
      // Save to settings store
      settingsStore.setSetting('userName', cachedUserName).catch(console.error);
      return cachedUserName;
    }

    // Use fallback if user cancelled
    cachedUserName = prefillName;
    return cachedUserName;
  }

  async function setupAutoSave() {
    // Clear existing interval if any
    if (autoSaveInterval) {
      clearInterval(autoSaveInterval);
      autoSaveInterval = null;
    }
    
    // Check if auto-save is enabled
    try {
      const settings = await settingsStore.getSettings();
      if (!settings.autoSave) {
        return; // Auto-save disabled
      }
    } catch (err) {
      console.warn('Failed to check auto-save setting:', err);
      return;
    }
    
    // Set up interval to auto-save every 10 minutes
    autoSaveInterval = setInterval(async () => {
      await autoSaveFile();
    }, 10 * 60 * 1000); // 10 minutes
  }
  
  async function autoSaveFile() {
    // Only auto-save if:
    // 1. There are changes
    // 2. A file is open
    // 3. User is logged in
    // 4. User is a maintainer
    // 5. Not currently saving
    // 6. Not in clone state
    if (!hasChanges || !currentFile || !userPubkey || !isMaintainer || saving || needsClone) {
      return;
    }
    
    // Check auto-save setting again (in case it changed)
    try {
      const settings = await settingsStore.getSettings();
      if (!settings.autoSave) {
        // Auto-save was disabled, clear interval
        if (autoSaveInterval) {
          clearInterval(autoSaveInterval);
          autoSaveInterval = null;
        }
        return;
      }
    } catch (err) {
      console.warn('Failed to check auto-save setting:', err);
      return;
    }
    
    // Generate a default commit message
    const autoCommitMessage = `Auto-save: ${new Date().toLocaleString()}`;
    
    try {
      // Get user email and name from settings
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
              ['message', autoCommitMessage]
            ],
            content: `Signed commit: ${autoCommitMessage}`
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
          commitMessage: autoCommitMessage,
          authorName: authorName,
          authorEmail: authorEmail,
          branch: currentBranch,
          userPubkey: userPubkey,
          commitSignatureEvent: commitSignatureEvent
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: response.statusText }));
        console.warn('Auto-save failed:', errorData.message || 'Failed to save file');
        return;
      }

      // Reload file to get updated content
      await loadFile(currentFile);
      // Note: We don't show an alert for auto-save, it's silent
      console.log('Auto-saved file:', currentFile);
    } catch (err) {
      console.warn('Error during auto-save:', err);
      // Don't show error to user, it's silent
    }
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

  function handleBranchChangeDirect(branch: string) {
    currentBranch = branch;
    // Create a synthetic event for the existing handler
    const syntheticEvent = {
      target: { value: branch }
    } as unknown as Event;
    handleBranchChange(syntheticEvent);
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
      // If no branches exist, use default branch from settings
      let fromBranch = newBranchFrom || currentBranch;
      if (!fromBranch && branches.length === 0) {
        const settings = await settingsStore.getSettings();
        fromBranch = settings.defaultBranch || 'master';
      }

      const response = await fetch(`/api/repos/${npub}/${repo}/branches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          branchName: newBranchName,
          fromBranch: fromBranch || 'master' // Final fallback
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

  async function updateIssueStatus(issueId: string, issueAuthor: string, status: 'open' | 'closed' | 'resolved' | 'draft') {
    if (!userPubkeyHex) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    // Check if user is maintainer or issue author
    const isAuthor = userPubkeyHex === issueAuthor;
    if (!isMaintainer && !isAuthor) {
      alert('Only repository maintainers or issue authors can update issue status');
      return;
    }

    updatingIssueStatus = { ...updatingIssueStatus, [issueId]: true };
    error = null;

    try {
      const response = await fetch(`/api/repos/${npub}/${repo}/issues`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          issueId,
          issueAuthor,
          status
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update issue status');
      }

      await loadIssues();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to update issue status';
      console.error('Error updating issue status:', err);
    } finally {
      updatingIssueStatus = { ...updatingIssueStatus, [issueId]: false };
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

  async function createPatch() {
    if (!newPatchContent.trim()) {
      alert('Please enter patch content');
      return;
    }

    if (!userPubkey || !userPubkeyHex) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    creatingPatch = true;
    error = null;

    try {
      const decoded = nip19.decode(npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;
      const repoAddress = `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${repo}`;

      // Get user's relays and combine with defaults
      const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const { outbox } = await getUserRelays(userPubkey, tempClient);
      const combinedRelays = combineRelays(outbox);

      // Create patch event (kind 1617)
      const patchEventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.PATCH,
        pubkey: userPubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['a', repoAddress],
          ['p', repoOwnerPubkey],
          ['t', 'root']
        ],
        content: newPatchContent.trim()
      };

      // Add subject if provided
      if (newPatchSubject.trim()) {
        patchEventTemplate.tags.push(['subject', newPatchSubject.trim()]);
      }

      // Sign the event using NIP-07
      const signedEvent = await signEventWithNIP07(patchEventTemplate);

      // Publish to all available relays
      const publishClient = new NostrClient(combinedRelays);
      const result = await publishClient.publishEvent(signedEvent, combinedRelays);

      if (result.failed.length > 0 && result.success.length === 0) {
        throw new Error('Failed to publish patch to all relays');
      }

      showCreatePatchDialog = false;
      newPatchContent = '';
      newPatchSubject = '';
      alert('Patch created successfully!');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to create patch';
      console.error('Error creating patch:', err);
    } finally {
      creatingPatch = false;
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
  <!-- Banner hidden on mobile, shown on desktop -->
  {#if repoBanner}
    <div class="repo-banner desktop-only">
      <img src={repoBanner} alt="" onerror={(e) => { 
        console.error('[Repo Images] Failed to load banner:', repoBanner); 
        const target = e.target as HTMLImageElement;
        if (target) target.style.display = 'none';
      }} />
    </div>
  {/if}
  
  {#if repoOwnerPubkey}
    <RepoHeaderEnhanced
      repoName={pageData.repoName || repo}
      repoDescription={pageData.repoDescription}
      ownerNpub={npub}
      ownerPubkey={repoOwnerPubkey}
      isMaintainer={isMaintainer}
      isPrivate={pageData.repoIsPrivate || false}
      cloneUrls={pageData.repoCloneUrls || []}
      branches={branches}
      currentBranch={currentBranch}
      defaultBranch={defaultBranch}
      isRepoCloned={isRepoCloned}
      copyingCloneUrl={copyingCloneUrl}
      onBranchChange={handleBranchChangeDirect}
      onCopyCloneUrl={copyCloneUrl}
      onDeleteBranch={deleteBranch}
      onMenuToggle={() => showRepoMenu = !showRepoMenu}
      showMenu={showRepoMenu}
      userPubkey={userPubkey}
      isBookmarked={isBookmarked}
      loadingBookmark={loadingBookmark}
      onToggleBookmark={toggleBookmark}
      onFork={forkRepository}
      forking={forking}
      onCloneToServer={cloneRepository}
      cloning={cloning}
      checkingCloneStatus={checkingCloneStatus}
      onCreateIssue={() => showCreateIssueDialog = true}
      onCreatePR={() => showCreatePRDialog = true}
      onCreatePatch={() => showCreatePatchDialog = true}
      onCreateBranch={async () => {
        if (!userPubkey || !isMaintainer || needsClone) return;
        try {
          const settings = await settingsStore.getSettings();
          defaultBranchName = settings.defaultBranch || 'master';
        } catch {
          defaultBranchName = 'master';
        }
        showCreateBranchDialog = true;
      }}
      onSettings={() => goto(`/signup?npub=${npub}&repo=${repo}`)}
      onGenerateVerification={pageData.repoOwnerPubkey && userPubkeyHex === pageData.repoOwnerPubkey && verificationStatus?.verified !== true ? generateAnnouncementFileForRepo : undefined}
      onDeleteAnnouncement={pageData.repoOwnerPubkey && userPubkeyHex === pageData.repoOwnerPubkey ? deleteAnnouncement : undefined}
      deletingAnnouncement={deletingAnnouncement}
      hasUnlimitedAccess={hasUnlimitedAccess($userStore.userLevel)}
      needsClone={needsClone}
      allMaintainers={allMaintainers}
    />
  {/if}

  <!-- Additional repo metadata (website, clone URLs with verification) -->

  {#if pageData.repoWebsite || (pageData.repoCloneUrls && pageData.repoCloneUrls.length > 0) || pageData.repoLanguage || (pageData.repoTopics && pageData.repoTopics.length > 0) || forkInfo?.isFork}
    <div class="repo-metadata-section">
      {#if pageData.repoWebsite}
        <div class="repo-website">
          <a href={pageData.repoWebsite} target="_blank" rel="noopener noreferrer">
            <img src="/icons/external-link.svg" alt="" class="icon-inline" />
            {pageData.repoWebsite}
          </a>
        </div>
      {/if}
      {#if pageData.repoLanguage}
        <span class="repo-language">
          <img src="/icons/file-text.svg" alt="" class="icon-inline" />
          {pageData.repoLanguage}
        </span>
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
      {#if pageData.repoCloneUrls && pageData.repoCloneUrls.length > 0}
        <div class="repo-clone-urls">
          <span class="clone-label">Clone URLs:</span>
          {#each pageData.repoCloneUrls.slice(0, 3) as cloneUrl}
            {@const cloneVerification = verificationStatus?.cloneVerifications?.find(cv => {
              const normalizeUrl = (url: string) => url.replace(/\/$/, '').toLowerCase().replace(/^https?:\/\//, '');
              const normalizedCv = normalizeUrl(cv.url);
              const normalizedClone = normalizeUrl(cloneUrl);
              return normalizedCv === normalizedClone || 
                     normalizedCv.includes(normalizedClone) || 
                     normalizedClone.includes(normalizedCv);
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
                <span class="verification-badge unverified" title="Verification status unknown">
                  <img src="/icons/alert-triangle.svg" alt="Unknown" class="icon-inline" />
                </span>
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
    </div>
  {/if}

  <main class="repo-view">
    {#if error}
      <div class="error">
        Error: {error}
      </div>
    {/if}

    <!-- Tabs -->
    <RepoTabs
      activeTab={activeTab}
      tabs={[
        { id: 'discussions', label: 'Discussions', icon: '/icons/message-circle.svg' },
        { id: 'files', label: 'Files', icon: '/icons/file-text.svg' },
        { id: 'history', label: 'History', icon: '/icons/git-commit.svg' },
        { id: 'tags', label: 'Tags', icon: '/icons/tag.svg' },
        { id: 'issues', label: 'Issues', icon: '/icons/alert-circle.svg', count: issues.length },
        { id: 'prs', label: 'Pull Requests', icon: '/icons/git-pull-request.svg', count: prs.length },
        { id: 'docs', label: 'Docs', icon: '/icons/book.svg' }
      ]}
      onTabChange={(tab) => activeTab = tab as typeof activeTab}
    />

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
                {#if userPubkeyHex && (isMaintainer || userPubkeyHex === issue.author)}
                  <div class="issue-actions">
                    {#if issue.status === 'open'}
                      <button onclick={() => updateIssueStatus(issue.id, issue.author, 'closed')} disabled={updatingIssueStatus[issue.id]} class="issue-action-btn close-btn">
                        {updatingIssueStatus[issue.id] ? 'Closing...' : 'Close'}
                      </button>
                      <button onclick={() => updateIssueStatus(issue.id, issue.author, 'resolved')} disabled={updatingIssueStatus[issue.id]} class="issue-action-btn resolve-btn">
                        {updatingIssueStatus[issue.id] ? 'Resolving...' : 'Resolve'}
                      </button>
                    {:else if issue.status === 'closed' || issue.status === 'resolved'}
                      <button onclick={() => updateIssueStatus(issue.id, issue.author, 'open')} disabled={updatingIssueStatus[issue.id]} class="issue-action-btn reopen-btn">
                        {updatingIssueStatus[issue.id] ? 'Reopening...' : 'Reopen'}
                      </button>
                    {/if}
                  </div>
                {/if}
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
                    isMaintainer={isMaintainer}
                    userPubkeyHex={userPubkeyHex ?? undefined}
                    onStatusUpdate={loadPRs}
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
                  class="btn btn-secondary icon-button"
                  onclick={() => loadDiscussions()}
                  disabled={loadingDiscussions}
                  title={loadingDiscussions ? 'Refreshing...' : 'Refresh discussions'}
                  aria-label={loadingDiscussions ? 'Refreshing...' : 'Refresh discussions'}
                >
                  <img src="/icons/refresh-cw.svg" alt="" class="icon" />
                </button>
                {#if userPubkey}
                  <button 
                    class="btn btn-primary icon-button"
                    onclick={() => showCreateThreadDialog = true}
                    disabled={creatingThread}
                    title={creatingThread ? 'Creating...' : 'New Discussion Thread'}
                    aria-label={creatingThread ? 'Creating...' : 'New Discussion Thread'}
                  >
                    <img src="/icons/message-circle.svg" alt="" class="icon" />
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
                          {#if true}
                            {@const commentEvent = getDiscussionEvent(comment.id)}
                            {@const referencedEvent = commentEvent ? getReferencedEventFromDiscussion(commentEvent) : undefined}
                            {@const parts = processContentWithNostrLinks(comment.content)}
                            <div class="comment-content">
                              {#if referencedEvent}
                                <div class="referenced-event">
                                  <div class="referenced-event-header">
                                    <UserBadge pubkey={referencedEvent.pubkey} disableLink={true} />
                                    <span class="referenced-event-time">{formatDiscussionTime(referencedEvent.created_at)}</span>
                                  </div>
                                  <div class="referenced-event-content">{referencedEvent.content || '(No content)'}</div>
                                </div>
                              {/if}
                              <div>
                                {#each parts as part}
                                  {#if part.type === 'text'}
                                    <span>{part.value}</span>
                                  {:else if part.type === 'event' && part.event}
                                    <div class="nostr-link-event">
                                      <div class="nostr-link-event-header">
                                        <UserBadge pubkey={part.event.pubkey} disableLink={true} />
                                        <span class="nostr-link-event-time">{formatDiscussionTime(part.event.created_at)}</span>
                                      </div>
                                      <div class="nostr-link-event-content">{part.event.content || '(No content)'}</div>
                                    </div>
                                  {:else if part.type === 'profile' && part.pubkey}
                                    <UserBadge pubkey={part.pubkey} />
                                  {:else}
                                    <span class="nostr-link-placeholder">{part.value}</span>
                                  {/if}
                                {/each}
                              </div>
                            </div>
                          {/if}
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
                          {#if true}
                            {@const commentEvent = getDiscussionEvent(comment.id)}
                            {@const referencedEvent = commentEvent ? getReferencedEventFromDiscussion(commentEvent) : undefined}
                            {@const parts = processContentWithNostrLinks(comment.content)}
                            <div class="comment-content">
                              {#if referencedEvent}
                                <div class="referenced-event">
                                  <div class="referenced-event-header">
                                    <UserBadge pubkey={referencedEvent.pubkey} disableLink={true} />
                                    <span class="referenced-event-time">{formatDiscussionTime(referencedEvent.created_at)}</span>
                                  </div>
                                  <div class="referenced-event-content">{referencedEvent.content || '(No content)'}</div>
                                </div>
                              {/if}
                              <div>
                                {#each parts as part}
                                  {#if part.type === 'text'}
                                    <span>{part.value}</span>
                                  {:else if part.type === 'event' && part.event}
                                    <div class="nostr-link-event">
                                      <div class="nostr-link-event-header">
                                        <UserBadge pubkey={part.event.pubkey} disableLink={true} />
                                        <span class="nostr-link-event-time">{formatDiscussionTime(part.event.created_at)}</span>
                                      </div>
                                      <div class="nostr-link-event-content">{part.event.content || '(No content)'}</div>
                                    </div>
                                  {:else if part.type === 'profile' && part.pubkey}
                                    <UserBadge pubkey={part.pubkey} />
                                  {:else}
                                    <span class="nostr-link-placeholder">{part.value}</span>
                                  {/if}
                                {/each}
                              </div>
                            </div>
                          {/if}
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
            {#if branches.length === 0}
              <option value={null}>No branches - will create initial branch ({defaultBranchName})</option>
            {:else}
              {#each branches as branch}
                {@const branchName = typeof branch === 'string' ? branch : (branch as { name: string }).name}
                <option value={branchName}>{branchName}</option>
              {/each}
            {/if}
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

  <!-- Create Patch Dialog -->
  {#if showCreatePatchDialog && userPubkey}
    <div 
      class="modal-overlay" 
      role="dialog"
      aria-modal="true"
      aria-label="Create new patch"
      onclick={() => showCreatePatchDialog = false}
      onkeydown={(e) => e.key === 'Escape' && (showCreatePatchDialog = false)}
      tabindex="-1"
    >
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
      <div 
        class="modal" 
        role="document"
        onclick={(e) => e.stopPropagation()}
      >
        <h3>Create New Patch</h3>
        <p class="help-text">Enter your patch content in git format-patch format. Patches should be under 60KB.</p>
        <label>
          Subject (optional):
          <input type="text" bind:value={newPatchSubject} placeholder="Patch title..." />
        </label>
        <label>
          Patch Content:
          <textarea bind:value={newPatchContent} rows="15" placeholder="Paste your git format-patch output here..."></textarea>
        </label>
        <div class="modal-actions">
          <button onclick={() => showCreatePatchDialog = false} class="cancel-button">Cancel</button>
          <button onclick={createPatch} disabled={!newPatchContent.trim() || creatingPatch} class="save-button">
            {creatingPatch ? 'Creating...' : 'Create Patch'}
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
            The announcement event should be saved to <code>nostr/repo-events.jsonl</code> in your repository.
            You can download the announcement event JSON below for reference.
          </p>
          <div class="verification-file-content">
            <div class="file-header">
              <span class="filename">announcement-event.json</span>
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
