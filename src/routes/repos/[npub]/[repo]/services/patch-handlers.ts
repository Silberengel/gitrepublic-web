/**
 * Patch handler utilities
 * UI interaction handlers for patch operations
 */

import type { RepoState } from '../stores/repo-state.js';

/**
 * Handle patch code selection
 */
export function handlePatchCodeSelection(
  text: string,
  startLine: number,
  endLine: number,
  startPos: number,
  endPos: number,
  state: RepoState
): void {
  if (!text.trim() || !state.user.pubkey) return;
  
  state.forms.patchHighlight.text = text;
  state.forms.patchHighlight.startLine = startLine;
  state.forms.patchHighlight.endLine = endLine;
  state.forms.patchHighlight.startPos = startPos;
  state.forms.patchHighlight.endPos = endPos;
  state.openDialog = 'patchHighlight';
}

/**
 * Start patch comment
 */
export function startPatchComment(
  parentId: string | undefined,
  state: RepoState
): void {
  if (!state.user.pubkey) {
    alert('Please connect your NIP-07 extension');
    return;
  }
  state.forms.patchComment.replyingTo = parentId || null;
  state.openDialog = 'patchComment';
}
