/**
 * Issue operations service
 * Handles issue loading, creation, status updates, and replies
 */

import type { RepoState } from '../stores/repo-state.js';
import { apiRequest } from '../utils/api-client.js';
import { nip19 } from 'nostr-tools';
import { NostrClient } from '$lib/services/nostr/nostr-client.js';
import { DEFAULT_NOSTR_RELAYS, combineRelays } from '$lib/config.js';
import { getUserRelays } from '$lib/services/nostr/user-relays.js';
import { KIND } from '$lib/types/nostr.js';
import type { NostrEvent } from '$lib/types/nostr.js';

interface IssueOperationsCallbacks {
  loadIssues: () => Promise<void>;
  loadIssueReplies: (issueId: string) => Promise<void>;
  nostrClient: NostrClient;
}

/**
 * Load issues from the repository
 */
export async function loadIssues(
  state: RepoState,
  callbacks: IssueOperationsCallbacks
): Promise<void> {
  state.loading.issues = true;
  state.error = null;
  try {
    const data = await apiRequest<Array<{
      id: string;
      tags: string[][];
      content: string;
      status?: string;
      pubkey: string;
      created_at: number;
      kind?: number;
    }>>(`/api/repos/${state.npub}/${state.repo}/issues`);
    
    state.issues = data.map((issue) => ({
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
      callbacks.loadIssueReplies(state.issues[0].id);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Failed to load issues';
    console.error('[Issues] Error loading issues:', err);
    state.error = errorMessage;
  } finally {
    state.loading.issues = false;
  }
}

/**
 * Load replies for an issue
 */
export async function loadIssueReplies(
  issueId: string,
  state: RepoState,
  callbacks: IssueOperationsCallbacks
): Promise<void> {
  state.loading.issueReplies = true;
  try {
    const replies = await callbacks.nostrClient.fetchEvents([
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
    console.error('[Issues] Error loading replies:', err);
    state.issueReplies = [];
  } finally {
    state.loading.issueReplies = false;
  }
}

/**
 * Create a new issue
 */
export async function createIssue(
  state: RepoState,
  callbacks: IssueOperationsCallbacks
): Promise<void> {
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
    await issuesService.createIssue(
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
    await callbacks.loadIssues();
    alert('Issue created successfully!');
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to create issue';
    console.error('Error creating issue:', err);
  } finally {
    state.saving = false;
  }
}

/**
 * Update issue status
 */
export async function updateIssueStatus(
  issueId: string,
  issueAuthor: string,
  status: 'open' | 'closed' | 'resolved' | 'draft',
  state: RepoState,
  callbacks: IssueOperationsCallbacks
): Promise<void> {
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
    await apiRequest(`/api/repos/${state.npub}/${state.repo}/issues`, {
      method: 'PATCH',
      body: JSON.stringify({
        issueId,
        issueAuthor,
        status
      })
    } as RequestInit);

    await callbacks.loadIssues();
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to update issue status';
    console.error('Error updating issue status:', err);
  } finally {
    state.statusUpdates.issue = { ...state.statusUpdates.issue, [issueId]: false };
  }
}
