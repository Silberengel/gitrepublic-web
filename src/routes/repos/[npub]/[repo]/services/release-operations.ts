/**
 * Release operations service
 * Handles release loading and creation
 */

import type { RepoState } from '../stores/repo-state.js';
import { apiRequest, apiPost } from '../utils/api-client.js';
import type { NostrEvent } from '$lib/types/nostr.js';

interface ReleaseOperationsCallbacks {
  loadReleases: () => Promise<void>;
}

/**
 * Load releases from the repository
 */
export async function loadReleases(
  state: RepoState,
  callbacks: ReleaseOperationsCallbacks
): Promise<void> {
  if (state.repoNotFound) return;
  state.loading.releases = true;
  try {
    const data = await apiRequest<Array<NostrEvent>>(
      `/api/repos/${state.npub}/${state.repo}/releases`
    );
    state.releases = data.map((release: any) => ({
      id: release.id,
      title: release.tags.find((t: string[]) => t[0] === 'title')?.[1],
      tagName: release.tags.find((t: string[]) => t[0] === 'tag')?.[1] || '',
      tagHash: release.tags.find((t: string[]) => t[0] === 'r' && t[2] === 'tag')?.[1],
      releaseNotes: release.content || '',
      downloadUrl: release.tags.find((t: string[]) => t[0] === 'r' && t[2] === 'download')?.[1],
      isDraft: release.tags.some((t: string[]) => t[0] === 'draft' && t[1] === 'true'),
      isPrerelease: release.tags.some((t: string[]) => t[0] === 'prerelease' && t[1] === 'true'),
      created_at: release.created_at,
      pubkey: release.pubkey
    }));
  } catch (err) {
    console.error('Failed to load releases:', err);
  } finally {
    state.loading.releases = false;
  }
}

/**
 * Create a new release
 */
export async function createRelease(
  state: RepoState,
  repoOwnerPubkeyDerived: string,
  callbacks: ReleaseOperationsCallbacks
): Promise<void> {
  if (!state.forms.release.tagName.trim() || !state.forms.release.tagHash.trim()) {
    alert('Please enter a tag name and tag hash');
    return;
  }

  if (!state.user.pubkey) {
    alert('Please connect your NIP-07 extension');
    return;
  }

  if (!state.maintainers.isMaintainer && state.user.pubkeyHex !== repoOwnerPubkeyDerived) {
    alert('Only repository owners and maintainers can create releases');
    return;
  }

    state.creating.release = true;
  state.error = null;

  try {
    await apiPost(`/api/repos/${state.npub}/${state.repo}/releases`, {
      title: state.forms.release.title,
      tagName: state.forms.release.tagName,
      tagHash: state.forms.release.tagHash,
      releaseNotes: state.forms.release.notes,
      downloadUrl: state.forms.release.downloadUrl,
      isDraft: state.forms.release.isDraft,
      isPrerelease: state.forms.release.isPrerelease
    });

    state.openDialog = null;
    state.forms.release.title = '';
    state.forms.release.tagName = '';
    state.forms.release.tagHash = '';
    state.forms.release.notes = '';
    state.forms.release.downloadUrl = '';
    state.forms.release.isDraft = false;
    state.forms.release.isPrerelease = false;
    await callbacks.loadReleases();
    alert('Release created successfully!');
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to create release';
    alert(state.error);
  } finally {
    state.creating.release = false;
  }
}
