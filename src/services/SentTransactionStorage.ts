/**
 * Caches sent transaction output data locally for PPOI proof generation.
 *
 * This is a convenience cache to avoid re-scanning the chain. If this data is
 * lost (e.g. cleared localStorage, new device), it is fully recoverable:
 *
 * 1. The blindedReceiverViewingKey is published on-chain in each Transact event.
 * 2. The sender computes: sharedKey = ECDH(senderViewingPrivateKey, blindedReceiverViewingKey)
 * 3. Using this sharedKey, the sender decrypts the on-chain ciphertext to recover
 *    random, value, tokenHash, and the receiver's master public key (-> npk).
 * 4. The senderRandom is recovered from the on-chain annotationData, decrypted
 *    with the sender's viewing private key.
 *
 * As long as the user has their seed phrase, all PPOI proof data can be reconstructed.
 * See: SubsquidBalanceScanner.tryDecryptCommitmentAsSender() for the implementation,
 * and POIService.getSentCommitmentsForRailgunTxid() for the fallback logic.
 */

interface SentTransactionOutput {
  transactionHash: string
  railgunTxid?: string
  commitmentHash: string

  // Output data needed for PPOI proofs
  npk: string
  value: bigint
  tokenHash: string
  tokenAddress: string
  tokenType: number
  tokenSubID: string

  recipientAddress: string // 0zk address
  timestamp: number
}

interface SerializedOutput extends Omit<SentTransactionOutput, 'value'> {
  value: string
}

const STORAGE_KEY = 'railgun_sent_outputs'

/**
 * Manages local storage of sent transaction output data for PPOI proof generation.
 */
class SentTransactionStorage {
  /** Singleton instance of SentTransactionStorage. */
  private static instance: SentTransactionStorage
  // Key is wallet.address (deterministic), NOT wallet.id (random per session),
  // so data persists across browser sessions.
  /** In-memory map of wallet addresses to their sent transaction outputs. */
  private storage = new Map<string, SentTransactionOutput[]>()

  /**
   * Initialize storage by loading persisted data from localStorage.
   */
  private constructor () {
    this.loadFromLocalStorage()
  }

  /**
   * Get or create the singleton instance of SentTransactionStorage.
   * @returns The singleton SentTransactionStorage instance
   */
  static getInstance (): SentTransactionStorage {
    if (!this.instance) {
      this.instance = new SentTransactionStorage()
    }
    return this.instance
  }

  /**
   * Store sent transaction outputs for a wallet, appending to any existing entries.
   * @param walletAddress - The deterministic wallet address used as the storage key
   * @param outputs - The transaction outputs to store
   */
  storeSentOutputs (walletAddress: string, outputs: SentTransactionOutput[]): void {
    const existing = this.storage.get(walletAddress) || []
    this.storage.set(walletAddress, [...existing, ...outputs])
    this.saveToLocalStorage()
  }

  /**
   * Retrieve all stored sent outputs for a given wallet address.
   * @param walletAddress - The deterministic wallet address to look up
   * @returns Array of sent transaction outputs, or an empty array if none exist
   */
  getSentOutputs (walletAddress: string): SentTransactionOutput[] {
    return this.storage.get(walletAddress) || []
  }

  /**
   * Retrieve sent outputs matching a specific on-chain transaction hash.
   * @param walletAddress - The deterministic wallet address to look up
   * @param transactionHash - The on-chain transaction hash to filter by
   * @returns Array of sent transaction outputs matching the given hash
   */
  getSentOutputsForTransaction (
    walletAddress: string,
    transactionHash: string
  ): SentTransactionOutput[] {
    return this.getSentOutputs(walletAddress).filter(
      (o) => o.transactionHash.toLowerCase() === transactionHash.toLowerCase()
    )
  }

  /**
   * Retrieve sent outputs matching a specific RAILGUN transaction ID.
   * @param walletAddress - The deterministic wallet address to look up
   * @param railgunTxid - The RAILGUN-specific transaction identifier to filter by
   * @returns Array of sent transaction outputs matching the given RAILGUN txid
   */
  getSentOutputsByRailgunTxid (walletAddress: string, railgunTxid: string): SentTransactionOutput[] {
    return this.getSentOutputs(walletAddress).filter(
      (o) => o.railgunTxid?.toLowerCase() === railgunTxid.toLowerCase()
    )
  }

  /**
   * Delete all stored outputs for a given wallet address and persist the change.
   * @param walletAddress - The deterministic wallet address whose outputs to clear
   */
  clearWalletOutputs (walletAddress: string): void {
    this.storage.delete(walletAddress)
    this.saveToLocalStorage()
  }

  /**
   * Serialize and persist all in-memory outputs to browser localStorage.
   */
  private saveToLocalStorage (): void {
    if (typeof window === 'undefined' || !window.localStorage) return

    try {
      const data: Record<string, SerializedOutput[]> = {}
      for (const [walletAddress, outputs] of this.storage.entries()) {
        data[walletAddress] = outputs.map((o) => ({
          ...o,
          value: o.value.toString(),
        }))
      }
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch (error) {
      console.error('Failed to save sent outputs to localStorage:', error)
    }
  }

  /**
   * Deserialize and load persisted outputs from browser localStorage into memory.
   */
  private loadFromLocalStorage (): void {
    if (typeof window === 'undefined' || !window.localStorage) return

    try {
      const json = window.localStorage.getItem(STORAGE_KEY)
      if (!json) return

      const data: Record<string, SerializedOutput[]> = JSON.parse(json)
      for (const [walletAddress, outputs] of Object.entries(data)) {
        this.storage.set(
          walletAddress,
          outputs.map((o) => ({ ...o, value: BigInt(o.value) }))
        )
      }
    } catch (error) {
      console.error('Failed to load sent outputs from localStorage:', error)
    }
  }
}

export type { SentTransactionOutput }
export { SentTransactionStorage }
