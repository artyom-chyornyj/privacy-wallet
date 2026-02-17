import React, { useMemo, useState } from 'react'

import { PublicBalanceService } from '@/services/PublicBalanceService'
import { TokenService } from '@/services/TokenService'
import type { NetworkName } from '@/types/network'
import type { TokenInfo } from '@/types/wallet'
import './shared-modal.css'
import './AddTokenModal.css'

interface AddTokenModalProps {
  isOpen: boolean
  onClose: () => void
  networkName: NetworkName
  onTokenAdded: () => void
}

/**
 * Validates that a string is a well-formed ERC-20 contract address.
 * @param address - The address string to validate.
 * @returns True if the address matches the 0x + 40 hex character format.
 */
const isValidAddress = (address: string): boolean => {
  return /^0x[0-9a-fA-F]{40}$/.test(address)
}

/**
 * Modal for adding a custom ERC-20 token by contract address, with optional auto-fill from RPC.
 * @param root0 - Component props object.
 * @param root0.isOpen - Whether the modal is currently visible.
 * @param root0.onClose - Callback to close the modal.
 * @param root0.networkName - The active network to query token metadata from.
 * @param root0.onTokenAdded - Callback invoked after a token is successfully added.
 * @returns The add-token modal UI, or null when not open.
 */
export const AddTokenModal: React.FC<AddTokenModalProps> = ({
  isOpen,
  onClose,
  networkName,
  onTokenAdded,
}) => {
  const [address, setAddress] = useState('')
  const [symbol, setSymbol] = useState('')
  const [name, setName] = useState('')
  const [decimals, setDecimals] = useState('18')
  const [isLooking, setIsLooking] = useState(false)
  const [error, setError] = useState('')
  const [lookupDone, setLookupDone] = useState(false)

  const builtInTokens = useMemo(() => {
    if (!isOpen) return []
    return TokenService.getInstance().getBuiltInTokens(networkName)
  }, [isOpen, networkName])

  if (!isOpen) return null

  /**
   * Resets all form fields and error state to their initial values.
   */
  const resetState = () => {
    setAddress('')
    setSymbol('')
    setName('')
    setDecimals('18')
    setIsLooking(false)
    setError('')
    setLookupDone(false)
  }

  /**
   * Populates form fields from a selected built-in token.
   * @param e - The select element change event containing the token address.
   */
  const handleBuiltInSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedAddress = e.target.value
    if (!selectedAddress) return
    const token = builtInTokens.find(
      (t) => t.address.toLowerCase() === selectedAddress.toLowerCase()
    )
    if (token) {
      setAddress(token.address)
      setSymbol(token.symbol)
      setName(token.name)
      setDecimals(String(token.decimals))
      setError('')
      setLookupDone(false)
    }
  }

  /**
   * Resets the form state and closes the modal.
   */
  const handleClose = () => {
    resetState()
    onClose()
  }

  /**
   * Validates the entered contract address format and checks for duplicates.
   * @returns An error message string if validation fails, or null if valid.
   */
  const validateAddress = (): string | null => {
    const trimmed = address.trim()
    if (!isValidAddress(trimmed)) {
      return 'Invalid address. Must be 0x followed by 40 hex characters.'
    }
    const tokenService = TokenService.getInstance()
    const existing = tokenService.getTokenSymbol(trimmed, networkName)
    if (existing !== 'UNKNOWN') {
      return `Token already added: ${existing}`
    }
    return null
  }

  /**
   * Fetches token metadata from the network RPC and auto-fills the form fields.
   */
  const handleLookup = async () => {
    const addrError = validateAddress()
    if (addrError) {
      setError(addrError)
      return
    }

    setError('')
    setIsLooking(true)

    try {
      const publicBalanceService = PublicBalanceService.getInstance()
      const metadata = await publicBalanceService.getTokenMetadata(address.trim(), networkName)

      if (metadata.symbol === 'UNKNOWN') {
        setError('Could not fetch token metadata. You can enter the details manually below.')
        setIsLooking(false)
        return
      }

      setSymbol(metadata.symbol)
      setName(metadata.name)
      setDecimals(String(metadata.decimals))
      setLookupDone(true)
    } catch {
      setError('RPC call failed. You can enter the details manually below.')
    } finally {
      setIsLooking(false)
    }
  }

  /**
   * Validates the form inputs and adds the custom token to the token service.
   */
  const handleAddToken = () => {
    const addrError = validateAddress()
    if (addrError) {
      setError(addrError)
      return
    }

    const trimmedSymbol = symbol.trim()
    if (!trimmedSymbol) {
      setError('Symbol is required.')
      return
    }

    const parsedDecimals = parseInt(decimals, 10)
    if (isNaN(parsedDecimals) || parsedDecimals < 0 || parsedDecimals > 18) {
      setError('Decimals must be a number between 0 and 18.')
      return
    }

    const token: TokenInfo = {
      address: address.trim().toLowerCase(),
      symbol: trimmedSymbol.toUpperCase(),
      name: name.trim() || trimmedSymbol.toUpperCase(),
      decimals: parsedDecimals,
    }

    const tokenService = TokenService.getInstance()
    tokenService.addCustomToken(token, networkName)
    resetState()
    onTokenAdded()
    onClose()
  }

  return (
    <div className='modal-overlay' onClick={handleClose}>
      <div className='modal-content add-token-modal' onClick={(e) => e.stopPropagation()}>
        <div className='modal-header'>
          <h2>Add Token</h2>
          <button className='modal-close' onClick={handleClose}>
            &times;
          </button>
        </div>

        <div className='add-token-body'>
          {builtInTokens.length > 0 && (
            <>
              <div className='add-token-field'>
                <label className='add-token-label'>Quick Add Built-in Token</label>
                <select
                  className='form-input add-token-select'
                  onChange={handleBuiltInSelect}
                  defaultValue=''
                >
                  <option value='' disabled>
                    Select a known token...
                  </option>
                  {builtInTokens.map((token) => (
                    <option key={token.address} value={token.address}>
                      {token.symbol} — {token.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className='add-token-separator'>
                <span>or add custom token</span>
              </div>
            </>
          )}

          <div className='add-token-field'>
            <label className='add-token-label'>Contract Address</label>
            <input
              type='text'
              className='form-input add-token-input'
              placeholder='0x...'
              value={address}
              onChange={(e) => {
                setAddress(e.target.value)
                setError('')
                setLookupDone(false)
              }}
              spellCheck={false}
              autoComplete='off'
            />
          </div>

          <button
            className='add-token-lookup-btn'
            onClick={handleLookup}
            disabled={isLooking || !isValidAddress(address.trim())}
          >
            {isLooking ? 'Looking up...' : 'Auto-fill from network (RPC call)'}
          </button>

          <div className='add-token-separator'>
            <span>or enter manually</span>
          </div>

          <div className='add-token-field'>
            <label className='add-token-label'>Symbol</label>
            <input
              type='text'
              className='form-input'
              placeholder='e.g. USDC'
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              spellCheck={false}
              autoComplete='off'
            />
          </div>

          <div className='add-token-field'>
            <label className='add-token-label'>Name (optional)</label>
            <input
              type='text'
              className='form-input'
              placeholder='e.g. USD Coin'
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              autoComplete='off'
            />
          </div>

          <div className='add-token-field'>
            <label className='add-token-label'>Decimals</label>
            <input
              type='number'
              className='form-input'
              placeholder='18'
              value={decimals}
              onChange={(e) => setDecimals(e.target.value)}
              min='0'
              max='18'
            />
          </div>

          {error && <div className='add-token-error'>{error}</div>}

          {lookupDone && <div className='add-token-success'>Fields auto-filled from network.</div>}

          <div className='modal-actions'>
            <button
              className='btn-primary btn-full'
              onClick={handleAddToken}
              disabled={!address.trim() || !symbol.trim()}
            >
              Add {symbol.trim() ? symbol.trim().toUpperCase() : 'Token'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
