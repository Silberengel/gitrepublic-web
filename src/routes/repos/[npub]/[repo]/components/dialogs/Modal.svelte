<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    open: boolean;
    title: string;
    ariaLabel?: string;
    onClose: () => void;
    children?: Snippet;
  }

  let { open, title, ariaLabel, onClose, children }: Props = $props();
</script>

{#if open}
  <div 
    class="modal-overlay" 
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel || title}
    onclick={onClose}
    onkeydown={(e) => e.key === 'Escape' && onClose()}
    tabindex="-1"
  >
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div 
      class="modal" 
      role="dialog"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      tabindex="-1"
    >
      <h3>{title}</h3>
      {#if children}{@render children()}{/if}
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

  .modal {
    background: var(--modal-bg, #fff);
    border-radius: 8px;
    padding: 1.5rem;
    max-width: 500px;
    width: 90%;
    max-height: 90vh;
    overflow-y: auto;
  }

  .modal h3 {
    margin: 0 0 1rem 0;
  }
</style>
