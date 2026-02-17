import * as ed from '@noble/ed25519'
import { sha512 as sha512Hash } from '@noble/hashes/sha2.js'
import type { BytesLike } from 'ethers'
import { ethers } from 'ethers'

import { ByteLength, ByteUtils } from './crypto'
import { scalarMultiplyWasmFallbackToJavascript } from './scalar-multiply'

// Set up sync hashing for ed25519 (required for sync operations)
ed.hashes.sha512 = sha512Hash

// Extract needed utilities from ed25519 v3
const { bytesToHex, invert } = ed.etc
const Point = ed.Point
// CURVE is a function in v3, call it to get the curve params
const CURVE = Point.CURVE()

/**
 * RAILGUN cryptographic utilities
 * Used for commitment decryption and key derivation
 */

const SNARK_PRIME = BigInt(
  '21888242871839275222246405745257275088548364400416034343698204186575808495617'
)

const MERKLE_ZERO_VALUE_BIGINT: bigint =
  ByteUtils.hexToBigInt(ethers.keccak256(ethers.toUtf8Bytes('Railgun'))) % SNARK_PRIME

/**
 * Calculates sha512 hash of bytes
 * @param preImage - bytesdata
 * @returns hash
 */
function sha512 (preImage: BytesLike): string {
  return ethers.sha512(bytesLikeify(preImage)).slice(2)
}

/**
 * Convert BytesLike data into a Uint8Array.
 * @param data - The bytes-like data to convert
 * @returns A Uint8Array representation of the input data
 */
const bytesLikeify = (data: BytesLike): Uint8Array => {
  return new Uint8Array(ByteUtils.arrayify(data))
}

/**
 * Calculates sha256 hash of bytes.
 * @param preImage - The bytes-like data to hash
 * @returns The hex-encoded hash string without 0x prefix
 */
function sha256 (preImage: BytesLike): string {
  // Hash and return
  return ethers.sha256(bytesLikeify(preImage)).slice(2)
}

/**
 * Keys utilities /src/utils/keys-utils.ts
 */

/**
 * Adjust bits to match the pattern xxxxx000...01xxxxxx for little endian and 01xxxxxx...xxxxx000 for big endian
 * This ensures that the bytes are a little endian representation of an integer of the form (2^254 + 8) * x where
 * 0 \< x \<= 2^251 - 1, which can be decoded as an X25519 integer.
 * @param bytes - bytes to adjust
 * @param endian - what endian to use
 * @returns adjusted bytes
 */
function adjustBytes25519 (bytes: Uint8Array, endian: 'be' | 'le'): Uint8Array {
  // Create new array to prevent side effects
  const adjustedBytes = new Uint8Array(bytes)

  if (adjustedBytes.length < 32) {
    throw new Error('adjustBytes25519 requires at least 32 bytes')
  }

  if (endian === 'be') {
    // BIG ENDIAN
    // AND operation to ensure the last 3 bits of the last byte are 0 leaving the rest unchanged
    adjustedBytes[31] = (adjustedBytes[31] ?? 0) & 0b11111000

    // AND operation to ensure the first bit of the first byte is 0 leaving the rest unchanged
    adjustedBytes[0] = (adjustedBytes[0] ?? 0) & 0b01111111

    // OR operation to ensure the second bit of the first byte is 0 leaving the rest unchanged
    adjustedBytes[0] = (adjustedBytes[0] ?? 0) | 0b01000000
  } else {
    // LITTLE ENDIAN
    // AND operation to ensure the last 3 bits of the first byte are 0 leaving the rest unchanged
    adjustedBytes[0] = (adjustedBytes[0] ?? 0) & 0b11111000

    // AND operation to ensure the first bit of the last byte is 0 leaving the rest unchanged
    adjustedBytes[31] = (adjustedBytes[31] ?? 0) & 0b01111111

    // OR operation to ensure the second bit of the last byte is 0 leaving the rest unchanged
    adjustedBytes[31] = (adjustedBytes[31] ?? 0) | 0b01000000
  }

  // Return adjusted bytes
  return adjustedBytes
}

/**
 * Get private scalar from private key by hashing with SHA-512 and adjusting for X25519.
 * @param privateKey - The 32-byte private key
 * @returns The derived scalar value as a bigint
 */
async function getPrivateScalarFromPrivateKey (privateKey: Uint8Array): Promise<bigint> {
  // Private key should be 32 bytes
  if (privateKey.length !== 32) throw new Error('Expected 32 bytes')

  // SHA512 hash private key using the hash from @noble/hashes
  const hash = sha512Hash(privateKey)

  // Get key head, this is the first 32 bytes of the hash
  // We aren't interested in the rest of the hash as we only want the scalar
  const head = adjustBytes25519(hash.slice(0, 32), 'le')

  // Convert head to scalar - CURVE.n is the order of the curve (was CURVE.l in v2)
  const scalar = BigInt(`0x${bytesToHex(new Uint8Array([...head].reverse()))}`) % CURVE.n

  return scalar > 0n ? scalar : CURVE.n
}

/**
 * Get shared symmetric key between two parties using ECDH on ed25519.
 * /src/utils/keys-utils.ts
 * @param privateKeyPairA - The private key of party A
 * @param blindedPublicKeyPairB - The blinded public key of party B (ephemeral key)
 * @returns The 32-byte shared symmetric key, or null if derivation fails
 */
async function getSharedSymmetricKey (
  privateKeyPairA: Uint8Array,
  blindedPublicKeyPairB: Uint8Array
): Promise<Uint8Array | null> {
  try {
    // Retrieve private scalar from private key
    const scalar: bigint = await getPrivateScalarFromPrivateKey(privateKeyPairA)

    // Multiply ephemeral key by private scalar to get shared key
    const keyPreimage: Uint8Array = scalarMultiplyWasmFallbackToJavascript(
      blindedPublicKeyPairB,
      scalar
    )

    // SHA256 hash to get the final key
    const hashed: Uint8Array = ByteUtils.hexStringToBytes(sha256(keyPreimage))
    return hashed
  } catch (err) {
    return null
  }
}

/**
 * Compute the RAILGUN token data hash for ERC20, ERC721, or ERC1155 tokens.
 * @param token - The token descriptor object
 * @param token.tokenType - The token standard type (0=ERC20, 1=ERC721, 2=ERC1155 or string)
 * @param token.tokenAddress - The token contract address
 * @param token.tokenSubID - Optional sub-ID for ERC721/ERC1155 tokens
 * @returns The token data hash as a hex string
 */
function getTokenDataHash (token: {
  tokenType: number | string
  tokenAddress: string
  tokenSubID?: string
}): string {
  // ERC20: 32-byte padded token address (as hex string)
  // ERC721/1155: keccak256([type, address, subId]) mod SNARK_PRIME (as hex string)

  /**
   * Resolve a token type from a number or string identifier to a numeric value.
   * @param tt - The token type as a number or string (e.g. "ERC20", "ERC721")
   * @returns The numeric token type (0=ERC20, 1=ERC721, 2=ERC1155)
   */
  const resolveTokenType = (tt: number | string): number => {
    if (typeof tt === 'number') return tt
    const tts = String(tt).toUpperCase()
    if (tts === 'ERC20') return 0
    if (tts === 'ERC721') return 1
    if (tts === 'ERC1155') return 2
    // Fallback: try numeric string
    const parsed = Number(tt)
    return Number.isFinite(parsed) ? parsed : 0
  }

  const tokenTypeNum = resolveTokenType(token.tokenType)

  // ERC20 hash is simply the 32-byte padded address (as hex string)
  if (tokenTypeNum === 0) {
    return ByteUtils.formatToByteLength(token.tokenAddress, ByteLength.UINT_256)
  }

  // NFT hash: keccak256 of 32-byte type, 32-byte address, 32-byte subID, then mod SNARK_PRIME
  const combinedHex = ByteUtils.combine([
    ByteUtils.nToBytes(BigInt(tokenTypeNum), ByteLength.UINT_256),
    ByteUtils.hexToBytes(ByteUtils.formatToByteLength(token.tokenAddress, ByteLength.UINT_256)),
    ByteUtils.nToBytes(BigInt(token.tokenSubID || '0'), ByteLength.UINT_256),
  ])

  const hashed = ethers.keccak256(`0x${combinedHex}`)
  const modulo = BigInt(hashed) % SNARK_PRIME
  return ByteUtils.nToHex(modulo, ByteLength.UINT_256)
}

/**
 * Generate blinding scalar value by combining sender and shared random via XOR.
 * @param sharedRandom - The shared random hex string
 * @param senderRandom - The sender's random hex string
 * @returns The blinding scalar as a bigint
 */
function getBlindingScalar (sharedRandom: string, senderRandom: string): bigint {
  const sharedBigInt = ByteUtils.hexToBigInt(sharedRandom)
  const senderBigInt = ByteUtils.hexToBigInt(senderRandom)
  const xorResult = sharedBigInt ^ senderBigInt

  const finalRandom = ByteUtils.nToBytes(xorResult, 32)
  const scalar = ByteUtils.bytesToN(seedToScalar(finalRandom))

  return scalar
}

/**
 * Converts seed bytes to a valid ed25519 curve scalar via SHA-512 and modular reduction.
 * @param seed - The seed bytes to convert
 * @returns The scalar value as a 32-byte Uint8Array
 */
function seedToScalar (seed: Uint8Array): Uint8Array {
  // Hash to 512 bit value as per FIPS-186
  const seedHash = sha512(seed)
  // Return (seedHash mod (n - 1)) + 1 to fit to range 0 < scalar < n
  const CURVE_N = BigInt('0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3ed')
  return ByteUtils.nToBytes((ByteUtils.hexToBigInt(seedHash) % CURVE_N) - 1n + 1n, 32)
}

/**
 * Blinds sender and receiver public keys using a scalar derived from shared and sender random values.
 * EXACT COPY /src/utils/keys-utils.ts
 * @param senderViewingPublicKey - The sender's ed25519 viewing public key bytes
 * @param receiverViewingPublicKey - The receiver's ed25519 viewing public key bytes
 * @param sharedRandom - The shared random hex string
 * @param senderRandom - The sender's random hex string
 * @returns An object containing the blinded sender and receiver viewing keys
 */
function getNoteBlindingKeys (
  senderViewingPublicKey: Uint8Array,
  receiverViewingPublicKey: Uint8Array,
  sharedRandom: string,
  senderRandom: string
): { blindedSenderViewingKey: Uint8Array; blindedReceiverViewingKey: Uint8Array } {
  const blindingScalar = getBlindingScalar(sharedRandom, senderRandom)

  // Get public key points
  const senderPublicKeyPoint = Point.fromHex(bytesToHex(senderViewingPublicKey))
  const receiverPublicKeyPoint = Point.fromHex(bytesToHex(receiverViewingPublicKey))

  // Multiply both public keys by blinding scalar
  // toBytes() replaces toRawBytes() in @noble/ed25519 v3
  const blindedSenderViewingKey = senderPublicKeyPoint.multiply(blindingScalar).toBytes()
  const blindedReceiverViewingKey = receiverPublicKeyPoint.multiply(blindingScalar).toBytes()

  // Return blinded keys
  return { blindedSenderViewingKey, blindedReceiverViewingKey }
}

/**
 * Unblind a blinded note key to recover the original public key by inverting the blinding scalar.
 * EXACT COPY /src/utils/keys-utils.ts
 * @param blindedNoteKey - The blinded note key bytes to unblind
 * @param sharedRandom - The shared random hex string used during blinding
 * @param senderRandom - The sender's random hex string used during blinding
 * @returns The unblinded public key bytes, or null if unblinding fails
 */
function unblindNoteKey (
  blindedNoteKey: Uint8Array,
  sharedRandom: string,
  senderRandom: string
): Uint8Array | null {
  try {
    const blindingScalar = getBlindingScalar(sharedRandom, senderRandom)

    // Create curve point instance from blinded key bytes
    const point = Point.fromHex(bytesToHex(blindedNoteKey))

    // Invert the scalar to undo blinding multiplication operation
    // In v3, invert is in ed.etc and CURVE.n is the order
    const inverse = invert(blindingScalar, CURVE.n)

    // Unblind by multiplying by the inverted scalar
    const unblinded = point.multiply(inverse)

    // toRawBytes() in v3 - check if it exists, otherwise use toBytes()
    return unblinded.toBytes()
  } catch (error) {
    console.error('Error unblinding note key:', error)
    return null
  }
}

export {
  SNARK_PRIME,
  MERKLE_ZERO_VALUE_BIGINT,
  getSharedSymmetricKey,
  getTokenDataHash,
  getNoteBlindingKeys,
  unblindNoteKey,
}
