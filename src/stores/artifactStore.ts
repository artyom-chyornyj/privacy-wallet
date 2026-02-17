import { create } from 'zustand'

import {
  ALL_VARIANTS,
  ArtifactDownloadService,
  COMMON_VARIANTS_WITH_POI,
} from '@/services/ArtifactDownloadService'

interface ArtifactStore {
  downloadedVariants: string[]
  downloading: boolean
  downloadProgress: { current: number; total: number; currentVariant: string } | null
  downloadError: string | null

  refreshDownloadedVariants: () => Promise<void>
  downloadCommonCircuits: () => Promise<void>
  downloadAllCircuits: () => Promise<void>
  clearArtifacts: () => Promise<void>
}

const useArtifactStore = create<ArtifactStore>()((set) => ({
  downloadedVariants: [],
  downloading: false,
  downloadProgress: null,
  downloadError: null,

  /**
   * Query IndexedDB for all fully downloaded circuit variants and update state.
   */
  refreshDownloadedVariants: async () => {
    const service = ArtifactDownloadService.getInstance()
    const variants = await service.getDownloadedVariants()
    set({ downloadedVariants: variants })
  },

  /**
   * Download the common circuit variants used by most transactions.
   */
  downloadCommonCircuits: async () => {
    set({ downloading: true, downloadError: null, downloadProgress: null })
    try {
      const service = ArtifactDownloadService.getInstance()
      await service.downloadCommonVariants((current, total, currentVariant) => {
        set({ downloadProgress: { current, total, currentVariant } })
      })
      const variants = await service.getDownloadedVariants()
      set({ downloadedVariants: variants, downloadProgress: null })
    } catch (err: unknown) {
      set({ downloadError: err instanceof Error ? err.message : 'Failed to download circuits.' })
    } finally {
      set({ downloading: false })
    }
  },

  /**
   * Download all possible circuit variants (93 V2 + 2 POI).
   */
  downloadAllCircuits: async () => {
    set({ downloading: true, downloadError: null, downloadProgress: null })
    try {
      const service = ArtifactDownloadService.getInstance()
      await service.downloadAllVariants((current, total, currentVariant) => {
        set({ downloadProgress: { current, total, currentVariant } })
      })
      const variants = await service.getDownloadedVariants()
      set({ downloadedVariants: variants, downloadProgress: null })
    } catch (err: unknown) {
      set({ downloadError: err instanceof Error ? err.message : 'Failed to download circuits.' })
    } finally {
      set({ downloading: false })
    }
  },

  /**
   * Clear all downloaded artifacts from IndexedDB and reset state.
   */
  clearArtifacts: async () => {
    const service = ArtifactDownloadService.getInstance()
    await service.clearDownloadedArtifacts()
    set({ downloadedVariants: [], downloadProgress: null, downloadError: null })
  },
}))

export { useArtifactStore, COMMON_VARIANTS_WITH_POI, ALL_VARIANTS }
