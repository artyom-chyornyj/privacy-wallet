/**
 * PPOI Node API Client
 *
 * Provides communication with RAILGUN Privacy Pools of Innocence (PPOI) nodes
 * for PPOI proof generation and submission.
 *
 * Based on: wallet/src/services/poi/poi-node-request.ts
 */

import type { AxiosError } from 'axios'
import axios from 'axios'

import type { Proof } from '@/core/prover-poi'
import { NetworkName } from '@/types/network'
import { derror, dwarn } from '@/utils/debug'

// Utility type for optional values
type Optional<T> = T | undefined

// JSON-RPC Types
interface JsonRpcPayload {
  jsonrpc: '2.0'
  method: string
  params: any
  id: number | string
}

interface JsonRpcResult {
  jsonrpc: '2.0'
  result: any
  id: number | string
}

interface JsonRpcError {
  jsonrpc: '2.0'
  error: {
    code: number
    message: string
    data?: any
  }
  id: number | string
}

// PPOI JSON-RPC Methods (from shared-models)
enum POIJSONRPCMethod {
  POIMerkleProofs = 'ppoi_merkle_proofs',
  SubmitTransactProof = 'ppoi_submit_transact_proof',
  ValidateTXIDMerkleroot = 'ppoi_validate_txid_merkleroot',
  ValidatedTXID = 'ppoi_validated_txid',
}

// PPOI's current sync status
interface ValidatedRailgunTxidStatus {
  validatedTxidIndex: number | undefined
  validatedMerkleroot: string | undefined
}

interface POIMerkleProof {
  element: string
  elements: string[]
  indices: number
  leaf: string
  root: string
}

enum TXIDVersion {
  V2_PoseidonMerkle = 'V2_PoseidonMerkle',
}

/**
 * Default PPOI node URL
 * Using single unified PPOI node for all networks
 */
const DEFAULT_PPOI_NODE_URL = 'https://ppoi.fdi.network/'

const DEFAULT_PPOI_NODE_URLS: Record<NetworkName, string[]> = {
  [NetworkName.EthereumSepolia]: [DEFAULT_PPOI_NODE_URL],
  [NetworkName.Hardhat]: [],
}

/**
 * PPOI List Keys
 * These identify different PPOI lists (privacy pools)
 *
 * Using sanctions-checking list key: efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88
 * This list validates that funds are not from sanctioned addresses.
 * Wallets must have validated PPOI proofs from this list to spend commitments.
 */
const SANCTIONS_LIST_KEY = 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88'

const DEFAULT_POI_LIST_KEYS: Record<NetworkName, string[]> = {
  [NetworkName.EthereumSepolia]: [SANCTIONS_LIST_KEY],
  [NetworkName.Hardhat]: [],
}

/**
 * Client for communicating with RAILGUN PPOI nodes via JSON-RPC.
 */
class PPOINodeClient {
  /** List of PPOI node URLs to use, with fallback rotation. */
  private nodeURLs: string[]
  /** Index into nodeURLs for the currently active node. */
  private currentNodeIndex: number = 0

  /**
   * Create a PPOINodeClient for the given network.
   * @param networkName - The RAILGUN network to connect to
   */
  constructor (private networkName: NetworkName) {
    this.nodeURLs = DEFAULT_PPOI_NODE_URLS[networkName] || []

    if (this.nodeURLs.length === 0) {
      dwarn(`No PPOI nodes configured for ${networkName}`)
    }
  }

  /**
   * Get PPOI list keys for this network.
   * @returns Array of PPOI list key hex strings
   */
  getListKeys (): string[] {
    return DEFAULT_POI_LIST_KEYS[this.networkName] || []
  }

  /**
   * Get the current node URL.
   * @returns The currently active PPOI node URL
   */
  private getCurrentNodeURL (): string {
    const url = this.nodeURLs[this.currentNodeIndex]
    if (!url) {
      throw new Error(`No PPOI node URL available at index ${this.currentNodeIndex}`)
    }
    return url
  }

  /**
   * Rotate to the next node URL (for fallback)
   */
  private rotateNodeURL (): void {
    this.currentNodeIndex = (this.currentNodeIndex + 1) % this.nodeURLs.length
  }

  /**
   * Make a JSON-RPC request to PPOI node with automatic node rotation on failure.
   * @param method - The PPOI JSON-RPC method to call
   * @param params - The parameters to pass to the JSON-RPC method
   * @param attemptIndex - The current retry attempt index for node rotation
   * @returns The result from the JSON-RPC response
   */
  private async jsonRpcRequest<T>(
    method: POIJSONRPCMethod,
    params: any,
    attemptIndex: number = 0
  ): Promise<T> {
    if (this.nodeURLs.length === 0) {
      throw new Error(`No PPOI nodes available for ${this.networkName}`)
    }

    const baseUrl = this.getCurrentNodeURL()

    const payload: JsonRpcPayload = {
      jsonrpc: '2.0',
      method,
      params,
      id: Date.now(),
    }

    try {
      const response = await axios.post<JsonRpcResult | JsonRpcError>(baseUrl, payload, {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 60000, // 60 second timeout (matching wallet implementation)
      })

      const data = response.data

      // Check if the response contains an error
      if ('error' in data) {
        throw new Error(data.error.message)
      }

      // Return the result
      return data.result as T
    } catch (error) {
      // If we have more nodes to try, rotate and retry
      if (attemptIndex < this.nodeURLs.length - 1) {
        dwarn(
          `PPOI request failed on ${baseUrl}, trying next node...`,
          error instanceof Error ? error.message : error
        )
        this.rotateNodeURL()
        return this.jsonRpcRequest<T>(method, params, attemptIndex + 1)
      }

      // All nodes failed - log detailed error info
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError
        derror(
          `PPOI Node Error: ${axiosError.response?.status} ${axiosError.response?.statusText} for method ${method}`
        )

        throw new Error(
          `PPOI Node request failed after ${this.nodeURLs.length} attempts: ${axiosError.message}`
        )
      }
      throw error
    }
  }

  /**
   * Get PPOI merkle proofs for input commitments
   *
   * This fetches merkle proofs from the PPOI node for the specified blinded commitments.
   * These proofs are required as circuit inputs to prove that spent UTXOs are in the PPOI tree.
   * @param listKey - The PPOI list key to get proofs for
   * @param blindedCommitments - Array of blinded commitments (from spent UTXOs)
   * @param txidVersion - The TXID version (V2_PoseidonMerkle for current transactions)
   * @returns Array of merkle proofs for each blinded commitment
   */
  async getPOIMerkleProofs (
    listKey: string,
    blindedCommitments: string[],
    txidVersion: TXIDVersion = TXIDVersion.V2_PoseidonMerkle
  ): Promise<POIMerkleProof[]> {
    const chainType = this.getChainType()
    const chainID = this.getChainID()

    const params = {
      chainType,
      chainID,
      txidVersion,
      listKey,
      blindedCommitments,
    }

    const poiMerkleProofs = await this.jsonRpcRequest<POIMerkleProof[]>(
      POIJSONRPCMethod.POIMerkleProofs,
      params
    )

    return poiMerkleProofs || []
  }

  /**
   * Get RAILGUN txid merkle proof
   *
   * Note: This might require querying the RAILGUN txid tree directly
   * The txid merkleroot validation endpoint exists, but getting the proof
   * may require additional integration with the RAILGUN contract or subsquid
   * @param txidMerkleroot - The txid merkleroot to validate
   * @param txidMerklerootIndex - The index of the merkleroot
   * @param txidVersion - The TXID version to use for validation
   * @returns Whether the merkleroot is valid
   */
  async validateTxidMerkleroot (
    txidMerkleroot: string,
    txidMerklerootIndex: number,
    txidVersion: TXIDVersion = TXIDVersion.V2_PoseidonMerkle
  ): Promise<boolean> {
    const chainType = this.getChainType()
    const chainID = this.getChainID()

    const params = {
      chainType,
      chainID,
      txidVersion,
      merkleroot: txidMerkleroot,
      index: txidMerklerootIndex,
      tree: 0, // Default tree index
    }

    const isValid = await this.jsonRpcRequest<boolean>(
      POIJSONRPCMethod.ValidateTXIDMerkleroot,
      params
    )

    return isValid
  }

  /**
   * Get PPOI node's latest validated RAILGUN txid index and merkleroot.
   * This tells us how far the PPOI node has synced.
   * @param txidVersion - The TXID version to query
   * @returns The validated txid status including index and merkleroot
   */
  async getLatestValidatedRailgunTxid (
    txidVersion: TXIDVersion = TXIDVersion.V2_PoseidonMerkle
  ): Promise<ValidatedRailgunTxidStatus> {
    const chainType = this.getChainType()
    const chainID = this.getChainID()

    const params = {
      chainType,
      chainID,
      txidVersion,
    }

    const status = await this.jsonRpcRequest<ValidatedRailgunTxidStatus>(
      POIJSONRPCMethod.ValidatedTXID,
      params
    )

    return status
  }

  /**
   * Ensure hex string has 0x prefix.
   * @param hex - The hex string to check and prefix if needed
   * @returns The hex string with 0x prefix
   */
  private ensureHexPrefix (hex: string): string {
    if (hex.startsWith('0x')) {
      return hex
    }
    return `0x${hex}`
  }

  /**
   * Submit a transact proof to the PPOI node.
   * @param txidVersion - The TXID version for this proof
   * @param chainType - The chain type identifier (e.g. "0" for EVM)
   * @param chainID - The numeric chain ID
   * @param listKey - The PPOI list key to submit the proof against
   * @param snarkProof - The zk-SNARK proof data
   * @param poiMerkleroots - Array of PPOI merkle roots used in the proof
   * @param txidMerkleroot - The RAILGUN TXID merkle root
   * @param txidMerklerootIndex - The index of the TXID merkle root
   * @param blindedCommitmentsOut - Array of blinded output commitments
   * @param railgunTxidIfHasUnshield - The RAILGUN txid if the transaction includes an unshield
   */
  async submitTransactProof (
    txidVersion: TXIDVersion,
    chainType: string,
    chainID: number,
    listKey: string,
    snarkProof: Proof,
    poiMerkleroots: string[],
    txidMerkleroot: string,
    txidMerklerootIndex: number,
    blindedCommitmentsOut: string[],
    railgunTxidIfHasUnshield: Optional<string>
  ): Promise<void> {
    const params = {
      chainType,
      chainID: chainID.toString(),
      txidVersion,
      listKey,
      transactProofData: {
        snarkProof,
        //  TXID merkleroot must NOT have 0x prefix
        // The PPOI node database stores txid merkleroots without 0x prefix
        // If we add 0x prefix, validation will fail with "Invalid txid merkleroot"
        txidMerkleroot: txidMerkleroot.startsWith('0x') ? txidMerkleroot.slice(2) : txidMerkleroot,
        txidMerklerootIndex,
        //  PPOI merkle roots must NOT have 0x prefix
        // The PPOI node database stores them without 0x prefix
        // If we add 0x prefix, validation will fail with "PPOI merkleroots must all exist"
        poiMerkleroots, // Already stripped in POIService before calling this
        blindedCommitmentsOut: blindedCommitmentsOut.map((bc) => this.ensureHexPrefix(bc)),
        railgunTxidIfHasUnshield: railgunTxidIfHasUnshield
          ? this.ensureHexPrefix(railgunTxidIfHasUnshield)
          : railgunTxidIfHasUnshield,
      },
    }

    await this.jsonRpcRequest<void>(POIJSONRPCMethod.SubmitTransactProof, params)
  }

  /**
   * Get chain info for this network.
   * @returns An object containing the chain type string and numeric chain ID
   */
  private getChainInfo (): { chainType: string; chainId: number } {
    const chainIds: Record<NetworkName, number> = {
      [NetworkName.EthereumSepolia]: 11155111,
      [NetworkName.Hardhat]: 31337,
    }

    return {
      chainType: '0', // All supported networks are Ethereum EVM chains (type 0)
      chainId: chainIds[this.networkName],
    }
  }

  /**
   * Get chain type for this network.
   * @returns The chain type string identifier
   */
  private getChainType (): string {
    return this.getChainInfo().chainType
  }

  /**
   * Get chain ID for this network.
   * @returns The chain ID as a string
   */
  private getChainID (): string {
    return this.getChainInfo().chainId.toString()
  }
}

export { TXIDVersion, PPOINodeClient }
