import { bech32m } from '@scure/base'

import { ByteUtils } from './crypto'

import type { AddressData } from '@/types/core'

const ADDRESS_LENGTH_LIMIT = 127
const ALL_CHAINS_NETWORK_ID = 'ffffffffffffffff'
const PREFIX = '0zk'
const ADDRESS_VERSION = 1

/**
 * XORs a hex-encoded chain ID with the string "railgun" to derive a network identifier.
 * @param chainID - The hex-encoded chain ID to XOR
 * @returns The XOR'd network ID as a hex string
 */
function xorNetworkID (chainID: string): string {
  const chainIDBuffer = Buffer.from(chainID, 'hex')
  const railgunBuffer = Buffer.from('railgun', 'utf8')
  const result = Buffer.alloc(chainIDBuffer.length)
  for (let i = 0; i < chainIDBuffer.length; i++) {
    const chainByte = chainIDBuffer[i] ?? 0
    const railgunByte = i < railgunBuffer.length ? (railgunBuffer[i] ?? 0) : 0
    result[i] = chainByte ^ railgunByte
  }
  return result.toString('hex')
}

/**
 * Converts a hex network ID back to chain type and chain ID, or undefined for the all-chains ID.
 * @param networkID - The hex-encoded network identifier
 * @returns The chain type and ID, or undefined if the network ID represents all chains
 */
function networkIDToChain (networkID: string): { type: number; id: number } | undefined {
  if (networkID === ALL_CHAINS_NETWORK_ID) return undefined
  return {
    type: parseInt(networkID.slice(0, 2), 16),
    id: parseInt(networkID.slice(2, 16), 16),
  }
}

/**
 * Decodes a bech32m-encoded 0zk RAILGUN address into its component public keys and chain info.
 * @param address - The bech32m-encoded RAILGUN address starting with 0zk
 * @returns The decoded address data including master public key and viewing public key
 */
function decodeRailgunAddress (address: string): AddressData {
  try {
    if (!address) throw new Error('No address to decode')

    const decoded = bech32m.decode(address as `${string}1${string}`, ADDRESS_LENGTH_LIMIT)
    if (decoded.prefix !== PREFIX) throw new Error('Invalid address prefix')

    const data = ByteUtils.hexlify(bech32m.fromWords(decoded.words))
    const version = parseInt(data.slice(0, 2), 16)
    const masterPublicKey = ByteUtils.hexToBigInt(data.slice(2, 66))
    const networkID = xorNetworkID(data.slice(66, 82))
    const viewingPublicKey = ByteUtils.hexStringToBytes(data.slice(82, 146))

    if (version !== ADDRESS_VERSION) throw new Error('Incorrect address version')

    const addressData: AddressData = {
      masterPublicKey,
      viewingPublicKey,
      version,
    }
    const chain = networkIDToChain(networkID)
    if (chain) {
      addressData.chain = chain
    }
    return addressData
  } catch (cause: unknown) {
    if (cause instanceof Error && cause.message.includes('Invalid checksum')) {
      throw new Error('Invalid checksum')
    }
    throw new Error('Failed to decode bech32 address')
  }
}

export type { AddressData }
export { decodeRailgunAddress }
