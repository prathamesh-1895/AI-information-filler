/** Panel state shared across screens (Zustand). The background stays the source of truth. */
import type { SessionState } from '@filler/core';
import { create } from 'zustand';
import { call, getTargetTab, vaultStatus } from '@/src/messaging/client';
import type { TargetTab } from '@/src/messaging/protocol';
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '@/src/settings';

export type VaultState = 'loading' | 'uninitialized' | 'locked' | 'unlocked';
export type View = 'fill' | 'vault' | 'settings';

interface PanelStore {
  vault: VaultState;
  settings: Settings;
  view: View;
  target: TargetTab | null;
  session: SessionState | null;
  setView(view: View): void;
  setSession(session: SessionState | null): void;
  refreshVault(): Promise<VaultState>;
  refreshTarget(): Promise<TargetTab | null>;
  loadSettings(): Promise<void>;
  updateSettings(patch: SettingsPatch): Promise<void>;
}

export const usePanel = create<PanelStore>((set, get) => ({
  vault: 'loading',
  settings: DEFAULT_SETTINGS,
  view: 'fill',
  target: null,
  session: null,
  setView: (view) => set({ view }),
  setSession: (session) => set({ session }),
  async refreshVault() {
    const result = await vaultStatus();
    const vault: VaultState = result.ok ? result.data.status : 'loading';
    set({ vault });
    return vault;
  },
  async refreshTarget() {
    const result = await getTargetTab();
    const target = result.ok ? result.data : null;
    if (target?.tabId !== get().target?.tabId) set({ session: null });
    set({ target });
    return target;
  },
  async loadSettings() {
    const result = await call<Settings>({ type: 'SETTINGS_GET' });
    if (result.ok) set({ settings: result.data });
  },
  async updateSettings(patch) {
    set({ settings: { ...get().settings, ...patch } }); // optimistic
    const result = await call<Settings>({ type: 'SETTINGS_SET', patch });
    if (result.ok) set({ settings: result.data });
  },
}));
