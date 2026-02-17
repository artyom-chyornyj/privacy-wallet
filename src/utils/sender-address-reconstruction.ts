/**
 * Utilities to reconstruct full 0zk addresses from decrypted commitment data
 *
 * Sender address reconstruction (receiver side):
 * 1. Extract sender's master public key from decrypted data
 * 2. Unblind the on-chain blinded sender viewing key
 * 3. Reconstruct the full address from MPK + VPK
 *
 * Receiver address reconstruction (sender side):
 * 1. Decode receiver's master public key from encrypted note
 * 2. Unblind the on-chain blinded receiver viewing key
 * 3. Reconstruct the full address from MPK + VPK
 */

import { ByteUtils, generateRailgunAddress } from './crypto'
import { unblindNoteKey } from './railgun-crypto'

import { derror, dlog } from '@/utils/debug'

const MEMO_SENDER_RANDOM_NULL = '0'.repeat(30) // 15 bytes of zeros

/**
 * Reconstruct full sender 0zk address from commitment data
 * @param senderMasterPublicKey - Sender's MPK (from decrypted data)
 * @param blindedSenderViewingKey - Blinded sender VPK (from on-chain ciphertext)
 * @param noteRandom - Note random value (from decrypted data)
 * @param chainId - Optional chain ID for the address
 * @returns Full 0zk address or null if reconstruction fails
 */
function reconstructSenderAddress (
  senderMasterPublicKey: string | bigint,
  blindedSenderViewingKey: string | Uint8Array,
  noteRandom: string,
  chainId?: number
): string | null {
  try {
    dlog('reconstructSenderAddress called with:', {
      senderMPK:
        typeof senderMasterPublicKey === 'string'
          ? senderMasterPublicKey.substring(0, 20) + '...'
          : senderMasterPublicKey.toString(16).substring(0, 20) + '...',
      blindedSVK:
        typeof blindedSenderViewingKey === 'string'
          ? blindedSenderViewingKey.substring(0, 20) + '...'
          : 'Uint8Array',
      noteRandom: noteRandom.substring(0, 20) + '...',
    })

    // Convert inputs to proper types
    const mpk =
      typeof senderMasterPublicKey === 'string'
        ? BigInt(
          senderMasterPublicKey.startsWith('0x')
            ? senderMasterPublicKey
            : `0x${senderMasterPublicKey}`
        )
        : senderMasterPublicKey

    const blindedKey =
      typeof blindedSenderViewingKey === 'string'
        ? ByteUtils.hexStringToBytes(blindedSenderViewingKey)
        : blindedSenderViewingKey

    // Clean noteRandom (remove 0x prefix if present)
    const cleanNoteRandom = noteRandom.startsWith('0x') ? noteRandom.slice(2) : noteRandom

    dlog('cleanNoteRandom length:', cleanNoteRandom.length, '(expected 32 for 16 bytes)')

    // Unblind the sender viewing key using note random as sharedRandom
    const senderViewingPublicKey = unblindNoteKey(
      blindedKey,
      cleanNoteRandom, // 16 bytes (32 hex) - the note random
      MEMO_SENDER_RANDOM_NULL // 15 bytes (30 hex) - zeros for visible sender
    )

    if (!senderViewingPublicKey) {
      derror('Failed to unblind sender viewing key')
      return null
    }

    dlog('Unblinded sender VPK length:', senderViewingPublicKey.length, 'bytes')

    // Reconstruct the full 0zk address
    const senderAddress = generateRailgunAddress(mpk, senderViewingPublicKey, chainId)

    dlog('Reconstructed sender address:', senderAddress?.substring(0, 30) + '...')

    return senderAddress
  } catch (error) {
    derror('Error reconstructing sender address:', error)
    return null
  }
}

/**
 * Reconstruct full receiver 0zk address from sender-decrypted commitment data
 * @param receiverMasterPublicKey - Receiver's MPK (decoded from encrypted note by sender)
 * @param blindedReceiverViewingKey - Blinded receiver VPK (from on-chain ciphertext)
 * @param noteRandom - Note random value (from decrypted data)
 * @param senderRandom - Sender random from annotation data (controls address visibility)
 * @param chainId - Optional chain ID for the address
 * @returns Full 0zk address or null if reconstruction fails
 */
function reconstructReceiverAddress (
  receiverMasterPublicKey: string | bigint,
  blindedReceiverViewingKey: string | Uint8Array,
  noteRandom: string,
  senderRandom?: string,
  chainId?: number
): string | null {
  try {
    dlog('reconstructReceiverAddress called with:', {
      receiverMPK:
        typeof receiverMasterPublicKey === 'string'
          ? receiverMasterPublicKey.substring(0, 20) + '...'
          : receiverMasterPublicKey.toString(16).substring(0, 20) + '...',
      blindedRVK:
        typeof blindedReceiverViewingKey === 'string'
          ? blindedReceiverViewingKey.substring(0, 20) + '...'
          : 'Uint8Array',
      noteRandom: noteRandom.substring(0, 20) + '...',
      hasSenderRandom: !!senderRandom,
    })

    const mpk =
      typeof receiverMasterPublicKey === 'string'
        ? BigInt(
          receiverMasterPublicKey.startsWith('0x')
            ? receiverMasterPublicKey
            : `0x${receiverMasterPublicKey}`
        )
        : receiverMasterPublicKey

    const blindedKey =
      typeof blindedReceiverViewingKey === 'string'
        ? ByteUtils.hexStringToBytes(blindedReceiverViewingKey)
        : blindedReceiverViewingKey

    const cleanNoteRandom = noteRandom.startsWith('0x') ? noteRandom.slice(2) : noteRandom

    // The blinding scalar uses both sharedRandom (noteRandom) and senderRandom.
    // senderRandom controls sender address visibility but is also part of the blinding.
    // If senderRandom is null/undefined, use MEMO_SENDER_RANDOM_NULL (visible sender mode).
    const effectiveSenderRandom = senderRandom || MEMO_SENDER_RANDOM_NULL

    // Unblind the receiver viewing key
    const receiverViewingPublicKey = unblindNoteKey(
      blindedKey,
      cleanNoteRandom,
      effectiveSenderRandom
    )

    if (!receiverViewingPublicKey) {
      derror('Failed to unblind receiver viewing key')
      return null
    }

    dlog('Unblinded receiver VPK length:', receiverViewingPublicKey.length, 'bytes')

    const receiverAddress = generateRailgunAddress(mpk, receiverViewingPublicKey, chainId)

    dlog('Reconstructed receiver address:', receiverAddress?.substring(0, 30) + '...')

    return receiverAddress
  } catch (error) {
    derror('Error reconstructing receiver address:', error)
    return null
  }
}

export { reconstructSenderAddress, reconstructReceiverAddress }
