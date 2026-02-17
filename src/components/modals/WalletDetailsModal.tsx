import React, { useState } from 'react'

import { useWalletStore } from '@/stores/walletStore'
import type { SavedWalletMetadata } from '@/types/wallet'
import { copyToClipboard } from '@/utils/clipboard'
import { ByteUtils, deriveRailgunKeys } from '@/utils/crypto'
import { decryptWithPassword } from '@/utils/passwordEncryption'
import './shared-modal.css'
import './WalletDetailsModal.css'

interface WalletDetailsModalProps {
  isOpen: boolean
  onClose: () => void
  wallet: SavedWalletMetadata
}

/**
 * Modal that displays wallet addresses, seed phrase, and viewing key with password-protected reveal.
 * @param root0 - Component props object.
 * @param root0.isOpen - Whether the modal is currently visible.
 * @param root0.onClose - Callback to close the modal.
 * @param root0.wallet - The wallet metadata to display details for.
 * @returns The wallet details modal UI, or null when not open.
 */
export const WalletDetailsModal: React.FC<WalletDetailsModalProps> = ({
  isOpen,
  onClose,
  wallet,
}) => {
  const { currentWallet } = useWalletStore()
  const [copiedField, setCopiedField] = useState<string | null>(null)

  // Seed phrase state
  const [seedRevealed, setSeedRevealed] = useState(false)
  const [seedPhrase, setSeedPhrase] = useState<string | null>(null)
  const [seedPassword, setSeedPassword] = useState('')
  const [seedError, setSeedError] = useState('')
  const [seedLoading, setSeedLoading] = useState(false)

  // Viewing key state
  const [viewingKeyRevealed, setViewingKeyRevealed] = useState(false)
  const [viewingKey, setViewingKey] = useState<string | null>(null)
  const [viewingKeyPassword, setViewingKeyPassword] = useState('')
  const [viewingKeyError, setViewingKeyError] = useState('')
  const [viewingKeyLoading, setViewingKeyLoading] = useState(false)

  if (!isOpen) return null

  const isActive = currentWallet?.id === wallet.id

  /**
   * Copies a value to the clipboard and shows a temporary "copied" indicator for the field.
   * @param value - The text to copy to the clipboard.
   * @param fieldName - An identifier for the field, used to track which field was just copied.
   */
  const handleCopy = async (value: string, fieldName: string) => {
    await copyToClipboard(value)
    setCopiedField(fieldName)
    setTimeout(() => setCopiedField(null), 2000)
  }

  /**
   * Initiates the seed phrase reveal, using the in-memory mnemonic if available or prompting for a password.
   */
  const handleRevealSeed = async () => {
    // If this is the active wallet and mnemonic is in memory, use it directly
    if (isActive && currentWallet?.mnemonic) {
      setSeedPhrase(currentWallet.mnemonic)
      setSeedRevealed(true)
      return
    }
    // Otherwise show password prompt
    setSeedRevealed(true)
  }

  /**
   * Decrypts and reveals the seed phrase using the entered password.
   * @param e - The form submission event.
   */
  const handleConfirmSeedPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!seedPassword) {
      setSeedError('Please enter your password')
      return
    }
    setSeedLoading(true)
    setSeedError('')
    try {
      const mnemonic = await decryptWithPassword(wallet.encryptedMnemonic, seedPassword)
      setSeedPhrase(mnemonic)
      setSeedPassword('')
    } catch {
      setSeedError('Incorrect password')
    } finally {
      setSeedLoading(false)
    }
  }

  /**
   * Initiates the viewing key reveal, using the in-memory key if available or prompting for a password.
   */
  const handleRevealViewingKey = async () => {
    // If this is the active wallet, viewing key is in memory
    if (isActive && currentWallet?.viewingKey) {
      setViewingKey(currentWallet.viewingKey)
      setViewingKeyRevealed(true)
      return
    }
    // Otherwise need password to decrypt mnemonic then derive keys
    setViewingKeyRevealed(true)
  }

  /**
   * Decrypts the mnemonic, derives the viewing key, and reveals it.
   * @param e - The form submission event.
   */
  const handleConfirmViewingKeyPassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!viewingKeyPassword) {
      setViewingKeyError('Please enter your password')
      return
    }
    setViewingKeyLoading(true)
    setViewingKeyError('')
    try {
      const mnemonic = await decryptWithPassword(wallet.encryptedMnemonic, viewingKeyPassword)
      // Derive keys from mnemonic to get viewing key
      const keys = await deriveRailgunKeys(mnemonic, 0)
      setViewingKey(ByteUtils.hexlify(keys.viewingKey))
      setViewingKeyPassword('')
    } catch {
      setViewingKeyError('Incorrect password')
    } finally {
      setViewingKeyLoading(false)
    }
  }

  /**
   * Clears all revealed secrets and sensitive state, then closes the modal.
   */
  const handleClose = () => {
    setSeedRevealed(false)
    setSeedPhrase(null)
    setSeedPassword('')
    setSeedError('')
    setViewingKeyRevealed(false)
    setViewingKey(null)
    setViewingKeyPassword('')
    setViewingKeyError('')
    setCopiedField(null)
    onClose()
  }

  return (
    <div className='modal-overlay' onClick={handleClose}>
      <div className='modal-content wallet-details-modal' onClick={(e) => e.stopPropagation()}>
        <div className='modal-header'>
          <h2>Wallet Details</h2>
          <button className='modal-close' onClick={handleClose}>
            ×
          </button>
        </div>

        <div className='wallet-details-body'>
          <div className='wallet-details-name'>
            {wallet.nickname}
            {isActive && <span className='active-badge'>Active</span>}
          </div>

          {/* Private Address (0zk) */}
          <div className='wallet-details-section'>
            <div className='wallet-details-label'>
              Private Address
              <span className='wallet-details-badge badge-private'>0zk</span>
            </div>
            <p className='wallet-details-description'>
              Your RAILGUN private address for receiving shielded transactions. Works across all EVM
              chains.
            </p>
            <div
              className={`wallet-details-value mono ${copiedField === 'address' ? 'copied' : ''}`}
              onClick={() => handleCopy(wallet.address, 'address')}
              title='Click to copy'
            >
              {wallet.address}
            </div>
            {copiedField === 'address' && <span className='copied-notice'>Copied!</span>}
          </div>

          {/* Public Address (0x) */}
          <div className='wallet-details-section'>
            <div className='wallet-details-label'>
              Public Address
              <span className='wallet-details-badge badge-public'>0x</span>
            </div>
            <p className='wallet-details-description'>
              Your Ethereum address for gas payments and receiving tokens before shielding.
            </p>
            <div
              className={`wallet-details-value mono ${copiedField === 'ethAddress' ? 'copied' : ''}`}
              onClick={() => handleCopy(wallet.ethereumAddress, 'ethAddress')}
              title='Click to copy'
            >
              {wallet.ethereumAddress}
            </div>
            {copiedField === 'ethAddress' && <span className='copied-notice'>Copied!</span>}
          </div>

          {/* Seed Phrase */}
          <div className='wallet-details-section section-sensitive'>
            <div className='wallet-details-label'>
              Seed Phrase
              <span className='wallet-details-badge badge-danger'>Secret</span>
            </div>
            <p className='wallet-details-description'>
              Your 12-word recovery phrase. Anyone with these words can access your funds.
            </p>
            {!seedRevealed
              ? (
                <button className='btn-reveal' onClick={handleRevealSeed}>
                  Reveal Seed Phrase
                </button>
                )
              : seedPhrase
                ? (
                  <>
                    <div className='seed-phrase-grid'>
                      {seedPhrase.split(' ').map((word, i) => (
                        <div className='seed-word' key={i}>
                          <span className='seed-word-index'>{i + 1}</span>
                          <span className='seed-word-text'>{word}</span>
                        </div>
                      ))}
                    </div>
                    <button
                      className='btn-copy-seed'
                      onClick={() => handleCopy(seedPhrase, 'mnemonic')}
                    >
                      {copiedField === 'mnemonic' ? 'Copied!' : 'Copy Seed Phrase'}
                    </button>
                  </>
                  )
                : (
                  <form onSubmit={handleConfirmSeedPassword} className='password-prompt'>
                    <input
                      type='password'
                      value={seedPassword}
                      onChange={(e) => setSeedPassword(e.target.value)}
                      placeholder='Enter wallet password...'
                      className='form-input'
                      autoFocus
                      autoComplete='current-password'
                      disabled={seedLoading}
                    />
                    {seedError && <div className='form-error'>{seedError}</div>}
                    <div className='password-prompt-actions'>
                      <button
                        type='button'
                        className='btn-secondary'
                        onClick={() => {
                          setSeedRevealed(false)
                          setSeedPassword('')
                          setSeedError('')
                        }}
                        disabled={seedLoading}
                      >
                        Cancel
                      </button>
                      <button type='submit' className='btn-primary' disabled={seedLoading}>
                        {seedLoading ? 'Decrypting...' : 'Unlock'}
                      </button>
                    </div>
                  </form>
                  )}
            <div className='wallet-details-warning'>
              <strong>Warning:</strong> Never share your seed phrase with anyone.
            </div>
          </div>

          {/* Viewing Key */}
          <div className='wallet-details-section section-sensitive'>
            <div className='wallet-details-label'>
              Viewing Key
              <span className='wallet-details-badge badge-info'>Read-only</span>
            </div>
            <p className='wallet-details-description'>
              Allows viewing your transaction history and balances without spending authority.
              Useful for sharing with a tax accountant or auditor without giving them control of
              your funds.
            </p>
            {!viewingKeyRevealed
              ? (
                <button className='btn-reveal' onClick={handleRevealViewingKey}>
                  Reveal Viewing Key
                </button>
                )
              : viewingKey
                ? (
                  <>
                    <div
                      className={`wallet-details-value mono ${copiedField === 'viewingKey' ? 'copied' : ''}`}
                      onClick={() => handleCopy(viewingKey, 'viewingKey')}
                      title='Click to copy'
                    >
                      {viewingKey}
                    </div>
                    {copiedField === 'viewingKey' && <span className='copied-notice'>Copied!</span>}
                  </>
                  )
                : (
                  <form onSubmit={handleConfirmViewingKeyPassword} className='password-prompt'>
                    <input
                      type='password'
                      value={viewingKeyPassword}
                      onChange={(e) => setViewingKeyPassword(e.target.value)}
                      placeholder='Enter wallet password...'
                      className='form-input'
                      autoFocus
                      autoComplete='current-password'
                      disabled={viewingKeyLoading}
                    />
                    {viewingKeyError && <div className='form-error'>{viewingKeyError}</div>}
                    <div className='password-prompt-actions'>
                      <button
                        type='button'
                        className='btn-secondary'
                        onClick={() => {
                          setViewingKeyRevealed(false)
                          setViewingKeyPassword('')
                          setViewingKeyError('')
                        }}
                        disabled={viewingKeyLoading}
                      >
                        Cancel
                      </button>
                      <button type='submit' className='btn-primary' disabled={viewingKeyLoading}>
                        {viewingKeyLoading ? 'Decrypting...' : 'Unlock'}
                      </button>
                    </div>
                  </form>
                  )}
          </div>

          <div className='modal-actions'>
            <button className='btn-secondary btn-full' onClick={handleClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
