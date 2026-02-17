import React, { useState } from 'react'

import type { RailgunWallet } from '@/types/wallet'
import { copyToClipboard } from '@/utils/clipboard'
import './shared-modal.css'
import './WalletCreatedModal.css'

interface WalletCreatedModalProps {
  isOpen: boolean
  onClose: () => void
  wallet: RailgunWallet
}

/**
 * Modal displaying newly created wallet details including addresses, seed phrase, and viewing key.
 * @param root0 - The component props
 * @param root0.isOpen - Whether the modal is currently visible
 * @param root0.onClose - Callback to close the modal after confirming backup
 * @param root0.wallet - The newly created wallet containing addresses and secrets
 * @returns The wallet created modal component or null when closed
 */
export const WalletCreatedModal: React.FC<WalletCreatedModalProps> = ({
  isOpen,
  onClose,
  wallet,
}) => {
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [seedRevealed, setSeedRevealed] = useState(false)
  const [viewingKeyRevealed, setViewingKeyRevealed] = useState(false)
  const [confirmedBackup, setConfirmedBackup] = useState(false)

  if (!isOpen) return null

  /**
   * Copies a value to the clipboard and briefly shows a copied indicator.
   * @param value - The text to copy to clipboard
   * @param fieldName - The field identifier used to show the copied indicator
   */
  const handleCopy = async (value: string, fieldName: string) => {
    await copyToClipboard(value)
    setCopiedField(fieldName)
    setTimeout(() => setCopiedField(null), 2000)
  }

  /**
   * Resets reveal states and closes the modal, only if the user has confirmed backup.
   */
  const handleClose = () => {
    if (!confirmedBackup) return
    setSeedRevealed(false)
    setViewingKeyRevealed(false)
    setConfirmedBackup(false)
    setCopiedField(null)
    onClose()
  }

  return (
    <div className='modal-overlay' onClick={handleClose}>
      <div className='modal-content wallet-created-modal' onClick={(e) => e.stopPropagation()}>
        <div className='modal-header'>
          <h2>
            <strong>{wallet.nickname || 'Unnamed'}</strong> Created
          </h2>
        </div>

        <div className='wallet-created-body'>
          <p className='wallet-created-subtitle'>Back up your recovery information below.</p>

          {/* Private Address (0zk) */}
          <div className='wallet-created-section'>
            <div className='wallet-created-label'>
              Private Address
              <span className='wallet-created-badge badge-private'>0zk</span>
            </div>
            <p className='wallet-created-description'>
              Your RAILGUN private address. Share this to receive shielded funds.
            </p>
            <div
              className={`wallet-created-value mono ${copiedField === 'address' ? 'copied' : ''}`}
              onClick={() => handleCopy(wallet.address, 'address')}
              title='Click to copy'
            >
              {wallet.address}
            </div>
            {copiedField === 'address' && <span className='copied-notice'>Copied!</span>}
          </div>

          {/* Public Address (0x) */}
          <div className='wallet-created-section'>
            <div className='wallet-created-label'>
              Public Address
              <span className='wallet-created-badge badge-public'>0x</span>
            </div>
            <p className='wallet-created-description'>
              Your Ethereum address for gas payments and receiving tokens before shielding.
            </p>
            <div
              className={`wallet-created-value mono ${copiedField === 'ethAddress' ? 'copied' : ''}`}
              onClick={() => handleCopy(wallet.ethereumAddress, 'ethAddress')}
              title='Click to copy'
            >
              {wallet.ethereumAddress}
            </div>
            {copiedField === 'ethAddress' && <span className='copied-notice'>Copied!</span>}
          </div>

          {/* Seed Phrase */}
          {wallet.mnemonic && (
            <div className='wallet-created-section section-sensitive'>
              <div className='wallet-created-label'>
                Seed Phrase
                <span className='wallet-created-badge badge-danger'>Secret</span>
              </div>
              <p className='wallet-created-description'>
                Your 12-word recovery phrase. Anyone with these words can access your funds. Write
                them down and store them offline in a safe place.
              </p>
              {!seedRevealed
                ? (
                  <button className='btn-reveal' onClick={() => setSeedRevealed(true)}>
                    Reveal Seed Phrase
                  </button>
                  )
                : (
                  <>
                    <div className='seed-phrase-grid'>
                      {wallet.mnemonic.split(' ').map((word, i) => (
                        <div className='seed-word' key={i}>
                          <span className='seed-word-index'>{i + 1}</span>
                          <span className='seed-word-text'>{word}</span>
                        </div>
                      ))}
                    </div>
                    <button
                      className='btn-copy-seed'
                      onClick={() => handleCopy(wallet.mnemonic!, 'mnemonic')}
                    >
                      {copiedField === 'mnemonic' ? 'Copied!' : 'Copy Seed Phrase'}
                    </button>
                  </>
                  )}
              <div className='wallet-created-warning'>
                <strong>Warning:</strong> Never share your seed phrase. No legitimate service will
                ever ask for it. If you lose it, your funds cannot be recovered.
              </div>
            </div>
          )}

          {/* Viewing Key */}
          <div className='wallet-created-section section-sensitive'>
            <div className='wallet-created-label'>
              Viewing Key
              <span className='wallet-created-badge badge-info'>Read-only</span>
            </div>
            <p className='wallet-created-description'>
              Allows viewing your transaction history and balances without spending authority.
              Useful for sharing with a tax accountant or auditor without giving them control of
              your funds.
            </p>
            {!viewingKeyRevealed
              ? (
                <button className='btn-reveal' onClick={() => setViewingKeyRevealed(true)}>
                  Reveal Viewing Key
                </button>
                )
              : (
                <>
                  <div
                    className={`wallet-created-value mono ${copiedField === 'viewingKey' ? 'copied' : ''}`}
                    onClick={() => handleCopy(wallet.viewingKey, 'viewingKey')}
                    title='Click to copy'
                  >
                    {wallet.viewingKey}
                  </div>
                  {copiedField === 'viewingKey' && <span className='copied-notice'>Copied!</span>}
                </>
                )}
          </div>

          {/* Confirmation checkbox */}
          <label className='wallet-created-confirm'>
            <input
              type='checkbox'
              checked={confirmedBackup}
              onChange={(e) => setConfirmedBackup(e.target.checked)}
            />
            <span>
              I have backed up my seed phrase and understand it cannot be recovered if lost.
            </span>
          </label>

          <div className='modal-actions'>
            <button
              className='btn-primary btn-full'
              onClick={handleClose}
              disabled={!confirmedBackup}
            >
              Continue to Wallet
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
