/**
 * Proxy endpoint for Git hosting API requests (Gitea, GitLab, etc.) to avoid CORS issues
 * Usage: /api/gitea-proxy/{apiPath}?baseUrl={baseUrl}
 * Examples:
 *   - Gitea: /api/gitea-proxy/repos/owner/repo/contents/README.md?baseUrl=https://gitea.example.com/api/v1&ref=master
 *   - GitLab: /api/gitea-proxy/projects/owner%2Frepo/repository/files/path/to/file/raw?baseUrl=https://gitlab.com/api/v4&ref=master
 */

import type { RequestHandler } from './$types';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
} as const;

function createErrorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS
    }
  });
}

function buildTargetUrl(baseUrl: string, apiPath: string, searchParams: URLSearchParams): string {
  // Ensure baseUrl doesn't have a trailing slash
  const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  
  // Handle GitLab API paths
  // GitLab format: projects/{owner}/{repo}/repository/files/{file_path}/raw
  // - Project path (owner/repo) MUST be encoded as owner%2Frepo
  // - File path MUST be URL-encoded with %2F for slashes (GitLab API requirement)
  let processedPath = apiPath;
  
  if (apiPath.startsWith('projects/')) {
    const parts = apiPath.split('/');
    
    if (parts.length >= 2) {
      // Determine if project path is already encoded (contains %2F) or split across parts
      let encodedProjectPath: string;
      
      if (parts[1].includes('%2F') || parts[1].includes('%2f')) {
        // Project path is already encoded in parts[1] (e.g., "owner%2Frepo")
        encodedProjectPath = parts[1];
        // Remaining parts start from index 2
        const remainingParts = parts.slice(2);
        
        // Check if this is a file path request
        const filesIndex = remainingParts.indexOf('files');
        if (filesIndex !== -1 && filesIndex < remainingParts.length - 1) {
          // This is a file path: projects/{encodedProjectPath}/repository/files/{file_path}/raw
          // Extract file path segments (everything between 'files' and 'raw')
          const filePathParts = remainingParts.slice(filesIndex + 1, remainingParts.length - 1);
          
          // Decode any already-encoded segments first
          const decodedSegments = filePathParts.map(segment => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          });
          
          // Join with slashes to get the actual file path
          // GitLab API accepts file paths with actual slashes / in the URL path
          // Only encode individual segments if they contain special characters, but keep slashes as /
          const filePath = decodedSegments
            .map(segment => {
              // Only encode if segment contains characters that need encoding (but not slashes)
              const needsEncoding = /[^a-zA-Z0-9._/-]/.test(segment);
              return needsEncoding ? encodeURIComponent(segment) : segment;
            })
            .join('/'); // Use actual slashes, NOT %2F
          
          // Reconstruct: projects/{encodedProjectPath}/repository/files/{filePath}/raw
          // Project path uses %2F (required), file path uses actual / (no %2F)
          const beforeFiles = `projects/${encodedProjectPath}/repository/files`;
          const lastPart = remainingParts[remainingParts.length - 1]; // 'raw'
          processedPath = `${beforeFiles}/${filePath}/${lastPart}`;
        } else {
          // Not a file path, just reconstruct with encoded project path
          processedPath = `projects/${encodedProjectPath}${remainingParts.length > 0 ? '/' + remainingParts.join('/') : ''}`;
        }
      } else if (parts.length >= 3) {
        // Project path is split: parts[1] = owner, parts[2] = repo
        const projectPath = `${parts[1]}/${parts[2]}`;
        encodedProjectPath = encodeURIComponent(projectPath); // Creates owner%2Frepo
        
        // Remaining parts start from index 3
        const remainingParts = parts.slice(3);
        
        // Check if this is a file path request
        const filesIndex = remainingParts.indexOf('files');
        if (filesIndex !== -1 && filesIndex < remainingParts.length - 1) {
          // This is a file path: projects/{owner}/{repo}/repository/files/{file_path}/raw
          // Extract file path segments (everything between 'files' and 'raw')
          const filePathParts = remainingParts.slice(filesIndex + 1, remainingParts.length - 1);
          
          // Decode any already-encoded segments first
          const decodedSegments = filePathParts.map(segment => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          });
          
          // Join with slashes to get the actual file path
          // GitLab API accepts file paths with actual slashes / in the URL path
          // Only encode individual segments if they contain special characters, but keep slashes as /
          const filePath = decodedSegments
            .map(segment => {
              // Only encode if segment contains characters that need encoding (but not slashes)
              const needsEncoding = /[^a-zA-Z0-9._/-]/.test(segment);
              return needsEncoding ? encodeURIComponent(segment) : segment;
            })
            .join('/'); // Use actual slashes, NOT %2F
          
          // Reconstruct: projects/{encodedProjectPath}/repository/files/{filePath}/raw
          // Project path uses %2F (required), file path uses actual / (no %2F)
          const beforeFiles = `projects/${encodedProjectPath}/repository/files`;
          const lastPart = remainingParts[remainingParts.length - 1]; // 'raw'
          processedPath = `${beforeFiles}/${filePath}/${lastPart}`;
        } else {
          // Not a file path, just reconstruct with encoded project path
          processedPath = `projects/${encodedProjectPath}${remainingParts.length > 0 ? '/' + remainingParts.join('/') : ''}`;
        }
      }
    }
  }
  
  // Ensure processedPath starts with a slash
  const cleanApiPath = processedPath.startsWith('/') ? processedPath : `/${processedPath}`;
  
  // Construct query string (excluding baseUrl)
  const queryParts: string[] = [];
  for (const [key, value] of searchParams.entries()) {
    if (key !== 'baseUrl') {
      queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  const queryString = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
  
  // Construct the full URL as a string
  // We must construct as string to preserve %2F encoding
  // Using URL constructor would decode %2F, which we don't want
  const fullUrl = `${cleanBaseUrl}${cleanApiPath}${queryString}`;
  
  return fullUrl;
}

export const GET: RequestHandler = async ({ params, url }) => {
  try {
    // Handle special endpoints
    const apiPath = Array.isArray(params.path) ? params.path.join('/') : params.path;
    
    // Special endpoint: raw-file (for direct file fetching)
    if (apiPath === 'raw-file') {
      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) {
        return createErrorResponse('Missing url query parameter for raw-file', 400);
      }
      
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'Accept': 'text/plain, text/html, */*',
          'User-Agent': 'GitRepublic/1.0'
        }
      });
      
      if (!response.ok) {
        return createErrorResponse(`Failed to fetch file: ${response.status}`, response.status);
      }
      
      const contentType = response.headers.get('content-type') || 'text/plain';
      const body = await response.text();
      
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: {
          'Content-Type': contentType,
          ...CORS_HEADERS
        }
      });
    }
    
    // Standard Gitea/GitLab API proxy handling
    const baseUrl = url.searchParams.get('baseUrl');
    
    if (!baseUrl) {
      return createErrorResponse('Missing baseUrl query parameter', 400);
    }
    
    if (!apiPath) {
      return createErrorResponse('Missing API path', 400);
    }

    const targetUrl = buildTargetUrl(baseUrl, apiPath, url.searchParams);
    
    // Use fetch with the URL string directly
    // fetch() will handle the URL correctly, preserving %2F encoding
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'GitRepublic/1.0'
      }
    });

    const contentType = response.headers.get('content-type') || 'application/json';
    const body = await response.text();
    
    // Log error responses for debugging
    if (!response.ok) {
      // Skip logging 404s for README file requests - these are expected when trying multiple file extensions
      const isReadmeRequest = apiPath.includes('contents') && 
        (apiPath.toLowerCase().includes('readme') || apiPath.toLowerCase().includes('readme'));
      
      if (response.status === 404 && isReadmeRequest) {
        // Silently skip - expected for README attempts
      } else if (response.status === 404) {
        // Log other 404s with context
        console.warn('[Gitea Proxy] 404 Not Found:', {
          apiPath,
          targetUrl,
          baseUrl,
          body: body.substring(0, 200)
        });
      } else {
        // Log non-404 errors
        console.error('[Gitea Proxy] Error response:', response.status, response.statusText);
        console.error('[Gitea Proxy] Request URL:', targetUrl);
        console.error('[Gitea Proxy] Response body:', body.substring(0, 500));
      }
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'Content-Type': contentType,
        ...CORS_HEADERS
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('Git hosting proxy error:', message);
    return createErrorResponse(message, 500);
  }
};

export const OPTIONS: RequestHandler = async () => {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS
  });
};
