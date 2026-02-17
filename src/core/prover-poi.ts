/**
 * PPOI Proof Generation Module
 *
 * This module handles PPOI (Proof of Innocence) proof generation for RAILGUN transactions.
 *
 * commitmentsOut in POIProofInputs are PREIMAGE commitments (from railgunTransaction.commitments),
 * not blinded commitments. The circuit calculates blinded commitments from preimage + npk + position.
 * Blinded commitments are passed separately as blindedCommitmentsOut for public inputs.
 */

import type { RailgunArtifacts } from './artifacts'
import { getArtifactsPOI } from './artifacts'

import { ByteUtils } from '@/utils/crypto'
import { MERKLE_ZERO_VALUE_BIGINT } from '@/utils/railgun-crypto'

// Empty POI tree merkleroot (root of empty POI merkle tree with depth 16)
// Used for padding dummy input POI merkle proof path elements
const EMPTY_POI_MERKLEROOT = 14744269619966411208579211824598458697587494354926760081771325075741142829156n

type Proof = {
  pi_a: [string, string]
  pi_b: [[string, string], [string, string]]
  pi_c: [string, string]
}

type POIProofInputs = {
  // Public inputs
  anyRailgunTxidMerklerootAfterTransaction: string // hex
  poiMerkleroots: string[] // hex array

  // Private inputs
  boundParamsHash: string // hex
  nullifiers: string[] // hex array
  commitmentsOut: string[] // hex array - PREIMAGE commitments (from railgunTransaction.commitments)
  spendingPublicKey: [bigint, bigint]
  nullifyingKey: bigint
  token: string // hex
  randomsIn: string[] // hex array
  valuesIn: bigint[]
  utxoPositionsIn: number[] //  number[] not bigint[]
  utxoTreeIn: number
  npksOut: bigint[]
  valuesOut: bigint[]
  utxoBatchGlobalStartPositionOut: bigint
  railgunTxidIfHasUnshield: string // hex
  railgunTxidMerkleProofIndices: string // hex
  railgunTxidMerkleProofPathElements: string[] // hex array
  poiInMerkleProofIndices: string[] // hex array
  poiInMerkleProofPathElements: string[][] // hex 2D array
}

type FormattedCircuitInputsPOI = {
  // Public inputs
  anyRailgunTxidMerklerootAfterTransaction: bigint
  poiMerkleroots: bigint[]

  // Private inputs
  boundParamsHash: bigint
  nullifiers: bigint[]
  commitmentsOut: bigint[] // PREIMAGE commitments (not blinded)
  spendingPublicKey: [bigint, bigint]
  nullifyingKey: bigint
  token: bigint
  randomsIn: bigint[]
  valuesIn: bigint[]
  utxoPositionsIn: bigint[]
  utxoTreeIn: bigint
  npksOut: bigint[]
  valuesOut: bigint[]
  utxoBatchGlobalStartPositionOut: bigint
  railgunTxidIfHasUnshield: bigint
  railgunTxidMerkleProofIndices: bigint
  railgunTxidMerkleProofPathElements: bigint[]
  poiInMerkleProofIndices: bigint[]
  poiInMerkleProofPathElements: bigint[][] // 2D array: [[proof0_elements], [proof1_elements], ...]
}

type PublicInputsPOI = {
  anyRailgunTxidMerklerootAfterTransaction: bigint
  blindedCommitmentsOut: bigint[]
  poiMerkleroots: bigint[]
  railgunTxidIfHasUnshield: bigint
}

/**
 * Pad array with zeros to max length.
 * @param array - The input bigint array to pad
 * @param max - The target length to pad to
 * @param zeroValue - The value to use for padding
 * @returns The padded array with length equal to max
 */
function padWithZerosToMax (
  array: bigint[],
  max: number,
  zeroValue = MERKLE_ZERO_VALUE_BIGINT
): bigint[] {
  const padded = [...array]
  while (padded.length < max) {
    padded.push(zeroValue)
  }
  return padded
}

/**
 * Pad 2D array with zero-filled arrays to reach the target dimensions.
 * @param array - The input 2D bigint array to pad
 * @param max - The target number of inner arrays
 * @param length - The length of each padding array
 * @param zeroValue - The value to fill padding arrays with
 * @returns The padded 2D array
 */
function padWithArraysOfZerosToMaxAndLength (
  array: bigint[][],
  max: number,
  length: number,
  zeroValue = 0n
): bigint[][] {
  const padded = [...array]
  while (padded.length < max) {
    padded.push(Array(length).fill(zeroValue))
  }
  return padded
}

/**
 * Format PPOI proof inputs for circuit by converting hex strings to bigints and padding arrays.
 * @param proofInputs - The raw PPOI proof inputs with hex-encoded values
 * @param maxInputs - The maximum number of inputs for the circuit
 * @param maxOutputs - The maximum number of outputs for the circuit
 * @returns The formatted circuit inputs with all values as bigints
 */
function formatPOIInputs (
  proofInputs: POIProofInputs,
  maxInputs: number,
  maxOutputs: number
): FormattedCircuitInputsPOI {
  return {
    anyRailgunTxidMerklerootAfterTransaction: ByteUtils.hexToBigInt(
      proofInputs.anyRailgunTxidMerklerootAfterTransaction
    ),
    boundParamsHash: ByteUtils.hexToBigInt(proofInputs.boundParamsHash),
    nullifiers: padWithZerosToMax(
      proofInputs.nullifiers.map((x) => ByteUtils.hexToBigInt(x)),
      maxInputs
    ),
    commitmentsOut: padWithZerosToMax(
      proofInputs.commitmentsOut.map((x) => ByteUtils.hexToBigInt(x)),
      maxOutputs
    ),
    spendingPublicKey: proofInputs.spendingPublicKey,
    nullifyingKey: proofInputs.nullifyingKey,
    token: ByteUtils.hexToBigInt(proofInputs.token),
    randomsIn: padWithZerosToMax(
      proofInputs.randomsIn.map((x) => ByteUtils.hexToBigInt(x)),
      maxInputs
    ),
    valuesIn: padWithZerosToMax(
      proofInputs.valuesIn,
      maxOutputs,
      0n // Use Zero = 0 here
    ),
    utxoPositionsIn: padWithZerosToMax(proofInputs.utxoPositionsIn.map(BigInt), maxInputs),
    utxoTreeIn: BigInt(proofInputs.utxoTreeIn),
    npksOut: padWithZerosToMax(proofInputs.npksOut, maxOutputs),
    valuesOut: padWithZerosToMax(
      proofInputs.valuesOut,
      maxOutputs,
      0n // Use Zero = 0 here
    ),
    utxoBatchGlobalStartPositionOut: BigInt(proofInputs.utxoBatchGlobalStartPositionOut),
    railgunTxidIfHasUnshield: BigInt(proofInputs.railgunTxidIfHasUnshield),
    railgunTxidMerkleProofIndices: ByteUtils.hexToBigInt(proofInputs.railgunTxidMerkleProofIndices),
    railgunTxidMerkleProofPathElements: proofInputs.railgunTxidMerkleProofPathElements.map((x) =>
      ByteUtils.hexToBigInt(x)
    ),
    poiMerkleroots: padWithZerosToMax(
      proofInputs.poiMerkleroots.map((x) => ByteUtils.hexToBigInt(x)),
      maxInputs
    ),
    poiInMerkleProofIndices: padWithZerosToMax(
      proofInputs.poiInMerkleProofIndices.map((x) => ByteUtils.hexToBigInt(x)),
      maxInputs,
      0n // Use Zero = 0 here
    ),
    // Pad PPOI merkle proof path elements as 2D array
    // Circuit expects: [[proof0_elements], [proof1_elements], [proof2_elements]]
    // Keep the 2D structure - snarkjs will handle flattening internally
    poiInMerkleProofPathElements: padWithArraysOfZerosToMaxAndLength(
      proofInputs.poiInMerkleProofPathElements.map((pathElements) =>
        pathElements.map((x) => ByteUtils.hexToBigInt(x))
      ),
      maxInputs, // Number of proofs (3 for 3x3 circuit)
      16, // Elements per proof
      EMPTY_POI_MERKLEROOT // Use empty POI tree merkleroot for dummy input path elements
    ),
  }
}

/**
 * Get public inputs for PPOI circuit by converting hex values and padding to circuit dimensions.
 * @param anyRailgunTxidMerklerootAfterTransaction - The RAILGUN txid merkle root hex string
 * @param blindedCommitmentsOut - The blinded output commitment hex strings
 * @param poiMerkleroots - The POI merkle root hex strings
 * @param railgunTxidIfHasUnshield - The RAILGUN txid hex string if transaction includes an unshield
 * @param maxInputs - The maximum number of inputs for the circuit
 * @param maxOutputs - The maximum number of outputs for the circuit
 * @returns The formatted public inputs for the PPOI circuit
 */
function getPublicInputsPOI (
  anyRailgunTxidMerklerootAfterTransaction: string,
  blindedCommitmentsOut: string[],
  poiMerkleroots: string[],
  railgunTxidIfHasUnshield: string,
  maxInputs: number,
  maxOutputs: number
): PublicInputsPOI {
  return {
    blindedCommitmentsOut: padWithZerosToMax(
      blindedCommitmentsOut.map((x) => ByteUtils.hexToBigInt(x)),
      maxOutputs,
      0n // Use Zero = 0 for blinded commitments padding
    ),
    railgunTxidIfHasUnshield: ByteUtils.hexToBigInt(railgunTxidIfHasUnshield),
    anyRailgunTxidMerklerootAfterTransaction: ByteUtils.hexToBigInt(
      anyRailgunTxidMerklerootAfterTransaction
    ),
    poiMerkleroots: padWithZerosToMax(
      poiMerkleroots.map((x) => ByteUtils.hexToBigInt(x)),
      maxInputs
    ),
  }
}

/**
 * Determine circuit size based on inputs/outputs, selecting either the 3x3 or 13x13 circuit.
 * @param numInputs - The actual number of inputs in the transaction
 * @param numOutputs - The actual number of outputs in the transaction
 * @returns The maxInputs and maxOutputs for the selected circuit size
 */
function getCircuitSize (
  numInputs: number,
  numOutputs: number
): { maxInputs: number; maxOutputs: number } {
  if (numInputs <= 3 && numOutputs <= 3) {
    return { maxInputs: 3, maxOutputs: 3 }
  }
  return { maxInputs: 13, maxOutputs: 13 }
}

/**
 * Generate PPOI proof using snarkjs.
 * @param inputs - PPOI proof inputs with PREIMAGE commitments in commitmentsOut
 * @param blindedCommitmentsOut - Blinded output commitments (for public inputs)
 * @param onProgress - Progress callback
 * @returns The generated proof, public inputs, and public signals from the circuit
 */
async function provePOI (
  inputs: POIProofInputs,
  blindedCommitmentsOut: string[],
  onProgress?: (p: number) => void
): Promise<{ proof: Proof; publicInputs: PublicInputsPOI; publicSignals: string[] }> {
  // Determine circuit size
  const numInputs = inputs.nullifiers.length
  const numOutputs = inputs.commitmentsOut.length
  const { maxInputs, maxOutputs } = getCircuitSize(numInputs, numOutputs)

  const artifacts: RailgunArtifacts = await getArtifactsPOI(maxInputs, maxOutputs)
  onProgress?.(5)

  // Get public inputs
  const publicInputs = getPublicInputsPOI(
    inputs.anyRailgunTxidMerklerootAfterTransaction,
    blindedCommitmentsOut,
    inputs.poiMerkleroots,
    inputs.railgunTxidIfHasUnshield,
    maxInputs,
    maxOutputs
  )

  // Format inputs for circuit
  const formattedInputs = formatPOIInputs(inputs, maxInputs, maxOutputs)

  onProgress?.(10)

  try {
    // Value conservation check — the circuit enforces totalIn >= totalOut
    const totalIn = (formattedInputs as any).valuesIn.reduce(
      (sum: bigint, v: bigint) => sum + v,
      0n
    )
    const totalOut = (formattedInputs as any).valuesOut.reduce(
      (sum: bigint, v: bigint) => sum + v,
      0n
    )
    if (totalIn < totalOut) {
      throw new Error(
        `Value conservation violated: totalIn (${totalIn}) < totalOut (${totalOut}). Aborting proof generation.`
      )
    }

    const snarkjs = await import('snarkjs')

    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      formattedInputs as any,
      artifacts.wasm,
      artifacts.zkey
    )

    onProgress?.(98)

    // Format proof for PPOI node: Remove homogeneous coordinates and extra fields
    // snarkjs returns: pi_a: [x, y, 1], pi_b: [[x1, y1], [x2, y2], [1, 0]], pi_c: [x, y, 1]
    // PPOI expects: pi_a: [x, y], pi_b: [[x1, y1], [x2, y2]], pi_c: [x, y]
    const formattedProof: Proof = {
      pi_a: [proof.pi_a[0], proof.pi_a[1]],
      pi_b: [
        [proof.pi_b[0][0], proof.pi_b[0][1]],
        [proof.pi_b[1][0], proof.pi_b[1][1]],
      ],
      pi_c: [proof.pi_c[0], proof.pi_c[1]],
    }

    return {
      proof: formattedProof,
      publicInputs,
      publicSignals, // Return the actual public signals from the circuit for verification
    }
  } catch (error) {
    console.error('PPOI proof generation failed:', error)

    if (error instanceof Error) {
      if (
        error.message.includes('could not allocate memory') ||
        error.message.includes('out of memory')
      ) {
        throw new Error(
          'Browser ran out of memory during PPOI proof generation. ' +
            'Try restarting your browser, closing other tabs, or using a desktop browser. ' +
            `Original error: ${error.message}`
        )
      }
    }

    throw error
  }
}

export type {
  Proof,
  POIProofInputs,
  FormattedCircuitInputsPOI,
  PublicInputsPOI,
}
export {
  EMPTY_POI_MERKLEROOT,
  formatPOIInputs,
  getPublicInputsPOI,
  getCircuitSize,
  provePOI,
}
