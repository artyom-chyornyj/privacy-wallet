import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import type { NetworkName } from '@/types/network'

interface SettingsStore {
  debugEnabled: boolean
  customRpcUrls: Partial<Record<NetworkName, string>>

  // Actions
  setDebugEnabled: (enabled: boolean) => void
  setCustomRpcUrl: (network: NetworkName, url: string) => void
  clearCustomRpcUrl: (network: NetworkName) => void
}

const SETTINGS_STORAGE_KEY = 'privacy-wallet-settings'

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      debugEnabled: false,
      customRpcUrls: {},

      /**
       * Enables or disables debug logging throughout the application.
       * @param enabled - Whether debug mode should be active
       */
      setDebugEnabled: (enabled: boolean) => {
        set({ debugEnabled: enabled })
      },

      /**
       * Sets a custom RPC URL for a specific network, overriding the default.
       * @param network - The network to configure
       * @param url - The custom RPC endpoint URL
       */
      setCustomRpcUrl: (network: NetworkName, url: string) => {
        set((state) => ({
          customRpcUrls: { ...state.customRpcUrls, [network]: url },
        }))
      },

      /**
       * Removes a custom RPC URL for a network, reverting to the default.
       * @param network - The network to clear the custom URL for
       */
      clearCustomRpcUrl: (network: NetworkName) => {
        set((state) => {
          const updated = { ...state.customRpcUrls }
          delete updated[network]
          return { customRpcUrls: updated }
        })
      },
    }),
    {
      name: SETTINGS_STORAGE_KEY,
    }
  )
)
