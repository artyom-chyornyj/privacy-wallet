/**
 * TransactionMetadataService
 *
 * Manages local (off-chain) metadata for transactions, including:
 * - Recipient 0zk addresses for sent transactions
 * - Optional memo/notes
 * - Custom labels
 *
 * Stored locally in the browser. Does not compromise privacy.
 */

import { dlog } from '@/utils/debug'

interface TransactionMetadata {
  txid: string
  walletId: string
  recipientAddress?: string
  recipientLabel?: string
  memo?: string
  tags?: string[]
  createdAt: number
  updatedAt: number
}

const STORAGE_KEY_PREFIX = 'tx_metadata:'

/**
 * Stores and retrieves local off-chain metadata for RAILGUN transactions.
 */
class TransactionMetadataService {
  /**
   * Singleton instance of the service.
   */
  private static instance: TransactionMetadataService

  /**
   * Private constructor to enforce singleton pattern.
   */
  private constructor () {}

  /**
   * Get the singleton instance of TransactionMetadataService.
   * @returns The shared TransactionMetadataService instance
   */
  static getInstance (): TransactionMetadataService {
    if (!this.instance) {
      this.instance = new TransactionMetadataService()
    }
    return this.instance
  }

  /**
   * Load all stored transaction metadata for a wallet from localStorage.
   * @param walletId - The wallet identifier to load metadata for
   * @returns A record mapping transaction IDs to their metadata
   */
  private loadMetadataForWallet (walletId: string): Record<string, TransactionMetadata> {
    try {
      const data = localStorage.getItem(`${STORAGE_KEY_PREFIX}${walletId}`)
      if (!data) return {}
      return JSON.parse(data)
    } catch (error) {
      console.error('Error loading transaction metadata:', error)
      return {}
    }
  }

  /**
   * Persist all transaction metadata for a wallet to localStorage.
   * @param walletId - The wallet identifier to save metadata for
   * @param metadata - The complete metadata record to persist
   */
  private saveMetadataForWallet (
    walletId: string,
    metadata: Record<string, TransactionMetadata>
  ): void {
    try {
      localStorage.setItem(`${STORAGE_KEY_PREFIX}${walletId}`, JSON.stringify(metadata))
    } catch (error) {
      console.error('Error saving transaction metadata:', error)
    }
  }

  /**
   * Retrieve metadata for a specific transaction.
   * @param walletId - The wallet identifier that owns the transaction
   * @param txid - The transaction ID to look up
   * @returns The transaction metadata, or null if not found
   */
  getMetadata (walletId: string, txid: string): TransactionMetadata | null {
    const allMetadata = this.loadMetadataForWallet(walletId)
    return allMetadata[txid] || null
  }

  /**
   * Save or update metadata for a transaction, preserving the original creation timestamp.
   * @param metadata - The transaction metadata to save
   */
  saveMetadata (metadata: TransactionMetadata): void {
    const allMetadata = this.loadMetadataForWallet(metadata.walletId)
    const existing = allMetadata[metadata.txid]

    allMetadata[metadata.txid] = {
      ...metadata,
      createdAt: existing?.createdAt || metadata.createdAt,
      updatedAt: Date.now(),
    }

    this.saveMetadataForWallet(metadata.walletId, allMetadata)
    dlog(`Saved metadata for transaction ${metadata.txid.slice(0, 10)}...`)
  }

  /**
   * Remove all stored transaction metadata for a wallet.
   * @param walletId - The wallet identifier to clear metadata for
   */
  clearWalletMetadata (walletId: string): void {
    localStorage.removeItem(`${STORAGE_KEY_PREFIX}${walletId}`)
    dlog(`Cleared all transaction metadata for wallet ${walletId}`)
  }
}

export type { TransactionMetadata }
export { TransactionMetadataService }
