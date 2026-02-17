import React, { useState } from 'react'

import { validatePasswordStrength } from '@/utils/security'
import './shared-modal.css'
import './WalletManagementModal.css'

interface WalletManagementModalProps {
  isOpen: boolean
  onClose: () => void
  onCreateWallet: (nickname: string, password: string) => Promise<void | unknown>
  onImportWallet: (mnemonic: string, nickname: string, password: string) => Promise<void>
  mode: 'create' | 'import'
}

/**
 * Modal for creating or importing a RAILGUN wallet with password protection.
 * @param root0 - The component props
 * @param root0.isOpen - Whether the modal is currently visible
 * @param root0.onClose - Callback to close the modal
 * @param root0.onCreateWallet - Callback to create a new wallet with the given nickname and password
 * @param root0.onImportWallet - Callback to import a wallet from a mnemonic phrase
 * @param root0.mode - Whether the modal is in create or import mode
 * @returns The wallet management modal component or null when closed
 */
export const WalletManagementModal: React.FC<WalletManagementModalProps> = ({
  isOpen,
  onClose,
  onCreateWallet,
  onImportWallet,
  mode,
}) => {
  const [nickname, setNickname] = useState('')
  const [mnemonic, setMnemonic] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [passwordStrength, setPasswordStrength] = useState<'weak' | 'medium' | 'strong' | null>(
    null
  )

  /**
   * Validates form inputs and triggers wallet creation or import.
   * @param e - The form submission event
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (!nickname.trim()) {
      setError('Please enter a nickname for your wallet')
      return
    }

    if (!password) {
      setError('Please enter a password')
      return
    }

    // Validate password strength
    const passwordValidation = validatePasswordStrength(password)
    if (!passwordValidation.isValid) {
      setError(passwordValidation.errors.join('. '))
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setIsLoading(true)
    try {
      if (mode === 'create') {
        await onCreateWallet(nickname.trim(), password)
      } else {
        if (!mnemonic.trim()) {
          setError('Please enter your seed phrase')
          setIsLoading(false)
          return
        }
        await onImportWallet(mnemonic.trim(), nickname.trim(), password)
      }

      // Reset form and close
      setNickname('')
      setMnemonic('')
      setPassword('')
      setConfirmPassword('')
      setError('')
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setIsLoading(false)
    }
  }

  /**
   * Resets form state and closes the modal.
   */
  const handleClose = () => {
    setNickname('')
    setMnemonic('')
    setPassword('')
    setConfirmPassword('')
    setError('')
    setPasswordStrength(null)
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className='modal-overlay' onClick={handleClose}>
      <div className='modal-content' onClick={(e) => e.stopPropagation()}>
        <div className='modal-header'>
          <h2>{mode === 'create' ? 'Create New Wallet' : 'Import Wallet'}</h2>
          <button className='modal-close' onClick={handleClose}>
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className='modal-form'>
          <div className='form-group'>
            <label htmlFor='nickname'>Wallet Nickname</label>
            <input
              id='nickname'
              type='text'
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder='e.g., Personal, Trading, Savings'
              className='form-input'
              autoFocus
              disabled={isLoading}
            />
            <small className='form-hint'>
              Give your wallet a memorable name for easy identification
            </small>
          </div>

          {mode === 'import' && (
            <div className='form-group'>
              <label htmlFor='mnemonic'>Seed Phrase</label>
              <textarea
                id='mnemonic'
                value={mnemonic}
                onChange={(e) => setMnemonic(e.target.value)}
                placeholder='Enter your 12 or 24 word seed phrase...'
                rows={4}
                className='form-textarea'
                disabled={isLoading}
              />
              <small className='form-hint'>Enter the words separated by spaces</small>
            </div>
          )}

          <div className='form-group'>
            <label htmlFor='password'>Wallet Password</label>
            <input
              id='password'
              type='password'
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                if (e.target.value) {
                  const validation = validatePasswordStrength(e.target.value)
                  setPasswordStrength(validation.strength)
                } else {
                  setPasswordStrength(null)
                }
              }}
              placeholder='Enter a strong password...'
              className='form-input'
              disabled={isLoading}
              autoComplete='new-password'
            />
            <small className='form-hint'>
              Must include uppercase, lowercase, and a number.
              {passwordStrength && (
                <span className={`password-strength password-strength-${passwordStrength}`}>
                  {' '}
                  Strength: {passwordStrength}
                </span>
              )}
            </small>
          </div>

          <div className='form-group'>
            <label htmlFor='confirmPassword'>Confirm Password</label>
            <input
              id='confirmPassword'
              type='password'
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder='Re-enter your password...'
              className='form-input'
              disabled={isLoading}
              autoComplete='new-password'
            />
          </div>

          {error && <div className='form-error'>{error}</div>}

          <div className='modal-actions'>
            <button
              type='button'
              className='btn-secondary'
              onClick={handleClose}
              disabled={isLoading}
            >
              Cancel
            </button>
            <button type='submit' className='btn-primary' disabled={isLoading}>
              {isLoading
                ? mode === 'create'
                  ? 'Creating...'
                  : 'Importing...'
                : mode === 'create'
                  ? 'Create Wallet'
                  : 'Import Wallet'}
            </button>
          </div>

          {mode === 'create' && (
            <div className='wallet-info-box'>
              <strong>Important:</strong> After creating your wallet, you will see your seed phrase.
              Make sure to write it down and store it safely. This is the only way to recover your
              wallet.
            </div>
          )}
        </form>
      </div>
    </div>
  )
}
