<script lang="ts">
  import { getContext } from 'svelte';
  import { onMount } from 'svelte';

  // Get theme and toggle function from layout context
  const themeContext = getContext<{
    theme: { value: 'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black' };
    toggleTheme: () => void;
  }>('theme');

  let currentTheme = $state<'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black'>('gitrepublic-dark');
  let dropdownOpen = $state(false);
  let buttonElement: HTMLButtonElement | null = $state(null);

  function updateTheme() {
    const themeAttr = document.documentElement.getAttribute('data-theme');
    if (themeAttr === 'light') {
      currentTheme = 'gitrepublic-light';
    } else if (themeAttr === 'black') {
      currentTheme = 'gitrepublic-black';
    } else {
      currentTheme = 'gitrepublic-dark'; // default to dark/purple
    }
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
    
    // Close dropdown when clicking outside
    function handleClickOutside(event: MouseEvent) {
      if (buttonElement && !buttonElement.contains(event.target as Node) && 
          !(event.target as Element)?.closest('.theme-dropdown')) {
        dropdownOpen = false;
      }
    }
    
    document.addEventListener('click', handleClickOutside);
    
    return () => {
      observer.disconnect();
      document.removeEventListener('click', handleClickOutside);
    };
  });

  function toggleDropdown() {
    dropdownOpen = !dropdownOpen;
  }

  function selectTheme(theme: 'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black') {
    // Set theme directly
    if (theme === 'gitrepublic-light') {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('theme', 'gitrepublic-light');
    } else if (theme === 'gitrepublic-black') {
      document.documentElement.setAttribute('data-theme', 'black');
      localStorage.setItem('theme', 'gitrepublic-black');
    } else {
      document.documentElement.setAttribute('data-theme', 'dark');
      localStorage.setItem('theme', 'gitrepublic-dark');
    }
    updateTheme();
    dropdownOpen = false;
  }

  function getThemeName(theme: 'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black'): string {
    if (theme === 'gitrepublic-light') return 'Light';
    if (theme === 'gitrepublic-black') return 'Black';
    return 'Purple';
  }
</script>

<div class="theme-toggle-container">
  <button 
    class="theme-toggle" 
    onclick={toggleDropdown} 
    title="Theme settings"
    bind:this={buttonElement}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M12 1v6m0 6v6M5.64 5.64l4.24 4.24m4.24 4.24l4.24 4.24M1 12h6m6 0h6M5.64 18.36l4.24-4.24m4.24-4.24l4.24-4.24"></path>
    </svg>
  </button>
  
  {#if dropdownOpen}
    <div class="theme-dropdown">
      <button 
        class="theme-option" 
        class:active={currentTheme === 'gitrepublic-light'}
        onclick={() => selectTheme('gitrepublic-light')}
      >
        <span class="theme-circle">⚪</span>
        <span class="theme-name">Light</span>
      </button>
      <button 
        class="theme-option" 
        class:active={currentTheme === 'gitrepublic-dark'}
        onclick={() => selectTheme('gitrepublic-dark')}
      >
        <span class="theme-circle">🟣</span>
        <span class="theme-name">Purple</span>
      </button>
      <button 
        class="theme-option" 
        class:active={currentTheme === 'gitrepublic-black'}
        onclick={() => selectTheme('gitrepublic-black')}
      >
        <span class="theme-circle">⚫</span>
        <span class="theme-name">Black</span>
      </button>
    </div>
  {/if}
</div>

<style>
  .theme-toggle-container {
    position: relative;
    display: inline-block;
  }

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

  .theme-toggle svg {
    width: 16px;
    height: 16px;
  }

  .theme-dropdown {
    position: absolute;
    top: calc(100% + 0.5rem);
    right: 0;
    background: var(--card-bg);
    border: 1px solid var(--border-color);
    border-radius: 0.375rem;
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    min-width: 150px;
    z-index: 1000;
    overflow: hidden;
    animation: slideDown 0.2s ease;
  }

  @keyframes slideDown {
    from {
      opacity: 0;
      transform: translateY(-10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .theme-option {
    width: 100%;
    padding: 0.75rem 1rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: transparent;
    border: none;
    color: var(--text-primary);
    cursor: pointer;
    transition: background 0.2s ease;
    font-family: 'IBM Plex Serif', serif;
    font-size: 0.875rem;
    text-align: left;
  }

  .theme-option:hover {
    background: var(--bg-secondary);
  }

  .theme-option.active {
    background: var(--bg-tertiary);
    font-weight: 600;
  }

  .theme-option .theme-circle {
    font-size: 1.25rem;
    line-height: 1;
    display: inline-block;
  }

  .theme-option.active .theme-circle {
    transform: scale(1.1);
  }

  .theme-name {
    flex: 1;
  }
</style>
