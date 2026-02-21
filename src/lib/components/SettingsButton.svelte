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
    filter: brightness(0) saturate(100%) invert(1) !important; /* Default white for dark themes */
    opacity: 1 !important;
  }

  /* Light theme: black icon */
  :global([data-theme="light"]) .settings-icon {
    filter: brightness(0) saturate(100%) !important; /* Black in light theme */
    opacity: 1 !important;
  }

  /* Dark themes: white icon */
  :global([data-theme="dark"]) .settings-icon,
  :global([data-theme="black"]) .settings-icon {
    filter: brightness(0) saturate(100%) invert(1) !important; /* White in dark themes */
    opacity: 1 !important;
  }

  /* Hover: white for visibility */
  .settings-button:hover .settings-icon {
    filter: brightness(0) saturate(100%) invert(1) !important;
    opacity: 1 !important;
  }

  /* Light theme hover: keep black */
  :global([data-theme="light"]) .settings-button:hover .settings-icon {
    filter: brightness(0) saturate(100%) !important;
    opacity: 1 !important;
  }
</style>
