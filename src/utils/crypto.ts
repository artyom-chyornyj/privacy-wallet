import { getPublicKey } from '@noble/ed25519'
import circom from '@railgun-community/circomlibjs'
import { bech32m } from '@scure/base'
import { createHmac } from 'crypto-browserify'
import { mnemonicToSeedSync } from 'ethereum-cryptography/bip39'
import { getRandomBytesSync } from 'ethereum-cryptography/random'
import { bytesToHex, hexToBytes } from 'ethereum-cryptography/utils'
import { ethers } from 'ethers'

import type { AddressData, Chain } from '@/types/core'

// Poseidon hash from circomlibjs
const poseidon = circom.poseidon
const eddsa = circom.eddsa

// Constants
const ADDRESS_LENGTH_LIMIT = 127
const ADDRESS_VERSION = 1

type ViewingKeyPair = {
  privateKey: Uint8Array
  pubkey: Uint8Array
}

type BytesData = bigint | number | ArrayLike<number> | string

// BIP32 key derivation
interface KeyNode {
  chainKey: string
  chainCode: string
}

// returns true if string is prefixed with '0x'
/**
 * Check whether a string has a 0x prefix.
 * @param str - The string to check
 * @returns True if the string starts with 0x
 */
const isPrefixed = (str: string): boolean => str.startsWith('0x')

enum ByteLength {
  UINT_8 = 1,
  UINT_56 = 7,
  UINT_120 = 15,
  UINT_128 = 16,
  Address = 20,
  UINT_192 = 24,
  UINT_248 = 31,
  UINT_256 = 32,
}

/**
 * Utility class for byte manipulation, hex conversion, and data formatting operations.
 */
class ByteUtils {
  /**
   * Bitmask for a full 32-bit unsigned integer (0xFFFFFFFF).
   */
  static readonly FULL_32_BITS = BigInt(2 ** 32 - 1)

  /**
   * Normalize a hex string to 0x-prefixed, lowercase, zero-padded to 64 hex chars (32 bytes).
   * @param hex - The hex string to normalize
   * @returns A lowercase 0x-prefixed hex string padded to 32 bytes
   */
  static normalizeHex256 (hex: string): string {
    const h = (hex || '').toLowerCase().replace(/^0x/, '')
    return `0x${h.padStart(64, '0')}`
  }

  // add 0x if it str isn't already prefixed
  /**
   * Add 0x prefix to a string if it is not already prefixed.
   * @param str - The string to prefix
   * @returns The 0x-prefixed string
   */
  static prefix0x = (str: string): string => (isPrefixed(str) ? str : `0x${str}`)

  // remove 0x prefix if it exists
  /**
   * Remove 0x prefix from a string if it exists.
   * @param str - The string to strip
   * @returns The string without 0x prefix
   */
  static strip0x = (str: string): string => (isPrefixed(str) ? str.slice(2) : str)

  /**
   * Convert a hex string to a Uint8Array using ethereum-cryptography hexToBytes.
   */
  static hexToBytes = hexToBytes

  /**
   * Convert hex string to BigInt, prefixing with 0x if necessary.
   * @param str - The hex string to convert
   * @returns The BigInt representation of the hex string
   */
  static hexToBigInt (str: string): bigint {
    return BigInt(ByteUtils.prefix0x(str))
  }

  /**
   * Convert a Uint8Array to a BigInt by first converting to hex.
   * @param u8 - The Uint8Array to convert
   * @returns The BigInt representation
   */
  static u8ToBigInt (u8: Uint8Array): bigint {
    return ByteUtils.hexToBigInt(ByteUtils.hexlify(u8))
  }

  /**
   * Coerces BytesData into hex string format
   * @param data - bytes data to coerce
   * @param prefix - prefix with 0x
   * @returns hex string
   */
  static hexlify (data: BytesData, prefix = false): string {
    let hexString = ''

    if (typeof data === 'string') {
      // If we're already a string return the string
      // Strip leading 0x if it exists before returning
      hexString = ByteUtils.strip0x(data)
    } else if (typeof data === 'bigint' || typeof data === 'number') {
      hexString = data.toString(16)
      if (hexString.length % 2 === 1) {
        hexString = `0${hexString}`
      }
    } else {
      // We're an ArrayLike
      // Coerce ArrayLike to Array
      const dataArray: number[] = Array.from(data)

      // Convert array of bytes to hex string
      hexString = dataArray.map((byte) => byte.toString(16).padStart(2, '0')).join('')
    }

    // Return 0x prefixed hex string if specified
    if (prefix) {
      return `0x${hexString}`.toLowerCase()
    }

    // Else return plain hex string
    return hexString.toLowerCase()
  }

  /**
   * Coerces BytesData into array of bytes
   * @param data - bytes data to coerce
   * @returns byte array
   */
  static arrayify (data: BytesData): number[] {
    // If we're already a byte array return array coerced data
    if (typeof data !== 'string' && typeof data !== 'bigint' && typeof data !== 'number') {
      return Array.from(data)
    }

    // Remove leading 0x if exists
    const dataFormatted =
      typeof data === 'bigint' || typeof data === 'number'
        ? ByteUtils.hexlify(data)
        : ByteUtils.strip0x(data)

    // Create empty array
    const bytesArray: number[] = []

    // Loop through each byte and push to array
    for (let i = 0; i < dataFormatted.length; i += 2) {
      const number = parseInt(dataFormatted.substr(i, 2), 16)
      if (Number.isNaN(number)) {
        throw new Error('Invalid BytesData')
      } else {
        bytesArray.push(number)
      }
    }

    // Return bytes array
    return bytesArray
  }

  /**
   * Pads BytesData to specified length
   * @param data - bytes data
   * @param length - length in bytes to pad to
   * @param side - whether to pad left or right
   * @returns padded bytes data
   */
  static padToLength (
    data: BytesData,
    length: number,
    side: 'left' | 'right' = 'left'
  ): string | number[] {
    if (typeof data === 'bigint' || typeof data === 'number') {
      if (side === 'left') {
        return data.toString(16).padStart(length * 2, '0')
      }
      return data.toString(16).padEnd(length * 2, '0')
    }

    if (typeof data === 'string') {
      const dataFormattedString = ByteUtils.strip0x(data)

      // If we're requested to pad to left, pad left and return
      if (side === 'left') {
        return data.startsWith('0x')
          ? `0x${dataFormattedString.padStart(length * 2, '0')}`
          : dataFormattedString.padStart(length * 2, '0')
      }

      // Else pad right and return
      return data.startsWith('0x')
        ? `0x${dataFormattedString.padEnd(length * 2, '0')}`
        : dataFormattedString.padEnd(length * 2, '0')
    }

    // Coerce data into array
    const dataArray = Array.from(data)

    if (side === 'left') {
      // If side is left, unshift till length
      while (dataArray.length < length) {
        dataArray.unshift(0)
      }
    } else {
      // If side is right, push till length
      while (dataArray.length < length) {
        dataArray.push(0)
      }
    }

    // Return dataArray
    return dataArray
  }

  /**
   * Split bytes into array of chunks
   * @param data - data to chunk
   * @param size - size of chunks
   * @returns chunked data
   */
  static chunk (data: BytesData, size = ByteLength.UINT_256): string[] {
    // Convert to hex string
    const dataFormatted = ByteUtils.hexlify(data)

    // Split into byte chunks and return
    return dataFormatted.match(new RegExp(`.{1,${size * 2}}`, 'g')) || []
  }

  /**
   * Combines array of BytesData into single BytesData
   * @param data - data to combine
   * @returns combined data
   */
  static combine (data: BytesData[]): string {
    // Convert all chunks into hex strings
    const dataFormatted = data.map((element) => ByteUtils.hexlify(element))

    // Combine and return
    return dataFormatted.join('')
  }

  /**
   * Trim to length of bytes
   * @param data - data to trim
   * @param length - length to trim to
   * @param side - side to trim from
   * @returns trimmed data
   */
  static trim (data: BytesData, length: number, side: 'left' | 'right' = 'left'): BytesData {
    if (typeof data === 'bigint' || typeof data === 'number') {
      const stringData = data.toString(16)
      const trimmedString = ByteUtils.trim(stringData, length, side) as string
      return BigInt(`0x${trimmedString}`)
    }

    if (typeof data === 'string') {
      const dataFormatted = data.startsWith('0x') ? data.slice(2) : data

      if (side === 'left') {
        // If side is left return the last length bytes
        return data.startsWith('0x')
          ? `0x${dataFormatted.slice(dataFormatted.length - length * 2)}`
          : dataFormatted.slice(dataFormatted.length - length * 2)
      }

      // Side is right, return the start of the string to length
      return data.startsWith('0x')
        ? `0x${dataFormatted.slice(0, length * 2)}`
        : dataFormatted.slice(0, length * 2)
    }

    // Coerce to array
    const dataFormatted = Array.from(data)

    if (side === 'left') {
      // If side is left return the last length bytes
      return dataFormatted.slice(data.length - length)
    }

    // Side is right, return the start of the array to length
    return dataFormatted.slice(0, length)
  }

  /**
   * Format through hexlify, trim and padToLength given a number of bytes.
   * @param data - data to format
   * @param length - length to format to
   * @param prefix - whether to include 0x prefix
   * @returns formatted data
   */
  static formatToByteLength (data: BytesData, length: ByteLength, prefix = false): string {
    const hex = ByteUtils.hexlify(data, prefix)
    const padded = ByteUtils.padToLength(hex, length)
    const trimmed = ByteUtils.trim(padded, length) as string
    return trimmed
  }

  /**
   * Convert bigint to hex string, 0-padded to even length.
   * @param n - a bigint
   * @param byteLength - target byte length to pad to
   * @param prefix - prefix hex with 0x
   * @returns even-length hex
   */
  static nToHex (n: bigint, byteLength: ByteLength, prefix: boolean = false): string {
    if (n < 0) throw new Error('bigint must be positive')
    const hex = ByteUtils.formatToByteLength(n.toString(16), byteLength, prefix)
    return prefix ? ByteUtils.prefix0x(hex) : hex
  }

  /**
   * Convert bigint to Uint8Array
   * @param n - The bigint value to convert
   * @param byteLength - Target byte length
   * @returns Uint8Array representation
   */
  static nToBytes (n: bigint, byteLength: ByteLength): Uint8Array {
    return ByteUtils.hexToBytes(ByteUtils.nToHex(n, byteLength))
  }

  /**
   * Convert Uint8Array to bigint.
   * @param bytes - The byte array to convert
   * @returns The bigint representation
   */
  static bytesToN (bytes: Uint8Array): bigint {
    const prefix = true
    return BigInt(ByteUtils.hexlify(bytes, prefix))
  }

  /**
   * Convert hex string to Uint8Array. Handles prefixed or non-prefixed.
   * @param hex - The hex string to convert
   * @returns Uint8Array representation
   */
  static hexStringToBytes (hex: string): Uint8Array {
    return ByteUtils.hexToBytes(ByteUtils.strip0x(hex))
  }

  /**
   * Convert hex string to Uint8Array. Does not handle 0x prefixes, and assumes
   * your string has an even number of characters.
   * @param str - The unprefixed hex string to convert
   * @returns The Uint8Array representation
   */
  static fastHexToBytes (str: string): Uint8Array {
    const bytes = new Uint8Array(str.length / 2)
    for (let i = 0; i < bytes.length; i += 1) {
      const c1 = str.charCodeAt(i * 2)
      const c2 = str.charCodeAt(i * 2 + 1)
      const n1 = c1 - (c1 < 58 ? 48 : 87)
      const n2 = c2 - (c2 < 58 ? 48 : 87)
      bytes[i] = n1 * 16 + n2
    }
    return bytes
  }

  /**
   * Convert Uint8Array to hex string. Does not output 0x prefixes.
   * @param bytes - The byte array to convert
   * @returns The unprefixed hex string
   */
  static fastBytesToHex (bytes: Uint8Array): string {
    const hex = new Array(bytes.length * 2)
    for (let i = 0; i < bytes.length; i += 1) {
      const n = bytes[i] ?? 0
      const c1 = (n / 16) | 0
      const c2 = n % 16
      hex[2 * i] = String.fromCharCode(c1 + (c1 < 10 ? 48 : 87))
      hex[2 * i + 1] = String.fromCharCode(c2 + (c2 < 10 ? 48 : 87))
    }
    return hex.join('')
  }

  /**
   * Generates random bytes
   * @param length - number of bytes to generate
   * @returns random bytes hex string WITHOUT 0x prefix
   */
  static randomHex (length: number = 32): string {
    return bytesToHex(getRandomBytesSync(length))
  }
}

/**
 * Creates KeyNode from seed ( bip32.ts).
 * @param seed - The hex-encoded seed from mnemonic
 * @returns The master KeyNode with chainKey and chainCode
 */
function getMasterKeyFromSeed (seed: string): KeyNode {
  const CURVE_SEED = ethers.hexlify(new TextEncoder().encode('babyjubjub seed')).slice(2) // Convert to hex string without 0x

  // HMAC with seed to get I
  const I = sha512HMAC(CURVE_SEED, seed)

  // Slice 32 bytes for IL and IR values, IL = key, IR = chainCode
  const chainKey = I.slice(0, 64)
  const chainCode = I.slice(64)

  return { chainKey, chainCode }
}

/**
 * Derive child KeyNode from KeyNode via hardened derivation ( bip32.ts).
 * @param node - The parent KeyNode to derive from
 * @param index - The child index for derivation
 * @param offset - The hardened derivation offset, defaults to 0x80000000
 * @returns The derived child KeyNode
 */
function childKeyDerivationHardened (
  node: KeyNode,
  index: number,
  offset: number = 0x80000000
): KeyNode {
  // Convert index to bytes as 32bit big endian
  const indexFormatted = padToLength(index + offset, 4)

  // Calculate HMAC preImage
  const preImage = `00${node.chainKey}${indexFormatted}`

  // Calculate I
  const I = sha512HMAC(node.chainCode, preImage)

  // Slice 32 bytes for IL and IR values, IL = key, IR = chainCode
  const chainKey = I.slice(0, 64)
  const chainCode = I.slice(64)

  return { chainKey, chainCode }
}

/**
 * Convert path string into segments ( bip32.ts).
 * @param path - The BIP32 derivation path string (e.g. "m/44'/1984'/0'/0'/0'")
 * @returns An array of numeric path segment indices
 */
function getPathSegments (path: string): number[] {
  if (!path.startsWith('m/')) {
    throw new Error('Invalid path')
  }

  const segments = path.substring(2).split('/')
  return segments.map((segment) => {
    if (segment.endsWith("'")) {
      return parseInt(segment.slice(0, -1), 10)
    }
    return parseInt(segment, 10)
  })
}

/**
 * Pad to byte length (helper function).
 * @param value - The numeric value to pad
 * @param length - The target byte length
 * @returns A zero-padded hex string
 */
function padToLength (value: number, length: number): string {
  return value.toString(16).padStart(length * 2, '0')
}

/**
 * SHA512 HMAC (helper function).
 * @param key - The HMAC key as a hex string
 * @param data - The data to authenticate as a hex string
 * @returns The HMAC-SHA512 digest as a hex string
 */
function sha512HMAC (key: string, data: string): string {
  const keyBuffer = Buffer.from(key, 'hex')
  const dataBuffer = Buffer.from(data, 'hex')
  const hmac = createHmac('sha512', keyBuffer)
  hmac.update(dataBuffer)
  return hmac.digest('hex')
}

/**
 * BIP32 WalletNode for RAILGUN key derivation
 */
class WalletNode {
  /**
   * The BIP32 chain key (private key material) for this node.
   */
  private chainKey: string
  /**
   * The BIP32 chain code used for child key derivation.
   */
  private chainCode: string

  /**
   * Create a WalletNode from a KeyNode containing chain key and chain code.
   * @param keyNode - The KeyNode with chainKey and chainCode
   */
  constructor (keyNode: KeyNode) {
    this.chainKey = keyNode.chainKey
    this.chainCode = keyNode.chainCode
  }

  /**
   * Create BIP32 node from mnemonic.
   * @param mnemonic - The BIP39 mnemonic phrase
   * @returns A new WalletNode derived from the mnemonic seed
   */
  static fromMnemonic (mnemonic: string): WalletNode {
    const seed = Mnemonic.toSeed(mnemonic)
    return new WalletNode(getMasterKeyFromSeed(seed))
  }

  /**
   * Derives new BIP32Node along path.
   * @param path - The BIP32 derivation path string
   * @returns A new WalletNode derived along the specified path
   */
  derive (path: string): WalletNode {
    const segments = getPathSegments(path)
    const keyNode = segments.reduce(
      (parentKeys: KeyNode, segment: number) =>
        childKeyDerivationHardened(parentKeys, segment, 0x80000000),
      {
        chainKey: this.chainKey,
        chainCode: this.chainCode,
      }
    )
    return new WalletNode(keyNode)
  }

  /**
   * Get spending key-pair (babyjubjub).
   * @returns The spending private key and babyjubjub public key pair
   */
  getSpendingKeyPair (): { privateKey: Uint8Array; pubkey: [bigint, bigint] } {
    const privateKey = ByteUtils.hexStringToBytes(this.chainKey)
    const pubkey = getPublicSpendingKey(privateKey)
    return { privateKey, pubkey }
  }

  /**
   * Get viewing key-pair (ed25519).
   * @returns The viewing private key and ed25519 public key pair
   */
  async getViewingKeyPair (): Promise<ViewingKeyPair> {
    const privateKey = ByteUtils.hexStringToBytes(this.chainKey)
    const pubkey = await getPublicViewingKey(privateKey)
    return { privateKey, pubkey }
  }

  /**
   * Derive the nullifying key as the Poseidon hash of the viewing private key.
   * @returns The nullifying key as a bigint
   */
  async getNullifyingKey (): Promise<bigint> {
    const { privateKey } = await this.getViewingKeyPair()
    return poseidon([ByteUtils.hexToBigInt(bytesToHex(privateKey))])
  }

  /**
   * Compute the master public key as the Poseidon hash of the spending public key and nullifying key.
   * @param spendingPublicKey - The babyjubjub spending public key pair
   * @param nullifyingKey - The nullifying key derived from the viewing key
   * @returns The master public key as a bigint
   */
  static getMasterPublicKey (spendingPublicKey: [bigint, bigint], nullifyingKey: bigint): bigint {
    return poseidon([...spendingPublicKey, nullifyingKey])
  }
}

/**
 * Derive the ed25519 public viewing key from a private viewing key.
 * @param privateViewingKey - The private viewing key bytes
 * @returns The public viewing key as a Uint8Array
 */
async function getPublicViewingKey (privateViewingKey: Uint8Array): Promise<Uint8Array> {
  return getPublicKey(privateViewingKey)
}

/**
 * Derive the babyjubjub public spending key from a private spending key.
 * @param privateSpendingKey - The private spending key bytes
 * @returns The public spending key as a pair of bigints
 */
function getPublicSpendingKey (privateSpendingKey: Uint8Array): [bigint, bigint] {
  return eddsa.prv2pub(Buffer.from(privateSpendingKey))
}

/**
 * Mnemonic helper for BIP39 seed derivation.
 */
class Mnemonic {
  /**
   * Convert a BIP39 mnemonic phrase to a hex-encoded seed.
   * @param mnemonic - The BIP39 mnemonic phrase
   * @param password - Optional passphrase for seed derivation
   * @returns The hex-encoded seed string
   */
  static toSeed (mnemonic: string, password: string = ''): string {
    const seed = mnemonicToSeedSync(mnemonic, password)
    return bytesToHex(seed)
  }
}

interface KeyDerivationResult {
  masterPublicKey: bigint
  spendingPublicKey: [bigint, bigint]
  viewingPublicKey: Uint8Array
  spendingKey: Uint8Array
  viewingKey: Uint8Array
  nullifyingKey: bigint
}

const ALL_CHAINS_NETWORK_ID = 'ffffffffffffffff'

// Chain encoding functions /src/chain/chain.ts
/**
 * Encode a Chain into a full 8-byte network ID string (1 byte type + 7 bytes chain ID).
 * @param chain - The chain object with type and id
 * @returns The hex-encoded 8-byte network ID
 */
const getChainFullNetworkID = (chain: Chain): string => {
  // 1 byte: chainType.
  const formattedChainType = ByteUtils.formatToByteLength(
    ByteUtils.hexlify(chain.type),
    ByteLength.UINT_8 // 1 byte
  )
  // 7 bytes: chainID.
  const formattedChainID = ByteUtils.formatToByteLength(
    ByteUtils.hexlify(chain.id),
    ByteLength.UINT_56 // 7 bytes
  )
  return `${formattedChainType}${formattedChainID}`
}

/**
 * XOR a network ID with the string 'railgun' to make the resulting address more visually distinct.
 * @param chainID - hex value of chainID
 * @returns chainID XOR'd with 'railgun' to make address prettier
 */
const xorNetworkID = (chainID: string) => {
  const chainIDBuffer = Buffer.from(chainID, 'hex')
  const railgunBuffer = Buffer.from('railgun', 'utf8')

  // Create result buffer with same length as chainID
  const result = Buffer.alloc(chainIDBuffer.length)

  // XOR each byte, using 0 for railgun bytes beyond its length
  for (let i = 0; i < chainIDBuffer.length; i++) {
    const railgunByte = i < railgunBuffer.length ? (railgunBuffer[i] ?? 0) : 0
    const chainByte = chainIDBuffer[i] ?? 0
    result[i] = chainByte ^ railgunByte
  }

  return result.toString('hex')
}

/**
 * Convert an optional Chain to its network ID, returning the all-chains ID if no chain is specified.
 * @param chain - The optional chain object
 * @returns The hex-encoded network ID string
 */
const chainToNetworkID = (chain?: Chain): string => {
  if (chain == null) {
    return ALL_CHAINS_NETWORK_ID
  }

  const networkID = getChainFullNetworkID(chain)
  return networkID
}

/**
 * Bech32m-encode address data into a 0zk-prefixed RAILGUN address string.
 * @param addressData - The address data containing master public key, viewing key, and optional chain
 * @returns The bech32m-encoded RAILGUN address
 */
function encodeAddress (addressData: AddressData): string {
  const masterPublicKey = ByteUtils.nToHex(addressData.masterPublicKey, ByteLength.UINT_256, false)
  const viewingPublicKey = ByteUtils.formatToByteLength(
    addressData.viewingPublicKey,
    ByteLength.UINT_256
  )

  const { chain } = addressData
  const networkID = xorNetworkID(chainToNetworkID(chain))

  const version = '01'

  const addressString = `${version}${masterPublicKey}${networkID}${viewingPublicKey}`

  // Create 73 byte address buffer
  const addressBuffer = Buffer.from(addressString, 'hex')

  // Encode address
  const address = bech32m.encode('0zk', bech32m.toWords(addressBuffer), ADDRESS_LENGTH_LIMIT)

  return address
}

/**
 * Derive all RAILGUN master keys (spending, viewing, nullifying, and master public key) from a mnemonic.
 * @param mnemonic - The BIP39 mnemonic phrase
 * @param index - The wallet index for key derivation, defaults to 0
 * @returns The full set of derived keys including master public key, spending/viewing key pairs, and nullifying key
 */
async function deriveMasterKeysFromMnemonic (
  mnemonic: string,
  index: number = 0
): Promise<KeyDerivationResult> {
  // Create separate master nodes for each derivation path
  const spendingPath = `m/44'/1984'/0'/0'/${index}'`
  const viewingPath = `m/420'/1984'/0'/0'/${index}'`

  // Create fresh master node from mnemonic for each derivation
  const spendingNode = WalletNode.fromMnemonic(mnemonic).derive(spendingPath)
  const viewingNode = WalletNode.fromMnemonic(mnemonic).derive(viewingPath)

  const spendingKeyPair = spendingNode.getSpendingKeyPair()
  const viewingKeyPair = await viewingNode.getViewingKeyPair()

  // Calculate nullifying key
  const nullifyingKey = await viewingNode.getNullifyingKey()

  // Calculate master public key
  const masterPublicKey = WalletNode.getMasterPublicKey(spendingKeyPair.pubkey, nullifyingKey)

  return {
    masterPublicKey,
    spendingPublicKey: spendingKeyPair.pubkey,
    viewingPublicKey: viewingKeyPair.pubkey,
    spendingKey: spendingKeyPair.privateKey,
    viewingKey: viewingKeyPair.privateKey,
    nullifyingKey,
  }
}

/**
 * Alias for deriveMasterKeysFromMnemonic - some tests expect this name
 */
const deriveRailgunKeys = deriveMasterKeysFromMnemonic

/**
 * Generate Railgun address from keys.
 * @param masterPublicKey - The master public key as a bigint
 * @param viewingPublicKey - The viewing public key bytes
 * @param chainId - Optional chain ID to encode into the address
 * @returns The bech32m-encoded 0zk RAILGUN address
 */
function generateRailgunAddress (
  masterPublicKey: bigint,
  viewingPublicKey: Uint8Array,
  chainId?: number
): string {
  const addressData: AddressData = {
    masterPublicKey,
    viewingPublicKey,
    version: ADDRESS_VERSION,
  }

  if (chainId) {
    addressData.chain = {
      type: 0, // Ethereum-like chains use type 0
      id: chainId,
    }
  }

  return encodeAddress(addressData)
}

/**
 * Generate Ethereum address from mnemonic using standard BIP44 derivation path.
 * @param mnemonic - The BIP39 mnemonic phrase
 * @param index - The account index for derivation, defaults to 0
 * @returns The checksummed Ethereum address
 */
function getEthereumAddress (mnemonic: string, index: number = 0): string {
  const path = `m/44'/60'/0'/0/${index}`
  const wallet = ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(mnemonic), path)
  return wallet.address
}

/**
 * Generate a new random 12-word BIP39 mnemonic phrase.
 * @returns The generated mnemonic phrase
 */
function generateMnemonic (): string {
  return ethers.Mnemonic.entropyToPhrase(ethers.randomBytes(16))
}

/**
 * Validate a mnemonic phrase.
 * @param mnemonic - The mnemonic phrase to validate
 * @returns True if the mnemonic is a valid BIP39 phrase
 */
function validateMnemonic (mnemonic: string): boolean {
  try {
    ethers.Mnemonic.fromPhrase(mnemonic)
    return true
  } catch {
    return false
  }
}

export type { BytesData }
export {
  ByteLength,
  ByteUtils,
  getPublicViewingKey,
  getPublicSpendingKey,
  getChainFullNetworkID,
  deriveMasterKeysFromMnemonic,
  deriveRailgunKeys,
  generateRailgunAddress,
  getEthereumAddress,
  generateMnemonic,
  validateMnemonic,
}
