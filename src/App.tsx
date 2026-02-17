import { useCallback, useEffect, useState } from 'react'

import './App.css'
import type { TabType } from '@/components/layout/Navigation'
import { Navigation } from '@/components/layout/Navigation'
import { NetworkSelector } from '@/components/layout/NetworkSelector'
import { WalletSelector } from '@/components/layout/WalletSelector'
import { LegalAgreementModal } from '@/components/modals/LegalAgreementModal'
import { NetworkRequestModal } from '@/components/modals/NetworkRequestModal'
import { SettingsModal } from '@/components/modals/SettingsModal'
import { WalletCreatedModal } from '@/components/modals/WalletCreatedModal'
import { WalletListModal } from '@/components/modals/WalletListModal'
import { WalletManagementModal } from '@/components/modals/WalletManagementModal'
import { BalancesPage } from '@/components/pages/BalancesPage'
import { HistoryPage } from '@/components/pages/HistoryPage'
import { TransactPage } from '@/components/pages/TransactPage'
import { installNetworkInterceptor } from '@/services/NetworkRequestInterceptor'
import { useLegalStore } from '@/stores/legalStore'
import { useWalletStore } from '@/stores/walletStore'
import type { RailgunWallet, SavedWalletMetadata } from '@/types/wallet'
import { SESSION_TIMEOUT_MS, SessionTimeoutManager } from '@/utils/security'

// Install network request interceptor globally on app load
installNetworkInterceptor()

/**
 * Renders the unlock screen for returning users with saved wallets.
 * @param root0 - Component props object.
 * @param root0.savedWallets - Array of previously saved wallet metadata entries.
 * @param root0.onCreateNew - Callback invoked when the user clicks "Create New Wallet".
 * @param root0.onImportNew - Callback invoked when the user clicks "Import Seed Phrase".
 * @returns The unlock screen UI with password input and wallet action buttons.
 */
function UnlockScreen ({
  savedWallets,
  onCreateNew,
  onImportNew,
}: {
  savedWallets: SavedWalletMetadata[]
  onCreateNew: () => void
  onImportNew: () => void
}) {
  const { switchWallet } = useWalletStore()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isUnlocking, setIsUnlocking] = useState(false)

  /**
   * Attempts to unlock the wallet with the entered password.
   * @param e - The form submission event.
   */
  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password) return

    setIsUnlocking(true)
    setError('')

    // Unlock the last active wallet, or fall back to the first saved wallet.
    // All wallets share the same application password, so if this succeeds
    // the user is authenticated and can switch wallets freely afterward.
    const lastWalletId = localStorage.getItem('railgun-last-wallet-id')
    const targetWalletId =
      lastWalletId && savedWallets.some((w) => w.id === lastWalletId)
        ? lastWalletId
        : savedWallets[0]?.id
    if (!targetWalletId) return

    try {
      await switchWallet(targetWalletId, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Incorrect password')
    } finally {
      setIsUnlocking(false)
    }
  }

  return (
    <div className='unlock-screen'>
      <form onSubmit={handleUnlock}>
        <div className='form-group'>
          <input
            id='unlock-password'
            type='password'
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder='Enter your password'
            className='form-input'
            autoComplete='current-password'
            autoFocus
          />
        </div>

        {error && <div className='form-error'>{error}</div>}

        <button
          type='submit'
          className='primary-button'
          disabled={!password || isUnlocking}
          style={{ width: '100%', marginTop: '1rem' }}
        >
          {isUnlocking ? 'Unlocking...' : 'Unlock'}
        </button>
      </form>

      <div className='wallet-actions' style={{ marginTop: '1.5rem' }}>
        <button className='secondary-button' onClick={onCreateNew}>
          Create New Wallet
        </button>
        <button className='secondary-button' onClick={onImportNew}>
          Import Seed Phrase
        </button>
      </div>
    </div>
  )
}

/**
 * Root application component that manages wallet lifecycle, session timeout, and tab navigation.
 * @returns The main application UI including header, navigation, tab content, and modals.
 */
export default function App () {
  const {
    isInitialized,
    lastError,
    createWallet,
    importWallet,
    loadSavedWallets,
    lockWallet,
    isPasswordSet,
    savedWallets,
  } = useWalletStore()

  const { hasAcceptedTerms, acceptTerms } = useLegalStore()

  const [showWalletManagement, setShowWalletManagement] = useState(false)
  const [showWalletList, setShowWalletList] = useState(false)
  const [walletModalMode, setWalletModalMode] = useState<'create' | 'import'>('create')
  const [activeTab, setActiveTab] = useState<TabType>('balances')
  const [sessionTimedOut, setSessionTimedOut] = useState(false)
  const [createdWallet, setCreatedWallet] = useState<RailgunWallet | null>(null)
  const [showSettings, setShowSettings] = useState(false)

  // Handle session timeout - clears ALL sensitive data from memory
  const handleSessionTimeout = useCallback(() => {
    if (isPasswordSet) {
      lockWallet()
      setSessionTimedOut(true)
    }
  }, [lockWallet, isPasswordSet])

  // Load saved wallets on mount
  useEffect(() => {
    loadSavedWallets()
  }, [loadSavedWallets])

  // Session timeout management
  useEffect(() => {
    if (!isInitialized || !isPasswordSet) {
      return
    }

    const timeoutManager = new SessionTimeoutManager(handleSessionTimeout, SESSION_TIMEOUT_MS)
    timeoutManager.start()

    // Clean up sensitive data on page unload
    /**
     * Locks the wallet and clears sensitive data before the page unloads.
     */
    const handleBeforeUnload = () => {
      lockWallet()
    }
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      timeoutManager.stop()
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [isInitialized, isPasswordSet, handleSessionTimeout, lockWallet])

  // Reset session timeout notification when user re-authenticates
  useEffect(() => {
    if (isPasswordSet && sessionTimedOut) {
      setSessionTimedOut(false)
    }
  }, [isPasswordSet, sessionTimedOut])

  /**
   * Creates a new wallet with the given nickname and password, then shows the created wallet modal.
   * @param nickname - The display name for the new wallet.
   * @param password - The encryption password for the wallet.
   */
  const handleCreateWallet = async (nickname: string, password: string) => {
    try {
      const wallet = await createWallet(nickname, password)
      setShowWalletManagement(false)
      setCreatedWallet(wallet)
    } catch (error) {
      console.error('Failed to create wallet:', error)
      throw error
    }
  }

  /**
   * Imports an existing wallet from a seed phrase, encrypts it with the given password.
   * @param mnemonic - The BIP-39 seed phrase to import.
   * @param nickname - The display name for the imported wallet.
   * @param password - The encryption password for the wallet.
   */
  const handleImportWallet = async (mnemonic: string, nickname: string, password: string) => {
    try {
      await importWallet(mnemonic, nickname, password)
      setShowWalletManagement(false)
    } catch (error) {
      console.error('Failed to import wallet:', error)
      throw error
    }
  }

  /**
   * Opens the wallet management modal in "create" mode.
   */
  const handleOpenCreateModal = () => {
    setWalletModalMode('create')
    setShowWalletManagement(true)
    setShowWalletList(false)
  }

  /**
   * Opens the wallet management modal in "import" mode.
   */
  const handleOpenImportModal = () => {
    setWalletModalMode('import')
    setShowWalletManagement(true)
    setShowWalletList(false)
  }

  /**
   * Renders the page component corresponding to the currently active tab.
   * @returns The React element for the selected tab page.
   */
  const renderTabContent = () => {
    switch (activeTab) {
      case 'balances':
        return <BalancesPage />
      case 'history':
        return <HistoryPage />
      case 'transact':
        return <TransactPage />
      default:
        return <BalancesPage />
    }
  }

  // Gate: Require legal agreement acceptance before any wallet functionality
  if (!hasAcceptedTerms) {
    return <LegalAgreementModal onAccept={acceptTerms} />
  }

  if (!isInitialized) {
    return (
      <div className='wallet-container'>
        <div className='welcome-section'>
          <h1>Privacy Wallet</h1>

          {savedWallets.length > 0
            ? (
              <UnlockScreen
                savedWallets={savedWallets}
                onCreateNew={handleOpenCreateModal}
                onImportNew={handleOpenImportModal}
              />
              )
            : (
              <div className='wallet-actions'>
                <button className='primary-button' onClick={handleOpenCreateModal}>
                  Create New Wallet
                </button>
                <button className='secondary-button' onClick={handleOpenImportModal}>
                  Import Seed Phrase
                </button>
              </div>
              )}
        </div>

        <WalletManagementModal
          isOpen={showWalletManagement}
          onClose={() => setShowWalletManagement(false)}
          onCreateWallet={handleCreateWallet}
          onImportWallet={handleImportWallet}
          mode={walletModalMode}
        />
      </div>
    )
  }

  return (
    <div className='wallet-container'>
      <header className='app-header'>
        <h1>Privacy Wallet</h1>
        {lastError && <div className='error-message'>Error: {lastError}</div>}
        {sessionTimedOut && (
          <div className='session-timeout-notice'>
            Session timed out for security. Please re-enter your password to continue transactions.
          </div>
        )}
      </header>

      {/* Wallet Selector and Network Selector */}
      <div className='wallet-selector-container'>
        <WalletSelector onManageWallets={() => setShowWalletList(true)} />
        <NetworkSelector />
      </div>

      {/* Global Mode Toggle */}
      <Navigation activeTab={activeTab} onTabChange={setActiveTab} />

      <main className='tab-content'>{renderTabContent()}</main>

      {/* Settings Button */}
      <footer className='app-footer'>
        <button
          className='settings-footer-btn'
          onClick={() => setShowSettings(true)}
          title='Settings'
        >
          {'\u2699'} Settings
        </button>
      </footer>

      {/* Wallet Management Modals */}
      <WalletListModal
        isOpen={showWalletList}
        onClose={() => setShowWalletList(false)}
        onCreateNew={handleOpenCreateModal}
        onImportNew={handleOpenImportModal}
      />

      <WalletManagementModal
        isOpen={showWalletManagement}
        onClose={() => setShowWalletManagement(false)}
        onCreateWallet={handleCreateWallet}
        onImportWallet={handleImportWallet}
        mode={walletModalMode}
      />

      {createdWallet && (
        <WalletCreatedModal
          isOpen={!!createdWallet}
          onClose={() => setCreatedWallet(null)}
          wallet={createdWallet}
        />
      )}

      <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

      <NetworkRequestModal />
    </div>
  )
}
