/**
 * File handler utilities
 * UI interaction handlers for file operations
 */

import type { RepoState } from '../stores/repo-state.js';
import { getMimeType } from './file-helpers.js';

/**
 * Handle content change in file editor
 */
export function handleContentChange(value: string, state: RepoState): void {
  state.files.editedContent = value;
  state.files.hasChanges = value !== state.files.content;
}

/**
 * Handle file click (directory or file)
 */
export function handleFileClick(
  file: { name: string; path: string; type: 'file' | 'directory' },
  state: RepoState,
  callbacks: {
    loadFiles: (path: string) => Promise<void>;
    loadFile: (path: string) => Promise<void>;
  }
): void {
  if (file.type === 'directory') {
    state.files.pathStack.push(state.files.currentPath);
    callbacks.loadFiles(file.path);
  } else {
    callbacks.loadFile(file.path);
    // On mobile, switch to file viewer when a file is clicked
    if (typeof window !== 'undefined' && window.innerWidth <= 768) {
      state.ui.showFileListOnMobile = false;
    }
  }
}

/**
 * Copy file content to clipboard
 */
export async function copyFileContent(
  state: RepoState,
  event?: Event
): Promise<void> {
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

/**
 * Download file
 */
export function downloadFile(state: RepoState): void {
  if (!state.files.content || !state.files.currentFile) return;
  
  try {
    // Determine MIME type based on file extension
    const ext = state.files.currentFile.split('.').pop()?.toLowerCase() || '';
    const mimeType = getMimeType(ext);
    
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

/**
 * Handle back navigation in file browser
 */
export function handleBack(
  state: RepoState,
  callbacks: {
    loadFiles: (path: string) => Promise<void>;
  }
): void {
  if (state.files.pathStack.length > 0) {
    const parentPath = state.files.pathStack.pop() || '';
    callbacks.loadFiles(parentPath);
  } else {
    callbacks.loadFiles('');
  }
}

/**
 * Toggle word wrap
 */
export async function toggleWordWrap(
  state: RepoState,
  callbacks: {
    applySyntaxHighlighting: (content: string, ext: string) => Promise<void>;
  }
): Promise<void> {
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
    await callbacks.applySyntaxHighlighting(state.files.content, ext);
  }
}
