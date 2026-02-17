import React, { useEffect, useRef, useState } from 'react'

import { useWalletStore } from '@/stores/walletStore'
import './WalletSelector.css'

interface WalletSelectorProps {
  className?: string
  onManageWallets?: () => void
}

/**
 * Dropdown component that displays the active wallet address and allows switching between private/public modes.
 * @param root0 - Component props object.
 * @param root0.className - Optional CSS class name to append to the root element.
 * @param root0.onManageWallets - Optional callback to open the wallet management modal.
 * @returns The wallet selector UI, or null if no wallet is loaded.
 */
export const WalletSelector: React.FC<WalletSelectorProps> = ({ className, onManageWallets }) => {
  const { currentWallet, balanceMode, setBalanceMode } = useWalletStore()
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null)
  const [isDropdownOpen, setIsDropdownOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>(null)

  /**
   * Truncates an address for compact display by showing the first 9 and last 8 characters.
   * @param address - The full address string to truncate.
   * @returns The shortened address with ellipsis in the middle.
   */
  const formatAddress = (address: string): string => {
    if (!address) return ''
    return `${address.slice(0, 9)}...${address.slice(-8)}`
  }

  /**
   * Truncates an address for the dropdown display with more visible characters.
   * @param address - The full address string to truncate.
   * @returns The shortened address with ellipsis in the middle.
   */
  const formatDropdownAddress = (address: string): string => {
    if (!address) return ''
    return `${address.slice(0, 12)}...${address.slice(-10)}`
  }

  /**
   * Returns the current wallet address based on the selected balance mode (private or public).
   * @returns The 0zk private address or 0x public address of the current wallet.
   */
  const getCurrentAddress = (): string => {
    if (!currentWallet) return ''
    return balanceMode === 'private' ? currentWallet.address : currentWallet.ethereumAddress
  }

  /**
   * Copies the given address to the clipboard and shows a temporary "copied" indicator.
   * @param e - The mouse event, stopped from propagating to parent handlers.
   * @param address - The wallet address to copy.
   */
  const handleCopyAddress = async (e: React.MouseEvent, address: string) => {
    e.stopPropagation()
    if (!address) return

    try {
      await navigator.clipboard.writeText(address)
      setCopiedAddress(address)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => setCopiedAddress(null), 2000)
    } catch (error) {
      console.error('Failed to copy address:', error)
    }
  }

  /**
   * Switches the balance mode between private and public and closes the dropdown.
   * @param type - The balance mode to switch to.
   */
  const handleWalletTypeSelect = (type: 'private' | 'public') => {
    setBalanceMode(type)
    setIsDropdownOpen(false)
  }

  useEffect(() => {
    /**
     * Closes the dropdown when a click occurs outside the component.
     * @param event - The mousedown event to check the click target.
     */
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    }
  }, [])

  if (!currentWallet) {
    return null
  }

  const modeLabel = balanceMode === 'private' ? 'Private' : 'Public'

  return (
    <div
      className={`wallet-selector ${isDropdownOpen ? 'open' : ''} ${className || ''}`}
      ref={dropdownRef}
      onClick={() => setIsDropdownOpen(!isDropdownOpen)}
    >
      <div className='wallet-label'>
        <span className='wallet-mode-badge'>{modeLabel}</span>
        {currentWallet.nickname
          ? (
            <span className='wallet-nickname'>{currentWallet.nickname}</span>
            )
          : (
            <span className='wallet-nickname-placeholder'>No nickname</span>
            )}
      </div>

      <div className='wallet-address-container'>
        <div className='wallet-dropdown'>
          <span className='wallet-address'>{formatAddress(getCurrentAddress())}</span>
          <span className='dropdown-arrow'>
            <svg width='10' height='6' viewBox='0 0 10 6' fill='none'>
              <path d='M1 1L5 5L9 1' stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round' />
            </svg>
          </span>

          {isDropdownOpen && (
            <div className='dropdown-menu' onClick={(e) => e.stopPropagation()}>
              <div className='dropdown-menu-header'>Addresses</div>

              <div
                className={`dropdown-item ${balanceMode === 'private' ? 'active' : ''}`}
                onClick={() => handleWalletTypeSelect('private')}
              >
                <div className='wallet-option'>
                  <div className='wallet-type-header'>
                    <span className='wallet-type-label private'>Private</span>
                    <span className='wallet-type-tech'>0zk</span>
                  </div>
                  <div className='wallet-address-row'>
                    <span className='wallet-address-full'>{formatDropdownAddress(currentWallet.address)}</span>
                    <button
                      className={`copy-button ${copiedAddress === currentWallet.address ? 'copied' : ''}`}
                      onClick={(e) => handleCopyAddress(e, currentWallet.address)}
                      title={copiedAddress === currentWallet.address ? 'Copied!' : 'Copy full address'}
                    >
                      {copiedAddress === currentWallet.address
                        ? (
                          <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round'>
                            <polyline points='20 6 9 17 4 12' />
                          </svg>
                          )
                        : (
                          <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                            <rect x='9' y='9' width='13' height='13' rx='2' ry='2' />
                            <path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' />
                          </svg>
                          )}
                    </button>
                  </div>
                </div>
              </div>

              <div
                className={`dropdown-item ${balanceMode === 'public' ? 'active' : ''}`}
                onClick={() => handleWalletTypeSelect('public')}
              >
                <div className='wallet-option'>
                  <div className='wallet-type-header'>
                    <span className='wallet-type-label public'>Public</span>
                    <span className='wallet-type-tech'>0x</span>
                  </div>
                  <div className='wallet-address-row'>
                    <span className='wallet-address-full'>{formatDropdownAddress(currentWallet.ethereumAddress)}</span>
                    <button
                      className={`copy-button ${copiedAddress === currentWallet.ethereumAddress ? 'copied' : ''}`}
                      onClick={(e) => handleCopyAddress(e, currentWallet.ethereumAddress)}
                      title={
                        copiedAddress === currentWallet.ethereumAddress ? 'Copied!' : 'Copy full address'
                      }
                    >
                      {copiedAddress === currentWallet.ethereumAddress
                        ? (
                          <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round'>
                            <polyline points='20 6 9 17 4 12' />
                          </svg>
                          )
                        : (
                          <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                            <rect x='9' y='9' width='13' height='13' rx='2' ry='2' />
                            <path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' />
                          </svg>
                          )}
                    </button>
                  </div>
                </div>
              </div>

              {onManageWallets && (
                <>
                  <div className='dropdown-divider' />
                  <div
                    className='dropdown-item manage-wallets'
                    onClick={(e) => {
                      e.stopPropagation()
                      setIsDropdownOpen(false)
                      onManageWallets()
                    }}
                  >
                    <svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                      <path d='M12 20h9' />
                      <path d='M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z' />
                    </svg>
                    <span>Manage Wallets</span>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
