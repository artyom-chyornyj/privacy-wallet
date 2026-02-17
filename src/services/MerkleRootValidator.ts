import { ethers } from 'ethers'

import type { NetworkName } from '@/types/network'
import { NETWORK_CONFIG } from '@/types/network'
import { dwarn } from '@/utils/debug'
import { createProvider } from '@/utils/rpc'

/**
 * Merkle Root Validator Service
 *
 * Validates locally built merkle tree roots against the actual RAILGUN contract roots.
 * This is critical for proof generation - the circuit requires roots that match the contract.
 */
export class MerkleRootValidator {
  /** Singleton instance of the merkle root validator. */
  private static instance: MerkleRootValidator

  /**
   * Returns the singleton instance of MerkleRootValidator.
   * @returns The shared MerkleRootValidator instance
   */
  static getInstance (): MerkleRootValidator {
    if (!this.instance) {
      this.instance = new MerkleRootValidator()
    }
    return this.instance
  }

  /** Private constructor to enforce singleton pattern. */
  private constructor () {}

  /**
   * Validate that a locally computed merkle root matches the contract root
   * @param treeNumber - The merkle tree index to validate
   * @param localRoot - The locally computed merkle root hex string
   * @param networkName - The network to validate against
   * @param provider - Optional ethers provider; one is created if not supplied
   * @returns Validation result with match status and the on-chain contract root
   */
  async validateMerkleRoot (
    treeNumber: number,
    localRoot: string,
    networkName: NetworkName,
    provider?: ethers.Provider
  ): Promise<{ isValid: boolean; contractRoot?: string; error?: string }> {
    try {
      const network = NETWORK_CONFIG[networkName]
      if (!network) {
        return { isValid: false, error: `Network ${networkName} not found` }
      }

      // Use provided provider or create one
      const ethProvider = provider || createProvider(networkName)

      // Get contract instance
      const contract = new ethers.Contract(
        network.railgunContractAddress,
        ['function merkleRoot() view returns (bytes32)'],
        ethProvider
      )

      // Get current contract root
      const merkleRootFn = contract['merkleRoot'] as () => Promise<string>
      const contractRoot = await merkleRootFn()
      const contractRootHex = ethers.toBeHex(contractRoot)

      // Normalize both roots for comparison
      const normalizedLocal = ethers.toBeHex(localRoot)
      const normalizedContract = contractRootHex

      const isValid = normalizedLocal.toLowerCase() === normalizedContract.toLowerCase()

      if (!isValid) {
        dwarn(`Merkle root mismatch for tree ${treeNumber}:`)
        dwarn(`  Local root:    ${normalizedLocal}`)
        dwarn(`  Contract root: ${normalizedContract}`)
      }

      return {
        isValid,
        contractRoot: normalizedContract,
      }
    } catch (error) {
      console.error('Error validating merkle root:', error)
      return {
        isValid: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Get a validation function bound to specific network and provider
   * Useful for passing to merkle tree services
   * @param networkName - The network to bind the validator to
   * @param provider - Optional ethers provider for on-chain queries
   * @returns An async function that validates a merkle root for a given tree number
   */
  getValidatorFunction (
    networkName: NetworkName,
    provider?: ethers.Provider
  ): (
      tree: number,
      merkleroot: string,
    ) => Promise<{ isValid: boolean; contractRoot?: string; error?: string }> {
    return async (tree: number, merkleroot: string) => {
      return this.validateMerkleRoot(tree, merkleroot, networkName, provider)
    }
  }
}
