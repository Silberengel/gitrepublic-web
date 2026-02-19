<script lang="ts">
  import { onMount } from 'svelte';

  onMount(() => {
    // Load Swagger UI from local static files
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.type = 'text/css';
    link.href = '/swagger-ui/swagger-ui.css';
    document.head.appendChild(link);

    let bundleScript: HTMLScriptElement | null = null;

    // Load standalone preset first
    const presetScript = document.createElement('script');
    presetScript.src = '/swagger-ui/swagger-ui-standalone-preset.js';
    presetScript.onload = () => {
      // Then load the bundle
      bundleScript = document.createElement('script');
      bundleScript.src = '/swagger-ui/swagger-ui-bundle.js';
      bundleScript.onload = () => {
        // @ts-ignore - SwaggerUIBundle is loaded from static files
        const ui = window.SwaggerUIBundle({
          url: '/api/openapi.json',
          dom_id: '#swagger-ui',
          presets: [
            // @ts-ignore
            window.SwaggerUIBundle.presets.apis,
            // @ts-ignore
            window.SwaggerUIBundle.presets.standalone
          ],
          layout: 'StandaloneLayout',
          deepLinking: true,
          displayRequestDuration: true,
          tryItOutEnabled: true,
          supportedSubmitMethods: ['get', 'post', 'put', 'delete', 'patch'],
          validatorUrl: null,
          docExpansion: 'list',
          filter: true,
          showExtensions: true,
          showCommonExtensions: true
        });
      };
      document.head.appendChild(bundleScript);
    };
    document.head.appendChild(presetScript);

    return () => {
      // Cleanup
      if (link.parentNode) document.head.removeChild(link);
      if (presetScript.parentNode) document.head.removeChild(presetScript);
      if (bundleScript?.parentNode) document.head.removeChild(bundleScript);
    };
  });
</script>

<div class="api-docs-container">
  <div class="api-docs-header">
    <h1>GitRepublic API Documentation</h1>
    <p>Interactive API documentation with Swagger UI. All endpoints use NIP-98 HTTP authentication.</p>
    <p class="note">
      <strong>Note:</strong> To authenticate, you need to provide a NIP-98 Authorization header.
      The format is: <code>Authorization: Nostr &lt;base64-encoded-event-json&gt;</code>
    </p>
  </div>
  <div id="swagger-ui"></div>
</div>

<style>
  .api-docs-container {
    max-width: 1400px;
    margin: 0 auto;
    padding: 2rem;
  }

  .api-docs-header {
    margin-bottom: 2rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border-color);
  }

  .api-docs-header h1 {
    margin: 0 0 0.5rem 0;
    color: var(--text-primary);
  }

  .api-docs-header p {
    margin: 0.5rem 0;
    color: var(--text-secondary);
  }

  .api-docs-header .note {
    margin-top: 1rem;
    padding: 1rem;
    background: var(--bg-secondary);
    border-left: 3px solid var(--accent);
    border-radius: 0.25rem;
  }

  .api-docs-header code {
    background: var(--bg-tertiary);
    padding: 0.2rem 0.4rem;
    border-radius: 0.25rem;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.875rem;
  }

  #swagger-ui {
    margin-top: 2rem;
  }

  /* Override Swagger UI styles to match our theme */
  :global(.swagger-ui) {
    font-family: 'IBM Plex Serif', serif;
  }

  :global(.swagger-ui .topbar) {
    display: none;
  }

  :global(.swagger-ui .info .title) {
    color: var(--text-primary);
  }

  :global(.swagger-ui .scheme-container) {
    background: var(--bg-secondary);
    padding: 1rem;
    border-radius: 0.375rem;
  }
</style>
