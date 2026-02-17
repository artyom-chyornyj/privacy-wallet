import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { dlog } from '@/utils/debug'

interface LegalAcceptance {
  termsVersion: string
  acceptedAt: number
  // Matches the seven checkboxes in LegalAgreementModal
  termsAccepted: boolean
  networkDisclosure: boolean
  sanctionsCompliance: boolean
  ppoiEnforcement: boolean
  licenseRestrictions: boolean
  conductRestrictions: boolean
  noWarranty: boolean
}

interface LegalStore {
  hasAcceptedTerms: boolean
  acceptance: LegalAcceptance | null

  // Actions
  acceptTerms: () => void
  resetAcceptance: () => void
}

// Increment this version when terms change significantly to require re-acceptance
const CURRENT_TERMS_VERSION = '1.0.0'

export const useLegalStore = create<LegalStore>()(
  persist(
    (set) => ({
      hasAcceptedTerms: false,
      acceptance: null,

      /**
       * Records full acceptance of all legal terms with the current version and timestamp.
       */
      acceptTerms: () => {
        const acceptance: LegalAcceptance = {
          termsVersion: CURRENT_TERMS_VERSION,
          acceptedAt: Date.now(),
          termsAccepted: true,
          networkDisclosure: true,
          sanctionsCompliance: true,
          ppoiEnforcement: true,
          licenseRestrictions: true,
          conductRestrictions: true,
          noWarranty: true,
        }

        set({
          hasAcceptedTerms: true,
          acceptance,
        })
      },

      /**
       * Clears the stored legal acceptance, requiring the user to re-accept terms.
       */
      resetAcceptance: () => {
        set({
          hasAcceptedTerms: false,
          acceptance: null,
        })
      },
    }),
    {
      name: 'privacy-wallet-legal',
      // On rehydration, verify the terms version is current
      /**
       * Verifies the stored terms version matches the current version on rehydration.
       * @returns A callback that resets acceptance if the terms version has changed
       */
      onRehydrateStorage: () => (state, error) => {
        if (error) return
        if (state?.acceptance?.termsVersion !== CURRENT_TERMS_VERSION) {
          dlog('Terms version changed, requiring re-acceptance')
          useLegalStore.setState({ hasAcceptedTerms: false, acceptance: null })
        }
      },
    }
  )
)
