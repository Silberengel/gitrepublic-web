/**
 * File processing utilities
 * Handles syntax highlighting, HTML rendering, and file type detection
 */

// Note: highlight.js, marked, and asciidoctor are imported dynamically in functions

/**
 * Get highlight.js language from file extension
 */
export function getHighlightLanguage(ext: string): string {
  const langMap: Record<string, string> = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'cxx': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'hxx': 'cpp',
    'cs': 'csharp',
    'php': 'php',
    'swift': 'swift',
    'kt': 'kotlin',
    'scala': 'scala',
    'clj': 'clojure',
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
    'fish': 'bash',
    'ps1': 'powershell',
    'sql': 'sql',
    'html': 'html',
    'htm': 'html',
    'xml': 'xml',
    'css': 'css',
    'scss': 'scss',
    'sass': 'sass',
    'less': 'less',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'toml': 'toml',
    'ini': 'ini',
    'conf': 'ini',
    'dockerfile': 'dockerfile',
    'makefile': 'makefile',
    'mk': 'makefile',
    'cmake': 'cmake',
    'r': 'r',
    'R': 'r',
    'm': 'objectivec',
    'mm': 'objectivec',
    'vue': 'xml',
    'svelte': 'xml',
    'graphql': 'graphql',
    'gql': 'graphql',
    'proto': 'protobuf',
    'md': 'markdown',
    'markdown': 'markdown',
    'adoc': 'asciidoc',
    'asciidoc': 'asciidoc',
    'rst': 'restructuredtext',
    'org': 'org',
    'vim': 'vim',
    'lua': 'lua',
    'pl': 'perl',
    'pm': 'perl',
    'tcl': 'tcl',
    'dart': 'dart',
    'elm': 'elm',
    'ex': 'elixir',
    'exs': 'elixir',
    'erl': 'erlang',
    'hrl': 'erlang',
    'fs': 'fsharp',
    'fsx': 'fsharp',
    'fsi': 'fsharp',
    'ml': 'ocaml',
    'mli': 'ocaml',
    'hs': 'haskell',
    'lhs': 'haskell',
    'nim': 'nim',
    'zig': 'zig',
    'cr': 'crystal',
    'jl': 'julia',
    'matlab': 'matlab',
    'tex': 'latex',
    'latex': 'latex',
    'bib': 'bibtex',
    'log': 'plaintext',
    'txt': 'plaintext',
    'diff': 'diff',
    'patch': 'diff'
  };
  
  return langMap[ext.toLowerCase()] || 'plaintext';
}

/**
 * Check if file extension supports HTML preview
 */
export function supportsPreview(ext: string): boolean {
  const previewExtensions = ['md', 'markdown', 'adoc', 'asciidoc', 'html', 'htm', 'csv'];
  return previewExtensions.includes(ext.toLowerCase());
}

/**
 * Check if file extension is an image type
 */
export function isImageFileType(ext: string): boolean {
  const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'avif', 'heic', 'heif'];
  return imageExtensions.includes(ext.toLowerCase());
}

/**
 * Rewrite image paths in HTML to be relative to file path
 */
export function rewriteImagePaths(html: string, filePath: string | null): string {
  if (!filePath || !html) return html;
  
  // Get directory path (remove filename)
  const dirPath = filePath.split('/').slice(0, -1).join('/');
  const basePath = dirPath ? `/${dirPath}/` : '/';
  
  // Rewrite relative image paths
  // Match: src="image.png" or src='image.png' or src=image.png
  html = html.replace(/src=["']([^"']+)["']/g, (match, path) => {
    // Skip absolute URLs and data URLs
    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:') || path.startsWith('/')) {
      return match;
    }
    // Make path relative to file directory
    return `src="${basePath}${path}"`;
  });
  
  return html;
}

/**
 * Render CSV content as HTML table
 */
export function renderCsvAsTable(csvContent: string): string {
  const lines = csvContent.split('\n').filter(line => line.trim());
  if (lines.length === 0) return '<p>Empty CSV file</p>';
  
  // Parse CSV (simple parser - handles basic cases)
  const rows: string[][] = [];
  for (const line of lines) {
    const cells: string[] = [];
    let currentCell = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        cells.push(currentCell.trim());
        currentCell = '';
      } else {
        currentCell += char;
      }
    }
    cells.push(currentCell.trim());
    rows.push(cells);
  }
  
  if (rows.length === 0) return '<p>No data in CSV file</p>';
  
  // Generate HTML table
  let html = '<table class="csv-table"><thead><tr>';
  const headerRow = rows[0];
  for (const cell of headerRow) {
    html += `<th>${escapeHtml(cell)}</th>`;
  }
  html += '</tr></thead><tbody>';
  
  for (let i = 1; i < rows.length; i++) {
    html += '<tr>';
    for (const cell of rows[i]) {
      html += `<td>${escapeHtml(cell)}</td>`;
    }
    html += '</tr>';
  }
  
  html += '</tbody></table>';
  return html;
}

/**
 * Escape HTML special characters
 */
export function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}

/**
 * Apply syntax highlighting to content
 */
export async function applySyntaxHighlighting(
  content: string,
  ext: string,
  setHighlightedContent: (html: string) => void
): Promise<void> {
  try {
    const hljsModule = await import('highlight.js');
    const hljs = hljsModule.default || hljsModule;
    const lang = getHighlightLanguage(ext);
    
    // Register Markdown language if needed
    if (lang === 'markdown' && !hljs.getLanguage('markdown')) {
      hljs.registerLanguage('markdown', function(hljs) {
        return {
          name: 'Markdown',
          aliases: ['md', 'mkdown', 'mkd'],
          contains: [
            { className: 'section', begin: /^#{1,6}\s+/, relevance: 10 },
            { className: 'strong', begin: /\*\*[^*]+\*\*/, relevance: 0 },
            { className: 'strong', begin: /__[^_]+__/, relevance: 0 },
            { className: 'emphasis', begin: /\*[^*]+\*/, relevance: 0 },
            { className: 'emphasis', begin: /_[^_]+_/, relevance: 0 },
            { className: 'code', begin: /`[^`]+`/, relevance: 0 },
            { className: 'code', begin: /^```[\w]*/, end: /^```$/, contains: [{ begin: /./ }] },
            { className: 'link', begin: /\[/, end: /\]/, contains: [{ className: 'string', begin: /\(/, end: /\)/ }] },
            { className: 'string', begin: /!\[/, end: /\]/ },
            { className: 'bullet', begin: /^(\s*)([*+-]|\d+\.)\s+/, relevance: 0 },
            { className: 'quote', begin: /^>\s+/, relevance: 0 },
            { className: 'horizontal_rule', begin: /^(\*{3,}|-{3,}|_{3,})$/, relevance: 0 }
          ]
        };
      });
    }
    
    // Register AsciiDoc language if needed
    if (lang === 'asciidoc' && !hljs.getLanguage('asciidoc')) {
      hljs.registerLanguage('asciidoc', function(hljs) {
        return {
          name: 'AsciiDoc',
          aliases: ['adoc', 'asciidoc', 'ad'],
          contains: [
            { className: 'section', begin: /^={1,6}\s+/, relevance: 10 },
            { className: 'strong', begin: /\*\*[^*]+\*\*/, relevance: 0 },
            { className: 'emphasis', begin: /_[^_]+_/, relevance: 0 },
            { className: 'code', begin: /`[^`]+`/, relevance: 0 },
            { className: 'code', begin: /^----+$/, end: /^----+$/, contains: [{ begin: /./ }] },
            { className: 'bullet', begin: /^(\*+|\.+|-+)\s+/, relevance: 0 },
            { className: 'link', begin: /link:/, end: /\[/, contains: [{ begin: /\[/, end: /\]/ }] },
            { className: 'comment', begin: /^\/\/.*$/, relevance: 0 },
            { className: 'attr', begin: /^:.*:$/, relevance: 0 }
          ]
        };
      });
    }
    
    // Apply highlighting
    if (lang === 'plaintext') {
      setHighlightedContent(`<pre><code class="hljs">${hljs.highlight(content, { language: 'plaintext' }).value}</code></pre>`);
    } else if (hljs.getLanguage(lang)) {
      setHighlightedContent(`<pre><code class="hljs language-${lang}">${hljs.highlight(content, { language: lang }).value}</code></pre>`);
    } else {
      setHighlightedContent(`<pre><code class="hljs">${hljs.highlightAuto(content).value}</code></pre>`);
    }
  } catch (err) {
    console.error('Error applying syntax highlighting:', err);
    setHighlightedContent(`<pre><code class="hljs">${escapeHtml(content)}</code></pre>`);
  }
}

/**
 * Render file content as HTML
 */
export async function renderFileAsHtml(
  content: string,
  ext: string,
  filePath: string | null,
  setHtml: (html: string) => void
): Promise<void> {
  try {
    const lowerExt = ext.toLowerCase();
    
    if (lowerExt === 'md' || lowerExt === 'markdown') {
      // Render markdown using markdown-it
      const MarkdownIt = (await import('markdown-it')).default;
      const hljsModule = await import('highlight.js');
      const hljs = hljsModule.default || hljsModule;
      
      const md = new MarkdownIt({
        html: true,
        linkify: true,
        typographer: true,
        breaks: true,
        highlight: function (str: string, lang: string): string {
          if (lang && hljs.getLanguage(lang)) {
            try {
              return hljs.highlight(str, { language: lang }).value;
            } catch (__) {}
          }
          try {
            return hljs.highlightAuto(str).value;
          } catch (__) {}
          return '';
        }
      });
      
      let rendered = md.render(content);
      rendered = rewriteImagePaths(rendered, filePath);
      setHtml(rendered);
    } else if (lowerExt === 'adoc' || lowerExt === 'asciidoc') {
      // Render asciidoc
      const Asciidoctor = (await import('@asciidoctor/core')).default;
      const asciidoctor = Asciidoctor();
      const converted = asciidoctor.convert(content, {
        safe: 'safe',
        attributes: {
          'source-highlighter': 'highlight.js'
        }
      });
      let rendered = typeof converted === 'string' ? converted : String(converted);
      rendered = rewriteImagePaths(rendered, filePath);
      setHtml(rendered);
    } else if (lowerExt === 'html' || lowerExt === 'htm') {
      // HTML files - rewrite image paths
      let rendered = content;
      rendered = rewriteImagePaths(rendered, filePath);
      setHtml(rendered);
    } else if (lowerExt === 'csv') {
      // Parse CSV and render as HTML table
      const html = renderCsvAsTable(content);
      setHtml(html);
    } else {
      setHtml('');
    }
  } catch (err) {
    console.error('Error rendering file as HTML:', err);
    setHtml('');
  }
}
