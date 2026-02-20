/**
 * Client-side messaging preferences storage using IndexedDB
 * This replaces the server-side in-memory storage
 */

import { settingsStore } from '../settings-store.js';
import type { MessagingPreferences } from './preferences-types.js';

/**
 * Store user messaging preferences in IndexedDB settings
 */
export async function storePreferences(
  preferences: MessagingPreferences
): Promise<void> {
  await settingsStore.updateSettings({ messagingPreferences: preferences });
}

/**
 * Retrieve user messaging preferences from IndexedDB
 */
export async function getPreferences(): Promise<MessagingPreferences | null> {
  const settings = await settingsStore.getSettings();
  return settings.messagingPreferences || null;
}

/**
 * Check if user has preferences configured
 */
export async function hasPreferences(): Promise<boolean> {
  const preferences = await getPreferences();
  return preferences !== null && preferences !== undefined;
}

/**
 * Delete user messaging preferences
 */
export async function deletePreferences(): Promise<void> {
  await settingsStore.updateSettings({ messagingPreferences: undefined });
}
