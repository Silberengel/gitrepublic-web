/**
 * Settings store using IndexedDB for persistent client-side storage
 * Stores: auto-save, user.name, user.email, theme
 */

import logger from './logger.js';

const DB_NAME = 'gitrepublic_settings';
const DB_VERSION = 1;
const STORE_SETTINGS = 'settings';

interface Settings {
  autoSave: boolean;
  userName: string;
  userEmail: string;
  theme: 'gitrepublic-light' | 'gitrepublic-dark' | 'gitrepublic-black';
  defaultBranch: string;
}

const DEFAULT_SETTINGS: Settings = {
  autoSave: false,
  userName: '',
  userEmail: '',
  theme: 'gitrepublic-dark',
  defaultBranch: 'master'
};

export class SettingsStore {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private settingsCache: Settings | null = null;

  constructor() {
    this.init();
  }

  /**
   * Initialize IndexedDB
   */
  private async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    if (typeof window === 'undefined' || !window.indexedDB) {
      logger.warn('IndexedDB not available, using in-memory cache only');
      return;
    }

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        logger.error('Failed to open settings IndexedDB');
        reject(new Error('Failed to open settings IndexedDB'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Settings store - stores all settings as a single object
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'id' });
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Get all settings
   */
  async getSettings(): Promise<Settings> {
    await this.init();

    // Return cached settings if available
    if (this.settingsCache) {
      return this.settingsCache;
    }

    if (!this.db) {
      return { ...DEFAULT_SETTINGS };
    }

    try {
      const store = this.db.transaction([STORE_SETTINGS], 'readonly').objectStore(STORE_SETTINGS);
      const request = store.get('main');

      const result = await new Promise<Settings>((resolve, reject) => {
        request.onsuccess = () => {
          const data = request.result;
          if (data && data.settings) {
            // Merge with defaults to ensure all fields exist
            const merged = { ...DEFAULT_SETTINGS, ...data.settings };
            resolve(merged);
          } else {
            resolve({ ...DEFAULT_SETTINGS });
          }
        };
        request.onerror = () => reject(request.error);
      });

      // Cache the result
      this.settingsCache = result;
      return result;
    } catch (error) {
      logger.error({ error }, 'Error reading settings from IndexedDB');
      return { ...DEFAULT_SETTINGS };
    }
  }

  /**
   * Update settings (partial update)
   */
  async updateSettings(updates: Partial<Settings>): Promise<void> {
    await this.init();

    if (!this.db) {
      logger.warn('IndexedDB not available, cannot save settings');
      return;
    }

    try {
      // Get current settings
      const current = await this.getSettings();
      
      // Merge with updates
      const updated = { ...current, ...updates };

      // Save to IndexedDB
      const store = this.db.transaction([STORE_SETTINGS], 'readwrite').objectStore(STORE_SETTINGS);
      await new Promise<void>((resolve, reject) => {
        const request = store.put({ id: 'main', settings: updated });
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      // Update cache
      this.settingsCache = updated;

      logger.debug({ updates }, 'Settings updated');
    } catch (error) {
      logger.error({ error, updates }, 'Error updating settings');
      throw error;
    }
  }

  /**
   * Get a specific setting
   */
  async getSetting<K extends keyof Settings>(key: K): Promise<Settings[K]> {
    const settings = await this.getSettings();
    return settings[key];
  }

  /**
   * Set a specific setting
   */
  async setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
    await this.updateSettings({ [key]: value } as Partial<Settings>);
  }

  /**
   * Clear all settings (reset to defaults)
   */
  async clear(): Promise<void> {
    await this.init();

    if (!this.db) {
      return;
    }

    try {
      const store = this.db.transaction([STORE_SETTINGS], 'readwrite').objectStore(STORE_SETTINGS);
      await new Promise<void>((resolve, reject) => {
        const request = store.delete('main');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      // Clear cache
      this.settingsCache = null;
    } catch (error) {
      logger.error({ error }, 'Error clearing settings');
    }
  }
}

// Singleton instance
export const settingsStore = new SettingsStore();
