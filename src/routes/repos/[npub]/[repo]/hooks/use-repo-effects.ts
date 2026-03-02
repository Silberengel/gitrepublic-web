/**
 * Repository effects hooks
 * Extracted $effect blocks from +page.svelte for better organization
 * 
 * Note: These hooks must be called from within a Svelte component context
 * where $page and $userStore runes are available
 */

import { settingsStore } from '$lib/services/settings-store.js';
import type { RepoState } from '../stores/repo-state.js';

/**
 * Sync pageData from $page store
 * Returns effect callback that should be called within $effect in component
 */
export function usePageDataEffect(state: RepoState, getPageData: () => any): () => void {
  return () => {
    if (typeof window === 'undefined' || !state.isMounted) return;
    try {
      const data = getPageData();
      if (data && state.isMounted) {
        state.pageData = data || {};
        
        // Only set repoNotFound if explicitly set to true AND we've verified the repo doesn't exist
        // Don't set it just because announcement is null - the repo might exist but announcement not found yet
        if (data.repoNotFound === true) {
          // Check if repo actually exists by trying to verify via API
          // If repo exists (e.g., branches endpoint returns 200), don't show "not found"
          fetch(`/api/repos/${state.npub}/${state.repo}/branches?skipApiFallback=true`)
            .then(response => {
              if (state.isMounted) {
                if (response.ok || response.status === 200) {
                  // Repo exists! Clear repoNotFound even if announcement is missing
                  console.log(`[Page Data Effect] Repo exists (status ${response.status}), clearing repoNotFound flag`);
                  state.repoNotFound = false;
                } else if (response.status === 404) {
                  // Repo truly doesn't exist
                  console.log(`[Page Data Effect] Repo doesn't exist (status 404), setting repoNotFound`);
                  state.repoNotFound = true;
                  state.loading.main = false;
                } else {
                  // Other error - don't assume repo doesn't exist
                  console.log(`[Page Data Effect] Repo check returned status ${response.status}, keeping current state`);
                }
              }
            })
            .catch(err => {
              if (state.isMounted) {
                console.warn('[Page Data Effect] Failed to verify repo existence:', err);
                // On error checking, if repoNotFound was explicitly set, keep it
                // Otherwise, don't assume repo doesn't exist
                if (data.repoNotFound === true) {
                  state.repoNotFound = true;
                  state.loading.main = false;
                }
              }
            });
        } else if (data.announcement) {
          // Clear repoNotFound if we have a valid announcement
          state.repoNotFound = false;
        } else {
          // Announcement is null but repoNotFound wasn't explicitly set
          // Don't set repoNotFound - let the component try to load the repo anyway
          // The repo might exist but announcement not found yet (e.g., private fork)
          console.log('[Page Data Effect] Announcement is null but repoNotFound not explicitly set - allowing page to load');
        }
      }
    } catch (err) {
      if (state.isMounted) {
        console.warn('Failed to update pageData:', err);
        // On error, don't automatically mark as not found - might be a transient error
      }
    }
  };
}

/**
 * Sync params from $page store
 * Returns effect callback that should be called within $effect in component
 */
export function usePageParamsEffect(state: RepoState, getPageParams: () => { npub?: string; repo?: string }): () => void {
  return () => {
    if (typeof window === 'undefined' || !state.isMounted) return;
    try {
      const params = getPageParams();
      if (params && state.isMounted) {
        if (params.npub && params.npub !== state.npub) state.npub = params.npub;
        if (params.repo && params.repo !== state.repo) state.repo = params.repo;
      }
    } catch {
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
  };
}

/**
 * Load maintainers when repo data is available
 * Returns effect callback that should be called within $effect in component
 */
export function useMaintainersEffect(
  state: RepoState,
  getRepoOwnerPubkey: () => string,
  getRepoMaintainers: () => string[],
  loadAllMaintainers: () => Promise<void>,
  getPageData: () => any
): () => void {
  return () => {
    if (typeof window === 'undefined' || !state.isMounted) return;
    try {
      const data = getPageData();
      if (!data || !state.isMounted) return;
      
      const currentRepoKey = `${state.npub}/${state.repo}`;
      
      if (currentRepoKey !== state.maintainers.lastRepoKey && state.isMounted) {
        state.maintainers.loaded = false;
        state.maintainers.effectRan = false;
        state.maintainers.lastRepoKey = currentRepoKey;
      }
      
      const repoOwnerPubkeyDerived = getRepoOwnerPubkey();
      const repoMaintainers = getRepoMaintainers();
      
      if (state.isMounted && 
          (repoOwnerPubkeyDerived || (repoMaintainers && repoMaintainers.length > 0)) && 
          !state.maintainers.effectRan && 
          !state.loading.maintainers) {
        state.maintainers.effectRan = true;
        state.maintainers.loaded = true;
        loadAllMaintainers().catch(err => {
          if (!state.isMounted) return;
          state.maintainers.loaded = false;
          state.maintainers.effectRan = false;
          console.warn('Failed to load maintainers:', err);
        });
      }
    } catch (err) {
      if (state.isMounted) {
        console.warn('Maintainers effect error:', err);
      }
    }
  };
}

/**
 * Watch auto-save settings and manage auto-save interval
 * Returns effect callback that should be called within $effect in component
 */
export function useAutoSaveEffect(
  state: RepoState,
  autoSaveInterval: { value: ReturnType<typeof setInterval> | null },
  setupAutoSave: () => void
): () => void {
  return () => {
    if (!state.isMounted) return;
    settingsStore.getSettings().then(settings => {
      if (!state.isMounted) return;
      if (settings.autoSave && !autoSaveInterval.value) {
        setupAutoSave();
      } else if (!settings.autoSave && autoSaveInterval.value) {
        if (autoSaveInterval.value) {
          clearInterval(autoSaveInterval.value);
          autoSaveInterval.value = null;
        }
      }
    }).catch(err => {
      if (state.isMounted) {
        console.warn('Failed to check auto-save setting:', err);
      }
    });
  };
}

/**
 * Sync user state from userStore and reload data on login/logout
 * Returns effect callback that should be called within $effect in component
 */
export function useUserStoreEffect(
  state: RepoState,
  cachedUserData: { email: string | null; name: string | null },
  getUserStore: () => any,
  callbacks: {
    checkMaintainerStatus: () => Promise<void>;
    loadBookmarkStatus: () => Promise<void>;
    loadAllMaintainers: () => Promise<void>;
    checkCloneStatus: (force: boolean) => Promise<void>;
    loadBranches: () => Promise<void>;
    loadFiles: (path?: string) => Promise<void>;
    loadReadme: () => Promise<void>;
    loadTags: () => Promise<void>;
    loadDiscussions: () => Promise<void>;
  }
): () => void {
  return () => {
    if (!state.isMounted) return;
    try {
      const currentUser = getUserStore();
      if (!currentUser || !state.isMounted) return;
      
      const wasLoggedIn = state.user.pubkey !== null || state.user.pubkeyHex !== null;
      
      if (currentUser.userPubkey && currentUser.userPubkeyHex && state.isMounted) {
        const wasDifferent = state.user.pubkey !== currentUser.userPubkey || state.user.pubkeyHex !== currentUser.userPubkeyHex;
        state.user.pubkey = currentUser.userPubkey;
        state.user.pubkeyHex = currentUser.userPubkeyHex;
        
        if (wasDifferent && state.isMounted) {
          state.loading.repoNotFound = false;
          cachedUserData.email = null;
          cachedUserData.name = null;
          
          if (!state.isMounted) return;
          callbacks.checkMaintainerStatus().catch(err => {
            if (state.isMounted) console.warn('Failed to reload maintainer status after login:', err);
          });
          callbacks.loadBookmarkStatus().catch(err => {
            if (state.isMounted) console.warn('Failed to reload bookmark status after login:', err);
          });
          state.maintainers.loaded = false;
          state.maintainers.effectRan = false;
          state.maintainers.lastRepoKey = null;
          callbacks.loadAllMaintainers().catch(err => {
            if (state.isMounted) console.warn('Failed to reload maintainers after login:', err);
          });
          setTimeout(() => {
            if (state.isMounted) {
              callbacks.checkCloneStatus(true).catch(err => {
                if (state.isMounted) console.warn('Failed to recheck clone status after login:', err);
              });
            }
          }, 100);
          if (!state.loading.main && state.isMounted) {
            callbacks.loadBranches().catch(err => {
              if (state.isMounted) console.warn('Failed to reload branches after login:', err);
            });
            callbacks.loadFiles().catch(err => {
              if (state.isMounted) console.warn('Failed to reload files after login:', err);
            });
            callbacks.loadReadme().catch(err => {
              if (state.isMounted) console.warn('Failed to reload readme after login:', err);
            });
            callbacks.loadTags().catch(err => {
              if (state.isMounted) console.warn('Failed to reload tags after login:', err);
            });
            callbacks.loadDiscussions().catch(err => {
              if (state.isMounted) console.warn('Failed to reload discussions after login:', err);
            });
          }
        }
      } else if (state.isMounted) {
        state.user.pubkey = null;
        state.user.pubkeyHex = null;
        cachedUserData.email = null;
        cachedUserData.name = null;
        
        if (wasLoggedIn && state.isMounted) {
          callbacks.checkMaintainerStatus().catch(err => {
            if (state.isMounted) console.warn('Failed to reload maintainer status after logout:', err);
          });
          callbacks.loadBookmarkStatus().catch(err => {
            if (state.isMounted) console.warn('Failed to reload bookmark status after logout:', err);
          });
          state.maintainers.loaded = false;
          state.maintainers.effectRan = false;
          state.maintainers.lastRepoKey = null;
          callbacks.loadAllMaintainers().catch(err => {
            if (state.isMounted) console.warn('Failed to reload maintainers after logout:', err);
          });
          if (!state.loading.main && state.ui.activeTab === 'files' && state.isMounted) {
            callbacks.loadFiles().catch(err => {
              if (state.isMounted) console.warn('Failed to reload files after logout:', err);
            });
          }
        }
      }
    } catch (err) {
      if (state.isMounted) {
        console.warn('User store sync error:', err);
      }
    }
  };
}

/**
 * Handle tab switching when clone status changes
 * Returns effect callback that should be called within $effect in component
 */
export function useTabSwitchEffect(
  state: RepoState,
  tabs: Array<{ id: string }>,
  canUseApiFallback: boolean
): () => void {
  return () => {
    if (!state.isMounted) return;
    if (state.clone.isCloned === false && !canUseApiFallback && tabs.length > 0) {
      const currentTab = tabs.find(t => t.id === state.ui.activeTab);
      if (!currentTab && state.isMounted) {
        state.ui.activeTab = tabs[0].id as typeof state.ui.activeTab;
      }
    }
  };
}

/**
 * Update repo images from pageData
 * Returns effect callback that should be called within $effect in component
 */
export function useRepoImagesEffect(state: RepoState, getPageData: () => any): () => void {
  return () => {
    if (typeof window === 'undefined' || !state.isMounted) return;
    try {
      const data = getPageData();
      if (!data || !state.isMounted) return;
      if (data.image && data.image !== state.metadata.image && state.isMounted) {
        state.metadata.image = data.image;
        console.log('[Repo Images] Updated image from pageData (reactive):', state.metadata.image);
      }
      if (data.banner && data.banner !== state.metadata.banner && state.isMounted) {
        state.metadata.banner = data.banner;
        console.log('[Repo Images] Updated banner from pageData (reactive):', state.metadata.banner);
      }
    } catch (err) {
      if (state.isMounted) {
        console.warn('Image update effect error:', err);
      }
    }
  };
}

/**
 * Load patch highlights when patch is selected
 * Returns effect callback that should be called within $effect in component
 */
export function usePatchHighlightsEffect(
  state: RepoState,
  loadPatchHighlights: (patchId: string, author: string) => Promise<void>
): () => void {
  return () => {
    if (!state.isMounted || !state.selected.patch) return;
    const patch = state.patches.find(p => p.id === state.selected.patch);
    if (patch) {
      loadPatchHighlights(patch.id, patch.author).catch(err => {
        if (state.isMounted) console.warn('Failed to load patch highlights:', err);
      });
    }
  };
}

/**
 * Load tab content when tab changes
 * Returns effect callback that should be called within $effect in component
 */
export function useTabChangeEffect(
  state: RepoState,
  lastTab: { value: string | null },
  findReadmeFile: (files: Array<{ name: string; path: string; type: 'file' | 'directory' }>) => { name: string; path: string; type: 'file' | 'directory' } | null,
  callbacks: {
    loadFiles: (path?: string) => Promise<void>;
    loadFile: (path: string) => Promise<void>;
    loadCommitHistory: () => Promise<void>;
    loadTags: () => Promise<void>;
    loadReleases: () => Promise<void>;
    loadIssues: () => Promise<void>;
    loadPRs: () => Promise<void>;
    loadDocumentation: () => Promise<void>;
    loadDiscussions: () => Promise<void>;
    loadPatches: () => Promise<void>;
  }
): () => void {
  return () => {
    if (!state.isMounted) return;
    if (state.ui.activeTab !== lastTab.value) {
      lastTab.value = state.ui.activeTab;
      if (!state.isMounted) return;
      
      if (state.ui.activeTab === 'files') {
        if (state.files.list.length === 0 || state.files.currentPath !== '') {
          callbacks.loadFiles('').catch(err => {
            if (state.isMounted) console.warn('Failed to load files:', err);
          });
        } else if (state.files.list.length > 0 && !state.files.currentFile && state.isMounted) {
          const readmeFile = findReadmeFile(state.files.list);
          if (readmeFile) {
            setTimeout(() => {
              if (state.isMounted) {
                callbacks.loadFile(readmeFile.path).catch(err => {
                  if (state.isMounted) console.warn('Failed to load README file:', err);
                });
              }
            }, 100);
          }
        }
      } else if (state.ui.activeTab === 'history' && state.isMounted) {
        callbacks.loadCommitHistory().catch(err => {
          if (state.isMounted) console.warn('Failed to load commit history:', err);
        });
      } else if (state.ui.activeTab === 'tags' && state.isMounted) {
        callbacks.loadTags().catch(err => {
          if (state.isMounted) console.warn('Failed to load tags:', err);
        });
        callbacks.loadReleases().catch(err => {
          if (state.isMounted) console.warn('Failed to load releases:', err);
        });
      } else if (state.ui.activeTab === 'code-search') {
        // Code search is performed on demand, not auto-loaded
      } else if (state.ui.activeTab === 'issues' && state.isMounted) {
        callbacks.loadIssues().catch(err => {
          if (state.isMounted) console.warn('Failed to load issues:', err);
        });
      } else if (state.ui.activeTab === 'prs' && state.isMounted) {
        callbacks.loadPRs().catch(err => {
          if (state.isMounted) console.warn('Failed to load PRs:', err);
        });
      } else if (state.ui.activeTab === 'docs' && state.isMounted) {
        callbacks.loadDocumentation().catch(err => {
          if (state.isMounted) console.warn('Failed to load documentation:', err);
        });
      } else if (state.ui.activeTab === 'discussions' && state.isMounted) {
        callbacks.loadDiscussions().catch(err => {
          if (state.isMounted) console.warn('Failed to load discussions:', err);
        });
      } else if (state.ui.activeTab === 'patches' && state.isMounted) {
        callbacks.loadPatches().catch(err => {
          if (state.isMounted) console.warn('Failed to load patches:', err);
        });
      }
    }
  };
}

/**
 * Reload branch-dependent data when branch changes
 * Returns effect callback that should be called within $effect in component
 */
export function useBranchChangeEffect(
  state: RepoState,
  lastBranch: { value: string | null },
  callbacks: {
    loadReadme: () => Promise<void>;
    loadFile: (path: string) => Promise<void>;
    loadFiles: (path: string) => Promise<void>;
    loadCommitHistory: () => Promise<void>;
    loadDocumentation: () => Promise<void>;
  }
): () => void {
  return () => {
    if (!state.isMounted) return;
    if (state.git.currentBranch && state.git.currentBranch !== lastBranch.value) {
      lastBranch.value = state.git.currentBranch;
      if (!state.isMounted) return;
      
      callbacks.loadReadme().catch(err => {
        if (state.isMounted) console.warn('Failed to reload README after branch change:', err);
      });
      
      if (state.ui.activeTab === 'files' && state.isMounted) {
        if (state.files.currentFile) {
          callbacks.loadFile(state.files.currentFile).catch(err => {
            if (state.isMounted) console.warn('Failed to reload file after branch change:', err);
          });
        } else {
          callbacks.loadFiles(state.files.currentPath).catch(err => {
            if (state.isMounted) console.warn('Failed to reload files after branch change:', err);
          });
        }
      }
      
      if (state.ui.activeTab === 'history' && state.isMounted) {
        callbacks.loadCommitHistory().catch(err => {
          if (state.isMounted) console.warn('Failed to reload commit history after branch change:', err);
        });
      }
      
      if (state.ui.activeTab === 'docs' && state.isMounted) {
        state.docs.html = null;
        state.docs.content = null;
        state.docs.kind = null;
        callbacks.loadDocumentation().catch(err => {
          if (state.isMounted) console.warn('Failed to reload documentation after branch change:', err);
        });
      }
    }
  };
}
