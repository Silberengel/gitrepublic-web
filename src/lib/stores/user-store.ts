/**
 * User store for managing user state and access level across the application
 */

import { writable } from 'svelte/store';
import type { UserLevel } from '../services/nostr/user-level-service.js';

export interface UserState {
  userPubkey: string | null;
  userPubkeyHex: string | null;
  userLevel: UserLevel;
  checkingLevel: boolean;
  error: string | null;
}

const initialState: UserState = {
  userPubkey: null,
  userPubkeyHex: null,
  userLevel: 'strictly_rate_limited',
  checkingLevel: false,
  error: null
};

function createUserStore() {
  const { subscribe, set, update } = writable<UserState>(initialState);

  return {
    subscribe,
    set,
    update,
    reset: () => set(initialState),
    setChecking: (checking: boolean) => {
      update(state => ({ ...state, checkingLevel: checking }));
    },
    setUser: (
      userPubkey: string | null,
      userPubkeyHex: string | null,
      userLevel: UserLevel,
      error: string | null = null
    ) => {
      update(state => ({
        ...state,
        userPubkey,
        userPubkeyHex,
        userLevel,
        checkingLevel: false,
        error
      }));
    }
  };
}

export const userStore = createUserStore();
