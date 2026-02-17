<script lang="ts">
  import { getContext } from 'svelte';
  import { onMount } from 'svelte';

  // Get theme and toggle function from layout context
  const themeContext = getContext<{
    theme: { value: 'light' | 'dark' };
    toggleTheme: () => void;
  }>('theme');

  let currentTheme: 'light' | 'dark' = 'dark';

  function updateTheme() {
    currentTheme = document.documentElement.hasAttribute('data-theme') ? 'dark' : 'light';
  }

  onMount(() => {
    // Check current theme from document
    updateTheme();
    
    // Watch for theme changes
    const observer = new MutationObserver(() => {
      updateTheme();
    });
    
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme']
    });
    
    return () => observer.disconnect();
  });

  function handleToggle() {
    if (themeContext) {
      themeContext.toggleTheme();
    } else {
      // Fallback: toggle manually
      const isDark = document.documentElement.hasAttribute('data-theme');
      if (isDark) {
        document.documentElement.removeAttribute('data-theme');
      } else {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
      localStorage.setItem('theme', isDark ? 'light' : 'dark');
    }
    updateTheme();
  }
</script>

<button class="theme-toggle" onclick={handleToggle} title={currentTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
  <span class="theme-toggle-icon">
    {#if currentTheme === 'dark'}
      <!-- Sun icon for light mode -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5"></circle>
        <line x1="12" y1="1" x2="12" y2="3"></line>
        <line x1="12" y1="21" x2="12" y2="23"></line>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
        <line x1="1" y1="12" x2="3" y2="12"></line>
        <line x1="21" y1="12" x2="23" y2="12"></line>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
      </svg>
    {:else}
      <!-- Moon icon for dark mode -->
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      </svg>
    {/if}
  </span>
</button>

<style>
  .theme-toggle {
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
    font-family: 'IBM Plex Serif', serif;
  }

  .theme-toggle:hover {
    background: var(--bg-secondary);
    border-color: var(--accent);
    color: var(--accent);
  }

  .theme-toggle:active {
    transform: scale(0.98);
  }

  .theme-toggle-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
  }

  .theme-toggle-icon svg {
    width: 100%;
    height: 100%;
  }
</style>
