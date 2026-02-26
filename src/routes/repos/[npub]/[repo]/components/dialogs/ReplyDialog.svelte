<script lang="ts">
  import Modal from './Modal.svelte';
  import type { RepoState } from '../../stores/repo-state.js';

  interface Props {
    open: boolean;
    state: RepoState;
    onCreate: () => void;
    onClose: () => void;
  }

  let { open, state, onCreate, onClose }: Props = $props();

  function handleClose() {
    state.discussion.replyingToThread = null;
    state.discussion.replyingToComment = null;
    state.forms.discussion.replyContent = '';
    onClose();
  }
</script>

<Modal 
  {open} 
  title={state.discussion.replyingToComment ? 'Reply to Comment' : state.discussion.replyingToThread ? 'Reply to Thread' : 'Reply'}
  ariaLabel={state.discussion.replyingToComment ? 'Reply to comment' : 'Reply to thread'}
  onClose={handleClose}
>
  <label>
    Your Reply:
    <textarea bind:value={state.forms.discussion.replyContent} rows="8" placeholder="Write your reply..."></textarea>
  </label>
  <div class="modal-actions">
    <button onclick={handleClose} class="cancel-button">Cancel</button>
    <button 
      onclick={onCreate} 
      disabled={!state.forms.discussion.replyContent.trim() || state.creating.reply} 
      class="save-button"
    >
      {state.creating.reply ? 'Posting...' : 'Post Reply'}
    </button>
  </div>
</Modal>

<style>
  label {
    display: block;
    margin-bottom: 1rem;
  }

  label textarea {
    width: 100%;
    padding: 0.5rem;
    margin-top: 0.25rem;
    border: 1px solid var(--border-color, #e0e0e0);
    border-radius: 4px;
  }

  .modal-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 1rem;
  }

  .cancel-button,
  .save-button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
  }

  .cancel-button {
    background: var(--cancel-bg, #e0e0e0);
  }

  .save-button {
    background: var(--primary-color, #2196f3);
    color: white;
  }

  .save-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
