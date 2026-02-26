<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import CodeEditor from '$lib/components/CodeEditor.svelte';
  import PRDetail from '$lib/components/PRDetail.svelte';
  import UserBadge from '$lib/components/UserBadge.svelte';
  import EventCopyButton from '$lib/components/EventCopyButton.svelte';
  import RepoHeaderEnhanced from '$lib/components/RepoHeaderEnhanced.svelte';
  import TabsMenu from '$lib/components/TabsMenu.svelte';
  import NostrLinkRenderer from '$lib/components/NostrLinkRenderer.svelte';
  import TagsTab from './components/TagsTab.svelte';
  import FilesTab from './components/FilesTab.svelte';
  import HistoryTab from './components/HistoryTab.svelte';
  import IssuesTab from './components/IssuesTab.svelte';
  import PRsTab from './components/PRsTab.svelte';
  import PatchesTab from './components/PatchesTab.svelte';
  import DocsTab from './components/DocsTab.svelte';
  import DiscussionsTab from './components/DiscussionsTab.svelte';
  import CreateFileDialog from './components/dialogs/CreateFileDialog.svelte';
  import CreateBranchDialog from './components/dialogs/CreateBranchDialog.svelte';
  import CreateTagDialog from './components/dialogs/CreateTagDialog.svelte';
  import CreateReleaseDialog from './components/dialogs/CreateReleaseDialog.svelte';
  import CreateIssueDialog from './components/dialogs/CreateIssueDialog.svelte';
  import CreateThreadDialog from './components/dialogs/CreateThreadDialog.svelte';
  import ReplyDialog from './components/dialogs/ReplyDialog.svelte';
  import CreatePRDialog from './components/dialogs/CreatePRDialog.svelte';
  import CreatePatchDialog from './components/dialogs/CreatePatchDialog.svelte';
  import PatchHighlightDialog from './components/dialogs/PatchHighlightDialog.svelte';
  import PatchCommentDialog from './components/dialogs/PatchCommentDialog.svelte';
  import CommitDialog from './components/dialogs/CommitDialog.svelte';
  import VerificationDialog from './components/dialogs/VerificationDialog.svelte';
  import CloneUrlVerificationDialog from './components/dialogs/CloneUrlVerificationDialog.svelte';
  import { downloadRepository as downloadRepoUtil } from './utils/download.js';
  import { buildApiHeaders } from './utils/api-client.js';
  import '$lib/styles/repo.css';
  import { getPublicKeyWithNIP07, isNIP07Available, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
  import { NostrClient } from '$lib/services/nostr/nostr-client.js';
  import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS, combineRelays } from '$lib/config.js';
  import { getUserRelays } from '$lib/services/nostr/user-relays.js';
  import { BookmarksService } from '$lib/services/nostr/bookmarks-service.js';
  import { HighlightsService } from '$lib/services/nostr/highlights-service.js';
  import { KIND } from '$lib/types/nostr.js';
  import { nip19 } from 'nostr-tools';
  import { userStore } from '$lib/stores/user-store.js';
  import { settingsStore } from '$lib/services/settings-store.js';
  // Note: Announcements are now stored in nostr/repo-events.jsonl, not .nostr-announcement
  import type { NostrEvent } from '$lib/types/nostr.js';
  import { hasUnlimitedAccess } from '$lib/utils/user-access.js';
  import { createRepoState, type RepoState } from './stores/repo-state.js';
  import {
    usePageDataEffect,
    usePageParamsEffect,
    useMaintainersEffect,
    useAutoSaveEffect,
    useUserStoreEffect,
    useTabSwitchEffect,
    useRepoImagesEffect,
    usePatchHighlightsEffect,
    useTabChangeEffect,
    useBranchChangeEffect
  } from './hooks/use-repo-effects.js';
  import {
    getHighlightLanguage,
    supportsPreview,
    isImageFileType,
    renderCsvAsTable,
    escapeHtml,
    applySyntaxHighlighting as applySyntaxHighlightingUtil,
    renderFileAsHtml as renderFileAsHtmlUtil
  } from './utils/file-processing.js';
  import {
    parseNostrLinks
  } from './utils/nostr-links.js';
  // formatDiscussionTime is defined locally (slightly different format than utility version)
  import {
    getUserEmail as getUserEmailUtil,
    getUserName as getUserNameUtil
  } from './utils/user-profile.js';
  import {
    saveFile as saveFileService,
    createFile as createFileService,
    deleteFile as deleteFileService,
    loadFiles as loadFilesService,
    loadFile as loadFileService,
    setupAutoSave as setupAutoSaveService,
    autoSaveFile as autoSaveFileService
  } from './services/file-operations.js';
  import {
    findReadmeFile as findReadmeFileUtil,
    formatPubkey as formatPubkeyUtil,
    getMimeType as getMimeTypeUtil
  } from './utils/file-helpers.js';
  import {
    handleContentChange as handleContentChangeUtil,
    handleFileClick as handleFileClickUtil,
    copyFileContent as copyFileContentUtil,
    downloadFile as downloadFileUtil,
    handleBack as handleBackUtil,
    toggleWordWrap as toggleWordWrapUtil
  } from './utils/file-handlers.js';
  import {
    copyCloneUrl as copyCloneUrlUtil
  } from './utils/repo-handlers.js';
  import {
    countAllReplies as countAllRepliesUtil,
    toggleThread as toggleThreadUtil
  } from './utils/discussion-utils.js';
  import {
    checkAuth as checkAuthService,
    login as loginService
  } from './services/auth-operations.js';
  import {
    handlePatchCodeSelection as handlePatchCodeSelectionUtil,
    startPatchComment as startPatchCommentUtil
  } from './services/patch-handlers.js';
  import {
    createBranch as createBranchService,
    deleteBranch as deleteBranchService,
    loadBranches as loadBranchesService,
    handleBranchChange as handleBranchChangeService
  } from './services/branch-operations.js';
  import {
    loadTags as loadTagsService,
    createTag as createTagService
  } from './services/tag-operations.js';
  import {
    loadReleases as loadReleasesService,
    createRelease as createReleaseService
  } from './services/release-operations.js';
  import {
    loadCommitHistory as loadCommitHistoryService,
    verifyCommit as verifyCommitService,
    viewDiff as viewDiffService
  } from './services/commit-operations.js';
  import {
    loadIssues as loadIssuesService,
    loadIssueReplies as loadIssueRepliesService,
    createIssue as createIssueService,
    updateIssueStatus as updateIssueStatusService
  } from './services/issue-operations.js';
  import {
    loadPRs as loadPRsService,
    createPR as createPRService
  } from './services/pr-operations.js';
  import {
    loadPatches as loadPatchesService,
    createPatch as createPatchService,
    updatePatchStatus as updatePatchStatusService,
    loadPatchHighlights as loadPatchHighlightsService,
    createPatchHighlight as createPatchHighlightService,
    createPatchComment as createPatchCommentService
  } from './services/patch-operations.js';
  import {
    performCodeSearch as performCodeSearchService
  } from './services/code-search-operations.js';
  import {
    loadDiscussions as loadDiscussionsService,
    createDiscussionThread as createDiscussionThreadService,
    createThreadReply as createThreadReplyService,
    loadDocumentation as loadDocumentationService
  } from './services/discussion-operations.js';
  import {
    checkCloneStatus as checkCloneStatusService,
    cloneRepository as cloneRepositoryService,
    forkRepository as forkRepositoryService,
    toggleBookmark as toggleBookmarkService,
    checkMaintainerStatus as checkMaintainerStatusService,
    loadAllMaintainers as loadAllMaintainersService,
    checkVerification as checkVerificationService,
    loadBookmarkStatus as loadBookmarkStatusService,
    loadCloneUrlReachability as loadCloneUrlReachabilityService,
    loadForkInfo as loadForkInfoService,
    loadRepoImages as loadRepoImagesService,
    generateAnnouncementFileForRepo as generateAnnouncementFileForRepoService,
    copyVerificationToClipboard as copyVerificationToClipboardService,
    downloadVerificationFile as downloadVerificationFileService,
    verifyCloneUrl as verifyCloneUrlService,
    deleteAnnouncement as deleteAnnouncementService,
    copyEventId as copyEventIdService
  } from './services/repo-operations.js';
  import {
    loadReadme as loadReadmeService
  } from './services/file-operations.js';

  // Consolidated state - all state variables in one object
  let state = $state(createRepoState());
  
  // Local variables for component-specific state
  let announcementEventId = { value: null as string | null };
  let applying: Record<string, boolean> = {};
  
  // Extract fields from announcement for convenience
  const repoAnnouncement = $derived(state.pageData.announcement);
  const repoName = $derived(repoAnnouncement?.tags.find((t: string[]) => t[0] === 'name')?.[1] || state.repo);
  const repoDescription = $derived(repoAnnouncement?.tags.find((t: string[]) => t[0] === 'description')?.[1] || '');
  const repoCloneUrls = $derived(repoAnnouncement?.tags
    .filter((t: string[]) => t[0] === 'clone')
    .flatMap((t: string[]) => t.slice(1))
    .filter((url: string) => url && typeof url === 'string') as string[] || []);
  const repoMaintainers = $derived(repoAnnouncement?.tags
    .filter((t: string[]) => t[0] === 'maintainers')
    .flatMap((t: string[]) => t.slice(1))
    .filter((m: string) => m && typeof m === 'string') as string[] || []);
  const repoOwnerPubkeyDerived = $derived(repoAnnouncement?.pubkey || '');
  const repoLanguage = $derived(repoAnnouncement?.tags.find((t: string[]) => t[0] === 'language')?.[1]);
  const repoTopics = $derived(repoAnnouncement?.tags
    .filter((t: string[]) => t[0] === 't' && t[1] !== 'private')
    .map((t: string[]) => t[1])
    .filter((t: string) => t && typeof t === 'string') as string[] || []);
  const repoWebsite = $derived(repoAnnouncement?.tags.find((t: string[]) => t[0] === 'website')?.[1]);
  const repoIsPrivate = $derived(repoAnnouncement?.tags.some((t: string[]) =>
    (t[0] === 'private' && t[1] === 'true') || (t[0] === 't' && t[1] === 'private')
  ) || false);
  
  // Safe page URL for SSR - computed from pageData or current URL
  // Must be completely SSR-safe to prevent "Cannot read properties of null" errors
  const pageUrl = $derived.by(() => {
    try {
      // First try pageData (safest)
      if (state.pageData && typeof state.pageData === 'object' && state.pageData.repoUrl) {
        const url = state.pageData.repoUrl;
        if (typeof url === 'string' && url.trim()) {
          return url;
        }
      }
      
      // During SSR, return empty string immediately
      if (typeof window === 'undefined') {
        return '';
      }
      
      // On client, try to get from current location as fallback
      try {
        if (window && window.location && window.location.protocol && window.location.host && window.location.pathname) {
          return `${window.location.protocol}//${window.location.host}${window.location.pathname}`;
        }
      } catch (err) {
        // Silently ignore errors during SSR or if window.location is unavailable
        console.debug('Could not get page URL from window.location:', err);
      }
      
      return '';
    } catch (err) {
      // Catch any unexpected errors and return empty string
      console.debug('Error computing pageUrl:', err);
      return '';
    }
  });
  
  // Safe Twitter card type - avoid IIFE in head during SSR
  const twitterCardType = $derived.by(() => {
    try {
      const banner = (state.pageData?.banner || state.metadata.banner) || (state.pageData?.image || state.metadata.image);
      if (banner && typeof banner === 'string' && banner.trim()) {
        return "summary_large_image";
      }
      return "summary";
    } catch {
      return "summary";
    }
  });
  
  
  // Helper function to safely update state only if component is still mounted
  function safeStateUpdate<T>(updateFn: () => T): T | null {
    if (!state.isMounted) return null;
    try {
      return updateFn();
    } catch (err) {
      // Silently ignore errors during destruction
      if (state.isMounted) {
        console.warn('State update state.error (component may be destroying):', err);
      }
      return null;
    }
  }
  
  // Store event listener handler for cleanup
  let clickOutsideHandler: ((event: MouseEvent) => void) | null = null;
  
  // Auto-save interval (wrapped in object for effect hook)
  let autoSaveInterval = { value: null as ReturnType<typeof setInterval> | null };
  
  // Cached user data (not in state store - these are temporary caches)
  let cachedUserEmail: string | null = null;
  let cachedUserName: string | null = null;
  
  // Initialize user store sync effect (will be called in onMount to avoid SSR issues)
  const cachedUserData = { email: cachedUserEmail, name: cachedUserName };
  
  // Initialize patch highlights, tab change, and branch change effects
  const lastTab = { value: null as string | null };
  const lastBranch = { value: null as string | null };
  
  // Initialize activeTab from URL query parameter
  // Sync activeTab to match URL state
  $effect(() => {
    if (typeof window === 'undefined' || !state.isMounted) return;
    const tabFromQuery = $page.url.searchParams.get('tab');
    
    const validTabs = ['docs', 'files', 'issues', 'prs', 'patches', 'discussions', 'history', 'tags', 'code-search'];
    
    // Determine what tab the URL represents - default to 'docs' since it always works
    const urlTab = tabFromQuery && validTabs.includes(tabFromQuery) ? tabFromQuery : 'docs';
    
    // Only update if activeTab doesn't match URL state
    if (state.ui.activeTab !== urlTab) {
      state.ui.activeTab = urlTab as typeof state.ui.activeTab;
    }
  });
  
  // Initialize effects at component level (must be top-level, not in onMount)
  // Hooks return effect callbacks that we call within $effect blocks
  $effect(usePageDataEffect(state, () => $page.data));
  $effect(usePageParamsEffect(state, () => $page.params as { npub?: string; repo?: string }));
  $effect(useMaintainersEffect(state, () => repoOwnerPubkeyDerived, () => repoMaintainers, loadAllMaintainers, () => $page.data));
  $effect(useAutoSaveEffect(state, autoSaveInterval, setupAutoSave));
  $effect(useUserStoreEffect(state, cachedUserData, () => $userStore, {
    checkMaintainerStatus,
    loadBookmarkStatus,
    loadAllMaintainers,
    checkCloneStatus,
    loadBranches,
    loadFiles,
    loadReadme,
    loadTags,
    loadDiscussions
  }));
  $effect(useRepoImagesEffect(state, () => $page.data));
  $effect(usePatchHighlightsEffect(state, loadPatchHighlights));
  $effect(useTabChangeEffect(state, lastTab, findReadmeFileUtil, {
    loadFiles,
    loadFile,
    loadCommitHistory,
    loadTags,
    loadReleases,
    loadIssues,
    loadPRs,
    loadDocumentation,
    loadDiscussions,
    loadPatches
  }));
  $effect(useBranchChangeEffect(state, lastBranch, {
    loadReadme,
    loadFile,
    loadFiles,
    loadCommitHistory,
    loadDocumentation
  }));
  
  // Function to toggle word wrap and refresh highlighting
  async function toggleWordWrap() {
    await toggleWordWrapUtil(state, { applySyntaxHighlighting });
  }
  
  // Helper: Check if repo needs to be cloned for write operations
  const needsClone = $derived(state.clone.isCloned === false);
  // Helper: Check if we can use API fallback for read-only operations
  const canUseApiFallback = $derived(state.clone.apiFallbackAvailable === true);
  // Helper: Check if we have any way to view the repo (cloned or API fallback)
  const canViewRepo = $derived(state.clone.isCloned === true || canUseApiFallback);
  const cloneTooltip = 'Please clone this repo to use this feature.';
  
  // Copy clone URL to clipboard
  async function copyCloneUrl() {
    await copyCloneUrlUtil(state, $page.data, $page.url);
  }
  

  
  // Tabs menu - always show all tabs, let each tab component handle its own requirements
  const tabs = [
    { id: 'docs', label: 'Documentation', icon: '/icons/book.svg' },
    { id: 'files', label: 'Files', icon: '/icons/file-text.svg' },
    { id: 'issues', label: 'Issues', icon: '/icons/alert-circle.svg' },
    { id: 'prs', label: 'Pull Requests', icon: '/icons/git-pull-request.svg' },
    { id: 'patches', label: 'Patches', icon: '/icons/clipboard-list.svg' },
    { id: 'discussions', label: 'Discussions', icon: '/icons/message-circle.svg' },
    { id: 'history', label: 'Commit History', icon: '/icons/git-commit.svg' },
    { id: 'tags', label: 'Tags', icon: '/icons/tag.svg' },
    { id: 'code-search', label: 'Code Search', icon: '/icons/search.svg' }
  ];
  
  // Initialize tab switch effect (already done above, but keeping for clarity)
  
  const highlightsService = new HighlightsService(DEFAULT_NOSTR_RELAYS);

  // parseNostrLinks is now imported from utils/nostr-links.ts

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
            state.discussion.nostrLinkProfiles.set(link.value, decoded.data as string);
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
          state.discussion.nostrLinkEvents.set(event.id, event);
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
              state.discussion.nostrLinkEvents.set(events[0].id, events[0]);
            }
          } catch {
            // Ignore fetch errors
          }
        }
      }
    }
  }

  // Get event from nostr: link (local version that uses state)
  function getEventFromNostrLinkLocal(link: string): NostrEvent | undefined {
    try {
      if (link.startsWith('nostr:nevent1') || link.startsWith('nostr:note1')) {
        const decoded = nip19.decode(link.replace('nostr:', ''));
        if (decoded.type === 'nevent') {
          return state.discussion.nostrLinkEvents.get(decoded.data.id);
        } else if (decoded.type === 'note') {
          return state.discussion.nostrLinkEvents.get(decoded.data as string);
        }
      } else if (link.startsWith('nostr:naddr1')) {
        const decoded = nip19.decode(link.replace('nostr:', ''));
        if (decoded.type === 'naddr') {
          const eventId = `${decoded.data.kind}:${decoded.data.pubkey}:${decoded.data.identifier}`;
          return Array.from(state.discussion.nostrLinkEvents.values()).find(e => {
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

  // Get pubkey from nostr: npub/profile link (local version that uses state)
  function getPubkeyFromNostrLinkLocal(link: string): string | undefined {
    return state.discussion.nostrLinkProfiles.get(link);
  }

  // Process content with nostr links into parts for rendering (local version that uses state)
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
      const event = getEventFromNostrLinkLocal(link.value);
      const pubkey = getPubkeyFromNostrLinkLocal(link.value);
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

  // Load full events for state.discussions and comments to get state.git.tags for blurbs
  async function loadDiscussionEvents(discussionsList: typeof state.discussions) {
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
        state.discussion.events.set(event.id, event);
      }
    } catch {
      // Ignore fetch errors
    }
  }

  // Get discussion event by ID
  function getDiscussionEvent(eventId: string): NostrEvent | undefined {
    return state.discussion.events.get(eventId);
  }

  // Get referenced event from discussion event (e-tag, a-tag, q-tag)
  function getReferencedEventFromDiscussion(event: NostrEvent): NostrEvent | undefined {
    // Check e-tag
    const eTag = event.tags.find(t => t[0] === 'e' && t[1])?.[1];
    if (eTag) {
      const referenced = state.discussion.events.get(eTag);
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
        return Array.from(state.discussion.events.values()).find(e => 
          e.kind === kind && 
          e.pubkey === pubkey && 
          e.tags.find(t => t[0] === 'd' && t[1] === dTag)
        );
      }
    }
    
    // Check q-tag
    const qTag = event.tags.find(t => t[0] === 'q' && t[1])?.[1];
    if (qTag) {
      return state.discussion.events.get(qTag);
    }
    
    return undefined;
  }

  // Format time for state.discussions
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

  // Rewrite image paths in HTML to point to repository file API
  function rewriteImagePaths(html: string, filePath: string | null): string {
    if (!html || !filePath) return html;
    
    // Get the directory of the current file
    const fileDir = filePath.includes('/') 
      ? filePath.substring(0, filePath.lastIndexOf('/'))
      : '';
    
    // Get current branch for the API URL
    // If repo is empty (no branches), use null and let API handle it
    const branch = state.git.currentBranch || state.git.defaultBranch || null;
    
    // Rewrite relative image paths
    return html.replace(/<img([^>]*)\ssrc=["']([^"']+)["']([^>]*)>/gi, (match, before, src, after) => {
      // Skip if it's already an absolute URL (http/https/data)
      if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('data:') || src.startsWith('/api/')) {
        return match;
      }
      
      // Resolve relative path
      let imagePath: string;
      if (src.startsWith('/')) {
        // Absolute path from repo root
        imagePath = src.substring(1);
      } else if (src.startsWith('./')) {
        // Relative to current file directory
        imagePath = fileDir ? `${fileDir}/${src.substring(2)}` : src.substring(2);
      } else {
        // Relative to current file directory
        imagePath = fileDir ? `${fileDir}/${src}` : src;
      }
      
      // Normalize path (remove .. and .)
      const pathParts = imagePath.split('/').filter(p => p !== '.' && p !== '');
      const normalizedPath: string[] = [];
      for (const part of pathParts) {
        if (part === '..') {
          normalizedPath.pop();
        } else {
          normalizedPath.push(part);
        }
      }
      imagePath = normalizedPath.join('/');
      
      // Build API URL
      // Use HEAD if branch is null (empty repo)
      const ref = branch || 'HEAD';
      const apiUrl = `/api/repos/${state.npub}/${state.repo}/raw?path=${encodeURIComponent(imagePath)}&ref=${encodeURIComponent(ref)}`;
      
      return `<img${before} src="${apiUrl}"${after}>`;
    });
  }

  // Fork
  let bookmarksService: BookmarksService | null = null;
  
  // Safe values for head section to prevent SSR errors
  const safeRepo = $derived(state.repo || 'Repository');
  const safeRepoName = $derived.by(() => {
    try {
      return repoName || state.repo || 'Repository';
    } catch {
      return state.repo || 'Repository';
    }
  });
  const safeRepoDescription = $derived.by(() => {
    try {
      return repoDescription || '';
    } catch {
      return '';
    }
  });
  const safeTitle = $derived.by(() => {
    try {
      return state.pageData?.title || `${safeRepo} - Repository`;
    } catch {
      return `${safeRepo} - Repository`;
    }
  });
  const safeDescription = $derived.by(() => {
    try {
      return state.pageData?.description || `Repository: ${safeRepo}`;
    } catch {
      return `Repository: ${safeRepo}`;
    }
  });
  const safeImage = $derived.by(() => {
    try {
      return state.pageData?.image || state.metadata.image || null;
    } catch {
      return null;
    }
  });
  const safeBanner = $derived.by(() => {
    try {
      return state.pageData?.banner || state.metadata.banner || null;
    } catch {
      return null;
    }
  });
  const hasImage = $derived.by(() => {
    try {
      return safeImage && typeof safeImage === 'string' && safeImage.trim() !== '';
    } catch {
      return false;
    }
  });
  const hasBanner = $derived.by(() => {
    try {
      return safeBanner && typeof safeBanner === 'string' && safeBanner.trim() !== '';
    } catch {
      return false;
    }
  });
  
  // Additional safe values for head section to avoid IIFEs
  const safeOgDescription = $derived.by(() => {
    try {
      return state.pageData?.description || safeRepoDescription || `Repository: ${safeRepoName || safeRepo || 'Repository'}`;
    } catch {
      return 'Repository';
    }
  });
  const safeTwitterDescription = $derived.by(() => {
    try {
      return state.pageData?.description || safeRepoDescription || `Repository: ${safeRepoName || safeRepo || 'Repository'}`;
    } catch {
      return 'Repository';
    }
  });
  const safeTwitterCard = $derived.by(() => {
    try {
      return twitterCardType || 'summary';
    } catch {
      return 'summary';
    }
  });
  const safePageUrl = $derived.by(() => {
    try {
      return pageUrl || '';
    } catch {
      return '';
    }
  });

  // Repository owner pubkey (decoded from npub) - kept for backward compatibility with some functions
  let readmeAutoLoadTimeout = { value: null as ReturnType<typeof setTimeout> | null };

  // Load clone URL reachability status
  async function loadCloneUrlReachability(forceRefresh: boolean = false) {
    await loadCloneUrlReachabilityService(forceRefresh, state, repoCloneUrls);
  }

  async function loadReadme() {
    await loadReadmeService(state, rewriteImagePaths);
  }

  // File processing utilities are now imported from utils/file-processing.ts

  // Render markdown, asciidoc, or HTML files as HTML
  async function renderFileAsHtml(content: string, ext: string) {
    await renderFileAsHtmlUtil(content, ext, state.files.currentFile, (html: string) => {
      state.preview.file.html = html;
    });
  }

  // CSV and HTML utilities are now imported from utils/file-processing.ts

  async function applySyntaxHighlighting(content: string, ext: string) {
    await applySyntaxHighlightingUtil(content, ext, (html: string) => {
      state.preview.file.highlightedContent = html;
    });
  }

  async function loadForkInfo() {
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/fork`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        state.fork.info = await response.json();
      }
    } catch (err) {
      console.error('Error state.loading.main fork info:', err);
    }
  }

  // Helper function to count all replies recursively (including nested ones)

  async function checkCloneStatus(force: boolean = false) {
    await checkCloneStatusService(force, state, repoCloneUrls);
  }

  async function cloneRepository() {
    await cloneRepositoryService(state, {
      checkCloneStatus,
      loadBranches,
      loadFiles,
      loadReadme,
      loadTags,
      loadCommitHistory
    });
  }

  async function forkRepository() {
    await forkRepositoryService(state);
  }

  async function loadDiscussions() {
    await loadDiscussionsService(state, repoOwnerPubkeyDerived, {
      loadDiscussions,
      loadNostrLinks,
      loadDiscussionEvents: loadDiscussionEvents as any
    });
  }


  async function createDiscussionThread() {
    await createDiscussionThreadService(state, repoOwnerPubkeyDerived, {
      loadDiscussions,
      loadNostrLinks,
      loadDiscussionEvents: loadDiscussionEvents as any
    });
  }

  async function createThreadReply() {
    // Store nostrClient for use in other functions
    const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
    nostrClient = client;
    
    await createThreadReplyService(state, repoOwnerPubkeyDerived, {
      loadDiscussions,
      loadNostrLinks,
      loadDiscussionEvents: loadDiscussionEvents as any
    });
  }

  function toggleThread(threadId: string) {
    toggleThreadUtil(threadId, state.ui.expandedThreads);
    // Trigger reactivity
    state.ui.expandedThreads = new Set(state.ui.expandedThreads);
  }

  async function loadDocumentation() {
    await loadDocumentationService(state, repoOwnerPubkeyDerived, repoIsPrivate);
  }

  async function loadRepoImages() {
    await loadRepoImagesService(state, repoOwnerPubkeyDerived, repoIsPrivate, $page.data);
  }

  // Reactively update images when pageData changes (only once, when data becomes available)
  // Initialize repo images effect (moved to onMount)

  onMount(async () => {
    // Initialize bookmarks service
    bookmarksService = new BookmarksService(DEFAULT_NOSTR_SEARCH_RELAYS);
    
    // Load clone URL reachability status
    loadCloneUrlReachability().catch(err => console.warn('Failed to load clone URL reachability:', err));
    
    // Decode npub to get repo owner pubkey for bookmark address
    try {
      if (state.npub && state.npub.trim()) {
        const decoded = nip19.decode(state.npub);
        if (decoded.type === 'npub') {
          state.metadata.ownerPubkey = decoded.data as string;
          state.metadata.address = `${KIND.REPO_ANNOUNCEMENT}:${state.metadata.ownerPubkey}:${state.repo}`;
        }
      }
    } catch (err) {
      console.warn('Failed to decode npub for bookmark address:', err);
    }

    // Close menu when clicking outside (handled by RepoHeaderEnhanced component)
    clickOutsideHandler = (event: MouseEvent) => {
      if (!state.isMounted) return;
      try {
        const target = event.target as HTMLElement;
        if (state.ui.showRepoMenu && !target.closest('.repo-header') && state.isMounted) {
          state.ui.showRepoMenu = false;
        }
      } catch (err) {
        // Ignore errors during destruction
        if (state.isMounted) {
          console.warn('Click outside handler error:', err);
        }
      }
    };

    document.addEventListener('click', clickOutsideHandler);

    await loadBranches();
    if (!state.isMounted) return;
    
    // Skip other API calls if repository doesn't exist
    if (state.repoNotFound) {
      state.loading.main = false;
      return;
    }
    
    // loadBranches() already handles setting state.git.currentBranch to the default branch
    await loadFiles();
    if (!state.isMounted) return;
    
    await checkAuth();
    if (!state.isMounted) return;
    
    await loadTags();
    if (!state.isMounted) return;
    
    await checkMaintainerStatus();
    if (!state.isMounted) return;
    
    await loadBookmarkStatus();
    if (!state.isMounted) return;
    
    await loadAllMaintainers();
    if (!state.isMounted) return;
    
    // Check clone status (needed to disable write operations)
    await checkCloneStatus();
    if (!state.isMounted) return;
    
    await checkVerification();
    if (!state.isMounted) return;
    
    await loadReadme();
    if (!state.isMounted) return;
    
    await loadForkInfo();
    if (!state.isMounted) return;
    
    await loadRepoImages();
    if (!state.isMounted) return;
    
    // Load clone URL reachability status
    loadCloneUrlReachability().catch(err => {
      if (state.isMounted) console.warn('Failed to load clone URL reachability:', err);
    });
    
    // Set up auto-save if enabled
    setupAutoSave().catch(err => {
      if (state.isMounted) console.warn('Failed to setup auto-save:', err);
    });
  });
  
  // Cleanup on destroy - only register on client side to prevent SSR errors
  if (typeof window !== 'undefined') {
    onDestroy(() => {
      try {
        // Mark component as unmounted first to prevent any state updates
        state.isMounted = false;
        
        // Clean up intervals and timeouts
        if (autoSaveInterval.value) {
          clearInterval(autoSaveInterval.value);
          autoSaveInterval.value = null;
        }
        
        if (readmeAutoLoadTimeout.value) {
          clearTimeout(readmeAutoLoadTimeout.value);
          readmeAutoLoadTimeout.value = null;
        }
        
        // Clean up event listeners
        if (clickOutsideHandler && typeof document !== 'undefined') {
          document.removeEventListener('click', clickOutsideHandler);
          clickOutsideHandler = null;
        }
      } catch (err) {
        // Ignore all errors during cleanup - component is being destroyed anyway
      }
    });
  }

  async function checkAuth() {
    // Check userStore first
    const currentUser = $userStore;
    if (currentUser.userPubkey && currentUser.userPubkeyHex) {
      state.user.pubkey = currentUser.userPubkey;
      state.user.pubkeyHex = currentUser.userPubkeyHex;
      // Recheck maintainer status and bookmark status after auth
      await checkMaintainerStatus();
      await loadBookmarkStatus();
      return;
    }
    
    // Fallback: try NIP-07 if store doesn't have it
    try {
      if (isNIP07Available()) {
        const pubkey = await getPublicKeyWithNIP07();
        state.user.pubkey = pubkey;
        // Convert to hex if needed
        if (/^[0-9a-f]{64}$/i.test(pubkey)) {
          state.user.pubkeyHex = pubkey.toLowerCase();
        } else {
          try {
            const decoded = nip19.decode(pubkey);
            if (decoded.type === 'npub') {
              state.user.pubkeyHex = decoded.data as string;
            }
          } catch {
            state.user.pubkeyHex = pubkey;
          }
        }
        // Recheck maintainer status and bookmark status after auth
        await checkMaintainerStatus();
        await loadBookmarkStatus();
      }
    } catch (err) {
      console.log('NIP-07 not available or user not connected');
      state.user.pubkey = null;
      state.user.pubkeyHex = null;
    }
  }

  async function login() {
    // Check userStore first
    const currentUser = $userStore;
    if (currentUser.userPubkey && currentUser.userPubkeyHex) {
      state.user.pubkey = currentUser.userPubkey;
      state.user.pubkeyHex = currentUser.userPubkeyHex;
      // Re-check maintainer status and bookmark status after login
      await checkMaintainerStatus();
      await loadBookmarkStatus();
      // Check for pending transfers (user is already logged in via store)
      if (state.user.pubkeyHex) {
        try {
          const response = await fetch('/api/transfers/pending', {
            headers: {
              'X-User-Pubkey': state.user.pubkeyHex
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
        state.user.pubkey = pubkey;
      } else {
        try {
          const decoded = nip19.decode(pubkey);
          if (decoded.type === 'npub') {
            pubkeyHex = decoded.data as string;
            state.user.pubkey = pubkey;
          } else {
            throw new Error('Invalid pubkey format');
          }
        } catch {
          state.error = 'Invalid public key format';
          return;
        }
      }
      
      state.user.pubkeyHex = pubkeyHex;
      
      // Check write access and update user store
      const { determineUserLevel } = await import('$lib/services/nostr/user-level-service.js');
      const levelResult = await determineUserLevel(state.user.pubkey, state.user.pubkeyHex);
      
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
      if (state.user.pubkeyHex) {
        try {
          const response = await fetch('/api/transfers/pending', {
            headers: {
              'X-User-Pubkey': state.user.pubkeyHex
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
      state.error = err instanceof Error ? err.message : 'Failed to connect';
      console.error('Login error:', err);
    }
  }


  async function loadBookmarkStatus() {
    await loadBookmarkStatusService(state, bookmarksService);
  }

  async function toggleBookmark() {
    await toggleBookmarkService(state, bookmarksService);
  }

  async function copyEventId() {
    if (!state.metadata.address || !repoOwnerPubkeyDerived) {
      alert('Repository address not available');
      return;
    }

    try {
      // Parse the repo address: kind:pubkey:identifier
      const parts = state.metadata.address.split(':');
      if (parts.length < 3) {
        throw new Error('Invalid repository address format');
      }

      const kind = parseInt(parts[0]);
      const pubkey = parts[1];
      const identifier = parts.slice(2).join(':'); // In case identifier contains ':'

      // Generate naddr synchronously
      const naddr = nip19.naddrEncode({
        kind,
        pubkey,
        identifier,
        relays: [] // Optional: could include relays if available
      });

      // Copy naddr to clipboard immediately (while we have user activation)
      try {
        await navigator.clipboard.writeText(naddr);
      } catch (clipboardErr) {
        // Fallback: use execCommand for older browsers or if clipboard API fails
        const textArea = document.createElement('textarea');
        textArea.value = naddr;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.select();
        try {
          document.execCommand('copy');
          textArea.remove();
        } catch (execErr) {
          textArea.remove();
          throw new Error('Failed to copy to clipboard. Please copy manually: ' + naddr);
        }
      }
      
      // Show message with naddr
      alert(`Event ID copied to clipboard!\n\nnaddr (repository address):\n${naddr}`);
    } catch (err) {
      console.error('Failed to copy event ID:', err);
      alert(`Failed to copy event ID: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function checkMaintainerStatus() {
    await checkMaintainerStatusService(state);
  }

  async function loadAllMaintainers() {
    await loadAllMaintainersService(state, repoOwnerPubkeyDerived, repoMaintainers);
  }

  async function checkVerification() {
    await checkVerificationService(state);
  }

  async function generateAnnouncementFileForRepo() {
    await generateAnnouncementFileForRepoService(state, repoOwnerPubkeyDerived);
  }

  function copyVerificationToClipboard() {
    copyVerificationToClipboardService(state);
  }

  // Verify clone URL by committing announcement
  async function verifyCloneUrl() {
    await verifyCloneUrlService(state, repoOwnerPubkeyDerived, { checkVerification });
  }

  async function deleteAnnouncement() {
    await deleteAnnouncementService(state, repoOwnerPubkeyDerived, announcementEventId);
  }

  function downloadVerificationFile() {
    downloadVerificationFileService(state);
  }

  // buildApiHeaders is now imported from utils/api-client.ts - using it directly

  // Safe wrapper functions for SSR - use function declarations that check at call time
  // This ensures they're always defined and never null, even during SSR
  function safeCopyCloneUrl() {
    if (typeof window === 'undefined') return Promise.resolve();
    try {
      return copyCloneUrl();
    } catch (err) {
      console.warn('Error in copyCloneUrl:', err);
      return Promise.resolve();
    }
  }

  function safeDeleteBranch(branchName: string) {
    if (typeof window === 'undefined') return Promise.resolve();
    try {
      return deleteBranch(branchName);
    } catch (err) {
      console.warn('Error in deleteBranch:', err);
      return Promise.resolve();
    }
  }

  function safeToggleBookmark() {
    if (typeof window === 'undefined') return Promise.resolve();
    try {
      return toggleBookmark();
    } catch (err) {
      console.warn('Error in toggleBookmark:', err);
      return Promise.resolve();
    }
  }

  function safeForkRepository() {
    if (typeof window === 'undefined') return Promise.resolve();
    try {
      return forkRepository();
    } catch (err) {
      console.warn('Error in forkRepository:', err);
      return Promise.resolve();
    }
  }

  function safeCloneRepository() {
    if (typeof window === 'undefined') return Promise.resolve();
    try {
      return cloneRepository();
    } catch (err) {
      console.warn('Error in cloneRepository:', err);
      return Promise.resolve();
    }
  }

  function safeHandleBranchChange(branch: string) {
    if (typeof window === 'undefined') return;
    try {
      handleBranchChangeDirect(branch);
    } catch (err) {
      console.warn('Error in handleBranchChangeDirect:', err);
    }
  }

  // Download function - now using extracted utility
  async function downloadRepository(ref?: string, filename?: string): Promise<void> {
    await downloadRepoUtil({
      npub: state.npub,
      repo: state.repo,
      ref,
      filename
    });
  }

  async function loadBranches() {
    await loadBranchesService(state, repoCloneUrls);
  }

  async function loadFiles(path: string = '') {
    await loadFilesService(path, state, repoCloneUrls, readmeAutoLoadTimeout, {
      getUserEmail,
      getUserName,
      loadFiles,
      loadFile,
      renderFileAsHtml,
      applySyntaxHighlighting,
      findReadmeFile: findReadmeFileUtil,
      rewriteImagePaths
    });
  }

  async function loadFile(filePath: string) {
    await loadFileService(filePath, state, {
      getUserEmail,
      getUserName,
      loadFiles,
      loadFile,
      renderFileAsHtml,
      applySyntaxHighlighting,
      findReadmeFile: findReadmeFileUtil,
      rewriteImagePaths
    });
  }

  function handleContentChange(value: string) {
    handleContentChangeUtil(value, state);
  }

  function handleFileClick(file: { name: string; path: string; type: 'file' | 'directory' }) {
    handleFileClickUtil(file, state, { loadFiles, loadFile });
  }

  // Copy file content to clipboard
  async function copyFileContent(event?: Event) {
    await copyFileContentUtil(state, event);
  }

  // Download file
  function downloadFile() {
    downloadFileUtil(state);
  }

  function handleBack() {
    handleBackUtil(state, { loadFiles });
  }

  // Cache for user profile email and name (already declared above)
  let fetchingUserEmail = false;
  let fetchingUserName = false;

  async function getUserEmail(): Promise<string> {
    return getUserEmailUtil(state.user.pubkeyHex, state.user.pubkey, { email: cachedUserEmail, name: cachedUserName }, { email: fetchingUserEmail, name: fetchingUserName });
  }

  async function getUserName(): Promise<string> {
    return getUserNameUtil(state.user.pubkeyHex, state.user.pubkey, { email: cachedUserEmail, name: cachedUserName }, { email: fetchingUserEmail, name: fetchingUserName });
  }

  async function setupAutoSave() {
    // Clear existing interval if any
    if (autoSaveInterval.value) {
      clearInterval(autoSaveInterval.value);
      autoSaveInterval.value = null;
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
    autoSaveInterval.value = setInterval(async () => {
      await autoSaveFile();
    }, 10 * 60 * 1000); // 10 minutes
  }
  
  async function autoSaveFile() {
    // Only auto-save if:
    // 1. There are changes
    // 2. A file is open
    // 3. User is logged in
    // 4. User is a maintainer
    // 5. Not currently state.saving
    // 6. Not in clone state
    if (!state.files.hasChanges || !state.files.currentFile || !state.user.pubkey || !state.maintainers.isMaintainer || state.saving || needsClone) {
      return;
    }
    
    // Check auto-save setting again (in case it changed)
    try {
      const settings = await settingsStore.getSettings();
      if (!settings.autoSave) {
        // Auto-save was disabled, clear interval
        if (autoSaveInterval.value) {
          clearInterval(autoSaveInterval.value);
          autoSaveInterval.value = null;
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
      
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          path: state.files.currentFile,
          content: state.files.editedContent,
          message: autoCommitMessage,
          authorName: authorName,
          authorEmail: authorEmail,
          branch: state.git.currentBranch,
          userPubkey: state.user.pubkey,
          commitSignatureEvent: commitSignatureEvent
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: response.statusText }));
        console.warn('Auto-save failed:', errorData.message || 'Failed to save file');
        return;
      }

      // Reload file to get updated content
      await loadFile(state.files.currentFile);
      // Note: We don't show an alert for auto-save, it's silent
      console.log('Auto-saved file:', state.files.currentFile);
    } catch (err) {
      console.warn('Error during auto-save:', err);
      // Don't show state.error to user, it's silent
    }
  }

  async function saveFile() {
    await saveFileService(state, {
      getUserEmail,
      getUserName,
      loadFiles,
      loadFile,
      renderFileAsHtml,
      applySyntaxHighlighting,
      findReadmeFile: findReadmeFileUtil,
      rewriteImagePaths
    });
  }

  function handleBranchChangeDirect(branch: string) {
    state.git.currentBranch = branch;
    // Create a synthetic event for the existing handler
    const syntheticEvent = {
      target: { value: branch }
    } as unknown as Event;
    handleBranchChange(syntheticEvent);
  }

  async function handleBranchChange(event: Event) {
    const target = event.target as HTMLSelectElement;
    state.git.currentBranch = target.value;
    
    // Reload all branch-dependent data
    const reloadPromises: Promise<void>[] = [];
    
    // Always reload state.files.list (and current file if open)
    if (state.files.currentFile) {
      reloadPromises.push(loadFile(state.files.currentFile).catch(err => console.warn('Failed to reload file after branch change:', err)));
    } else {
      reloadPromises.push(loadFiles(state.files.currentPath).catch(err => console.warn('Failed to reload state.files.list after branch change:', err)));
    }
    
    // Reload README (branch-specific)
    reloadPromises.push(loadReadme().catch(err => console.warn('Failed to reload README after branch change:', err)));
    
    // Reload commit history if history tab is active
    if (state.ui.activeTab === 'history') {
      reloadPromises.push(loadCommitHistory().catch(err => console.warn('Failed to reload commit history after branch change:', err)));
    }
    
    // Reload documentation if docs tab is active (might be branch-specific)
    if (state.ui.activeTab === 'docs') {
      // Reset documentation to force reload
      state.docs.html = null;
      state.docs.content = null;
      state.docs.kind = null;
      reloadPromises.push(loadDocumentation().catch(err => console.warn('Failed to reload documentation after branch change:', err)));
    }
    
    // Wait for all reloads to complete
    await Promise.all(reloadPromises);
  }

  async function createFile() {
    await createFileService(state, {
      getUserEmail,
      getUserName,
      loadFiles,
      loadFile,
      renderFileAsHtml,
      applySyntaxHighlighting,
      findReadmeFile: findReadmeFileUtil,
      rewriteImagePaths
    });
  }

  async function deleteFile(filePath: string) {
    await deleteFileService(filePath, state, {
      getUserEmail,
      getUserName,
      loadFiles,
      loadFile,
      renderFileAsHtml,
      applySyntaxHighlighting,
      findReadmeFile: findReadmeFileUtil,
      rewriteImagePaths
    });
  }

  async function createBranch() {
    await createBranchService(state, repoAnnouncement, {
      loadBranches,
      loadFiles,
      loadFile,
      loadReadme,
      loadCommitHistory,
      loadDocumentation
    });
  }

  async function deleteBranch(branchName: string) {
    await deleteBranchService(branchName, state, {
      loadBranches,
      loadFiles,
      loadFile,
      loadReadme,
      loadCommitHistory,
      loadDocumentation
    });
  }

  async function loadCommitHistory() {
    await loadCommitHistoryService(state, { verifyCommit });
  }

  async function verifyCommit(commitHash: string) {
    await verifyCommitService(commitHash, state);
  }

  async function viewDiff(commitHash: string) {
    await viewDiffService(commitHash, state);
  }

  async function loadTags() {
    await loadTagsService(state, { loadTags });
  }

  async function createTag() {
    await createTagService(state, { loadTags });
  }

  async function loadReleases() {
    await loadReleasesService(state, { loadReleases });
  }

  async function createRelease() {
    await createReleaseService(state, repoOwnerPubkeyDerived, {
      loadReleases
    });
    // Reload tags to show release indicator
    await loadTags();
  }

  async function performCodeSearch() {
    await performCodeSearchService(state);
  }

  async function loadIssues() {
    await loadIssuesService(state, {
      loadIssues,
      loadIssueReplies,
      nostrClient
    });
  }

  async function loadIssueReplies(issueId: string) {
    await loadIssueRepliesService(issueId, state, {
      loadIssues,
      loadIssueReplies,
      nostrClient
    });
  }

  async function createIssue() {
    await createIssueService(state, {
      loadIssues,
      loadIssueReplies,
      nostrClient
    });
  }

  async function updatePatchStatus(patchId: string, patchAuthor: string, status: string) {
    await updatePatchStatusService(patchId, patchAuthor, status, state, { loadPatches });
  }

  async function updateIssueStatus(issueId: string, issueAuthor: string, status: 'open' | 'closed' | 'resolved' | 'draft') {
    await updateIssueStatusService(issueId, issueAuthor, status, state, {
      loadIssues,
      loadIssueReplies,
      nostrClient
    });
  }

  async function loadPRs() {
    await loadPRsService(state, { loadPRs });
  }

  async function createPR() {
    await createPRService(state, { loadPRs });
  }

  async function createPatch() {
    await createPatchService(state, { loadPatches });
  }

  async function loadPatches() {
    await loadPatchesService(state, { loadPatches });
  }

  async function loadPatchHighlights(patchId: string, patchAuthor: string) {
    await loadPatchHighlightsService(patchId, patchAuthor, state);
  }

  function handlePatchCodeSelection(
    text: string,
    startLine: number,
    endLine: number,
    startPos: number,
    endPos: number
  ) {
    handlePatchCodeSelectionUtil(text, startLine, endLine, startPos, endPos, state);
  }

  async function createPatchHighlight() {
    await createPatchHighlightService(state, highlightsService, { loadPatches });
  }

  function formatPubkey(pubkey: string): string {
    return formatPubkeyUtil(pubkey);
  }

  function startPatchComment(parentId?: string) {
    startPatchCommentUtil(parentId, state);
  }

  async function createPatchComment() {
    await createPatchCommentService(state, highlightsService, { loadPatches });
  }

</script>

<svelte:head>
  <title>{safeTitle || 'Repository'}</title>
  <meta name="description" content={safeDescription || 'Repository'} />
  
  <!-- OpenGraph / Facebook -->
  <meta property="og:type" content="website" />
  <meta property="og:title" content={safeTitle || 'Repository'} />
  <meta property="og:description" content={safeOgDescription} />
  <meta property="og:url" content={safePageUrl} />
  {#if hasImage && safeImage}
    <meta property="og:image" content={safeImage} />
  {/if}
  {#if hasBanner && safeBanner}
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
  {/if}
  
  <!-- Twitter Card -->
  <meta name="twitter:card" content={safeTwitterCard} />
  <meta name="twitter:title" content={safeTitle || 'Repository'} />
  <meta name="twitter:description" content={safeTwitterDescription} />
  {#if hasBanner && safeBanner}
    <meta name="twitter:image" content={safeBanner} />
  {:else if hasImage && safeImage}
    <meta name="twitter:image" content={safeImage} />
  {/if}
</svelte:head>

<div class="container">
  <!-- Banner hidden on mobile, shown on desktop -->
  {#if state.metadata.banner && typeof state.metadata.banner === 'string' && state.metadata.banner.trim()}
    <div class="repo-banner desktop-only">
      <img src={state.metadata.banner} alt="" onerror={(e) => { 
        if (typeof window !== 'undefined') {
          console.error('[Repo Images] Failed to load banner:', state.metadata.banner); 
          const target = e.target as HTMLImageElement;
          if (target) target.style.display = 'none';
        }
      }} />
    </div>
  {/if}
  
  {#if repoOwnerPubkeyDerived}
    <RepoHeaderEnhanced
      repoName={repoName || ''}
      repoDescription={repoDescription || ''}
      ownerNpub={state.npub || ''}
      ownerPubkey={repoOwnerPubkeyDerived || ''}
      isMaintainer={state.maintainers.isMaintainer || false}
      isPrivate={repoIsPrivate || false}
      cloneUrls={repoCloneUrls || []}
      branches={state.git.branches || []}
      currentBranch={state.git.currentBranch || null}
      topics={repoTopics || []}
      defaultBranch={state.git.defaultBranch || null}
      isRepoCloned={state.clone.isCloned}
      copyingCloneUrl={state.clone.copyingUrl || false}
      onBranchChange={safeHandleBranchChange}
      onCopyCloneUrl={safeCopyCloneUrl}
      onDeleteBranch={safeDeleteBranch}
      onMenuToggle={() => { if (typeof state.ui.showRepoMenu !== 'undefined') state.ui.showRepoMenu = !state.ui.showRepoMenu; }}
      showMenu={state.ui.showRepoMenu || false}
      userPubkey={state.user.pubkey || null}
      isBookmarked={state.bookmark.isBookmarked || false}
      loadingBookmark={state.loading.bookmark || false}
      onToggleBookmark={safeToggleBookmark}
      onFork={safeForkRepository}
      forking={state.fork.forking || false}
      onCloneToServer={safeCloneRepository}
      cloning={state.clone.cloning || false}
      checkingCloneStatus={state.clone.checking || false}
      onCreateIssue={() => { state.openDialog = 'createIssue'; }}
      onCreatePR={() => { state.openDialog = 'createPR'; }}
      onCreatePatch={() => { state.openDialog = 'createPatch'; }}
      onCreateBranch={async () => {
        if (!state.user.pubkey || !state.maintainers.isMaintainer || needsClone) return;
        try {
          const settings = await settingsStore.getSettings();
          state.forms.branch.defaultName = settings.defaultBranch || 'master';
        } catch {
          state.forms.branch.defaultName = 'master';
        }
        // Preset the default branch name in the input field
        state.forms.branch.name = state.forms.branch.defaultName;
        state.forms.branch.from = null; // Reset from branch selection
        state.openDialog = 'createBranch';
      }}
      onSettings={() => goto(`/signup?npub=${state.npub}&repo=${state.repo}`)}
      onGenerateVerification={repoOwnerPubkeyDerived && state.user.pubkeyHex === repoOwnerPubkeyDerived && state.verification.status?.verified !== true ? generateAnnouncementFileForRepo : undefined}
      onDeleteAnnouncement={repoOwnerPubkeyDerived && state.user.pubkeyHex === repoOwnerPubkeyDerived ? deleteAnnouncement : undefined}
      deletingAnnouncement={state.creating.announcement}
      hasUnlimitedAccess={hasUnlimitedAccess($userStore.userLevel)}
      needsClone={needsClone}
      allMaintainers={state.maintainers.all}
      onCopyEventId={copyEventId}
    />
  {/if}

  <!-- Additional repo metadata (website, clone URLs with verification) -->

  {#if repoWebsite || (repoCloneUrls && repoCloneUrls.length > 0) || repoLanguage || (repoTopics && repoTopics.length > 0) || state.fork.info?.isFork}
    <div class="repo-metadata-section">
      {#if repoWebsite}
        <div class="repo-website">
          <a href={repoWebsite} target="_blank" rel="noopener noreferrer">
            <img src="/icons/external-link.svg" alt="" class="icon-inline" />
            {repoWebsite}
          </a>
        </div>
      {/if}
      {#if repoLanguage}
        <span class="repo-language">
          <img src="/icons/file-text.svg" alt="" class="icon-inline" />
          {repoLanguage}
        </span>
      {/if}
      {#if state.fork.info?.isFork && state.fork.info.originalRepo}
        <span class="fork-badge">Forked from <a href={`/repos/${state.fork.info.originalRepo.npub}/${state.fork.info.originalRepo.repo}`}>{state.fork.info.originalRepo.repo}</a></span>
      {/if}
      {#if repoCloneUrls && repoCloneUrls.length > 0}
        <div class="repo-clone-urls">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <button 
              class="clone-label-button"
              onclick={() => state.clone.urlsExpanded = !state.clone.urlsExpanded}
              aria-expanded={state.clone.urlsExpanded}
            >
              <span class="clone-label">Clone URLs:</span>
            <img src="/icons/chevron-down.svg" alt="" class="clone-toggle-icon icon-inline" class:expanded={state.clone.urlsExpanded} />
          </button>
          <button
            class="reachability-refresh-button"
            onclick={() => loadCloneUrlReachability(true)}
            disabled={state.loading.reachability}
            title="Refresh reachability status"
          >
            {#if state.loading.reachability}
              Checking...
            {:else}
              <img src="/icons/refresh-cw.svg" alt="" class="refresh-icon icon-inline" />
              <span>Check Reachability</span>
            {/if}
          </button>
          </div>
          <div class="clone-url-list" class:collapsed={!state.clone.urlsExpanded}>
            {#if state.clone.isCloned === true && $page.data?.gitDomain && !$page.data.gitDomain.startsWith('localhost') && !$page.data.gitDomain.startsWith('127.0.0.1')}
              <button 
                class="copy-clone-url-button"
                onclick={() => copyCloneUrl()}
                disabled={state.clone.copyingUrl}
                title="Copy clone URL"
              >
                <img src="/icons/copy.svg" alt="" class="icon-inline" />
                {state.clone.copyingUrl ? 'Copying...' : 'Copy Clone URL'}
              </button>
            {/if}
            {#each (state.clone.showAllUrls ? repoCloneUrls : repoCloneUrls.slice(0, 3)) as cloneUrl}
            {@const cloneVerification = state.verification.status?.cloneVerifications?.find(cv => {
              const normalizeUrl = (url: string) => url.replace(/\/$/, '').toLowerCase().replace(/^https?:\/\//, '');
              const normalizedCv = normalizeUrl(cv.url);
              const normalizedClone = normalizeUrl(cloneUrl);
              return normalizedCv === normalizedClone || 
                     normalizedCv.includes(normalizedClone) || 
                     normalizedClone.includes(normalizedCv);
            })}
            {@const reachability = state.clone.reachability.get(cloneUrl)}
            {@const isChecking = state.clone.checkingReachability.has(cloneUrl)}
            <div class="clone-url-wrapper">
              <code class="clone-url">{cloneUrl}</code>
              {#if state.loading.verification}
                <span class="verification-badge state.loading.main" title="Checking verification...">
                  <span style="opacity: 0.5;">⋯</span>
                </span>
              {:else if cloneVerification !== undefined}
                {#if cloneVerification.verified}
                  <span 
                    class="verification-badge verified" 
                    title="Verified ownership"
                  >
                    <img src="/icons/check-circle.svg" alt="Verified" class="icon-inline" />
                  </span>
                {:else}
                  {#if state.user.pubkey && (state.maintainers.isMaintainer || state.user.pubkeyHex === repoOwnerPubkeyDerived) && state.clone.isCloned === true}
                    <button
                      class="verification-badge unverified clickable"
                      title="Click to verify this repository by committing the repo announcement event"
                      onclick={() => {
                        state.verification.selectedCloneUrl = cloneUrl;
                        state.openDialog = 'cloneUrlVerification';
                      }}
                    >
                      <img src="/icons/alert-triangle.svg" alt="Unverified" class="icon-inline" />
                    </button>
                  {:else}
                    <span 
                      class="verification-badge unverified" 
                      title={cloneVerification.error || 'Unverified'}
                    >
                      <img src="/icons/alert-triangle.svg" alt="Unverified" class="icon-inline" />
                    </span>
                  {/if}
                {/if}
              {:else if state.verification.status}
                {#if state.user.pubkey && (state.maintainers.isMaintainer || state.user.pubkeyHex === repoOwnerPubkeyDerived) && state.clone.isCloned === true}
                  <button
                    class="verification-badge unverified clickable"
                    title="Click to verify this repository by committing the repo announcement event"
                    onclick={() => {
                      state.verification.selectedCloneUrl = cloneUrl;
                      state.openDialog = 'cloneUrlVerification';
                    }}
                  >
                    <img src="/icons/alert-triangle.svg" alt="Unknown" class="icon-inline" />
                  </button>
                {:else}
                  <span class="verification-badge unverified" title="Verification status unknown">
                    <img src="/icons/alert-triangle.svg" alt="Unknown" class="icon-inline" />
                  </span>
                {/if}
              {:else}
                {#if state.user.pubkey && (state.maintainers.isMaintainer || state.user.pubkeyHex === repoOwnerPubkeyDerived) && state.clone.isCloned === true}
                  <button
                    class="verification-badge unverified clickable"
                    title="Click to verify this repository by committing the repo announcement event"
                    onclick={() => {
                      state.verification.selectedCloneUrl = cloneUrl;
                      state.openDialog = 'cloneUrlVerification';
                    }}
                  >
                    <img src="/icons/alert-triangle.svg" alt="Not checked" class="icon-inline" />
                  </button>
                {:else}
                  <span class="verification-badge unverified" title="Verification not checked">
                    <img src="/icons/alert-triangle.svg" alt="Not checked" class="icon-inline" />
                  </span>
                {/if}
              {/if}
              {#if isChecking || state.loading.reachability}
                <span class="reachability-badge state.loading.main" title="Checking reachability...">
                  <span style="opacity: 0.5;">⋯</span>
                </span>
              {:else if reachability !== undefined}
                <span 
                  class="reachability-badge" 
                  class:reachable={reachability.reachable} 
                  class:unreachable={!reachability.reachable}
                  title={reachability.reachable 
                    ? `Reachable${reachability.serverType === 'grasp' ? ' (GRASP server)' : reachability.serverType === 'git' ? ' (Git server)' : ''}` 
                    : (reachability.error || 'Unreachable')}
                >
                  {#if reachability.reachable}
                    <img src="/icons/check-circle.svg" alt="Reachable" class="icon-inline icon-success" />
                  {:else}
                    <img src="/icons/x-circle.svg" alt="Unreachable" class="icon-inline icon-state.error" />
                  {/if}
                </span>
                {#if reachability.serverType === 'grasp'}
                  <span class="server-type-badge grasp-badge" title="GRASP server (git server with Nostr relay and GRASP features)">
                    GRASP
                  </span>
                {:else if reachability.serverType === 'git'}
                  <span class="server-type-badge git-badge" title="Git server (standard git smart HTTP)">
                    Git
                  </span>
                {/if}
              {/if}
            </div>
            {/each}
            {#if repoCloneUrls.length > 3}
              <button 
                class="clone-more" 
                onclick={() => state.clone.showAllUrls = !state.clone.showAllUrls}
                title={state.clone.showAllUrls ? 'Show fewer' : 'Show all clone URLs'}
              >
                {state.clone.showAllUrls ? `-${repoCloneUrls.length - 3} less` : `+${repoCloneUrls.length - 3} more`}
              </button>
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {/if}

  <main class="repo-view">
    {#if state.clone.isCloned === false && (canUseApiFallback || state.clone.apiFallbackAvailable === null)}
      <div class="read-only-banner">
        <div class="banner-content">
          <img src="/icons/alert-circle.svg" alt="Info" class="banner-icon" />
          <span>
            {#if state.clone.apiFallbackAvailable === null}
              Checking external clone URLs for read-only access...
            {:else}
              This repository is displayed in <strong>read-only mode</strong> using data from external clone URLs. To enable editing and full features, clone this repository to the server.
            {/if}
          </span>
          {#if hasUnlimitedAccess($userStore.userLevel) && state.clone.apiFallbackAvailable !== null}
            <button 
              class="clone-button-banner"
              onclick={cloneRepository}
              disabled={state.clone.cloning || state.clone.checking}
            >
              {state.clone.cloning ? 'Cloning...' : (state.clone.checking ? 'Checking...' : 'Clone to Server')}
            </button>
          {/if}
        </div>
      </div>
    {/if}
    {#if state.error}
      <div class="state.error">
        <div class="state.error-message">
          <strong>Error:</strong> {state.error}
        </div>
        {#if state.error.includes('not cloned locally') && hasUnlimitedAccess($userStore.userLevel)}
          <div class="state.error-actions">
            <button 
              class="clone-button-inline"
              onclick={cloneRepository}
              disabled={state.clone.cloning || state.clone.checking}
            >
              {state.clone.cloning ? 'Cloning...' : (state.clone.checking ? 'Checking...' : 'Clone to Server')}
            </button>
          </div>
        {/if}
      </div>
    {/if}

    <!-- Tabs -->
    <div class="repo-layout">
      <!-- Files Tab -->
      {#if state.ui.activeTab === 'files'}
        <FilesTab
          files={state.files.list}
          currentPath={state.files.currentPath}
          currentFile={state.files.currentFile}
          fileContent={state.files.content}
          fileLanguage={state.files.language}
          editedContent={state.files.editedContent}
          hasChanges={state.files.hasChanges}
          loading={state.loading.main && !state.files.currentFile}
          error={state.error}
          pathStack={state.files.pathStack}
          onFileClick={handleFileClick}
          onDirectoryClick={(path) => {
            state.files.currentPath = path;
            loadFiles(path);
          }}
          onNavigateBack={handleBack}
          onContentChange={(content) => {
            state.files.editedContent = content;
            state.files.hasChanges = content !== state.files.content;
          }}
          isMaintainer={state.maintainers.isMaintainer}
          readmeContent={state.preview.readme.content || null}
          readmePath={state.preview.readme.path || null}
          readmeHtml={state.preview.readme.html}
          showFilePreview={state.preview.file.showPreview}
          fileHtml={state.preview.file.html}
          highlightedFileContent={state.preview.file.highlightedContent}
          isImageFile={state.preview.file.isImage}
          imageUrl={state.preview.file.imageUrl}
          wordWrap={state.ui.wordWrap}
          {supportsPreview}
          onSave={() => {
            if (!state.user.pubkey || !state.maintainers.isMaintainer || needsClone) return;
            state.openDialog = 'commit';
          }}
          onTogglePreview={() => {
            state.preview.file.showPreview = !state.preview.file.showPreview;
            if (!state.preview.file.showPreview && state.files.content && state.files.currentFile) {
              const ext = state.files.currentFile.split('.').pop() || '';
              applySyntaxHighlighting(state.files.content, ext).catch(err => console.error('Error applying syntax highlighting:', err));
            }
          }}
          onCopyFileContent={copyFileContent}
          onDownloadFile={downloadFile}
          copyingFile={state.preview.copying}
          saving={state.saving}
          needsClone={needsClone}
          {cloneTooltip}
          branches={state.git.branches}
          currentBranch={state.git.currentBranch}
          defaultBranch={state.git.defaultBranch}
          onBranchChange={(branch) => {
            state.git.currentBranch = branch;
            handleBranchChangeDirect(branch);
          }}
          userPubkey={state.user.pubkey}
          activeTab={state.ui.activeTab}
          {tabs}
          onTabChange={(tab: string) => {
            state.ui.activeTab = tab as typeof state.ui.activeTab;
            // Update URL query parameter without page reload
            const url = new URL($page.url);
            if (tab === 'docs') {
              url.searchParams.delete('tab');
            } else {
              url.searchParams.set('tab', tab);
            }
            goto(url.pathname + url.search, { replaceState: true, noScroll: true });
          }}
        />
      {/if}

      <!-- History Tab -->
      {#if state.ui.activeTab === 'history'}
        <HistoryTab
          commits={state.git.commits}
          selectedCommit={state.git.selectedCommit}
          loading={state.loading.commits}
          error={state.error}
          onSelect={(hash) => {
            state.git.selectedCommit = hash;
            viewDiff(hash);
          }}
          onVerify={async (hash) => {
            state.git.verifyingCommits.add(hash);
            try {
              // Trigger verification logic - find the commit and verify
              const commit = state.git.commits.find(c => (c.hash || (c as any).sha) === hash);
              if (commit) {
                await verifyCommit(hash);
              }
            } finally {
              state.git.verifyingCommits.delete(hash);
            }
          }}
          verifyingCommits={state.git.verifyingCommits}
          showDiff={state.git.showDiff}
          diffData={state.git.diffData}
          activeTab={state.ui.activeTab}
          {tabs}
          onTabChange={(tab: string) => {
            state.ui.activeTab = tab as typeof state.ui.activeTab;
            // Update URL query parameter without page reload
            const url = new URL($page.url);
            if (tab === 'docs') {
              url.searchParams.delete('tab');
            } else {
              url.searchParams.set('tab', tab);
            }
            goto(url.pathname + url.search, { replaceState: true, noScroll: true });
          }}
        />
      {/if}

      <!-- Tags View -->
      <TagsTab
        npub={state.npub}
        repo={state.repo}
        tags={state.git.tags}
        releases={state.releases}
        selectedTag={state.git.selectedTag}
        isMaintainer={state.maintainers.isMaintainer}
        userPubkeyHex={state.user.pubkeyHex}
        repoOwnerPubkeyDerived={repoOwnerPubkeyDerived}
        isRepoCloned={state.clone.isCloned}
        {canViewRepo}
        canUseApiFallback={canUseApiFallback}
        {needsClone}
        {cloneTooltip}
        activeTab={state.ui.activeTab}
        {tabs}
        showLeftPanelOnMobile={state.ui.showLeftPanelOnMobile}
        onTagSelect={(tagName) => state.git.selectedTag = tagName}
          onTabChange={(tab: string) => {
            state.ui.activeTab = tab as typeof state.ui.activeTab;
            // Update URL without page reload
            const url = new URL($page.url);
            if (tab === 'docs') {
              url.searchParams.delete('tab');
            } else {
              url.searchParams.set('tab', tab);
            }
            goto(url.pathname + url.search, { replaceState: true, noScroll: true });
          }}
        onToggleMobilePanel={() => state.ui.showLeftPanelOnMobile = !state.ui.showLeftPanelOnMobile}
        onCreateTag={() => state.openDialog = 'createTag'}
        onCreateRelease={(tagName, tagHash) => {
          state.forms.release.tagName = tagName;
          state.forms.release.tagHash = tagHash;
          state.openDialog = 'createRelease';
        }}
        onLoadTags={loadTags}
      />

      <!-- Code Search View -->
      {#if state.ui.activeTab === 'code-search'}
      <aside class="code-search-sidebar" class:hide-on-mobile={!state.ui.showLeftPanelOnMobile && state.ui.activeTab === 'code-search'}>
        <div class="code-search-header">
          <TabsMenu 
            activeTab={state.ui.activeTab} 
            {tabs} 
            onTabChange={(tab: string) => {
              state.ui.activeTab = tab as typeof state.ui.activeTab;
              // Update URL query parameter without page reload
              const url = new URL($page.url);
              if (tab === 'docs') {
                url.searchParams.delete('tab');
              } else {
                url.searchParams.set('tab', tab);
              }
              goto(url.pathname + url.search, { replaceState: true, noScroll: true });
            }}
          />
          <h2>Code Search</h2>
          <button 
            onclick={() => state.ui.showLeftPanelOnMobile = !state.ui.showLeftPanelOnMobile} 
            class="mobile-toggle-button"
            title="Show content"
          >
            <img src="/icons/arrow-right.svg" alt="Show content" class="icon-inline" />
          </button>
        </div>
      </aside>
      {/if}

      <!-- Issues Tab -->
        {#if state.ui.activeTab === 'issues'}
          <IssuesTab
            issues={state.issues}
            selectedIssue={state.selected.issue}
            loading={state.loading.issues}
          error={state.error}
          onSelect={(id) => {
            state.selected.issue = id;
            loadIssueReplies(id);
          }}
          onStatusUpdate={async (id, status) => {
            // Find issue and update status
            const issue = state.issues.find(i => i.id === id);
            if (issue) {
              await updateIssueStatus(id, issue.author, status as 'open' | 'closed' | 'resolved' | 'draft');
              await loadIssues();
            }
          }}
          issueReplies={state.issueReplies}
          loadingReplies={state.loading.issueReplies}
          activeTab={state.ui.activeTab}
          {tabs}
          onTabChange={(tab: string) => {
            state.ui.activeTab = tab as typeof state.ui.activeTab;
            // Update URL query parameter without page reload
            const url = new URL($page.url);
            if (tab === 'docs') {
              url.searchParams.delete('tab');
            } else {
              url.searchParams.set('tab', tab);
            }
            goto(url.pathname + url.search, { replaceState: true, noScroll: true });
          }}
          onCreate={() => { state.openDialog = 'createIssue'; }}
          userPubkey={state.user.pubkey || null}
        />
      {/if}

      <!-- Pull Requests Tab -->
      {#if state.ui.activeTab === 'prs'}
        <PRsTab
          prs={state.prs}
          selectedPR={state.selected.pr || null}
          loading={state.loading.prs}
          error={state.error}
          onSelect={(id) => {
            state.selected.pr = id;
          }}
          onStatusUpdate={async (id, status) => {
            // Find PR and update status - similar to updateIssueStatus
            const pr = state.prs.find(p => p.id === id);
            if (pr && state.user.pubkeyHex) {
              // Check if user is maintainer or PR author
              const isAuthor = state.user.pubkeyHex === pr.author;
              if (!state.maintainers.isMaintainer && !isAuthor) {
                alert('Only repository maintainers or PR authors can update PR status');
                return;
              }
              
              try {
                const response = await fetch(`/api/repos/${state.npub}/${state.repo}/prs`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    prId: id,
                    prAuthor: pr.author,
                    status
                  })
                });
                
                if (!response.ok) {
                  const data = await response.json();
                  throw new Error(data.state.error || 'Failed to update PR status');
                }
                
                await loadPRs();
              } catch (err) {
                state.error = err instanceof Error ? err.message : 'Failed to update PR status';
                console.error('Error updating PR status:', err);
              }
            }
          }}
          activeTab={state.ui.activeTab}
          {tabs}
          onTabChange={(tab: string) => {
            state.ui.activeTab = tab as typeof state.ui.activeTab;
            // Update URL query parameter without page reload
            const url = new URL($page.url);
            if (tab === 'docs') {
              url.searchParams.delete('tab');
            } else {
              url.searchParams.set('tab', tab);
            }
            goto(url.pathname + url.search, { replaceState: true, noScroll: true });
          }}
          onCreate={() => { state.openDialog = 'createPR'; }}
          userPubkey={state.user.pubkey || null}
        />
      {/if}

      <!-- Patches Tab -->
      {#if state.ui.activeTab === 'patches'}
        <PatchesTab
          patches={state.patches}
          selectedPatch={state.selected.patch}
          loading={state.loading.patches}
          error={state.error}
          onSelect={(id) => {
            state.selected.patch = id;
          }}
          onStatusUpdate={async (id, status) => {
            const patch = state.patches.find(p => p.id === id);
            if (patch) {
              await updatePatchStatus(id, patch.author, status);
            }
          }}
          onApply={async (id) => {
            applying[id] = true;
            try {
              const patch = state.patches.find(p => p.id === id);
              if (!patch) {
                throw new Error('Patch not found');
              }
              
              if (!state.user.pubkey || !state.maintainers.isMaintainer || needsClone) {
                alert('Only maintainers can apply patches');
                return;
              }
              
              // Check if repo is empty (no branches)
              if (state.git.branches.length === 0) {
                alert('Cannot apply patch to an empty repository. Please create a branch first.');
                return;
              }
              
              if (!confirm('Apply this patch to the repository? This will create a commit with the patch changes.')) {
                return;
              }
              
              const authorEmail = await getUserEmail();
              const authorName = await getUserName();
              
              // Use current branch, default branch, or first branch (repo is not empty at this point)
              const branch = state.git.currentBranch || state.git.defaultBranch || 
                (state.git.branches.length > 0 
                  ? (typeof state.git.branches[0] === 'string' ? state.git.branches[0] : state.git.branches[0].name)
                  : null);
              
              if (!branch) {
                alert('No branch available to apply patch to. Please create a branch first.');
                return;
              }
              
              const response = await fetch(`/api/repos/${state.npub}/${state.repo}/patches/${id}/apply`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...buildApiHeaders()
                },
                body: JSON.stringify({
                  message: `Apply patch ${id.slice(0, 8)}: ${patch.subject}`,
                  authorName,
                  authorEmail,
                  branch
                })
              });
              
              if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Failed to apply patch');
              }
              
              await loadPatches();
              alert('Patch applied successfully!');
            } catch (err) {
              state.error = err instanceof Error ? err.message : 'Failed to apply patch';
              console.error('Error applying patch:', err);
            } finally {
              applying[id] = false;
            }
          }}
          {applying}
          activeTab={state.ui.activeTab}
          {tabs}
          onTabChange={(tab: string) => {
            state.ui.activeTab = tab as typeof state.ui.activeTab;
            // Update URL query parameter without page reload
            const url = new URL($page.url);
            if (tab === 'docs') {
              url.searchParams.delete('tab');
            } else {
              url.searchParams.set('tab', tab);
            }
            goto(url.pathname + url.search, { replaceState: true, noScroll: true });
          }}
          onCreate={() => { state.openDialog = 'createPatch'; }}
          userPubkey={state.user.pubkey || null}
        />
      {/if}

      <!-- Discussions Tab -->
      {#if state.ui.activeTab === 'discussions'}
        <DiscussionsTab
          npub={state.npub}
          repo={state.repo}
          repoAnnouncement={repoAnnouncement}
          userPubkey={state.user.pubkey}
          activeTab={state.ui.activeTab}
          {tabs}
          onTabChange={(tab: string) => {
            state.ui.activeTab = tab as typeof state.ui.activeTab;
            // Update URL query parameter without page reload
            const url = new URL($page.url);
            if (tab === 'docs') {
              url.searchParams.delete('tab');
            } else {
              url.searchParams.set('tab', tab);
            }
            goto(url.pathname + url.search, { replaceState: true, noScroll: true });
          }}
        />
      {/if}

      <!-- Docs Tab - Always render as fallback if no other tab is active -->
      {#if state.ui.activeTab === 'docs' || (!['files', 'issues', 'prs', 'patches', 'discussions', 'history', 'tags', 'code-search'].includes(state.ui.activeTab))}
        <DocsTab
          npub={state.npub}
          repo={state.repo}
          currentBranch={state.git.currentBranch || null}
          relays={[...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS]}
          activeTab={state.ui.activeTab}
          {tabs}
          onTabChange={(tab: string) => {
            state.ui.activeTab = tab as typeof state.ui.activeTab;
            // Update URL query parameter without page reload
            const url = new URL($page.url);
            if (tab === 'docs') {
              url.searchParams.delete('tab');
            } else {
              url.searchParams.set('tab', tab);
            }
            goto(url.pathname + url.search, { replaceState: true, noScroll: true });
          }}
        />
      {/if}

      <!-- Files tab content is now handled by FilesTab component -->

        <!-- History tab content is now handled by HistoryTab component -->

        <!-- Tags content is now handled by TagsTab component -->


        {#if state.ui.activeTab === 'code-search'}
          <div class="code-search-content" class:hide-on-mobile={state.ui.showLeftPanelOnMobile && state.ui.activeTab === 'code-search'}>
            <div class="content-header-mobile">
              <button 
                onclick={() => state.ui.showLeftPanelOnMobile = !state.ui.showLeftPanelOnMobile} 
                class="mobile-toggle-button"
                title="Show list"
              >
                <img src="/icons/arrow-right.svg" alt="Show list" class="icon-inline mobile-toggle-left" />
              </button>
            </div>
            {#if state.files.list.length === 0 && !state.loading.main}
              <div class="empty-state">
                <p>This repo is empty and contains no files.</p>
              </div>
            {:else}
              <div class="code-search-form">
                <div class="search-input-group">
                  <input 
                    type="text" 
                    bind:value={state.codeSearch.query}
                    placeholder="Search code..."
                    onkeydown={(e) => e.key === 'Enter' && performCodeSearch()}
                    class="code-search-input"
                  />
                  <select bind:value={state.codeSearch.scope} class="code-search-scope">
                    <option value="repo">This Repository</option>
                    <option value="all">All Repositories</option>
                  </select>
                  <button onclick={performCodeSearch} disabled={state.loading.codeSearch || !state.codeSearch.query.trim()} class="search-button">
                    {state.loading.codeSearch ? 'Searching...' : 'Search'}
                  </button>
                </div>
              </div>
              {#if state.loading.codeSearch}
                <div class="empty-state">
                  <p>Searching...</p>
                </div>
              {:else if state.codeSearch.results.length > 0}
                <div class="code-search-results">
                  <h3>Found {state.codeSearch.results.length} result{state.codeSearch.results.length !== 1 ? 's' : ''}</h3>
                  {#each state.codeSearch.results as result}
                    <div class="code-search-result-item">
                      <div class="result-header">
                        <span class="result-file">{result.file}</span>
                        <span class="result-line">Line {result.line}</span>
                        {#if state.codeSearch.scope === 'all' && 'repo' in result}
                          <span class="result-repo">{result.repo || state.npub}/{result.repo || state.repo}</span>
                        {/if}
                      </div>
                      <pre class="result-content">{result.content}</pre>
                    </div>
                  {/each}
                </div>
              {:else if state.codeSearch.query.trim() && !state.loading.codeSearch}
                <div class="empty-state">
                  {#if state.error}
                    <p class="state.error-message">Error: {state.error}</p>
                  {:else}
                    <p>No results found</p>
                  {/if}
                </div>
              {/if}
            {/if}
          </div>
        {/if}

        <!-- Issues tab content is now handled by IssuesTab component -->

        <!-- PRs tab content is now handled by PRsTab component -->

        <!-- Patches tab content is now handled by PatchesTab component -->


        <!-- Docs tab content is now handled by DocsTab component -->
    </div>
  </main>

  <!-- Dialogs -->
  <CreateFileDialog
    open={state.openDialog === 'createFile' && !!state.user.pubkey && state.maintainers.isMaintainer}
    {state}
    {needsClone}
    {cloneTooltip}
    onCreate={createFile}
    onClose={() => state.openDialog = null}
  />

  <CreateBranchDialog
    open={state.openDialog === 'createBranch' && !!state.user.pubkey && state.maintainers.isMaintainer}
    {state}
    {needsClone}
    {cloneTooltip}
    onCreate={createBranch}
    onClose={() => state.openDialog = null}
  />

  <CreateTagDialog
    open={state.openDialog === 'createTag' && !!state.user.pubkey && state.maintainers.isMaintainer}
    {state}
    {needsClone}
    {cloneTooltip}
    onCreate={createTag}
    onClose={() => state.openDialog = null}
  />

  <CreateReleaseDialog
    open={state.openDialog === 'createRelease' && !!state.user.pubkey && (state.maintainers.isMaintainer || state.user.pubkeyHex === repoOwnerPubkeyDerived) && !!state.clone.isCloned}
    {state}
    onCreate={createRelease}
    onClose={() => state.openDialog = null}
  />

  <CreateIssueDialog
    open={state.openDialog === 'createIssue' && !!state.user.pubkey}
    {state}
    onCreate={createIssue}
    onClose={() => state.openDialog = null}
  />

  <CreateThreadDialog
    open={state.openDialog === 'createThread' && !!state.user.pubkey}
    {state}
    onCreate={createDiscussionThread}
    onClose={() => state.openDialog = null}
  />

  <ReplyDialog
    open={state.openDialog === 'reply' && !!state.user.pubkey && (!!state.discussion.replyingToThread || !!state.discussion.replyingToComment)}
    {state}
    onCreate={createThreadReply}
    onClose={() => state.openDialog = null}
  />

  <CreatePRDialog
    open={state.openDialog === 'createPR' && !!state.user.pubkey}
    {state}
    onCreate={createPR}
    onClose={() => state.openDialog = null}
  />

  <CreatePatchDialog
    open={state.openDialog === 'createPatch' && !!state.user.pubkey}
    {state}
    onCreate={createPatch}
    onClose={() => state.openDialog = null}
  />

  <PatchHighlightDialog
    open={state.openDialog === 'patchHighlight'}
    {state}
    onCreate={createPatchHighlight}
    onClose={() => state.openDialog = null}
  />

  <PatchCommentDialog
    open={state.openDialog === 'patchComment'}
    {state}
    onCreate={createPatchComment}
    onClose={() => state.openDialog = null}
  />

  <CommitDialog
    open={state.openDialog === 'commit' && !!state.user.pubkey && state.maintainers.isMaintainer}
    {state}
    {needsClone}
    {cloneTooltip}
    onCommit={saveFile}
    onClose={() => state.openDialog = null}
  />

  <VerificationDialog
    open={state.openDialog === 'verification' && !!state.verification.fileContent}
    {state}
    onCopy={copyVerificationToClipboard}
    onDownload={downloadVerificationFile}
    onClose={() => state.openDialog = null}
  />

  <CloneUrlVerificationDialog
    open={state.openDialog === 'cloneUrlVerification'}
    {state}
    onVerify={verifyCloneUrl}
    onClose={() => state.openDialog = null}
  />
</div>

<style>
  /* Word wrap styles - ensure they apply with highest specificity */
  :global(.read-only-editor.word-wrap) {
    overflow-x: hidden !important;
  }

  :global(.read-only-editor.word-wrap pre) {
    white-space: pre-wrap !important;
    word-wrap: break-word !important;
    overflow-wrap: break-word !important;
    overflow-x: hidden !important;
    overflow-y: visible !important;
    max-width: 100% !important;
  }

  :global(.read-only-editor.word-wrap pre code),
  :global(.read-only-editor.word-wrap pre code.hljs),
  :global(.read-only-editor.word-wrap code.hljs),
  :global(.read-only-editor.word-wrap .hljs) {
    white-space: pre-wrap !important;
    word-wrap: break-word !important;
    overflow-wrap: break-word !important;
    overflow-x: hidden !important;
    overflow-y: visible !important;
    display: block !important;
    max-width: 100% !important;
  }

  :global(.read-only-editor.word-wrap pre code.hljs *),
  :global(.read-only-editor.word-wrap pre code.hljs span),
  :global(.read-only-editor.word-wrap code.hljs *),
  :global(.read-only-editor.word-wrap .hljs *) {
    white-space: pre-wrap !important;
  }

  /* Image preview styling */
  :global(.image-preview) {
    display: flex;
    justify-content: center;
    align-items: center;
    padding: 1rem;
    background: var(--bg-secondary);
    border-radius: 4px;
    min-height: 200px;
  }

  :global(.file-image) {
    max-width: 100%;
    max-height: 80vh;
    height: auto;
    object-fit: contain;
    border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  /* Tag-related styles have been moved to TagsTab.svelte component */
</style>
