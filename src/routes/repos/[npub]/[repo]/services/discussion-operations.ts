/**
 * Discussion operations service
 * Handles discussion loading, thread creation, and replies
 */

import type { RepoState } from '../stores/repo-state.js';
import { nip19 } from 'nostr-tools';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS, DEFAULT_NOSTR_SEARCH_RELAYS, combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { isNIP07Available, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { KIND } from '$lib/types/nostr.js';
import type { NostrEvent } from '$lib/types/nostr.js';
import { buildApiHeaders } from '../utils/api-client.js';

interface DiscussionOperationsCallbacks {
  loadDiscussions: () => Promise<void>;
  loadNostrLinks: (content: string) => Promise<void>;
  loadDiscussionEvents: (discussions: Array<{
    type: 'thread' | 'comments' | string;
    id: string;
    title: string;
    content: string;
    author: string;
    createdAt: number;
    kind?: number;
    pubkey?: string;
    comments?: Array<any>;
  }>) => Promise<void>;
}

/**
 * Load discussions from the repository
 */
export async function loadDiscussions(
  state: RepoState,
  repoOwnerPubkeyDerived: string,
  callbacks: DiscussionOperationsCallbacks
): Promise<void> {
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
    const { DiscussionsService } = await import('$lib/services/nostr/discussions-service.js');
    
    // Get user's relays if available
    let userRelays: string[] = [];
    // Try to get user pubkey from userStore first, then fallback to state
    let currentUserPubkey: string | null = null;
    try {
      const { userStore } = await import('$lib/stores/user-store.js');
      const { get } = await import('svelte/store');
      currentUserPubkey = get(userStore)?.userPubkey || state.user.pubkey || null;
    } catch {
      currentUserPubkey = state.user.pubkey || null;
    }
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
      kind: entry.kind ?? KIND.THREAD,
      pubkey: entry.pubkey ?? '',
      comments: entry.comments
    }));

    // Fetch full events for discussions and comments to get tags for blurbs
    await callbacks.loadDiscussionEvents(state.discussions);
    
    // Fetch nostr: links from discussion content
    for (const discussion of state.discussions) {
      if (discussion.content) {
        await callbacks.loadNostrLinks(discussion.content);
      }
      if (discussion.comments) {
        for (const comment of discussion.comments) {
          if (comment.content) {
            await callbacks.loadNostrLinks(comment.content);
          }
          if (comment.replies) {
            for (const reply of comment.replies) {
              if (reply.content) {
                await callbacks.loadNostrLinks(reply.content);
              }
              if (reply.replies) {
                for (const nestedReply of reply.replies) {
                  if (nestedReply.content) {
                    await callbacks.loadNostrLinks(nestedReply.content);
                  }
                }
              }
            }
          }
        }
      }
    }
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to load discussions';
    console.error('Error loading discussions:', err);
  } finally {
    state.loading.discussions = false;
  }
}

/**
 * Create a discussion thread
 */
export async function createDiscussionThread(
  state: RepoState,
  repoOwnerPubkeyDerived: string,
  callbacks: DiscussionOperationsCallbacks
): Promise<void> {
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
    await callbacks.loadDiscussions();
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to create discussion thread';
    console.error('Error creating discussion thread:', err);
  } finally {
    state.creating.thread = false;
  }
}

/**
 * Create a thread reply
 */
export async function createThreadReply(
  state: RepoState,
  repoOwnerPubkeyDerived: string,
  callbacks: DiscussionOperationsCallbacks
): Promise<void> {
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
        rootKind = state.discussion.replyingToThread.kind ?? KIND.THREAD;
        rootPubkey = state.discussion.replyingToThread.pubkey ?? state.discussion.replyingToThread.author ?? '';
      } else {
        // Comment is directly on announcement (in "Comments" pseudo-thread)
        rootEventId = announcement.id;
        rootKind = KIND.REPO_ANNOUNCEMENT;
        rootPubkey = announcement.pubkey;
      }

      // Parent is the comment we're replying to
      parentEventId = comment.id;
      parentKind = comment.kind ?? KIND.COMMENT;
      parentPubkey = comment.pubkey ?? comment.author ?? '';
    } else if (state.discussion.replyingToThread) {
      // Replying directly to a thread - use the thread object we already have
      rootEventId = state.discussion.replyingToThread.id;
      rootKind = state.discussion.replyingToThread.kind ?? KIND.THREAD;
      rootPubkey = state.discussion.replyingToThread.pubkey ?? state.discussion.replyingToThread.author ?? '';
      parentEventId = state.discussion.replyingToThread.id;
      parentKind = state.discussion.replyingToThread.kind ?? KIND.THREAD;
      parentPubkey = state.discussion.replyingToThread.pubkey ?? state.discussion.replyingToThread.author ?? '';
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

    // Reload discussions to show the new reply
    await callbacks.loadDiscussions();
    
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

/**
 * Load documentation from the repository
 */
export async function loadDocumentation(
  state: RepoState,
  repoOwnerPubkeyDerived: string,
  repoIsPrivate: boolean
): Promise<void> {
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
      }
    }
  } catch (err) {
    console.error('Error loading documentation:', err);
    state.docs.content = null;
    state.docs.html = null;
  } finally {
    state.loading.docs = false;
  }
}
