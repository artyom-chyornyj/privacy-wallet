import React, { useEffect, useRef, useState } from 'react'

import { useWalletStore } from '@/stores/walletStore'
import { NETWORK_CONFIG, NetworkName } from '@/types/network'
import './NetworkSelector.css'

/**
 * Dropdown selector for choosing the active blockchain network.
 * @returns The network selector component
 */
export const NetworkSelector: React.FC = () => {
  const { currentNetwork, setCurrentNetwork } = useWalletStore()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const networkOptions = [NetworkName.EthereumSepolia]

  /**
   * Returns the human-readable display name for a network.
   * @param network - The network enum value to look up
   * @returns The public display name of the network
   */
  const getNetworkDisplayName = (network: NetworkName): string => {
    return NETWORK_CONFIG[network]?.publicName || network
  }

  /**
   * Selects a network and closes the dropdown.
   * @param network - The network to switch to
   */
  const handleNetworkSelect = (network: NetworkName) => {
    setCurrentNetwork(network)
    setIsOpen(false)
  }

  useEffect(() => {
    /**
     * Closes the dropdown when a click occurs outside the component.
     * @param event - The mousedown event to check the click target.
     */
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  return (
    <div className='network-selector' ref={dropdownRef}>
      <div
        className={`network-dropdown-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className='network-value'>{getNetworkDisplayName(currentNetwork)}</span>
        <span className='network-arrow'>
          <svg width='10' height='6' viewBox='0 0 10 6' fill='none'>
            <path d='M1 1L5 5L9 1' stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round' />
          </svg>
        </span>

        {isOpen && (
          <div className='network-dropdown-menu' onClick={(e) => e.stopPropagation()}>
            <div className='network-dropdown-header'>Networks</div>
            {networkOptions.map((network) => (
              <div
                key={network}
                className={`network-dropdown-item ${currentNetwork === network ? 'active' : ''}`}
                onClick={() => handleNetworkSelect(network)}
              >
                <span className='network-item-name'>{getNetworkDisplayName(network)}</span>
                {currentNetwork === network && (
                  <svg className='network-check' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2.5' strokeLinecap='round' strokeLinejoin='round'>
                    <polyline points='20 6 9 17 4 12' />
                  </svg>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
