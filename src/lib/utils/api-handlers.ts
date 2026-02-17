/**
 * API Handler Wrappers
 * Higher-order functions to wrap SvelteKit request handlers with common logic
 */

import type { RequestHandler } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import { handleApiError, handleValidationError, type ErrorContext } from './error-handler.js';
import { getRepoContext, extractRequestContext, validateRepoParams, type RepoContext, type RequestContext, type RepoRequestContext } from './api-context.js';
import { requireRepoAccess, requireRepoExists, requireMaintainer, requireNIP98Auth, requireRepoAccessWithExists } from './api-auth.js';
import { auditLogger } from '../services/security/audit-logger.js';

/**
 * Handler function that receives validated context
 */
export type RepoHandler = (context: {
  repoContext: RepoContext;
  requestContext: RequestContext;
  event: RequestEvent;
}) => Promise<Response>;

/**
 * Handler function with full repo request context
 */
export type RepoRequestHandler = (context: {
  repoRequestContext: RepoRequestContext;
  event: RequestEvent;
}) => Promise<Response>;

/**
 * Options for handler wrappers
 */
export interface HandlerOptions {
  operation?: string;
  requireAuth?: boolean;
  requireMaintainer?: boolean;
  requireNIP98?: boolean;
  requireRepoExists?: boolean;
  requireRepoAccess?: boolean;
  auditLog?: boolean;
}

/**
 * Wrap a handler with repository parameter validation
 * Validates npub/repo params and converts npub to pubkey
 * 
 * @param handler - Handler function that receives validated context
 * @param options - Handler options
 * @returns Wrapped SvelteKit RequestHandler
 */
export function withRepoValidation(
  handler: RepoHandler,
  options: HandlerOptions = {}
): RequestHandler {
  return async (event) => {
    const { params } = event;
    const operation = options.operation || 'unknown';
    
    try {
      // Validate repo parameters
      const repoContext = validateRepoParams(params);
      
      // Extract request context
      const requestContext = extractRequestContext(event);
      
      // Check if repo exists (if required)
      if (options.requireRepoExists !== false) {
        requireRepoExists(repoContext, operation);
      }
      
      // Check repository access (if required)
      if (options.requireRepoAccess !== false) {
        await requireRepoAccess(repoContext, requestContext, operation);
      }
      
      // Check if user is maintainer (if required)
      if (options.requireMaintainer) {
        await requireMaintainer(repoContext, requestContext, operation);
      }
      
      // Check NIP-98 auth (if required)
      if (options.requireNIP98) {
        requireNIP98Auth(event.request, event.url, event.request.method, operation);
      }
      
      // Audit logging (if enabled)
      if (options.auditLog) {
        auditLogger.log({
          user: requestContext.userPubkeyHex || undefined,
          ip: requestContext.clientIp,
          action: `api.${operation}`,
          resource: `${repoContext.npub}/${repoContext.repo}`,
          result: 'success'
        });
      }
      
      // Call the handler with validated context
      return await handler({
        repoContext,
        requestContext,
        event
      });
    } catch (err) {
      // If it's already a Response (from error handlers), return it
      if (err instanceof Response) {
        return err;
      }
      
      // If it's a SvelteKit HttpError (from error() function), re-throw it
      // SvelteKit errors have a status property and body property
      if (err && typeof err === 'object' && 'status' in err && 'body' in err) {
        throw err;
      }
      
      // Otherwise, wrap in standard error handler
      return handleApiError(
        err,
        { operation, npub: params.npub, repo: params.repo },
        `Failed to process ${operation}`
      );
    }
  };
}

/**
 * Create a simple GET handler for repository operations
 * Automatically handles validation, access checks, and error handling
 * 
 * @param handler - Handler function that receives repo request context
 * @param options - Handler options
 * @returns GET RequestHandler
 */
export function createRepoGetHandler(
  handler: (context: RepoRequestContext, event: RequestEvent) => Promise<Response>,
  options: HandlerOptions = {}
): RequestHandler {
  return withRepoValidation(async ({ repoContext, requestContext, event }) => {
    const repoRequestContext: RepoRequestContext = {
      ...repoContext,
      ...requestContext
    };
    
    return await handler(repoRequestContext, event);
  }, {
    requireRepoExists: true,
    requireRepoAccess: true,
    ...options
  });
}

/**
 * Create a POST handler with maintainer requirement
 * 
 * @param handler - Handler function that receives repo request context
 * @param options - Handler options
 * @returns POST RequestHandler
 */
export function createRepoPostHandler(
  handler: (context: RepoRequestContext, event: RequestEvent) => Promise<Response>,
  options: HandlerOptions = {}
): RequestHandler {
  return withRepoValidation(async ({ repoContext, requestContext, event }) => {
    const repoRequestContext: RepoRequestContext = {
      ...repoContext,
      ...requestContext
    };
    
    return await handler(repoRequestContext, event);
  }, {
    requireRepoExists: true,
    requireMaintainer: true,
    ...options
  });
}

/**
 * Wrap handler with audit logging
 * 
 * @param handler - Handler function
 * @param operation - Operation name for audit log
 * @returns Wrapped handler with audit logging
 */
export function withAuditLogging(
  handler: RequestHandler,
  operation: string
): RequestHandler {
  return async (event) => {
    const { params } = event;
    const requestContext = extractRequestContext(event);
    
    try {
      const response = await handler(event);
      
      // Log successful operation
      if (params.npub && params.repo) {
        auditLogger.log({
          user: requestContext.userPubkeyHex || undefined,
          ip: requestContext.clientIp,
          action: `api.${operation}`,
          resource: `${params.npub}/${params.repo}`,
          result: 'success',
          metadata: { status: response.status }
        });
      }
      
      return response;
    } catch (err) {
      // Log failed operation
      if (params.npub && params.repo) {
        auditLogger.log({
          user: requestContext.userPubkeyHex || undefined,
          ip: requestContext.clientIp,
          action: `api.${operation}`,
          resource: `${params.npub}/${params.repo}`,
          result: 'failure',
          error: err instanceof Error ? err.message : String(err)
        });
      }
      
      throw err;
    }
  };
}

/**
 * Create a handler factory for common repository API patterns
 * 
 * @param config - Handler configuration
 * @returns RequestHandler factory function
 */
export function createRepoHandler(config: {
  get?: (context: RepoRequestContext, event: RequestEvent) => Promise<Response>;
  post?: (context: RepoRequestContext, event: RequestEvent) => Promise<Response>;
  put?: (context: RepoRequestContext, event: RequestEvent) => Promise<Response>;
  delete?: (context: RepoRequestContext, event: RequestEvent) => Promise<Response>;
  options?: HandlerOptions;
}): {
  GET?: RequestHandler;
  POST?: RequestHandler;
  PUT?: RequestHandler;
  DELETE?: RequestHandler;
} {
  const handlerOptions = config.options || {};
  
  const result: {
    GET?: RequestHandler;
    POST?: RequestHandler;
    PUT?: RequestHandler;
    DELETE?: RequestHandler;
  } = {};
  
  if (config.get) {
    result.GET = createRepoGetHandler(config.get, handlerOptions);
  }
  
  if (config.post) {
    result.POST = createRepoPostHandler(config.post, handlerOptions);
  }
  
  if (config.put) {
    result.PUT = withRepoValidation(async ({ repoContext, requestContext, event }) => {
      const repoRequestContext: RepoRequestContext = {
        ...repoContext,
        ...requestContext
      };
      return await config.put!(repoRequestContext, event);
    }, {
      requireRepoExists: true,
      requireMaintainer: true,
      ...handlerOptions
    });
  }
  
  if (config.delete) {
    result.DELETE = withRepoValidation(async ({ repoContext, requestContext, event }) => {
      const repoRequestContext: RepoRequestContext = {
        ...repoContext,
        ...requestContext
      };
      return await config.delete!(repoRequestContext, event);
    }, {
      requireRepoExists: true,
      requireMaintainer: true,
      ...handlerOptions
    });
  }
  
  return result;
}
