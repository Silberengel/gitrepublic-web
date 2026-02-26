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
  import { fetchUserEmail, fetchUserName } from '$lib/utils/user-profile.js';
  import { createRepoState, type RepoState } from './stores/repo-state.js';

  // Consolidated state - all state variables in one object
  let state = $state(createRepoState());
  
  // Local variables for component-specific state
  let announcementEventId: string | null = null;
  let applying: Record<string, boolean> = {};
  
  // Update pageData from $page when available (client-side)
  $effect(() => {
    if (typeof window === 'undefined' || !state.isMounted) return;
    try {
      const data = $page.data as typeof state.pageData;
      if (data && state.isMounted) {
        state.pageData = data || {};
      }
    } catch (err) {
      // Ignore SSR errors and errors during destruction
      if (state.isMounted) {
        console.warn('Failed to update pageData:', err);
      }
    }
  });

  // Update params from $page when available (client-side)
  $effect(() => {
    if (typeof window === 'undefined' || !state.isMounted) return;
    try {
      const params = $page.params as { npub?: string; repo?: string };
      if (params && state.isMounted) {
        if (params.npub && params.npub !== state.npub) state.npub = params.npub;
        if (params.repo && params.repo !== state.repo) state.repo = params.repo;
      }
    } catch {
      // If $page.params fails, try to parse from URL path
      if (!state.isMounted) return;
      try {
        if (typeof window !== 'undefined') {
          const pathParts = window.location.pathname.split('/').filter(Boolean);
          if (pathParts[0] === 'repos' && pathParts[1] && pathParts[2] && state.isMounted) {
            state.npub = pathParts[1];
            state.repo = pathParts[2];
          }
        }
      } catch {
        // Ignore errors - params will be set eventually
      }
    }
  });

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
  
  // Auto-save
  let autoSaveInterval: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    // Guard against SSR and component destruction
    if (typeof window === 'undefined' || !state.isMounted) return;
    try {
      const data = $page.data as typeof state.pageData;
      if (!data || !state.isMounted) return;
      
      const currentRepoKey = `${state.npub}/${state.repo}`;
      
      // Reset flags if repo changed
      if (currentRepoKey !== state.maintainers.lastRepoKey && state.isMounted) {
        state.maintainers.loaded = false;
        state.maintainers.effectRan = false;
        state.maintainers.lastRepoKey = currentRepoKey;
      }
      
      // Only load if:
      // 1. We have page data
      // 2. Effect hasn't run yet for this repo
      // 3. We're not currently state.loading.main
      // 4. Component is still mounted
      if (state.isMounted && 
          (repoOwnerPubkeyDerived || (repoMaintainers && repoMaintainers.length > 0)) && 
          !state.maintainers.effectRan && 
          !state.loading.maintainers) {
        state.maintainers.effectRan = true; // Mark as ran to prevent re-running
        state.maintainers.loaded = true; // Set flag before state.loading.main to prevent concurrent calls
        loadAllMaintainers().catch(err => {
          if (!state.isMounted) return;
          state.maintainers.loaded = false; // Reset on state.error so we can retry
          state.maintainers.effectRan = false; // Allow retry
          console.warn('Failed to load maintainers:', err);
        });
      }
    } catch (err) {
      // Ignore SSR errors and errors during destruction
      if (state.isMounted) {
        console.warn('Maintainers effect error:', err);
      }
    }
  });

  // Watch for auto-save setting changes
  $effect(() => {
    if (!state.isMounted) return;
    // Check auto-save setting and update interval (async, but don't await)
    settingsStore.getSettings().then(settings => {
      if (!state.isMounted) return;
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
      if (state.isMounted) {
        console.warn('Failed to check auto-save setting:', err);
      }
    });
  });

  // Sync with userStore
  $effect(() => {
    if (!state.isMounted) return;
    try {
      const currentUser = $userStore;
      if (!currentUser || !state.isMounted) return;
      
      const wasLoggedIn = state.user.pubkey !== null || state.user.pubkeyHex !== null;
      
      if (currentUser.userPubkey && currentUser.userPubkeyHex && state.isMounted) {
        const wasDifferent = state.user.pubkey !== currentUser.userPubkey || state.user.pubkeyHex !== currentUser.userPubkeyHex;
        state.user.pubkey = currentUser.userPubkey;
        state.user.pubkeyHex = currentUser.userPubkeyHex;
        
        // Reload data when user logs in or pubkey changes
        if (wasDifferent && state.isMounted) {
          // Reset state.repoNotFound flag when user logs in, so we can retry state.loading.main
          state.loading.repoNotFound = false;
          // Clear cached email and name when user changes
          cachedUserEmail = null;
          cachedUserName = null;
          
          if (!state.isMounted) return;
          checkMaintainerStatus().catch(err => {
            if (state.isMounted) console.warn('Failed to reload maintainer status after login:', err);
          });
          loadBookmarkStatus().catch(err => {
            if (state.isMounted) console.warn('Failed to reload bookmark status after login:', err);
          });
          // Reset flags to allow reload
          state.maintainers.loaded = false;
          state.maintainers.effectRan = false;
          state.maintainers.lastRepoKey = null;
          loadAllMaintainers().catch(err => {
            if (state.isMounted) console.warn('Failed to reload maintainers after login:', err);
          });
          // Recheck clone status after login (force refresh) - delay slightly to ensure auth headers are ready
          setTimeout(() => {
            if (state.isMounted) {
              checkCloneStatus(true).catch(err => {
                if (state.isMounted) console.warn('Failed to recheck clone status after login:', err);
              });
            }
          }, 100);
          // Reload all repository data with the new user context
          if (!state.loading.main && state.isMounted) {
            loadBranches().catch(err => {
              if (state.isMounted) console.warn('Failed to reload state.git.branches after login:', err);
            });
            loadFiles().catch(err => {
              if (state.isMounted) console.warn('Failed to reload files after login:', err);
            });
            loadReadme().catch(err => {
              if (state.isMounted) console.warn('Failed to reload readme after login:', err);
            });
            loadTags().catch(err => {
              if (state.isMounted) console.warn('Failed to reload state.git.tags after login:', err);
            });
            // Reload state.discussions when user logs in (needs user context for relay selection)
            loadDiscussions().catch(err => {
              if (state.isMounted) console.warn('Failed to reload state.discussions after login:', err);
            });
          }
        }
      } else if (state.isMounted) {
        state.user.pubkey = null;
        state.user.pubkeyHex = null;
        // Clear cached email and name when user logs out
        cachedUserEmail = null;
        cachedUserName = null;
        
        // Reload data when user logs out to hide private content
        if (wasLoggedIn && state.isMounted) {
          checkMaintainerStatus().catch(err => {
            if (state.isMounted) console.warn('Failed to reload maintainer status after logout:', err);
          });
          loadBookmarkStatus().catch(err => {
            if (state.isMounted) console.warn('Failed to reload bookmark status after logout:', err);
          });
          // Reset flags to allow reload
          state.maintainers.loaded = false;
          state.maintainers.effectRan = false;
          state.maintainers.lastRepoKey = null;
          loadAllMaintainers().catch(err => {
            if (state.isMounted) console.warn('Failed to reload maintainers after logout:', err);
          });
          // If repo is private and user logged out, reload to trigger access check
          if (!state.loading.main && state.ui.activeTab === 'files' && state.isMounted) {
            loadFiles().catch(err => {
              if (state.isMounted) console.warn('Failed to reload files after logout:', err);
            });
          }
        }
      }
    } catch (err) {
      // Ignore errors during destruction
      if (state.isMounted) {
        console.warn('User store sync error:', err);
      }
    }
  });

  // Function to toggle word wrap and refresh highlighting
  async function toggleWordWrap() {
    state.ui.wordWrap = !state.ui.wordWrap;
    console.log('Word wrap toggled:', state.ui.wordWrap);
    // Force DOM update by accessing the element
    await new Promise(resolve => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
    // Re-apply syntax highlighting to refresh the display
    if (state.files.currentFile && state.files.content) {
      const ext = state.files.currentFile.split('.').pop() || '';
      await applySyntaxHighlighting(state.files.content, ext);
    }
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
    if (state.clone.copyingUrl) return;
    
    state.clone.copyingUrl = true;
    try {
      // Use the current page URL to get the correct host and port
      // This ensures we use the same domain/port the user is currently viewing
      // Guard against SSR - $page store can only be accessed in component context
      if (typeof window === 'undefined') return;
      // Guard against SSR - $page.url might not be available
      if (typeof window === 'undefined' || !$page?.url) {
        return '';
      }
      const currentUrl = $page.url;
      const host = currentUrl.host; // Includes port if present (e.g., "localhost:5173")
      const protocol = currentUrl.protocol.slice(0, -1); // Remove trailing ":"
      
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
  

  
  // Tabs menu - defined after state.issues and state.prs
  // Order: Files, Issues, PRs, Patches, Discussion, History, Tags, Code Search, Docs
  // Show tabs that require cloned repo when repo is cloned OR API fallback is available
  const tabs = $derived.by(() => {
    const allTabs = [
      { id: 'files', label: 'Files', icon: '/icons/file-text.svg', requiresClone: true },
      { id: 'state.issues', label: 'Issues', icon: '/icons/alert-circle.svg', requiresClone: false },
      { id: 'state.prs', label: 'Pull Requests', icon: '/icons/git-pull-request.svg', requiresClone: false },
      { id: 'state.patches', label: 'Patches', icon: '/icons/clipboard-list.svg', requiresClone: false },
      { id: 'state.discussions', label: 'Discussions', icon: '/icons/message-circle.svg', requiresClone: false },
      { id: 'history', label: 'Commit History', icon: '/icons/git-commit.svg', requiresClone: true },
      { id: 'state.git.tags', label: 'Tags', icon: '/icons/tag.svg', requiresClone: true },
      { id: 'code-search', label: 'Code Search', icon: '/icons/search.svg', requiresClone: true },
      { id: 'docs', label: 'Docs', icon: '/icons/book.svg', requiresClone: false }
    ];
    
    // Show all tabs if repo is cloned OR API fallback is available
    // Otherwise, only show tabs that don't require state.clone.cloning
    if (state.clone.isCloned === false && !canUseApiFallback) {
      return allTabs.filter(tab => !tab.requiresClone).map(({ requiresClone, ...tab }) => tab);
    }
    
    // Return all tabs when repo is cloned, API fallback is available, or status is unknown (remove requiresClone property)
    return allTabs.map(({ requiresClone, ...tab }) => tab);
  });
  
  // Redirect to a valid tab if current tab requires state.clone.cloning but repo isn't cloned and API fallback isn't available
  $effect(() => {
    if (!state.isMounted) return;
    if (state.clone.isCloned === false && !canUseApiFallback && tabs.length > 0) {
      const currentTab = tabs.find(t => t.id === state.ui.activeTab);
      if (!currentTab && state.isMounted) {
        // Current tab requires state.clone.cloning, switch to first available tab
        state.ui.activeTab = tabs[0].id as typeof state.ui.activeTab;
      }
    }
  });

  const highlightsService = new HighlightsService(DEFAULT_NOSTR_RELAYS);

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

  // Get event from nostr: link
  function getEventFromNostrLink(link: string): NostrEvent | undefined {
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

  // Get pubkey from nostr: npub/profile link
  function getPubkeyFromNostrLink(link: string): string | undefined {
    return state.discussion.nostrLinkProfiles.get(link);
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
    const branch = state.git.currentBranch || state.git.defaultBranch || 'main';
    
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
      const apiUrl = `/api/repos/${state.npub}/${state.repo}/raw?path=${encodeURIComponent(imagePath)}&ref=${encodeURIComponent(branch)}`;
      
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
  let readmeAutoLoadTimeout: ReturnType<typeof setTimeout> | null = null;

  // Load clone URL reachability status
  async function loadCloneUrlReachability(forceRefresh: boolean = false) {
    if (!repoCloneUrls || repoCloneUrls.length === 0) {
      return;
    }
    
    if (state.loading.reachability) return;
    
    state.loading.reachability = true;
    try {
      const response = await fetch(
        `/api/repos/${state.npub}/${state.repo}/clone-urls/reachability${forceRefresh ? '?forceRefresh=true' : ''}`,
        {
          headers: buildApiHeaders()
        }
      );
      
      if (response.ok) {
        const data = await response.json();
          const newMap = new Map<string, { reachable: boolean; error?: string; checkedAt: number; serverType: 'git' | 'grasp' | 'unknown' }>();
        
        if (data.results && Array.isArray(data.results)) {
          for (const result of data.results) {
            newMap.set(result.url, {
              reachable: result.reachable,
                error: result.error,
              checkedAt: result.checkedAt,
              serverType: result.serverType || 'unknown'
            });
          }
        }
        
        state.clone.reachability = newMap;
      }
    } catch (err) {
      console.warn('Failed to load clone URL reachability:', err);
    } finally {
      state.loading.reachability = false;
      state.clone.checkingReachability.clear();
    }
  }

  async function loadReadme() {
    if (state.loading.repoNotFound) return;
    state.loading.readme = true;
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/readme?ref=${state.git.currentBranch}`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        if (data.found) {
          state.preview.readme.content = data.content;
          state.preview.readme.path = data.path;
          state.preview.readme.isMarkdown = data.isMarkdown;
          
          // Reset preview mode for README
          state.preview.file.showPreview = true;
          state.preview.readme.html = '';
          
          // Render markdown or asciidoc if needed
          if (state.preview.readme.content) {
            const ext = state.preview.readme.path?.split('.').pop()?.toLowerCase() || '';
            if (state.preview.readme.isMarkdown || ext === 'md' || ext === 'markdown') {
              try {
                const MarkdownIt = (await import('markdown-it')).default;
                const hljsModule = await import('highlight.js');
                const hljs = hljsModule.default || hljsModule;
                
                const md = new MarkdownIt({
                  html: true, // Enable HTML state.git.tags in source
                  linkify: true, // Autoconvert URL-like text to links
                  typographer: true, // Enable some language-neutral replacement + quotes beautification
                  breaks: true, // Convert '\n' in paragraphs into <br>
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
                
                let rendered = md.render(state.preview.readme.content);
                // Rewrite image paths to point to repository API
                rendered = rewriteImagePaths(rendered, state.preview.readme.path);
                state.preview.readme.html = rendered;
                console.log('[README] Markdown rendered successfully, HTML length:', state.preview.readme.html.length);
              } catch (err) {
                console.error('[README] Error rendering markdown:', err);
                state.preview.readme.html = '';
              }
            } else if (ext === 'adoc' || ext === 'asciidoc') {
              try {
                const Asciidoctor = (await import('@asciidoctor/core')).default;
                const asciidoctor = Asciidoctor();
                const converted = asciidoctor.convert(state.preview.readme.content, {
                  safe: 'safe',
                  attributes: {
                    'source-highlighter': 'highlight.js'
                  }
                });
                let rendered = typeof converted === 'string' ? converted : String(converted);
                // Rewrite image paths to point to repository API
                rendered = rewriteImagePaths(rendered, state.preview.readme.path);
                state.preview.readme.html = rendered;
                state.preview.readme.isMarkdown = true; // Treat as markdown for display purposes
              } catch (err) {
                console.error('[README] Error rendering asciidoc:', err);
                state.preview.readme.html = '';
              }
            } else if (ext === 'html' || ext === 'htm') {
              // Rewrite image paths to point to repository API
              state.preview.readme.html = rewriteImagePaths(state.preview.readme.content || '', state.preview.readme.path);
              state.preview.readme.isMarkdown = true; // Treat as markdown for display purposes
            } else {
              state.preview.readme.html = '';
            }
          }
        }
      }
    } catch (err) {
      console.error('Error state.loading.main README:', err);
    } finally {
      state.loading.readme = false;
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

  // Check if file type supports preview mode
  function supportsPreview(ext: string): boolean {
    const previewExtensions = ['md', 'markdown', 'adoc', 'asciidoc', 'html', 'htm', 'csv'];
    return previewExtensions.includes(ext.toLowerCase());
  }

  // Check if a file is an image based on extension
  function isImageFileType(ext: string): boolean {
    const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'apng', 'avif'];
    return imageExtensions.includes(ext.toLowerCase());
  }

  // Render markdown, asciidoc, or HTML files as HTML
  async function renderFileAsHtml(content: string, ext: string) {
    try {
      const lowerExt = ext.toLowerCase();
      
      if (lowerExt === 'md' || lowerExt === 'markdown') {
        // Render markdown
        const MarkdownIt = (await import('markdown-it')).default;
        const hljsModule = await import('highlight.js');
        const hljs = hljsModule.default || hljsModule;
        
        const md = new MarkdownIt({
          html: true,
          linkify: true,
          typographer: true,
          breaks: true,
          highlight: function (str: string, lang: string): string {
            if (lang && hljs.getLanguage(lang)) {
              try {
                return hljs.highlight(str, { language: lang }).value;
              } catch (__) {}
            }
            try {
              return hljs.highlightAuto(str).value;
            } catch (__) {}
            return '';
          }
        });
        
        let rendered = md.render(content);
        // Rewrite image paths to point to repository API
        rendered = rewriteImagePaths(rendered, state.files.currentFile);
        state.preview.file.html = rendered;
      } else if (lowerExt === 'adoc' || lowerExt === 'asciidoc') {
        // Render asciidoc
        const Asciidoctor = (await import('@asciidoctor/core')).default;
        const asciidoctor = Asciidoctor();
        const converted = asciidoctor.convert(content, {
          safe: 'safe',
          attributes: {
            'source-highlighter': 'highlight.js'
          }
        });
        let rendered = typeof converted === 'string' ? converted : String(converted);
        // Rewrite image paths to point to repository API
        rendered = rewriteImagePaths(rendered, state.files.currentFile);
        state.preview.file.html = rendered;
      } else if (lowerExt === 'html' || lowerExt === 'htm') {
        // HTML files - rewrite image paths
        let rendered = content;
        rendered = rewriteImagePaths(rendered, state.files.currentFile);
        state.preview.file.html = rendered;
      } else if (lowerExt === 'csv') {
        // Parse CSV and render as HTML table
        state.preview.file.html = renderCsvAsTable(content);
      }
    } catch (err) {
      console.error('Error rendering file as HTML:', err);
      state.preview.file.html = '';
    }
  }

  // Parse CSV content and render as HTML table
  function renderCsvAsTable(csvContent: string): string {
    try {
      // Parse CSV - handle quoted fields and escaped quotes
      const lines = csvContent.split(/\r?\n/).filter(line => line.trim() !== '');
      if (lines.length === 0) {
        return '<div class="csv-empty"><p>Empty CSV file</p></div>';
      }

      const rows: string[][] = [];
      
      for (const line of lines) {
        const row: string[] = [];
        let currentField = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
          const char = line[i];
          const nextChar = line[i + 1];
          
          if (char === '"') {
            if (inQuotes && nextChar === '"') {
              // Escaped quote
              currentField += '"';
              i++; // Skip next quote
            } else {
              // Toggle quote state
              inQuotes = !inQuotes;
            }
          } else if (char === ',' && !inQuotes) {
            // Field separator
            row.push(currentField);
            currentField = '';
          } else {
            currentField += char;
          }
        }
        
        // Add the last field
        row.push(currentField);
        rows.push(row);
      }

      if (rows.length === 0) {
        return '<div class="csv-empty"><p>No data in CSV file</p></div>';
      }

      // Find the maximum number of columns to ensure consistent table structure
      const maxColumns = Math.max(...rows.map(row => row.length));

      // Determine if first row should be treated as header (if it has more than 1 row)
      const hasHeader = rows.length > 1;
      const headerRow = hasHeader ? rows[0] : null;
      const dataRows = hasHeader ? rows.slice(1) : rows;

      // Build HTML table
      let html = '<div class="csv-table-wrapper"><table class="csv-table">';
      
      // Add header row if we have one
      if (hasHeader && headerRow) {
        html += '<thead><tr>';
        for (let i = 0; i < maxColumns; i++) {
          const cell = headerRow[i] || '';
          html += `<th>${escapeHtml(cell)}</th>`;
        }
        html += '</tr></thead>';
      }
      
      // Add data rows
      html += '<tbody>';
      for (const row of dataRows) {
        html += '<tr>';
        for (let i = 0; i < maxColumns; i++) {
          const cell = row[i] || '';
          html += `<td>${escapeHtml(cell)}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody></table></div>';

      return html;
    } catch (err) {
      console.error('Error parsing CSV:', err);
      return `<div class="csv-state.error"><p>Error parsing CSV: ${escapeHtml(err instanceof Error ? err.message : String(err))}</p></div>`;
    }
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
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
        state.preview.file.highlightedContent = `<pre><code class="hljs">${hljs.highlight(content, { language: 'plaintext' }).value}</code></pre>`;
      } else if (hljs.getLanguage(lang)) {
        state.preview.file.highlightedContent = `<pre><code class="hljs language-${lang}">${hljs.highlight(content, { language: lang }).value}</code></pre>`;
      } else {
        // Fallback to auto-detection
        state.preview.file.highlightedContent = `<pre><code class="hljs">${hljs.highlightAuto(content).value}</code></pre>`;
      }
    } catch (err) {
      console.error('Error applying syntax highlighting:', err);
      // Fallback to plain text
      state.preview.file.highlightedContent = `<pre><code class="hljs">${content}</code></pre>`;
    }
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
    if (state.clone.checking) return;
    if (!force && state.clone.isCloned !== null) {
      console.log(`[Clone Status] Skipping check - already checked: ${state.clone.isCloned}, force: ${force}`);
      return;
    }
    
    state.clone.checking = true;
    try {
      // Check if repo exists locally by trying to fetch state.git.branches
      // Use skipApiFallback parameter to ensure we only check local repo, not API fallback
      // 404 = repo not cloned, 403 = repo exists but access denied (cloned), 200 = cloned and accessible
      const url = `/api/repos/${state.npub}/${state.repo}/branches?skipApiFallback=true`;
      console.log(`[Clone Status] Checking clone status for ${state.npub}/${state.repo}...`);
      const response = await fetch(url, {
        headers: buildApiHeaders()
      });
      // If response is 403, repo exists (cloned) but user doesn't have access
      // If response is 404, repo doesn't exist (not cloned)
      // If response is 200, repo exists and is accessible (cloned)
      const wasCloned = response.status !== 404;
      state.clone.isCloned = wasCloned;
      
      // If repo is not cloned, check if API fallback is available
      if (!wasCloned) {
        // Try to detect API fallback by checking if we have clone URLs
        if (repoCloneUrls && repoCloneUrls.length > 0) {
          // We have clone URLs, so API fallback might work - will be detected when loadBranches() runs
          state.clone.apiFallbackAvailable = null; // Will be set to true if a subsequent request succeeds
        } else {
          state.clone.apiFallbackAvailable = false;
        }
      } else {
        // Repo is cloned, API fallback not needed
        state.clone.apiFallbackAvailable = false;
      }
      
      console.log(`[Clone Status] Repo ${wasCloned ? 'is cloned' : 'is not cloned'} (status: ${response.status}), API fallback: ${state.clone.apiFallbackAvailable}`);
    } catch (err) {
      // On state.error, assume not cloned
      console.warn('[Clone Status] Error checking clone status:', err);
      state.clone.isCloned = false;
      state.clone.apiFallbackAvailable = false;
    } finally {
      state.clone.checking = false;
    }
  }

  async function cloneRepository() {
    if (state.clone.cloning) return;
    
    state.clone.cloning = true;
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/clone`, {
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
        // Reset API fallback status since repo is now cloned
        state.clone.apiFallbackAvailable = false;
        // Reload data to use the cloned repo instead of API
        await Promise.all([
          loadBranches(),
          loadFiles(state.files.currentPath),
          loadReadme(),
          loadTags(),
          loadCommitHistory()
        ]);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to clone repository';
      alert(`Error: ${errorMessage}`);
      console.error('Error state.clone.cloning repository:', err);
    } finally {
      state.clone.cloning = false;
    }
  }

  async function forkRepository() {
    if (!state.user.pubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    state.fork.forking = true;
    state.error = null;

    try {
      // Security: Truncate npub in logs
      const truncatedNpub = state.npub.length > 16 ? `${state.npub.slice(0, 12)}...` : state.npub;
      console.log(`[Fork UI] Starting fork of ${truncatedNpub}/${state.repo}...`);
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/fork`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({ userPubkey: state.user.pubkey })
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
        
        alert(`${message}\n\nRedirecting to your fork...`);
        goto(`/repos/${data.fork.npub}/${data.fork.repo}`);
      } else {
        const errorMessage = data.state.error || 'Failed to fork repository';
        const errorDetails = data.details ? `\n\nDetails: ${data.details}` : '';
        const fullError = `${errorMessage}${errorDetails}`;
        
        console.error(`[Fork UI] ✗ Fork failed: ${errorMessage}`);
        if (data.details) {
          console.error(`[Fork UI] Details: ${data.details}`);
        }
        if (data.eventName) {
          console.error(`[Fork UI] Failed event: ${data.eventName}`);
        }
        
        state.error = fullError;
        alert(`Fork failed!\n\n${fullError}`);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to fork repository';
      console.error(`[Fork UI] ✗ Unexpected error: ${errorMessage}`, err);
      state.error = errorMessage;
      alert(`Fork failed!\n\n${errorMessage}`);
    } finally {
      state.fork.forking = false;
    }
  }

  async function loadDiscussions() {
    if (state.repoNotFound) return;
    state.loading.discussions = true;
    state.error = null;
    try {
      const decoded = nip19.decode(state.npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      // Fetch repo announcement to get project-relay tags and announcement ID
      const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const events = await client.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkeyDerived],
          '#d': [state.repo],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        state.discussions = [];
        return;
      }

      const announcement = events[0];
      const chatRelays = announcement.tags
        .filter(t => t[0] === 'project-relay')
        .flatMap(t => t.slice(1))
        .filter(url => url && typeof url === 'string') as string[];

      // Get default relays
      const { getGitUrl } = await import('$lib/config.js');
      const { DiscussionsService } = await import('$lib/services/nostr/discussions-service.js');
      
      // Get user's relays if available
      let userRelays: string[] = [];
      const currentUserPubkey = $userStore.userPubkey || state.user.pubkey;
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
      console.log('[Discussions] Project relays from announcement:', chatRelays);

      const discussionsService = new DiscussionsService(allRelays);
      const discussionEntries = await discussionsService.getDiscussions(
        repoOwnerPubkey,
        state.repo,
        announcement.id,
        announcement.pubkey,
        allRelays, // Use all relays for threads
        allRelays  // Use all relays for comments too
      );
      
      console.log('[Discussions] Found', discussionEntries.length, 'discussion entries');

      state.discussions = discussionEntries.map(entry => ({
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

      // Fetch full events for state.discussions and comments to get state.git.tags for blurbs
      await loadDiscussionEvents(state.discussions);
      
      // Fetch nostr: links from discussion content
      for (const discussion of state.discussions) {
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
      state.error = err instanceof Error ? err.message : 'Failed to load state.discussions';
      console.error('Error state.loading.main state.discussions:', err);
    } finally {
      state.loading.discussions = false;
    }
  }


  async function createDiscussionThread() {
    if (!state.user.pubkey || !state.user.pubkeyHex) {
      state.error = 'You must be logged in to create a discussion thread';
      return;
    }

    if (!state.forms.discussion.threadTitle.trim()) {
      state.error = 'Thread title is required';
      return;
    }

    state.creating.thread = true;
    state.error = null;

    try {
      const decoded = nip19.decode(state.npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      // Get repo announcement to get the repo address
      const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const events = await client.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkeyDerived],
          '#d': [state.repo],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        throw new Error('Repository announcement not found');
      }

      const announcement = events[0];
      state.metadata.address = `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${state.repo}`;

      // Get project relays from announcement, or use default relays
      const chatRelays = announcement.tags
        .filter(t => t[0] === 'project-relay')
        .flatMap(t => t.slice(1))
        .filter(url => url && typeof url === 'string') as string[];

      // Combine all available relays
      let allRelays = [...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS, ...chatRelays];
      if (state.user.pubkey) {
        try {
          const { outbox } = await getUserRelays(state.user.pubkey, client);
          allRelays = [...allRelays, ...outbox];
        } catch (err) {
          console.warn('Failed to get user relays:', err);
        }
      }
      allRelays = [...new Set(allRelays)]; // Deduplicate

      // Create kind 11 thread event
      const threadEventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.THREAD,
        pubkey: state.user.pubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['a', state.metadata.address],
          ['title', state.forms.discussion.threadTitle.trim()],
          ['t', 'repo']
        ],
        content: state.forms.discussion.threadContent.trim() || ''
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
      state.forms.discussion.threadTitle = '';
      state.forms.discussion.threadContent = '';
      state.openDialog = null;

      // Reload discussions
      await loadDiscussions();
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to create discussion thread';
      console.error('Error creating discussion thread:', err);
    } finally {
      state.creating.thread = false;
    }
  }

  async function createThreadReply() {
    if (!state.user.pubkey || !state.user.pubkeyHex) {
      state.error = 'You must be logged in to reply';
      return;
    }

    if (!state.forms.discussion.replyContent.trim()) {
      state.error = 'Reply content is required';
      return;
    }

    if (!state.discussion.replyingToThread && !state.discussion.replyingToComment) {
      state.error = 'Must reply to either a thread or a comment';
      return;
    }

    state.creating.reply = true;
    state.error = null;

    try {
      const decoded = nip19.decode(state.npub);
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
          authors: [repoOwnerPubkeyDerived],
          '#d': [state.repo],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        throw new Error('Repository announcement not found');
      }

      const announcement = events[0];
      
      // Get project relays from announcement, or use default relays
      const chatRelays = announcement.tags
        .filter(t => t[0] === 'project-relay')
        .flatMap(t => t.slice(1))
        .filter(url => url && typeof url === 'string') as string[];

      // Combine all available relays
      let allRelays = [...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS, ...chatRelays];
      if (state.user.pubkey) {
        try {
          const { outbox } = await getUserRelays(state.user.pubkey, client);
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

      if (state.discussion.replyingToComment) {
        // Replying to a comment - use the comment object we already have
        const comment = state.discussion.replyingToComment;
        
        // Determine root: if we have a thread, use it as root; otherwise use announcement
        if (state.discussion.replyingToThread) {
          rootEventId = state.discussion.replyingToThread.id;
          rootKind = state.discussion.replyingToThread.kind || KIND.THREAD;
          rootPubkey = state.discussion.replyingToThread.pubkey || state.discussion.replyingToThread.author;
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
      } else if (state.discussion.replyingToThread) {
        // Replying directly to a thread - use the thread object we already have
        rootEventId = state.discussion.replyingToThread.id;
        rootKind = state.discussion.replyingToThread.kind || KIND.THREAD;
        rootPubkey = state.discussion.replyingToThread.pubkey || state.discussion.replyingToThread.author;
        parentEventId = state.discussion.replyingToThread.id;
        parentKind = state.discussion.replyingToThread.kind || KIND.THREAD;
        parentPubkey = state.discussion.replyingToThread.pubkey || state.discussion.replyingToThread.author;
      } else {
        throw new Error('Must specify thread or comment to reply to');
      }

      // Create kind 1111 comment event
      const commentEventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.COMMENT,
          pubkey: state.user.pubkeyHex,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['e', parentEventId, '', 'reply'], // Parent event
            ['k', parentKind.toString()], // Parent kind
          ['p', parentPubkey], // Parent pubkey
          ['E', rootEventId], // Root event
          ['K', rootKind.toString()], // Root kind
          ['P', rootPubkey] // Root pubkey
        ],
        content: state.forms.discussion.replyContent.trim()
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
      const threadIdToExpand = state.discussion.replyingToThread?.id;

      // Clear form and close dialog
      state.forms.discussion.replyContent = '';
      state.openDialog = null;
      state.discussion.replyingToThread = null;
      state.discussion.replyingToComment = null;

      // Reload state.discussions to show the new reply
      await loadDiscussions();
      
      // Expand the thread if we were replying to a thread
      if (threadIdToExpand) {
        state.ui.expandedThreads.add(threadIdToExpand);
        state.ui.expandedThreads = new Set(state.ui.expandedThreads); // Trigger reactivity
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to create reply';
      console.error('Error creating reply:', err);
    } finally {
      state.creating.reply = false;
    }
  }

  function toggleThread(threadId: string) {
    if (state.ui.expandedThreads.has(threadId)) {
      state.ui.expandedThreads.delete(threadId);
    } else {
      state.ui.expandedThreads.add(threadId);
    }
    // Trigger reactivity
    state.ui.expandedThreads = new Set(state.ui.expandedThreads);
  }

  async function loadDocumentation() {
    if (state.loading.docs) return;
    // Reset documentation when reloading
    state.docs.html = null;
    state.docs.content = null;
    state.docs.kind = null;
    
    state.loading.docs = true;
    try {
      // Guard against SSR - $page store can only be accessed in component context
      if (typeof window === 'undefined') return;
      // Check if repo is private and user has access
      const data = $page.data as typeof state.pageData;
      if (repoIsPrivate) {
        // Check access via API
        const accessResponse = await fetch(`/api/repos/${state.npub}/${state.repo}/access`, {
          headers: buildApiHeaders()
        });
        if (accessResponse.ok) {
          const accessData = await accessResponse.json();
          if (!accessData.canView) {
            // User doesn't have access, don't load documentation
            state.loading.docs = false;
            return;
          }
        } else {
          // Access check failed, don't load documentation
          state.loading.docs = false;
          return;
        }
      }
      
      const decoded = nip19.decode(state.npub);
      if (decoded.type === 'npub') {
        const repoOwnerPubkey = decoded.data as string;
        const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
        
        // First, get the repo announcement to find the documentation tag
        const announcementEvents = await client.fetchEvents([
          {
            kinds: [KIND.REPO_ANNOUNCEMENT],
            authors: [repoOwnerPubkeyDerived],
            '#d': [state.repo],
            limit: 1
          }
        ]);

        if (announcementEvents.length === 0) {
          state.loading.docs = false;
          return;
        }

        const announcement = announcementEvents[0];
        
        // Look for documentation tag in the announcement
        const documentationTag = announcement.tags.find(t => t[0] === 'documentation');
        
        state.docs.kind = null;
        
        if (documentationTag && documentationTag[1]) {
          // Parse the a-tag format: kind:pubkey:identifier
          const docAddress = documentationTag[1];
          const parts = docAddress.split(':');
          
          if (parts.length >= 3) {
            state.docs.kind = parseInt(parts[0]);
            const docPubkey = parts[1];
            const docIdentifier = parts.slice(2).join(':'); // In case identifier contains ':'
            
            // Fetch the documentation event
            const docEvents = await client.fetchEvents([
              {
                kinds: [state.docs.kind],
                authors: [docPubkey],
                '#d': [docIdentifier],
                limit: 1
              }
            ]);
            
            if (docEvents.length > 0) {
              state.docs.content = docEvents[0].content || null;
            } else {
              console.warn('Documentation event not found:', docAddress);
              state.docs.content = null;
            }
          } else {
            console.warn('Invalid documentation tag format:', docAddress);
            state.docs.content = null;
          }
        } else {
          // No documentation tag, try to use announcement content as fallback
          state.docs.content = announcement.content || null;
          // Announcement is kind 30617, not a doc kind, so keep state.docs.kind as null
        }
        
        // Render content based on kind: AsciiDoc for 30041 or 30818, Markdown otherwise
        if (state.docs.content) {
          // Check if we should use AsciiDoc parser (kinds 30041 or 30818)
          const useAsciiDoc = state.docs.kind === 30041 || state.docs.kind === 30818;
          
          if (useAsciiDoc) {
            // Use AsciiDoc parser
            const Asciidoctor = (await import('@asciidoctor/core')).default;
            const asciidoctor = Asciidoctor();
            const converted = asciidoctor.convert(state.docs.content, {
              safe: 'safe',
              attributes: {
                'source-highlighter': 'highlight.js'
              }
            });
            // Convert to string if it's a Document object
            state.docs.html = typeof converted === 'string' ? converted : String(converted);
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
            
            state.docs.html = md.render(state.docs.content);
          }
        } else {
          // No content found, clear HTML
          state.docs.html = null;
        }
      }
    } catch (err) {
      console.error('Error state.loading.main documentation:', err);
      state.docs.html = null;
    } finally {
      state.loading.docs = false;
    }
  }

  async function loadRepoImages() {
    try {
      // Get images from page data (loaded from announcement)
      // Use $page.data directly to ensure we get the latest data
      // Guard against SSR - $page store can only be accessed in component context
      if (typeof window === 'undefined') return;
      const data = $page.data as typeof state.pageData;
      if (data.image) {
        state.metadata.image = data.image;
        console.log('[Repo Images] Loaded image from pageData:', state.metadata.image);
      }
      if (data.banner) {
        state.metadata.banner = data.banner;
        console.log('[Repo Images] Loaded banner from pageData:', state.metadata.banner);
      }

      // Also fetch from announcement directly as fallback (only if not private or user has access)
      if (!state.metadata.image && !state.metadata.banner) {
        // Guard against SSR - $page store can only be accessed in component context
        if (typeof window === 'undefined') return;
        const data = $page.data as typeof state.pageData;
        // Check access for private repos
        if (repoIsPrivate) {
          const headers: Record<string, string> = {};
          if (state.user.pubkey) {
            try {
              const decoded = nip19.decode(state.user.pubkey);
              if (decoded.type === 'npub') {
                headers['X-User-Pubkey'] = decoded.data as string;
              } else {
                headers['X-User-Pubkey'] = state.user.pubkey;
              }
            } catch {
              headers['X-User-Pubkey'] = state.user.pubkey;
            }
          }
          
          const accessResponse = await fetch(`/api/repos/${state.npub}/${state.repo}/access`, { headers });
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
        
        const decoded = nip19.decode(state.npub);
        if (decoded.type === 'npub') {
          const repoOwnerPubkey = decoded.data as string;
          const client = new NostrClient(DEFAULT_NOSTR_RELAYS);
          const events = await client.fetchEvents([
            {
              kinds: [30617], // REPO_ANNOUNCEMENT
              authors: [repoOwnerPubkeyDerived],
              '#d': [state.repo],
              limit: 1
            }
          ]);

          if (events.length > 0) {
            const announcement = events[0];
            const imageTag = announcement.tags.find((t: string[]) => t[0] === 'image');
            const bannerTag = announcement.tags.find((t: string[]) => t[0] === 'banner');
            
            if (imageTag?.[1]) {
              state.metadata.image = imageTag[1];
              console.log('[Repo Images] Loaded image from announcement:', state.metadata.image);
            }
            if (bannerTag?.[1]) {
              state.metadata.banner = bannerTag[1];
              console.log('[Repo Images] Loaded banner from announcement:', state.metadata.banner);
            }
          } else {
            console.log('[Repo Images] No announcement found');
          }
        }
      }
      
      if (!state.metadata.image && !state.metadata.banner) {
        console.log('[Repo Images] No images found in announcement');
      }
    } catch (err) {
      console.error('Error state.loading.main repo images:', err);
    }
  }

  // Reactively update images when pageData changes (only once, when data becomes available)
  $effect(() => {
    // Guard against SSR and component destruction
    if (typeof window === 'undefined' || !state.isMounted) return;
    try {
      const data = $page.data as typeof state.pageData;
      if (!data || !state.isMounted) return;
      // Only update if we have new data and don't already have the images set
      if (data.image && data.image !== state.metadata.image && state.isMounted) {
        state.metadata.image = data.image;
        console.log('[Repo Images] Updated image from pageData (reactive):', state.metadata.image);
      }
      if (data.banner && data.banner !== state.metadata.banner && state.isMounted) {
        state.metadata.banner = data.banner;
        console.log('[Repo Images] Updated banner from pageData (reactive):', state.metadata.banner);
      }
    } catch (err) {
      // Ignore errors during destruction
      if (state.isMounted) {
        console.warn('Image update effect error:', err);
      }
    }
  });

  onMount(async () => {
    // Initialize bookmarks service
    bookmarksService = new BookmarksService(DEFAULT_NOSTR_SEARCH_RELAYS);
    
    // Load clone URL reachability status
    loadCloneUrlReachability().catch(err => console.warn('Failed to load clone URL reachability:', err));
    
    // Decode npub to get repo owner pubkey for bookmark address
    try {
      const decoded = nip19.decode(state.npub);
      if (decoded.type === 'npub') {
        state.metadata.ownerPubkey = decoded.data as string;
        state.metadata.address = `${KIND.REPO_ANNOUNCEMENT}:${state.metadata.ownerPubkey}:${state.repo}`;
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
        if (autoSaveInterval) {
          clearInterval(autoSaveInterval);
          autoSaveInterval = null;
        }
        
        if (readmeAutoLoadTimeout) {
          clearTimeout(readmeAutoLoadTimeout);
          readmeAutoLoadTimeout = null;
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
    if (!state.user.pubkey || !state.metadata.address || !bookmarksService) return;
    
    try {
      state.bookmark.isBookmarked = await bookmarksService.isBookmarked(state.user.pubkey, state.metadata.address);
    } catch (err) {
      console.warn('Failed to load bookmark status:', err);
    }
  }

  async function toggleBookmark() {
    if (!state.user.pubkey || !state.metadata.address || !bookmarksService || state.loading.bookmark) return;
    
    state.loading.bookmark = true;
    try {
      // Get user's relays for publishing
      const { getUserRelays } = await import('$lib/services/nostr/user-relays.js');
      const allSearchRelays = [...new Set([...DEFAULT_NOSTR_SEARCH_RELAYS, ...DEFAULT_NOSTR_RELAYS])];
      const fullRelayClient = new NostrClient(allSearchRelays);
      const { outbox, inbox } = await getUserRelays(state.user.pubkey, fullRelayClient);
      const userRelays = combineRelays(outbox.length > 0 ? outbox : inbox, DEFAULT_NOSTR_RELAYS);
      
      let success = false;
      if (state.bookmark.isBookmarked) {
        success = await bookmarksService.removeBookmark(state.user.pubkey, state.metadata.address, userRelays);
      } else {
        success = await bookmarksService.addBookmark(state.user.pubkey, state.metadata.address, userRelays);
      }
      
      if (success) {
        state.bookmark.isBookmarked = !state.bookmark.isBookmarked;
      } else {
        alert(`Failed to ${state.bookmark.isBookmarked ? 'remove' : 'add'} bookmark. Please try again.`);
      }
    } catch (err) {
      console.error('Failed to toggle bookmark:', err);
      alert(`Failed to ${state.bookmark.isBookmarked ? 'remove' : 'add'} bookmark: ${String(err)}`);
    } finally {
      state.loading.bookmark = false;
    }
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
    if (state.repoNotFound || !state.user.pubkey) {
      state.maintainers.isMaintainer = false;
      return;
    }

    state.loading.maintainerStatus = true;
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/maintainers?userPubkey=${encodeURIComponent(state.user.pubkey)}`);
      if (response.ok) {
        const data = await response.json();
        state.maintainers.isMaintainer = data.state.maintainers.isMaintainer || false;
      }
    } catch (err) {
      console.error('Failed to check maintainer status:', err);
      state.maintainers.isMaintainer = false;
    } finally {
      state.loading.maintainerStatus = false;
    }
  }

  async function loadAllMaintainers() {
    if (state.repoNotFound || state.loading.maintainers) return;
    
    state.loading.maintainers = true;
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/maintainers`);
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
        
        state.maintainers.all = allMaintainersList;
      }
    } catch (err) {
      console.error('Failed to load maintainers:', err);
      state.maintainers.loaded = false; // Reset flag on state.error
      // Fallback to pageData if available
      if (repoOwnerPubkeyDerived) {
        state.maintainers.all = [{ pubkey: repoOwnerPubkeyDerived, isOwner: true }];
        if (repoMaintainers) {
          for (const maintainer of repoMaintainers) {
            if (maintainer.toLowerCase() !== repoOwnerPubkeyDerived.toLowerCase()) {
              state.maintainers.all.push({ pubkey: maintainer, isOwner: false });
            }
          }
        }
      }
    } finally {
      state.loading.maintainers = false;
    }
  }

  async function checkVerification() {
    if (state.repoNotFound) return;
    state.loading.verification = true;
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/verify`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        console.log('[Verification] Response:', data);
        state.verification.status = data;
      } else {
        console.warn('[Verification] Response not OK:', response.status, response.statusText);
        state.verification.status = { verified: false, error: `Verification check failed: ${response.status}` };
      }
    } catch (err) {
      console.error('[Verification] Failed to check verification:', err);
      state.verification.status = { verified: false, error: 'Failed to check verification' };
    } finally {
      state.loading.verification = false;
      console.log('[Verification] Status after check:', state.verification.status);
    }
  }

  async function generateAnnouncementFileForRepo() {
    if (!repoOwnerPubkeyDerived || !state.user.pubkeyHex) {
      state.error = 'Unable to generate announcement file: missing repository or user information';
      return;
    }

    try {
      // Fetch the repository announcement event
      const nostrClient = new NostrClient([...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])]);
      const events = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkeyDerived],
          '#d': [state.repo],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        state.error = 'Repository announcement not found. Please ensure the repository is registered on Nostr.';
        return;
      }

      const announcement = events[0] as NostrEvent;
      // Generate announcement event JSON (for download/reference)
      state.verification.fileContent = JSON.stringify(announcement, null, 2) + '\n';
      state.openDialog = 'verification';
    } catch (err) {
      console.error('Failed to generate announcement file:', err);
      state.error = `Failed to generate announcement file: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  function copyVerificationToClipboard() {
    if (!state.verification.fileContent) return;
    
    navigator.clipboard.writeText(state.verification.fileContent).then(() => {
      alert('Verification file content copied to clipboard!');
    }).catch((err) => {
      console.error('Failed to copy:', err);
      alert('Failed to copy to clipboard. Please select and copy manually.');
    });
  }

  // Verify clone URL by committing announcement
  async function verifyCloneUrl() {
    if (!state.verification.selectedCloneUrl || !state.user.pubkey || !state.user.pubkeyHex) {
      state.error = 'Unable to verify: missing information';
      return;
    }

    if (!state.maintainers.isMaintainer && state.user.pubkeyHex !== repoOwnerPubkeyDerived) {
      state.error = 'Only repository owners and maintainers can verify clone URLs';
      return;
    }

    // selectedCloneUrl is already set when user selects it
    state.error = null;

    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/verify`, {
        method: 'POST',
        headers: buildApiHeaders()
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(errorText || `Failed to verify: ${response.statusText}`);
      }

      const data = await response.json();
      
      // Close dialog
      state.openDialog = null;
      state.verification.selectedCloneUrl = null;

      // Reload verification status after a short delay
      setTimeout(() => {
        checkVerification().catch((err: unknown) => {
          console.warn('Failed to reload verification status:', err);
        });
      }, 1000);

      // Show success message
      alert(data.message || 'Repository verification initiated. The verification status will update shortly.');
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to verify repository';
      console.error('Error verifying clone URL:', err);
    } finally {
      state.verification.selectedCloneUrl = null;
    }
  }

  async function deleteAnnouncement() {
    if (!state.user.pubkey || !state.user.pubkeyHex) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    if (!repoOwnerPubkeyDerived || state.user.pubkeyHex !== repoOwnerPubkeyDerived) {
      alert('Only the repository owner can delete the announcement');
      return;
    }

    // First confirmation
    if (!confirm('WARNING: Are you sure you want to delete this repository announcement?\n\nThis will permanently delete the repository announcement from Nostr relays. This action CANNOT be undone.\n\nClick OK to continue, or Cancel to abort.')) {
      return;
    }

    // Second confirmation for critical operation
    if (!confirm('FINAL CONFIRMATION: This will permanently delete the repository announcement.\n\nAre you absolutely certain you want to proceed?\n\nThis action CANNOT be undone.')) {
      return;
    }

    state.creating.announcement = true;
    state.error = null;

    try {
      // Fetch the repository announcement to get its event ID
      const nostrClient = new NostrClient([...new Set([...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS])]);
      const events = await nostrClient.fetchEvents([
        {
          kinds: [KIND.REPO_ANNOUNCEMENT],
          authors: [repoOwnerPubkeyDerived],
          '#d': [state.repo],
          limit: 1
        }
      ]);

      if (events.length === 0) {
        throw new Error('Repository announcement not found');
      }

      const announcement = events[0];
      announcementEventId = announcement.id;

      // Get user relays
      const { outbox } = await getUserRelays(state.user.pubkeyHex, nostrClient);
      const combinedRelays = combineRelays(outbox);

      // Create deletion request (NIP-09)
      const deletionRequestTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.DELETION_REQUEST,
        pubkey: state.user.pubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        content: `Requesting deletion of repository announcement for ${state.repo}`,
        tags: [
          ['e', announcement.id], // Reference to the announcement event
          ['a', `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkeyDerived}:${state.repo}`], // Repository address
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
      state.error = err instanceof Error ? err.message : 'Failed to send deletion request';
      alert(state.error);
    } finally {
      state.creating.announcement = false;
    }
  }

  function downloadVerificationFile() {
    if (!state.verification.fileContent) return;
    
    const blob = new Blob([state.verification.fileContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'announcement-event.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/branches`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        state.git.branches = await response.json();
        
        // If repo is not cloned but we got state.git.branches, API fallback is available
        if (state.clone.isCloned === false && state.git.branches.length > 0) {
          state.clone.apiFallbackAvailable = true;
        }
        if (state.git.branches.length > 0) {
          // Branches can be an array of objects with .name property or array of strings
          const branchNames = state.git.branches.map((b: any) => typeof b === 'string' ? b : b.name);
          
          // Fetch the actual default branch from the API
          try {
            const defaultBranchResponse = await fetch(`/api/repos/${state.npub}/${state.repo}/default-branch`, {
              headers: buildApiHeaders()
            });
            if (defaultBranchResponse.ok) {
              const defaultBranchData = await defaultBranchResponse.json();
              state.git.defaultBranch = defaultBranchData.state.git.defaultBranch || defaultBranchData.branch || null;
            }
          } catch (err) {
            console.warn('Failed to fetch default branch, using fallback logic:', err);
          }
          
          // Fallback: Detect default branch: prefer master, then main, then first branch
          if (!state.git.defaultBranch) {
            if (branchNames.includes('master')) {
              state.git.defaultBranch = 'master';
            } else if (branchNames.includes('main')) {
              state.git.defaultBranch = 'main';
            } else {
              state.git.defaultBranch = branchNames[0];
            }
          }
          
          // Only update state.git.currentBranch if it's not set or if the current branch doesn't exist
          // Also validate that state.git.currentBranch doesn't contain invalid characters (like '#')
          if (!state.git.currentBranch || 
              typeof state.git.currentBranch !== 'string' || 
              state.git.currentBranch.includes('#') ||
              !branchNames.includes(state.git.currentBranch)) {
            state.git.currentBranch = state.git.defaultBranch;
          }
        } else {
          // No state.git.branches exist - set state.git.currentBranch to null to show "no state.git.branches" in header
          state.git.currentBranch = null;
        }
      } else if (response.status === 404) {
        // Check if this is a "not cloned" state.error - API fallback might be available
        const errorText = await response.text().catch(() => '');
        if (errorText.includes('not cloned locally')) {
          // Repository is not cloned - check if API fallback might be available
          if (repoCloneUrls && repoCloneUrls.length > 0) {
            // We have clone URLs, so API fallback might work - mark as unknown for now
            // It will be set to true if a subsequent request succeeds
            state.clone.apiFallbackAvailable = null;
            // Don't set state.repoNotFound or state.error yet - allow API fallback to be attempted
          } else {
            // No clone URLs, API fallback won't work
            state.repoNotFound = true;
            state.clone.apiFallbackAvailable = false;
            state.error = errorText || `Repository not found. This repository exists in Nostr but hasn't been provisioned on this server yet. The server will automatically provision it soon, or you can contact the server administrator.`;
          }
        } else {
          // Generic 404 - repository doesn't exist
          state.repoNotFound = true;
          state.clone.apiFallbackAvailable = false;
          state.error = `Repository not found. This repository exists in Nostr but hasn't been provisioned on this server yet. The server will automatically provision it soon, or you can contact the server administrator.`;
        }
      } else if (response.status === 403) {
        // Access denied - don't set state.repoNotFound, allow retry after login
        const errorText = await response.text().catch(() => response.statusText);
        state.error = `Access denied: ${errorText}. You may need to log in or you may not have permission to view this repository.`;
        console.warn('[Branches] Access denied, user may need to log in');
      }
    } catch (err) {
      console.error('Failed to load branches:', err);
    }
  }

  async function loadFiles(path: string = '') {
    // Skip if repository doesn't exist
    if (state.repoNotFound) return;
    
    state.loading.main = true;
    state.error = null;
    try {
      // Validate and get a valid branch name
      let branchName: string;
      if (typeof state.git.currentBranch === 'string' && state.git.currentBranch.trim() !== '' && !state.git.currentBranch.includes('#')) {
        const branchNames = state.git.branches.map((b: any) => typeof b === 'string' ? b : b.name);
        if (branchNames.includes(state.git.currentBranch)) {
          branchName = state.git.currentBranch;
        } else {
          branchName = state.git.defaultBranch || (state.git.branches.length > 0 
            ? (typeof state.git.branches[0] === 'string' ? state.git.branches[0] : state.git.branches[0].name)
            : 'HEAD');
        }
      } else {
        branchName = state.git.defaultBranch || (state.git.branches.length > 0 
          ? (typeof state.git.branches[0] === 'string' ? state.git.branches[0] : state.git.branches[0].name)
          : 'HEAD');
      }
      
      const url = `/api/repos/${state.npub}/${state.repo}/tree?ref=${encodeURIComponent(branchName)}&path=${encodeURIComponent(path)}`;
      const response = await fetch(url, {
        headers: buildApiHeaders()
      });
      
      if (!response.ok) {
        if (response.status === 404) {
          // Check if this is a "not cloned" state.error - API fallback might be available
          const errorText = await response.text().catch(() => '');
          if (errorText.includes('not cloned locally')) {
            // Repository is not cloned - check if API fallback might be available
            if (repoCloneUrls && repoCloneUrls.length > 0) {
              // We have clone URLs, so API fallback might work - mark as unknown for now
              // It will be set to true if a subsequent request succeeds
              state.clone.apiFallbackAvailable = null;
              // Don't set state.repoNotFound - allow API fallback to be attempted
            } else {
              // No clone URLs, API fallback won't work
              state.repoNotFound = true;
              state.clone.apiFallbackAvailable = false;
            }
            // Throw state.error but use the actual state.error text from the API
            throw new Error(errorText || 'Repository not found. This repository exists in Nostr but hasn\'t been provisioned on this server yet. The server will automatically provision it soon, or you can contact the server administrator.');
          } else {
            // Generic 404 - repository doesn't exist
            state.repoNotFound = true;
            state.clone.apiFallbackAvailable = false;
            throw new Error(`Repository not found. This repository exists in Nostr but hasn't been provisioned on this server yet. The server will automatically provision it soon, or you can contact the server administrator.`);
          }
        } else if (response.status === 403) {
          // 403 means access denied - don't set state.repoNotFound, just show state.error
          // This allows retry after login
          const accessDeniedError = new Error(`Access denied: ${response.statusText}. You may need to log in or you may not have permission to view this repository.`);
          // Log as info since this is normal client behavior (not logged in or no access)
          console.info('Access denied (normal behavior):', accessDeniedError.message);
          throw accessDeniedError;
        }
        throw new Error(`Failed to load files: ${response.statusText}`);
      }

      state.files.list = await response.json();
      state.files.currentPath = path;
      
      // If repo is not cloned but we got state.files.list, API fallback is available
      if (state.clone.isCloned === false && state.files.list.length > 0) {
        state.clone.apiFallbackAvailable = true;
      }
      
      // Auto-load README if we're in the root directory and no file is currently selected
      // Only attempt once per path to prevent loops
      if (path === '' && !state.files.currentFile && !state.metadata.readmeAutoLoadAttempted) {
        const readmeFile = findReadmeFile(state.files.list);
        if (readmeFile) {
          state.metadata.readmeAutoLoadAttempted = true;
          // Clear any existing timeout
          if (readmeAutoLoadTimeout) {
            clearTimeout(readmeAutoLoadTimeout);
          }
          // Small delay to ensure UI is ready
          readmeAutoLoadTimeout = setTimeout(() => {
            loadFile(readmeFile.path).catch(err => {
              // If load fails (e.g., 429 rate limit), reset the flag after a delay
              // so we can retry later, but not immediately
              if (err instanceof Error && err.message.includes('Too Many Requests')) {
                console.warn('[README] Rate limited, will retry later');
                setTimeout(() => {
                  state.metadata.readmeAutoLoadAttempted = false;
                }, 5000); // Retry after 5 seconds
              } else {
                // For other errors, reset immediately
                state.metadata.readmeAutoLoadAttempted = false;
              }
            });
            readmeAutoLoadTimeout = null;
          }, 100);
        }
      } else if (path !== '' || state.files.currentFile) {
        // Reset flag when navigating away from root or when a file is selected
        state.metadata.readmeAutoLoadAttempted = false;
        if (readmeAutoLoadTimeout) {
          clearTimeout(readmeAutoLoadTimeout);
          readmeAutoLoadTimeout = null;
        }
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to load state.files.list';
      // Only log as state.error if it's not a 403 (access denied), which is normal behavior
      if (err instanceof Error && err.message.includes('Access denied')) {
        // Already logged as info above, don't log again
      } else {
        console.error('Error loading files:', err);
      }
    } finally {
      state.loading.main = false;
    }
  }

  // Helper function to find README file in file list
  function findReadmeFile(fileList: Array<{ name: string; path: string; type: 'file' | 'directory' }>): { name: string; path: string; type: 'file' | 'directory' } | null {
    // Priority order for README state.files.list (most common first)
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
    state.loading.main = true;
    state.error = null;
    try {
      // Ensure state.git.currentBranch is a string (branch name), not an object
      // If state.git.currentBranch is not set, use the first available branch or 'master' as fallback
      let branchName: string;
      
      if (typeof state.git.currentBranch === 'string' && state.git.currentBranch.trim() !== '') {
        // Validate that state.git.currentBranch is actually a valid branch name
        // Check if it exists in the state.git.branches list
        const branchNames = state.git.branches.map((b: any) => typeof b === 'string' ? b : b.name);
        if (branchNames.includes(state.git.currentBranch)) {
          branchName = state.git.currentBranch;
        } else {
          // state.git.currentBranch is set but not in state.git.branches list, use state.git.defaultBranch or fallback
          branchName = state.git.defaultBranch || (state.git.branches.length > 0 
            ? (typeof state.git.branches[0] === 'string' ? state.git.branches[0] : state.git.branches[0].name)
            : 'HEAD');
        }
      } else if (typeof state.git.currentBranch === 'object' && state.git.currentBranch !== null && 'name' in state.git.currentBranch) {
        branchName = (state.git.currentBranch as { name: string }).name;
      } else {
        // state.git.currentBranch is null, undefined, or invalid - use state.git.defaultBranch or fallback
        branchName = state.git.defaultBranch || (state.git.branches.length > 0 
          ? (typeof state.git.branches[0] === 'string' ? state.git.branches[0] : state.git.branches[0].name)
          : 'HEAD');
      }
      
      // Final validation: ensure branchName is a valid string
      // Note: We allow '#' in branch names for existing state.git.branches (they'll be URL-encoded)
      // Only reject if it's empty or not a string
      if (!branchName || typeof branchName !== 'string' || branchName.trim() === '') {
        console.warn('[loadFile] Invalid branch name detected, using fallback:', branchName);
        branchName = state.git.defaultBranch || (state.git.branches.length > 0 
          ? (typeof state.git.branches[0] === 'string' ? state.git.branches[0] : state.git.branches[0].name)
          : 'HEAD');
      }
      
      // Determine language from file extension first to check if it's an image
      const ext = filePath.split('.').pop()?.toLowerCase() || '';
      
      // Check if this is an image file BEFORE making the API call
      state.preview.file.isImage = isImageFileType(ext);
      
      if (state.preview.file.isImage) {
        // For image state.files.list, construct the raw file URL and skip state.loading.main text content
        state.preview.file.imageUrl = `/api/repos/${state.npub}/${state.repo}/raw?path=${encodeURIComponent(filePath)}&ref=${encodeURIComponent(branchName)}`;
        state.files.content = ''; // Clear content for images
        state.files.editedContent = ''; // Clear edited content for images
        state.preview.file.html = ''; // Clear HTML for images
        state.preview.file.highlightedContent = ''; // Clear highlighted content
        state.files.language = 'text';
        state.files.currentFile = filePath;
        state.files.hasChanges = false;
      } else {
        // Not an image, load file content normally
        state.preview.file.imageUrl = null;
        
        const url = `/api/repos/${state.npub}/${state.repo}/file?path=${encodeURIComponent(filePath)}&ref=${encodeURIComponent(branchName)}`;
        const response = await fetch(url, {
          headers: buildApiHeaders()
        });
        
        if (!response.ok) {
          // Handle rate limiting specifically to prevent loops
          if (response.status === 429) {
            const error = new Error(`Failed to load file: Too Many Requests`);
            console.warn('[File Load] Rate limited, please wait before retrying');
            throw error;
          }
          throw new Error(`Failed to load file: ${response.statusText}`);
        }

        const data = await response.json();
        state.files.content = data.content;
        state.files.editedContent = data.content;
        state.files.currentFile = filePath;
        state.files.hasChanges = false;
        
        // Reset README auto-load flag when a file is successfully loaded
        if (filePath && filePath.toLowerCase().includes('readme')) {
          state.metadata.readmeAutoLoadAttempted = false;
        }
        
        if (ext === 'md' || ext === 'markdown') {
          state.files.language = 'markdown';
        } else if (ext === 'adoc' || ext === 'asciidoc') {
          state.files.language = 'asciidoc';
        } else {
          state.files.language = 'text';
        }
        
        // Reset preview mode to default (preview) when state.loading.main a new file
        state.preview.file.showPreview = true;
        state.preview.file.html = '';
        
        // Render markdown/asciidoc/HTML/CSV state.files.list as HTML for preview
        if (state.files.content && (ext === 'md' || ext === 'markdown' || ext === 'adoc' || ext === 'asciidoc' || ext === 'html' || ext === 'htm' || ext === 'csv')) {
          await renderFileAsHtml(state.files.content, ext || '');
        }
        
        // Apply syntax highlighting
        // For state.files.list that support HTML preview (markdown, HTML, etc.), only show highlighting in raw mode
        // For code state.files.list and other non-markup state.files.list, always show syntax highlighting
        const hasHtmlPreview = supportsPreview(ext);
        if (state.files.content) {
          if (hasHtmlPreview) {
            // Markup files: only show highlighting when not in preview mode (raw mode)
            if (!state.preview.file.showPreview) {
              await applySyntaxHighlighting(state.files.content, ext || '');
            }
          } else {
            // Code files and other non-markup files: always show syntax highlighting
            await applySyntaxHighlighting(state.files.content, ext || '');
          }
        }
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to load file';
      console.error('Error state.loading.main file:', err);
    } finally {
      state.loading.main = false;
    }
  }

  function handleContentChange(value: string) {
    state.files.editedContent = value;
    state.files.hasChanges = value !== state.files.content;
  }

  function handleFileClick(file: { name: string; path: string; type: 'file' | 'directory' }) {
    if (file.type === 'directory') {
      state.files.pathStack.push(state.files.currentPath);
      loadFiles(file.path);
    } else {
      loadFile(file.path);
      // On mobile, switch to file viewer when a file is clicked
      if (window.innerWidth <= 768) {
        state.ui.showFileListOnMobile = false;
      }
    }
  }

  // Copy file content to clipboard
  async function copyFileContent(event?: Event) {
    if (!state.files.content || state.preview.copying) return;
    
    state.preview.copying = true;
    try {
      await navigator.clipboard.writeText(state.files.content);
      // Show temporary feedback
      const button = event?.target as HTMLElement;
      if (button) {
        const originalTitle = button.getAttribute('title') || '';
        button.setAttribute('title', 'Copied!');
        setTimeout(() => {
          button.setAttribute('title', originalTitle);
        }, 2000);
      }
    } catch (err) {
      console.error('Failed to copy file content:', err);
      alert('Failed to copy file content to clipboard');
    } finally {
      state.preview.copying = false;
    }
  }

  // Download file
  function downloadFile() {
    if (!state.files.content || !state.files.currentFile) return;
    
    try {
      // Determine MIME type based on file extension
      const ext = state.files.currentFile.split('.').pop()?.toLowerCase() || '';
      const mimeTypes: Record<string, string> = {
        'js': 'text/javascript',
        'ts': 'text/typescript',
        'json': 'application/json',
        'css': 'text/css',
        'html': 'text/html',
        'htm': 'text/html',
        'md': 'text/markdown',
        'txt': 'text/plain',
        'csv': 'text/csv',
        'xml': 'application/xml',
        'svg': 'image/svg+xml',
        'py': 'text/x-python',
        'java': 'text/x-java-source',
        'c': 'text/x-csrc',
        'cpp': 'text/x-c++src',
        'h': 'text/x-csrc',
        'hpp': 'text/x-c++src',
        'sh': 'text/x-shellscript',
        'bash': 'text/x-shellscript',
        'yaml': 'text/yaml',
        'yml': 'text/yaml',
        'toml': 'text/toml',
        'ini': 'text/plain',
        'conf': 'text/plain',
        'log': 'text/plain'
      };
      
      const mimeType = mimeTypes[ext] || 'text/plain';
      const blob = new Blob([state.files.content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = state.files.currentFile.split('/').pop() || 'file';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download file:', err);
      alert('Failed to download file');
    }
  }

  function handleBack() {
    if (state.files.pathStack.length > 0) {
      const parentPath = state.files.pathStack.pop() || '';
      loadFiles(parentPath);
    } else {
      loadFiles('');
    }
  }

  // Cache for user profile email and name
  // Cached user data (not in state store - these are temporary caches)
  let cachedUserEmail: string | null = null;
  let cachedUserName: string | null = null;
  let fetchingUserEmail = false;
  let fetchingUserName = false;

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
    if (!state.user.pubkeyHex) {
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
      prefillEmail = await fetchUserEmail(state.user.pubkeyHex, state.user.pubkey || undefined, DEFAULT_NOSTR_RELAYS);
    } catch (err) {
      console.warn('Failed to fetch user profile for email:', err);
      // Fallback to shortenednpub@gitrepublic.web
      const npubFromPubkey = state.user.pubkeyHex ? nip19.npubEncode(state.user.pubkeyHex) : (state.user.pubkey || 'unknown');
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
    if (!state.user.pubkeyHex) {
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
      prefillName = await fetchUserName(state.user.pubkeyHex, state.user.pubkey || undefined, DEFAULT_NOSTR_RELAYS);
    } catch (err) {
      console.warn('Failed to fetch user profile for name:', err);
      // Fallback to shortened npub (20 chars)
      const npubFromPubkey = state.user.pubkeyHex ? nip19.npubEncode(state.user.pubkeyHex) : (state.user.pubkey || 'unknown');
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
    if (!state.files.currentFile || !state.forms.commit.message.trim()) {
      alert('Please enter a commit message');
      return;
    }

    if (!state.user.pubkey) {
      alert('Please connect your NIP-07 extension to save state.files.list');
      return;
    }

    // Validate branch selection
    if (!state.git.currentBranch || typeof state.git.currentBranch !== 'string') {
      alert('Please select a branch before state.saving the file');
      return;
    }

    state.saving = true;
    state.error = null;

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
              ['message', state.forms.commit.message.trim()]
            ],
            content: `Signed commit: ${state.forms.commit.message.trim()}`
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
          message: state.forms.commit.message.trim(),
          authorName: authorName,
          authorEmail: authorEmail,
          branch: state.git.currentBranch,
          userPubkey: state.user.pubkey,
          commitSignatureEvent: commitSignatureEvent // Send the signed event to server
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: response.statusText }));
        const errorMessage = errorData.message || errorData.state.error || 'Failed to save file';
        throw new Error(errorMessage);
      }

      // Reload file to get updated content
      await loadFile(state.files.currentFile);
      state.forms.commit.message = '';
      state.openDialog = null;
      alert('File saved successfully!');
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to save file';
      console.error('Error state.saving file:', err);
    } finally {
      state.saving = false;
    }
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
    if (!state.forms.file.fileName.trim()) {
      alert('Please enter a file name');
      return;
    }

    if (!state.user.pubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    // Validate branch selection
    if (!state.git.currentBranch || typeof state.git.currentBranch !== 'string') {
      alert('Please select a branch before creating the file');
      return;
    }

    state.saving = true;
    state.error = null;

    try {
      // Get user email and name (from profile or prompt)
      const authorEmail = await getUserEmail();
      const authorName = await getUserName();
      const filePath = state.files.currentPath ? `${state.files.currentPath}/${state.forms.file.fileName}` : state.forms.file.fileName;
      const commitMsg = `Create ${state.forms.file.fileName}`;
      
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
      
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          path: filePath,
          content: state.forms.file.content,
          message: commitMsg,
          authorName: authorName,
          authorEmail: authorEmail,
          branch: state.git.currentBranch,
          action: 'create',
          userPubkey: state.user.pubkey,
          commitSignatureEvent: commitSignatureEvent // Send the signed event to server
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create file');
      }

      state.openDialog = null;
      state.forms.file.fileName = '';
      state.forms.file.content = '';
      await loadFiles(state.files.currentPath);
      alert('File created successfully!');
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to create file';
    } finally {
      state.saving = false;
    }
  }

  async function deleteFile(filePath: string) {
    if (!confirm(`Are you sure you want to delete "${filePath}"?\n\nThis will permanently delete the file from the repository. This action cannot be undone.\n\nClick OK to delete, or Cancel to abort.`)) {
      return;
    }

    if (!state.user.pubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    // Validate branch selection
    if (!state.git.currentBranch || typeof state.git.currentBranch !== 'string') {
      alert('Please select a branch before deleting the file');
      return;
    }

    state.saving = true;
    state.error = null;

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
      
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          path: filePath,
          message: commitMsg,
          authorName: authorName,
          authorEmail: authorEmail,
          branch: state.git.currentBranch,
          action: 'delete',
          userPubkey: state.user.pubkey,
          commitSignatureEvent: commitSignatureEvent // Send the signed event to server
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to delete file');
      }

      if (state.files.currentFile === filePath) {
        state.files.currentFile = null;
      }
      await loadFiles(state.files.currentPath);
      alert('File deleted successfully!');
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to delete file';
    } finally {
      state.saving = false;
    }
  }

  async function createBranch() {
    if (!state.forms.branch.name.trim()) {
      alert('Please enter a branch name');
      return;
    }

    state.saving = true;
    state.error = null;

    try {
      // If no state.git.branches exist, don't pass fromBranch (will use --orphan)
      // Otherwise, use the selected branch or current branch
      let fromBranch: string | undefined = state.forms.branch.from || state.git.currentBranch || undefined;
      
      // Include announcement if available (for empty repos)
      const requestBody: { branchName: string; fromBranch?: string; announcement?: NostrEvent } = {
        branchName: state.forms.branch.name
      };
      if (state.git.branches.length > 0 && fromBranch) {
        requestBody.fromBranch = fromBranch;
      }
      // Pass announcement if available (especially useful for empty repos)
      if (repoAnnouncement) {
        requestBody.announcement = repoAnnouncement;
      }

      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/branches`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create branch');
      }

      state.openDialog = null;
      state.forms.branch.name = '';
      await loadBranches();
      alert('Branch created successfully!');
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to create branch';
    } finally {
      state.saving = false;
    }
  }

  async function deleteBranch(branchName: string) {
    if (!confirm(`Are you sure you want to delete the branch "${branchName}"?\n\nThis will permanently delete the branch from the repository. This action CANNOT be undone.\n\nClick OK to delete, or Cancel to abort.`)) {
      return;
    }

    if (!state.user.pubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    // Prevent deleting the current branch
    if (branchName === state.git.currentBranch) {
      alert('Cannot delete the currently selected branch. Please switch to a different branch first.');
      return;
    }

    state.saving = true;
    state.error = null;

    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/branches`, {
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
      state.error = err instanceof Error ? err.message : 'Failed to delete branch';
      alert(state.error);
    } finally {
      state.saving = false;
    }
  }

  async function loadCommitHistory() {
    state.loading.commits = true;
    state.error = null;
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/commits?branch=${state.git.currentBranch}&limit=50`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        // Normalize commits: API-based commits use 'sha', local commits use 'hash'
        state.git.commits = data.map((commit: any) => ({
          hash: commit.hash || commit.sha || '',
          message: commit.message || 'No message',
          author: commit.author || 'Unknown',
          date: commit.date || new Date().toISOString(),
          files: commit.files || []
        })).filter((commit: any) => commit.hash); // Filter out commits without hash
        
        // Verify state.git.commits in background (only for cloned repos)
        if (state.clone.isCloned === true) {
          state.git.commits.forEach(commit => {
            verifyCommit(commit.hash).catch(err => {
              console.warn(`Failed to verify commit ${commit.hash}:`, err);
            });
          });
        }
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to load commit history';
    } finally {
      state.loading.commits = false;
    }
  }

  async function verifyCommit(commitHash: string) {
    if (state.git.verifyingCommits.has(commitHash)) return; // Already verifying
    if (!state.clone.isCloned) return; // Can't verify without local repo
    
    state.git.verifyingCommits.add(commitHash);
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/commits/${commitHash}/verify`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const verification = await response.json();
        // Only update verification if there's actually a signature
        // If hasSignature is false or undefined, don't set verification at all
        if (verification.hasSignature !== false) {
          const commitIndex = state.git.commits.findIndex(c => c.hash === commitHash);
          if (commitIndex >= 0) {
            state.git.commits[commitIndex].verification = verification;
          }
        }
      }
    } catch (err) {
      console.warn(`Failed to verify commit ${commitHash}:`, err);
    } finally {
      state.git.verifyingCommits.delete(commitHash);
    }
  }

  async function viewDiff(commitHash: string) {
    // Set selected commit immediately so it shows in the right panel
    state.git.selectedCommit = commitHash;
    state.git.showDiff = false; // Start with false, will be set to true when diff loads
    state.loading.commits = true;
    state.error = null;
    try {
      // Normalize commit hash (handle both 'hash' and 'sha' properties)
      const getCommitHash = (c: any) => c.hash || c.sha || '';
      const commitIndex = state.git.commits.findIndex(c => getCommitHash(c) === commitHash);
      const parentHash = commitIndex >= 0
        ? (state.git.commits[commitIndex + 1] ? getCommitHash(state.git.commits[commitIndex + 1]) : `${commitHash}^`)
        : `${commitHash}^`;
      
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/diff?from=${parentHash}&to=${commitHash}`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        state.git.diffData = await response.json();
        state.git.showDiff = true;
      } else {
        // Handle 404 or other errors
        const errorText = await response.text().catch(() => response.statusText);
        if (response.status === 404) {
          // Check if this is an API fallback commit (repo not cloned or empty)
          if (state.clone.isCloned === false || (state.clone.isCloned === true && state.clone.apiFallbackAvailable)) {
            state.error = 'Diffs are not available for commits viewed via API fallback. Please clone the repository to view diffs.';
          } else {
            state.error = `Commit not found: ${errorText || 'The commit may not exist in the repository'}`;
          }
        } else {
          state.error = `Failed to load diff: ${errorText || response.statusText}`;
        }
      }
    } catch (err) {
      // Handle network errors
      if (err instanceof TypeError && err.message.includes('NetworkError')) {
        state.error = 'Network error: Unable to fetch diff. Please check your connection and try again.';
      } else {
        state.error = err instanceof Error ? err.message : 'Failed to load diff';
      }
    } finally {
      state.loading.commits = false;
    }
  }

  async function loadTags() {
    if (state.repoNotFound) return;
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/tags`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        state.git.tags = await response.json();
        // Auto-select first tag if none selected
        if (state.git.tags.length > 0 && !state.git.selectedTag) {
          state.git.selectedTag = state.git.tags[0].name;
        }
      }
    } catch (err) {
      console.error('Failed to load tags:', err);
    }
  }

  async function createTag() {
    if (!state.forms.tag.name.trim()) {
      alert('Please enter a tag name');
      return;
    }

    if (!state.user.pubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    state.saving = true;
    state.error = null;

    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/tags`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          tagName: state.forms.tag.name,
          ref: state.forms.tag.ref,
          message: state.forms.tag.message || undefined,
          userPubkey: state.user.pubkey
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create tag');
      }

      state.openDialog = null;
      state.forms.tag.name = '';
      state.forms.tag.message = '';
      await loadTags();
      alert('Tag created successfully!');
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to create tag';
    } finally {
      state.saving = false;
    }
  }

  async function loadReleases() {
    if (state.repoNotFound) return;
    state.loading.releases = true;
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/releases`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        state.releases = data.map((release: any) => ({
          id: release.id,
          tagName: release.tags.find((t: string[]) => t[0] === 'tag')?.[1] || '',
          tagHash: release.tags.find((t: string[]) => t[0] === 'r' && t[2] === 'tag')?.[1],
          releaseNotes: release.content || '',
          isDraft: release.tags.some((t: string[]) => t[0] === 'draft' && t[1] === 'true'),
          isPrerelease: release.tags.some((t: string[]) => t[0] === 'prerelease' && t[1] === 'true'),
          created_at: release.created_at,
          pubkey: release.pubkey
        }));
      }
    } catch (err) {
      console.error('Failed to load state.releases:', err);
    } finally {
      state.loading.releases = false;
    }
  }

  async function createRelease() {
    if (!state.forms.release.tagName.trim() || !state.forms.release.tagHash.trim()) {
      alert('Please enter a tag name and tag hash');
      return;
    }

    if (!state.user.pubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    if (!state.maintainers.isMaintainer && state.user.pubkeyHex !== repoOwnerPubkeyDerived) {
      alert('Only repository owners and maintainers can create state.releases');
      return;
    }

    state.creating.release = true;
    state.error = null;

    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/releases`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          tagName: state.forms.release.tagName,
          tagHash: state.forms.release.tagHash,
          releaseNotes: state.forms.release.notes,
          isDraft: state.forms.release.isDraft,
          isPrerelease: state.forms.release.isPrerelease
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Failed to create release');
      }

      state.openDialog = null;
      state.forms.release.tagName = '';
      state.forms.release.tagHash = '';
      state.forms.release.notes = '';
      state.forms.release.isDraft = false;
      state.forms.release.isPrerelease = false;
      await loadReleases();
      // Reload state.git.tags to show release indicator
      await loadTags();
      alert('Release created successfully!');
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to create release';
      alert(state.error);
    } finally {
      state.creating.release = false;
    }
  }

  async function performCodeSearch() {
    if (!state.codeSearch.query.trim() || state.codeSearch.query.length < 2) {
      state.codeSearch.results = [];
      return;
    }

    state.loading.codeSearch = true;
    state.error = null;

    try {
      // Get current branch for repo-specific search
      const branchParam = state.codeSearch.scope === 'repo' && state.git.currentBranch 
        ? `&branch=${encodeURIComponent(state.git.currentBranch)}` 
        : '';
      
      // For "All Repositories", don't pass repo filter - let it search all repos
      const url = state.codeSearch.scope === 'repo' 
        ? `/api/repos/${state.npub}/${state.repo}/code-search?q=${encodeURIComponent(state.codeSearch.query.trim())}${branchParam}`
        : `/api/code-search?q=${encodeURIComponent(state.codeSearch.query.trim())}`;
      
      const response = await fetch(url, {
        headers: buildApiHeaders()
      });

      if (response.ok) {
        const data = await response.json();
        state.codeSearch.results = Array.isArray(data) ? data : [];
      } else {
        let errorMessage = 'Failed to search code';
        try {
          const errorData = await response.json();
          errorMessage = errorData.message || errorMessage;
        } catch {
          errorMessage = `Search failed: ${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to search code';
      console.error('[Code Search] Error:', err);
      state.error = errorMessage;
      state.codeSearch.results = [];
    } finally {
      state.loading.codeSearch = false;
    }
  }

  async function loadIssues() {
    state.loading.issues = true;
    state.error = null;
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/issues`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        state.issues = data.map((issue: { id: string; tags: string[][]; content: string; status?: string; pubkey: string; created_at: number; kind?: number }) => ({
          id: issue.id,
          subject: issue.tags.find((t: string[]) => t[0] === 'subject')?.[1] || 'Untitled',
          content: issue.content,
          status: issue.status || 'open',
          author: issue.pubkey,
          created_at: issue.created_at,
          kind: issue.kind || KIND.ISSUE,
          tags: issue.tags || []
        }));
        // Auto-select first issue if none selected
        if (state.issues.length > 0 && !state.selected.issue) {
          state.selected.issue = state.issues[0].id;
          loadIssueReplies(state.issues[0].id);
        }
      } else {
        // Handle non-OK responses
        const errorText = await response.text().catch(() => response.statusText);
        let errorMessage = `Failed to load state.issues: ${response.status} ${response.statusText}`;
        try {
          const errorData = JSON.parse(errorText);
          if (errorData.message) {
            errorMessage = errorData.message;
          }
        } catch {
          // If parsing fails, use the text as-is
          if (errorText) {
            errorMessage = errorText;
          }
        }
        console.error('[Issues] Failed to load:', errorMessage);
        state.error = errorMessage;
        // Don't clear state.issues array - keep existing state.issues if any
        // state.issues = []; // Only clear if you want to show empty state on state.error
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load state.issues';
      console.error('[Issues] Error state.loading.main state.issues:', err);
      state.error = errorMessage;
    } finally {
      state.loading.issues = false;
    }
  }

  async function loadIssueReplies(issueId: string) {
    state.loading.issueReplies = true;
    try {
      const replies = await nostrClient.fetchEvents([
        {
          kinds: [KIND.COMMENT],
          '#e': [issueId],
          limit: 100
        }
      ]) as NostrEvent[];
      
      state.issueReplies = replies.map(reply => ({
        id: reply.id,
        content: reply.content,
        author: reply.pubkey,
        created_at: reply.created_at,
        tags: reply.tags || []
      })).sort((a, b) => a.created_at - b.created_at);
    } catch (err) {
      console.error('[Issues] Error state.loading.main replies:', err);
      state.issueReplies = [];
    } finally {
      state.loading.issueReplies = false;
    }
  }

  async function createIssue() {
    if (!state.forms.issue.subject.trim() || !state.forms.issue.content.trim()) {
      alert('Please enter a subject and content');
      return;
    }

    if (!state.user.pubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    state.saving = true;
    state.error = null;

    try {
      const { IssuesService } = await import('$lib/services/nostr/issues-service.js');
      
      const decoded = nip19.decode(state.npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      // Get user's relays and combine with defaults
      const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const { outbox } = await getUserRelays(state.user.pubkey, tempClient);
      const combinedRelays = combineRelays(outbox);

      const issuesService = new IssuesService(combinedRelays);
      const issue = await issuesService.createIssue(
        repoOwnerPubkey,
        state.repo,
        state.forms.issue.subject.trim(),
        state.forms.issue.content.trim(),
        state.forms.issue.labels.filter(l => l.trim())
      );

      state.openDialog = null;
      state.forms.issue.subject = '';
      state.forms.issue.content = '';
      state.forms.issue.labels = [''];
      await loadIssues();
      alert('Issue created successfully!');
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to create issue';
      console.error('Error creating issue:', err);
    } finally {
      state.saving = false;
    }
  }

  async function updatePatchStatus(patchId: string, patchAuthor: string, status: string) {
    if (!state.user.pubkey || !state.user.pubkeyHex) {
      state.error = 'Please log in to update patch status';
      return;
    }

    state.statusUpdates.patch[patchId] = true;
    state.error = null;

    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/patches`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...buildApiHeaders()
        },
        body: JSON.stringify({
          patchId,
          patchAuthor,
          status
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || `Failed to update patch status: ${response.statusText}`);
      }

      // Reload state.patches to get updated status
      await loadPatches();
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to update patch status';
      console.error('Error updating patch status:', err);
    } finally {
      state.statusUpdates.patch[patchId] = false;
    }
  }

  async function updateIssueStatus(issueId: string, issueAuthor: string, status: 'open' | 'closed' | 'resolved' | 'draft') {
    if (!state.user.pubkeyHex) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    // Check if user is maintainer or issue author
    const isAuthor = state.user.pubkeyHex === issueAuthor;
    if (!state.maintainers.isMaintainer && !isAuthor) {
      alert('Only repository maintainers or issue authors can update issue status');
      return;
    }

    state.statusUpdates.issue = { ...state.statusUpdates.issue, [issueId]: true };
    state.error = null;

    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/issues`, {
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
        throw new Error(data.state.error || 'Failed to update issue status');
      }

      await loadIssues();
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to update issue status';
      console.error('Error updating issue status:', err);
    } finally {
      state.statusUpdates.issue = { ...state.statusUpdates.issue, [issueId]: false };
    }
  }

  async function loadPRs() {
    state.loading.prs = true;
    state.error = null;
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/prs`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        state.prs = data.map((pr: { id: string; tags: string[][]; content: string; status?: string; pubkey: string; created_at: number; commitId?: string; kind?: number }) => ({
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
      state.error = err instanceof Error ? err.message : 'Failed to load pull requests';
    } finally {
      state.loading.prs = false;
    }
  }

  async function createPR() {
    if (!state.forms.pr.subject.trim() || !state.forms.pr.content.trim() || !state.forms.pr.commitId.trim()) {
      alert('Please enter a subject, content, and commit ID');
      return;
    }

    if (!state.user.pubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    state.saving = true;
    state.error = null;

    try {
      const { PRsService } = await import('$lib/services/nostr/prs-service.js');
      const { getGitUrl } = await import('$lib/config.js');
      
      const decoded = nip19.decode(state.npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      // Get user's relays and combine with defaults
      const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const { outbox } = await getUserRelays(state.user.pubkey, tempClient);
      const combinedRelays = combineRelays(outbox);

      const cloneUrl = getGitUrl(state.npub, state.repo);
      const prsService = new PRsService(combinedRelays);
      const pr = await prsService.createPullRequest(
        repoOwnerPubkey,
        state.repo,
        state.forms.pr.subject.trim(),
        state.forms.pr.content.trim(),
        state.forms.pr.commitId.trim(),
        cloneUrl,
        state.forms.pr.branchName.trim() || undefined,
        state.forms.pr.labels.filter(l => l.trim())
      );

      state.openDialog = null;
      state.forms.pr.subject = '';
      state.forms.pr.content = '';
      state.forms.pr.commitId = '';
      state.forms.pr.branchName = '';
      state.forms.pr.labels = [''];
      await loadPRs();
      alert('Pull request created successfully!');
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to create pull request';
      console.error('Error creating PR:', err);
    } finally {
      state.saving = false;
    }
  }

  async function createPatch() {
    if (!state.forms.patch.content.trim()) {
      alert('Please enter patch content');
      return;
    }

    if (!state.user.pubkey || !state.user.pubkeyHex) {
      alert('Please connect your NIP-07 extension');
      return;
    }

    state.creating.patch = true;
    state.error = null;

    try {
      const decoded = nip19.decode(state.npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;
      state.metadata.address = `${KIND.REPO_ANNOUNCEMENT}:${repoOwnerPubkey}:${state.repo}`;

      // Get user's relays and combine with defaults
      const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const { outbox } = await getUserRelays(state.user.pubkey, tempClient);
      const combinedRelays = combineRelays(outbox);

      // Create patch event (kind 1617)
      const patchEventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
        kind: KIND.PATCH,
        pubkey: state.user.pubkeyHex,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['a', state.metadata.address],
          ['p', repoOwnerPubkey],
          ['t', 'root']
        ],
        content: state.forms.patch.content.trim()
      };

      // Add subject if provided
      if (state.forms.patch.subject.trim()) {
        patchEventTemplate.tags.push(['subject', state.forms.patch.subject.trim()]);
      }

      // Sign the event using NIP-07
      const signedEvent = await signEventWithNIP07(patchEventTemplate);

      // Publish to all available relays
      const publishClient = new NostrClient(combinedRelays);
      const result = await publishClient.publishEvent(signedEvent, combinedRelays);

      if (result.failed.length > 0 && result.success.length === 0) {
        throw new Error('Failed to publish patch to all relays');
      }

      state.openDialog = null;
      state.forms.patch.content = '';
      state.forms.patch.subject = '';
      alert('Patch created successfully!');
      // Reload state.patches
      await loadPatches();
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to create patch';
      console.error('Error creating patch:', err);
    } finally {
      state.creating.patch = false;
    }
  }

  async function loadPatches() {
    if (state.repoNotFound) return;
    state.loading.patches = true;
    state.error = null;
    try {
      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/patches`, {
        headers: buildApiHeaders()
      });
      if (response.ok) {
        const data = await response.json();
        state.patches = data.map((patch: { id: string; tags: string[][]; content: string; pubkey: string; created_at: number; kind?: number; status?: string }) => {
          // Extract subject/title from various sources
          let subject = patch.tags.find((t: string[]) => t[0] === 'subject')?.[1];
          const description = patch.tags.find((t: string[]) => t[0] === 'description')?.[1];
          const alt = patch.tags.find((t: string[]) => t[0] === 'alt')?.[1];
          
          // If no subject tag, try description or alt
          if (!subject) {
            if (description) {
              subject = description.trim();
            } else if (alt) {
              // Remove "git patch: " prefix if present
              subject = alt.replace(/^git patch:\s*/i, '').trim();
            } else {
              // Try to extract from patch content (git patch format)
              const subjectMatch = patch.content.match(/^Subject:\s*\[PATCH[^\]]*\]\s*(.+)$/m);
              if (subjectMatch) {
                subject = subjectMatch[1].trim();
              } else {
                // Try simpler Subject: line
                const simpleSubjectMatch = patch.content.match(/^Subject:\s*(.+)$/m);
                if (simpleSubjectMatch) {
                  subject = simpleSubjectMatch[1].trim();
                }
              }
            }
          }
          
          return {
            id: patch.id,
            subject: subject || 'Untitled',
            content: patch.content,
            status: patch.status || 'open',
            author: patch.pubkey,
            created_at: patch.created_at,
            kind: patch.kind || KIND.PATCH,
            description: description?.trim(),
            tags: patch.tags || []
          };
        });
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to load state.patches';
      console.error('Error state.loading.main state.patches:', err);
    } finally {
      state.loading.patches = false;
    }
  }

  async function loadPatchHighlights(patchId: string, patchAuthor: string) {
    if (!patchId || !patchAuthor) return;
    
    state.loading.patchHighlights = true;
    try {
      const decoded = nip19.decode(state.npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      const response = await fetch(
        `/api/repos/${state.npub}/${state.repo}/highlights?patchId=${patchId}&patchAuthor=${patchAuthor}`
      );
      if (response.ok) {
        const data = await response.json();
        state.patchHighlights = data.highlights || [];
        state.patchComments = data.comments || [];
      }
    } catch (err) {
      console.error('Failed to load patch highlights:', err);
    } finally {
      state.loading.patchHighlights = false;
    }
  }

  function handlePatchCodeSelection(
    text: string,
    startLine: number,
    endLine: number,
    startPos: number,
    endPos: number
  ) {
    if (!text.trim() || !state.user.pubkey) return;
    
    state.forms.patchHighlight.text = text;
    state.forms.patchHighlight.startLine = startLine;
    state.forms.patchHighlight.endLine = endLine;
    state.forms.patchHighlight.startPos = startPos;
    state.forms.patchHighlight.endPos = endPos;
    state.openDialog = 'patchHighlight';
  }

  async function createPatchHighlight() {
    if (!state.user.pubkey || !state.forms.patchHighlight.text.trim() || !state.selected.patch) return;

    const patch = state.patches.find(p => p.id === state.selected.patch);
    if (!patch) return;

    state.creating.patchHighlight = true;
    state.error = null;

    try {
      const decoded = nip19.decode(state.npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      const eventTemplate = highlightsService.createHighlightEvent(
        state.forms.patchHighlight.text,
        patch.id,
        patch.author,
        repoOwnerPubkey,
        state.repo,
        KIND.PATCH, // targetKind
        undefined, // filePath
        state.forms.patchHighlight.startLine, // lineStart
        state.forms.patchHighlight.endLine, // lineEnd
        undefined, // context
        state.forms.patchHighlight.comment.trim() || undefined // comment
      );

      const signedEvent = await signEventWithNIP07(eventTemplate);
      
      const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const { outbox } = await getUserRelays(state.user.pubkey, tempClient);
      const combinedRelays = combineRelays(outbox);

      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/highlights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'highlight',
          event: signedEvent,
          userPubkey: state.user.pubkey
        })
      });

      if (response.ok) {
        state.openDialog = null;
        state.forms.patchHighlight.text = '';
        state.forms.patchHighlight.comment = '';
        await loadPatchHighlights(patch.id, patch.author);
      } else {
        const data = await response.json();
        state.error = data.state.error || 'Failed to create highlight';
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to create highlight';
    } finally {
      state.creating.patchHighlight = false;
    }
  }

  function formatPubkey(pubkey: string): string {
    try {
      return nip19.npubEncode(pubkey);
    } catch {
      return pubkey.slice(0, 8) + '...';
    }
  }

  function startPatchComment(parentId?: string) {
    if (!state.user.pubkey) {
      alert('Please connect your NIP-07 extension');
      return;
    }
    state.forms.patchComment.replyingTo = parentId || null;
    state.openDialog = 'patchComment';
  }

  async function createPatchComment() {
    if (!state.user.pubkey || !state.forms.patchComment.content.trim() || !state.selected.patch) return;

    const patch = state.patches.find(p => p.id === state.selected.patch);
    if (!patch) return;

    state.creating.patchComment = true;
    state.error = null;

    try {
      const decoded = nip19.decode(state.npub);
      if (decoded.type !== 'npub') {
        throw new Error('Invalid npub format');
      }
      const repoOwnerPubkey = decoded.data as string;

      const rootEventId = state.forms.patchComment.replyingTo || patch.id;
      const rootEventKind = state.forms.patchComment.replyingTo ? KIND.COMMENT : KIND.PATCH;
      const rootPubkey = state.forms.patchComment.replyingTo ? 
        (state.patchComments.find(c => c.id === state.forms.patchComment.replyingTo)?.pubkey || patch.author) :
        patch.author;

      let parentEventId: string | undefined;
      let parentEventKind: number | undefined;
      let parentPubkey: string | undefined;

      if (state.forms.patchComment.replyingTo) {
        // Reply to a comment
        const parentComment = state.patchComments.find(c => c.id === state.forms.patchComment.replyingTo) || 
                             state.patchHighlights.flatMap(h => h.comments || []).find(c => c.id === state.forms.patchComment.replyingTo);
        if (parentComment) {
          parentEventId = state.forms.patchComment.replyingTo;
          parentEventKind = KIND.COMMENT;
          parentPubkey = parentComment.pubkey;
        }
      }

      const eventTemplate = highlightsService.createCommentEvent(
        state.forms.patchComment.content.trim(),
        rootEventId,
        rootEventKind,
        rootPubkey,
        parentEventId,
        parentEventKind,
        parentPubkey
      );

      const signedEvent = await signEventWithNIP07(eventTemplate);
      
      const tempClient = new NostrClient(DEFAULT_NOSTR_RELAYS);
      const { outbox } = await getUserRelays(state.user.pubkey, tempClient);
      const combinedRelays = combineRelays(outbox);

      const response = await fetch(`/api/repos/${state.npub}/${state.repo}/highlights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'comment',
          event: signedEvent,
          userPubkey: state.user.pubkey
        })
      });

      if (response.ok) {
        state.openDialog = null;
        state.forms.patchComment.content = '';
        state.forms.patchComment.replyingTo = null;
        await loadPatchHighlights(patch.id, patch.author);
      } else {
        const data = await response.json();
        state.error = data.state.error || 'Failed to create comment';
      }
    } catch (err) {
      state.error = err instanceof Error ? err.message : 'Failed to create comment';
    } finally {
      state.creating.patchComment = false;
    }
  }

  // Load highlights when a patch is selected
  $effect(() => {
    if (!state.isMounted || !state.selected.patch) return;
    const patch = state.patches.find(p => p.id === state.selected.patch);
    if (patch) {
      loadPatchHighlights(patch.id, patch.author).catch(err => {
        if (state.isMounted) console.warn('Failed to load patch highlights:', err);
      });
    }
  });

  // Only load tab content when tab actually changes, not on every render
  let lastTab: string | null = null;
  $effect(() => {
    if (!state.isMounted) return;
    if (state.ui.activeTab !== lastTab) {
      lastTab = state.ui.activeTab;
      if (!state.isMounted) return;
      
      if (state.ui.activeTab === 'files') {
        // Files tab - ensure state.files.list are loaded and README is shown if available
        if (state.files.list.length === 0 || state.files.currentPath !== '') {
          loadFiles('').catch(err => {
            if (state.isMounted) console.warn('Failed to load files:', err);
          });
        } else if (state.files.list.length > 0 && !state.files.currentFile && state.isMounted) {
          // Files already loaded, ensure README is shown
          const readmeFile = findReadmeFile(state.files.list);
          if (readmeFile) {
            setTimeout(() => {
              if (state.isMounted) {
                loadFile(readmeFile.path).catch(err => {
                  if (state.isMounted) console.warn('Failed to load README file:', err);
                });
              }
            }, 100);
          }
        }
      } else if (state.ui.activeTab === 'history' && state.isMounted) {
        loadCommitHistory().catch(err => {
          if (state.isMounted) console.warn('Failed to load commit history:', err);
        });
      } else if (state.ui.activeTab === 'tags' && state.isMounted) {
        loadTags().catch(err => {
          if (state.isMounted) console.warn('Failed to load tags:', err);
        });
        loadReleases().catch(err => {
          if (state.isMounted) console.warn('Failed to load state.releases:', err);
        }); // Load state.releases to check for tag associations
      } else if (state.ui.activeTab === 'code-search') {
        // Code search is performed on demand, not auto-loaded
      } else if (state.ui.activeTab === 'issues' && state.isMounted) {
        loadIssues().catch(err => {
          if (state.isMounted) console.warn('Failed to load state.issues:', err);
        });
      } else if (state.ui.activeTab === 'prs' && state.isMounted) {
        loadPRs().catch(err => {
          if (state.isMounted) console.warn('Failed to load PRs:', err);
        });
      } else if (state.ui.activeTab === 'docs' && state.isMounted) {
        loadDocumentation().catch(err => {
          if (state.isMounted) console.warn('Failed to load documentation:', err);
        });
      } else if (state.ui.activeTab === 'discussions' && state.isMounted) {
        loadDiscussions().catch(err => {
          if (state.isMounted) console.warn('Failed to load state.discussions:', err);
        });
      } else if (state.ui.activeTab === 'patches' && state.isMounted) {
        loadPatches().catch(err => {
          if (state.isMounted) console.warn('Failed to load state.patches:', err);
        });
      }
    }
  });

  // Reload all branch-dependent data when branch changes
  let lastBranch: string | null = null;
  $effect(() => {
    if (!state.isMounted) return;
    if (state.git.currentBranch && state.git.currentBranch !== lastBranch) {
      lastBranch = state.git.currentBranch;
      if (!state.isMounted) return;
      
      // Reload README (always branch-specific)
      loadReadme().catch(err => {
        if (state.isMounted) console.warn('Failed to reload README after branch change:', err);
      });
      
      // Reload state.files.list if state.files.list tab is active
      if (state.ui.activeTab === 'files' && state.isMounted) {
        if (state.files.currentFile) {
          loadFile(state.files.currentFile).catch(err => {
            if (state.isMounted) console.warn('Failed to reload file after branch change:', err);
          });
        } else {
          loadFiles(state.files.currentPath).catch(err => {
            if (state.isMounted) console.warn('Failed to reload state.files.list after branch change:', err);
          });
        }
      }
      
      // Reload commit history if history tab is active
      if (state.ui.activeTab === 'history' && state.isMounted) {
        loadCommitHistory().catch(err => {
          if (state.isMounted) console.warn('Failed to reload commit history after branch change:', err);
        });
      }
      
      // Reload documentation if docs tab is active (reset to force reload)
      if (state.ui.activeTab === 'docs' && state.isMounted) {
        state.docs.html = null;
        state.docs.content = null;
        state.docs.kind = null;
        loadDocumentation().catch(err => {
          if (state.isMounted) console.warn('Failed to reload documentation after branch change:', err);
        });
      }
    }
  });
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
            {#if state.clone.isCloned === true}
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
    
    {#if state.clone.isCloned === false && !canUseApiFallback && tabs.length === 0}
      <div class="repo-not-cloned-message">
        <div class="message-content">
          <h2>Repository Not Cloned</h2>
          <p>This repository has not been cloned to the server yet, and read-only access via external clone URLs is not available.</p>
          {#if hasUnlimitedAccess($userStore.userLevel)}
            <p>Use the "Clone to Server" option in the repository menu to clone this repository.</p>
          {:else}
            <p>Contact a server administrator with unlimited access to clone this repository.</p>
          {/if}
        </div>
      </div>
    {:else}
    <div class="repo-layout">
      <!-- Files Tab -->
      {#if state.ui.activeTab === 'files' && canViewRepo}
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
        />
      {/if}

      <!-- History Tab -->
      {#if state.ui.activeTab === 'history' && canViewRepo}
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
        onTabChange={(tab) => state.ui.activeTab = tab as typeof state.ui.activeTab}
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
      {#if state.ui.activeTab === 'code-search' && canViewRepo}
      <aside class="code-search-sidebar" class:hide-on-mobile={!state.ui.showLeftPanelOnMobile && state.ui.activeTab === 'code-search'}>
        <div class="code-search-header">
          <TabsMenu 
            activeTab={state.ui.activeTab} 
            {tabs} 
            onTabChange={(tab) => state.ui.activeTab = tab as typeof state.ui.activeTab}
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
              
              if (!confirm('Apply this patch to the repository? This will create a commit with the patch changes.')) {
                return;
              }
              
              const authorEmail = await fetchUserEmail(state.user.pubkeyHex || '', state.user.pubkey || undefined);
              const authorName = await fetchUserName(state.user.pubkeyHex || '', state.user.pubkey || undefined);
              
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
                  branch: state.git.currentBranch || state.git.defaultBranch || 'main'
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
        />
      {/if}

      <!-- Discussions Tab -->
      {#if state.ui.activeTab === 'discussions'}
        <DiscussionsTab
          npub={state.npub}
          repo={state.repo}
          repoAnnouncement={repoAnnouncement}
          userPubkey={state.user.pubkey}
        />
      {/if}

      <!-- Docs Tab -->
      {#if state.ui.activeTab === 'docs'}
        <DocsTab
          npub={state.npub}
          repo={state.repo}
          currentBranch={state.git.currentBranch || null}
          relays={[...DEFAULT_NOSTR_RELAYS, ...DEFAULT_NOSTR_SEARCH_RELAYS]}
        />
      {/if}

      <!-- Files tab content is now handled by FilesTab component -->

        <!-- History tab content is now handled by HistoryTab component -->

        <!-- Tags content is now handled by TagsTab component -->


        {#if state.ui.activeTab === 'code-search' && canViewRepo}
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
          </div>
        {/if}

        <!-- Issues tab content is now handled by IssuesTab component -->

        <!-- PRs tab content is now handled by PRsTab component -->

        <!-- Patches tab content is now handled by PatchesTab component -->


        <!-- Docs tab content is now handled by DocsTab component -->
      </div>
    {/if}
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
