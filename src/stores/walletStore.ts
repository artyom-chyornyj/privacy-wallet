import { ethers } from 'ethers'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import { OnChainBalanceScanner } from '@/services/OnChainBalanceScanner'
import { POIService } from '@/services/POIService'
import { PublicBalanceService } from '@/services/PublicBalanceService'
import { PublicTransactionService } from '@/services/PublicTransactionService'
import { ShieldTransactionService } from '@/services/ShieldTransactionService'
import { SubsquidBalanceScanner as BalanceScanner } from '@/services/SubsquidBalanceScanner'
import { TokenService } from '@/services/TokenService'
import { TransactionHistoryService } from '@/services/TransactionHistoryService'
import { NETWORK_CONFIG, NetworkName, getEffectiveRpcUrl } from '@/types/network'
import type {
  DetailedTransaction,
  GasPayerWallet,
  POIStatus,
  RailgunWallet,
  SavedWalletMetadata,
  ShieldTransactionParams,
  WalletState
} from '@/types/wallet'
import {
  ByteUtils,
  generateMnemonic as cryptoGenerateMnemonic,
  deriveRailgunKeys,
  generateRailgunAddress,
  getEthereumAddress,
  validateMnemonic,
} from '@/utils/crypto'
import { dlog, dwarn } from '@/utils/debug'
import {
  decryptWithPassword,
  encryptWithPassword,
  resetRateLimit,
  validatePassword,
} from '@/utils/passwordEncryption'
import { secureLog } from '@/utils/security'

/**
 * Revive BigInt fields in deserialized transactions.
 * JSON.stringify converts BigInt to strings; this converts them back.
 * @param transactions - Array of raw deserialized transaction objects with string amounts.
 * @returns Array of DetailedTransaction objects with proper BigInt fields.
 */
function reviveTransactionBigInts (transactions: any[]): DetailedTransaction[] {
  return transactions.map((tx: any) => ({
    ...tx,
    transferredTokens:
      tx.transferredTokens?.map((t: any) => ({
        ...t,
        amount: typeof t.amount === 'bigint' ? t.amount : BigInt(t.amount || '0'),
      })) || [],
    shieldFee: tx.shieldFee != null ? BigInt(tx.shieldFee) : undefined,
    unshieldFee: tx.unshieldFee != null ? BigInt(tx.unshieldFee) : undefined,
    relayerFee: tx.relayerFee != null ? BigInt(tx.relayerFee) : undefined,
    gasCost: tx.gasCost != null ? BigInt(tx.gasCost) : undefined,
  }))
}

/** Default POI-related state used by lockWallet and resetWallet. */
const DEFAULT_POI_STATE = {
  commitmentPOIStatus: {} as Record<string, POIStatus>,
  checkedCommitments: new Set<string>(),
  isCheckingPOI: false,
  poiCheckProgress: { checked: 0, total: 0 },
} as const

interface WalletStore extends WalletState {
  // Multi-wallet state
  savedWallets: SavedWalletMetadata[]
  sessionPassword?: string
  isPasswordSet: boolean

  // Gas wallet state
  unlockedGasWallets: GasPayerWallet[]
  selectedGasWalletId: string | null

  // Actions
  setCurrentNetwork: (network: NetworkName) => void
  setBalanceMode: (mode: 'private' | 'public') => void
  createWallet: (nickname?: string, password?: string) => Promise<RailgunWallet>
  importWallet: (
    mnemonic: string,
    nickname?: string,
    password?: string,
    options?: { skipClearTXOs?: boolean },
  ) => Promise<RailgunWallet>
  switchWallet: (walletId: string, password?: string) => Promise<void>
  deleteWallet: (walletId: string) => void
  updateWalletNickname: (walletId: string, nickname: string) => void
  loadSavedWallets: () => void
  saveWalletMetadata: (wallet: RailgunWallet, password?: string) => Promise<void>
  // Password management
  setPassword: (password: string) => void
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  validateSessionPassword: (walletId: string) => Promise<boolean>
  lockWallet: () => void

  // Gas wallet management
  unlockWalletForGas: (walletId: string, password: string) => Promise<void>
  lockGasWallet: (walletId: string) => void
  setSelectedGasWallet: (walletId: string | null) => void
  getGasPayerWallet: () => GasPayerWallet | null
  refreshBalances: () => Promise<void>
  forceRescanBalances: () => Promise<void>
  resetWallet: () => void
  // Wallet scoped state helpers
  loadWalletScopedState: () => void
  saveWalletScopedState: () => void

  // Commitment-level PPOI state (shared across BalancesPage + TransactionList)
  commitmentPOIStatus: Record<string, POIStatus>
  /**
   * Set of commitment hashes that have been status-checked via a network call.
   *  Used to prevent showing "Submit PPOI" before we know the real status.
   */
  checkedCommitments: Set<string>
  isCheckingPOI: boolean
  poiCheckProgress: { checked: number; total: number }
  getUncheckedPOICount: () => number
  checkAllCommitmentPOI: () => Promise<void>
  checkSingleCommitmentPOI: (
    blindedCommitment: string,
    type: 'Shield' | 'Transact' | 'Unshield',
  ) => Promise<void>
  loadCachedPOIStatus: () => void
  clearCommitmentPOIStatus: (blindedCommitment: string) => void

  // Shield Transaction Actions
  executeShieldTransaction: (params: ShieldTransactionParams) => Promise<{ txHash: string }>
  estimateShieldGas: (
    params: ShieldTransactionParams,
  ) => Promise<{ gasEstimate: bigint; totalCost: bigint }>
  canShieldToken: (tokenAddress: string) => Promise<boolean>

  // Token Approval Actions
  isTokenApprovedForShield: (tokenAddress: string, amount?: string) => Promise<boolean>
  approveTokenForShield: (tokenAddress: string, amount?: string) => Promise<{ txHash: string }>
  checkTokenApprovalStatus: (
    tokenAddress: string,
    amount?: string,
  ) => Promise<{ isApproved: boolean; allowance: string }>

  // Sync state
  isSyncing: boolean
  lastError?: string
}

export const useWalletStore = create<WalletStore>()(
  persist(
    (set, get) => ({
      // Initial state
      isInitialized: false,
      currentNetwork: NetworkName.EthereumSepolia,
      balances: [],
      transactions: [],
      balanceMode: 'private',
      ...DEFAULT_POI_STATE,
      isSyncing: false,
      savedWallets: [],
      isPasswordSet: false,
      unlockedGasWallets: [],
      selectedGasWalletId: null,

      // Actions
      /**
       * Switch the active network, clearing balances and POI state.
       * @param network - The network to switch to.
       */
      setCurrentNetwork: (network: NetworkName) => {
        set({ currentNetwork: network, balances: [], transactions: [], ...DEFAULT_POI_STATE })
        try {
          const { currentWallet, sessionPassword } = get()
          if (currentWallet && sessionPassword) {
            TokenService.getInstance()
              .loadHiddenTokens(currentWallet.id, network, sessionPassword)
              .catch(() => {})
          }
          get().loadWalletScopedState()
        } catch {}
      },

      /**
       * Switch between private and public balance display mode.
       * @param mode - Either 'private' for shielded balances or 'public' for on-chain balances.
       */
      setBalanceMode: (mode: 'private' | 'public') => {
        set({ balanceMode: mode, balances: [], transactions: [], ...DEFAULT_POI_STATE })
        try {
          get().loadWalletScopedState()
        } catch {}
      },

      /**
       * Load cached balances, transactions, and POI status from localStorage for the current wallet, network, and balance mode.
       */
      loadWalletScopedState: () => {
        const { currentWallet, currentNetwork, balanceMode } = get()
        if (!currentWallet) return

        try {
          const key = `wallet:${currentWallet.id}:state:${balanceMode}:${currentNetwork}`
          const saved = localStorage.getItem(key)
          if (!saved) return

          const parsed = JSON.parse(saved)

          const balances =
            parsed.balances?.map((b: any) => ({
              ...b,
              balance: BigInt(b.balance),
            })) || []

          const transactions = reviveTransactionBigInts(parsed.transactions || [])

          const tokenService = TokenService.getInstance()
          const filteredBalances = balances.filter(
            (b: any) =>
              !tokenService.isTokenHidden(b.tokenAddress, currentWallet.id, currentNetwork)
          )

          set({
            balances: filteredBalances,
            transactions,
            lastBalanceUpdate: parsed.lastBalanceUpdate || undefined,
            commitmentPOIStatus: parsed.commitmentPOIStatus || {},
            checkedCommitments: new Set<string>(parsed.checkedCommitments || []),
          })
          get().loadCachedPOIStatus()
        } catch (e) {
          console.error('Error loading wallet-scoped state:', e)
        }
      },

      /**
       * Persist current balances, transactions, and POI status to localStorage for the current wallet, network, and balance mode.
       */
      saveWalletScopedState: () => {
        const {
          currentWallet,
          currentNetwork,
          balanceMode,
          balances,
          transactions,
          lastBalanceUpdate,
          commitmentPOIStatus,
          checkedCommitments,
        } = get()
        if (!currentWallet) return
        try {
          const key = `wallet:${currentWallet.id}:state:${balanceMode}:${currentNetwork}`

          const serializedBalances = balances.map((b) => ({
            ...b,
            balance: b.balance.toString(),
          }))

          const serializedTransactions = JSON.parse(
            JSON.stringify(transactions, (_key, value) => {
              return typeof value === 'bigint' ? value.toString() : value
            })
          )

          localStorage.setItem(
            key,
            JSON.stringify({
              balances: serializedBalances,
              transactions: serializedTransactions,
              lastBalanceUpdate,
              commitmentPOIStatus,
              checkedCommitments: Array.from(checkedCommitments),
            })
          )
        } catch (e) {
          console.error('Error saving wallet-scoped state:', e)
        }
      },

      /**
       * Load saved wallet metadata from localStorage into state.
       */
      loadSavedWallets: () => {
        try {
          const saved = localStorage.getItem('railgun-wallets')
          if (saved) {
            set({ savedWallets: JSON.parse(saved) as SavedWalletMetadata[] })
          }
        } catch (error) {
          console.error('Error loading saved wallets:', error)
        }
      },

      /**
       * Encrypt and persist wallet metadata (including mnemonic) to localStorage.
       * @param wallet - The wallet whose metadata to save.
       * @param password - Optional password override; falls back to session password.
       */
      saveWalletMetadata: async (wallet: RailgunWallet, password?: string) => {
        try {
          const { sessionPassword } = get()
          const passwordToUse = password || sessionPassword

          if (!passwordToUse || !wallet.mnemonic) {
            throw new Error('Password is required to save wallet')
          }

          const encryptedMnemonic = await encryptWithPassword(wallet.mnemonic, passwordToUse)

          const metadata: SavedWalletMetadata = {
            id: wallet.id,
            nickname: wallet.nickname || `Wallet ${wallet.address.slice(0, 10)}...`,
            address: wallet.address,
            ethereumAddress: wallet.ethereumAddress,
            createdAt: wallet.createdAt,
            encryptedMnemonic,
          }

          const saved = localStorage.getItem('railgun-wallets')
          const wallets = saved ? JSON.parse(saved) : []

          const existingIndex = wallets.findIndex((w: SavedWalletMetadata) => w.id === wallet.id)
          if (existingIndex >= 0) {
            wallets[existingIndex] = metadata
          } else {
            wallets.push(metadata)
          }

          localStorage.setItem('railgun-wallets', JSON.stringify(wallets))
          set({ savedWallets: wallets, isPasswordSet: true })
        } catch (error) {
          console.error('Error saving wallet metadata:', error)
          throw error
        }
      },

      /**
       * Switch to a different saved wallet by decrypting its mnemonic and re-importing it.
       * @param walletId - The ID of the wallet to switch to.
       * @param password - Optional password override; falls back to session password.
       */
      switchWallet: async (walletId: string, password?: string) => {
        try {
          get().saveWalletScopedState()

          const { savedWallets, sessionPassword } = get()
          const passwordToUse = password || sessionPassword

          const walletMetadata = savedWallets.find((w) => w.id === walletId)
          if (!walletMetadata) {
            throw new Error('Wallet not found')
          }

          if (!walletMetadata.encryptedMnemonic) {
            throw new Error(
              'This wallet was created before password encryption was enabled. Please delete it and re-import it with a password to enable wallet switching.'
            )
          }

          if (!passwordToUse) {
            throw new Error('Password is required to switch wallets')
          }

          const mnemonic = await decryptWithPassword(
            walletMetadata.encryptedMnemonic,
            passwordToUse
          )

          const wallet = await get().importWallet(
            mnemonic,
            walletMetadata.nickname,
            passwordToUse,
            { skipClearTXOs: true }
          )

          if (wallet.id !== walletId) {
            throw new Error('Wallet ID mismatch')
          }

          if (!sessionPassword) {
            set({ sessionPassword: passwordToUse })
          }

          localStorage.setItem('railgun-last-wallet-id', walletId)

          const tokenService = TokenService.getInstance()
          const { currentNetwork } = get()
          await tokenService.loadHiddenTokens(walletId, currentNetwork, passwordToUse)

          // Clear transient state and load cached state for the switched wallet
          set((state) => {
            const { lastBalanceUpdate: _, ...rest } = state
            return { ...rest, balances: [], transactions: [] }
          })
          get().loadWalletScopedState()
        } catch (error) {
          console.error('Error switching wallet:', error)
          throw error
        }
      },

      /**
       * Delete a saved wallet, removing its metadata from localStorage and clearing cached data.
       * @param walletId - The ID of the wallet to delete.
       */
      deleteWallet: (walletId: string) => {
        try {
          const saved = localStorage.getItem('railgun-wallets')
          if (saved) {
            const wallets = JSON.parse(saved) as SavedWalletMetadata[]
            const filtered = wallets.filter((w) => w.id !== walletId)
            localStorage.setItem('railgun-wallets', JSON.stringify(filtered))
            set({ savedWallets: filtered })
          }

          // Clear all cached data for this wallet
          for (const key of Object.keys(localStorage)) {
            if (key.startsWith(`wallet:${walletId}:`)) {
              localStorage.removeItem(key)
            }
          }

          try {
            BalanceScanner.getInstance().clearStoredTXOs(walletId)
          } catch (e) {
            dwarn('Could not clear TXO cache:', e)
          }

          const { currentWallet } = get()
          if (currentWallet?.id === walletId) {
            set((state) => {
              const { currentWallet: _, ...rest } = state
              return { ...rest, isInitialized: false, balances: [], transactions: [] }
            })
          }
        } catch (error) {
          console.error('Error deleting wallet:', error)
          throw error
        }
      },

      /**
       * Update the display nickname for a wallet in both state and localStorage.
       * @param walletId - The ID of the wallet to rename.
       * @param nickname - The new nickname to assign.
       */
      updateWalletNickname: (walletId: string, nickname: string) => {
        try {
          const { currentWallet } = get()

          if (currentWallet?.id === walletId) {
            const updatedWallet = { ...currentWallet, nickname }
            set({ currentWallet: updatedWallet })
            get().saveWalletMetadata(updatedWallet)
          } else {
            const saved = localStorage.getItem('railgun-wallets')
            const wallets = saved ? JSON.parse(saved) : []
            const walletIndex = wallets.findIndex((w: SavedWalletMetadata) => w.id === walletId)

            if (walletIndex >= 0) {
              wallets[walletIndex].nickname = nickname
              localStorage.setItem('railgun-wallets', JSON.stringify(wallets))
              set({ savedWallets: wallets })
            }
          }
        } catch (error) {
          console.error('Error updating wallet nickname:', error)
          throw error
        }
      },

      /**
       * Store the session password in state and mark password as set.
       * @param password - The password to store for the current session.
       */
      setPassword: (password: string) => {
        set({ sessionPassword: password, isPasswordSet: true })
      },

      /**
       * Re-encrypt all saved wallet mnemonics with a new password after validating the current one.
       * @param currentPassword - The current password used to decrypt existing mnemonics.
       * @param newPassword - The new password to encrypt mnemonics with.
       */
      changePassword: async (currentPassword: string, newPassword: string) => {
        const { savedWallets } = get()
        if (!savedWallets.length) {
          throw new Error('No wallets saved')
        }

        // Decrypt all mnemonics first to validate the current password.
        // If any wallet fails, abort before writing anything.
        const decrypted: { index: number; mnemonic: string }[] = []
        for (let i = 0; i < savedWallets.length; i++) {
          const w = savedWallets[i]!
          try {
            const mnemonic = await decryptWithPassword(w.encryptedMnemonic, currentPassword)
            decrypted.push({ index: i, mnemonic })
          } catch {
            throw new Error('Current password is incorrect.')
          }
        }

        const updatedWallets = [...savedWallets]
        for (const { index, mnemonic } of decrypted) {
          updatedWallets[index] = {
            ...updatedWallets[index]!,
            encryptedMnemonic: await encryptWithPassword(mnemonic, newPassword),
          }
        }

        localStorage.setItem('railgun-wallets', JSON.stringify(updatedWallets))
        set({ savedWallets: updatedWallets, sessionPassword: newPassword })
      },

      /**
       * Validate whether the current session password can decrypt the given wallet's mnemonic.
       * @param walletId - The ID of the wallet to validate against.
       * @returns Whether the session password is valid for this wallet.
       */
      validateSessionPassword: async (walletId: string): Promise<boolean> => {
        try {
          const { savedWallets, sessionPassword } = get()
          if (!sessionPassword) return false

          const walletMetadata = savedWallets.find((w) => w.id === walletId)
          if (!walletMetadata) return false

          return await validatePassword(walletMetadata.encryptedMnemonic, sessionPassword)
        } catch {
          return false
        }
      },

      /**
       * Lock the wallet by clearing all sensitive data from memory, resetting session state and POI status.
       */
      lockWallet: () => {
        secureLog.log('Locking wallet - clearing all sensitive data from memory')

        TokenService.getInstance().clearHiddenTokensCache()
        resetRateLimit()

        set((state) => {
          const { sessionPassword: _sp, currentWallet: _cw, lastError: _le, ...rest } = state
          return {
            ...rest,
            isInitialized: false,
            balances: [],
            transactions: [],
            ...DEFAULT_POI_STATE,
            isSyncing: false,
            unlockedGasWallets: [],
            selectedGasWalletId: null,
          }
        })
      },

      // Gas wallet management actions
      /**
       * Unlock a saved wallet for use as a gas payer by decrypting its mnemonic.
       * @param walletId - The ID of the wallet to unlock.
       * @param password - The password to decrypt the wallet's mnemonic.
       */
      unlockWalletForGas: async (walletId: string, password: string) => {
        const { savedWallets, unlockedGasWallets } = get()

        const walletMetadata = savedWallets.find((w) => w.id === walletId)
        if (!walletMetadata) {
          throw new Error('Wallet not found')
        }

        if (!walletMetadata.encryptedMnemonic) {
          throw new Error('This wallet does not have an encrypted mnemonic')
        }

        // Validate password by attempting decryption (throws on wrong password)
        const mnemonic = await decryptWithPassword(walletMetadata.encryptedMnemonic, password)

        if (unlockedGasWallets.some((w) => w.id === walletId)) {
          return
        }

        const gasWallet: GasPayerWallet = {
          id: walletMetadata.id,
          nickname: walletMetadata.nickname,
          ethereumAddress: walletMetadata.ethereumAddress,
          mnemonic,
        }

        set({ unlockedGasWallets: [...unlockedGasWallets, gasWallet] })
      },

      /**
       * Lock a gas payer wallet, removing its mnemonic from memory.
       * @param walletId - The ID of the gas wallet to lock.
       */
      lockGasWallet: (walletId: string) => {
        set((state) => ({
          unlockedGasWallets: state.unlockedGasWallets.filter((w) => w.id !== walletId),
          selectedGasWalletId:
            state.selectedGasWalletId === walletId ? null : state.selectedGasWalletId,
        }))
      },

      /**
       * Select an unlocked wallet as the active gas payer, or clear the selection.
       * @param walletId - The ID of the gas wallet to select, or null to clear.
       */
      setSelectedGasWallet: (walletId: string | null) => {
        const { unlockedGasWallets, currentWallet } = get()

        if (walletId === null || walletId === currentWallet?.id) {
          set({ selectedGasWalletId: null })
          return
        }

        if (!unlockedGasWallets.some((w) => w.id === walletId)) {
          throw new Error('Cannot select a locked wallet for gas payment')
        }

        set({ selectedGasWalletId: walletId })
      },

      /**
       * Get the currently selected gas payer wallet, if any.
       * @returns The selected gas payer wallet or null if none is selected.
       */
      getGasPayerWallet: () => {
        const { selectedGasWalletId, unlockedGasWallets } = get()
        if (!selectedGasWalletId) return null
        return unlockedGasWallets.find((w) => w.id === selectedGasWalletId) || null
      },

      /**
       * Generate a new mnemonic and create a wallet from it.
       * @param nickname - Optional display name for the wallet.
       * @param password - Optional password to encrypt the mnemonic.
       * @returns The newly created RAILGUN wallet.
       */
      createWallet: async (nickname?: string, password?: string): Promise<RailgunWallet> => {
        const mnemonic = cryptoGenerateMnemonic()
        return get().importWallet(mnemonic, nickname, password)
      },

      /**
       * Import a wallet from a mnemonic phrase, deriving RAILGUN and Ethereum keys.
       * @param mnemonic - The BIP-39 mnemonic phrase.
       * @param nickname - Optional display name for the wallet.
       * @param password - Optional password to encrypt and persist the mnemonic.
       * @param options - Optional import settings.
       * @param options.skipClearTXOs - Skip clearing TXO cache (used during wallet switching).
       * @returns The imported RAILGUN wallet.
       */
      importWallet: async (
        mnemonic: string,
        nickname?: string,
        password?: string,
        options?: { skipClearTXOs?: boolean }
      ): Promise<RailgunWallet> => {
        try {
          if (!validateMnemonic(mnemonic)) {
            throw new Error('Invalid mnemonic phrase')
          }

          const derivationIndex = 0
          const keys = await deriveRailgunKeys(mnemonic, derivationIndex)

          const railgunAddress = generateRailgunAddress(keys.masterPublicKey, keys.viewingPublicKey)

          const ethereumAddress = getEthereumAddress(mnemonic, derivationIndex)

          const railgunWallet: RailgunWallet = {
            id: ethers.id(railgunAddress),
            address: railgunAddress,
            viewingKey: ByteUtils.hexlify(keys.viewingKey),
            spendingKey: ByteUtils.hexlify(keys.spendingKey),
            nullifyingKey: keys.nullifyingKey.toString(),
            masterPublicKey: keys.masterPublicKey.toString(),
            mnemonic,
            derivationIndex,
            ethereumAddress,
            createdAt: Date.now(),
            ...(nickname && { nickname }),
          }

          set({
            currentWallet: railgunWallet,
            isInitialized: true,
          })

          localStorage.setItem('railgun-last-wallet-id', railgunWallet.id)

          if (password) {
            set({ sessionPassword: password })
            await get().saveWalletMetadata(railgunWallet, password)
          } else {
            const { sessionPassword } = get()
            if (sessionPassword) {
              await get().saveWalletMetadata(railgunWallet, sessionPassword)
            }
          }

          if (!options?.skipClearTXOs) {
            try {
              BalanceScanner.getInstance().clearStoredTXOs(railgunWallet.id)
            } catch (e) {
              dwarn('Could not clear TXO cache for new wallet:', e)
            }
          }

          return railgunWallet
        } catch (error) {
          console.error('Error importing wallet:', error)
          throw error
        }
      },

      /**
       * Refresh token balances and transaction history for the current wallet and balance mode.
       */
      refreshBalances: async () => {
        let { currentWallet, currentNetwork, balanceMode } = get()
        if (!currentWallet) return

        // Normalize masterPublicKey to decimal string if needed
        try {
          const mpkStr = String(currentWallet.masterPublicKey)
          let mpkDec: string
          if (mpkStr.startsWith('0x') || mpkStr.startsWith('0X')) {
            mpkDec = BigInt(mpkStr).toString()
          } else {
            try {
              mpkDec = BigInt(mpkStr).toString()
            } catch {
              mpkDec = BigInt(`0x${mpkStr}`).toString()
            }
          }
          if (mpkDec !== mpkStr) {
            currentWallet = { ...currentWallet, masterPublicKey: mpkDec }
          }
        } catch {}

        try {
          set({ isSyncing: true })

          let balances
          let transactions: DetailedTransaction[] = []

          if (balanceMode === 'private') {
            secureLog.log('Fetching PRIVATE balances via BalanceScanner (manual)')

            const scanner = BalanceScanner.getInstance()
            // Load cached balances instantly (no network)
            try {
              const cachedBalances = await scanner.getBalancesFromStoredTXOs(
                currentWallet.id,
                currentNetwork,
                currentWallet.address
              )
              if (cachedBalances.length > 0) {
                set({ balances: cachedBalances })
              }
            } catch {}

            // Incremental scan for new commitments
            balances = await scanner.scanBalances(currentWallet, currentNetwork, () => {}, {
              incremental: true,
            })

            // Fetch transaction history using scanned TXOs
            try {
              secureLog.log('Fetching transaction history using scanned TXOs...')
              const transactionHistoryService = TransactionHistoryService.getInstance()
              const cachedNullifiers = scanner.cachedNullifiers.get(currentNetwork)
              const result = await transactionHistoryService.getTransactionHistory(
                currentWallet,
                currentNetwork,
                scanner,
                0,
                50,
                cachedNullifiers
              )
              transactions = result.transactions.sort((a, b) => b.timestamp - a.timestamp)
            } catch (txError) {
              console.error('Error fetching transactions during balance refresh:', txError)
            }
          } else {
            const publicBalanceService = PublicBalanceService.getInstance()
            const tokenService = TokenService.getInstance()
            const allTokens = [
              ...tokenService.getBuiltInTokens(currentNetwork),
              ...tokenService.getCustomTokens(currentNetwork),
            ]

            balances = await publicBalanceService.getCommonTokenBalances(
              currentWallet.ethereumAddress,
              currentNetwork,
              allTokens
            )

            balances = balances.filter(
              (b) => !tokenService.isTokenHidden(b.tokenAddress, currentWallet.id, currentNetwork)
            )

            try {
              const publicTxService = PublicTransactionService.getInstance()
              transactions = await publicTxService.getTransactionHistory(
                currentWallet.ethereumAddress,
                currentNetwork
              )
            } catch (txError) {
              console.error('Error fetching public transactions:', txError)
            }
          }

          set({
            balances,
            transactions,
            lastBalanceUpdate: Date.now(),
            isSyncing: false,
          })
          try {
            get().saveWalletScopedState()
          } catch {}
          get().loadCachedPOIStatus()
        } catch (error) {
          console.error('Error refreshing balances:', error)
          set({
            isSyncing: false,
            lastError: error instanceof Error ? error.message : 'Unknown error',
          })
        }
      },

      /**
       * Force a full rescan of balances by clearing caches before scanning.
       */
      forceRescanBalances: async () => {
        const { currentWallet, currentNetwork, balanceMode } = get()
        if (!currentWallet) return

        try {
          set({ isSyncing: true })

          if (balanceMode === 'private') {
            secureLog.log('Force rescanning PRIVATE balances - clearing caches')

            const scanner = BalanceScanner.getInstance()
            scanner.clearStoredTXOs(currentWallet.id)

            try {
              await scanner.scanBalances(currentWallet, currentNetwork, () => {}, {
                incremental: false,
              })
            } catch (balanceScannerError) {
              dwarn(
                'BalanceScanner force rescan failed, falling back to OnChainBalanceScanner:',
                balanceScannerError
              )

              const onChainScanner = OnChainBalanceScanner.getInstance()
              const provider = new ethers.JsonRpcProvider(getEffectiveRpcUrl(currentNetwork))

              await onChainScanner.scanBalances(currentWallet, currentNetwork, () => {}, {
                provider,
              })
            }

            await get().refreshBalances()
          } else {
            await get().refreshBalances()
          }
        } catch (error) {
          console.error('Error in force rescan:', error)
          set({ lastError: error instanceof Error ? error.message : 'Force rescan failed' })
        } finally {
          set({ isSyncing: false })
        }
      },

      /**
       * Reset the wallet state to defaults and remove persisted data from localStorage.
       */
      resetWallet: () => {
        set((state) => {
          const { currentWallet: _, lastError: __, ...rest } = state
          return {
            ...rest,
            isInitialized: false,
            currentNetwork: NetworkName.EthereumSepolia,
            balances: [],
            transactions: [],
            ...DEFAULT_POI_STATE,
            isSyncing: false,
          }
        })

        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem('minimal-railgun-wallet')
        }
      },

      // Commitment-level PPOI actions

      /**
       * Load previously cached POI status for wallet commitments without making network calls.
       */
      loadCachedPOIStatus: () => {
        const { currentWallet, currentNetwork } = get()
        if (!currentWallet) return

        try {
          const scanner = BalanceScanner.getInstance()
          const poiService = POIService.getInstance()

          const commitments = scanner.getDecryptedCommitmentsForWallet(currentWallet.id)
          const unspent = commitments.filter((c) => !c.isSpent && !c.isSentToOther)

          const commitmentData = unspent.map((c) => ({
            blindedCommitment: scanner.blindedCommitmentOf(c),
            type: (c.commitmentType === 'ShieldCommitment' ? 'Shield' : 'Transact') as
              | 'Shield'
              | 'Transact'
              | 'Unshield',
          }))

          const txCommitments = get().transactions.flatMap((tx: any) =>
            (tx.blindedCommitments || []).map((bc: any) => ({
              blindedCommitment: bc.commitment,
              type: (bc.type || 'Transact') as 'Shield' | 'Transact' | 'Unshield',
            }))
          )

          // Deduplicate
          const allMap = new Map<
            string,
            { blindedCommitment: string; type: 'Shield' | 'Transact' | 'Unshield' }
          >()
          for (const cd of [...commitmentData, ...txCommitments]) {
            allMap.set(cd.blindedCommitment, cd)
          }
          const allCommitments = Array.from(allMap.values())
          if (allCommitments.length === 0) return

          const cached = poiService.getPOIStatusForCommitmentsFromCacheOnly(
            currentNetwork,
            allCommitments
          )

          if (Object.keys(cached).length > 0) {
            const nextChecked = new Set(get().checkedCommitments)
            for (const commitment of Object.keys(cached)) {
              nextChecked.add(commitment)
            }
            set({
              commitmentPOIStatus: { ...get().commitmentPOIStatus, ...cached },
              checkedCommitments: nextChecked,
            })
          }
        } catch (e) {
          console.error('Error loading cached PPOI status:', e)
        }
      },

      /**
       * Count the number of commitments that have not yet been validated as POI-valid.
       * @returns The number of unvalidated or non-valid commitments.
       */
      getUncheckedPOICount: () => {
        const { currentWallet, commitmentPOIStatus, transactions } = get()
        if (!currentWallet) return 0

        const unchecked = new Set<string>()

        try {
          const scanner = BalanceScanner.getInstance()
          const commitments = scanner.getDecryptedCommitmentsForWallet(currentWallet.id)
          for (const c of commitments) {
            if (c.isSpent || c.isSentToOther) continue
            const bc = scanner.blindedCommitmentOf(c)
            const status = commitmentPOIStatus[bc]
            if (!status || status.status !== 'valid') {
              unchecked.add(bc)
            }
          }
        } catch {}

        for (const tx of transactions as any[]) {
          for (const bc of tx.blindedCommitments || []) {
            const status = commitmentPOIStatus[bc.commitment]
            if (!status || status.status !== 'valid') {
              unchecked.add(bc.commitment)
            }
          }
        }

        return unchecked.size
      },

      /**
       * Check the POI status for all unvalidated commitments across balance and transaction data, in batches.
       */
      checkAllCommitmentPOI: async () => {
        const { currentWallet, currentNetwork } = get()
        if (!currentWallet) return

        set({ isCheckingPOI: true, poiCheckProgress: { checked: 0, total: 0 } })

        try {
          const scanner = BalanceScanner.getInstance()
          const poiService = POIService.getInstance()

          const commitments = scanner.getDecryptedCommitmentsForWallet(currentWallet.id)
          const unspent = commitments.filter((c) => !c.isSpent && !c.isSentToOther)

          const currentStatus = get().commitmentPOIStatus
          const toCheck: Array<{
            blindedCommitment: string
            type: 'Shield' | 'Transact' | 'Unshield'
          }> = []

          for (const c of unspent) {
            const bc = scanner.blindedCommitmentOf(c)
            const existing = currentStatus[bc]
            if (!existing || existing.status !== 'valid') {
              poiService.clearCommitmentCache(currentNetwork, bc)
              toCheck.push({
                blindedCommitment: bc,
                type: (c.commitmentType === 'ShieldCommitment' ? 'Shield' : 'Transact') as
                  | 'Shield'
                  | 'Transact'
                  | 'Unshield',
              })
            }
          }

          const txCommitments = get().transactions.flatMap((tx: any) =>
            (tx.blindedCommitments || [])
              .filter((bc: any) => {
                const existing = currentStatus[bc.commitment]
                return !existing || existing.status !== 'valid'
              })
              .map((bc: any) => {
                poiService.clearCommitmentCache(currentNetwork, bc.commitment)
                return {
                  blindedCommitment: bc.commitment,
                  type: (bc.type || 'Transact') as 'Shield' | 'Transact' | 'Unshield',
                }
              })
          )

          // Deduplicate
          const allMap = new Map<
            string,
            { blindedCommitment: string; type: 'Shield' | 'Transact' | 'Unshield' }
          >()
          for (const cd of [...toCheck, ...txCommitments]) {
            allMap.set(cd.blindedCommitment, cd)
          }
          const allToCheck = Array.from(allMap.values())

          if (allToCheck.length === 0) {
            set({ isCheckingPOI: false })
            return
          }

          set({ poiCheckProgress: { checked: 0, total: allToCheck.length } })

          const batchSize = 500
          const mergedResults: Record<string, POIStatus> = {}
          let checkedCount = 0

          for (let i = 0; i < allToCheck.length; i += batchSize) {
            const batch = allToCheck.slice(i, i + batchSize)
            try {
              const results = await poiService.getPOIStatusForCommitments(currentNetwork, batch)
              Object.assign(mergedResults, results)
            } catch (e) {
              console.error('Error checking PPOI batch:', e)
            }
            checkedCount += batch.length
            set({ poiCheckProgress: { checked: checkedCount, total: allToCheck.length } })

            if (i + batchSize < allToCheck.length) {
              await new Promise((resolve) => setTimeout(resolve, 200))
            }
          }

          const nextChecked = new Set(get().checkedCommitments)
          for (const commitment of Object.keys(mergedResults)) {
            nextChecked.add(commitment)
          }

          set({
            commitmentPOIStatus: { ...get().commitmentPOIStatus, ...mergedResults },
            checkedCommitments: nextChecked,
            isCheckingPOI: false,
            poiCheckProgress: { checked: 0, total: 0 },
          })
        } catch (e) {
          console.error('Error checking all commitment PPOI:', e)
          set({ isCheckingPOI: false, poiCheckProgress: { checked: 0, total: 0 } })
        }
      },

      /**
       * Check the POI status for a single blinded commitment via a network call.
       * @param blindedCommitment - The blinded commitment hash to check.
       * @param type - The commitment type (Shield, Transact, or Unshield).
       */
      checkSingleCommitmentPOI: async (
        blindedCommitment: string,
        type: 'Shield' | 'Transact' | 'Unshield'
      ) => {
        const { currentNetwork } = get()

        const poiService = POIService.getInstance()
        poiService.clearCommitmentCache(currentNetwork, blindedCommitment)

        const results = await poiService.getPOIStatusForCommitments(currentNetwork, [
          { blindedCommitment, type },
        ])

        const nextChecked = new Set(get().checkedCommitments)
        nextChecked.add(blindedCommitment)

        if (results[blindedCommitment]) {
          set({
            commitmentPOIStatus: {
              ...get().commitmentPOIStatus,
              [blindedCommitment]: results[blindedCommitment],
            },
            checkedCommitments: nextChecked,
          })
        } else {
          set({ checkedCommitments: nextChecked })
        }
      },

      /**
       * Clear the cached POI status for a single commitment from both the service cache and state.
       * @param blindedCommitment - The blinded commitment hash to clear.
       */
      clearCommitmentPOIStatus: (blindedCommitment: string) => {
        const { currentNetwork } = get()
        POIService.getInstance().clearCommitmentCache(currentNetwork, blindedCommitment)
        const { [blindedCommitment]: _, ...rest } = get().commitmentPOIStatus
        set({ commitmentPOIStatus: rest })
      },

      // Shield Transaction Actions
      /**
       * Execute a shield transaction to move tokens from public to private balance.
       * @param params - The shield transaction parameters including token, amount, and signer.
       * @returns An object containing the on-chain transaction hash.
       */
      executeShieldTransaction: async (params: ShieldTransactionParams) => {
        const { currentWallet, currentNetwork } = get()

        if (!currentWallet) {
          throw new Error('No wallet connected')
        }

        try {
          set({ isSyncing: true })

          if (!NETWORK_CONFIG[currentNetwork]) {
            throw new Error(`Unsupported network: ${currentNetwork}`)
          }

          const provider = new ethers.JsonRpcProvider(getEffectiveRpcUrl(currentNetwork))
          const shieldService = ShieldTransactionService.getInstance()

          const result = await shieldService.executeShieldTransaction(
            params,
            currentWallet,
            currentNetwork,
            provider,
            (status) => {
              dlog('Shield progress:', status)
            }
          )

          set({ isSyncing: false })
          return result
        } catch (error) {
          console.error('Error executing shield transaction:', error)
          set({
            isSyncing: false,
            lastError: error instanceof Error ? error.message : 'Shield transaction failed',
          })
          throw error
        }
      },

      /**
       * Estimate gas cost for a shield transaction without executing it.
       * @param params - The shield transaction parameters to estimate gas for.
       * @returns An object with the gas estimate and total cost in wei.
       */
      estimateShieldGas: async (params: ShieldTransactionParams) => {
        const { currentWallet, currentNetwork } = get()

        if (!currentWallet) {
          throw new Error('No wallet connected')
        }

        if (!NETWORK_CONFIG[currentNetwork]) {
          throw new Error(`Unsupported network: ${currentNetwork}`)
        }

        const provider = new ethers.JsonRpcProvider(getEffectiveRpcUrl(currentNetwork))
        const shieldService = ShieldTransactionService.getInstance()

        const gasEstimate = await shieldService.estimateShieldGas(
          params,
          currentWallet,
          currentNetwork,
          provider
        )

        return {
          gasEstimate: gasEstimate.gasLimit,
          totalCost: gasEstimate.totalCost,
        }
      },

      /**
       * Check whether a token can be shielded on the current network.
       * @param tokenAddress - The ERC-20 token contract address to check.
       * @returns Whether the token is supported for shielding.
       */
      canShieldToken: async (tokenAddress: string) => {
        const { currentNetwork } = get()

        try {
          if (!NETWORK_CONFIG[currentNetwork]) {
            return false
          }

          const provider = new ethers.JsonRpcProvider(getEffectiveRpcUrl(currentNetwork))
          const shieldService = ShieldTransactionService.getInstance()
          return await shieldService.canShieldToken(tokenAddress, currentNetwork, provider)
        } catch (error) {
          console.error('Error checking if token can be shielded:', error)
          return false
        }
      },

      /**
       * Check whether a token has sufficient ERC-20 approval for the shield contract.
       * @param tokenAddress - The token contract address to check approval for.
       * @param amount - Optional specific amount to check approval against.
       * @returns Whether the token is approved for the required amount.
       */
      isTokenApprovedForShield: async (tokenAddress: string, amount?: string) => {
        const { currentWallet, currentNetwork } = get()
        if (!currentWallet) {
          throw new Error('No wallet available')
        }

        try {
          const provider = new ethers.JsonRpcProvider(getEffectiveRpcUrl(currentNetwork))
          const shieldService = ShieldTransactionService.getInstance()
          const amountBigInt = amount ? BigInt(amount) : undefined

          return await shieldService.isTokenApprovedForShield(
            tokenAddress,
            currentWallet.address,
            currentNetwork,
            provider,
            amountBigInt
          )
        } catch (error) {
          console.error('Error checking token approval for shield:', error)
          return false
        }
      },

      /**
       * Send an ERC-20 approval transaction so the shield contract can spend the token.
       * @param tokenAddress - The token contract address to approve.
       * @param amount - Optional specific approval amount; defaults to max uint256.
       * @returns An object containing the approval transaction hash.
       */
      approveTokenForShield: async (tokenAddress: string, amount?: string) => {
        const { currentWallet, currentNetwork } = get()
        if (!currentWallet) {
          throw new Error('No wallet available')
        }

        try {
          set({ isSyncing: true })

          const provider = new ethers.JsonRpcProvider(getEffectiveRpcUrl(currentNetwork))
          const shieldService = ShieldTransactionService.getInstance()

          secureLog.log('Creating and simulating approval transaction...')
          const signer = ethers.Wallet.fromPhrase(currentWallet.mnemonic!).connect(provider)
          const approvalTx = await shieldService.createTokenApprovalTransaction(
            tokenAddress,
            amount || ethers.MaxUint256.toString(),
            signer.address,
            currentNetwork,
            provider
          )

          secureLog.log('Approval transaction simulation passed, sending...')
          const txResponse = await signer.sendTransaction(approvalTx)
          await txResponse.wait()

          return { txHash: txResponse.hash }
        } catch (error) {
          console.error('Error approving token for shield:', error)
          throw error
        } finally {
          set({ isSyncing: false })
        }
      },

      /**
       * Query the current ERC-20 allowance and determine if the token is approved for the given amount.
       * @param tokenAddress - The token contract address to check.
       * @param amount - Optional amount to compare against the current allowance.
       * @returns An object with the approval status and the raw allowance string.
       */
      checkTokenApprovalStatus: async (tokenAddress: string, amount?: string) => {
        const { currentWallet, currentNetwork } = get()
        if (!currentWallet) {
          throw new Error('No wallet available')
        }

        if (!tokenAddress || tokenAddress === '0x0000000000000000000000000000000000000000') {
          return { isApproved: true, allowance: 'unlimited' }
        }

        try {
          const provider = new ethers.JsonRpcProvider(getEffectiveRpcUrl(currentNetwork))
          const shieldService = ShieldTransactionService.getInstance()
          const spenderAddress = shieldService.getShieldApprovalContractAddress(currentNetwork)

          const tokenContract = new ethers.Contract(
            tokenAddress,
            ['function allowance(address owner, address spender) view returns (uint256)'],
            provider
          )

          const ownerAddress = currentWallet.ethereumAddress
          if (!ownerAddress) {
            throw new Error('No Ethereum address available for approval check')
          }

          const allowanceFn = tokenContract['allowance'] as (
            owner: string,
            spender: string,
          ) => Promise<bigint>
          const allowance = await allowanceFn(ownerAddress, spenderAddress)
          const amountBigInt = amount ? BigInt(amount) : 0n

          return {
            isApproved: amountBigInt > 0n ? allowance >= amountBigInt : allowance > 0n,
            allowance: allowance.toString(),
          }
        } catch (error) {
          console.error('Error checking token approval status:', error)
          return { isApproved: false, allowance: '0' }
        }
      },
    }),
    {
      name: 'minimal-railgun-wallet',
      /**
       * Select only the fields that should be persisted to localStorage.
       * @param state - The full wallet store state.
       * @returns A partial state object containing only persistable fields.
       */
      partialize: (state) => ({
        currentNetwork: state.currentNetwork,
        savedWallets: state.savedWallets,
        isPasswordSet: state.isPasswordSet,
      }),
    }
  )
)
