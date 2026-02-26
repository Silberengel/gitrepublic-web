/**
 * File helper utilities
 * Pure utility functions for file operations
 */

/**
 * Find README file in file list
 */
export function findReadmeFile(fileList: Array<{ name: string; path: string; type: 'file' | 'directory' }>): { name: string; path: string; type: 'file' | 'directory' } | null {
  // Priority order for README files (most common first)
  const readmeExtensions = ['md', 'markdown', 'txt', 'adoc', 'asciidoc', 'rst', 'org'];
  
  // First, try to find README with extensions (prioritized order)
  for (const ext of readmeExtensions) {
    const readmeFile = fileList.find(file => 
      file.type === 'file' && 
      file.name.toLowerCase() === `readme.${ext}`
    );
    if (readmeFile) {
      return readmeFile;
    }
  }
  
  // Then check for README without extension
  const readmeNoExt = fileList.find(file => 
    file.type === 'file' && 
    file.name.toLowerCase() === 'readme'
  );
  if (readmeNoExt) {
    return readmeNoExt;
  }
  
  // Finally, check for any file starting with "readme." (case-insensitive)
  const readmeAny = fileList.find(file => 
    file.type === 'file' && 
    file.name.toLowerCase().startsWith('readme.')
  );
  if (readmeAny) {
    return readmeAny;
  }
  
  return null;
}

/**
 * Format pubkey to npub
 */
export function formatPubkey(pubkey: string): string {
  try {
    const { nip19 } = require('nostr-tools');
    return nip19.npubEncode(pubkey);
  } catch {
    return pubkey.slice(0, 8) + '...';
  }
}

/**
 * Get MIME type from file extension
 */
export function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    'js': 'text/javascript',
    'ts': 'text/typescript',
    'json': 'application/json',
    'css': 'text/css',
    'html': 'text/html',
    'htm': 'text/html',
    'md': 'text/markdown',
    'txt': 'text/plain',
    'csv': 'text/csv',
    'xml': 'application/xml',
    'svg': 'image/svg+xml',
    'py': 'text/x-python',
    'java': 'text/x-java-source',
    'c': 'text/x-csrc',
    'cpp': 'text/x-c++src',
    'h': 'text/x-csrc',
    'hpp': 'text/x-c++src',
    'sh': 'text/x-shellscript',
    'bash': 'text/x-shellscript',
    'yaml': 'text/yaml',
    'yml': 'text/yaml',
    'toml': 'text/toml',
    'ini': 'text/plain',
    'conf': 'text/plain',
    'log': 'text/plain'
  };
  
  return mimeTypes[ext.toLowerCase()] || 'text/plain';
}
