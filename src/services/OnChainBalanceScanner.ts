import { poseidon } from '@railgun-community/circomlibjs'
import { ethers } from 'ethers'

import { TokenService } from './TokenService'

import RailgunSmartWalletABI from '@/core/abis/RailgunSmartWallet.json'
import type { NetworkName } from '@/types/network'
import { NETWORK_CONFIG } from '@/types/network'
import type { RailgunWallet, TokenBalance } from '@/types/wallet'
import { AES } from '@/utils/aes'
import { ByteUtils } from '@/utils/crypto'
import { dlog as _debugLog } from '@/utils/debug'
import { poseidon as poseidonUtil } from '@/utils/poseidon'
import { getSharedSymmetricKey } from '@/utils/railgun-crypto'

/**
 * Logs a debug message with the OnChainBalanceScanner prefix.
 * @param msg - The message to log
 * @param args - Additional arguments to pass to the debug logger
 * @returns The result of the underlying debug log call
 */
const dlog = (msg: string, ...args: any[]) => _debugLog(`[OnChainBalanceScanner] ${msg}`, ...args)

/**
 * On-Chain Balance Scanner Service
 *
 * Fetches commitments directly from RAILGUN contract events on-chain
 * Similar to BalanceScanner but works without Subsquid dependency
 * Perfect for local Hardhat testing and development
 */
class OnChainBalanceScanner {
  /** Singleton instance of OnChainBalanceScanner. */
  private static instance: OnChainBalanceScanner
  /** Map of wallet ID to its decrypted commitments. */
  private decryptedCommitments: Map<string, OnChainDecryptedCommitment[]> = new Map()

  /**
   * Returns the singleton instance, creating it if necessary.
   * @returns The OnChainBalanceScanner singleton
   */
  static getInstance (): OnChainBalanceScanner {
    if (!this.instance) {
      this.instance = new OnChainBalanceScanner()
    }
    return this.instance
  }

  /**
   * Scan balances directly from on-chain RAILGUN contract events
   * @param wallet - Wallet to scan for
   * @param networkName - Network to scan on
   * @param progressCallback - Optional progress callback
   * @param options - Scan options (must include provider for OnChain scanner)
   * @param options.provider - The ethers provider used to query the chain
   * @returns Array of token balances found for the wallet
   */
  async scanBalances (
    wallet: RailgunWallet,
    networkName: NetworkName,
    progressCallback?: (progress: number) => void,
    options?: { provider?: ethers.Provider }
  ): Promise<TokenBalance[]> {
    // Extract provider from options or throw error
    const provider = options?.provider
    if (!provider) {
      throw new Error('OnChainBalanceScanner requires a provider in options.provider')
    }
    try {
      dlog(`Starting on-chain balance scan for wallet ${wallet.id}`)
      if (progressCallback) progressCallback(0)

      // 1. Fetch commitment events from RAILGUN contract
      const commitments = await this.fetchCommitmentEvents(networkName, provider)
      dlog(`Fetched ${commitments.length} commitment events from contract`)

      if (progressCallback) progressCallback(0.3)

      // 2. Try to decrypt commitments for this wallet
      const decryptedCommitments = await this.decryptCommitmentsForWallet(
        commitments,
        wallet,
        progressCallback
      )
      dlog(`Decrypted ${decryptedCommitments.length} commitments for wallet`)

      if (progressCallback) progressCallback(0.5)

      // 2.5. Detect spent commitments by checking nullifier events
      const decryptedCommitmentsWithSpentStatus = await this.detectSpentCommitments(
        decryptedCommitments,
        wallet,
        networkName,
        provider
      )
      dlog(`Detected spent status for ${decryptedCommitmentsWithSpentStatus.length} commitments`)

      // Store decrypted commitments for this wallet
      this.decryptedCommitments.set(wallet.id, decryptedCommitmentsWithSpentStatus)

      if (progressCallback) progressCallback(0.7)

      // 3. Calculate token balances - must use commitments with spent status!
      const balances = this.calculateTokenBalances(decryptedCommitmentsWithSpentStatus, networkName)
      dlog(`Calculated ${balances.length} token balances`)

      if (progressCallback) progressCallback(1.0)

      return balances
    } catch (error) {
      console.error('Error in on-chain balance scan:', error)
      throw error
    }
  }

  /**
   * Get decrypted commitments for a specific wallet
   * @param walletId - The unique identifier of the wallet
   * @returns Array of decrypted commitments belonging to the wallet
   */
  getDecryptedCommitmentsForWallet (walletId: string): OnChainDecryptedCommitment[] {
    return this.decryptedCommitments.get(walletId) || []
  }

  /**
   * Clear stored commitments for a wallet
   * @param walletId - The unique identifier of the wallet whose commitments should be cleared
   */
  clearStoredTXOs (walletId: string): void {
    this.decryptedCommitments.delete(walletId)
    dlog(`Cleared stored commitments for wallet ${walletId}`)
  }

  /**
   * Helper function to chunk large block ranges into smaller segments
   * RPC providers typically limit eth_getLogs to 50,000 blocks per call
   * @param provider - The ethers provider to query logs from
   * @param filter - Log filter parameters
   * @param filter.address - Contract address to filter events from
   * @param filter.topics - Optional event topic filters
   * @param filter.fromBlock - Starting block number
   * @param filter.toBlock - Ending block number
   * @param chunkSize - Maximum number of blocks per RPC request
   * @returns All matching logs across the entire block range
   */
  private async fetchLogsInChunks (
    provider: ethers.Provider,
    filter: {
      address: string
      topics?: string[]
      fromBlock: number
      toBlock: number
    },
    chunkSize: number = 50000
  ): Promise<ethers.Log[]> {
    const { fromBlock, toBlock, ...restFilter } = filter
    const allLogs: ethers.Log[] = []

    // Calculate number of chunks needed
    const totalBlocks = toBlock - fromBlock + 1
    const numChunks = Math.ceil(totalBlocks / chunkSize)

    dlog(
      `Fetching logs in ${numChunks} chunks of up to ${chunkSize} blocks each (total: ${totalBlocks} blocks)`
    )

    // Fetch logs for each chunk
    for (let i = 0; i < numChunks; i++) {
      const chunkFromBlock = fromBlock + i * chunkSize
      const chunkToBlock = Math.min(chunkFromBlock + chunkSize - 1, toBlock)

      dlog(`Fetching chunk ${i + 1}/${numChunks}: blocks ${chunkFromBlock} to ${chunkToBlock}`)

      const chunkLogs = await provider.getLogs({
        ...restFilter,
        fromBlock: chunkFromBlock,
        toBlock: chunkToBlock,
      })

      allLogs.push(...chunkLogs)
      dlog(
        `Chunk ${i + 1}/${numChunks} returned ${chunkLogs.length} logs (total so far: ${allLogs.length})`
      )
    }

    return allLogs
  }

  /**
   * Fetch commitment events directly from RAILGUN contract
   * @param networkName - The network to query commitment events from
   * @param provider - The ethers provider for RPC calls
   * @returns Array of parsed on-chain commitment events (Shield and Transact)
   */
  private async fetchCommitmentEvents (
    networkName: NetworkName,
    provider: ethers.Provider
  ): Promise<OnChainCommitment[]> {
    const networkConfig = NETWORK_CONFIG[networkName]
    if (!networkConfig) {
      throw new Error(`Network configuration not found for ${networkName}`)
    }

    const railgunABI = RailgunSmartWalletABI

    dlog(`Using RAILGUN ABI with ${railgunABI.length} entries`)

    const commitmentEvents: OnChainCommitment[] = []

    try {
      // Get deployment block (use network-specific deployment block like BalanceScanner)
      const currentBlock = await provider.getBlockNumber()
      const fromBlock = networkConfig.deploymentBlock // Use deployment block from network config

      dlog(`Fetching commitment events from block ${fromBlock} to ${currentBlock}`)

      // Get ALL logs from the RAILGUN contract to see what's actually being emitted
      // Use chunking to handle large block ranges (RPC providers limit to ~50k blocks)
      const allLogs = await this.fetchLogsInChunks(provider, {
        address: networkConfig.railgunV2Contract,
        fromBlock,
        toBlock: currentBlock,
      })

      dlog(`Found ${allLogs.length} total logs from RAILGUN contract`)

      if (allLogs.length > 0) {
        const contractInterface = new ethers.Interface(railgunABI)

        let shieldCount = 0
        let transactCount = 0
        let otherCount = 0

        for (const log of allLogs) {
          try {
            const parsedLog = contractInterface.parseLog(log)
            if (!parsedLog) {
              otherCount++
              continue
            }

            if (parsedLog.name === 'Shield') {
              shieldCount++
              // Extract Shield event args: [treeNumber, startPosition, commitments[], shieldCiphertext[], fees[]]
              const args = parsedLog.args
              if (args && args.length >= 4) {
                const [treeNumber, startPosition, shieldCommitments, shieldCiphertext] = args

                // Convert ethers Result arrays to regular arrays
                const commitmentsArray = Array.from(shieldCommitments as any[])
                const ciphertextArray = Array.from(shieldCiphertext as any[])

                // Process each commitment in the shield batch
                for (let i = 0; i < commitmentsArray.length; i++) {
                  const commitment = commitmentsArray[i] as any[]
                  const ciphertext = ciphertextArray[i] as any[]

                  // Extract commitment data: [commitmentHash, tokenData, value]
                  if (commitment && commitment.length >= 3) {
                    const [commitmentHash, tokenData, value] = commitment

                    // Convert tokenData to array and extract token address
                    const tokenDataArray = Array.from(tokenData as any[])
                    let tokenAddress = '0x0'
                    if (tokenDataArray && tokenDataArray.length > 1) {
                      tokenAddress = (tokenDataArray[1] as string) || '0x0' // tokenData[1] is the token address
                    }

                    // Extract ciphertext data: [encryptedBundle[3], shieldKey]
                    let encryptedBundle: [string, string, string] | null = null
                    let shieldKey: string | null = null
                    if (ciphertext && ciphertext.length >= 2) {
                      const [bundleData, shieldKeyData] = ciphertext
                      if (bundleData && Array.from(bundleData as any[]).length >= 3) {
                        const bundleArray = Array.from(bundleData as any[])
                        encryptedBundle = [
                          bundleArray[0] as string,
                          bundleArray[1] as string,
                          bundleArray[2] as string,
                        ]
                      }
                      shieldKey = shieldKeyData as string
                    }

                    // Use the commitment hash directly from the Shield event (first element of commitment)
                    const finalCommitmentHash = (commitmentHash as any).toString()

                    commitmentEvents.push({
                      id: `shield-${log.transactionHash}-${i}`,
                      hash: finalCommitmentHash, // Use commitment hash directly from Shield event
                      txid: log.transactionHash || '',
                      blockNumber: log.blockNumber || 0,
                      treeNumber: Number(treeNumber),
                      batchStartTreePosition: Number(startPosition),
                      position: i + Number(startPosition), // Position in merkle tree
                      commitmentType: 'Shield',
                      ciphertext: log.data, // Raw data as ciphertext - keep for compatibility
                      timestamp: 0, // Will be filled later if needed
                      // Shield-specific fields extracted from event
                      npk: finalCommitmentHash, // In Shield events, the first element is the commitment hash
                      value: (value as any).toString(),
                      tokenAddress,
                      // Shield encryption data for decryption
                      encryptedBundle,
                      shieldKey,
                    })
                  }
                }
              }
            } else if (parsedLog.name === 'Transact') {
              transactCount++
              // Extract Transact event args: [treeNumber, startPosition, hash[], ciphertext[]]
              // The Transact event emits arrays of commitment hashes and their corresponding ciphertexts
              const args = parsedLog.args
              if (args && args.length >= 4) {
                const [treeNumber, startPosition, hashes, ciphertexts] = args

                // Convert to regular arrays
                const hashesArray = Array.from(hashes as any[])
                const ciphertextsArray = Array.from(ciphertexts as any[])

                // Each hash corresponds to a ciphertext at the same index
                for (let i = 0; i < hashesArray.length; i++) {
                  const commitmentHash = (hashesArray[i] as any).toString()
                  const ciphertext = ciphertextsArray[i]

                  // Extract ciphertext components: { ciphertext: bytes32[4], blindedSenderViewingKey, blindedReceiverViewingKey, annotationData, memo }
                  let transactCiphertext: OnChainTransactCiphertext | null = null
                  if (ciphertext) {
                    try {
                      // Extract the ciphertext struct fields
                      const ciphertextData = Array.from(ciphertext[0] as any[]) // bytes32[4] ciphertext array
                      const blindedSenderKey = (ciphertext[1] as any)?.toString()
                      const blindedReceiverKey = (ciphertext[2] as any)?.toString()
                      const annotationData = (ciphertext[3] as any)?.toString() || '0x'
                      const memo = (ciphertext[4] as any)?.toString() || '0x'

                      // Parse ciphertext array as IV (16 bytes), Tag (16 bytes), Data blocks
                      // ciphertext[0] = IV (first 16 bytes) + Tag (last 16 bytes) = 32 bytes
                      // ciphertext[1-3] = Data blocks (48 bytes total)
                      if (ciphertextData.length >= 4) {
                        const block0 = ciphertextData[0].toString()
                        const block1 = ciphertextData[1].toString()
                        const block2 = ciphertextData[2].toString()
                        const block3 = ciphertextData[3].toString()

                        // Extract IV and Tag from first block
                        const block0Hex = block0.startsWith('0x') ? block0.slice(2) : block0
                        const iv = '0x' + block0Hex.slice(0, 32) // First 16 bytes
                        const tag = '0x' + block0Hex.slice(32, 64) // Last 16 bytes

                        transactCiphertext = {
                          iv,
                          tag,
                          data: [block1, block2, block3], // Remaining data blocks
                          blindedSenderViewingKey: blindedSenderKey,
                          blindedReceiverViewingKey: blindedReceiverKey,
                          annotationData,
                          memo,
                        }
                      }
                    } catch (e) {
                      dlog(`Failed to parse transact ciphertext: ${e}`)
                    }
                  }

                  commitmentEvents.push({
                    id: `transact-${log.transactionHash}-${i}`,
                    hash: commitmentHash,
                    txid: log.transactionHash || '',
                    blockNumber: log.blockNumber || 0,
                    treeNumber: Number(treeNumber),
                    batchStartTreePosition: Number(startPosition),
                    position: i + Number(startPosition), // Position in merkle tree
                    commitmentType: 'Transact',
                    ciphertext: log.data, // Keep raw data for compatibility
                    timestamp: 0,
                    npk: '0', // Will be decrypted from ciphertext
                    value: '0', // Will be decrypted from ciphertext
                    tokenAddress: '0x0', // Will be determined from token data
                    encryptedBundle: null,
                    shieldKey: null,
                    // Transact-specific fields
                    transactCiphertext,
                  })
                }
              }
            } else {
              otherCount++
            }
          } catch (error) {
            dlog(`Could not parse log with topic ${log.topics[0]}: ${error}`)
            otherCount++
          }
        }

        dlog(
          `Event parsing summary: ${shieldCount} Shield, ${transactCount} Transact, ${otherCount} other/unparsed`
        )
      }

      return commitmentEvents
    } catch (error) {
      console.error('Error fetching commitment events:', error)
      throw error
    }
  }

  /**
   * Try to decrypt commitments for this wallet
   * @param commitments - Array of on-chain commitment events to attempt decryption on
   * @param wallet - The wallet whose viewing key is used for decryption
   * @param progressCallback - Optional callback to report decryption progress
   * @returns Array of successfully decrypted commitments belonging to the wallet
   */
  private async decryptCommitmentsForWallet (
    commitments: OnChainCommitment[],
    wallet: RailgunWallet,
    progressCallback?: (progress: number) => void
  ): Promise<OnChainDecryptedCommitment[]> {
    const decryptedCommitments: OnChainDecryptedCommitment[] = []
    let successCount = 0
    let failureCount = 0

    dlog(`Attempting to decrypt ${commitments.length} commitments`)

    for (let i = 0; i < commitments.length; i++) {
      const commitment = commitments[i]
      if (!commitment) continue

      try {
        const decrypted = await this.tryDecryptCommitment(commitment, wallet)
        if (decrypted) {
          decryptedCommitments.push(decrypted)
          successCount++
        } else {
          failureCount++
        }
      } catch (error) {
        failureCount++
        // Don't log every failure - most commitments won't belong to this wallet
      }

      // Update progress
      if (progressCallback && i % 100 === 0) {
        const progress = 0.3 + (i / commitments.length) * 0.4 // 30-70% range
        progressCallback(progress)
      }
    }

    dlog(`Decryption complete: ${successCount} successful, ${failureCount} failed`)
    return decryptedCommitments
  }

  /**
   * Try to decrypt a single commitment for this wallet
   * @param commitment - The on-chain commitment event to decrypt
   * @param wallet - The wallet whose keys are used for decryption
   * @returns The decrypted commitment if it belongs to this wallet, or null otherwise
   */
  private async tryDecryptCommitment (
    commitment: OnChainCommitment,
    wallet: RailgunWallet
  ): Promise<OnChainDecryptedCommitment | null> {
    try {
      if (commitment.commitmentType === 'Shield') {
        return this.tryDecryptShieldCommitment(commitment, wallet)
      } else if (commitment.commitmentType === 'Transact') {
        return this.tryDecryptTransactCommitment(commitment, wallet)
      }
      return null
    } catch (error) {
      // Most commitments won't decrypt for this wallet - that's expected
      return null
    }
  }

  /**
   * Try to decrypt a shield commitment
   * @param commitment - The shield commitment event to decrypt
   * @param _wallet - The wallet whose viewing key is used for decryption
   * @returns The decrypted commitment if it belongs to this wallet, or null otherwise
   */
  private async tryDecryptShieldCommitment (
    commitment: OnChainCommitment,
    _wallet: RailgunWallet
  ): Promise<OnChainDecryptedCommitment | null> {
    try {
      // For shield commitments, we have the plaintext commitment data from the event.
      // However, we still need to verify it belongs to this wallet by attempting
      // to decrypt the shield ciphertext using our wallet's viewing key.

      if (!commitment.npk || !commitment.value || !commitment.tokenAddress) {
        dlog(
          `Shield commitment missing required fields: npk=${!!commitment.npk}, value=${!!commitment.value}, tokenAddress=${!!commitment.tokenAddress}`
        )
        return null
      }

      // For Shield commitments, the data is already plaintext in the event,
      // but we can verify ownership by checking if we can compute the expected NPK
      // The NPK should be poseidon(masterPublicKey, random) for our wallet

      // For shield commitments, decrypt the actual random value from the encryptedBundle
      // The encryptedBundle contains the encrypted random that was used to create the shield note
      let randomValue = '0x' + '0'.repeat(32) // Default 16 bytes hex (32 chars)

      try {
        if (
          commitment.encryptedBundle &&
          commitment.shieldKey &&
          commitment.encryptedBundle.length >= 3
        ) {
          // Extract AES-GCM components from encryptedBundle
          // Bundle format: [IV+Tag, Data+IV, Receiver]
          const ivTagHex = commitment.encryptedBundle[0].startsWith('0x')
            ? commitment.encryptedBundle[0].slice(2)
            : commitment.encryptedBundle[0]
          const dataIvHex = commitment.encryptedBundle[1].startsWith('0x')
            ? commitment.encryptedBundle[1].slice(2)
            : commitment.encryptedBundle[1]

          // Parse IV, tag, and data according to contract format
          // Bundle[0] = IV (16 bytes) + Tag (16 bytes) = 32 bytes total
          // Bundle[1] = Encrypted data (varies) + something else
          const iv = ivTagHex.slice(0, 32) // First 32 chars (16 bytes)
          const tag = ivTagHex.slice(32, 64) // Next 32 chars (16 bytes)

          // For shield, we expect the encrypted random to be 16 bytes (32 hex chars)
          // But we need to figure out the right portion of dataIvHex
          // Based on shield creation, the encrypted random should be much shorter than 64 chars
          const data = [dataIvHex.slice(0, 32)] // Try first 32 chars (16 bytes) for random

          // Get shared symmetric key for decryption
          const viewingPrivateKey = ByteUtils.hexStringToBytes(_wallet.viewingKey)
          const shieldKeyBytes = ByteUtils.hexStringToBytes(commitment.shieldKey)
          const sharedKey = await getSharedSymmetricKey(viewingPrivateKey, shieldKeyBytes)

          if (sharedKey && sharedKey.length === 32) {
            // Decrypt using AES-GCM
            const decrypted = AES.decryptGCM({ iv, tag, data }, sharedKey)

            const decryptedFirst = decrypted?.[0]
            if (decrypted && decrypted.length > 0 && decryptedFirst) {
              // The decrypted[0] should contain our 16-byte random hex string
              const decryptedRandom = ByteUtils.hexlify(decryptedFirst, false)
              // Ensure it's exactly 32 characters (16 bytes)
              randomValue = '0x' + decryptedRandom.slice(0, 32).padEnd(32, '0')
            } else {
              // Decryption failed - this commitment doesn't belong to this wallet
              return null
            }
          } else {
            // Failed to generate shared key - this commitment doesn't belong to this wallet
            return null
          }
        }
      } catch (e) {
        // Decryption exception - this commitment doesn't belong to this wallet
        return null
      }

      // CRITICAL FIX: Calculate the actual commitment hash as poseidon([npk, tokenHash, value])
      // The commitment.hash from Shield event is just the NPK, not the full commitment hash
      const npkBigInt = ByteUtils.hexToBigInt(commitment.npk)
      const tokenAddress = commitment.tokenAddress.toLowerCase()
      const tokenHashBigInt = ByteUtils.hexToBigInt(
        ByteUtils.formatToByteLength(tokenAddress, 20, false)
      )
      const valueBigInt = BigInt(commitment.value)

      const calculatedHash = ByteUtils.nToHex(
        poseidonUtil([npkBigInt, tokenHashBigInt, valueBigInt]),
        32,
        true
      )

      return {
        id: commitment.id,
        hash: calculatedHash, // Use the correctly calculated hash
        txid: commitment.txid,
        blockNumber: commitment.blockNumber,
        treeNumber: commitment.treeNumber,
        batchStartTreePosition: commitment.batchStartTreePosition,
        position: commitment.position,
        commitmentType: commitment.commitmentType,
        tokenAddress: commitment.tokenAddress,
        tokenType: 0, // ERC20
        tokenSubID: '0',
        value: valueBigInt,
        npk: commitment.npk,
        isSpent: false,
        timestamp: commitment.timestamp,
        random: randomValue,
      }
    } catch (error) {
      dlog(`Error decrypting shield commitment: ${error}`)
      return null
    }
  }

  /**
   * Try to decrypt a transact commitment
   * @param commitment - The transact commitment event to decrypt
   * @param wallet - The wallet whose viewing key is used for decryption
   * @returns The decrypted commitment if it belongs to this wallet, or null otherwise
   */
  private async tryDecryptTransactCommitment (
    commitment: OnChainCommitment,
    wallet: RailgunWallet
  ): Promise<OnChainDecryptedCommitment | null> {
    try {
      // Check if we have parsed transact ciphertext
      if (!commitment.transactCiphertext) {
        return null
      }

      const ciphertextData = commitment.transactCiphertext
      const viewingPrivateKey = ByteUtils.hexStringToBytes(wallet.viewingKey)

      // Extract blinded viewing keys from parsed ciphertext
      const blindedReceiverViewingKey = ByteUtils.hexStringToBytes(
        ciphertextData.blindedReceiverViewingKey
      )
      const blindedSenderViewingKey = ByteUtils.hexStringToBytes(
        ciphertextData.blindedSenderViewingKey
      )

      if (!blindedReceiverViewingKey || !blindedSenderViewingKey) {
        return null
      }

      // Derive shared keys
      const [sharedKeyReceiver, sharedKeySender] = await Promise.all([
        getSharedSymmetricKey(viewingPrivateKey, blindedReceiverViewingKey),
        getSharedSymmetricKey(viewingPrivateKey, blindedSenderViewingKey),
      ])

      // Build the note payload once (shared between receiver and sender attempts)
      const notePayload = {
        ciphertext: {
          iv: ciphertextData.iv,
          tag: ciphertextData.tag,
          data: ciphertextData.data,
        },
        memo: ciphertextData.memo,
      }

      // Try receiver key first, then sender key (change outputs)
      const keysToTry: Array<{ key: Uint8Array | null; isSentNote: boolean }> = [
        { key: sharedKeyReceiver, isSentNote: false },
        { key: sharedKeySender, isSentNote: true },
      ]

      for (const { key, isSentNote } of keysToTry) {
        if (!key) continue
        const decrypted = await this.tryDecryptTransactNote(
          notePayload,
          key,
          isSentNote,
          wallet.masterPublicKey
        )
        if (decrypted) {
          return {
            id: commitment.id,
            hash: commitment.hash,
            txid: commitment.txid,
            blockNumber: commitment.blockNumber,
            treeNumber: commitment.treeNumber,
            batchStartTreePosition: commitment.batchStartTreePosition,
            position: commitment.position,
            commitmentType: commitment.commitmentType,
            tokenAddress: decrypted.tokenAddress,
            tokenType: decrypted.tokenType,
            tokenSubID: decrypted.tokenSubID,
            value: decrypted.value,
            npk: decrypted.npk,
            isSpent: false,
            timestamp: commitment.timestamp,
            random: decrypted.random,
          }
        }
      }

      return null
    } catch (error) {
      // Most commitments won't decrypt for this wallet - that's expected
      return null
    }
  }

  /**
   * Try to decrypt a transact note using shared key
   * @param ciphertextData - The encrypted note payload containing ciphertext and memo
   * @param ciphertextData.ciphertext - The AES-GCM encrypted ciphertext object
   * @param ciphertextData.ciphertext.iv - The initialization vector for AES-GCM decryption
   * @param ciphertextData.ciphertext.tag - The authentication tag for AES-GCM verification
   * @param ciphertextData.ciphertext.data - The encrypted data blocks
   * @param ciphertextData.memo - The encrypted memo block used as part of the decryption input
   * @param sharedKey - The derived shared symmetric key for AES-GCM decryption
   * @param isSentNote - Whether this is a sent note (change output) rather than a received note
   * @param currentWalletMasterPublicKey - The master public key of the current wallet
   * @returns Decrypted note data including token address, value, and NPK, or null on failure
   */
  private async tryDecryptTransactNote (
    ciphertextData: {
      ciphertext: { iv: string; tag: string; data: string[] }
      memo: string
    },
    sharedKey: Uint8Array,
    isSentNote: boolean,
    currentWalletMasterPublicKey: string
  ): Promise<{
    tokenAddress: string
    tokenType: number
    tokenSubID: string
    value: bigint
    npk: string
    random: string
  } | null> {
    try {
      // During encryption, ALL 4 blocks (MPK, tokenHash, randomValue, memo) are encrypted
      // together in ONE AES-GCM operation. So we must include memo as the 4th block during decryption!
      const dataBlocks: string[] = [
        ...ciphertextData.ciphertext.data.map((d) => ByteUtils.strip0x(d)),
        ByteUtils.strip0x(ciphertextData.memo), // Add memo as 4th block
      ]

      const decryptedCiphertext = AES.decryptGCM(
        {
          iv: ByteUtils.strip0x(ciphertextData.ciphertext.iv),
          tag: ByteUtils.strip0x(ciphertextData.ciphertext.tag),
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

      const tokenHashHex = ByteUtils.prefix0x(
        ByteUtils.formatToByteLength(tokenHashBlock, 32, false).toLowerCase()
      )

      const random = '0x' + randomAndValue.substring(0, 32)
      const value = BigInt('0x' + randomAndValue.substring(32, 64))

      // For ERC20 tokens, tokenHash directly contains the token address (padded to 32 bytes)
      // Extract the last 20 bytes (40 hex chars) as the token address
      const tokenAddress = '0x' + tokenHashHex.slice(-40)

      // Calculate NPK using receiver's master public key
      let mpkForNpk: bigint
      try {
        if (!isSentNote && currentWalletMasterPublicKey) {
          const mpkStr = String(currentWalletMasterPublicKey)
          mpkForNpk =
            mpkStr.startsWith('0x') || mpkStr.startsWith('0X')
              ? BigInt(mpkStr)
              : BigInt('0x' + mpkStr)
        } else {
          mpkForNpk = BigInt('0x' + encodedMPKHex.replace(/^0x/, ''))
        }
      } catch {
        mpkForNpk = BigInt('0x' + encodedMPKHex.replace(/^0x/, ''))
      }

      const npk = poseidonUtil([mpkForNpk, ByteUtils.hexToBigInt(random)])

      return {
        tokenAddress: tokenAddress.toLowerCase(),
        tokenType: 0, // ERC20
        tokenSubID: '0',
        value,
        npk: ByteUtils.hexlify(npk),
        random,
      }
    } catch (error) {
      // Most commitments won't decrypt for this wallet - expected
      return null
    }
  }

  /**
   * Calculate token balances from decrypted commitments
   * @param decryptedCommitments - Array of decrypted commitment data to aggregate
   * @param networkName - The network name used to resolve token symbols
   * @returns Array of aggregated token balances from unspent commitments
   */
  private calculateTokenBalances (
    decryptedCommitments: OnChainDecryptedCommitment[],
    networkName: NetworkName
  ): TokenBalance[] {
    const balanceMap = new Map<string, TokenBalance>()

    for (const commitment of decryptedCommitments) {
      // Skip spent commitments
      if (commitment.isSpent) continue

      const tokenKey = commitment.tokenAddress.toLowerCase()

      if (!balanceMap.has(tokenKey)) {
        balanceMap.set(tokenKey, {
          tokenAddress: tokenKey, // Use lowercase for consistency
          symbol: TokenService.getInstance().getTokenSymbol(commitment.tokenAddress, networkName),
          decimals: 18, // Default; actual decimals resolved via TokenService.getTokenInfo() when needed
          balance: 0n,
          balanceBucket: 'ShieldPending', // Default bucket for on-chain scanning
        })
      }

      const tokenBalance = balanceMap.get(tokenKey)!
      tokenBalance.balance += commitment.value
    }

    return Array.from(balanceMap.values())
  }

  /**
   * Fetch ALL commitments (not just decrypted ones) for a specific tree from on-chain logs
   * This is needed to populate the merkle tree for proof generation
   * Matches SubsquidBalanceScanner.fetchAllCommitmentsForTree() interface
   * @param treeNumber - The merkle tree number to filter commitments by
   * @param chainId - The chain ID used to determine the network configuration
   * @param provider - The ethers provider for RPC calls
   * @param maxBlockNumber - Optional upper block boundary for the scan range
   * @param minBlockNumber - Optional lower block boundary for the scan range
   * @returns Array of commitment hashes with their positions and block numbers
   */
  public async fetchAllCommitmentsForTree (
    treeNumber: number,
    chainId: number,
    provider: ethers.Provider,
    maxBlockNumber?: number,
    minBlockNumber?: number
  ): Promise<Array<{ hash: string; position: number; blockNumber: number }>> {
    try {
      // Determine network from chainId
      const networkName =
        chainId === 11155111 ? 'EthereumSepolia' : chainId === 31337 ? 'Hardhat' : 'EthereumSepolia' // Default fallback

      const networkConfig = NETWORK_CONFIG[networkName as NetworkName]
      if (!networkConfig) {
        throw new Error(`Network configuration not found for ${networkName}`)
      }

      dlog(`Fetching ALL commitments for tree ${treeNumber} from on-chain RPC (${networkName})`)

      const railgunABI = RailgunSmartWalletABI

      const currentBlock = maxBlockNumber || (await provider.getBlockNumber())
      // Allow caller to specify min block for testing purposes (avoid scanning entire history)
      const fromBlock =
        minBlockNumber !== undefined ? minBlockNumber : networkConfig.deploymentBlock

      dlog(
        `Fetching commitment events for tree ${treeNumber} from block ${fromBlock} to ${currentBlock}`
      )

      // Fetch ALL logs using chunking for large block ranges
      const allLogs = await this.fetchLogsInChunks(provider, {
        address: networkConfig.railgunV2Contract,
        fromBlock,
        toBlock: currentBlock,
      })

      dlog(`Found ${allLogs.length} total logs from RAILGUN contract for tree filtering`)

      const contractInterface = new ethers.Interface(railgunABI)
      const commitments: Array<{ hash: string; position: number; blockNumber: number }> = []

      // Parse logs and filter by tree number
      for (const log of allLogs) {
        try {
          const parsed = contractInterface.parseLog({
            topics: [...log.topics],
            data: log.data,
          })

          if (!parsed) continue

          // Handle Shield events (V2.1 with fee, or legacy without fee)
          if (parsed.name === 'Shield') {
            const hasV21Signature = parsed.args.length === 5
            const treeNum = hasV21Signature ? Number(parsed.args[0]) : 0
            const startPos = hasV21Signature ? Number(parsed.args[1]) : Number(parsed.args[0])
            const commitmentsArray = hasV21Signature ? parsed.args[2] : parsed.args[1]

            // Only include commitments from the requested tree
            if (treeNum === treeNumber) {
              for (let i = 0; i < commitmentsArray.length; i++) {
                commitments.push({
                  hash: commitmentsArray[i].toString(), // Ensure string format
                  position: startPos + i,
                  blockNumber: log.blockNumber,
                })
              }
            }
          }

          // Handle Transact events (V2.1 with fee, or legacy without fee)
          if (parsed.name === 'Transact') {
            const hasV21Signature = parsed.args.length === 5
            const treeNum = hasV21Signature ? Number(parsed.args[0]) : 0
            const startPos = hasV21Signature ? Number(parsed.args[1]) : Number(parsed.args[0])
            const commitmentsArray = hasV21Signature ? parsed.args[3] : parsed.args[2]

            // Only include commitments from the requested tree
            if (treeNum === treeNumber) {
              for (let i = 0; i < commitmentsArray.length; i++) {
                commitments.push({
                  hash: commitmentsArray[i].toString(), // Ensure string format
                  position: startPos + i,
                  blockNumber: log.blockNumber,
                })
              }
            }
          }
        } catch (error) {
          // Skip logs that don't parse
          continue
        }
      }

      // Sort by position (ascending) to match Subsquid behavior
      commitments.sort((a, b) => a.position - b.position)

      dlog(`Fetched ${commitments.length} commitments for tree ${treeNumber} from on-chain RPC`)

      return commitments
    } catch (error) {
      console.error('Failed to fetch commitments from on-chain RPC:', error)
      return []
    }
  }

  /**
   * Detect spent commitments by fetching Nullified events and checking nullifiers
   * @param decryptedCommitments - Array of decrypted commitments to check for spent status
   * @param wallet - The wallet whose nullifying key is used to compute nullifiers
   * @param networkName - The network to fetch nullifier events from
   * @param provider - The ethers provider for RPC calls
   * @returns The same commitments with their isSpent flag updated
   */
  private async detectSpentCommitments (
    decryptedCommitments: OnChainDecryptedCommitment[],
    wallet: RailgunWallet,
    networkName: NetworkName,
    provider: ethers.Provider
  ): Promise<OnChainDecryptedCommitment[]> {
    dlog(`Checking ${decryptedCommitments.length} UTXOs for spent status`)

    try {
      // Fetch nullifier events from RAILGUN contract
      const spentNullifiers = await this.fetchNullifierEvents(networkName, provider)
      const spentNullifierSet = new Set(spentNullifiers.map((n) => ByteUtils.normalizeHex256(n)))

      dlog(`Found ${spentNullifiers.length} nullifier events`)

      // Check each commitment against spent nullifiers
      const updatedCommitments = await Promise.all(
        decryptedCommitments.map(async (commitment) => {
          // Calculate the nullifier for this commitment
          const nullifier = await this.calculateNullifier(commitment, wallet)
          const isSpent = spentNullifierSet.has(ByteUtils.normalizeHex256(nullifier))

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
   * Fetch Nullified events from RAILGUN contract
   * @param networkName - The network to scan for nullifier events
   * @param provider - The ethers provider for RPC calls
   * @returns Array of nullifier hex strings extracted from on-chain events
   */
  private async fetchNullifierEvents (
    networkName: NetworkName,
    provider: ethers.Provider
  ): Promise<string[]> {
    const networkConfig = NETWORK_CONFIG[networkName]
    if (!networkConfig) {
      throw new Error(`Network configuration not found for ${networkName}`)
    }

    const railgunABI = RailgunSmartWalletABI

    const contract = new ethers.Contract(networkConfig.railgunV2Contract, railgunABI, provider)

    // Get Nullified event topic
    const nullifiedTopic = ethers.id('Nullified(uint16,bytes32[])')

    const currentBlock = await provider.getBlockNumber()
    const fromBlock = networkConfig.deploymentBlock

    dlog(`Fetching Nullified events from block ${fromBlock} to ${currentBlock}`)

    // Use chunking to handle large block ranges (RPC providers limit to ~50k blocks)
    const logs = await this.fetchLogsInChunks(provider, {
      address: networkConfig.railgunV2Contract,
      topics: [nullifiedTopic],
      fromBlock,
      toBlock: currentBlock,
    })

    dlog(`Found ${logs.length} Nullified event logs`)

    // Parse logs and extract nullifiers
    const nullifiers: string[] = []
    for (const log of logs) {
      try {
        const parsed = contract.interface.parseLog({
          topics: [...log.topics],
          data: log.data,
        })
        if (parsed && parsed.args && parsed.args['nullifier']) {
          // nullifier is an array of bytes32
          const nullifierArray = parsed.args['nullifier']
          nullifiers.push(...nullifierArray)
        }
      } catch (error) {
        console.error('Error parsing Nullified event:', error)
      }
    }

    dlog(`Extracted ${nullifiers.length} total nullifiers`)
    return nullifiers
  }

  /**
   * Calculate nullifier for a commitment
   * Nullifier = poseidon(nullifyingKey, position)
   * @param commitment - The decrypted commitment to compute a nullifier for
   * @param wallet - The wallet providing the nullifying key
   * @returns The computed nullifier as a hex string
   */
  private async calculateNullifier (
    commitment: OnChainDecryptedCommitment,
    wallet: RailgunWallet
  ): Promise<string> {
    if (!wallet.nullifyingKey) {
      throw new Error('Wallet missing nullifyingKey')
    }

    // Calculate nullifier : poseidon(nullifyingKey, position)
    const nullifyingKey = BigInt(wallet.nullifyingKey)
    const position = BigInt(commitment.position)
    const nullifier = poseidon([nullifyingKey, position])

    // Convert to hex string
    return ByteUtils.nToHex(nullifier, 32, true)
  }
}

// Type definitions for on-chain commitments
interface OnChainTransactCiphertext {
  iv: string
  tag: string
  data: string[]
  blindedSenderViewingKey: string
  blindedReceiverViewingKey: string
  annotationData: string
  memo: string
}

interface OnChainCommitment {
  id: string
  hash: string
  txid: string
  blockNumber: number
  treeNumber: number
  batchStartTreePosition: number
  position: number
  commitmentType: 'Shield' | 'Transact'
  ciphertext: string
  timestamp: number
  // Shield-specific fields
  npk?: string
  value?: string
  tokenAddress?: string
  // Shield encryption data for proper decryption
  encryptedBundle?: [string, string, string] | null
  shieldKey?: string | null
  // Transact-specific fields
  transactCiphertext?: OnChainTransactCiphertext | null
}

interface OnChainDecryptedCommitment {
  id: string
  hash: string
  txid: string
  blockNumber: number
  treeNumber: number
  batchStartTreePosition: number
  position: number
  commitmentType: string
  tokenAddress: string
  tokenType: number
  tokenSubID: string
  value: bigint
  npk: string
  isSpent: boolean
  timestamp: number
  random: string
}

export { OnChainBalanceScanner }
