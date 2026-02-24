<script lang="ts">
  import { goto } from '$app/navigation';
  
  interface Props {
    initialTab?: 'general' | 'git-setup' | 'connections';
  }
  
  let { initialTab = 'general' }: Props = $props();
  
  function openSettings() {
    goto(`/settings/${initialTab}`);
  }
</script>

<button 
  class="settings-button" 
  onclick={openSettings}
  title="Settings"
  aria-label="Settings"
>
  <img src="/icons/settings.svg" alt="Settings" class="settings-icon" />
</button>

<style>
  .settings-button {
    cursor: pointer;
    padding: 0.5rem;
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    background: var(--card-bg);
    color: var(--text-primary);
    transition: all 0.2s ease;
    font-size: 0.875rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2.5rem;
    height: 2.5rem;
  }

  .settings-button:hover {
    background: var(--bg-secondary);
    border-color: var(--accent);
    color: var(--accent);
  }

  .settings-button:active {
    transform: scale(0.98);
  }

  .settings-icon {
    width: 16px;
    height: 16px;
    display: block;
    /* White icon for both dark themes */
    filter: brightness(0) saturate(100%) invert(1) !important;
    opacity: 1 !important;
  }

  .settings-button:hover .settings-icon {
    filter: brightness(0) saturate(100%) invert(1) !important;
    opacity: 1 !important;
  }
</style>
