import { NETWORK_CONFIG, NetworkName, WRAPPED_BASE_TOKEN } from '@/types/network'
import type { DetailedTransaction, KnownTransactionType } from '@/types/wallet'

interface BlockscoutTx {
  hash: string
  blockNumber: string
  timeStamp: string
  from: string
  to: string
  value: string
  isError: string
  input: string
  gasUsed: string
  gasPrice: string
}

interface BlockscoutInternalTx {
  transactionHash: string
  blockNumber: string
  timeStamp: string
  from: string
  to: string
  value: string
  isError: string
}

interface BlockscoutTokenTx {
  hash: string
  blockNumber: string
  timeStamp: string
  from: string
  to: string
  value: string
  contractAddress: string
  tokenSymbol: string
  tokenDecimal: string
}

const BLOCKSCOUT_API_URLS: Partial<Record<NetworkName, string>> = {
  [NetworkName.EthereumSepolia]: 'https://eth-sepolia.blockscout.com/api',
}

/**
 * Fetches public (0x) wallet transaction history via Blockscout API.
 * Blockscout is open source and free — no API key required.
 */
export class PublicTransactionService {
  /** Singleton instance of the public transaction service. */
  private static instance: PublicTransactionService

  /**
   * Returns the singleton instance of PublicTransactionService.
   * @returns The shared PublicTransactionService instance
   */
  static getInstance (): PublicTransactionService {
    if (!PublicTransactionService.instance) {
      PublicTransactionService.instance = new PublicTransactionService()
    }
    return PublicTransactionService.instance
  }

  /**
   * Fetches the full public transaction history for a wallet address from Blockscout.
   * @param address - The 0x wallet address to fetch history for
   * @param network - The network to query transactions on
   * @returns Sorted array of detailed transactions, newest first
   */
  async getTransactionHistory (
    address: string,
    network: NetworkName
  ): Promise<DetailedTransaction[]> {
    const apiUrl = BLOCKSCOUT_API_URLS[network]
    if (!apiUrl || !address) return []

    // Fetch normal + internal + ERC20 token transactions in parallel
    const [txs, internalTxs, tokenTxs] = await Promise.all([
      this.fetchFromBlockscout<BlockscoutTx>(apiUrl, 'txlist', address),
      this.fetchFromBlockscout<BlockscoutInternalTx>(apiUrl, 'txlistinternal', address),
      this.fetchFromBlockscout<BlockscoutTokenTx>(apiUrl, 'tokentx', address),
    ])

    const addressLower = address.toLowerCase()

    // Get RAILGUN-related contract addresses for this network to label interactions
    const networkConfig = NETWORK_CONFIG[network]
    const railgunAddress = networkConfig?.railgunContractAddress?.toLowerCase()
    const relayAdaptAddress = NETWORK_CONFIG[network]?.relayAdaptContract?.toLowerCase()
    const wethAddress = WRAPPED_BASE_TOKEN[network]?.toLowerCase()

    // Single pass over internal txs to build:
    // 1. unshieldInternalTxMap: tx hashes where user received ETH from RAILGUN/RelayAdapt
    // 2. wethUnwrapTxHashes: tx hashes where user received ETH from WETH.withdraw()
    const unshieldInternalTxMap = new Map<string, bigint>()
    const wethUnwrapTxHashes = new Set<string>()
    const hasWeth = wethAddress && wethAddress !== '0x0000000000000000000000000000000000000000'

    for (const itx of internalTxs) {
      const toAddr = itx.to?.toLowerCase()
      if (toAddr !== addressLower || itx.isError === '1') continue

      const value = BigInt(itx.value)
      if (value <= 0n) continue

      const fromAddr = itx.from?.toLowerCase()

      if (fromAddr === railgunAddress || fromAddr === relayAdaptAddress) {
        const existing = unshieldInternalTxMap.get(itx.transactionHash) ?? 0n
        unshieldInternalTxMap.set(itx.transactionHash, existing + value)
      }

      if (hasWeth && fromAddr === wethAddress) {
        wethUnwrapTxHashes.add(itx.transactionHash.toLowerCase())
      }
    }

    // Build a map of tx hashes where the user received ERC20 tokens FROM the RAILGUN contract
    // (standard ERC20 unshields produce a Transfer event from RAILGUN → user)
    const erc20UnshieldMap = new Map<
      string,
      { symbol: string; amount: bigint; decimals: number; tokenAddress: string }
    >()
    for (const ttx of tokenTxs) {
      const fromAddr = ttx.from?.toLowerCase()
      const toAddr = ttx.to?.toLowerCase()
      if (
        toAddr === addressLower &&
        (fromAddr === railgunAddress || fromAddr === relayAdaptAddress) &&
        BigInt(ttx.value) > 0n
      ) {
        erc20UnshieldMap.set(ttx.hash.toLowerCase(), {
          symbol: ttx.tokenSymbol || 'ERC20',
          amount: BigInt(ttx.value),
          decimals: parseInt(ttx.tokenDecimal, 10) || 18,
          tokenAddress: ttx.contractAddress,
        })
      }
    }

    const seenTxHashes = new Set<string>()

    const validTxs = txs.filter((tx) => tx.hash && tx.from)
    const detailed: DetailedTransaction[] = validTxs.map((tx) => {
      seenTxHashes.add(tx.hash.toLowerCase())
      const isSent = tx.from.toLowerCase() === addressLower
      const valueBigInt = BigInt(tx.value || '0')
      const isContractCall = tx.input && tx.input !== '0x'
      const toLower = tx.to?.toLowerCase()

      // Detect RAILGUN contract interactions (direct or via RelayAdapt)
      const isDirectRailgun = railgunAddress && toLower === railgunAddress
      const isRelayAdapt = relayAdaptAddress && toLower === relayAdaptAddress
      const isWethContract = wethAddress && toLower === wethAddress

      // Check if this tx hash has an associated unshield internal transfer (ETH via RelayAdapt)
      const unshieldAmount = unshieldInternalTxMap.get(tx.hash)

      // Check if this tx hash has an associated ERC20 token transfer from RAILGUN → user
      const erc20Unshield = erc20UnshieldMap.get(tx.hash.toLowerCase())

      // Check if this is a WETH.withdraw() call (old unshield flow created these)
      const isWethUnwrap = isWethContract && isSent && wethUnwrapTxHashes.has(tx.hash.toLowerCase())

      // Determine type and category based on RAILGUN detection
      let type: KnownTransactionType = 'Private Send'
      let category: string
      if (isRelayAdapt && isSent && valueBigInt > 0n) {
        // User sent ETH to RelayAdapt — this is a shield
        type = 'Shield'
        category = 'RAILGUN Shield'
      } else if (unshieldAmount != null) {
        // This tx hash has internal transfers sending ETH to the user from RAILGUN/RelayAdapt
        type = 'Unshield'
        category = 'RAILGUN Unshield'
      } else if (erc20Unshield) {
        // ERC20 Transfer event from RAILGUN contract to user — this is an unshield
        type = 'Unshield'
        category = 'RAILGUN Unshield'
      } else if (isWethUnwrap) {
        // User called WETH.withdraw() — only categorize as unshield if RelayAdapt was involved
        // Standalone WETH unwraps (user directly unwrapping WETH) are just contract calls
        category = 'WETH Unwrap'
      } else if (isRelayAdapt && isSent && valueBigInt === 0n) {
        // Zero-value call to RelayAdapt — atomic unshield-to-ETH (no internal tx match means it may have failed or is pending)
        type = 'Unshield'
        category = 'RAILGUN Unshield'
      } else if (isDirectRailgun) {
        type = valueBigInt > 0n ? 'Shield' : 'Private Send'
        category = valueBigInt > 0n ? 'RAILGUN Shield' : 'RAILGUN Transact'
      } else if (isContractCall) {
        category = valueBigInt > 0n ? 'Contract + ETH' : 'Contract Call'
      } else {
        category = 'ETH Transfer'
      }

      const metadata: DetailedTransaction['metadata'] = {}
      if (isSent) metadata.recipientAddress = tx.to
      else metadata.senderAddress = tx.from

      // Calculate gas cost: gasUsed * gasPrice (both in wei)
      const gasUsed = BigInt(tx.gasUsed || '0')
      const gasPrice = BigInt(tx.gasPrice || '0')
      const gasCost = gasUsed * gasPrice

      const transferredTokens: DetailedTransaction['transferredTokens'] = []
      if (unshieldAmount != null && unshieldAmount > 0n) {
        transferredTokens.push({
          tokenAddress: '0x0000000000000000000000000000000000000000',
          symbol: 'ETH',
          amount: unshieldAmount,
          decimals: 18,
          direction: 'received',
          recipientAddress: address,
        })
      } else if (erc20Unshield) {
        transferredTokens.push({
          tokenAddress: erc20Unshield.tokenAddress,
          symbol: erc20Unshield.symbol,
          amount: erc20Unshield.amount,
          decimals: erc20Unshield.decimals,
          direction: 'received',
          recipientAddress: address,
        })
      } else if (valueBigInt > 0n) {
        transferredTokens.push({
          tokenAddress: '0x0000000000000000000000000000000000000000',
          symbol: 'ETH',
          amount: valueBigInt,
          decimals: 18,
          direction: isSent ? 'sent' : 'received',
          recipientAddress: isSent ? tx.to : tx.from,
        })
      }

      const status: DetailedTransaction['status'] = tx.isError === '1' ? 'failed' : 'confirmed'

      return {
        txid: tx.hash,
        blockNumber: parseInt(tx.blockNumber, 10),
        timestamp: parseInt(tx.timeStamp, 10),
        status,
        type,
        category,
        transferredTokens,
        blindedCommitments: [],
        version: 2,
        metadata,
        gasCost,
      }
    })

    // Also add unshield internal txs that don't appear in the normal tx list
    // (e.g. when a broadcaster submitted the tx, not the user themselves)
    for (const [txHash, amount] of unshieldInternalTxMap) {
      if (seenTxHashes.has(txHash.toLowerCase())) continue

      // Find the internal tx details for this hash
      const itx = internalTxs.find((t) => t.transactionHash.toLowerCase() === txHash.toLowerCase())
      if (!itx) continue

      const unshieldTokens: DetailedTransaction['transferredTokens'] =
        amount > 0n
          ? [
              {
                tokenAddress: '0x0000000000000000000000000000000000000000',
                symbol: 'ETH',
                amount,
                decimals: 18,
                direction: 'received',
                recipientAddress: address,
              },
            ]
          : []

      seenTxHashes.add(txHash.toLowerCase())
      detailed.push({
        txid: itx.transactionHash,
        blockNumber: parseInt(itx.blockNumber, 10),
        timestamp: parseInt(itx.timeStamp, 10),
        status: 'confirmed',
        type: 'Unshield',
        category: 'RAILGUN Unshield',
        transferredTokens: unshieldTokens,
        blindedCommitments: [],
        version: 2,
        metadata: { senderAddress: itx.from },
        gasCost: 0n,
      })
    }

    // Also add ERC20 unshield token txs that don't appear in the normal tx list
    // (e.g. when a broadcaster submitted the tx, not the user themselves)
    for (const [txHash, tokenData] of erc20UnshieldMap) {
      if (seenTxHashes.has(txHash.toLowerCase())) continue

      // Find the token tx details for this hash
      const ttx = tokenTxs.find((t) => t.hash.toLowerCase() === txHash.toLowerCase())
      if (!ttx) continue

      detailed.push({
        txid: ttx.hash,
        blockNumber: parseInt(ttx.blockNumber, 10),
        timestamp: parseInt(ttx.timeStamp, 10),
        status: 'confirmed',
        type: 'Unshield',
        category: 'RAILGUN Unshield',
        transferredTokens: [
          {
            tokenAddress: tokenData.tokenAddress,
            symbol: tokenData.symbol,
            amount: tokenData.amount,
            decimals: tokenData.decimals,
            direction: 'received',
            recipientAddress: address,
          },
        ],
        blindedCommitments: [],
        version: 2,
        metadata: { senderAddress: ttx.from },
        gasCost: 0n,
      })
    }

    return detailed.sort((a, b) => b.timestamp - a.timestamp)
  }

  /**
   * Fetches paginated account data from the Blockscout API.
   * @param apiUrl - The base Blockscout API URL
   * @param action - The Blockscout action type (e.g., txlist, txlistinternal, tokentx)
   * @param address - The 0x wallet address to query
   * @returns Array of transaction records from Blockscout
   */
  private async fetchFromBlockscout<T>(
    apiUrl: string,
    action: string,
    address: string
  ): Promise<T[]> {
    try {
      const url = `${apiUrl}?module=account&action=${action}&address=${address}&sort=desc&page=1&offset=50`
      const response = await fetch(url)
      const data = await response.json()
      if (data.message === 'OK' && Array.isArray(data.result)) {
        return data.result
      }
      return []
    } catch (e) {
      console.error(`Error fetching ${action} from Blockscout:`, e)
      return []
    }
  }
}
