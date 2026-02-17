/**
 * Poseidon hash utilities for RAILGUN privacy wallet
 */
import { poseidon as poseidonJS } from '@railgun-community/circomlibjs'

import { ByteUtils } from './crypto'
import { MERKLE_ZERO_VALUE_BIGINT } from './railgun-crypto'

import { derror } from '@/utils/debug'

/**
 * Calculate Poseidon hash of array of bigints
 * @param inputs - Array of bigint values to hash
 * @returns Poseidon hash result as bigint
 */
function poseidon (inputs: bigint[]): bigint {
  try {
    return poseidonJS(inputs)
  } catch (error) {
    console.error('Poseidon hash calculation failed:', error)
    throw new Error(
      `Poseidon hash failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Calculate Poseidon hash of array of hex strings
 * @param inputs - Array of hex string values to hash
 * @returns Poseidon hash result as hex string
 */
function poseidonHex (inputs: string[]): string {
  try {
    const bigIntInputs = inputs.map((hex) => ByteUtils.hexToBigInt(hex))
    return ByteUtils.nToHex(poseidon(bigIntInputs), 32, true)
  } catch (error) {
    derror('poseidonHex error:', error)
    throw error
  }
}

/**
 * Calculate railgun transaction ID
 * @param nullifiers - Array of nullifier hashes
 * @param commitments - Array of commitment hashes
 * @param boundParamsHash - Bound parameters hash
 * @returns Railgun transaction ID as bigint
 */
function calculateRailgunTxid (
  nullifiers: string[],
  commitments: string[],
  boundParamsHash: string
): bigint {
  const maxInputsOutputs = 13 // RAILGUN constant

  // Pad arrays to max size with MERKLE_ZERO_VALUE_BIGINT (NOT 0n!)
  // This must match the padding used by RailgunTxidScanner and ppoi-private
  const nullifiersPadded = [...nullifiers.map((n) => ByteUtils.hexToBigInt(n))]
  while (nullifiersPadded.length < maxInputsOutputs) {
    nullifiersPadded.push(MERKLE_ZERO_VALUE_BIGINT)
  }

  const commitmentsPadded = [...commitments.map((c) => ByteUtils.hexToBigInt(c))]
  while (commitmentsPadded.length < maxInputsOutputs) {
    commitmentsPadded.push(MERKLE_ZERO_VALUE_BIGINT)
  }

  // Calculate hashes
  const nullifiersHash = poseidon(nullifiersPadded)
  const commitmentsHash = poseidon(commitmentsPadded)
  const boundParamsHashBigInt = ByteUtils.hexToBigInt(boundParamsHash)

  // Final txid hash
  return poseidon([nullifiersHash, commitmentsHash, boundParamsHashBigInt])
}

export { poseidon, poseidonHex, calculateRailgunTxid }
