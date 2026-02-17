import { ethers } from 'ethers'
import React, { useEffect, useRef, useState } from 'react'

import { PublicBalanceService } from '@/services/PublicBalanceService'
import { useWalletStore } from '@/stores/walletStore'
import type { NetworkName } from '@/types/network'
import './GasWalletSelector.css'

interface GasWalletSelectorProps {
  disabled?: boolean
  showLabel?: boolean
}

/**
 * Dropdown component for selecting which wallet pays transaction gas fees.
 * @param root0 - The component props
 * @param root0.disabled - Whether the selector should be disabled
 * @param root0.showLabel - Whether to show the label above the selector
 * @returns The rendered gas wallet selector component
 */
export const GasWalletSelector: React.FC<GasWalletSelectorProps> = ({
  disabled = false,
  showLabel = true,
}) => {
  const {
    currentWallet,
    savedWallets,
    unlockedGasWallets,
    selectedGasWalletId,
    setSelectedGasWallet,
    unlockWalletForGas,
    lockGasWallet,
    currentNetwork,
  } = useWalletStore()

  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const [unlockingWalletId, setUnlockingWalletId] = useState<string | null>(null)
  const [passwordInput, setPasswordInput] = useState('')
  const [unlockError, setUnlockError] = useState<string | null>(null)
  const [isUnlocking, setIsUnlocking] = useState(false)
  const [gasWalletEthBalance, setGasWalletEthBalance] = useState<string | null>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  /**
   * Truncate a wallet address for compact display.
   * @param address - The full wallet address to format
   * @returns The truncated address showing the first 6 and last 4 characters
   */
  const formatAddress = (address: string): string => {
    if (!address) return ''
    return `${address.slice(0, 6)}...${address.slice(-4)}`
  }

  // Get the currently selected wallet for display
  /**
   * Get display info for the currently selected gas payer wallet.
   * @returns An object with nickname, address, and whether it is the current active wallet
   */
  const getSelectedWalletDisplay = () => {
    if (!selectedGasWalletId || selectedGasWalletId === currentWallet?.id) {
      return {
        nickname: currentWallet?.nickname || 'Active Wallet',
        address: currentWallet?.ethereumAddress || '',
        isCurrentWallet: true,
      }
    }

    const gasWallet = unlockedGasWallets.find((w) => w.id === selectedGasWalletId)
    if (gasWallet) {
      return {
        nickname: gasWallet.nickname,
        address: gasWallet.ethereumAddress,
        isCurrentWallet: false,
      }
    }

    // Fallback to current wallet
    return {
      nickname: currentWallet?.nickname || 'Active Wallet',
      address: currentWallet?.ethereumAddress || '',
      isCurrentWallet: true,
    }
  }

  // Get other wallets that can be used for gas
  /**
   * Get the list of saved wallets excluding the current active wallet.
   * @returns Array of saved wallets available for gas payment selection
   */
  const getOtherWallets = () => {
    return savedWallets.filter((w) => w.id !== currentWallet?.id)
  }

  // Check if a wallet is unlocked for gas
  /**
   * Check whether a wallet has been unlocked for gas payment use.
   * @param walletId - The ID of the wallet to check
   * @returns True if the wallet is currently unlocked for gas
   */
  const isWalletUnlocked = (walletId: string) => {
    return unlockedGasWallets.some((w) => w.id === walletId)
  }

  /**
   * Select the current active wallet as the gas payer and close the dropdown.
   */
  const handleSelectCurrentWallet = () => {
    setSelectedGasWallet(null)
    setIsDropdownOpen(false)
  }

  /**
   * Select an unlocked wallet as the gas payer and close the dropdown.
   * @param walletId - The ID of the unlocked wallet to select
   */
  const handleSelectUnlockedWallet = (walletId: string) => {
    setSelectedGasWallet(walletId)
    setIsDropdownOpen(false)
  }

  /**
   * Begin the unlock flow for a wallet by showing its password input.
   * @param walletId - The ID of the wallet to start unlocking
   * @param e - The mouse event, stopped from propagating to parent click handlers
   */
  const handleStartUnlock = (walletId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    setUnlockingWalletId(walletId)
    setPasswordInput('')
    setUnlockError(null)
    // Always show password input - never auto-unlock with session password
    // to ensure user explicitly authorizes gas wallet usage
  }

  /**
   * Attempt to unlock the wallet currently being unlocked using the entered password.
   */
  const doUnlock = async () => {
    if (!unlockingWalletId || !passwordInput) return

    setIsUnlocking(true)
    setUnlockError(null)

    try {
      await unlockWalletForGas(unlockingWalletId, passwordInput)
      setUnlockingWalletId(null)
      setPasswordInput('')
    } catch (error) {
      setUnlockError(error instanceof Error ? error.message : 'Failed to unlock wallet')
    } finally {
      setIsUnlocking(false)
    }
  }

  /**
   * Handle submission of the unlock password form.
   * @param e - The synthetic event from the form or button click
   */
  const handleUnlockSubmit = (e: React.SyntheticEvent) => {
    e.preventDefault()
    e.stopPropagation()
    doUnlock()
  }

  /**
   * Cancel the wallet unlock flow and reset password input state.
   * @param e - The mouse event, stopped from propagating to parent click handlers
   */
  const handleCancelUnlock = (e: React.MouseEvent) => {
    e.stopPropagation()
    setUnlockingWalletId(null)
    setPasswordInput('')
    setUnlockError(null)
  }

  /**
   * Lock a previously unlocked gas wallet, revoking its gas payment authorization.
   * @param walletId - The ID of the wallet to lock
   * @param e - The mouse event, stopped from propagating to parent click handlers
   */
  const handleLockWallet = (walletId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    lockGasWallet(walletId)
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    /**
     * Close the dropdown and reset unlock state when clicking outside of it.
     * @param event - The mouse event from the document listener
     */
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false)
        if (!isUnlocking) {
          setUnlockingWalletId(null)
          setPasswordInput('')
          setUnlockError(null)
        }
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isUnlocking])

  // Fetch ETH balance for the selected gas payer wallet
  useEffect(() => {
    const selectedDisplay = getSelectedWalletDisplay()
    const address = selectedDisplay.address
    if (!address) {
      setGasWalletEthBalance(null)
      return
    }

    let cancelled = false
    setGasWalletEthBalance(null)

    /**
     * Fetch the ETH balance of the selected gas payer wallet from the network.
     */
    const fetchBalance = async () => {
      try {
        const balance = await PublicBalanceService.getInstance().getETHBalance(
          address,
          currentNetwork as NetworkName
        )
        if (!cancelled) {
          setGasWalletEthBalance(ethers.formatEther(balance))
        }
      } catch {
        if (!cancelled) {
          setGasWalletEthBalance(null)
        }
      }
    }

    fetchBalance()
    return () => {
      cancelled = true
    }
  }, [selectedGasWalletId, currentWallet?.id, currentNetwork])

  if (!currentWallet) {
    return null
  }

  const selectedDisplay = getSelectedWalletDisplay()
  const otherWallets = getOtherWallets()

  return (
    <div className='gas-wallet-selector' ref={dropdownRef}>
      {showLabel && <label className='gas-wallet-label'>Gas Payment Wallet</label>}

      <div
        className={`gas-wallet-dropdown ${isDropdownOpen ? 'open' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && setIsDropdownOpen(!isDropdownOpen)}
      >
        <div className='gas-wallet-selected'>
          <span className='gas-wallet-badge'>
            {selectedDisplay.isCurrentWallet ? 'Active' : 'Alt'}
          </span>
          <span className='gas-wallet-nickname'>{selectedDisplay.nickname}</span>
          <span className='gas-wallet-address'>{formatAddress(selectedDisplay.address)}</span>
          {gasWalletEthBalance !== null && (
            <span className='gas-wallet-eth-balance'>
              {parseFloat(gasWalletEthBalance).toFixed(4)} ETH
            </span>
          )}
        </div>
        <span className='gas-dropdown-arrow'>▼</span>

        {isDropdownOpen && !disabled && (
          <div className='gas-dropdown-menu'>
            {/* Current wallet option */}
            <div
              className={`gas-dropdown-item ${!selectedGasWalletId ? 'active' : ''}`}
              onClick={handleSelectCurrentWallet}
            >
              <div className='gas-wallet-option'>
                <div className='gas-wallet-option-header'>
                  <span className='gas-wallet-badge active-badge'>Active</span>
                  <span className='gas-wallet-option-nickname'>
                    {currentWallet.nickname || 'Current Wallet'}
                  </span>
                </div>
                <span className='gas-wallet-option-address'>{currentWallet.ethereumAddress}</span>
              </div>
            </div>

            {/* Other wallets */}
            {otherWallets.length > 0 && (
              <>
                <div className='gas-dropdown-divider' />
                <div className='gas-dropdown-section-label'>Other Wallets</div>

                {otherWallets.map((wallet) => {
                  const isUnlocked = isWalletUnlocked(wallet.id)
                  const isSelected = selectedGasWalletId === wallet.id
                  const isBeingUnlocked = unlockingWalletId === wallet.id

                  return (
                    <div
                      key={wallet.id}
                      className={`gas-dropdown-item ${isSelected ? 'active' : ''} ${!isUnlocked ? 'locked' : ''}`}
                      onClick={() => isUnlocked && handleSelectUnlockedWallet(wallet.id)}
                    >
                      <div className='gas-wallet-option'>
                        <div className='gas-wallet-option-header'>
                          <span
                            className={`gas-wallet-badge ${isUnlocked ? 'unlocked-badge' : 'locked-badge'}`}
                          >
                            {isUnlocked ? 'Unlocked' : 'Locked'}
                          </span>
                          <span className='gas-wallet-option-nickname'>{wallet.nickname}</span>
                        </div>
                        <span className='gas-wallet-option-address'>{wallet.ethereumAddress}</span>

                        {/* Unlock/Lock actions */}
                        {isBeingUnlocked
                          ? (
                            <div className='gas-unlock-form' onClick={(e) => e.stopPropagation()}>
                              <input
                                type='password'
                                placeholder='Enter password...'
                                value={passwordInput}
                                onChange={(e) => setPasswordInput(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    doUnlock()
                                  }
                                }}
                                className='gas-unlock-input'
                                autoFocus
                                disabled={isUnlocking}
                              />
                              {unlockError && <span className='gas-unlock-error'>{unlockError}</span>}
                              <div className='gas-unlock-actions'>
                                <button
                                  type='button'
                                  className='gas-unlock-btn confirm'
                                  disabled={isUnlocking || !passwordInput}
                                  onClick={handleUnlockSubmit}
                                >
                                  {isUnlocking ? '...' : 'Unlock'}
                                </button>
                                <button
                                  type='button'
                                  className='gas-unlock-btn cancel'
                                  onClick={handleCancelUnlock}
                                  disabled={isUnlocking}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                            )
                          : (
                            <div className='gas-wallet-actions'>
                              {isUnlocked
                                ? (
                                  <button
                                    className='gas-action-btn lock'
                                    onClick={(e) => handleLockWallet(wallet.id, e)}
                                    title='Lock wallet'
                                  >
                                    Lock
                                  </button>
                                  )
                                : (
                                  <button
                                    className='gas-action-btn unlock'
                                    onClick={(e) => handleStartUnlock(wallet.id, e)}
                                    title='Unlock for gas payment'
                                  >
                                    Unlock
                                  </button>
                                  )}
                            </div>
                            )}
                      </div>
                    </div>
                  )
                })}
              </>
            )}

            {otherWallets.length === 0 && (
              <div className='gas-dropdown-empty'>
                <span>No other wallets available</span>
                <span className='gas-dropdown-hint'>
                  Import or create another wallet to use for gas payments
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <p className='gas-wallet-hint'>
        Using a different wallet for gas enhances privacy by separating gas payments from your
        shielding wallet.
      </p>
    </div>
  )
}
