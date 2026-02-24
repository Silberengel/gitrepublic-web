/**
 * API client utilities for repository operations
 * Provides centralized API call functions with error handling and logging
 */

import { get } from 'svelte/store';
import { userStore } from '$lib/stores/user-store.js';
import logger from '$lib/services/logger.js';

/**
 * Builds API headers with user pubkey for authenticated requests
 */
export function buildApiHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const currentUser = get(userStore);
  const currentUserPubkeyHex = currentUser?.userPubkeyHex;
  if (currentUserPubkeyHex) {
    headers['X-User-Pubkey'] = currentUserPubkeyHex;
    logger.debug({ pubkey: currentUserPubkeyHex.substring(0, 16) + '...' }, '[API] Sending X-User-Pubkey header');
  }
  return headers;
}

/**
 * Makes an API request with error handling and logging
 */
export async function apiRequest<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = {
    ...buildApiHeaders(),
    ...options.headers,
    'Content-Type': 'application/json',
  };

  logger.debug({ url, method: options.method || 'GET' }, '[API] Making request');

  try {
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: 'same-origin',
    });

    if (!response.ok) {
      let errorMessage = `API request failed: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.message) {
          errorMessage = errorData.message;
        } else if (errorData.error) {
          errorMessage = errorData.error;
        }
      } catch {
        try {
          const text = await response.text();
          if (text) {
            errorMessage = text.substring(0, 200);
          }
        } catch {
          // Ignore parsing errors
        }
      }
      logger.error({ url, status: response.status, error: errorMessage }, '[API] Request failed');
      throw new Error(errorMessage);
    }

    const data = await response.json();
    logger.debug({ url }, '[API] Request successful');
    return data as T;
  } catch (err) {
    logger.error({ url, error: err }, '[API] Request error');
    throw err;
  }
}

/**
 * Makes a POST request
 */
export async function apiPost<T>(
  url: string,
  body: unknown
): Promise<T> {
  return apiRequest<T>(url, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Makes a PUT request
 */
export async function apiPut<T>(
  url: string,
  body: unknown
): Promise<T> {
  return apiRequest<T>(url, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/**
 * Makes a DELETE request
 */
export async function apiDelete<T>(url: string): Promise<T> {
  return apiRequest<T>(url, {
    method: 'DELETE',
  });
}
