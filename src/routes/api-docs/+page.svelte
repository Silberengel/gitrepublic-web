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
          deepLinking: false, // Disabled to avoid conflict with SvelteKit's router
          displayRequestDuration: true,
          tryItOutEnabled: true,
          supportedSubmitMethods: ['get', 'post', 'put', 'delete', 'patch'],
          validatorUrl: null,
          docExpansion: 'list',
          filter: true,
          defaultModelsExpandDepth: 1,
          defaultModelExpandDepth: 1,
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
    color: var(--text-primary);
    padding: 0.2rem 0.4rem;
    border-radius: 0.25rem;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.875rem;
    border: 1px solid var(--border-light);
  }

  .api-docs-header .note strong {
    color: var(--text-primary);
  }

  #swagger-ui {
    margin-top: 2rem;
  }

  /* Base Swagger UI theme overrides */
  :global(.swagger-ui) {
    font-family: 'IBM Plex Serif', serif;
    color: var(--text-primary) !important;
    background: var(--bg-primary) !important;
  }

  :global(.swagger-ui .wrapper),
  :global(.swagger-ui .wrapper .container),
  :global(.swagger-ui .swagger-ui-wrap),
  :global(.swagger-ui .topbar) {
    background: var(--bg-primary) !important;
  }

  :global(.swagger-ui .topbar) {
    display: none;
  }

  /* Info section */
  :global(.swagger-ui .info) {
    background: var(--card-bg) !important;
    border: 1px solid var(--border-color) !important;
    border-radius: 0.5rem;
    padding: 1.5rem;
    margin-bottom: 2rem;
  }

  :global(.swagger-ui .info .title) {
    color: var(--text-primary);
    font-size: 2rem;
    margin-bottom: 0.5rem;
    display: flex !important;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 1rem;
  }

  /* Container for version badges - align right with spacing */
  :global(.swagger-ui .info .title > span) {
    display: flex !important;
    gap: 0.5rem !important;
    align-items: center;
    margin-left: auto;
    flex-shrink: 0;
  }

  :global(.swagger-ui .info .description),
  :global(.swagger-ui .info p) {
    color: var(--text-secondary);
  }

  :global(.swagger-ui .info a) {
    color: var(--link-color) !important;
  }

  :global(.swagger-ui .info a:hover) {
    color: var(--link-hover) !important;
  }

  /* All links in Swagger UI */
  :global(.swagger-ui a),
  :global(.swagger-ui a span),
  :global(.swagger-ui a code) {
    color: var(--link-color) !important;
    text-decoration: none;
  }

  :global(.swagger-ui a:hover),
  :global(.swagger-ui a:hover span),
  :global(.swagger-ui a:hover code) {
    color: var(--link-hover) !important;
    text-decoration: underline;
  }

  /* Version badges - unified round styling with matching borders */
  /* Target the <pre class="version"> elements directly */
  :global(.swagger-ui .info pre.version),
  :global(.swagger-ui .info .version-stamp pre.version),
  :global(.swagger-ui pre.version) {
    border-radius: 9999px !important;
    display: inline-block !important;
    padding: 0.25rem 0.75rem !important;
    background: var(--bg-secondary) !important;
    color: var(--text-primary) !important;
    border: 1px solid var(--border-color) !important;
    border-color: var(--border-color) !important;
    border-width: 1px !important;
    margin: 0 !important;
    font-size: inherit !important;
    font-family: inherit !important;
    line-height: 1.5 !important;
  }

  /* Add spacing between badges */
  :global(.swagger-ui .info small:not(:last-child)),
  :global(.swagger-ui .info .version-stamp:not(:last-child)) {
    margin-right: 0.5rem !important;
  }

  /* Target the <small class="version-stamp"> wrapper */
  :global(.swagger-ui .info small.version-stamp) {
    border-radius: 9999px !important;
    display: inline-block !important;
    padding: 0 !important;
    background: transparent !important;
    border: none !important;
    margin: 0 !important;
  }

  /* Ensure <small> wrappers don't interfere */
  :global(.swagger-ui .info small:not(.version-stamp)) {
    display: inline-block !important;
    padding: 0 !important;
    background: transparent !important;
    border: none !important;
    margin: 0 !important;
  }

  /* Remove any nested styling that creates double borders */
  :global(.swagger-ui .info .version-stamp pre.version) {
    margin: 0 !important;
  }

  /* Scheme container and filter */
  :global(.swagger-ui .scheme-container),
  :global(.swagger-ui .filter-container) {
    background: var(--bg-secondary) !important;
    border: 1px solid var(--border-color) !important;
    border-radius: 0.375rem;
    padding: 1rem;
    margin-bottom: 2rem;
  }

  :global(.swagger-ui .scheme-container label),
  :global(.swagger-ui .filter-container label) {
    color: var(--text-primary);
  }

  :global(.swagger-ui .scheme-container select),
  :global(.swagger-ui .filter-container select) {
    background: var(--input-bg);
    color: var(--text-primary);
    border: 1px solid var(--input-border);
  }

  /* Operation blocks */
  :global(.swagger-ui .opblock) {
    background: var(--card-bg) !important;
    border: 1px solid var(--border-color) !important;
    border-radius: 0.375rem;
    margin-bottom: 1rem;
  }

  :global(.swagger-ui .opblock.opblock-get) { border-left: 4px solid #61affe; }
  :global(.swagger-ui .opblock.opblock-post) { border-left: 4px solid #49cc90; }
  :global(.swagger-ui .opblock.opblock-put) { border-left: 4px solid #fca130; }
  :global(.swagger-ui .opblock.opblock-delete) { border-left: 4px solid #f93e3e; }
  :global(.swagger-ui .opblock.opblock-patch) { border-left: 4px solid #50e3c2; }

  :global(.swagger-ui .opblock-tag) {
    color: var(--text-primary);
    border-bottom: 1px solid var(--border-color);
    padding: 1rem 0;
  }

  :global(.swagger-ui .opblock-tag small) {
    color: var(--text-muted);
  }

  :global(.swagger-ui .opblock-summary) {
    background: var(--bg-secondary) !important;
    border-bottom: 1px solid var(--border-color) !important;
    padding: 1rem;
    color: var(--text-primary) !important; /* Ensure base text color */
  }

  /* Ensure all text in summary has proper contrast */
  :global(.swagger-ui .opblock-summary *),
  :global(.swagger-ui .opblock-summary-path-description-wrapper *),
  :global(.swagger-ui .opblock-summary-path-description-wrapper span),
  :global(.swagger-ui .opblock-summary-path-description-wrapper div) {
    color: inherit;
  }

  :global(.swagger-ui .opblock-summary-method) {
    background: var(--accent);
    color: var(--accent-text, #ffffff);
    font-weight: 600;
    padding: 0.25rem 0.75rem;
    border-radius: 0.25rem;
  }

  :global(.swagger-ui .opblock-summary-path),
  :global(.swagger-ui .opblock-summary-path a),
  :global(.swagger-ui .opblock-summary-path a span),
  :global(.swagger-ui .opblock-summary-path-description-wrapper),
  :global(.swagger-ui .opblock-summary-path-description-wrapper *) {
    color: var(--text-primary) !important;
    font-family: 'IBM Plex Mono', monospace;
  }

  :global(.swagger-ui .opblock-summary-path a.nostyle) {
    color: var(--text-primary) !important;
    text-decoration: none;
  }

  :global(.swagger-ui .opblock-summary-path a.nostyle:hover) {
    color: var(--accent) !important;
    text-decoration: underline;
  }

  :global(.swagger-ui .opblock-summary-description) {
    color: var(--text-primary) !important; /* Use primary text for better contrast */
  }

  /* Operation body and expanded sections */
  :global(.swagger-ui .opblock-body),
  :global(.swagger-ui .opblock.is-open .opblock-body) {
    background: var(--card-bg) !important;
    padding: 1.5rem !important;
    color: var(--text-primary) !important;
  }

  :global(.swagger-ui .opblock.is-open) {
    background: var(--card-bg) !important;
    border-color: var(--border-color) !important;
  }

  :global(.swagger-ui .opblock.is-open .opblock-summary) {
    background: var(--bg-secondary) !important;
  }

  :global(.swagger-ui .opblock-description-wrapper),
  :global(.swagger-ui .opblock-description-wrapper p) {
    color: var(--text-secondary);
    padding: 0.75rem 1rem !important;
  }

  /* Parameters */
  :global(.swagger-ui .parameters-container) {
    background: var(--bg-secondary) !important;
    border: 1px solid var(--border-color) !important;
    border-radius: 0.375rem;
    padding: 1rem !important;
    margin-bottom: 1rem;
    color: var(--text-primary) !important; /* Ensure base text color */
  }

  /* "No parameters" text and all text in parameters container */
  :global(.swagger-ui .parameters-container p),
  :global(.swagger-ui .parameters-container *),
  :global(.swagger-ui .parameters-container span),
  :global(.swagger-ui .parameters-container div) {
    color: var(--text-primary) !important;
  }

  :global(.swagger-ui .parameter__name) {
    color: var(--text-primary);
    font-weight: 600;
  }

  :global(.swagger-ui .parameter__name.required),
  :global(.swagger-ui .parameter__name.required span) {
    color: var(--text-primary) !important;
  }

  :global(.swagger-ui .parameter__name.required::after),
  :global(.swagger-ui .parameter__required) {
    color: var(--error-text) !important;
  }

  :global(.swagger-ui .parameter__type) {
    color: var(--accent);
    font-family: 'IBM Plex Mono', monospace;
  }

  :global(.swagger-ui .parameter__in) {
    color: var(--text-primary) !important; /* Use primary text for better contrast on bg-tertiary */
    background: var(--bg-tertiary);
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
  }

  :global(.swagger-ui .parameter__description),
  :global(.swagger-ui .parameters-col_description) {
    color: var(--text-secondary) !important;
    padding: 0.75rem 1rem !important;
  }

  /* Ensure text-secondary has good contrast on bg-secondary */
  :global(.swagger-ui .parameters-container .parameter__description),
  :global(.swagger-ui .parameters-container .parameters-col_description) {
    color: var(--text-primary) !important; /* Use primary text for better contrast */
  }

  :global(.swagger-ui .parameter__extension),
  :global(.swagger-ui .parameter__deprecated) {
    color: var(--text-secondary) !important; /* Use secondary instead of muted for better contrast */
  }

  :global(.swagger-ui .parameter-row) {
    padding: 0.75rem 1rem !important;
  }

  /* Form inputs */
  :global(.swagger-ui input),
  :global(.swagger-ui textarea),
  :global(.swagger-ui select) {
    background: var(--input-bg) !important;
    color: var(--text-primary) !important;
    border: 1px solid var(--input-border) !important;
    border-radius: 0.375rem;
    padding: 0.5rem;
    font-family: 'IBM Plex Serif', serif;
  }

  :global(.swagger-ui input:focus),
  :global(.swagger-ui textarea:focus),
  :global(.swagger-ui select:focus) {
    outline: none;
    border-color: var(--input-focus) !important;
  }

  :global(.swagger-ui input::placeholder),
  :global(.swagger-ui textarea::placeholder) {
    color: var(--input-placeholder, var(--text-muted)) !important;
    opacity: 1;
  }

  /* Buttons */
  :global(.swagger-ui .btn),
  :global(.swagger-ui button) {
    background: var(--button-primary);
    color: var(--accent-text, #ffffff) !important;
    border: none;
    border-radius: 0.375rem;
    padding: 0.5rem 1rem;
    font-family: 'IBM Plex Serif', serif;
    cursor: pointer;
    transition: background 0.2s ease;
  }

  :global(.swagger-ui .btn:hover),
  :global(.swagger-ui button:hover) {
    background: var(--button-primary-hover);
  }

  :global(.swagger-ui .btn.execute) {
    background: var(--accent);
  }

  :global(.swagger-ui .btn.execute:hover) {
    background: var(--accent-hover);
  }

  :global(.swagger-ui .btn.cancel),
  :global(.swagger-ui button.btn-clear) {
    background: var(--bg-tertiary) !important;
    color: var(--text-primary) !important; /* Ensure primary text for contrast */
    border: 1px solid var(--border-color) !important;
  }

  :global(.swagger-ui .btn.cancel:hover),
  :global(.swagger-ui button.btn-clear:hover) {
    background: var(--bg-secondary);
  }

  :global(.swagger-ui .try-out__btn) {
    background: var(--button-secondary) !important;
    color: var(--accent-text, #ffffff) !important;
  }

  /* Ensure button-secondary text is always readable */
  :global(.swagger-ui .btn[class*="secondary"]),
  :global(.swagger-ui button[class*="secondary"]) {
    color: var(--accent-text, #ffffff) !important;
  }

  :global(.swagger-ui .try-out__btn:hover) {
    background: var(--button-secondary-hover);
  }

  /* Response sections */
  :global(.swagger-ui .responses-wrapper) {
    background: var(--bg-secondary) !important;
    border: 1px solid var(--border-color) !important;
    border-radius: 0.375rem;
    padding: 1rem !important;
    margin-top: 1rem;
  }

  :global(.swagger-ui .responses-inner) {
    background: var(--card-bg) !important;
    padding: 1rem !important;
    border-radius: 0.25rem;
  }

  :global(.swagger-ui .response-col_status) {
    color: var(--text-primary);
    font-weight: 600;
  }

  :global(.swagger-ui .response-col_description) {
    color: var(--text-secondary);
  }

  :global(.swagger-ui .response-col_links) {
    color: var(--text-muted);
  }

  /* Code blocks and examples */
  :global(.swagger-ui pre),
  :global(.swagger-ui .highlight-code),
  :global(.swagger-ui .microlight),
  :global(.swagger-ui .curl),
  :global(.swagger-ui .curl-command),
  :global(.swagger-ui .example),
  :global(.swagger-ui .example-value),
  :global(.swagger-ui .example-single) {
    background: var(--bg-tertiary) !important;
    color: var(--text-primary) !important;
    border: 1px solid var(--border-color) !important;
    border-radius: 0.375rem;
    padding: 1rem !important;
    margin: 0.5rem 0;
    font-family: 'IBM Plex Mono', monospace;
    overflow-x: auto;
  }

  :global(.swagger-ui code) {
    background: var(--bg-secondary) !important;
    color: var(--text-primary) !important;
    padding: 0.125rem 0.25rem;
    border-radius: 0.25rem;
    font-family: 'IBM Plex Mono', monospace;
  }

  :global(.swagger-ui pre code),
  :global(.swagger-ui .microlight code) {
    background: transparent !important;
    padding: 0;
  }

  /* Model definitions */
  :global(.swagger-ui .model-container),
  :global(.swagger-ui .model-box) {
    background: var(--card-bg) !important;
    border: 1px solid var(--border-color) !important;
    border-radius: 0.375rem;
    padding: 1rem !important;
    margin-bottom: 1rem;
    color: var(--text-primary) !important;
  }

  :global(.swagger-ui .model-container .model-box-control) {
    background: var(--bg-secondary) !important;
    padding: 0.5rem 1rem !important;
  }

  :global(.swagger-ui .model-title),
  :global(.swagger-ui .model-title__text),
  :global(.swagger-ui .prop-name),
  :global(.swagger-ui .prop) {
    color: var(--text-primary) !important;
    font-weight: 600;
  }

  :global(.swagger-ui .model-title__small),
  :global(.swagger-ui .prop-format),
  :global(.swagger-ui .prop-attr) {
    color: var(--text-muted) !important;
  }

  :global(.swagger-ui .model-jump-to-path) {
    color: var(--link-color);
  }

  :global(.swagger-ui .model-jump-to-path:hover) {
    color: var(--link-hover);
  }

  :global(.swagger-ui .prop-type),
  :global(.swagger-ui .prop-elem) {
    color: var(--accent) !important;
    font-family: 'IBM Plex Mono', monospace;
  }

  :global(.swagger-ui .model-box .model),
  :global(.swagger-ui .model-box .property-row) {
    padding: 0.75rem 1rem !important;
    border-bottom: 1px solid var(--border-light) !important;
  }

  :global(.swagger-ui .model-box .property-row:hover) {
    background: var(--bg-secondary) !important;
  }

  :global(.swagger-ui .model-container .model-toggle) {
    background: var(--bg-tertiary) !important;
    color: var(--text-primary) !important;
  }

  :global(.swagger-ui .model-container .model-toggle:hover) {
    background: var(--bg-secondary) !important;
  }

  /* Tables */
  :global(.swagger-ui table) {
    background: var(--card-bg) !important;
    border: 1px solid var(--border-color) !important;
    border-radius: 0.375rem;
    width: 100%;
    border-collapse: collapse;
    margin: 0.5rem 0;
  }

  :global(.swagger-ui table thead),
  :global(.swagger-ui table thead tr) {
    background: var(--bg-secondary) !important;
  }

  :global(.swagger-ui table tbody),
  :global(.swagger-ui table tbody tr) {
    background: var(--card-bg) !important;
  }

  :global(.swagger-ui table tbody tr:hover) {
    background: var(--bg-secondary) !important;
  }

  :global(.swagger-ui table thead th),
  :global(.swagger-ui table tbody td),
  :global(.swagger-ui table thead td),
  :global(.swagger-ui .col_header),
  :global(.swagger-ui .response-col_status),
  :global(.swagger-ui .response-col_description),
  :global(.swagger-ui .response-col_links),
  :global(.swagger-ui .response-col_headers) {
    color: var(--text-primary) !important;
    padding: 0.75rem 1rem !important;
  }

  :global(.swagger-ui table thead th),
  :global(.swagger-ui .col_header) {
    font-weight: 600;
    border-bottom: 2px solid var(--border-color);
    background: var(--bg-secondary) !important;
  }

  :global(.swagger-ui table tbody tr) {
    border-bottom: 1px solid var(--border-light);
  }

  /* Links in tables */
  :global(.swagger-ui table a),
  :global(.swagger-ui .response-col_links a),
  :global(.swagger-ui .response a) {
    color: var(--link-color) !important;
    text-decoration: none;
  }

  :global(.swagger-ui table a:hover),
  :global(.swagger-ui .response-col_links a:hover),
  :global(.swagger-ui .response a:hover) {
    color: var(--link-hover) !important;
    text-decoration: underline;
  }

  /* Links and text elements */
  :global(.swagger-ui a) {
    color: var(--link-color);
    text-decoration: none;
  }

  :global(.swagger-ui a:hover) {
    color: var(--link-hover);
    text-decoration: underline;
  }

  :global(.swagger-ui h1),
  :global(.swagger-ui h2),
  :global(.swagger-ui h3),
  :global(.swagger-ui h4),
  :global(.swagger-ui h5),
  :global(.swagger-ui h6),
  :global(.swagger-ui label),
  :global(.swagger-ui .label),
  :global(.swagger-ui p) {
    color: var(--text-primary) !important;
  }

  /* Ensure all paragraphs have proper contrast */
  :global(.swagger-ui .parameters-container p),
  :global(.swagger-ui .opblock-body p),
  :global(.swagger-ui .response p),
  :global(.swagger-ui .model-box p) {
    color: var(--text-primary) !important;
  }

  :global(.swagger-ui small) {
    color: var(--text-muted) !important;
  }

  /* Loading and errors */
  :global(.swagger-ui .loading-container) {
    color: var(--text-primary);
  }

  :global(.swagger-ui .error-wrapper) {
    background: var(--error-bg);
    color: var(--error-text);
    border: 1px solid var(--error-text);
    border-radius: 0.375rem;
    padding: 1rem;
  }

  /* Authorization */
  :global(.swagger-ui .auth-container) {
    background: var(--card-bg) !important;
    border: 1px solid var(--border-color) !important;
    border-radius: 0.375rem;
    padding: 1.5rem !important;
  }

  :global(.swagger-ui .auth-container .auth-btn-wrapper) {
    background: var(--bg-secondary) !important;
    padding: 1rem !important;
  }

  :global(.swagger-ui .auth-btn-wrapper .btn-done) {
    background: var(--accent);
    color: var(--accent-text, #ffffff) !important;
  }

  :global(.swagger-ui .auth-btn-wrapper .btn-done:hover) {
    background: var(--accent-hover);
  }

  /* Expand/collapse controls */
  :global(.swagger-ui .expand-methods),
  :global(.swagger-ui .expand-operation),
  :global(.swagger-ui .opblock-summary-control) {
    background: var(--bg-tertiary);
    color: var(--text-primary) !important;
    border: 1px solid var(--border-color);
  }

  :global(.swagger-ui .expand-methods:hover),
  :global(.swagger-ui .expand-operation:hover),
  :global(.swagger-ui .opblock-summary-control:hover) {
    background: var(--bg-secondary);
    color: var(--accent) !important;
  }

  /* All SVG icons in Swagger UI - make theme-aware */
  :global(.swagger-ui svg),
  :global(.swagger-ui svg path),
  :global(.swagger-ui svg circle),
  :global(.swagger-ui svg rect),
  :global(.swagger-ui svg polygon),
  :global(.swagger-ui svg line),
  :global(.swagger-ui svg polyline),
  :global(.swagger-ui svg g),
  :global(.swagger-ui svg g path) {
    fill: var(--text-primary) !important;
    stroke: var(--text-primary) !important;
    color: var(--text-primary) !important;
  }

  /* Image-based icons in Swagger UI (if any) */
  :global(.swagger-ui img[src*="lock"]),
  :global(.swagger-ui img[src*="chevron"]),
  :global(.swagger-ui img[src*="arrow"]),
  :global(.swagger-ui .authorize img),
  :global(.swagger-ui button img),
  :global(.swagger-ui .btn img) {
    filter: var(--icon-filter, brightness(0) saturate(100%) invert(var(--icon-invert, 0))) !important;
    opacity: 1 !important;
  }

  :global(.swagger-ui .opblock-summary-control svg),
  :global(.swagger-ui .opblock-summary-control svg path),
  :global(.swagger-ui .opblock-summary-control svg circle) {
    fill: var(--text-primary) !important;
    stroke: var(--text-primary) !important;
  }

  :global(.swagger-ui .opblock-summary-control:hover svg),
  :global(.swagger-ui .opblock-summary-control:hover svg path),
  :global(.swagger-ui .opblock-summary-control:hover svg circle) {
    fill: var(--accent) !important;
    stroke: var(--accent) !important;
  }

  /* Lock icon (authorize button) */
  :global(.swagger-ui .authorize svg),
  :global(.swagger-ui .authorize svg path),
  :global(.swagger-ui .authorize svg circle),
  :global(.swagger-ui .authorize svg rect),
  :global(.swagger-ui .btn.authorize svg),
  :global(.swagger-ui .btn.authorize svg path),
  :global(.swagger-ui button.authorize svg),
  :global(.swagger-ui button.authorize svg path) {
    fill: var(--text-primary) !important;
    stroke: var(--text-primary) !important;
    color: var(--text-primary) !important;
  }

  /* Chevron/arrow icons */
  :global(.swagger-ui .arrow svg),
  :global(.swagger-ui .arrow svg path),
  :global(.swagger-ui .arrow svg polyline),
  :global(.swagger-ui .chevron svg),
  :global(.swagger-ui .chevron svg path),
  :global(.swagger-ui .chevron svg polyline),
  :global(.swagger-ui [class*="chevron"] svg),
  :global(.swagger-ui [class*="chevron"] svg path),
  :global(.swagger-ui [class*="arrow"] svg),
  :global(.swagger-ui [class*="arrow"] svg path) {
    fill: var(--text-primary) !important;
    stroke: var(--text-primary) !important;
  }

  /* Expand/collapse arrow icons */
  :global(.swagger-ui .expand-methods svg),
  :global(.swagger-ui .expand-operation svg),
  :global(.swagger-ui .expand-methods svg path),
  :global(.swagger-ui .expand-operation svg path) {
    fill: var(--text-primary) !important;
    stroke: var(--text-primary) !important;
  }

  /* Copy buttons */
  :global(.swagger-ui .copy-to-clipboard) {
    background: var(--bg-tertiary) !important;
    border: 1px solid var(--border-color) !important;
    color: var(--text-primary) !important;
  }

  :global(.swagger-ui .copy-to-clipboard:hover) {
    background: var(--bg-secondary) !important;
  }

  :global(.swagger-ui .copy-to-clipboard button) {
    background: transparent !important;
    color: var(--text-primary) !important;
    border: none !important;
  }

  /* Markdown and rendered content */
  :global(.swagger-ui .markdown p),
  :global(.swagger-ui .renderedMarkdown),
  :global(.swagger-ui .renderedMarkdown p) {
    color: var(--text-secondary) !important;
  }

  /* Ensure text-secondary is readable on bg-tertiary backgrounds */
  :global(.swagger-ui .bg-tertiary .text-secondary),
  :global(.swagger-ui [style*="background: var(--bg-tertiary)"] .text-secondary) {
    color: var(--text-primary) !important; /* Use primary text for better contrast */
  }

  :global(.swagger-ui .markdown code),
  :global(.swagger-ui .renderedMarkdown code) {
    background: var(--bg-secondary) !important;
    color: var(--text-primary) !important;
  }

  :global(.swagger-ui .markdown pre) {
    background: var(--bg-tertiary) !important;
    color: var(--text-primary) !important;
  }

  /* Request/response bodies and examples */
  :global(.swagger-ui .request-body),
  :global(.swagger-ui .body-param) {
    background: var(--bg-secondary) !important;
    border: 1px solid var(--border-color) !important;
    color: var(--text-primary) !important;
    padding: 1rem !important;
    border-radius: 0.375rem;
    margin: 0.5rem 0;
  }

  :global(.swagger-ui .body-param-content),
  :global(.swagger-ui .body-param-content textarea) {
    background: var(--input-bg) !important;
    color: var(--text-primary) !important;
    padding: 0.75rem !important;
  }

  :global(.swagger-ui .body-param-content textarea) {
    border: 1px solid var(--input-border) !important;
  }

  :global(.swagger-ui .body-param-content textarea::placeholder) {
    color: var(--input-placeholder, var(--text-muted)) !important;
  }

  /* Response content type selectors */
  :global(.swagger-ui .response-content-type),
  :global(.swagger-ui .response-content-type ul),
  :global(.swagger-ui .response-content-type li) {
    background: var(--bg-secondary) !important;
    color: var(--text-primary) !important;
    padding: 0.5rem 0.75rem !important;
    border-radius: 0.375rem;
  }

  :global(.swagger-ui .response-content-type li.active) {
    background: var(--accent) !important;
    color: var(--accent-text, #ffffff) !important;
  }

  :global(.swagger-ui .response-content-type li:hover) {
    background: var(--bg-tertiary) !important;
  }

  /* Section headers and expanded states */
  :global(.swagger-ui .opblock-section),
  :global(.swagger-ui .opblock-section-header) {
    background: transparent !important;
    padding: 0.75rem 1rem !important;
  }

  :global(.swagger-ui .opblock.is-open) {
    background: var(--card-bg) !important;
    border-color: var(--border-color) !important;
  }

  :global(.swagger-ui .opblock.is-open .opblock-summary) {
    background: var(--bg-secondary) !important;
  }

  /* Force override white backgrounds */
  :global(.swagger-ui [style*="background: white"]),
  :global(.swagger-ui [style*="background: #fff"]),
  :global(.swagger-ui [style*="background: #ffffff"]) {
    background: var(--card-bg) !important;
  }
</style>
