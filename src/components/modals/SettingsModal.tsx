import React, { useCallback, useEffect, useState } from 'react'

import { OnChainBalanceScanner } from '@/services/OnChainBalanceScanner'
import { POIService } from '@/services/POIService'
import { RailgunTxidScanner } from '@/services/RailgunTxidScanner'
import { SentTransactionStorage } from '@/services/SentTransactionStorage'
import { SubsquidBalanceScanner } from '@/services/SubsquidBalanceScanner'
import { TokenService } from '@/services/TokenService'
import { TransactionMetadataService } from '@/services/TransactionMetadataService'
import { ALL_VARIANTS, COMMON_VARIANTS_WITH_POI, useArtifactStore } from '@/stores/artifactStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useWalletStore } from '@/stores/walletStore'
import { NETWORK_CONFIG, NetworkName } from '@/types/network'
import { dlog } from '@/utils/debug'
import './shared-modal.css'
import './SettingsModal.css'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
}

/**
 * Modal component for application settings including RPC URLs, password, and cache management.
 * @param root0 - The component props
 * @param root0.isOpen - Whether the modal is currently visible
 * @param root0.onClose - Callback to close the modal
 * @returns The rendered settings modal component, or null when closed
 */
export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
  const { debugEnabled, customRpcUrls, setDebugEnabled, setCustomRpcUrl, clearCustomRpcUrl } =
    useSettingsStore()

  const { resetWallet, changePassword, currentWallet, currentNetwork } = useWalletStore()

  const {
    downloadedVariants,
    downloading,
    downloadProgress,
    downloadError,
    refreshDownloadedVariants,
    downloadCommonCircuits,
    downloadAllCircuits,
    clearArtifacts,
  } = useArtifactStore()

  // Load downloaded variants list when modal opens
  useEffect(() => {
    if (isOpen) {
      refreshDownloadedVariants()
    }
  }, [isOpen, refreshDownloadedVariants])

  const [rpcInputs, setRpcInputs] = useState<Partial<Record<NetworkName, string>>>(() => ({
    ...customRpcUrls,
  }))
  const [rpcErrors, setRpcErrors] = useState<Partial<Record<NetworkName, string>>>({})
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)

  // Change password state
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwFeedback, setPwFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const canSubmitPw = currentPw.length > 0 && newPw.length >= 4 && newPw === confirmPw && !pwBusy

  // Cache management state
  const [clearingCache, setClearingCache] = useState(false)
  const [cacheFeedback, setCacheFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  // TXID tree resync state
  const [resyncingTxidTree, setResyncingTxidTree] = useState(false)

  // Core clearing operations (no UI state management)
  /**
   * Clear all cached transaction data for a wallet including TXOs, metadata, and balances.
   * @param walletId - The ID of the wallet whose transaction data to clear
   */
  const clearTransactionDataCore = (walletId: string) => {
    // Full cache clear: TXOs, nullifier cache, token hash maps, all in-memory state
    SubsquidBalanceScanner.getInstance().clearCache()
    dlog('Cleared all SubsquidBalanceScanner caches')

    // Clear OnChainBalanceScanner in-memory commitments
    OnChainBalanceScanner.getInstance().clearStoredTXOs(walletId)
    dlog('Cleared OnChainBalanceScanner in-memory commitments')

    TransactionMetadataService.getInstance().clearWalletMetadata(walletId)
    dlog('Cleared transaction metadata')

    // Clear TokenService in-memory caches (token lookups + hidden tokens)
    TokenService.getInstance().clearHiddenTokensCache()
    dlog('Cleared TokenService in-memory caches')

    // Clear wallet-scoped localStorage entries
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && key.startsWith(`wallet:${walletId}:`)) {
        keysToRemove.push(key)
      }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key))
    dlog(`Cleared ${keysToRemove.length} wallet state entries from localStorage`)

    useWalletStore.setState({
      balances: [],
      transactions: [],
      lastBalanceUpdate: 0,
      commitmentPOIStatus: {},
      checkedCommitments: new Set<string>(),
    })
    dlog('Reset store balances, transactions, and POI status')
  }

  /**
   * Clear all cached PPOI data for a wallet including status cache and sent outputs.
   * @param walletAddress - The address of the wallet whose PPOI data to clear
   */
  const clearPPOIDataCore = (walletAddress: string) => {
    POIService.getInstance().clearPOICache()
    dlog('Cleared PPOI status cache')

    SentTransactionStorage.getInstance().clearWalletOutputs(walletAddress)
    dlog('Cleared sent transaction outputs')
  }

  /**
   * Execute a cache clearing operation with shared loading and feedback state management.
   * @param op - The cache clearing function to execute
   * @param successMsg - The message to display on successful completion
   * @param errorLabel - A label describing the operation for error messages
   * @returns Whether the operation succeeded
   */
  const runCacheOp = async (op: () => void, successMsg: string, errorLabel: string): Promise<boolean> => {
    if (!currentWallet) {
      setCacheFeedback({ ok: false, msg: 'No wallet selected.' })
      return false
    }
    setClearingCache(true)
    setCacheFeedback(null)
    try {
      op()
      setCacheFeedback({ ok: true, msg: successMsg })
      return true
    } catch (err: unknown) {
      console.error(`Error ${errorLabel}:`, err)
      setCacheFeedback({ ok: false, msg: err instanceof Error ? err.message : `Failed to ${errorLabel}.` })
      return false
    } finally {
      setClearingCache(false)
    }
  }

  /**
   * Clear cached transaction data (TXOs, balances, metadata) for the current wallet.
   * @returns A promise that resolves when the operation completes
   */
  const handleClearTransactionData = () =>
    runCacheOp(
      () => clearTransactionDataCore(currentWallet!.id),
      'Transaction data cleared. Click Refresh on Balances page to rescan.',
      'clearing transaction data'
    )

  /**
   * Clear cached PPOI status and sent outputs for the current wallet.
   * @returns A promise that resolves when the operation completes
   */
  const handleClearPPOIData = () =>
    runCacheOp(
      () => clearPPOIDataCore(currentWallet!.address),
      'PPOI data cleared. PPOI status will be re-checked on next refresh.',
      'clearing PPOI data'
    )

  /**
   * Clear all cached data including transaction data and PPOI data for the current wallet.
   * @returns A promise that resolves when the operation completes
   */
  const handleClearAllCache = async () => {
    if (!currentWallet) {
      setCacheFeedback({ ok: false, msg: 'No wallet selected.' })
      return
    }
    setClearingCache(true)
    setCacheFeedback(null)
    try {
      clearTransactionDataCore(currentWallet.id)
      clearPPOIDataCore(currentWallet.address)

      // Also clear TXID merkletree for all networks
      const allNetworks = Object.values(NetworkName).filter((n) => n !== NetworkName.Hardhat)
      for (const network of allNetworks) {
        try {
          const merkletree = RailgunTxidScanner.getTxidMerkletree(network)
          await merkletree.clear()
        } catch {
          // Non-fatal: tree may not have been initialized for this network
        }
      }
      dlog('Cleared TXID merkletrees for all networks')

      setCacheFeedback({ ok: true, msg: 'All caches cleared. Reloading...' })
      window.location.reload()
    } catch (err: unknown) {
      console.error('Error clearing all caches:', err)
      setCacheFeedback({ ok: false, msg: err instanceof Error ? err.message : 'Failed to clear all caches.' })
    } finally {
      setClearingCache(false)
    }
  }

  /**
   * Clear and rebuild the TXID merkletree from Subsquid for the current network.
   */
  const handleResyncTxidTree = async () => {
    if (!currentNetwork) {
      setCacheFeedback({ ok: false, msg: 'No network selected.' })
      return
    }

    setResyncingTxidTree(true)
    setCacheFeedback(null)
    try {
      setCacheFeedback({ ok: true, msg: 'Clearing TXID merkletree and resyncing from Subsquid...' })
      await RailgunTxidScanner.syncFullTree(currentNetwork as NetworkName)
      const stats = await RailgunTxidScanner.getStats(currentNetwork as NetworkName)
      setCacheFeedback({
        ok: true,
        msg: `TXID merkletree resynced. ${stats.currentIndex + 1} transactions indexed.`,
      })
    } catch (err: unknown) {
      console.error('Error resyncing TXID tree:', err)
      setCacheFeedback({ ok: false, msg: err instanceof Error ? err.message : 'Failed to resync TXID merkletree.' })
    } finally {
      setResyncingTxidTree(false)
    }
  }

  /**
   * Change the wallet encryption password using the current and new password inputs.
   */
  const handleChangePassword = async () => {
    setPwFeedback(null)
    setPwBusy(true)
    try {
      await changePassword(currentPw, newPw)
      setPwFeedback({ ok: true, msg: 'Password changed successfully.' })
      setCurrentPw('')
      setNewPw('')
      setConfirmPw('')
    } catch (err: unknown) {
      setPwFeedback({ ok: false, msg: err instanceof Error ? err.message : 'Failed to change password.' })
    } finally {
      setPwBusy(false)
    }
  }

  // Close on Escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    if (!isOpen) return
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, handleKeyDown])

  if (!isOpen) return null

  const networks = Object.values(NetworkName).filter((n) => n !== NetworkName.Hardhat)

  /**
   * Validate that a URL string is a valid HTTP or HTTPS URL.
   * @param url - The URL string to validate
   * @returns True if the URL is empty or a valid http/https URL
   */
  const validateUrl = (url: string): boolean => {
    if (!url) return true
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
      return false
    }
  }

  /**
   * Handle changes to a custom RPC URL input field with inline validation.
   * @param network - The network whose RPC URL is being changed
   * @param value - The new RPC URL value entered by the user
   */
  const handleRpcChange = (network: NetworkName, value: string) => {
    setRpcInputs((prev) => ({ ...prev, [network]: value }))

    if (value && !validateUrl(value)) {
      setRpcErrors((prev) => ({ ...prev, [network]: 'Must be a valid http:// or https:// URL' }))
    } else {
      setRpcErrors((prev) => {
        const updated = { ...prev }
        delete updated[network]
        return updated
      })
    }
  }

  /**
   * Save or clear the custom RPC URL for a network on input blur.
   * @param network - The network whose custom RPC URL to save
   */
  const handleRpcSave = (network: NetworkName) => {
    const value = rpcInputs[network]?.trim() || ''
    if (!value) {
      clearCustomRpcUrl(network)
      setRpcInputs((prev) => {
        const updated = { ...prev }
        delete updated[network]
        return updated
      })
      return
    }
    if (!validateUrl(value)) return
    setCustomRpcUrl(network, value)
  }

  /**
   * Reset a custom RPC URL back to the default for a network.
   * @param network - The network whose custom RPC URL to reset
   */
  const handleRpcReset = (network: NetworkName) => {
    clearCustomRpcUrl(network)
    setRpcInputs((prev) => {
      const updated = { ...prev }
      delete updated[network]
      return updated
    })
    setRpcErrors((prev) => {
      const updated = { ...prev }
      delete updated[network]
      return updated
    })
  }

  return (
    <div className='modal-overlay' onClick={onClose}>
      <div className='modal-content settings-modal' onClick={(e) => e.stopPropagation()}>
        <div className='modal-header'>
          <h2>Settings</h2>
          <button className='modal-close' onClick={onClose}>
            &times;
          </button>
        </div>

        <div className='modal-body'>
          {/* Debug Logging Toggle */}
          <div className='settings-section'>
            <h3>Debug Logging</h3>
            <p className='settings-description'>
              Enable verbose console logging for debugging. Logs will appear in the browser
              developer console.
            </p>
            <label className='settings-toggle'>
              <input
                type='checkbox'
                checked={debugEnabled}
                onChange={(e) => setDebugEnabled(e.target.checked)}
              />
              <span className='toggle-slider' />
              <span className='toggle-label'>{debugEnabled ? 'Enabled' : 'Disabled'}</span>
            </label>
          </div>

          {/* Custom RPC URLs */}
          <div className='settings-section'>
            <h3>Custom RPC URLs</h3>
            <p className='settings-description'>
              Override the default RPC endpoint for each network. Leave blank to use the default.
            </p>

            <div className='rpc-list'>
              {networks.map((network) => {
                const defaultUrl = NETWORK_CONFIG[network].rpcUrl
                const customUrl = customRpcUrls[network]
                const inputValue = rpcInputs[network] ?? ''
                const error = rpcErrors[network]
                const isCustom = !!customUrl

                return (
                  <div key={network} className='rpc-item'>
                    <div className='rpc-item-header'>
                      <span className='rpc-network-name'>{NETWORK_CONFIG[network].publicName}</span>
                      {isCustom && <span className='rpc-custom-badge'>Custom</span>}
                    </div>
                    <div className='rpc-item-body'>
                      <input
                        type='text'
                        className={`form-input rpc-url-input ${error ? 'input-error' : ''}`}
                        value={inputValue}
                        onChange={(e) => handleRpcChange(network, e.target.value)}
                        onBlur={() => handleRpcSave(network)}
                        placeholder={defaultUrl}
                      />
                      {isCustom && (
                        <button
                          className='rpc-reset-btn'
                          onClick={() => handleRpcReset(network)}
                          title='Reset to default'
                        >
                          Reset
                        </button>
                      )}
                    </div>
                    {error && <div className='rpc-error'>{error}</div>}
                  </div>
                )
              })}
            </div>
          </div>

          {/* Change Password */}
          <div className='settings-section'>
            <button className='pw-toggle-header' onClick={() => setShowChangePw((v) => !v)}>
              <h3>Change Password</h3>
              <span className={`pw-toggle-arrow ${showChangePw ? 'open' : ''}`}>&#9662;</span>
            </button>
            <p className='settings-description'>
              Update the password used to encrypt your wallets.
            </p>
            {showChangePw && (
              <div className='pw-form'>
                <input
                  type='password'
                  className='form-input pw-input'
                  placeholder='Current password'
                  value={currentPw}
                  onChange={(e) => {
                    setCurrentPw(e.target.value)
                    setPwFeedback(null)
                  }}
                />
                <input
                  type='password'
                  className='form-input pw-input'
                  placeholder='New password (min 4 characters)'
                  value={newPw}
                  onChange={(e) => {
                    setNewPw(e.target.value)
                    setPwFeedback(null)
                  }}
                />
                <input
                  type='password'
                  className={`form-input pw-input ${newPw && confirmPw && newPw !== confirmPw ? 'input-error' : ''}`}
                  placeholder='Confirm new password'
                  value={confirmPw}
                  onChange={(e) => {
                    setConfirmPw(e.target.value)
                    setPwFeedback(null)
                  }}
                />
                {newPw && confirmPw && newPw !== confirmPw && (
                  <div className='pw-feedback pw-error'>Passwords do not match.</div>
                )}
                {pwFeedback && (
                  <div className={`pw-feedback ${pwFeedback.ok ? 'pw-success' : 'pw-error'}`}>
                    {pwFeedback.msg}
                  </div>
                )}
                <button
                  className='pw-submit-btn'
                  disabled={!canSubmitPw}
                  onClick={handleChangePassword}
                >
                  {pwBusy ? 'Changing...' : 'Change Password'}
                </button>
              </div>
            )}
          </div>

          {/* Cache Management */}
          <div className='settings-section'>
            <h3>Cache Management</h3>
            <p className='settings-description'>
              Clear cached data to force fresh scans. Use this if transactions are missing or PPOI
              status is stale.
            </p>
            <div className='cache-actions'>
              <button
                className='cache-btn cache-btn-primary'
                onClick={handleClearAllCache}
                disabled={clearingCache || !currentWallet}
                title='Clear all cached data (TXOs, balances, transactions, PPOI) - fresh start'
              >
                {clearingCache ? '⏳ Clearing...' : '🔄 Clear All & Reset'}
              </button>
              <button
                className='cache-btn'
                onClick={handleClearTransactionData}
                disabled={clearingCache || !currentWallet}
                title='Clear all balance and history data (TXOs, balances, transactions, metadata)'
              >
                🧹 Clear Transaction Data
              </button>
              <button
                className='cache-btn'
                onClick={handleClearPPOIData}
                disabled={clearingCache || !currentWallet}
                title='Clear all PPOI data (PPOI status cache, sent outputs for proof generation)'
              >
                🗑️ Clear PPOI Data
              </button>
              <button
                className='cache-btn'
                onClick={handleResyncTxidTree}
                disabled={resyncingTxidTree || clearingCache}
                title='Clear and rebuild the TXID merkletree from Subsquid. Use this if PPOI merkleroot validation fails.'
              >
                {resyncingTxidTree ? '⏳ Resyncing...' : '🌲 Resync TXID Tree'}
              </button>
            </div>
            {cacheFeedback && (
              <div
                className={`cache-feedback ${cacheFeedback.ok ? 'cache-success' : 'cache-error'}`}
              >
                {cacheFeedback.msg}
              </div>
            )}
          </div>

          {/* Circuit Management */}
          <div className='settings-section'>
            <h3>Circuit Management</h3>
            <p className='settings-description'>
              Circuit files are required for generating zk-SNARK proofs. Download them from IPFS
              before making transactions. Common circuits cover most transaction types.
            </p>
            <div className='circuit-status'>
              {downloadedVariants.length} of {ALL_VARIANTS.length} circuits downloaded
              {downloadedVariants.length > 0 && (
                <span className='circuit-status-detail'>
                  {' '}({COMMON_VARIANTS_WITH_POI.filter((v) => downloadedVariants.includes(v)).length}/{COMMON_VARIANTS_WITH_POI.length} common)
                </span>
              )}
            </div>
            <div className='cache-actions'>
              <button
                className='cache-btn cache-btn-primary'
                onClick={downloadCommonCircuits}
                disabled={downloading}
                title='Download the 10 most commonly used circuit variants from IPFS'
              >
                {downloading && downloadProgress && downloadProgress.total === COMMON_VARIANTS_WITH_POI.length
                  ? `Downloading ${downloadProgress.current}/${downloadProgress.total}: ${downloadProgress.currentVariant}...`
                  : 'Download Common Circuits'}
              </button>
              <button
                className='cache-btn'
                onClick={downloadAllCircuits}
                disabled={downloading}
                title='Download all 171 circuit variants from IPFS (~2.9GB decompressed)'
              >
                {downloading && downloadProgress && downloadProgress.total === ALL_VARIANTS.length
                  ? `Downloading ${downloadProgress.current}/${downloadProgress.total}: ${downloadProgress.currentVariant}...`
                  : 'Download All Circuits'}
              </button>
              <button
                className='cache-btn'
                onClick={clearArtifacts}
                disabled={downloading || downloadedVariants.length === 0}
                title='Remove all downloaded circuit files from browser storage'
              >
                Clear Downloaded Circuits
              </button>
            </div>
            {downloading && downloadProgress && (
              <div className='circuit-progress'>
                Downloading {downloadProgress.currentVariant} ({downloadProgress.current}/{downloadProgress.total})...
              </div>
            )}
            {downloadError && (
              <div className='cache-feedback cache-error'>
                {downloadError}
              </div>
            )}
            {!downloading && !downloadError && downloadedVariants.length > 0 && (
              <div className='cache-feedback cache-success'>
                {downloadedVariants.length} circuit{downloadedVariants.length !== 1 ? 's' : ''} ready for proof generation.
              </div>
            )}
          </div>

          {/* Danger Zone */}
          <div className='settings-section settings-danger-zone'>
            <h3>Danger Zone</h3>
            <p className='settings-description'>
              This will permanently delete your wallet and all its data. This action cannot be
              undone.
            </p>
            <div className='danger-actions'>
              <button
                className={`delete-wallet-btn ${showDeleteConfirm ? 'confirm' : ''}`}
                onClick={() => {
                  if (showDeleteConfirm) {
                    resetWallet()
                    onClose()
                  } else {
                    setShowDeleteConfirm(true)
                    setTimeout(() => setShowDeleteConfirm(false), 5000)
                  }
                }}
              >
                {showDeleteConfirm ? 'Click again to confirm deletion' : 'Delete Wallet'}
              </button>
              {showDeleteConfirm && (
                <button className='cancel-btn' onClick={() => setShowDeleteConfirm(false)}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
