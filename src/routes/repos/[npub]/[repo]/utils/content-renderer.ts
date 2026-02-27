/**
 * Content rendering utility
 * Renders content as Markdown (default) or AsciiDoc (for kinds 30041 and 30818)
 * Consolidates rendering logic used by DocsViewer, PRsTab, IssuesTab, and PatchesTab
 */

/**
 * Extract document title from AsciiDoc content
 * @param content - The AsciiDoc content
 * @returns The title (text after `= `) or null if not found
 */
export function extractAsciiDocTitle(content: string): string | null {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('= ')) {
      return trimmed.substring(2).trim();
    }
  }
  return null;
}

/**
 * Remove document title from AsciiDoc content
 * @param content - The AsciiDoc content
 * @returns Content without the title line
 */
export function removeAsciiDocTitle(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let titleRemoved = false;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!titleRemoved && trimmed.startsWith('= ')) {
      titleRemoved = true;
      continue; // Skip the title line
    }
    result.push(line);
  }
  
  return result.join('\n');
}

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
    try {
      // Remove document title from content before rendering
      // (we'll display it separately in the header)
      const contentWithoutTitle = removeAsciiDocTitle(content);
      
      const asciidoctor = (await import('asciidoctor')).default();
      // Convert with options to get clean HTML body
      // standalone: false means no document wrapper
      // header_footer: false means no HTML header/footer tags
      const result = asciidoctor.convert(contentWithoutTitle, {
        safe: 'safe',
        standalone: false,
        header_footer: false,
        doctype: 'article',
        attributes: {
          'source-highlighter': 'highlight.js'
        }
      });
      let html = typeof result === 'string' ? result : String(result);
      
      // AsciiDoctor with standalone:false should give us just the body content
      // But if there's still a wrapper, extract it
      const bodyMatch = html.match(/<body[^>]*>(.*?)<\/body>/s);
      if (bodyMatch) {
        html = bodyMatch[1];
      }
      
      // Don't extract sect1 wrapper - we want all sections, not just the first one
      // The sect1 divs are fine, they contain the actual content sections
      
      // Log for debugging
      console.log('[ContentRenderer] AsciiDoc converted:', { 
        inputLength: content.length, 
        outputLength: html.length,
        hasH1: html.includes('<h1'),
        hasH2: html.includes('<h2'),
        sect1Count: (html.match(/<div[^>]*class="sect1"/g) || []).length,
        preview: html.substring(0, 300)
      });
      return html;
    } catch (err) {
      console.error('[ContentRenderer] AsciiDoc conversion error:', err);
      throw new Error(`Failed to convert AsciiDoc: ${err instanceof Error ? err.message : String(err)}`);
    }
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
