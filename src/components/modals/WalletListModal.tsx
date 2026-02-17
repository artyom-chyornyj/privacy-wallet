import React, { useState } from 'react'

import { WalletDetailsModal } from './WalletDetailsModal'

import { useWalletStore } from '@/stores/walletStore'
import type { SavedWalletMetadata } from '@/types/wallet'
import './shared-modal.css'
import './WalletListModal.css'

interface WalletListModalProps {
  isOpen: boolean
  onClose: () => void
  onCreateNew: () => void
  onImportNew: () => void
}

/**
 * Modal that displays all saved wallets and allows switching, editing, or deleting them.
 * @param root0 - Component props object.
 * @param root0.isOpen - Whether the modal is currently visible.
 * @param root0.onClose - Callback to close the modal.
 * @param root0.onCreateNew - Callback to open the create-wallet flow.
 * @param root0.onImportNew - Callback to open the import-wallet flow.
 * @returns The wallet list modal UI, or null when not open.
 */
export const WalletListModal: React.FC<WalletListModalProps> = ({
  isOpen,
  onClose,
  onCreateNew,
  onImportNew,
}) => {
  const { savedWallets, currentWallet, switchWallet, deleteWallet, updateWalletNickname } =
    useWalletStore()
  const [switchingWalletId, setSwitchingWalletId] = useState<string | null>(null)
  const [switchPassword, setSwitchPassword] = useState('')
  const [switchError, setSwitchError] = useState('')
  const [editingWalletId, setEditingWalletId] = useState<string | null>(null)
  const [editNickname, setEditNickname] = useState('')
  const [detailsWallet, setDetailsWallet] = useState<SavedWalletMetadata | null>(null)

  /**
   * Truncates an address for display by showing the first 12 and last 10 characters.
   * @param address - The full wallet address string.
   * @returns The shortened address with ellipsis in the middle.
   */
  const formatAddress = (address: string): string => {
    if (!address) return ''
    const start = address.slice(0, 12)
    const end = address.slice(-10)
    return `${start}...${end}`
  }

  /**
   * Initiates the wallet switch flow by prompting for a password.
   * @param walletId - The ID of the wallet to switch to.
   */
  const handleSwitchWallet = async (walletId: string) => {
    setSwitchingWalletId(walletId)
    setSwitchError('')
  }

  /**
   * Confirms the wallet switch by authenticating with the entered password.
   */
  const handleConfirmSwitch = async () => {
    if (!switchingWalletId) return

    try {
      setSwitchError('')
      await switchWallet(switchingWalletId, switchPassword)
      setSwitchingWalletId(null)
      setSwitchPassword('')
      onClose()
    } catch (error) {
      setSwitchError(error instanceof Error ? error.message : 'Failed to switch wallet')
    }
  }

  /**
   * Cancels the wallet switch flow and resets the password input state.
   */
  const handleCancelSwitch = () => {
    setSwitchingWalletId(null)
    setSwitchPassword('')
    setSwitchError('')
  }

  /**
   * Prompts for confirmation and deletes the specified wallet.
   * @param walletId - The ID of the wallet to delete.
   */
  const handleDeleteWallet = (walletId: string) => {
    if (
      window.confirm(
        'Are you sure you want to delete this wallet? This will remove all cached data. Make sure you have your seed phrase backed up!'
      )
    ) {
      deleteWallet(walletId)
    }
  }

  /**
   * Enters edit mode for the specified wallet's nickname.
   * @param walletId - The ID of the wallet to edit.
   * @param currentNickname - The current nickname to populate the input field.
   */
  const handleStartEdit = (walletId: string, currentNickname: string) => {
    setEditingWalletId(walletId)
    setEditNickname(currentNickname)
  }

  /**
   * Saves the edited nickname for the specified wallet.
   * @param walletId - The ID of the wallet whose nickname is being updated.
   */
  const handleSaveEdit = (walletId: string) => {
    if (editNickname.trim()) {
      updateWalletNickname(walletId, editNickname.trim())
    }
    setEditingWalletId(null)
    setEditNickname('')
  }

  /**
   * Cancels the nickname edit and resets the editing state.
   */
  const handleCancelEdit = () => {
    setEditingWalletId(null)
    setEditNickname('')
  }

  if (!isOpen) return null

  return (
    <div className='modal-overlay' onClick={onClose}>
      <div className='modal-content wallet-list-modal' onClick={(e) => e.stopPropagation()}>
        <div className='modal-header'>
          <h2>My Wallets</h2>
          <button className='modal-close' onClick={onClose}>
            ×
          </button>
        </div>

        <div className='modal-body'>
          {switchingWalletId
            ? (
              <form
                className='switch-wallet-form'
                onSubmit={(e) => {
                  e.preventDefault()
                  handleConfirmSwitch()
                }}
              >
                <h3>Enter Password to Switch Wallet</h3>
                <p className='switch-hint'>
                  Enter your wallet password to unlock and switch to this wallet
                </p>
                <input
                  type='password'
                  value={switchPassword}
                  onChange={(e) => setSwitchPassword(e.target.value)}
                  placeholder='Enter your wallet password...'
                  className='form-input'
                  autoComplete='current-password'
                  autoFocus
                />
                {switchError && <div className='form-error'>{switchError}</div>}
                <div className='modal-actions'>
                  <button type='button' className='btn-secondary' onClick={handleCancelSwitch}>
                    Cancel
                  </button>
                  <button type='submit' className='btn-primary'>
                    Switch Wallet
                  </button>
                </div>
              </form>
              )
            : (
              <>
                <div className='wallet-list'>
                  {savedWallets.length === 0
                    ? (
                      <div className='empty-state'>
                        <p>No saved wallets yet</p>
                      </div>
                      )
                    : (
                        savedWallets.map((wallet) => {
                          const isActive = currentWallet?.id === wallet.id
                          const isEditing = editingWalletId === wallet.id

                          return (
                            <div key={wallet.id} className={`wallet-item ${isActive ? 'active' : ''}`}>
                              <div className='wallet-item-content'>
                                {isEditing
                                  ? (
                                    <div className='wallet-edit-form'>
                                      <input
                                        type='text'
                                        value={editNickname}
                                        onChange={(e) => setEditNickname(e.target.value)}
                                        className='form-input'
                                        autoFocus
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') handleSaveEdit(wallet.id)
                                          if (e.key === 'Escape') handleCancelEdit()
                                        }}
                                      />
                                      <div className='edit-actions'>
                                        <button
                                          className='btn-icon'
                                          onClick={() => handleSaveEdit(wallet.id)}
                                          title='Save'
                                        >
                                          ✓
                                        </button>
                                        <button
                                          className='btn-icon'
                                          onClick={handleCancelEdit}
                                          title='Cancel'
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    </div>
                                    )
                                  : (
                                    <>
                                      <div className='wallet-info'>
                                        <div className='wallet-nickname'>
                                          {wallet.nickname}
                                          {isActive && <span className='active-badge'>Active</span>}
                                        </div>
                                        <div className='wallet-addresses'>
                                          <div className='address-line'>
                                            <span className='address-label'>Private:</span>
                                            <span className='address-value'>
                                              {formatAddress(wallet.address)}
                                            </span>
                                          </div>
                                          <div className='address-line'>
                                            <span className='address-label'>Public:</span>
                                            <span className='address-value'>{wallet.ethereumAddress}</span>
                                          </div>
                                        </div>
                                      </div>
                                      <div className='wallet-actions'>
                                        {!isActive && (
                                          <button
                                            className='btn-switch'
                                            onClick={() => handleSwitchWallet(wallet.id)}
                                            title='Switch to this wallet'
                                          >
                                            Switch
                                          </button>
                                        )}
                                        <button
                                          className='btn-icon'
                                          onClick={() => setDetailsWallet(wallet)}
                                          title='View wallet details'
                                        >
                                          🔑
                                        </button>
                                        <button
                                          className='btn-icon'
                                          onClick={() => handleStartEdit(wallet.id, wallet.nickname)}
                                          title='Edit nickname'
                                        >
                                          ✏️
                                        </button>
                                        <button
                                          className='btn-icon btn-danger'
                                          onClick={() => handleDeleteWallet(wallet.id)}
                                          title='Delete wallet'
                                        >
                                          🗑️
                                        </button>
                                      </div>
                                    </>
                                    )}
                              </div>
                            </div>
                          )
                        })
                      )}
                </div>

                <div className='wallet-list-actions'>
                  <button className='btn-primary btn-full' onClick={onCreateNew}>
                    + Create New Wallet
                  </button>
                  <button className='btn-secondary btn-full' onClick={onImportNew}>
                    Import Existing Wallet
                  </button>
                </div>
              </>
              )}
        </div>
      </div>

      {detailsWallet && (
        <WalletDetailsModal
          isOpen={!!detailsWallet}
          onClose={() => setDetailsWallet(null)}
          wallet={detailsWallet}
        />
      )}
    </div>
  )
}
