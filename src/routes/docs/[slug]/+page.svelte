<script lang="ts">
  import { page } from '$app/stores';
  import { onMount } from 'svelte';

  let content = $state('');
  let loading = $state(true);
  let error = $state<string | null>(null);

  onMount(async () => {
    try {
      const docContent = $page.data.content;
      if (docContent) {
        const MarkdownIt = (await import('markdown-it')).default;
        const hljsModule = await import('highlight.js');
        const hljs = hljsModule.default || hljsModule;
        
        const md = new MarkdownIt({
          highlight: function (str: string, lang: string): string {
            if (lang && hljs.getLanguage(lang)) {
              try {
                return '<pre class="hljs"><code>' +
                       hljs.highlight(str, { language: lang }).value +
                       '</code></pre>';
              } catch (err) {
                // Fallback to escaped HTML if highlighting fails
              }
            }
            return '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre>';
          }
        });
        
        let rendered = md.render(docContent);
        
        // Add IDs to headings for anchor links
        rendered = rendered.replace(/<h([1-6])>(.*?)<\/h[1-6]>/g, (match, level, text) => {
          const textContent = text.replace(/<[^>]*>/g, '').trim();
          const slug = textContent
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
          
          return `<h${level} id="${slug}">${text}</h${level}>`;
        });
        
        // Convert relative markdown links to docs routes
        // Handle various link formats:
        // - ./file.md -> /docs/file
        // - file.md -> /docs/file
        // - /file.md -> /docs/file (though this shouldn't happen in markdown)
        rendered = rendered.replace(/<a href="([^"]*\.md)"/g, (match, file) => {
          // Remove leading ./ or / if present
          const cleanFile = file.replace(/^\.\//, '').replace(/^\//, '');
          const slug = cleanFile.replace(/\.md$/, '');
          // Only process if it's a relative link (not already starting with /docs or http)
          if (!slug.startsWith('docs/') && !slug.startsWith('http')) {
            return `<a href="/docs/${slug}"`;
          }
          return match; // Return original if already processed or external
        });
        
        // Also handle links with anchors: ./file.md#section -> /docs/file#section
        rendered = rendered.replace(/<a href="([^"]*\.md)(#[^"]*)"/g, (match, file, anchor) => {
          const cleanFile = file.replace(/^\.\//, '').replace(/^\//, '');
          const slug = cleanFile.replace(/\.md$/, '');
          if (!slug.startsWith('docs/') && !slug.startsWith('http')) {
            return `<a href="/docs/${slug}${anchor}"`;
          }
          return match;
        });
        
        content = rendered;
        
        // Handle anchor links after content is rendered
        setTimeout(() => {
          if (window.location.hash) {
            const id = window.location.hash.substring(1);
            const element = document.getElementById(id);
            if (element) {
              element.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
          }
          
          const markdownContent = document.querySelector('.markdown-content');
          if (markdownContent) {
            markdownContent.addEventListener('click', (e) => {
              const target = e.target as HTMLElement;
              if (target.tagName === 'A') {
                const href = target.getAttribute('href');
                if (!href) return;
                
                // Handle anchor links
                if (href.startsWith('#')) {
                  const id = href.substring(1);
                  const element = document.getElementById(id);
                  if (element) {
                    e.preventDefault();
                    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    window.history.pushState(null, '', `#${id}`);
                  }
                  return;
                }
                
                // Handle .md file links that weren't converted properly
                if (href.endsWith('.md') && !href.startsWith('/docs/') && !href.startsWith('http')) {
                  e.preventDefault();
                  // Remove leading ./ or / if present, then remove .md extension
                  const cleanHref = href.replace(/^\.\//, '').replace(/^\//, '');
                  const slug = cleanHref.replace(/\.md$/, '');
                  // Navigate to docs route
                  window.location.href = `/docs/${slug}`;
                  return;
                }
              }
            });
          }
        }, 100);
      } else {
        error = $page.data.error || 'Failed to load documentation';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load documentation';
      console.error('Error parsing documentation:', err);
    } finally {
      loading = false;
    }
  });
</script>

<div class="container">
  <header>
    <h1>Documentation</h1>
  </header>

  <main class="docs-content">
    {#if loading}
      <div class="loading">Loading documentation...</div>
    {:else if error}
      <div class="error">{error}</div>
    {:else}
      <div class="markdown-content">
        {@html content}
      </div>
    {/if}
  </main>
</div>

<style>
  .docs-content {
    background: var(--card-bg);
    padding: 2rem;
    border-radius: 0.5rem;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
    border: 1px solid var(--border-color);
  }

  :global(.markdown-content) {
    line-height: 1.6;
  }

  :global(.markdown-content h1) {
    font-size: 2rem;
    margin-top: 2rem;
    margin-bottom: 1rem;
    border-bottom: 2px solid var(--border-color);
    padding-bottom: 0.5rem;
    color: var(--text-primary);
    scroll-margin-top: 1rem;
  }

  :global(.markdown-content h2) {
    font-size: 1.5rem;
    margin-top: 1.5rem;
    margin-bottom: 0.75rem;
    color: var(--text-primary);
    scroll-margin-top: 1rem;
  }

  :global(.markdown-content h3) {
    font-size: 1.25rem;
    margin-top: 1.25rem;
    margin-bottom: 0.5rem;
    color: var(--text-primary);
    scroll-margin-top: 1rem;
  }

  :global(.markdown-content h4, .markdown-content h5, .markdown-content h6) {
    scroll-margin-top: 1rem;
  }

  :global(.markdown-content) {
    scroll-behavior: smooth;
  }

  :global(.markdown-content code) {
    background: var(--bg-secondary);
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.875em;
    color: var(--text-primary);
  }

  :global(.markdown-content pre) {
    background: var(--bg-tertiary);
    color: var(--text-primary);
    padding: 1rem;
    border-radius: 0.5rem;
    overflow-x: auto;
    margin: 1rem 0;
    border: 1px solid var(--border-color);
  }

  :global(.markdown-content pre code) {
    background: transparent;
    padding: 0;
    color: inherit;
  }

  :global(.markdown-content p) {
    margin: 1rem 0;
  }

  :global(.markdown-content ul, .markdown-content ol) {
    margin: 1rem 0;
    padding-left: 2rem;
  }

  :global(.markdown-content li) {
    margin: 0.5rem 0;
  }

  :global(.markdown-content blockquote) {
    border-left: 4px solid var(--accent);
    padding-left: 1rem;
    margin: 1rem 0;
    color: var(--text-secondary);
  }

  :global(.markdown-content table) {
    width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
  }

  :global(.markdown-content th, .markdown-content td) {
    border: 1px solid var(--border-color);
    padding: 0.5rem;
    text-align: left;
  }

  :global(.markdown-content th) {
    background: var(--bg-secondary);
    font-weight: 600;
    color: var(--text-primary);
  }

  :global(.markdown-content td) {
    color: var(--text-primary);
  }
</style>
