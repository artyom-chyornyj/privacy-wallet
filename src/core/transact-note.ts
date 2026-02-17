import { poseidon } from '@railgun-community/circomlibjs'

import type { AddressData } from '@/types/core'
import type { Ciphertext } from '@/utils/aes'
import { AES } from '@/utils/aes'
import { ByteLength, ByteUtils } from '@/utils/crypto'
import { decodeRailgunAddress } from '@/utils/railgun-address'
import { getTokenDataHash } from '@/utils/railgun-crypto'

enum TokenType {
  ERC20 = 0,
}

enum OutputType {
  Transfer = 0,
  Withdraw = 1,
  Change = 2,
}

interface TokenData {
  tokenAddress: string
  tokenType: TokenType
  tokenSubID: string
}

const MEMO_SENDER_RANDOM_NULL = '000000000000000000000000000000' // 15 bytes
const NOTE_RANDOM_BYTE_LENGTH = ByteLength.UINT_128 // 16 bytes
const VALUE_BYTE_LENGTH = ByteLength.UINT_128 // 16 bytes

/**
 *
 * A Note on Encoded MPKs:
 *
 * The presence of senderRandom field, or an encoded/unencoded MPK in a decrypted note,
 * tells us whether or not the sender address was hidden or visible.
 *
 *          MPK               senderRandom                                Sender address
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * Value    Unencoded         Random hex (15)                             Hidden
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 * Value    Encoded           undefined or MEMO_SENDER_RANDOM_NULL        Visible
 * - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 */

/**
 * Represents a RAILGUN transact note used for private transfers, withdrawals, and change outputs.
 */
class TransactNote {
  /**
   * Address data of the note receiver including master public key and viewing key.
   */
  readonly receiverAddressData: AddressData
  /**
   * Address data of the note sender, undefined if sender is unknown.
   */
  readonly senderAddressData: AddressData | undefined
  /**
   * Poseidon hash of the token data for commitment computation.
   */
  readonly tokenHash: string
  /**
   * Token information including address, type, and sub-ID.
   */
  readonly tokenData: TokenData
  /**
   * Random hex value used as entropy for the note commitment.
   */
  readonly random: string
  /**
   * The token amount in base units held by this note.
   */
  readonly value: bigint
  /**
   * The derived note public key, computed from the receiver's master public key and random.
   */
  readonly notePublicKey: bigint
  /**
   * The Poseidon hash of the note, used as the commitment in the Merkle tree.
   */
  readonly hash: bigint
  /**
   * The output type indicating whether this is a transfer, withdrawal, or change note.
   */
  readonly outputType: OutputType
  /**
   * Random value controlling whether the sender address is hidden or visible to the receiver.
   */
  readonly senderRandom: string
  /**
   * Optional memo text message attached to the note.
   */
  readonly memoText: string | undefined

  /**
   * Construct a new TransactNote with all required fields.
   * @param receiverAddressData - Address data of the note receiver
   * @param senderAddressData - Address data of the note sender, or undefined
   * @param random - Random hex entropy for the note commitment
   * @param value - The token amount in base units
   * @param tokenData - Token information including address and type
   * @param outputType - The type of output (transfer, withdrawal, or change)
   * @param senderRandom - Random value controlling sender address visibility
   * @param memoText - Optional memo text message
   */
  private constructor (
    receiverAddressData: AddressData,
    senderAddressData: AddressData | undefined,
    random: string,
    value: bigint,
    tokenData: TokenData,
    outputType: OutputType,
    senderRandom: string,
    memoText?: string
  ) {
    TransactNote.assertValidRandom(random)

    this.receiverAddressData = receiverAddressData
    this.senderAddressData = senderAddressData
    this.random = ByteUtils.strip0x(random)
    this.value = BigInt(value)
    this.tokenData = tokenData
    this.tokenHash = getTokenDataHash(tokenData)
    this.notePublicKey = this.getNotePublicKey()
    this.hash = TransactNote.getHash(this.notePublicKey, this.tokenHash, this.value)
    this.outputType = outputType
    this.senderRandom = senderRandom
    this.memoText = memoText
  }

  /**
   * Create a new transfer note for an ERC20 token.
   * @param recipientRailgunAddress - The 0zk-prefixed RAILGUN address of the recipient
   * @param senderAddressData - Address data of the sender
   * @param value - The token amount in base units to transfer
   * @param tokenData - Token information including address and type
   * @param showSenderAddressToRecipient - Whether the sender address is visible to the recipient
   * @param memoText - Optional memo text message
   * @returns A new TransactNote configured as a transfer
   */
  static createTransfer (
    recipientRailgunAddress: string,
    senderAddressData: AddressData,
    value: bigint,
    tokenData: TokenData,
    showSenderAddressToRecipient: boolean,
    memoText?: string
  ): TransactNote {
    const receiverAddressData = decodeRailgunAddress(recipientRailgunAddress)
    const random = TransactNote.getNoteRandom()

    const senderRandom = showSenderAddressToRecipient
      ? MEMO_SENDER_RANDOM_NULL
      : TransactNote.getSenderRandom()

    return new TransactNote(
      receiverAddressData,
      senderAddressData,
      random,
      value,
      tokenData,
      OutputType.Transfer,
      senderRandom,
      memoText
    )
  }

  /**
   * Validate that the random value is exactly 16 bytes (128 bits).
   * @param random - The random hex string to validate
   */
  private static assertValidRandom (random: string) {
    const formatted = ByteUtils.hexlify(random, false)
    if (formatted.length !== NOTE_RANDOM_BYTE_LENGTH * 2) {
      throw new Error('Random must be 16 bytes.')
    }
  }

  /**
   * Generate a cryptographically random 16-byte hex string for note entropy.
   * @returns A random hex string of 16 bytes
   */
  static getNoteRandom (): string {
    return ByteUtils.randomHex(NOTE_RANDOM_BYTE_LENGTH)
  }

  /**
   * Generate a cryptographically random 15-byte hex string for sender randomness.
   * @returns A random hex string of 15 bytes
   */
  static getSenderRandom (): string {
    return ByteUtils.randomHex(ByteLength.UINT_120)
  }

  /**
   * Encode the master public key based on sender visibility preference.
   * When the sender is hidden, returns only the receiver's MPK. When visible, XORs both MPKs.
   * @param senderRandom - The sender random value controlling visibility
   * @param receiverMasterPublicKey - The receiver's master public key
   * @param senderMasterPublicKey - The sender's master public key
   * @returns The encoded master public key for note encryption
   */
  private static getEncodedMasterPublicKey (
    senderRandom: string,
    receiverMasterPublicKey: bigint,
    senderMasterPublicKey: bigint
  ): bigint {
    const senderHidden = senderRandom !== MEMO_SENDER_RANDOM_NULL
    return senderHidden ? receiverMasterPublicKey : receiverMasterPublicKey ^ senderMasterPublicKey
  }

  /**
   * Format note fields (tokenHash, value, random) to their canonical byte-length hex representations.
   * @param prefix - Whether to include 0x prefix on hex strings
   * @returns An object with formatted tokenHash, value, and random hex strings
   */
  private formatFields (prefix: boolean = false) {
    return {
      tokenHash: ByteUtils.formatToByteLength(this.tokenHash, ByteLength.UINT_256, prefix),
      value: ByteUtils.nToHex(this.value, VALUE_BYTE_LENGTH, prefix),
      random: ByteUtils.formatToByteLength(this.random, NOTE_RANDOM_BYTE_LENGTH, prefix),
    }
  }

  /**
   * Compute the note public key as Poseidon hash of the receiver's master public key and random.
   * @returns The computed note public key as a bigint
   */
  private getNotePublicKey (): bigint {
    return poseidon([this.receiverAddressData.masterPublicKey, ByteUtils.hexToBigInt(this.random)])
  }

  /**
   * Compute the note commitment hash using Poseidon over the note public key, token hash, and value.
   * @param notePublicKey - The note's public key
   * @param tokenHash - The Poseidon hash of the token data
   * @param value - The note value in base units
   * @returns The note commitment hash as a bigint
   */
  static getHash (notePublicKey: bigint, tokenHash: string, value: bigint): bigint {
    return poseidon([notePublicKey, ByteUtils.hexToBigInt(tokenHash), value])
  }

  /**
   * Calculate nullifier for V2 (requires nullifyingKey and leaf position).
   * @param nullifyingKey - The nullifying key derived from the viewing key
   * @param position - The leaf position in the Merkle tree
   * @returns The nullifier as a bigint
   */
  static getNullifier (nullifyingKey: bigint, position: number): bigint {
    return poseidon([nullifyingKey, BigInt(position)])
  }

  /**
   * Encrypt note data for V2 using AES-256-GCM.
   * @param sharedKey - The shared symmetric key derived from sender and receiver keys
   * @param senderMasterPublicKey - The sender's master public key for encoding
   * @param viewingPrivateKey - The sender's viewing private key for annotation encryption
   * @returns The encrypted note ciphertext, memo string, and annotation data
   */
  async encryptV2 (
    sharedKey: Uint8Array,
    senderMasterPublicKey: bigint,
    viewingPrivateKey: Uint8Array
  ): Promise<{
    noteCiphertext: Ciphertext
    noteMemo: string
    annotationData: string
  }> {
    if (!this.senderRandom?.length) {
      throw new Error('Sender random must be defined for encryption')
    }

    const receiverMasterPublicKey = this.receiverAddressData.masterPublicKey
    const encodedMasterPublicKey = TransactNote.getEncodedMasterPublicKey(
      this.senderRandom,
      receiverMasterPublicKey,
      senderMasterPublicKey
    )

    const { tokenHash, value, random } = this.formatFields()

    const encodedMemoText = encodeMemoText(this.memoText)
    const ciphertext = AES.encryptGCM(
      [
        ByteUtils.nToHex(encodedMasterPublicKey, ByteLength.UINT_256),
        tokenHash,
        `${random}${value}`,
        encodedMemoText,
      ],
      sharedKey
    )

    const annotationData = createEncryptedNoteAnnotationDataV2(
      this.outputType,
      this.senderRandom,
      viewingPrivateKey
    )

    return {
      noteCiphertext: {
        ...ciphertext,
        data: ciphertext.data.slice(0, 3),
      },
      noteMemo: ciphertext.data[3] ?? '',
      annotationData,
    }
  }

  /**
   * Calculate total value of multiple notes.
   * @param notes - Array of TransactNote instances to sum
   * @returns The total value across all notes
   */
  static calculateTotalNoteValues (notes: TransactNote[]): bigint {
    return notes.reduce((total, note) => total + note.value, 0n)
  }
}

/**
 * Encode a memo text string into a 30-byte (60 hex char) representation, padding or truncating as needed.
 * @param memoText - The optional memo text to encode
 * @returns A 60-character hex string representing the encoded memo
 */
const encodeMemoText = (memoText?: string): string => {
  if (typeof memoText === 'undefined' || memoText.length === 0) {
    // Return 30 bytes of zeros (60 hex chars)
    return '0'.repeat(60)
  }
  // Encode to UTF-8 bytes, then hex
  const encoded = ByteUtils.hexlify(new TextEncoder().encode(memoText))
  // Truncate to 30 bytes (60 hex chars) or pad with zeros
  if (encoded.length > 60) {
    return encoded.substring(0, 60)
  }
  return encoded.padEnd(60, '0')
}

/**
 * Decode a 30-byte hex-encoded memo text back into a UTF-8 string.
 * @param encoded - The 60-character hex string to decode
 * @returns The decoded memo text, or undefined if empty or invalid
 */
const decodeMemoText = (encoded: string): string | undefined => {
  if (!encoded || encoded.length !== 60) {
    return undefined
  }
  // Check if all zeros (no message)
  if (encoded === '0'.repeat(60)) {
    return undefined
  }
  // Remove trailing zeros
  const trimmed = encoded.replace(/0+$/, '')
  if (trimmed.length === 0) {
    return undefined
  }
  // Decode hex to UTF-8
  try {
    return new TextDecoder().decode(ByteUtils.hexToBytes(trimmed))
  } catch {
    return undefined
  }
}

/**
 * Create encrypted annotation data for a V2 note, containing output type and sender random.
 * Memo text is stored in the GCM ciphertext (data[3]), not here.
 * @param outputType - The note output type (transfer, withdrawal, or change)
 * @param senderRandom - The sender random value controlling address visibility
 * @param viewingPrivateKey - The sender's viewing private key for CTR encryption
 * @returns The hex-encoded encrypted annotation data string
 */
const createEncryptedNoteAnnotationDataV2 = (
  outputType: OutputType,
  senderRandom: string,
  viewingPrivateKey: Uint8Array
): string => {
  const outputTypeFormatted = ByteUtils.nToHex(BigInt(outputType), ByteLength.UINT_8)
  const metadataField0 = `${outputTypeFormatted}${senderRandom}`
  if (metadataField0.length !== 32) {
    throw new Error('Metadata field 0 must be 16 bytes.')
  }

  // 30 bytes of zeros (reserved)
  const metadataField1 = '0'.repeat(60)

  const { iv, data } = AES.encryptCTR([metadataField0, metadataField1], viewingPrivateKey)

  return iv + data[0] + data[1]
}

/**
 * Decrypt annotation data to extract outputType, senderRandom, and message.
 * Returns undefined if decryption fails or annotation data is invalid.
 * @param annotationData - The hex-encoded encrypted annotation data
 * @param viewingPrivateKey - The viewing private key for CTR decryption
 * @returns The decrypted output type, sender random, and optional message, or undefined on failure
 */
const decryptNoteAnnotationData = (
  annotationData: string,
  viewingPrivateKey: Uint8Array
): { outputType: OutputType; senderRandom: string; message?: string } | undefined => {
  if (!annotationData || annotationData.length === 0) {
    return undefined
  }

  try {
    const hexlified = ByteUtils.strip0x(annotationData)

    // Check length: 16 bytes IV + 16 bytes field0 + 30 bytes messageField = 62 bytes = 124 hex chars
    if (hexlified.length < 64) {
      return undefined
    }

    const metadataCiphertext = {
      iv: hexlified.substring(0, 32),
      data:
        hexlified.length >= 124
          ? [hexlified.substring(32, 64), hexlified.substring(64, 124)]
          : [hexlified.substring(32, 64)],
    }

    const decrypted = AES.decryptCTR(metadataCiphertext, viewingPrivateKey)

    if (!decrypted[0] || decrypted[0].length < 32) {
      return undefined
    }

    const outputType = parseInt(decrypted[0].substring(0, 2), 16)
    const senderRandom = decrypted[0].substring(2, 32)

    // Validate outputType
    if (!Object.values(OutputType).includes(outputType)) {
      return undefined
    }

    // Decode message if present
    const message = decrypted[1] ? decodeMemoText(decrypted[1]) : undefined

    const result: { outputType: OutputType; senderRandom: string; message?: string } = {
      outputType,
      senderRandom,
    }

    if (message) {
      result.message = message
    }

    return result
  } catch (error) {
    console.warn('Failed to decrypt note annotation data:', error)
    return undefined
  }
}

export type { TokenData }
export {
  TokenType,
  OutputType,
  TransactNote,
  decodeMemoText,
  decryptNoteAnnotationData,
}
