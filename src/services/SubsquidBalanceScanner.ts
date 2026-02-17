import { poseidon } from '@railgun-community/circomlibjs'

import type { POIService } from './POIService'
import { SentTransactionStorage } from './SentTransactionStorage'
import { SubsquidDataFetcher } from './SubsquidDataFetcher'
import { TokenService } from './TokenService'

import { decodeMemoText, decryptNoteAnnotationData } from '@/core/transact-note'
import type { NetworkName } from '@/types/network'
import { NETWORK_CONFIG } from '@/types/network'
import type {
  DecryptedCommitment,
  POIStatus,
  RailgunWallet,
  SubsquidCommitment,
  SubsquidNullifier,
  TokenBalance,
} from '@/types/wallet'
import { AES } from '@/utils/aes'
import { ByteUtils } from '@/utils/crypto'
import { dlog, dwarn } from '@/utils/debug'
import { getSharedSymmetricKey, getTokenDataHash } from '@/utils/railgun-crypto'
import { reconstructReceiverAddress } from '@/utils/sender-address-reconstruction'

/**
 * Balance Scanner Service
 *
 * Implements balance scanning:
 * 1. Fetches commitments from Subsquid
 * 2. Decrypts commitments for the wallet
 * 3. Calculates token balances by type
 * 4. Applies PPOI validation for balance buckets
 */
class SubsquidBalanceScanner {
  /** Singleton instance of the balance scanner. */
  public static instance: SubsquidBalanceScanner
  /** Most recently decrypted commitments from the last scan. */
  public lastDecryptedCommitments: DecryptedCommitment[] = []
  /** Cached PPOI statuses keyed by blinded commitment hash. */
  public lastPOIStatuses: Record<string, POIStatus> = {}

  // TXO storage
  /** Persistent TXO storage keyed by wallet ID. */
  public storedTXOs: Map<string, DecryptedCommitment[]> = new Map()

  // Store ALL commitments from Subsquid for merkle tree population
  /** All commitments fetched from Subsquid for the last scanned network. */
  public lastAllCommitments: SubsquidCommitment[] = []
  /** Network name associated with the last fetched commitments. */
  public lastNetworkName: NetworkName | null = null

  // tokenHash -> tokenData map (built from shield preimages)
  /** Maps token hashes to their token data, built from shield preimages. */
  public tokenHashToTokenData: Map<
    string,
    { tokenAddress: string; tokenType: number; tokenSubID: string }
  > = new Map()

  // Map txid (transactionHash) -> first treePosition for Transact commitments in that tx
  /** Maps transaction hashes to the first tree position of their Transact commitments. */
  public txidToTransactStartPos: Map<string, number> = new Map()

  // Nullifier cache: network -> cached nullifiers (incremental, avoids full re-fetches)
  /** Cached nullifier events per network for incremental fetching. */
  public cachedNullifiers: Map<string, SubsquidNullifier[]> = new Map()
  // Track highest block number per network for incremental nullifier fetching
  /** Highest block number seen per network for incremental nullifier fetching. */
  private lastNullifierBlockNumber: Map<string, number> = new Map()

  // Cache version to invalidate old data when implementation changes
  /** Cache version string used to invalidate stale stored data. */
  public static readonly CACHE_VERSION = 'v3_sender_address_reconstruction' // Added blindedSenderViewingKey field
  /** LocalStorage key for persisting the cache version. */
  public static readonly CACHE_VERSION_KEY = 'railgun_wallet_txos_version'
  // Global tree math: trees are size 2^16 leaves
  /** Maximum number of leaves per merkle tree (2^16). */
  public static readonly TREE_MAX_ITEMS = 65_536

  /** LocalStorage key for persisting the nullifier cache. */
  private static readonly NULLIFIER_CACHE_KEY = 'railgun_nullifier_cache'

  /** Lazily-resolved POIService instance to break circular dependency. */
  private _poiService: POIService | null = null

  /**
   * Initialize the balance scanner and load persisted TXO and nullifier caches.
   * @param subsquidFetcher - Subsquid data fetcher instance for querying commitment data
   */
  public constructor (public subsquidFetcher: SubsquidDataFetcher) {
    // Load stored TXOs from localStorage on initialization
    this.loadStoredTXOs()
    this.loadNullifierCache()
  }

  /**
   * Lazily resolve POIService via dynamic import to break circular dependency.
   * @returns The resolved POIService instance
   */
  private async getPoiService (): Promise<POIService> {
    if (!this._poiService) {
      const { POIService: POISvc } = await import('./POIService')
      this._poiService = POISvc.getInstance()
    }
    return this._poiService
  }

  /**
   * Get or create the singleton instance of SubsquidBalanceScanner.
   * @returns The singleton SubsquidBalanceScanner instance
   */
  static getInstance (): SubsquidBalanceScanner {
    if (!this.instance) {
      this.instance = new SubsquidBalanceScanner(SubsquidDataFetcher.getInstance())
    }
    return this.instance
  }

  /**
   * Return cached PPOI statuses keyed by blindedCommitment (normalized 0x-lowercase, 64-byte).
   * @returns A shallow copy of the cached PPOI status map
   */
  public getCachedPOIStatuses (): Record<string, POIStatus> {
    return { ...this.lastPOIStatuses }
  }

  /**
   * Get ALL commitments from the last scan for merkle tree population.
   * This includes commitments from all wallets, not just the current wallet.
   * @param networkName - The network to retrieve cached commitments for
   * @returns Array of all cached commitments for the specified network
   */
  public getAllCommitmentsForNetwork (networkName: NetworkName): SubsquidCommitment[] {
    if (this.lastNetworkName !== networkName) {
      return [] // No cached data for this network
    }
    return [...this.lastAllCommitments]
  }

  /**
   * Main balance scanning function.
   * Decrypt and process balances from commitment data.
   * @param wallet - The RAILGUN wallet to scan balances for
   * @param networkName - The network to scan on
   * @param progressCallback - Optional callback receiving progress values from 0 to 1
   * @param options - Optional scan configuration
   * @param options.startBlockNumber - Block number to start scanning from
   * @param options.incremental - Whether to merge with existing TXOs instead of replacing
   * @returns Array of token balances grouped by balance bucket
   */
  async scanBalances (
    wallet: RailgunWallet,
    networkName: NetworkName,
    progressCallback?: (progress: number) => void,
    options?: { startBlockNumber?: number; incremental?: boolean }
  ): Promise<TokenBalance[]> {
    try {
      if (progressCallback) progressCallback(0)

      // Decide start block for incremental scans to avoid re-fetching history
      const startBlock = (() => {
        if (options?.startBlockNumber != null) return options.startBlockNumber
        if (options?.incremental) {
          const last = this.getLastStoredBlockNumber(wallet.id)
          return last > 0 ? last + 1 : 0
        }
        return 0
      })()

      // 1. Fetch commitments and nullifiers in parallel
      const [commitments, nullifiers] = await Promise.all([
        this.fetchCommitmentsForWallet(wallet, networkName, progressCallback, startBlock),
        this.fetchNullifiersIncremental(networkName),
      ])

      dlog(
        `Fetched ${commitments.length} commitments, ${nullifiers.length} nullifiers from Subsquid`
      )

      // Indicate we've finished initial fetch/setup (~30%) using 0–1 scale
      if (progressCallback) progressCallback(0.3)

      // 2. Decrypt commitments for this wallet (pass nullifiers to avoid re-fetching)
      const decryptedCommitments = await this.decryptCommitments(
        commitments,
        wallet,
        networkName,
        progressCallback,
        nullifiers
      )

      dlog(`Decrypted ${decryptedCommitments.length}/${commitments.length} commitments`)

      // Merge with existing TXOs in incremental mode, otherwise replace
      if (options?.incremental) {
        const existing = this.getDecryptedCommitmentsForWallet(wallet.id) || []
        const byId = new Map<string, DecryptedCommitment>()
        for (const c of existing) byId.set(c.id, c)
        for (const c of decryptedCommitments) byId.set(c.id, c)
        const merged = Array.from(byId.values())
        // Update in-memory and persistent caches
        this.lastDecryptedCommitments = merged
        this.storeTXOsForWallet(wallet.id, merged)
      } else {
        // Store the decrypted commitments for transaction history service
        this.lastDecryptedCommitments = decryptedCommitments
        // Store decrypted commitments as TXOs for this wallet (persistent storage)
        this.storeTXOsForWallet(wallet.id, decryptedCommitments)
      }

      dlog('Stored decrypted commitments for wallet')

      // Decryption complete, advance to 60%
      if (progressCallback) progressCallback(0.6)

      // 3. Calculate token balances WITH BUCKETS (Spendable/Pending/Blocked)
      // In incremental mode, compute balances from the full merged set to avoid flicker/clearing
      const sourceForBalances = options?.incremental
        ? this.getDecryptedCommitmentsForWallet(wallet.id)
        : decryptedCommitments
      const finalBalances = await this.calculateTokenBalancesWithBuckets(
        sourceForBalances,
        networkName,
        wallet.address // Pass wallet address to check SentTransactionStorage
      )

      dlog(`Calculated ${finalBalances.length} token balance entries (split by bucket)`)

      // Balances calculated, advance to 80%
      if (progressCallback) progressCallback(0.8)

      // Done
      if (progressCallback) progressCallback(1)

      return finalBalances
    } catch (error) {
      console.error('Error scanning balances:', error)
      throw error
    }
  }

  /**
   * Get decrypted commitments for wallet (TXOs).
   * This is the main entry point for transaction history - similar to AbstractWallet.TXOs().
   * @param walletId - Optional wallet ID to retrieve stored TXOs for
   * @returns Array of decrypted commitments for the wallet
   */
  getDecryptedCommitmentsForWallet (walletId?: string): DecryptedCommitment[] {
    // If we have stored TXOs for a specific wallet, return those
    if (walletId && this.storedTXOs.has(walletId)) {
      const storedCommitments = this.storedTXOs.get(walletId) || []
      // Check for corrupted random values and auto-fix if needed
      const corruptedCount = storedCommitments.filter(
        (c) =>
          !c.random ||
          c.random === '0x0000000000000000000000000000000000000000000000000000000000000000'
      ).length

      if (corruptedCount > 0) {
        dwarn(
          `Found ${corruptedCount}/${storedCommitments.length} UTXOs with corrupted random values. Auto-clearing ALL caches to fix.`
        )
        this.clearStoredTXOs(walletId)

        // Also clear walletStore cache which stores balances separately
        // Clear all wallet store cache keys that match this wallet
        const keysToRemove: string[] = []
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i)
          if (key && key.startsWith(`wallet:${walletId}:`)) {
            keysToRemove.push(key)
          }
        }
        keysToRemove.forEach((key) => localStorage.removeItem(key))

        return [] // Force a fresh scan
      }

      return storedCommitments
    }

    // Otherwise, return the last decrypted commitments (for backward compatibility)
    dlog(`Returning ${this.lastDecryptedCommitments.length} in-memory commitments`)
    return this.lastDecryptedCommitments
  }

  /**
   * Quickly reconstruct balances from stored TXOs without any network calls.
   * @param walletId - The wallet ID to retrieve TXOs for
   * @param networkName - The network to calculate balances on
   * @param walletAddress - Optional wallet address for checking SentTransactionStorage
   * @returns Array of token balances calculated from stored TXOs
   */
  public async getBalancesFromStoredTXOs (
    walletId: string,
    networkName: NetworkName,
    walletAddress?: string // Optional wallet address for checking SentTransactionStorage
  ): Promise<TokenBalance[]> {
    const txos = this.getDecryptedCommitmentsForWallet(walletId)

    // Group balances by token AND balance bucket
    return await this.calculateTokenBalancesWithBuckets(txos, networkName, walletAddress)
  }

  /**
   * Check if we have stored TXOs for a wallet.
   * @param walletId - The wallet ID to check
   * @returns True if stored TXOs exist and are non-empty for this wallet
   */
  hasStoredTXOs (walletId: string): boolean {
    return this.storedTXOs.has(walletId) && (this.storedTXOs.get(walletId)?.length || 0) > 0
  }

  /**
   * Load stored TXOs from localStorage
   */
  public loadStoredTXOs (): void {
    try {
      // Check cache version first
      const storedVersion = localStorage.getItem(SubsquidBalanceScanner.CACHE_VERSION_KEY)
      if (storedVersion !== SubsquidBalanceScanner.CACHE_VERSION) {
        dlog(
          `Cache version mismatch (expected ${SubsquidBalanceScanner.CACHE_VERSION}, found ${storedVersion || 'none'}). Clearing caches.`
        )

        localStorage.removeItem('railgun_wallet_txos')
        localStorage.removeItem('railgun_wallet_balances')
        localStorage.removeItem(SubsquidBalanceScanner.NULLIFIER_CACHE_KEY)
        localStorage.setItem(
          SubsquidBalanceScanner.CACHE_VERSION_KEY,
          SubsquidBalanceScanner.CACHE_VERSION
        )
        this.storedTXOs = new Map()
        return
      }

      const stored = localStorage.getItem('railgun_wallet_txos')
      if (stored) {
        const data = JSON.parse(stored) as Record<string, any[]>
        // Restore BigInt values that were converted to strings during JSON serialization
        this.storedTXOs = new Map(
          Object.entries(data).map(([walletId, commitments]) => [
            walletId,
            commitments.map((c) => ({
              ...c,
              value: BigInt(c.value || '0'),
              timestamp: Number(c.timestamp || 0),
              blockNumber: Number(c.blockNumber || 0),
              // Ensure random field is preserved
              random:
                c.random || '0x0000000000000000000000000000000000000000000000000000000000000000',
            })),
          ])
        )
        dlog(`Loaded stored TXOs for ${this.storedTXOs.size} wallets from localStorage`)
      }
    } catch (error) {
      console.error('Error loading stored TXOs:', error)
      this.storedTXOs = new Map()
    }
  }

  /**
   * Return the highest blockNumber seen in stored TXOs for a wallet, or 0 if none.
   * @param walletId - The wallet ID to check
   * @returns The highest block number among stored TXOs, or 0
   */
  public getLastStoredBlockNumber (walletId: string): number {
    try {
      const txos = this.storedTXOs.get(walletId) || []
      if (txos.length === 0) return 0
      return txos.reduce((max, c) => (c.blockNumber > max ? c.blockNumber : max), 0)
    } catch {
      return 0
    }
  }

  /**
   * Fetch nullifiers incrementally - only fetches new ones since last cached block.
   * Returns the full merged set of nullifiers for the network.
   * @param networkName - The network to fetch nullifiers for
   * @returns The full merged set of nullifier events for the network
   */
  public async fetchNullifiersIncremental (networkName: NetworkName): Promise<SubsquidNullifier[]> {
    const cached = this.cachedNullifiers.get(networkName) || []
    const lastBlock = this.lastNullifierBlockNumber.get(networkName) || 0
    const startBlock = lastBlock > 0 ? lastBlock + 1 : 0

    dlog(`Fetching nullifiers incrementally from block ${startBlock} (cached: ${cached.length})`)

    const newNullifiers = await this.subsquidFetcher.fetchNullifierEvents(networkName, startBlock)

    if (newNullifiers.length > 0) {
      // Merge: deduplicate by nullifier id in case of overlap
      const byId = new Map<string, SubsquidNullifier>()
      for (const n of cached) byId.set(n.id, n)
      for (const n of newNullifiers) byId.set(n.id, n)
      const merged = Array.from(byId.values())

      // Update the highest block number
      const highestBlock = merged.reduce(
        (max, n) => Math.max(max, Number(n.blockNumber)),
        lastBlock
      )

      this.cachedNullifiers.set(networkName, merged)
      this.lastNullifierBlockNumber.set(networkName, highestBlock)
      this.saveNullifierCache()

      dlog(
        `Nullifiers updated: ${cached.length} cached + ${newNullifiers.length} new = ${merged.length} total (up to block ${highestBlock})`
      )
      return merged
    }

    dlog(`No new nullifiers since block ${startBlock}`)
    return cached
  }

  /**
   * Load cached nullifier events from localStorage into memory.
   */
  private loadNullifierCache (): void {
    try {
      const stored = localStorage.getItem(SubsquidBalanceScanner.NULLIFIER_CACHE_KEY)
      if (!stored) return
      const data = JSON.parse(stored) as Record<
        string,
        { nullifiers: SubsquidNullifier[]; lastBlock: number }
      >
      for (const [network, entry] of Object.entries(data)) {
        this.cachedNullifiers.set(network, entry.nullifiers)
        this.lastNullifierBlockNumber.set(network, entry.lastBlock)
      }
      dlog(`Loaded nullifier cache from localStorage for ${Object.keys(data).length} networks`)
    } catch (error) {
      console.error('Error loading nullifier cache:', error)
    }
  }

  /**
   * Persist in-memory nullifier cache to localStorage.
   */
  private saveNullifierCache (): void {
    try {
      const data: Record<string, { nullifiers: SubsquidNullifier[]; lastBlock: number }> = {}
      for (const [network, nullifiers] of this.cachedNullifiers) {
        data[network] = {
          nullifiers,
          lastBlock: this.lastNullifierBlockNumber.get(network) || 0,
        }
      }
      localStorage.setItem(SubsquidBalanceScanner.NULLIFIER_CACHE_KEY, JSON.stringify(data))
    } catch (error) {
      console.error('Error saving nullifier cache:', error)
    }
  }

  /**
   * Save TXOs to localStorage
   */
  public saveStoredTXOs (): void {
    try {
      // Convert BigInt values to strings for JSON serialization
      const data: Record<string, any[]> = {}
      for (const [walletId, commitments] of this.storedTXOs) {
        data[walletId] = commitments.map((c) => ({
          ...c,
          value: c.value?.toString() || '0',
          timestamp: Number(c.timestamp || 0),
          blockNumber: Number(c.blockNumber || 0),
          // Ensure random field is preserved
          random: c.random || '0x0000000000000000000000000000000000000000000000000000000000000000',
        }))
      }
      localStorage.setItem('railgun_wallet_txos', JSON.stringify(data))
      localStorage.setItem(
        SubsquidBalanceScanner.CACHE_VERSION_KEY,
        SubsquidBalanceScanner.CACHE_VERSION
      )
      dlog(`Saved TXOs for ${this.storedTXOs.size} wallets to localStorage`)
    } catch (error) {
      console.error('Error saving stored TXOs:', error)
    }
  }

  /**
   * Store decrypted commitments as TXOs for a wallet.
   * @param walletId - The wallet ID to store TXOs for
   * @param commitments - The decrypted commitments to store
   */
  public storeTXOsForWallet (walletId: string, commitments: DecryptedCommitment[]): void {
    // Store commitments for this wallet
    this.storedTXOs.set(walletId, commitments)

    // Persist to localStorage
    this.saveStoredTXOs()

    dlog(`Stored ${commitments.length} TXOs for wallet ${walletId}`)
  }

  /**
   * Clear stored TXOs for a wallet (useful for testing or re-scanning).
   * @param walletId - The wallet ID to clear TXOs for
   */
  clearStoredTXOs (walletId: string): void {
    this.storedTXOs.delete(walletId)
    this.lastDecryptedCommitments = []
    this.saveStoredTXOs()
    dlog(`Cleared stored TXOs for wallet ${walletId}`)
  }

  /**
   * Clear all cached data
   */
  clearCache (): void {
    this.storedTXOs.clear()
    localStorage.removeItem('railgun_wallet_txos')
    localStorage.removeItem(SubsquidBalanceScanner.CACHE_VERSION_KEY)
    this.lastDecryptedCommitments = []
    this.lastAllCommitments = []
    this.lastNetworkName = null
    this.tokenHashToTokenData.clear()
    this.txidToTransactStartPos.clear()
    this.saveStoredTXOs()
    dlog('Cleared all Subsquid scanner cache')
  }

  /**
   * Try to decrypt a TransactCommitment as the SENDER for PPOI proof generation
   *
   * This is CRITICAL for security - the sender can decrypt their own sent outputs
   * to generate PPOI proofs without needing access to receiver wallets.
   *
   * How it works:
   * 1. Extract blindedReceiverViewingKey from on-chain ciphertext
   * 2. Derive shared key: ECDH(senderViewingPrivateKey, blindedReceiverViewingKey)
   * 3. Decrypt ciphertext to extract: npk, value, tokenData, random
   * 4. Return decrypted commitment with all PPOI-required fields
   *
   * Decrypt TransactNote ciphertext with isSentNote=true.
   * @param commitment - The Subsquid commitment to attempt decryption on
   * @param wallet - The RAILGUN wallet used as sender for ECDH key derivation
   * @returns The decrypted commitment if successful, or null if decryption fails
   */
  async tryDecryptCommitmentAsSender (
    commitment: SubsquidCommitment,
    wallet: RailgunWallet
  ): Promise<DecryptedCommitment | null> {
    try {
      const viewingPrivateKey = ByteUtils.hexStringToBytes(wallet.viewingKey)

      // Only TransactCommitments have ciphertexts
      if (
        commitment.commitmentType !== 'TransactCommitment' ||
        !('ciphertext' in commitment) ||
        !commitment.ciphertext ||
        !commitment.ciphertext.ciphertext
      ) {
        return null
      }

      const ciphertext = commitment.ciphertext

      // SENDER decryption: derive shared key using blindedReceiverViewingKey
      // This is the OPPOSITE of receiver decryption which uses blindedSenderViewingKey
      const blindedReceiverViewingKey = ByteUtils.hexStringToBytes(
        ciphertext.blindedReceiverViewingKey
      )

      const sharedKeySender = await getSharedSymmetricKey(
        viewingPrivateKey,
        blindedReceiverViewingKey
      )

      if (!sharedKeySender) {
        dwarn('tryDecryptCommitmentAsSender: Failed to derive shared key (ECDH)')
        return null
      }

      // Handle memo: Subsquid may return it as a string or array
      // For V2: memo should be a single hex string (the 4th encrypted block)
      // For Legacy: memo could be an array of hex strings
      const memoHex = Array.isArray(ciphertext.memo)
        ? ciphertext.memo.length > 0
          ? ciphertext.memo[0]
          : '' // Take first element if array
        : ciphertext.memo || '' // Use as-is if string

      // Decrypt using TransactNote.decrypt pattern with isSentNote=true
      // Pass annotationData and viewingPrivateKey so MPK can be properly XOR-decoded
      const decryptedNote = await this.tryDecryptTransactNoteV2(
        ciphertext.ciphertext,
        sharedKeySender,
        true, // isSentNote=true for sender-side decryption
        memoHex,
        wallet.masterPublicKey,
        ciphertext.annotationData,
        viewingPrivateKey
      )

      if (!decryptedNote) {
        return null
      }

      // Return full commitment structure needed for PPOI proof generation
      // For sender notes, we don't have senderMasterPublicKey (we ARE the sender)
      return {
        id: commitment.id,
        hash: commitment.hash,
        txid: commitment.transactionHash || '',
        blockNumber:
          typeof commitment.blockNumber === 'string'
            ? parseInt(commitment.blockNumber)
            : commitment.blockNumber,
        treeNumber: commitment.treeNumber,
        batchStartTreePosition:
          typeof commitment.batchStartTreePosition === 'string'
            ? parseInt(commitment.batchStartTreePosition)
            : commitment.batchStartTreePosition,
        position:
          typeof commitment.treePosition === 'string'
            ? parseInt(commitment.treePosition)
            : commitment.treePosition || 0,
        commitmentType: commitment.commitmentType,
        tokenAddress: decryptedNote.tokenAddress,
        tokenType: decryptedNote.tokenType,
        tokenSubID: decryptedNote.tokenSubID,
        value: decryptedNote.value,
        npk: decryptedNote.npk,
        isSpent: false,
        timestamp: parseInt(commitment.blockTimestamp || '0'),
        random: '0x' + decryptedNote.random,
        blindedSenderViewingKey: ciphertext.blindedSenderViewingKey,
      }
    } catch (error) {
      // Log the error for debugging PPOI proof generation issues
      dwarn('tryDecryptCommitmentAsSender failed:', error)
      return null
    }
  }

  /**
   * Fetch commitments for wallet from Subsquid.
   * Similar to UTXOMerkletree.getCommitmentRange() but from Subsquid.
   * @param wallet - The RAILGUN wallet to fetch commitments for
   * @param networkName - The network to query
   * @param progressCallback - Optional callback receiving progress values from 0 to 1
   * @param startBlockNumber - Block number to start fetching from (defaults to 0)
   * @returns Array of commitments sorted chronologically
   */
  public async fetchCommitmentsForWallet (
    wallet: RailgunWallet,
    networkName: NetworkName,
    progressCallback?: (progress: number) => void,
    startBlockNumber: number = 0
  ): Promise<SubsquidCommitment[]> {
    dlog(`Fetching commitments from block ${startBlockNumber || 0} for wallet ${wallet.id}`)

    const { commitments } = await this.subsquidFetcher.fetchNewTransactionsAndCommitments(
      networkName,
      startBlockNumber
    )

    // Sort chronologically (oldest first)
    commitments.sort((a, b) => {
      const blockA = typeof a.blockNumber === 'string' ? parseInt(a.blockNumber) : a.blockNumber
      const blockB = typeof b.blockNumber === 'string' ? parseInt(b.blockNumber) : b.blockNumber
      if (blockA !== blockB) return blockA - blockB
      const posA = typeof a.treePosition === 'string' ? parseInt(a.treePosition) : a.treePosition
      const posB = typeof b.treePosition === 'string' ? parseInt(b.treePosition) : b.treePosition
      return posA - posB
    })

    // Store ALL commitments for merkle tree population
    this.lastAllCommitments = [...commitments]
    this.lastNetworkName = networkName

    if (progressCallback) {
      progressCallback(Math.min(Math.min(commitments.length, 100) * 0.002, 0.2))
    }

    dlog(`Fetched ${commitments.length} commitments from Subsquid`)
    return commitments
  }

  /**
   * Decrypt commitments for this wallet.
   * Similar to AbstractWallet.tryDecryptCommitments().
   * @param commitments - Raw commitments from Subsquid to attempt decryption on
   * @param wallet - The RAILGUN wallet to decrypt for
   * @param networkName - The network name for nullifier detection
   * @param progressCallback - Optional callback receiving progress values from 0 to 1
   * @param nullifiers - Optional pre-fetched nullifiers to avoid redundant fetches
   * @returns Array of successfully decrypted commitments with spent status applied
   */
  public async decryptCommitments (
    commitments: SubsquidCommitment[],
    wallet: RailgunWallet,
    networkName: NetworkName,
    progressCallback?: (progress: number) => void,
    nullifiers?: SubsquidNullifier[]
  ): Promise<DecryptedCommitment[]> {
    const decryptedCommitments: DecryptedCommitment[] = []
    let successCount = 0
    let failureCount = 0

    dlog(`Starting decryption of ${commitments.length} commitments`)

    // Build token-hash index from shield preimages so we can resolve transact token hashes.
    this.buildTokenHashIndexFromShields(commitments)

    for (let i = 0; i < commitments.length; i++) {
      const commitment = commitments[i]
      if (!commitment) continue

      try {
        // Try to decrypt this commitment for our wallet
        const decrypted = await this.tryDecryptCommitment(commitment, wallet)
        if (decrypted) {
          decryptedCommitments.push(decrypted)
          successCount++
        } else {
          // Count failures silently; we'll log a summary at the end.
          failureCount++
        }
      } catch (error) {
        // Silently continue and count failure - not all commitments are for this wallet
        failureCount++
      }

      // Update progress
      if (progressCallback && i % 100 === 0) {
        // Map decryption loop to 0.2–0.4
        const progress = 0.2 + (i / commitments.length) * 0.2
        progressCallback(Math.min(progress, 0.4))
      }
    }

    dlog(`Decryption: ${successCount} succeeded, ${failureCount} failed`)

    const commitmentsWithSpentStatus = await this.detectSpentUTXOs(
      decryptedCommitments,
      commitments,
      wallet,
      networkName,
      nullifiers
    )

    return commitmentsWithSpentStatus
  }

  /**
   * Try to decrypt a single commitment for this wallet.
   * Create scanned DB commitments from raw commitment data.
   *
   *  This method only accepts commitments that can be successfully decrypted
   * using proper cryptographic validation.
   * @param commitment - The raw Subsquid commitment to attempt decryption on
   * @param wallet - The RAILGUN wallet to decrypt for
   * @returns The decrypted commitment if it belongs to this wallet, or null otherwise
   */
  public async tryDecryptCommitment (
    commitment: SubsquidCommitment,
    wallet: RailgunWallet
  ): Promise<DecryptedCommitment | null> {
    try {
      const viewingPrivateKey = ByteUtils.hexStringToBytes(wallet.viewingKey)

      // Handle shield commitments - require encrypted bundle decryption
      if (
        commitment.commitmentType === 'ShieldCommitment' &&
        'shieldKey' in commitment &&
        commitment.shieldKey &&
        'encryptedBundle' in commitment &&
        commitment.encryptedBundle &&
        commitment.encryptedBundle.length > 0
      ) {
        const blindedShieldKey = ByteUtils.hexStringToBytes(commitment.shieldKey)
        const sharedKey = await getSharedSymmetricKey(viewingPrivateKey, blindedShieldKey)

        if (!sharedKey) {
          // Cannot derive shared key - this commitment is not for us
          return null
        }

        try {
          const encryptedBundle = commitment.encryptedBundle

          if (!encryptedBundle || encryptedBundle.length < 2) {
            return null
          }

          // Convert hex strings to bytes for decryption
          // encryptedBundle elements are Uint8Array, ByteUtils.hexlify() converts bytes->hex
          // In privacy-wallet: encryptedBundle elements are hex strings, so we convert hex->bytes->hex
          const bundle0 = encryptedBundle[0]
          const bundle1 = encryptedBundle[1]
          if (!bundle0 || !bundle1) {
            return null
          }
          const bundle0Bytes = ByteUtils.hexStringToBytes(bundle0)
          const bundle1Bytes = ByteUtils.hexStringToBytes(bundle1)
          const hexlified0 = ByteUtils.hexlify(bundle0Bytes)
          const hexlified1 = ByteUtils.hexlify(bundle1Bytes)

          let decrypted: any = null
          try {
            // Decrypt random from shield note
            decrypted = AES.decryptGCM(
              {
                iv: hexlified0.slice(0, 32), // First 16 bytes as hex (32 chars)
                tag: hexlified0.slice(16, 64), // OVERLAPPING: bytes 8-32 (48 hex chars)
                data: [hexlified1.slice(0, 32)], // First 16 bytes of encrypted data
              },
              sharedKey
            )
          } catch {
            // Continue with null decrypted
          }

          // No per-commitment failure logs; overall summary will be logged by caller.
          if (decrypted && decrypted.length > 0) {
            // Ownership check: compute npk = poseidon(mpk, random) and compare with preimage.npk
            const random = ByteUtils.hexlify(decrypted[0])
            if ('preimage' in commitment && commitment.preimage) {
              try {
                // masterPublicKey in our test wallet may be a decimal string. Parse safely.
                const mpkStr = (wallet.masterPublicKey || '').toString()
                const mpk: bigint =
                  mpkStr.startsWith('0x') || mpkStr.startsWith('0X')
                    ? BigInt(mpkStr)
                    : BigInt(mpkStr) // treat as decimal when no 0x prefix
                const computedNpk = SubsquidBalanceScanner.getNotePublicKey(mpk, random)
                const computedNpkHex = ByteUtils.prefix0x(ByteUtils.hexlify(computedNpk))
                const preimageNpk = ByteUtils.prefix0x(commitment.preimage.npk)
                const match = computedNpkHex.toLowerCase() === preimageNpk.toLowerCase()
                // If npk doesn't match, this shield is not ours.
                if (!match) {
                  return null
                }
              } catch (e) {
                // On parse error, do not accept this shield as ours.
                return null
              }
            }
          }

          // If decryption succeeds, extract the random value
          if (
            decrypted &&
            decrypted.length > 0 &&
            'preimage' in commitment &&
            commitment.preimage
          ) {
            // Extract 16-byte random from decrypted shield data
            // For shields, the random is the first 16 bytes of decrypted[0]
            const fullDecrypted = ByteUtils.hexlify(decrypted[0])
            const actualRandom = fullDecrypted.substring(0, 32) // Take first 16 bytes (32 hex chars)

            const preImage = commitment.preimage
            return {
              id: commitment.id,
              hash: commitment.hash,
              txid: commitment.transactionHash || '',
              blockNumber:
                typeof commitment.blockNumber === 'string'
                  ? parseInt(commitment.blockNumber)
                  : commitment.blockNumber,
              treeNumber: commitment.treeNumber,
              batchStartTreePosition:
                typeof commitment.batchStartTreePosition === 'string'
                  ? parseInt(commitment.batchStartTreePosition)
                  : commitment.batchStartTreePosition,
              // Use the actual commitment tree position for nullifier calculation
              position:
                typeof commitment.treePosition === 'string'
                  ? parseInt(commitment.treePosition)
                  : commitment.treePosition,
              commitmentType: commitment.commitmentType,
              tokenAddress: preImage.token.tokenAddress,
              tokenType: SubsquidBalanceScanner.normalizeTokenType(preImage.token.tokenType),
              tokenSubID: preImage.token.tokenSubID,
              value: BigInt(preImage.value),
              npk: preImage.npk,
              isSpent: false,
              timestamp: parseInt(commitment.blockTimestamp || '0'),
              random: '0x' + actualRandom, // Use actual decrypted random (16 bytes = 32 hex chars)
            }
          }
        } catch (error) {
          // Decryption failed - this commitment is not for us
          return null
        }
      }

      // Handle transact commitments - require ciphertext decryption
      if (
        commitment.commitmentType === 'TransactCommitment' &&
        'ciphertext' in commitment &&
        commitment.ciphertext &&
        commitment.ciphertext.ciphertext
      ) {
        const ciphertext = commitment.ciphertext
        const blindedSenderViewingKey = ByteUtils.hexStringToBytes(
          ciphertext.blindedSenderViewingKey
        )
        const blindedReceiverViewingKey = ByteUtils.hexStringToBytes(
          ciphertext.blindedReceiverViewingKey
        )

        // Try both receiver and sender decryption
        // IMPORTANT: Receiver derives shared key with blindedSenderViewingKey.
        const [sharedKeyReceiver, sharedKeySender] = await Promise.all([
          getSharedSymmetricKey(viewingPrivateKey, blindedSenderViewingKey),
          getSharedSymmetricKey(viewingPrivateKey, blindedReceiverViewingKey),
        ])

        // Handle memo: Subsquid may return it as a string or array
        const memoHex = Array.isArray(ciphertext.memo)
          ? ciphertext.memo[0] || '' // Legacy format: array of hex strings
          : ciphertext.memo || '' // V2 format: single hex string

        // Try to decrypt with receiver key first (derived using blindedSenderViewingKey)
        if (sharedKeyReceiver) {
          const decryptedNote = await this.tryDecryptTransactNoteV2(
            ciphertext.ciphertext,
            sharedKeyReceiver,
            false, // isSentNote
            memoHex,
            wallet.masterPublicKey
          )

          if (decryptedNote) {
            // Try to decrypt annotationData to extract outputType.
            // annotationData is encrypted with the SENDER's viewing key.
            // For change outputs (sent to ourselves), we ARE the sender,
            // so we can decrypt it to determine if outputType === Change (2).
            let outputType: number | undefined
            const annotationRaw = ciphertext.annotationData
            if (annotationRaw) {
              try {
                const annotation = decryptNoteAnnotationData(annotationRaw, viewingPrivateKey)
                if (annotation) {
                  outputType = annotation.outputType
                }
              } catch (e) {
                // Decryption failed - not the sender of this commitment
              }
            }

            const isChange = outputType === 2 // OutputType.Change
            const result: DecryptedCommitment = {
              id: commitment.id,
              hash: commitment.hash,
              txid: commitment.transactionHash || '',
              blockNumber:
                typeof commitment.blockNumber === 'string'
                  ? parseInt(commitment.blockNumber)
                  : commitment.blockNumber,
              treeNumber: commitment.treeNumber,
              batchStartTreePosition:
                typeof commitment.batchStartTreePosition === 'string'
                  ? parseInt(commitment.batchStartTreePosition)
                  : commitment.batchStartTreePosition,
              position:
                typeof commitment.treePosition === 'string'
                  ? parseInt(commitment.treePosition)
                  : commitment.treePosition || 0,
              commitmentType: commitment.commitmentType,
              tokenAddress: decryptedNote.tokenAddress,
              tokenType: decryptedNote.tokenType,
              tokenSubID: decryptedNote.tokenSubID,
              value: decryptedNote.value,
              npk: decryptedNote.npk,
              isSpent: false,
              timestamp: parseInt(commitment.blockTimestamp || '0'),
              random: '0x' + decryptedNote.random, // Use actual decrypted random (16 bytes = 32 hex chars)
              isSentNote: isChange, // Change outputs are internal (we are the sender)
              ...(outputType !== undefined ? { outputType } : {}),
              ...(decryptedNote.memoText ? { memoText: decryptedNote.memoText } : {}),
              blindedSenderViewingKey: ciphertext.blindedSenderViewingKey, // Store for sender address reconstruction
            }
            if (decryptedNote.senderMasterPublicKey) {
              result.senderMasterPublicKey = decryptedNote.senderMasterPublicKey // Store sender's MPK if available
            }
            return result
          }
        }

        // Try to decrypt with sender key (derived using blindedReceiverViewingKey)
        // These represent SentCommitments (outputs we created for others or unshields)
        // NOT included in balance (isSentToOther=true) but included for transaction history
        if (sharedKeySender) {
          const senderDecrypted = await this.tryDecryptTransactNoteV2(
            ciphertext.ciphertext,
            sharedKeySender,
            true, // isSentNote
            memoHex,
            wallet.masterPublicKey,
            ciphertext.annotationData,
            viewingPrivateKey
          )
          if (senderDecrypted) {
            // Reconstruct the receiver's 0zk address from the decrypted data
            let receiverAddress: string | undefined
            if (senderDecrypted.receiverMasterPublicKey) {
              const cleanRandom = senderDecrypted.random.startsWith('0x')
                ? senderDecrypted.random.slice(2)
                : senderDecrypted.random
              receiverAddress =
                reconstructReceiverAddress(
                  senderDecrypted.receiverMasterPublicKey,
                  ciphertext.blindedReceiverViewingKey,
                  cleanRandom,
                  senderDecrypted.senderRandom
                ) ?? undefined
            }

            return {
              id: commitment.id,
              hash: commitment.hash,
              txid: commitment.transactionHash || '',
              blockNumber:
                typeof commitment.blockNumber === 'string'
                  ? parseInt(commitment.blockNumber)
                  : commitment.blockNumber,
              treeNumber: commitment.treeNumber,
              batchStartTreePosition:
                typeof commitment.batchStartTreePosition === 'string'
                  ? parseInt(commitment.batchStartTreePosition)
                  : commitment.batchStartTreePosition,
              position:
                typeof commitment.treePosition === 'string'
                  ? parseInt(commitment.treePosition)
                  : commitment.treePosition || 0,
              commitmentType: commitment.commitmentType,
              tokenAddress: senderDecrypted.tokenAddress,
              tokenType: senderDecrypted.tokenType,
              tokenSubID: senderDecrypted.tokenSubID,
              value: senderDecrypted.value,
              npk: senderDecrypted.npk,
              isSpent: false,
              isSentToOther: true, // Excluded from balance, included in transaction history
              timestamp: parseInt(commitment.blockTimestamp || '0'),
              random: '0x' + senderDecrypted.random,
              ...(senderDecrypted.memoText ? { memoText: senderDecrypted.memoText } : {}),
              ...(receiverAddress ? { receiverAddress } : {}),
            }
          }
        }
      }

      // Handle legacy commitment types (LegacyGeneratedCommitment, LegacyEncryptedCommitment)
      // These are from deprecated RAILGUN versions and are not supported
      // Properly rejecting them is the correct production behavior
      if (
        commitment.commitmentType === 'LegacyGeneratedCommitment' ||
        commitment.commitmentType === 'LegacyEncryptedCommitment'
      ) {
        // Legacy commitments cannot be validated without the deprecated deserialization logic
        // Reject them as they're not for the current wallet format
        return null
      }

      // Reject all other unknown commitment types
      // We only accept commitments that can be properly decrypted and validated
      return null
    } catch (error) {
      // Any error during decryption means the commitment is not for us
      return null
    }
  }

  /**
   * Normalize tokenType string/number to numeric enum (ERC20=0, ERC721=1, ERC1155=2).
   * @param t - The token type as a string name or numeric value
   * @returns The normalized numeric token type
   */
  private static normalizeTokenType (t: string | number): number {
    if (typeof t === 'number') return t
    const s = String(t).toUpperCase()
    if (s === 'ERC20') return 0
    if (s === 'ERC721') return 1
    if (s === 'ERC1155') return 2
    const n = Number(t)
    return Number.isFinite(n) ? n : 0
  }

  /**
   * Compute the note public key as poseidon([masterPublicKey, random]).
   * @param masterPublicKey - The master public key as a bigint
   * @param random - The random value as a hex string
   * @returns The computed note public key
   */
  static getNotePublicKey (masterPublicKey: bigint, random: string): bigint {
    return poseidon([masterPublicKey, ByteUtils.hexToBigInt(random)])
  }

  /**
   * Try to decrypt a transact note using shared key.
   * Decrypt TransactNote ciphertext using shared symmetric key.
   * @param ciphertext - The AES-GCM encrypted ciphertext structure
   * @param ciphertext.iv - The initialization vector
   * @param ciphertext.tag - The authentication tag
   * @param ciphertext.data - The encrypted data blocks
   * @param sharedKey - The ECDH-derived shared symmetric key
   * @param isSentNote - Whether this is a sent note (sender-side decryption)
   * @param memoHex - Optional memo hex string appended as the 4th GCM block
   * @param currentWalletMasterPublicKey - Optional MPK of the current wallet for NPK computation
   * @param annotationData - Optional encrypted annotation data containing sender random
   * @param viewingPrivateKey - Optional viewing private key for decrypting annotation data
   * @returns The decrypted pre-image data if successful, or null on failure
   */
  public async tryDecryptTransactNoteV2 (
    ciphertext: { iv: string; tag: string; data: string[] },
    sharedKey: Uint8Array,
    isSentNote: boolean,
    memoHex?: string,
    currentWalletMasterPublicKey?: string,
    annotationData?: string,
    viewingPrivateKey?: Uint8Array
  ): Promise<DecryptedPreImage | null> {
    try {
      // Decrypt using AES-GCM  (include memo as 4th block if present)
      // IMPORTANT: Always appends the memo block, even if empty ("0x").
      // Omitting it breaks the GCM auth tag. Keep the 4th block as empty string when memo is 0x.
      const dataBlocks: string[] = [
        ...ciphertext.data.map((d) => ByteUtils.strip0x(d)),
        ByteUtils.strip0x(memoHex || ''),
      ]
      const decryptedCiphertext = AES.decryptGCM(
        {
          iv: ByteUtils.strip0x(ciphertext.iv),
          tag: ByteUtils.strip0x(ciphertext.tag),
          data: dataBlocks,
        },
        sharedKey
      ).map((value) => ByteUtils.hexlify(value))

      if (decryptedCiphertext.length < 3) {
        return null
      }

      // Parse values like TransactNote.getDecryptedValuesNoteCiphertextV2
      const encodedMPKHex = decryptedCiphertext[0]
      const tokenHashBlock = decryptedCiphertext[1]
      const randomAndValue = decryptedCiphertext[2]
      if (!encodedMPKHex || !tokenHashBlock || !randomAndValue || randomAndValue.length < 64) {
        return null
      }
      // Token hash: 32-byte, 0x-prefixed, lowercase
      const tokenHashHex = ByteUtils.prefix0x(
        ByteUtils.formatToByteLength(tokenHashBlock, 32, false).toLowerCase()
      )
      const random = randomAndValue.substring(0, 32)
      const value = BigInt('0x' + randomAndValue.substring(32, 64))

      // Resolve token info from tokenHash index
      let tokenInfo = this.tokenHashToTokenData.get(tokenHashHex.toLowerCase())
      if (!tokenInfo) {
        // For ERC20 tokens, the tokenHash IS the 32-byte padded address.
        // Extract the address directly from the hash (last 20 bytes = 40 hex chars).
        const stripped = ByteUtils.strip0x(tokenHashHex)
        const leading = stripped.substring(0, stripped.length - 40)
        if (leading === '0'.repeat(leading.length) && stripped.length === 64) {
          const extractedAddress = '0x' + stripped.substring(stripped.length - 40)
          tokenInfo = {
            tokenAddress: extractedAddress.toLowerCase(),
            tokenType: 0, // ERC20
            tokenSubID: '0',
          }
        } else {
          dwarn('TokenHash not found in map:', tokenHashHex)
          return null
        }
      }

      // Decode master public key to get the RECEIVER's actual MPK for NPK computation.
      // Transact note flow:
      //   1. For RECEIVE notes: NPK = poseidon([receiverMPK (our MPK), random])
      //   2. For SENT notes: NPK = poseidon([decodedReceiverMPK, random])
      //      where decodedReceiverMPK = getDecodedMasterPublicKey(senderMPK, encodedMPK, senderRandom)
      //        - If senderRandom is defined && != MEMO_SENDER_RANDOM_NULL: return encodedMPK as-is
      //        - Otherwise: return encodedMPK XOR senderMPK
      const MEMO_SENDER_RANDOM_NULL = '000000000000000000000000000000'
      const encodedMPKBigInt = BigInt('0x' + encodedMPKHex.replace(/^0x/, ''))
      let mpkForNpk: bigint
      let senderRandom: string | undefined // Hoisted for use in result building

      if (!isSentNote && currentWalletMasterPublicKey) {
        // RECEIVE note: use our own MPK (the receiver's MPK)
        mpkForNpk = BigInt(String(currentWalletMasterPublicKey))
      } else if (isSentNote && currentWalletMasterPublicKey) {
        // SENT note: decode the receiver's MPK from encodedMPK
        // First, try to decrypt annotationData to get senderRandom
        if (annotationData && viewingPrivateKey) {
          try {
            const annotation = decryptNoteAnnotationData(annotationData, viewingPrivateKey)
            if (annotation) {
              senderRandom = annotation.senderRandom
            }
          } catch (err) {
            dwarn('Failed to decrypt annotation data for senderRandom:', err)
          }
        }

        // Decode master public key from ciphertext
        if (senderRandom && senderRandom !== MEMO_SENDER_RANDOM_NULL) {
          // Sender chose to hide their address: encodedMPK IS the receiver's MPK (unencoded)
          mpkForNpk = encodedMPKBigInt
        } else {
          // Sender address is visible: encodedMPK = receiverMPK XOR senderMPK
          // Decode: receiverMPK = encodedMPK XOR senderMPK
          const senderMPKBigInt = BigInt(String(currentWalletMasterPublicKey))
          mpkForNpk = encodedMPKBigInt ^ senderMPKBigInt
        }
      } else {
        // Fallback: use encodedMPK directly
        mpkForNpk = encodedMPKBigInt
      }
      const npk = SubsquidBalanceScanner.getNotePublicKey(mpkForNpk, random)

      // Decode sender's MPK from encoded value
      // When sender address is visible: encodedMPK = receiverMPK ^ senderMPK
      // To get senderMPK: senderMPK = encodedMPK ^ receiverMPK
      // When sender address is hidden: encodedMPK = receiverMPK (so XOR gives 0)
      let decodedSenderMPK: string | undefined
      if (!isSentNote && currentWalletMasterPublicKey) {
        try {
          const receiverMPKBigInt = BigInt(String(currentWalletMasterPublicKey))

          // XOR to decode: senderMPK = encodedMPK ^ receiverMPK
          const senderMPKBigInt = encodedMPKBigInt ^ receiverMPKBigInt

          // If result is 0, sender chose to hide their address
          if (senderMPKBigInt !== 0n) {
            decodedSenderMPK = '0x' + senderMPKBigInt.toString(16).padStart(64, '0')
          }
        } catch (err) {
          dwarn('Failed to decode sender MPK:', err)
        }
      }

      // Extract memo from decrypted GCM data[3] (encoded as 30-byte hex)
      const memoHexDecrypted = decryptedCiphertext[3]
      const memoText = memoHexDecrypted ? decodeMemoText(memoHexDecrypted) : undefined

      const result: DecryptedPreImage = {
        tokenAddress: tokenInfo.tokenAddress,
        tokenType: tokenInfo.tokenType,
        tokenSubID: tokenInfo.tokenSubID,
        value,
        npk: ByteUtils.hexlify(npk),
        random, // Return the actual decrypted random (16 bytes as hex string)
        ...(memoText ? { memoText } : {}),
      }
      if (decodedSenderMPK) {
        result.senderMasterPublicKey = decodedSenderMPK // Store decoded sender's MPK
      }
      // For sent notes, store the receiver's MPK and senderRandom for address reconstruction
      if (isSentNote) {
        result.receiverMasterPublicKey = '0x' + mpkForNpk.toString(16).padStart(64, '0')
        if (senderRandom) {
          result.senderRandom = senderRandom
        }
      }
      return result
    } catch (error) {
      // Log the error for debugging sender decryption issues
      dwarn('tryDecryptTransactNoteV2 failed:', error instanceof Error ? error.message : error)
      return null
    }
  }

  /**
   * Calculate token balances grouped by balance bucket (Spendable, Pending, etc.).
   * Balance bucket system for PPOI status tracking.
   * @param decryptedCommitments - The decrypted commitments to calculate balances from
   * @param networkName - The network for PPOI status lookup
   * @param walletAddress - Optional wallet address for checking SentTransactionStorage
   * @returns Array of token balances grouped by token and balance bucket
   */
  public async calculateTokenBalancesWithBuckets (
    decryptedCommitments: DecryptedCommitment[],
    networkName: NetworkName,
    walletAddress?: string // Wallet address for checking SentTransactionStorage
  ): Promise<TokenBalance[]> {
    const poiService = await this.getPoiService()

    // STEP 0: Enrich commitments with isSentNote from SentTransactionStorage
    // This helps identify change outputs from transactions WE sent
    if (walletAddress) {
      const sentStorage = SentTransactionStorage.getInstance()
      const sentOutputs = sentStorage.getSentOutputs(walletAddress)

      // Create a set of transaction hashes that we sent
      const sentTxHashes = new Set(sentOutputs.map((o) => o.transactionHash.toLowerCase()))

      // Mark commitments from our sent transactions
      for (const commitment of decryptedCommitments) {
        if (commitment.txid && sentTxHashes.has(commitment.txid.toLowerCase())) {
          // This commitment is from a transaction WE sent
          // If it's a TransactCommitment and we're the sender, it must be change back to us
          if (commitment.commitmentType === 'TransactCommitment' && !commitment.isSentNote) {
            commitment.isSentNote = true
          }
        }
      }
    }

    // STEP 1: Get PPOI status from cache for all commitments (no network calls)
    //  Use blinded commitment (not raw commitment hash) to look up PPOI status
    // Exclude isSentToOther commitments - they belong to someone else's balance, not ours
    const commitmentData = decryptedCommitments
      .filter((c) => !c.isSpent && !c.isSentToOther)
      .map((c) => ({
        blindedCommitment: this.blindedCommitmentOf(c),
        type: (c.commitmentType === 'ShieldCommitment' ? 'Shield' : 'Transact') as
          | 'Shield'
          | 'Transact'
          | 'Unshield',
      }))

    const poiStatusMap = poiService.getPOIStatusForCommitmentsFromCacheOnly(
      networkName,
      commitmentData
    )

    // STEP 2: Group by token + balance bucket
    const balanceMap = new Map<string, TokenBalance>()

    for (const commitment of decryptedCommitments) {
      // Skip spent commitments and sent-to-other commitments (not our balance)
      if (commitment.isSpent || commitment.isSentToOther) continue

      // Get PPOI status from cache using blinded commitment (not raw hash)
      const blindedCommitment = this.blindedCommitmentOf(commitment)
      const poiStatus = poiStatusMap[blindedCommitment]

      // Determine balance bucket from commitment's PPOI status
      const balanceBucket = poiStatus
        ? poiService.getBalanceBucketForCommitment(commitment, poiStatus)
        : poiService.getBalanceBucketForCommitment(commitment)

      const tokenKey = `${commitment.tokenAddress}-${commitment.tokenType}-${commitment.tokenSubID}-${balanceBucket}`

      if (!balanceMap.has(tokenKey)) {
        balanceMap.set(tokenKey, {
          tokenAddress: commitment.tokenAddress.toLowerCase(),
          symbol: this.getTokenSymbol(commitment.tokenAddress, networkName),
          decimals: this.getTokenDecimals(commitment.tokenAddress, networkName),
          balance: BigInt(0),
          balanceBucket,
        })
      }

      const tokenBalance = balanceMap.get(tokenKey)!
      tokenBalance.balance += commitment.value
    }

    const balances = Array.from(balanceMap.values())
    dlog(
      `Calculated ${balances.length} balance entries across different buckets:`,
      balances.map((b) => `${b.symbol}: ${b.balance.toString()} (${b.balanceBucket})`)
    )

    return balances
  }

  /**
   * Apply PPOI-based balance buckets to existing balances.
   * - Spendable: all contributing unspent commitments have valid PPOI.
   * - ShieldBlocked: at least one contributing commitment has invalid PPOI.
   * - ShieldPending: otherwise (pending/missing or no commitments found).
   * This method makes network requests and should be called explicitly.
   * @param balances - The token balances to apply PPOI buckets to
   * @param wallet - The RAILGUN wallet for commitment decryption
   * @param networkName - The network to check PPOI status on
   * @param opts - Optional configuration
   * @param opts.strict - If true, throw on unresolved PPOI statuses instead of falling back
   * @returns Token balances with updated balance buckets based on PPOI status
   */
  async applyPOIToBalances (
    balances: TokenBalance[],
    wallet: RailgunWallet,
    networkName: NetworkName,
    opts?: { strict?: boolean }
  ): Promise<TokenBalance[]> {
    try {
      // Prefer already-decrypted commitments from cache to avoid re-fetching.
      const decrypted = this.getDecryptedCommitmentsForWallet(wallet.id)

      // Map token -> unspent decrypted commitments (for bucket calc)
      const tokenToCommitments = new Map<string, DecryptedCommitment[]>()
      // Map token -> all decrypted commitments (spent+unspent) for cache hydration/UI
      const tokenToAllCommitments = new Map<string, DecryptedCommitment[]>()
      for (const c of decrypted) {
        if (c.isSentToOther) continue // Not our UTXOs - skip for balance purposes
        const key = c.tokenAddress.toLowerCase()
        if (!tokenToAllCommitments.has(key)) tokenToAllCommitments.set(key, [])
        tokenToAllCommitments.get(key)!.push(c)
        if (!c.isSpent) {
          if (!tokenToCommitments.has(key)) tokenToCommitments.set(key, [])
          tokenToCommitments.get(key)!.push(c)
        }
      }

      // Build id -> { type, hash } map from Subsquid so we send correct values to PPOI
      const { commitments: allCommitments } =
        await this.subsquidFetcher.fetchNewTransactionsAndCommitments(networkName, 0)
      // Build a map for Transact output indexing within each transaction
      this.buildTransactStartIndex(allCommitments as any)
      const idToTypeHash = new Map<
        string,
        { type: 'Shield' | 'Transact' | 'Unshield'; hash: string }
      >()
      for (const c of allCommitments) {
        if (c.commitmentType === 'ShieldCommitment') {
          idToTypeHash.set(c.id, { type: 'Shield', hash: c.hash })
        } else if (c.commitmentType === 'TransactCommitment') {
          idToTypeHash.set(c.id, { type: 'Transact', hash: c.hash })
        }
      }

      // Build a single PPOI request for all tokens to minimize calls
      const allCommitmentDatas: Array<{
        blindedCommitment: string
        type: 'Shield' | 'Transact' | 'Unshield'
      }> = []
      const seen = new Set<string>()
      // Always include all commitments for the tokens present in the balances array
      const tokensRequested = new Set(balances.map((b) => b.tokenAddress.toLowerCase()))
      for (const [token, comms] of tokenToAllCommitments.entries()) {
        if (!tokensRequested.has(token)) continue
        for (const c of comms) {
          const th = idToTypeHash.get(c.id)
          if (!th) continue
          const blinded = this.getBlindedCommitmentForShieldOrTransact(c).toLowerCase()
          if (seen.has(blinded)) continue
          seen.add(blinded)
          allCommitmentDatas.push({ blindedCommitment: blinded, type: th.type })
        }
      }

      // Avoid noisy preflight checks; proceed to request statuses directly.

      // If nothing to check, return balances unchanged
      if (allCommitmentDatas.length === 0) return balances

      const poiStatuses = await (
        await this.getPoiService()
      ).getPOIStatusForCommitments(networkName, allCommitmentDatas)

      // Cache results for UI consumers (normalize keys to 0x + 64 hex lowercase)
      for (const [k, v] of Object.entries(poiStatuses)) {
        this.lastPOIStatuses[ByteUtils.normalizeHex256(k)] = v
      }

      // In strict mode, fail fast if we didn't get definitive statuses.
      if (opts?.strict) {
        const unresolved = Object.entries(poiStatuses).filter(
          ([, s]) => s.status === 'pending' || s.status === 'missing'
        )
        if (unresolved.length > 0 || Object.keys(poiStatuses).length === 0) {
          throw new Error(
            `PPOI unavailable: ${unresolved.length} unresolved statuses (${unresolved
              .slice(0, 3)
              .map(([id, s]) => `${id}:${s.status}`)
              .join(', ')}${unresolved.length > 3 ? '...' : ''})`
          )
        }
      }

      // Determine bucket per token based on PPOI statuses
      const bucketForToken = new Map<string, 'Spendable' | 'ShieldPending' | 'ShieldBlocked'>()
      for (const [tokenLower, comms] of tokenToCommitments.entries()) {
        if (comms.length === 0) {
          bucketForToken.set(tokenLower, 'ShieldPending')
          continue
        }
        let anyInvalid = false
        let validCount = 0

        for (const c of comms) {
          // Look up status by the blindedCommitment we sent
          const key = this.getBlindedCommitmentForShieldOrTransact(c).toLowerCase()
          const norm = `0x${key.replace(/^0x/, '').padStart(64, '0')}`
          const status = poiStatuses[norm]?.status

          if (status === 'invalid') {
            anyInvalid = true
          } else if (status === 'valid') {
            validCount++
          }
        }

        if (anyInvalid) {
          bucketForToken.set(tokenLower, 'ShieldBlocked')
        } else if (validCount === comms.length) {
          // All commitments have explicit 'valid' status
          bucketForToken.set(tokenLower, 'Spendable')
        } else {
          // Some commitments are missing/pending status
          bucketForToken.set(tokenLower, 'ShieldPending')
        }
      }

      // Apply buckets to balances
      return balances.map((b) => {
        const bucket = bucketForToken.get(b.tokenAddress.toLowerCase())
        return bucket ? { ...b, balanceBucket: bucket } : b
      })
    } catch (err) {
      console.error('Error applying PPOI to balances:', err)
      // In strict mode propagate to caller (tests/UI) so they can handle failure.
      if (opts?.strict) throw err
      return balances
    }
  }

  /**
   * Check PPOI status for a specific token (MANUAL - makes network requests).
   * WARNING: This method makes network requests to PPOI nodes.
   * Only call this when explicitly requested by the user.
   * @param tokenAddress - The token contract address to check
   * @param wallet - The RAILGUN wallet to check PPOI for
   * @param networkName - The network to check on
   * @returns The PPOI status for the token, or null if no commitments found
   */
  async checkPOIForToken (
    tokenAddress: string,
    wallet: RailgunWallet,
    networkName: NetworkName
  ): Promise<POIStatus | null> {
    dlog('PPOI: Checking PPOI status for token', tokenAddress)

    try {
      // Get commitments for this specific token
      const commitments = await this.fetchCommitmentsForWallet(wallet, networkName)
      const decryptedCommitments = await this.decryptCommitments(commitments, wallet, networkName)

      // Filter for this specific token
      const tokenCommitments = decryptedCommitments.filter(
        (c) => c.tokenAddress.toLowerCase() === tokenAddress.toLowerCase()
      )

      if (tokenCommitments.length === 0) {
        return null
      }

      // Map ids to types/hashes
      const { commitments: allCommitments } =
        await this.subsquidFetcher.fetchNewTransactionsAndCommitments(networkName, 0)
      this.buildTransactStartIndex(allCommitments as any)
      const idToTypeHash = new Map<
        string,
        { type: 'Shield' | 'Transact' | 'Unshield'; hash: string }
      >()
      for (const c of allCommitments) {
        if (c.commitmentType === 'ShieldCommitment') {
          idToTypeHash.set(c.id, { type: 'Shield', hash: c.hash })
        } else if (c.commitmentType === 'TransactCommitment') {
          idToTypeHash.set(c.id, { type: 'Transact', hash: c.hash })
        }
      }

      // Get blinded commitments for PPOI check with proper type
      const blindedCommitments = tokenCommitments
        .map((c) => {
          const th = idToTypeHash.get(c.id)
          if (!th) return undefined
          return {
            blindedCommitment: this.getBlindedCommitmentForShieldOrTransact(c),
            type: th.type,
          }
        })
        .filter(
          (v): v is { blindedCommitment: string; type: 'Shield' | 'Transact' | 'Unshield' } => !!v
        )

      // Check PPOI status
      const poiStatuses = await (
        await this.getPoiService()
      ).getPOIStatusForCommitments(networkName, blindedCommitments)

      // Return the status of the first commitment (or aggregate if needed)
      const firstCommitment = blindedCommitments[0]
      if (!firstCommitment) {
        return null
      }
      return poiStatuses[firstCommitment.blindedCommitment] || null
    } catch (error) {
      console.error('Error checking PPOI for token:', error)
      return null
    }
  }

  /**
   * Manually refresh PPOI status for all balances (MANUAL - makes network requests).
   * WARNING: This method makes network requests to PPOI nodes.
   * Only call this when explicitly requested by the user.
   * @param wallet - The RAILGUN wallet to refresh PPOI statuses for
   * @param networkName - The network to refresh on
   * @returns Map of blinded commitment hashes to their PPOI statuses
   */
  async refreshAllPOIStatus (
    wallet: RailgunWallet,
    networkName: NetworkName
  ): Promise<Record<string, POIStatus>> {
    dlog('PPOI: Refreshing PPOI status for all wallet commitments')

    try {
      // Prefer already-decrypted commitments from cache to match UI/test enumeration exactly.
      // Fallback to fetching/decrypting if cache is empty.
      let decryptedCommitments = this.getDecryptedCommitmentsForWallet(wallet.id)
      if (!decryptedCommitments || decryptedCommitments.length === 0) {
        const commitments = await this.fetchCommitmentsForWallet(wallet, networkName)
        decryptedCommitments = await this.decryptCommitments(commitments, wallet, networkName)
        // Store results for future calls
        this.storeTXOsForWallet(wallet.id, decryptedCommitments)
      }

      // Map ids to types/hashes
      const { commitments: allCommitments } =
        await this.subsquidFetcher.fetchNewTransactionsAndCommitments(networkName, 0)
      this.buildTransactStartIndex(allCommitments as any)
      const idToTypeHash = new Map<
        string,
        { type: 'Shield' | 'Transact' | 'Unshield'; hash: string }
      >()
      for (const c of allCommitments) {
        if (c.commitmentType === 'ShieldCommitment') {
          idToTypeHash.set(c.id, { type: 'Shield', hash: c.hash })
        } else if (c.commitmentType === 'TransactCommitment') {
          idToTypeHash.set(c.id, { type: 'Transact', hash: c.hash })
        }
      }

      // Get all blinded commitments with proper types
      // Skip isSentToOther - those are someone else's commitments, not ours for PPOI
      const blindedCommitments = decryptedCommitments
        .filter((c) => !c.isSentToOther)
        .map((c) => {
          const th = idToTypeHash.get(c.id)
          if (!th) return undefined
          return {
            blindedCommitment: this.getBlindedCommitmentForShieldOrTransact(c),
            type: th.type,
          }
        })
        .filter(
          (v): v is { blindedCommitment: string; type: 'Shield' | 'Transact' | 'Unshield' } => !!v
        )

      if (blindedCommitments.length === 0) {
        return {}
      }

      // Check PPOI status for all commitments
      const poiStatuses = await (
        await this.getPoiService()
      ).getPOIStatusForCommitments(networkName, blindedCommitments)
      // Update cache
      for (const [k, v] of Object.entries(poiStatuses)) {
        this.lastPOIStatuses[ByteUtils.normalizeHex256(k)] = v
      }

      return poiStatuses
    } catch (error) {
      console.error('Error refreshing PPOI status:', error)
      return {}
    }
  }

  // Helper methods
  /**
   * Resolve the display symbol for a token address.
   * @param tokenAddress - The token contract address
   * @param networkName - The network the token is on
   * @returns The token symbol string (e.g., 'ETH', 'USDC', or 'TOKEN' as fallback)
   */
  public getTokenSymbol (tokenAddress: string, networkName: NetworkName): string {
    const lowerAddress = tokenAddress.toLowerCase()
    if (lowerAddress === '0x0000000000000000000000000000000000000000') return 'ETH'
    if (lowerAddress.includes('a0b86a33e6417c5a0f8fdd4cdbde5cfeedbd5456')) return 'USDC'
    if (lowerAddress.includes('dac17f958d2ee523a2206206994597c13d831ec7')) return 'USDT'
    if (lowerAddress === '0xfff9976782d46cc05630d1f6ebab18b2324d6b14') return 'WETH'

    // Check TokenService for custom/known tokens
    const symbol = TokenService.getInstance().getTokenSymbol(tokenAddress, networkName)
    if (symbol !== 'UNKNOWN') return symbol

    return 'TOKEN'
  }

  /**
   * Resolve the decimal precision for a token address.
   * @param tokenAddress - The token contract address
   * @param networkName - The network the token is on
   * @returns The number of decimal places for the token (defaults to 18)
   */
  public getTokenDecimals (tokenAddress: string, networkName: NetworkName): number {
    const lowerAddress = tokenAddress.toLowerCase()
    if (lowerAddress === '0x0000000000000000000000000000000000000000') return 18
    if (lowerAddress.includes('a0b86a33e6417c5a0f8fdd4cdbde5cfeedbd5456')) return 6
    if (lowerAddress.includes('dac17f958d2ee523a2206206994597c13d831ec7')) return 6
    if (lowerAddress === '0xfff9976782d46cc05630d1f6ebab18b2324d6b14') return 18

    // Check TokenService for custom/known tokens
    const tokenService = TokenService.getInstance()
    const tokenSymbol = tokenService.getTokenSymbol(tokenAddress, networkName)
    if (tokenSymbol !== 'UNKNOWN') {
      // Found in TokenService - get full info for decimals
      const customTokens = tokenService.getCustomTokens(networkName)
      const match = customTokens.find((t) => t.address === lowerAddress)
      if (match) return match.decimals
    }

    return 18
  }

  /**
   * Detect spent UTXOs by checking nullifiers in later transactions.
   * @param decryptedCommitments - The decrypted commitments to check spent status for
   * @param _allCommitments - All raw commitments (unused, kept for API compatibility)
   * @param wallet - The RAILGUN wallet for nullifier calculation
   * @param networkName - The network to fetch nullifiers from
   * @param preloadedNullifiers - Optional pre-fetched nullifiers to avoid redundant fetches
   * @returns Commitments with updated isSpent flags
   */
  public async detectSpentUTXOs (
    decryptedCommitments: DecryptedCommitment[],
    _allCommitments: SubsquidCommitment[],
    wallet: RailgunWallet,
    networkName: NetworkName,
    preloadedNullifiers?: SubsquidNullifier[]
  ): Promise<DecryptedCommitment[]> {
    dlog(`Checking ${decryptedCommitments.length} UTXOs for spent status`)

    try {
      // Use pre-fetched nullifiers if available, otherwise fetch incrementally
      const spentNullifiers =
        preloadedNullifiers ?? (await this.fetchNullifiersIncremental(networkName))
      const spentNullifierSet = new Set(
        spentNullifiers.map((n: any) => ByteUtils.normalizeHex256(n.nullifier))
      )

      dlog(`Found ${spentNullifiers.length} nullifier events`)

      const updatedCommitments = await Promise.all(
        decryptedCommitments.map(async (commitment) => {
          // Calculate the nullifier for this commitment
          const nullifier = await this.calculateNullifier(commitment, wallet)
          const isSpent = spentNullifierSet.has(nullifier)
          return {
            ...commitment,
            isSpent,
          }
        })
      )

      const spentCount = updatedCommitments.filter((c) => c.isSpent).length
      const unspentCount = updatedCommitments.filter((c) => !c.isSpent).length
      dlog(`Spent=${spentCount}, Unspent=${unspentCount}`)

      return updatedCommitments
    } catch (error) {
      console.error('Error detecting spent UTXOs:', error)
      // Fallback: mark all as unspent
      return decryptedCommitments.map((commitment) => ({
        ...commitment,
        isSpent: false,
      }))
    }
  }

  /**
   * Calculate the nullifier hash for a commitment using poseidon([nullifyingKey, position]).
   * @param commitment - The decrypted commitment to calculate the nullifier for
   * @param wallet - The RAILGUN wallet providing the viewing key for nullifier derivation
   * @returns The nullifier as a 0x-prefixed 32-byte hex string
   */
  public async calculateNullifier (
    commitment: DecryptedCommitment,
    wallet: RailgunWallet
  ): Promise<string> {
    // Calculate nullifier: poseidon([nullifyingKey, noteHash])
    // The nullifyingKey is derived from the public key for this commitment
    // The noteHash is the commitment hash itself

    try {
      // Get the nullifying key for this commitment
      const nullifyingKey = await this.deriveNullifyingKey(commitment, wallet)

      // Calculate poseidon hash of [nullifyingKey, leafIndex (tree position)]
      const nullifier = poseidon([nullifyingKey, BigInt(commitment.position)])

      return `0x${nullifier.toString(16).padStart(64, '0')}`
    } catch (error) {
      console.error(`Error calculating nullifier for commitment ${commitment.id}:`, error)
      // Return a default value that won't match any real nullifier
      return '0x0000000000000000000000000000000000000000000000000000000000000000'
    }
  }

  /**
   * Derive the nullifying key from the wallet's viewing private key using poseidon hash.
   * @param commitment - The commitment (used for error reporting only)
   * @param wallet - The RAILGUN wallet providing the viewing key
   * @returns The nullifying key as a bigint
   */
  public async deriveNullifyingKey (
    commitment: DecryptedCommitment,
    wallet: RailgunWallet
  ): Promise<bigint> {
    try {
      // nullifyingKey = poseidon([viewingPrivateKey]) - matches AbstractWallet.getNullifyingKey()
      const vpkBytes = ByteUtils.hexStringToBytes(wallet.viewingKey)
      const vpkHex = ByteUtils.fastBytesToHex(vpkBytes)
      return poseidon([BigInt('0x' + vpkHex)])
    } catch (error) {
      console.error(`Error deriving nullifying key for commitment ${commitment.id}:`, error)
      // Return a default value
      return BigInt(0)
    }
  }

  /**
   * Get outgoing transactions where this wallet spent UTXOs.
   * This tracks transactions where the wallet was the sender by matching
   * nullifiers to the wallet's owned commitments.
   * @param wallet - The RAILGUN wallet to find outgoing transactions for
   * @param networkName - The network to search on
   * @param preloadedNullifiers - Optional pre-fetched nullifiers to avoid redundant fetches
   * @returns Array of outgoing transactions with their spent commitments
   */
  public async getOutgoingTransactions (
    wallet: RailgunWallet,
    networkName: NetworkName,
    preloadedNullifiers?: SubsquidNullifier[]
  ): Promise<OutgoingTransaction[]> {
    try {
      dlog(`Getting outgoing transactions for wallet ${wallet.id}`)

      // 1. Get all UTXOs owned by this wallet
      const myCommitments = this.getDecryptedCommitmentsForWallet(wallet.id)
      dlog(`Wallet has ${myCommitments.length} total commitments`)

      if (myCommitments.length === 0) {
        return []
      }

      // 2. Calculate nullifiers for each commitment and create a map
      // Skip isSentToOther commitments - we can't spend someone else's UTXOs
      const nullifierToCommitmentMap = new Map<string, DecryptedCommitment>()

      for (const commitment of myCommitments) {
        if (commitment.isSentToOther) continue
        try {
          const nullifier = await this.calculateNullifier(commitment, wallet)
          const normalizedNullifier = ByteUtils.normalizeHex256(nullifier)
          nullifierToCommitmentMap.set(normalizedNullifier, commitment)
        } catch (error) {
          dlog(`Failed to calculate nullifier for commitment ${commitment.id}: ${error}`)
        }
      }

      dlog(`Calculated ${nullifierToCommitmentMap.size} nullifiers`)

      // 3. Use pre-fetched nullifiers or fetch incrementally from cache
      const nullifierEvents =
        preloadedNullifiers ?? (await this.fetchNullifiersIncremental(networkName))
      dlog(`Using ${nullifierEvents.length} nullifier events`)

      // 4. Match spent nullifiers to our commitments
      const transactionMap = new Map<string, OutgoingTransaction>()

      for (const nullifierEvent of nullifierEvents) {
        const normalizedEventNullifier = ByteUtils.normalizeHex256(nullifierEvent.nullifier)
        const matchedCommitment = nullifierToCommitmentMap.get(normalizedEventNullifier)

        if (matchedCommitment) {
          // This nullifier corresponds to one of our commitments being spent
          const txid = nullifierEvent.transactionHash

          if (!transactionMap.has(txid)) {
            transactionMap.set(txid, {
              txid,
              blockNumber: parseInt(nullifierEvent.blockNumber as any),
              timestamp: parseInt(nullifierEvent.blockTimestamp as any),
              spentCommitments: [],
            })
          }

          // Create a copy of the commitment with isSpent=true to mark it as an input
          const spentCommitment: DecryptedCommitment = {
            ...matchedCommitment,
            isSpent: true,
          }

          transactionMap.get(txid)!.spentCommitments.push(spentCommitment)
        }
      }

      const outgoingTxs = Array.from(transactionMap.values())
      dlog(`Found ${outgoingTxs.length} outgoing transactions`)

      return outgoingTxs
    } catch (error) {
      console.error('Error getting outgoing transactions:', error)
      return []
    }
  }

  /**
   * Build the tokenHash-to-tokenData index from shield commitment preimages.
   * @param commitments - Array of Subsquid commitments to index shield token data from
   */
  public buildTokenHashIndexFromShields (commitments: SubsquidCommitment[]): void {
    const added: string[] = []
    for (const c of commitments) {
      if (c.commitmentType === 'ShieldCommitment' && 'preimage' in c && c.preimage) {
        const token = c.preimage.token
        try {
          const normalizedType = SubsquidBalanceScanner.normalizeTokenType(token.tokenType)
          const tokenHashBig = getTokenDataHash({
            tokenType: normalizedType,
            tokenAddress: token.tokenAddress,
            tokenSubID: token.tokenSubID,
          })
          const tokenHashHex = ByteUtils.formatToByteLength(tokenHashBig, 32, true).toLowerCase()
          if (!this.tokenHashToTokenData.has(tokenHashHex)) {
            this.tokenHashToTokenData.set(tokenHashHex, {
              tokenAddress: token.tokenAddress,
              tokenType: normalizedType,
              tokenSubID: token.tokenSubID,
            })
            added.push(tokenHashHex)
          }
        } catch {}
      }
    }
    if (added.length) dlog(`Indexed ${added.length} token hashes from shields`)
  }

  // Build txid -> first treePosition in that transaction (Transact commitments only)
  /**
   * Build the txid-to-first-treePosition index for Transact commitments.
   * @param allCommitments - Array of commitments with type, transaction hash, and position
   */
  public buildTransactStartIndex (
    allCommitments: Array<{
      commitmentType: string
      transactionHash?: string
      treePosition: number
    }>
  ): void {
    this.txidToTransactStartPos.clear()
    for (const c of allCommitments) {
      if (c.commitmentType !== 'TransactCommitment') continue
      const txid = String(c.transactionHash || '')
      if (!txid) continue
      const prev = this.txidToTransactStartPos.get(txid)
      if (prev == null || c.treePosition < prev) {
        this.txidToTransactStartPos.set(txid, c.treePosition)
      }
    }
  }

  /**
   * Compute the blinded commitment for an unshield commitment using the railgunTxid.
   * @param c - The decrypted unshield commitment
   * @returns The blinded commitment as a lowercase 0x-prefixed hex string
   */
  private getBlindedCommitmentForUnshield (c: DecryptedCommitment): string {
    try {
      // For unshield commitments, the blinded commitment is simply the railgunTxid
      // formatted to 32 bytes (UINT_256) with 0x prefix
      const railgunTxid = c.txid
      if (!railgunTxid) {
        console.error('Unshield commitment missing railgunTxid', c)
        throw new Error('Unshield commitment missing railgunTxid')
      }

      // Format to 32 bytes with 0x prefix
      const blinded = ByteUtils.formatToByteLength(railgunTxid, 32, true)

      return blinded.toLowerCase()
    } catch (err) {
      console.error('Error computing unshield blinded commitment:', err)
      // Fallback to txid if available
      return ByteUtils.prefix0x(String(c.txid).toLowerCase())
    }
  }

  /**
   * Compute the blinded commitment for a shield or transact commitment using poseidon hash.
   * @param c - The decrypted shield or transact commitment
   * @returns The blinded commitment as a lowercase 0x-prefixed hex string
   */
  private getBlindedCommitmentForShieldOrTransact (c: DecryptedCommitment): string {
    try {
      // Normalize commitment hash to a 32-byte 0x-hex string before hashing.
      // Subsquid may return decimal field element or 0x-hex.
      const commitmentHashHex = (() => {
        const h = String(c.hash).trim()
        if (h.startsWith('0x') || h.startsWith('0X')) {
          // Ensure 32-byte padding
          return ByteUtils.formatToByteLength(h, 32, true)
        }
        // Decimal string -> 32-byte hex
        return ByteUtils.nToHex(BigInt(h), 32, true)
      })()
      const commitmentHashBig = ByteUtils.hexToBigInt(commitmentHashHex)
      const npkBig = ByteUtils.hexToBigInt(c.npk)
      // IMPORTANT: For receive-side TXOs (both Shield and Transact), we compute
      // blinded commitments with the ACTUAL global UTXO position (tree, position).
      // The pre-transaction constants are only used during proof generation for sent txs.
      const globalTreePos =
        BigInt(c.treeNumber) * BigInt(SubsquidBalanceScanner.TREE_MAX_ITEMS) + BigInt(c.position)
      const blinded = poseidon([commitmentHashBig, npkBig, globalTreePos])
      return ByteUtils.prefix0x(ByteUtils.nToHex(blinded, 32, true)).toLowerCase()
    } catch {
      // Fallback to commitment hash if calculation fails
      return ByteUtils.prefix0x(String(c.hash).toLowerCase())
    }
  }

  // Public helper for UI/services to compute blinded commitment consistently
  /**
   * Compute the blinded commitment for any commitment type (Shield, Transact, or Unshield).
   * @param c - The decrypted commitment to compute the blinded commitment for
   * @returns The blinded commitment as a lowercase 0x-prefixed hex string
   */
  public blindedCommitmentOf (c: DecryptedCommitment): string {
    //  Unshield commitments use a different blinded commitment calculation
    // Unshield: formatToByteLength(railgunTxid, UINT_256, true)
    // Shield/Transact: poseidon([commitmentHash, npk, globalTreePosition])
    if (c.commitmentType === 'UnshieldCommitment') {
      return this.getBlindedCommitmentForUnshield(c)
    }
    return this.getBlindedCommitmentForShieldOrTransact(c)
  }

  /**
   * Fetch ALL commitments (not just decrypted ones) for a specific tree from Subsquid.
   * This is needed to populate the merkle tree for proof generation.
   * @param treeNumber - The merkle tree number to fetch commitments for
   * @param chainId - The chain ID of the network
   * @param maxBlockNumber - Optional upper bound block number to filter by
   * @returns Array of commitment hashes with their positions and block numbers
   */
  public async fetchAllCommitmentsForTree (
    treeNumber: number,
    chainId: number,
    maxBlockNumber?: number
  ): Promise<Array<{ hash: string; position: number; blockNumber: number }>> {
    // Do not allow for hardhat
    if (chainId === 31337) {
      dwarn('Skipping Subsquid on hardhat network')
      return []
    }

    try {
      // Determine network from chainId
      const networkName = chainId === 11155111 ? 'EthereumSepolia' : 'EthereumSepolia' // Default fallback

      const network = NETWORK_CONFIG[networkName as NetworkName]
      if (!network?.subsquidUrl) {
        throw new Error(`No Subsquid URL configured for network ${networkName}`)
      }

      dlog(`Fetching ALL commitments for tree ${treeNumber} from Subsquid (${networkName})`)

      // Fetch commitments from Subsquid GraphQL
      //  Include ALL commitment types that go into the merkle tree:
      // - ShieldCommitment: From Shield transactions
      // - TransactCommitment: Output commitments from private transfers
      // - LegacyGeneratedCommitment: From older RAILGUN versions
      // We must include Transact commitments because they are part of the on-chain merkle tree!
      const whereClause = maxBlockNumber
        ? `{ treeNumber_eq: ${treeNumber}, blockNumber_lte: "${maxBlockNumber}", commitmentType_in: [ShieldCommitment, TransactCommitment, LegacyGeneratedCommitment] }`
        : `{ treeNumber_eq: ${treeNumber}, commitmentType_in: [ShieldCommitment, TransactCommitment, LegacyGeneratedCommitment] }`

      const query = `
        query GetAllCommitmentsForTree {
          commitments(
            where: ${whereClause}
            orderBy: [treePosition_ASC]
            limit: 100000
          ) {
            id
            hash
            blockNumber
            treeNumber
            treePosition
            commitmentType
          }
        }
      `

      const response = await fetch(network.subsquidUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })

      const result = await response.json()

      // Check for GraphQL errors FIRST (before checking response.ok)
      if (result.errors) {
        console.error('Subsquid GraphQL errors:', JSON.stringify(result.errors, null, 2))
        throw new Error(`Subsquid GraphQL error: ${JSON.stringify(result.errors)}`)
      }

      if (!response.ok) {
        console.error('Subsquid HTTP error:', response.status, response.statusText)
        console.error('Response body:', result)
        throw new Error(`Subsquid request failed: ${response.statusText}`)
      }

      const commitments = result.data?.commitments || []

      return commitments.map((c: any) => ({
        hash: c.hash,
        position: parseInt(c.treePosition), // Use treePosition from Subsquid schema
        blockNumber: parseInt(c.blockNumber),
      }))
    } catch (error) {
      console.error('Failed to fetch commitments from Subsquid:', error)
      return []
    }
  }
}

// DecryptedCommitment type is defined in @/types/wallet

interface DecryptedPreImage {
  tokenAddress: string
  tokenType: number
  tokenSubID: string
  value: bigint
  npk: string
  random: string
  senderMasterPublicKey?: string // Sender's MPK from encrypted note (for received notes)
  receiverMasterPublicKey?: string // Receiver's MPK decoded from encrypted note (for sent notes)
  senderRandom?: string // Sender random from annotation data (needed for receiver address reconstruction)
  memoText?: string // Decrypted memo from GCM ciphertext data[3]
}

/**
 * Represents an outgoing transaction where the wallet spent UTXOs
 */
interface OutgoingTransaction {
  txid: string
  blockNumber: number
  timestamp: number
  spentCommitments: DecryptedCommitment[]
}

export type { OutgoingTransaction }
export { SubsquidBalanceScanner }
