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
      ☀️
    {:else}
      🌙
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
    font-size: 1rem;
    line-height: 1;
  }
</style>
