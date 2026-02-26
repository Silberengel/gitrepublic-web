/**
 * File operations service
 * Handles file saving, creating, and deleting
 * Note: loadFile and loadFiles remain in component due to complex state dependencies
 */

import type { NostrEvent } from '$lib/types/nostr.js';
import type { RepoState } from '../stores/repo-state.js';
import { isNIP07Available, signEventWithNIP07 } from '$lib/services/nostr/nip07-signer.js';
import { apiPost } from '../utils/api-client.js';

interface FileOperationsCallbacks {
  getUserEmail: () => Promise<string>;
  getUserName: () => Promise<string>;
  loadFiles: (path: string) => Promise<void>;
  loadFile?: (path: string) => Promise<void>;
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
      message: state.forms.commit.message.trim(),
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
      message: commitMsg,
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
    
    // Reload file list
    await callbacks.loadFiles(state.files.currentPath);
    
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
      message: commitMsg,
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
    
    // Reload file list
    await callbacks.loadFiles(state.files.currentPath);
    
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
  } catch (err) {
    console.error('Error loading README:', err);
  } finally {
    state.loading.readme = false;
  }
}
