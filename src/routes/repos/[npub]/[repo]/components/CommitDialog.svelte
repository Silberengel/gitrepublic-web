<script lang="ts">
  export let show: boolean = false;
  export let commitMessage: string = '';
  export let saving: boolean = false;
  export let onCommit: () => void = () => {};
  export let onCancel: () => void = () => {};
  export let onMessageChange: (message: string) => void = () => {};
</script>

{#if show}
  <div class="modal-overlay" onclick={onCancel}>
    <div class="modal-content" onclick={(e) => e.stopPropagation()}>
      <h2>Commit Changes</h2>
      
      <div class="form-group">
        <label for="commit-message">Commit Message</label>
        <textarea
          id="commit-message"
          bind:value={commitMessage}
          oninput={(e) => onMessageChange(e.target.value)}
          placeholder="Enter commit message..."
          rows="5"
          disabled={saving}
        />
      </div>
      
      <div class="modal-footer">
        <button 
          class="primary-button"
          onclick={onCommit}
          disabled={saving || !commitMessage.trim()}
        >
          {saving ? 'Committing...' : 'Commit'}
        </button>
        <button 
          class="cancel-button"
          onclick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }
  
  .modal-content {
    background: var(--bg-primary);
    border-radius: 8px;
    padding: 2rem;
    max-width: 600px;
    width: 90%;
    max-height: 80vh;
    overflow-y: auto;
  }
  
  .form-group {
    margin: 1.5rem 0;
  }
  
  .form-group label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
  }
  
  .form-group textarea {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    font-family: inherit;
    resize: vertical;
  }
  
  .modal-footer {
    display: flex;
    gap: 1rem;
    justify-content: flex-end;
    margin-top: 1.5rem;
  }
  
  .primary-button, .cancel-button {
    padding: 0.75rem 1.5rem;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-weight: 500;
  }
  
  .primary-button {
    background: var(--accent-color);
    color: white;
  }
  
  .primary-button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  
  .cancel-button {
    background: var(--bg-secondary);
    color: var(--text-primary);
  }
</style>
