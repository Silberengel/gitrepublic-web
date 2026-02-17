<script lang="ts">
  import '../app.css';
  import { onMount, setContext } from 'svelte';

  // Theme management - default to dark
  let theme: 'light' | 'dark' = 'dark';

  onMount(() => {
    // Check for saved theme preference or default to dark
    const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | null;
    if (savedTheme === 'light' || savedTheme === 'dark') {
      theme = savedTheme;
    } else {
      // Default to dark
      theme = 'dark';
    }
    applyTheme();

    // Watch for system theme changes (only if user hasn't set a preference)
    if (typeof window !== 'undefined') {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
        if (!localStorage.getItem('theme')) {
          theme = e.matches ? 'dark' : 'light';
          applyTheme();
        }
      });
    }
  });

  function applyTheme() {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    localStorage.setItem('theme', theme);
  }

  function toggleTheme() {
    theme = theme === 'light' ? 'dark' : 'light';
    applyTheme();
  }

  // Provide theme context to child components
  setContext('theme', {
    get theme() { return { value: theme }; },
    toggleTheme
  });
</script>

<slot />
