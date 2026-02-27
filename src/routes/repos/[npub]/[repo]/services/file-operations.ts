/**
 * File operations service
 * Handles file saving, creating, and deleting
 * Note: loadFile and loadFiles remain in component due to complex state dependencies
 */

import type { NostrEvent } from '$lib/types/nostr.js';
import type { RepoState } from '../stores/repo-state.js';
import { isNIP07Available, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { apiPost, apiRequest, buildApiHeaders } from '../utils/api-client.js';
import { isImageFileType, supportsPreview } from '../utils/file-processing.js';

interface FileOperationsCallbacks {
  getUserEmail: () => Promise<string>;
  getUserName: () => Promise<string>;
  loadFiles: (path: string) => Promise<void>;
  loadFile?: (path: string) => Promise<void>;
  renderFileAsHtml: (content: string, ext: string) => Promise<void>;
  applySyntaxHighlighting: (content: string, ext: string) => Promise<void>;
  findReadmeFile: (fileList: Array<{ name: string; path: string; type: 'file' | 'directory' }>) => { name: string; path: string; type: 'file' | 'directory' } | null;
  rewriteImagePaths: (html: string, filePath: string | null) => string;
}

/**
 * Save a file to the repository
 */
export async function saveFile(
  state: RepoState,
  callbacks: FileOperationsCallbacks
): Promise<void> {
  if (!state.files.currentFile || !state.forms.commit.message.trim()) {
    alert('Please enter a commit message');
    return;
  }

  if (!state.user.pubkey) {
    alert('Please connect your NIP-07 extension to save files');
    return;
  }

  if (!state.git.currentBranch || typeof state.git.currentBranch !== 'string') {
    alert('Please select a branch before saving the file');
    return;
  }

  state.saving = true;
  state.error = null;

  try {
    const authorEmail = await callbacks.getUserEmail();
    const authorName = await callbacks.getUserName();
    
    // Sign commit with NIP-07 (client-side)
    let commitSignatureEvent: NostrEvent | null = null;
    if (isNIP07Available()) {
      try {
        const { KIND } = await import('$lib/types/nostr.js');
        const timestamp = Math.floor(Date.now() / 1000);
        const eventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
          kind: KIND.COMMIT_SIGNATURE,
          pubkey: '',
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
      }
    }
    
    await apiPost(`/api/repos/${state.npub}/${state.repo}/file`, {
      path: state.files.currentFile,
      content: state.files.editedContent,
      commitMessage: state.forms.commit.message.trim(),
      authorName: authorName,
      authorEmail: authorEmail,
      branch: state.git.currentBranch,
      userPubkey: state.user.pubkey,
      commitSignatureEvent: commitSignatureEvent
    });

    if (callbacks.loadFile) {
      await callbacks.loadFile(state.files.currentFile);
    }
    state.forms.commit.message = '';
    state.openDialog = null;
    alert('File saved successfully!');
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to save file';
    console.error('Error saving file:', err);
  } finally {
    state.saving = false;
  }
}

/**
 * Create a new file in the repository
 */
export async function createFile(
  state: RepoState,
  callbacks: FileOperationsCallbacks
): Promise<void> {
  if (!state.forms.file.fileName.trim()) {
    alert('Please enter a file name');
    return;
  }

  if (!state.user.pubkey) {
    alert('Please connect your NIP-07 extension');
    return;
  }

  if (!state.git.currentBranch || typeof state.git.currentBranch !== 'string') {
    alert('Please select a branch before creating the file');
    return;
  }

  state.saving = true;
  state.error = null;

  try {
    const authorEmail = await callbacks.getUserEmail();
    const authorName = await callbacks.getUserName();
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
          pubkey: '',
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
      }
    }
    
    await apiPost(`/api/repos/${state.npub}/${state.repo}/file`, {
      path: filePath,
      content: state.forms.file.content,
      commitMessage: commitMsg,
      authorName: authorName,
      authorEmail: authorEmail,
      branch: state.git.currentBranch,
      action: 'create',
      userPubkey: state.user.pubkey,
      commitSignatureEvent: commitSignatureEvent
    });

    // Clear form
    state.forms.file.fileName = '';
    state.forms.file.content = '';
    state.openDialog = null;
    
    // Reload file list - use currentPath or empty string for root
    const pathToReload = state.files.currentPath || '';
    await callbacks.loadFiles(pathToReload);
    
    alert('File created successfully!');
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to create file';
    console.error('Error creating file:', err);
  } finally {
    state.saving = false;
  }
}

/**
 * Delete a file from the repository
 */
export async function deleteFile(
  filePath: string,
  state: RepoState,
  callbacks: FileOperationsCallbacks
): Promise<void> {
  if (!confirm(`Are you sure you want to delete "${filePath}"?\n\nThis will permanently delete the file from the repository. This action cannot be undone.\n\nClick OK to delete, or Cancel to abort.`)) {
    return;
  }

  if (!state.user.pubkey) {
    alert('Please connect your NIP-07 extension');
    return;
  }

  if (!state.git.currentBranch || typeof state.git.currentBranch !== 'string') {
    alert('Please select a branch before deleting the file');
    return;
  }

  state.saving = true;
  state.error = null;

  try {
    const authorEmail = await callbacks.getUserEmail();
    const authorName = await callbacks.getUserName();
    const commitMsg = `Delete ${filePath}`;
    
    // Sign commit with NIP-07 (client-side)
    let commitSignatureEvent: NostrEvent | null = null;
    if (isNIP07Available()) {
      try {
        const { KIND } = await import('$lib/types/nostr.js');
        const timestamp = Math.floor(Date.now() / 1000);
        const eventTemplate: Omit<NostrEvent, 'sig' | 'id'> = {
          kind: KIND.COMMIT_SIGNATURE,
          pubkey: '',
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
      }
    }
    
    await apiPost(`/api/repos/${state.npub}/${state.repo}/file`, {
      path: filePath,
      commitMessage: commitMsg,
      authorName: authorName,
      authorEmail: authorEmail,
      branch: state.git.currentBranch,
      action: 'delete',
      userPubkey: state.user.pubkey,
      commitSignatureEvent: commitSignatureEvent
    });

    // Clear current file if it was deleted
    if (state.files.currentFile === filePath) {
      state.files.currentFile = null;
    }
    
    // Reload file list - use currentPath or empty string for root
    const pathToReload = state.files.currentPath || '';
    await callbacks.loadFiles(pathToReload);
    
    alert('File deleted successfully!');
  } catch (err) {
    state.error = err instanceof Error ? err.message : 'Failed to delete file';
    console.error('Error deleting file:', err);
  } finally {
    state.saving = false;
  }
}

/**
 * Load README file
 */
export async function loadReadme(
  state: RepoState,
  rewriteImagePaths: (html: string, filePath: string | null) => string
): Promise<void> {
  if (state.loading.repoNotFound) return;
  state.loading.readme = true;
  try {
    const { apiRequest } = await import('../utils/api-client.js');
    const data = await apiRequest<{
      found?: boolean;
      content?: string;
      path?: string;
      isMarkdown?: boolean;
    }>(`/api/repos/${state.npub}/${state.repo}/readme?ref=${state.git.currentBranch}`);
    
    if (data.found) {
      state.preview.readme.content = data.content || null;
      state.preview.readme.path = data.path || null;
      state.preview.readme.isMarkdown = data.isMarkdown || false;
      
      // Reset preview mode for README
      state.preview.file.showPreview = true;
      // DON'T reset readme.html here - keep existing HTML until new one is ready
      // This prevents the component from falling back to DocsViewer with raw markdown
      
      // Render markdown or asciidoc if needed
      if (state.preview.readme.content) {
        const ext = state.preview.readme.path?.split('.').pop()?.toLowerCase() || '';
        if (state.preview.readme.isMarkdown || ext === 'md' || ext === 'markdown') {
          try {
            const MarkdownIt = (await import('markdown-it')).default;
            const hljsModule = await import('highlight.js');
            const hljs = hljsModule.default || hljsModule;
            
            const md = new MarkdownIt({
              html: true, // Enable HTML tags in source
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
                  }
                }
                return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
              }
            });
            
            let rendered = md.render(state.preview.readme.content);
            // Debug: check for image tags before rewrite
            const imgBefore = rendered.match(/<img[^>]*>/gi);
            if (imgBefore) {
              console.log('[README] Images before rewrite:', imgBefore);
            }
            // Rewrite image paths to point to repository API
            const beforeRewrite = rendered;
            rendered = rewriteImagePaths(rendered, state.preview.readme.path);
            // Debug: check for image tags after rewrite
            const imgAfter = rendered.match(/<img[^>]*>/gi);
            if (imgAfter) {
              console.log('[README] Images after rewrite:', imgAfter);
            }
            if (beforeRewrite === rendered) {
              console.warn('[README] rewriteImagePaths did not change HTML - images may not be rewritten');
            }
            // Safety check - ensure rendered is still a string
            if (!rendered || typeof rendered !== 'string') {
              console.error('[README] rewriteImagePaths returned invalid value, using original');
              rendered = md.render(state.preview.readme.content); // Fallback to original
            }
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
      } else {
        // No content available, clear HTML
        state.preview.readme.html = '';
      }
    } else {
      // README not found, clear state
      state.preview.readme.content = null;
      state.preview.readme.path = null;
      state.preview.readme.html = '';
      state.preview.readme.isMarkdown = false;
    }
  } catch (err) {
    console.error('Error loading README:', err);
  } finally {
    state.loading.readme = false;
  }
}

/**
 * Load files from a directory
 */
export async function loadFiles(
  path: string,
  state: RepoState,
  repoCloneUrls: string[] | undefined,
  readmeAutoLoadTimeout: { value: ReturnType<typeof setTimeout> | null },
  callbacks: FileOperationsCallbacks
): Promise<void> {
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
    
    const data = await apiRequest<Array<{ name: string; path: string; type: 'file' | 'directory'; size?: number }>>(
      `/api/repos/${state.npub}/${state.repo}/tree?ref=${encodeURIComponent(branchName)}&path=${encodeURIComponent(path)}`
    );
    
    state.files.list = data;
    state.files.currentPath = path;
    
    // If repo is not cloned but we got files, API fallback is available
    if (state.clone.isCloned === false && state.files.list.length > 0) {
      state.clone.apiFallbackAvailable = true;
    }
    
    // Auto-load README if we're in the root directory and no file is currently selected
    // Only attempt once per path to prevent loops
    if (path === '' && !state.files.currentFile && !state.metadata.readmeAutoLoadAttempted) {
      const readmeFile = callbacks.findReadmeFile(state.files.list);
      if (readmeFile) {
        state.metadata.readmeAutoLoadAttempted = true;
        // Clear any existing timeout
        if (readmeAutoLoadTimeout.value) {
          clearTimeout(readmeAutoLoadTimeout.value);
        }
        // Small delay to ensure UI is ready
        readmeAutoLoadTimeout.value = setTimeout(() => {
          if (callbacks.loadFile) {
            callbacks.loadFile(readmeFile.path).catch(err => {
            // If load fails (e.g., 429 rate limit), reset the flag after a delay
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
          }
          readmeAutoLoadTimeout.value = null;
        }, 100);
      }
    } else if (path !== '' || state.files.currentFile) {
      // Reset flag when navigating away from root or when a file is selected
      state.metadata.readmeAutoLoadAttempted = false;
      if (readmeAutoLoadTimeout.value) {
        clearTimeout(readmeAutoLoadTimeout.value);
        readmeAutoLoadTimeout.value = null;
      }
    }
  } catch (err: any) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // Handle 404 - repository not found or not cloned
    if (errorMessage.includes('404') || errorMessage.includes('not found')) {
      if (errorMessage.includes('not cloned locally')) {
        // Repository is not cloned - check if API fallback might be available
        if (repoCloneUrls && repoCloneUrls.length > 0) {
          // We have clone URLs, so API fallback might work - mark as unknown for now
          state.clone.apiFallbackAvailable = null;
        } else {
          // No clone URLs, API fallback won't work
          state.repoNotFound = true;
          state.clone.apiFallbackAvailable = false;
        }
        state.error = errorMessage || 'Repository not found. This repository exists in Nostr but hasn\'t been provisioned on this server yet. The server will automatically provision it soon, or you can contact the server administrator.';
      } else {
        // Generic 404 - repository doesn't exist
        state.repoNotFound = true;
        state.clone.apiFallbackAvailable = false;
        state.error = `Repository not found. This repository exists in Nostr but hasn't been provisioned on this server yet. The server will automatically provision it soon, or you can contact the server administrator.`;
      }
    } else if (errorMessage.includes('403') || errorMessage.includes('Access denied')) {
      // 403 means access denied - don't set repoNotFound, just show error
      state.error = `Access denied: ${errorMessage}. You may need to log in or you may not have permission to view this repository.`;
      console.info('Access denied (normal behavior):', state.error);
    } else {
      state.error = errorMessage || 'Failed to load files';
      console.error('Error loading files:', err);
    }
  } finally {
    state.loading.main = false;
  }
}

/**
 * Load a single file
 */
export async function loadFile(
  filePath: string,
  state: RepoState,
  callbacks: FileOperationsCallbacks
): Promise<void> {
  state.loading.main = true;
  state.error = null;
  try {
    // Ensure currentBranch is a string (branch name), not an object
    let branchName: string;
    
    if (typeof state.git.currentBranch === 'string' && state.git.currentBranch.trim() !== '') {
      // Validate that currentBranch is actually a valid branch name
      const branchNames = state.git.branches.map((b: any) => typeof b === 'string' ? b : b.name);
      if (branchNames.includes(state.git.currentBranch)) {
        branchName = state.git.currentBranch;
      } else {
        // currentBranch is set but not in branches list, use defaultBranch or fallback
        branchName = state.git.defaultBranch || (state.git.branches.length > 0 
          ? (typeof state.git.branches[0] === 'string' ? state.git.branches[0] : state.git.branches[0].name)
          : 'HEAD');
      }
    } else if (typeof state.git.currentBranch === 'object' && state.git.currentBranch !== null && 'name' in state.git.currentBranch) {
      branchName = (state.git.currentBranch as { name: string }).name;
    } else {
      // currentBranch is null, undefined, or invalid - use defaultBranch or fallback
      branchName = state.git.defaultBranch || (state.git.branches.length > 0 
        ? (typeof state.git.branches[0] === 'string' ? state.git.branches[0] : state.git.branches[0].name)
        : 'HEAD');
    }
    
    // Final validation: ensure branchName is a valid string
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
      // For image files, construct the raw file URL and skip loading text content
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
      
      const data = await apiRequest<{ content: string }>(
        `/api/repos/${state.npub}/${state.repo}/file?path=${encodeURIComponent(filePath)}&ref=${encodeURIComponent(branchName)}`
      );
      
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
      
      // Reset preview mode to default (preview) when loading a new file
      state.preview.file.showPreview = true;
      state.preview.file.html = '';
      
      // ALWAYS apply syntax highlighting for ALL files - this ensures raw view always has highlighting
      // We'll apply it regardless of preview mode so it's ready when user switches to raw view
      if (state.files.content && state.files.content.trim().length > 0) {
        await callbacks.applySyntaxHighlighting(state.files.content, ext || '');
      }
      
      // Render markdown/asciidoc/HTML/CSV files as HTML for preview (if in preview mode)
      // This happens after highlighting so both are available
      if (state.files.content && (ext === 'md' || ext === 'markdown' || ext === 'adoc' || ext === 'asciidoc' || ext === 'html' || ext === 'htm' || ext === 'csv')) {
        await callbacks.renderFileAsHtml(state.files.content, ext || '');
      }
    }
  } catch (err: any) {
    // Handle rate limiting specifically to prevent loops
    if (err instanceof Error && err.message.includes('Too Many Requests')) {
      state.error = 'Failed to load file: Too Many Requests';
      console.warn('[File Load] Rate limited, please wait before retrying');
    } else {
      state.error = err instanceof Error ? err.message : 'Failed to load file';
      console.error('Error loading file:', err);
    }
  } finally {
    state.loading.main = false;
  }
}

/**
 * Setup auto-save interval
 */
export async function setupAutoSave(
  autoSaveInterval: { value: ReturnType<typeof setInterval> | null },
  autoSaveFile: () => Promise<void>
): Promise<void> {
  // Clear existing interval if any
  if (autoSaveInterval.value) {
    clearInterval(autoSaveInterval.value);
    autoSaveInterval.value = null;
  }
  
  // Check if auto-save is enabled
  try {
    const { settingsStore } = await import('$lib/services/settings-store.js');
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

/**
 * Auto-save file
 */
export async function autoSaveFile(
  state: RepoState,
  needsClone: boolean,
  callbacks: FileOperationsCallbacks
): Promise<void> {
  // Only auto-save if:
  // 1. There are changes
  // 2. A file is open
  // 3. User is logged in
  // 4. User is a maintainer
  // 5. Not currently saving
  // 6. Not in clone state
  if (!state.files.hasChanges || !state.files.currentFile || !state.user.pubkey || !state.maintainers.isMaintainer || state.saving || needsClone) {
    return;
  }
  
  // Check auto-save setting again (in case it changed)
  try {
    const { settingsStore } = await import('$lib/services/settings-store.js');
    const settings = await settingsStore.getSettings();
    if (!settings.autoSave) {
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
    const authorEmail = await callbacks.getUserEmail();
    const authorName = await callbacks.getUserName();
    
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
    
    await apiPost(`/api/repos/${state.npub}/${state.repo}/file`, {
      path: state.files.currentFile,
      content: state.files.editedContent,
      message: autoCommitMessage,
      authorName: authorName,
      authorEmail: authorEmail,
      branch: state.git.currentBranch,
      userPubkey: state.user.pubkey,
      commitSignatureEvent: commitSignatureEvent
    });

    // Reload file to get updated content
    if (callbacks.loadFile) {
      await callbacks.loadFile(state.files.currentFile);
    }
    // Note: We don't show an alert for auto-save, it's silent
    console.log('Auto-saved file:', state.files.currentFile);
  } catch (err) {
    console.warn('Error during auto-save:', err);
    // Don't show error to user, it's silent
  }
}
