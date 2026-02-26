/**
 * Content rendering utility
 * Renders content as Markdown (default) or AsciiDoc (for kinds 30041 and 30818)
 * Consolidates rendering logic used by DocsViewer, PRsTab, IssuesTab, and PatchesTab
 */

/**
 * Render content as HTML based on kind or contentType
 * @param content - The content to render
 * @param kindOrType - The Nostr event kind (30041 or 30818 for AsciiDoc) or contentType string ('asciidoc' for AsciiDoc, everything else for Markdown)
 * @returns Promise<string> - Rendered HTML
 */
export async function renderContent(
  content: string, 
  kindOrType?: number | 'markdown' | 'asciidoc' | 'text'
): Promise<string> {
  if (!content) return '';
  
  // Determine if we should use AsciiDoc
  let useAsciiDoc = false;
  if (typeof kindOrType === 'number') {
    // Nostr event kind: 30041 or 30818 for AsciiDoc
    useAsciiDoc = kindOrType === 30041 || kindOrType === 30818;
  } else if (typeof kindOrType === 'string') {
    // Content type string: 'asciidoc' for AsciiDoc
    useAsciiDoc = kindOrType === 'asciidoc';
  }
  
  if (useAsciiDoc) {
    // Use AsciiDoc parser
    const asciidoctor = (await import('asciidoctor')).default();
    const result = asciidoctor.convert(content, {
      safe: 'safe',
      attributes: {
        'source-highlighter': 'highlight.js'
      }
    });
    return typeof result === 'string' ? result : String(result);
  } else if (typeof kindOrType === 'string' && kindOrType === 'text') {
    // Plain text - escape HTML
    return content
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\n/g, '<br>');
  } else {
    // Use Markdown parser (default)
    const MarkdownIt = (await import('markdown-it')).default;
    const hljsModule = await import('highlight.js');
    const hljs = hljsModule.default || hljsModule;
    
    const md = new MarkdownIt({
      html: true,
      linkify: true,
      typographer: true,
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
    
    let rendered = md.render(content);
    
    // Add IDs to headings for anchor links (like DocsViewer does)
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
    
    return rendered;
  }
}
