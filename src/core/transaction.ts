import circom, { poseidon } from '@railgun-community/circomlibjs'
import { ethers } from 'ethers'

import type { Database } from './merkletrees/database'
import { InMemoryDatabase } from './merkletrees/database'
import { UTXOMerkletree } from './merkletrees/UTXOMerkletree'
import type { TokenData } from './transact-note'
import { TokenType, TransactNote } from './transact-note'

import RailgunSmartWalletABI from '@/core/abis/RailgunSmartWallet.json'
import { SentTransactionStorage } from '@/services/SentTransactionStorage'
import { SubsquidBalanceScanner } from '@/services/SubsquidBalanceScanner'
import type { Chain, CommitmentCiphertextStruct } from '@/types/core'
import { NETWORK_CONFIG, NetworkName } from '@/types/network'
import type { RailgunWallet } from '@/types/wallet'
import { hashBoundParamsV2 } from '@/utils/bound-params'
import { ByteLength, ByteUtils, getChainFullNetworkID, getPublicViewingKey } from '@/utils/crypto'
import {
  getNoteBlindingKeys,
  getSharedSymmetricKey,
  getTokenDataHash,
} from '@/utils/railgun-crypto'

interface AdaptID {
  contract: string
  parameters: string
}

interface TXO {
  tree: number
  position: number
  blockNumber: number
  timestamp?: number
  spendtxid: boolean
  note: {
    npk: string
    value: bigint
    tokenData: TokenData
    random: string
  }
  txid: string
  poisPerList?: any
  blindedCommitment?: string
  transactCreationRailgunTxid?: string
  commitmentType: number
  nullifier: string
}

interface UnshieldData {
  toAddress: string
  tokenData: TokenData
  value: bigint
  allowOverride?: boolean
}

interface GlobalBoundParams {
  minGasPrice: bigint
  chainID: number
  senderCiphertext: string
  to: string
  data: string
}

interface PrivateInputsRailgun {
  tokenAddress: bigint
  randomIn: bigint[]
  valueIn: bigint[]
  pathElements: bigint[][]
  leavesIndices: bigint[]
  valueOut: bigint[]
  publicKey: [bigint, bigint]
  npkOut: bigint[]
  nullifyingKey: bigint
}

interface PublicInputsRailgun {
  merkleRoot: bigint
  boundParamsHash: bigint
  nullifiers: bigint[]
  commitmentsOut: bigint[]
}

interface UnprovedTransactionInputs {
  privateInputs: PrivateInputsRailgun
  publicInputs: PublicInputsRailgun
  boundParams: any
  signature: [bigint, bigint, bigint]
}

interface RailgunTransactionRequest extends UnprovedTransactionInputs {
  // No additional fields needed - publicInputs.commitmentsOut contains all outputs
}

interface CommitmentPreimageStruct {
  npk: string
  token: {
    tokenType: number
    tokenAddress: string
    tokenSubID: bigint
  }
  value: bigint
}

interface BoundParamsStruct {
  treeNumber: number
  minGasPrice: bigint
  unshield: bigint
  chainID: string
  adaptContract: string
  adaptParams: string
  commitmentCiphertext: CommitmentCiphertextStruct[]
}

interface G1PointStruct {
  x: string
  y: string
}

interface G2PointStruct {
  x: [string, string]
  y: [string, string]
}

interface SnarkProofStruct {
  a: G1PointStruct
  b: G2PointStruct
  c: G1PointStruct
}

interface TransactionStruct {
  proof: SnarkProofStruct
  merkleRoot: string
  nullifiers: string[]
  commitments: string[]
  boundParams: BoundParamsStruct
  boundParamsHash?: string
  unshieldPreimage: CommitmentPreimageStruct
}

/**
 * Abstract base class for unshield note data used in RAILGUN transactions.
 */
abstract class UnshieldNote {
  abstract value: bigint
  abstract notePublicKey: bigint
  abstract hash: bigint
  abstract preImage: CommitmentPreimageStruct

  /**
   * Create an empty unshield note with zero values, used when no unshield is present.
   * @returns An UnshieldNoteERC20 with zeroed address and value.
   */
  static empty (): UnshieldNote {
    return new UnshieldNoteERC20(
      '0x0000000000000000000000000000000000000000',
      0n,
      '0x0000000000000000000000000000000000000000'
    )
  }
}

/**
 * ERC-20 specific unshield note containing the recipient, value, and Poseidon commitment hash.
 */
class UnshieldNoteERC20 extends UnshieldNote {
  /**
   * The token amount to unshield.
   */
  value: bigint
  /**
   * The note public key derived from the recipient's Ethereum address.
   */
  notePublicKey: bigint
  /**
   * The Poseidon hash of the note (npk, tokenHash, value).
   */
  hash: bigint
  /**
   * The commitment preimage struct used by the RAILGUN contract.
   */
  preImage: CommitmentPreimageStruct

  /**
   * Create an ERC-20 unshield note with the computed Poseidon commitment hash.
   * @param toAddress - The recipient Ethereum address.
   * @param value - The token amount to unshield.
   * @param tokenAddress - The ERC-20 token contract address.
   */
  constructor (toAddress: string, value: bigint, tokenAddress: string) {
    super()
    this.value = value

    // For UNSHIELD notes, the NPK is the recipient's Ethereum address as a BigInt.
    // The contract extracts the address from the NPK by casting it back to address.
    const addressWithPrefix = toAddress.startsWith('0x') ? toAddress : `0x${toAddress}`
    this.notePublicKey = ByteUtils.hexToBigInt(addressWithPrefix)

    // hash = poseidon([npk, tokenHash, value])
    const tokenData: TokenData = { tokenType: TokenType.ERC20, tokenAddress, tokenSubID: '0' }
    const tokenHash = getTokenDataHash(tokenData)
    this.hash = poseidon([this.notePublicKey, ByteUtils.hexToBigInt(tokenHash), value])

    // preImage.npk is the raw address string
    this.preImage = {
      npk: toAddress,
      token: {
        tokenType: TokenType.ERC20,
        tokenAddress,
        tokenSubID: 0n,
      },
      value,
    }
  }
}

// UnshieldFlag constants
/**
 * Constants representing the unshield mode for a RAILGUN transaction.
 */
class UnshieldFlag {
  /**
   * No unshield operation in this transaction.
   */
  static readonly NO_UNSHIELD = 0n
  /**
   * Standard unshield operation.
   */
  static readonly UNSHIELD = 1n
  /**
   * Unshield with override (allows overriding token data).
   */
  static readonly OVERRIDE = 2n
}

/**
 * Every single cryptographic operation copied exactly
 */
class Transaction {
  /**
   * The adapt contract ID and parameters for cross-contract calls.
   */
  private readonly adaptID: AdaptID
  /**
   * The blockchain chain type and ID.
   */
  private readonly chain: Chain
  /**
   * The internal transact note outputs for this transaction.
   */
  private readonly tokenOutputs: TransactNote[] = []
  /**
   * The unshield note, defaulting to an empty note when no unshield is present.
   */
  private unshieldNote: UnshieldNote = UnshieldNoteERC20.empty()
  /**
   * The current unshield mode flag for this transaction.
   */
  private unshieldFlag: bigint = UnshieldFlag.NO_UNSHIELD
  /**
   * The token data identifying the token being transacted.
   */
  private readonly tokenData: TokenData
  /**
   * The Poseidon hash of the token data.
   */
  private readonly tokenHash: string
  /**
   * The UTXO merkle tree index that UTXOs are being spent from.
   */
  private readonly spendingTree: number
  /**
   * The unspent transaction outputs being consumed as inputs.
   */
  private readonly utxos: TXO[]
  /**
   * The database instance used for merkle tree operations.
   */
  private readonly db: Database

  /**
   * Create Transaction Object - EXACT COPY.
   * @param chain - The blockchain chain type and ID.
   * @param tokenData - The token data for the token being transacted.
   * @param spendingTree - The UTXO merkle tree index to spend from.
   * @param utxos - The unspent transaction outputs to consume.
   * @param tokenOutputs - The transact note outputs (max 5).
   * @param adaptID - The adapt contract ID and parameters.
   * @param db - The database instance for merkle tree lookups.
   */
  constructor (
    chain: Chain,
    tokenData: TokenData,
    spendingTree: number,
    utxos: TXO[],
    tokenOutputs: TransactNote[],
    adaptID: AdaptID,
    db: Database
  ) {
    if (tokenOutputs.length > 5) {
      throw new Error('Can not add more than 5 outputs.')
    }

    this.chain = chain
    this.tokenData = tokenData
    this.tokenHash = getTokenDataHash(tokenData)
    this.spendingTree = spendingTree
    this.utxos = utxos
    this.tokenOutputs = tokenOutputs
    this.adaptID = adaptID
    this.db = db
  }

  /**
   * Add unshield data to this transaction, enabling token withdrawal from private to public balance.
   * @param unshieldData - The unshield parameters including recipient, token, and value.
   * @param unshieldValue - The amount to unshield.
   */
  addUnshieldData (unshieldData: UnshieldData, unshieldValue: bigint) {
    if (this.unshieldFlag !== UnshieldFlag.NO_UNSHIELD) {
      throw new Error('You may only call .addUnshieldData once for a given transaction.')
    }

    const tokenHashUnshield = getTokenDataHash(unshieldData.tokenData)
    if (tokenHashUnshield !== this.tokenHash) {
      throw new Error('Unshield token does not match Transaction token.')
    }

    const { tokenData, allowOverride } = unshieldData
    const { tokenAddress, tokenType } = tokenData

    switch (tokenType) {
      case TokenType.ERC20:
        this.unshieldNote = new UnshieldNoteERC20(
          unshieldData.toAddress,
          unshieldValue,
          tokenAddress
        )
        break
    }

    this.unshieldFlag = allowOverride ? UnshieldFlag.OVERRIDE : UnshieldFlag.UNSHIELD
  }

  /**
   * Get the value being unshielded in this transaction, or 0 if none.
   * @returns The unshield amount as a bigint.
   */
  get unshieldValue () {
    return this.unshieldNote ? this.unshieldNote.value : 0n
  }

  /**
   * Generate transaction request - EXACT COPY of generateTransactionRequest.
   * @param wallet - The RAILGUN wallet providing spending and viewing keys.
   * @param globalBoundParams - Global bound parameters including gas price and chain ID.
   * @returns The complete transaction request with private/public inputs, bound params, and signature.
   */
  async generateTransactionRequest (
    wallet: RailgunWallet,
    globalBoundParams: GlobalBoundParams
  ): Promise<RailgunTransactionRequest> {
    // Get wallet keys
    // Derive BabyJubJub public key from spending private key
    const spendingPrivateKeyBytes = ByteUtils.hexStringToBytes(wallet.spendingKey)
    const spendingPubkey = circom.eddsa.prv2pub(Buffer.from(spendingPrivateKeyBytes)) as [
      bigint,
      bigint
    ]
    const spendingKey = {
      pubkey: spendingPubkey,
      privateKey: wallet.spendingKey,
    }
    // Parse nullifyingKey as decimal BigInt
    if (!wallet.nullifyingKey) {
      throw new Error('Wallet missing nullifyingKey - wallet not properly initialized')
    }
    const nullifyingKey = BigInt(wallet.nullifyingKey)

    // Derive sender's viewing public key from viewing private key
    const senderViewingPubkey = await getPublicViewingKey(
      ByteUtils.hexStringToBytes(wallet.viewingKey)
    )

    const senderViewingKeys = {
      pubkey: senderViewingPubkey,
      privateKey: wallet.viewingKey,
    }

    // Get REAL nullifiers and path data from the merkle tree
    const nullifiers: bigint[] = []
    const pathElements: bigint[][] = []
    const pathIndices: bigint[] = []

    // Store the merkle root from the first proof
    // All UTXOs spent in the same transaction must have proofs with the same merkle root
    let merkleRoot: string | undefined

    for (const utxo of this.utxos) {
      nullifiers.push(TransactNote.getNullifier(nullifyingKey, utxo.position))

      const proof = await this.getUTXOMerkleProof(utxo.tree, utxo.position)

      if (!merkleRoot) {
        merkleRoot = proof.root
      } else if (proof.root.toLowerCase() !== merkleRoot.toLowerCase()) {
        throw new Error(
          `Merkle root mismatch: UTXO at position ${utxo.position} has root ${proof.root} but expected ${merkleRoot}`
        )
      }

      pathElements.push(proof.elements.map((element: string) => ByteUtils.hexToBigInt(element)))
      pathIndices.push(BigInt(utxo.position))
    }

    const allOutputs: (TransactNote | UnshieldNote)[] = [...this.tokenOutputs]

    const hasUnshield = this.unshieldFlag !== UnshieldFlag.NO_UNSHIELD && this.unshieldNote
    if (hasUnshield) {
      allOutputs.push(this.unshieldNote)
    }

    if (allOutputs.length > 5) {
      throw new Error('Cannot create a transaction with >5 outputs.')
    }

    // Store output data for PPOI proof generation before encryption
    // (sender cannot decrypt sent outputs later — they're encrypted for the receiver)
    const outputsToStore = allOutputs
      .filter((note) => note instanceof TransactNote)
      .map((note) => {
        const transactNote = note as TransactNote
        return {
          transactionHash: '', // Will be updated after transaction is sent
          commitmentHash: ByteUtils.nToHex(transactNote.hash, ByteLength.UINT_256, true),
          npk: ByteUtils.nToHex(transactNote.notePublicKey, ByteLength.UINT_256, true),
          value: transactNote.value,
          tokenHash: transactNote.tokenHash, // Required for commitment hash calculation
          tokenAddress: this.tokenData.tokenAddress,
          tokenType: this.tokenData.tokenType,
          tokenSubID: this.tokenData.tokenSubID,
          recipientAddress: transactNote.receiverAddressData.masterPublicKey.toString(), // Store MPK as identifier
          timestamp: Date.now(),
        }
      })

    if (outputsToStore.length > 0) {
      // Use wallet.address (deterministic) instead of wallet.id (random per session)
      // This ensures data persists across browser sessions
      SentTransactionStorage.getInstance().storeSentOutputs(wallet.address, outputsToStore)
    }

    // Filter internal outputs
    const onlyInternalOutputs = allOutputs.filter(
      (note) => note instanceof TransactNote
    ) as TransactNote[]

    // Generate blinding keys
    const noteBlindedKeys = await Promise.all(
      onlyInternalOutputs.map((note) => {
        if (!note.senderRandom) {
          throw new Error('Sender random is not defined for transact note.')
        }
        // Use the receiver's viewing public key from the note's receiver address data
        const receiverViewingPubkey = note.receiverAddressData.viewingPublicKey
        if (!receiverViewingPubkey) {
          throw new Error('Receiver viewing public key is not defined for transact note.')
        }

        return getNoteBlindingKeys(
          senderViewingKeys.pubkey,
          receiverViewingPubkey,
          note.random,
          note.senderRandom
        )
      })
    )

    const sharedKeys = await Promise.all(
      noteBlindedKeys.map(async ({ blindedReceiverViewingKey }) => {
        const viewingPrivateKeyBytes = ByteUtils.hexStringToBytes(senderViewingKeys.privateKey)
        const sharedKey = await getSharedSymmetricKey(
          viewingPrivateKeyBytes,
          blindedReceiverViewingKey
        )

        if (!sharedKey) {
          throw new Error('Failed to derive shared key for commitment encryption')
        }

        return sharedKey
      })
    )

    const randomIn: bigint[] = this.utxos.map((utxo) => {
      const randomHex = utxo.note.random.startsWith('0x')
        ? utxo.note.random.slice(2)
        : utxo.note.random
      if (randomHex.length !== 32) {
        throw new Error(
          `Random value must be exactly 16 bytes (32 hex chars), got ${randomHex.length}`
        )
      }
      return BigInt('0x' + randomHex)
    })

    const valueIn: bigint[] = this.utxos.map((utxo) => {
      return utxo.note.value
    })

    const valueOut: bigint[] = allOutputs.map((note) => note.value)
    const npkOut: bigint[] = allOutputs.map((x) => x.notePublicKey)

    const privateInputs: PrivateInputsRailgun = {
      tokenAddress: ByteUtils.hexToBigInt(this.tokenHash),
      randomIn,
      valueIn,
      pathElements,
      leavesIndices: pathIndices,
      valueOut,
      publicKey: spendingKey.pubkey,
      npkOut,
      nullifyingKey,
    }

    const commitmentCiphertext: CommitmentCiphertextStruct[] = await Promise.all(
      onlyInternalOutputs.map(async (note, index) => {
        const sharedKey = sharedKeys[index]
        if (!sharedKey) {
          throw new Error('Shared symmetric key is not defined.')
        }

        // Get wallet's master public key for encoding
        const senderMasterPublicKey = wallet.masterPublicKey ? BigInt(wallet.masterPublicKey) : 0n

        // Use TransactNote's encryptV2 method - handles all encoding logic correctly
        const { noteCiphertext, noteMemo, annotationData } = await note.encryptV2(
          sharedKey,
          senderMasterPublicKey,
          ByteUtils.hexStringToBytes(senderViewingKeys.privateKey)
        )

        // Validate encryption output
        if (noteCiphertext.data.length !== 3) {
          throw new Error('Note ciphertext data must have length 3.')
        }
        if (!noteCiphertext.data[0] || !noteCiphertext.data[1] || !noteCiphertext.data[2]) {
          throw new Error('Missing encrypted data blocks.')
        }

        const blindedKeys = noteBlindedKeys[index]
        if (!blindedKeys) {
          throw new Error('Missing blinded keys for note.')
        }

        // Format ciphertext
        const ciphertext: [string, string, string, string] = [
          ByteUtils.hexlify(`${noteCiphertext.iv}${noteCiphertext.tag}`, true),
          ByteUtils.hexlify(noteCiphertext.data[0], true),
          ByteUtils.hexlify(noteCiphertext.data[1], true),
          ByteUtils.hexlify(noteCiphertext.data[2], true),
        ]

        return {
          ciphertext,
          blindedSenderViewingKey: ByteUtils.hexlify(blindedKeys.blindedSenderViewingKey, true),
          blindedReceiverViewingKey: ByteUtils.hexlify(blindedKeys.blindedReceiverViewingKey, true),
          memo: ByteUtils.hexlify(noteMemo, true),
          annotationData: ByteUtils.hexlify(annotationData, true),
        }
      })
    )

    const boundParams: BoundParamsStruct = {
      treeNumber: this.spendingTree,
      minGasPrice: globalBoundParams.minGasPrice,
      unshield: this.unshieldFlag,
      // 1 byte chainType + 7 bytes chainID (uint64 total)
      chainID: ByteUtils.hexlify(getChainFullNetworkID(this.chain), true),
      adaptContract: this.adaptID.contract,
      adaptParams: this.adaptID.parameters,
      commitmentCiphertext,
    }

    if (!merkleRoot) {
      throw new Error('No merkle root was generated - all UTXOs must have valid merkle proofs')
    }

    // All outputs (internal + unshield) included — circuit validates all output hashes
    const commitmentsOut: bigint[] = allOutputs.map((note) => note.hash)

    const publicInputs: PublicInputsRailgun = {
      merkleRoot: ByteUtils.hexToBigInt(merkleRoot),
      boundParamsHash: hashBoundParamsV2({
        treeNumber: BigInt(boundParams.treeNumber),
        minGasPrice: boundParams.minGasPrice,
        unshield: boundParams.unshield,
        chainID: ByteUtils.hexToBigInt(boundParams.chainID),
        adaptContract: boundParams.adaptContract,
        adaptParams: boundParams.adaptParams,
        commitmentCiphertext: boundParams.commitmentCiphertext,
      }),
      nullifiers,
      commitmentsOut,
    }

    const signature = await this.generateSignature(publicInputs, wallet)

    return {
      privateInputs,
      publicInputs,
      boundParams,
      signature, // Real cryptographic signature [R8x, R8y, S]
    }
  }

  /**
   * Generate EDDSA signature exactly as in RailgunWallet.sign().
   * Creates message hash and signs with spending private key.
   * @param publicInputs - The public inputs containing merkle root, bound params hash, nullifiers, and commitments.
   * @param wallet - The RAILGUN wallet providing the spending private key.
   * @returns The EDDSA signature as [R8x, R8y, S].
   */
  private async generateSignature (
    publicInputs: PublicInputsRailgun,
    wallet: RailgunWallet
  ): Promise<[bigint, bigint, bigint]> {
    // Create message hash
    // IMPORTANT: Only use actual (non-padded) values for signature generation

    // Filter out padded zero values from nullifiers and commitmentsOut
    const actualNullifiers = publicInputs.nullifiers.filter((n) => n !== BigInt(0))
    const actualCommitmentsOut = publicInputs.commitmentsOut.filter((c) => c !== BigInt(0))

    const msg = poseidon([
      publicInputs.merkleRoot,
      publicInputs.boundParamsHash,
      ...actualNullifiers,
      ...actualCommitmentsOut,
    ])

    // Get spending private key from wallet
    const spendingPrivateKey = ByteUtils.hexToBytes(wallet.spendingKey)

    // Sign using EDDSA
    const signature = circom.eddsa.signPoseidon(Buffer.from(spendingPrivateKey), msg)

    // Format signature
    // The R8 elements and S are already BigInts from circom.eddsa.signPoseidon
    return [...signature.R8, signature.S] as [bigint, bigint, bigint]
  }

  /**
   * Format inputs for circuit - EXACT COPY of formatRailgunInputs.
   * @param unprovedInputs - The unproved transaction inputs to format for the snark circuit.
   * @returns The formatted inputs object matching the circuit's expected structure.
   */
  private formatRailgunInputs (unprovedInputs: UnprovedTransactionInputs) {
    const { publicInputs, privateInputs } = unprovedInputs

    const formatted = {
      merkleRoot: publicInputs.merkleRoot,
      boundParamsHash: publicInputs.boundParamsHash,
      nullifiers: publicInputs.nullifiers,
      //  publicInputs.commitmentsOut contains ALL outputs (internal + unshield)
      // The circuit needs all output hashes to verify
      commitmentsOut: publicInputs.commitmentsOut,
      token: privateInputs.tokenAddress,
      publicKey: privateInputs.publicKey,
      signature: unprovedInputs.signature,
      randomIn: privateInputs.randomIn,
      valueIn: privateInputs.valueIn,
      pathElements: privateInputs.pathElements.flat(2),
      leavesIndices: privateInputs.leavesIndices,
      nullifyingKey: privateInputs.nullifyingKey,
      npkOut: privateInputs.npkOut,
      valueOut: privateInputs.valueOut,
    }

    return formatted
  }

  /**
   * Generate proved transaction by running the snark prover on formatted inputs.
   * @param unprovedInputs - The unproved transaction inputs including private inputs, public inputs, and signature.
   * @param progressCallback - Optional callback receiving progress percentage (0-100).
   * @returns The fully proved TransactionStruct ready for on-chain submission.
   */
  async generateProvedTransaction (
    unprovedInputs: UnprovedTransactionInputs,
    progressCallback?: (progress: number) => void
  ): Promise<TransactionStruct> {
    progressCallback?.(0)

    this.assertCanProve(unprovedInputs.privateInputs)

    try {
      // Format inputs
      const formattedInputs = this.formatRailgunInputs(unprovedInputs)

      progressCallback?.(20)

      // Import our real prover
      const { proveRailgunV2 } = await import('./prover')

      // Determine circuit size
      //  Circuit has outputs for BOTH internal notes AND unshield
      // The circuit processes unshield as an output (in npkOut/valueOut arrays)
      // BUT only internal outputs become on-chain commitments
      const nullifierCount = this.utxos.length
      const hasUnshield = this.unshieldFlag !== UnshieldFlag.NO_UNSHIELD
      // Circuit outputs = internal outputs + unshield (if present)
      const commitmentCount = this.tokenOutputs.length + (hasUnshield ? 1 : 0)

      // Generate the proof
      const result = await proveRailgunV2(
        formattedInputs,
        nullifierCount,
        commitmentCount,
        (progress: number) => {
          const adjustedProgress = 20 + progress * 0.7
          progressCallback?.(Math.floor(adjustedProgress))
        }
      )

      progressCallback?.(95)

      // Format proof
      const proof = this.formatProof(result.proof)

      progressCallback?.(100)

      // Return transaction struct
      return this.createTransactionStruct(
        proof,
        unprovedInputs.publicInputs,
        unprovedInputs.boundParams as BoundParamsStruct,
        this.unshieldNote.preImage
      )
    } catch (error) {
      console.error('RAILGUN: Proof generation failed:', error)
      throw error
    }
  }

  /**
   * Format proof - EXACT COPY of Prover.formatProof.
   * @param proof - The raw SnarkJS proof with pi_a, pi_b, pi_c arrays.
   * @returns The formatted proof with G1/G2 point structures expected by the contract.
   */
  private formatProof (proof: any): any {
    // The proof comes in SnarkJS format with pi_a, pi_b, pi_c
    // Convert to the format expected by the contract
    return {
      a: {
        x: BigInt(proof.pi_a[0]),
        y: BigInt(proof.pi_a[1]),
      },
      b: {
        x: [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
        y: [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
      },
      c: {
        x: BigInt(proof.pi_c[0]),
        y: BigInt(proof.pi_c[1]),
      },
    }
  }

  /**
   * Assert can prove - EXACT COPY. Throws if both input and output values are zero.
   * @param privateInputs - The private inputs to validate before proof generation.
   */
  private assertCanProve (privateInputs: PrivateInputsRailgun) {
    if (
      privateInputs.valueIn.length === 1 &&
      privateInputs.valueOut.length === 1 &&
      privateInputs.valueIn[0] === 0n &&
      privateInputs.valueOut[0] === 0n
    ) {
      throw new Error('Cannot prove transaction with null (zero value) inputs and outputs.')
    }
  }

  /**
   * Create transaction struct - EXACT COPY. Formats all fields into the on-chain submission format.
   * @param proof - The formatted snark proof.
   * @param publicInputs - The public circuit inputs (merkle root, nullifiers, commitments).
   * @param boundParams - The bound parameters struct including ciphertext and chain data.
   * @param unshieldPreimage - The commitment preimage for the unshield output.
   * @returns The TransactionStruct ready for contract submission.
   */
  private createTransactionStruct (
    proof: any,
    publicInputs: PublicInputsRailgun,
    boundParams: BoundParamsStruct,
    unshieldPreimage: CommitmentPreimageStruct
  ): TransactionStruct {
    return {
      proof,
      merkleRoot: ByteUtils.nToHex(publicInputs.merkleRoot, ByteLength.UINT_256, true),
      nullifiers: publicInputs.nullifiers.map((n) =>
        ByteUtils.nToHex(n, ByteLength.UINT_256, true)
      ),
      commitments: publicInputs.commitmentsOut.map((n) =>
        ByteUtils.nToHex(n, ByteLength.UINT_256, true)
      ),
      boundParams,
      boundParamsHash: publicInputs.boundParamsHash.toString(), // Include the hash used in proof generation
      unshieldPreimage: {
        npk: ByteUtils.formatToByteLength(unshieldPreimage.npk, 32, true),
        token: unshieldPreimage.token,
        value: unshieldPreimage.value,
      },
    }
  }

  /**
   * Generate dummy proved transaction - EXACT COPY. Uses zeroed proof values for gas estimation.
   * @param transactionRequest - The transaction request to generate a dummy proof for.
   * @returns A TransactionStruct with dummy proof values.
   */
  async generateDummyProvedTransaction (
    transactionRequest: RailgunTransactionRequest
  ): Promise<TransactionStruct> {
    const { publicInputs, boundParams } = transactionRequest

    // Create dummy proof
    const dummyProof = {
      a: { x: '0x' + '0'.repeat(64), y: '0x' + '0'.repeat(64) },
      b: {
        x: ['0x' + '0'.repeat(64), '0x' + '0'.repeat(64)] as [string, string],
        y: ['0x' + '0'.repeat(64), '0x' + '0'.repeat(64)] as [string, string],
      },
      c: { x: '0x' + '0'.repeat(64), y: '0x' + '0'.repeat(64) },
    }

    return this.createTransactionStruct(
      dummyProof,
      publicInputs,
      boundParams as BoundParamsStruct,
      this.unshieldNote.preImage
    )
  }

  /**
   * Get merkle proof for a UTXO at a given tree position.
   * @param tree - Tree number.
   * @param position - Position in the tree.
   * @param maxBlockNumber - Maximum block number to include commitments up to (for historical tree state).
   * @returns The merkle proof containing leaf, sibling elements, path indices, and root.
   */
  private async getUTXOMerkleProof (
    tree: number,
    position: number,
    maxBlockNumber?: number
  ): Promise<{ leaf: string; elements: string[]; indices: string; root: string }> {
    try {
      // For historical merkle roots, create a fresh in-memory database to avoid cache pollution
      // This ensures we get the correct historical root without interference from current state
      const db = maxBlockNumber !== undefined ? new InMemoryDatabase() : this.db

      // Create UTXOMerkletree instance
      const utxoMerkletree = new UTXOMerkletree(db)

      // First, populate the merkletree with commitment data from BalanceScanner
      // This is critical - the merkletree needs all commitments to generate valid proofs
      // If maxBlockNumber is provided, only include commitments up to that block (for historical merkle root)
      await this.populateUTXOMerkletree(utxoMerkletree, tree, maxBlockNumber)

      const proof = await utxoMerkletree.getUTXOMerkleProof(tree, position)

      return proof
    } catch (error) {
      console.error('Failed to get merkle proof:', error)
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(
        `Could not generate merkle proof for tree ${tree}, position ${position}: ${errorMessage}`
      )
    }
  }

  /**
   * Populate UTXOMerkletree with commitment data from Shield events (commitment events).
   * @param utxoMerkletree - The UTXO merkle tree instance to populate.
   * @param targetTree - The tree index to fetch and insert commitments for.
   * @param maxBlockNumber - Optional: Only include commitments up to this block (for historical merkle root).
   */
  private async populateUTXOMerkletree (
    utxoMerkletree: UTXOMerkletree,
    targetTree: number,
    maxBlockNumber?: number
  ): Promise<void> {
    // HARDHAT FIX: Check if we're running on Hardhat network
    if (this.chain.id === 31337) {
      try {
        const [shieldCommitments, transactCommitments] = await Promise.all([
          this.fetchShieldCommitmentsFromChain(targetTree, maxBlockNumber),
          this.fetchTransactCommitmentsFromChain(targetTree, maxBlockNumber),
        ])

        const allCommitments = [...shieldCommitments, ...transactCommitments]

        if (allCommitments.length === 0) return

        // Sort by position to ensure correct tree order
        const sortedCommitments = allCommitments.sort((a, b) => a.position - b.position)
        const maxPosition = Math.max(...sortedCommitments.map((c) => c.position))

        // Create leaves array with all commitment hashes at their positions
        const leaves: { hash: string }[] = []
        for (let i = 0; i <= maxPosition; i++) {
          const commitment = sortedCommitments.find((c) => c.position === i)
          if (commitment) {
            leaves[i] = { hash: commitment.hash }
          } else {
            leaves[i] = { hash: '' } // Empty leaf for gaps
          }
        }

        await utxoMerkletree.queueLeaves(targetTree, 0, leaves)
        await utxoMerkletree.updateTreesFromWriteQueue()
        return
      } catch (error) {
        console.error('Failed to fetch Hardhat commitments from chain:', error)
        return
      }
    }

    try {
      // For live networks, fetch commitments from Subsquid

      // Import SubsquidBalanceScanner and get all commitments for this tree
      const scanner = SubsquidBalanceScanner.getInstance()

      // Fetch ALL commitments from Subsquid for the target tree (not just decrypted ones)
      const allCommitments = await scanner.fetchAllCommitmentsForTree(
        targetTree,
        this.chain.id,
        maxBlockNumber
      )

      if (allCommitments.length === 0) return

      // Sort commitments by position to ensure correct tree order
      const sortedCommitments = allCommitments.sort((a, b) => a.position - b.position)

      // Create leaves array with commitment hashes at their correct positions
      const maxPosition = Math.max(...sortedCommitments.map((c) => c.position))
      const leaves: { hash: string }[] = []

      // Initialize array with empty slots
      for (let i = 0; i <= maxPosition; i++) {
        leaves[i] = { hash: '' } // Empty positions will use zero values
      }

      // Fill in actual commitment hashes at their positions
      //  Normalize hashes to hex format (0x-prefixed) for consistency
      for (const commitment of sortedCommitments) {
        // Convert decimal string to hex if needed
        let normalizedHash = commitment.hash
        if (!normalizedHash.startsWith('0x')) {
          // Subsquid returns decimal strings, convert to hex
          normalizedHash = ByteUtils.nToHex(BigInt(normalizedHash), ByteLength.UINT_256)
        }
        leaves[commitment.position] = { hash: normalizedHash }
      }

      await utxoMerkletree.queueLeaves(targetTree, 0, leaves)
      await utxoMerkletree.updateTreesFromWriteQueue()
    } catch (error) {
      console.error(`Failed to populate UTXOMerkletree for tree ${targetTree}:`, error)
    }
  }

  /**
   * Fetch Shield commitments from blockchain events for a specific tree.
   * Uses same approach as RPC fetcher to get commitment data.
   * @param targetTree - The tree index to fetch commitments for.
   * @param _maxBlockNumber - Optional: Only include commitments up to this block.
   * @returns Array of commitment objects with hash, position, and block number.
   */
  private async fetchShieldCommitmentsFromChain (
    targetTree: number,
    _maxBlockNumber?: number
  ): Promise<Array<{ hash: string; position: number; blockNumber: number }>> {
    try {
      // Get provider and contract setup from network config
      const hardhatConfig = NETWORK_CONFIG[NetworkName.Hardhat]
      const provider = new ethers.JsonRpcProvider(hardhatConfig.rpcUrl)

      const contractInterface = new ethers.Interface(RailgunSmartWalletABI)
      const contractAddress = hardhatConfig.railgunContractAddress

      // Get current block for range (scan recent blocks for testing)
      const currentBlock = await provider.getBlockNumber()
      const fromBlock = Math.max(0, currentBlock - 10000) // Last 10k blocks

      const allLogs = await provider.getLogs({
        address: contractAddress,
        fromBlock,
        toBlock: currentBlock,
      })

      const commitments: Array<{ hash: string; position: number; blockNumber: number }> = []

      // Parse Shield events from logs
      for (const log of allLogs) {
        try {
          const parsedLog = contractInterface.parseLog(log)

          if (parsedLog?.name === 'Shield') {
            const args = parsedLog.args
            if (args && args.length >= 3) {
              const [treeNumber, startPosition, shieldCommitments] = args

              // Only process commitments for our target tree
              if (Number(treeNumber) === targetTree) {
                // Extract commitment hashes from Shield event
                const commitmentsArray = Array.from(shieldCommitments as any[])

                for (let i = 0; i < commitmentsArray.length; i++) {
                  const commitment = commitmentsArray[i] as any[]

                  if (commitment && commitment.length >= 3) {
                    // commitment structure: [commitmentHash, tokenData, value]
                    const commitmentHash = commitment[0].toString()
                    const position = Number(startPosition) + i

                    // Calculate actual commitment hash using poseidon([npk, tokenHash, value])
                    // The Shield event commitmentHash is actually the NPK
                    const npk = ByteUtils.hexToBigInt(commitmentHash)

                    // Extract token data
                    const tokenData = commitment[1] as any[]
                    const tokenAddress =
                      tokenData && tokenData.length > 1 ? (tokenData[1] as string) : '0x0'
                    // For ERC20 token hash
                    const tokenHash = ByteUtils.formatToByteLength(
                      tokenAddress,
                      ByteLength.UINT_256,
                      true
                    )
                    const tokenHashBigInt = ByteUtils.hexToBigInt(tokenHash)

                    // Extract value
                    const value = commitment[2]
                    const valueBigInt = BigInt(value.toString())

                    // Calculate the actual commitment hash: poseidon([npk, tokenHash, value])
                    const actualCommitmentHash = ByteUtils.nToHex(
                      poseidon([npk, tokenHashBigInt, valueBigInt]),
                      32,
                      true
                    )

                    commitments.push({
                      hash: actualCommitmentHash,
                      position,
                      blockNumber: log.blockNumber,
                    })
                  }
                }
              }
            }
          }
        } catch (error) {
          // Skip unparseable logs - most won't be RAILGUN events
        }
      }

      return commitments
    } catch (error) {
      console.error('Error fetching Shield commitments from chain:', error)
      return []
    }
  }

  /**
   * Fetch Transact commitments from blockchain events for a specific tree.
   * Transact events contain commitments that were created by private transactions.
   * @param targetTree - The tree index to fetch commitments for.
   * @param maxBlockNumber - Optional: Only include commitments up to this block.
   * @returns Array of commitment objects with hash, position, and block number.
   */
  private async fetchTransactCommitmentsFromChain (
    targetTree: number,
    maxBlockNumber?: number
  ): Promise<Array<{ hash: string; position: number; blockNumber: number }>> {
    try {
      // Get provider and contract setup from network config
      const hardhatConfig = NETWORK_CONFIG[NetworkName.Hardhat]
      const provider = new ethers.JsonRpcProvider(hardhatConfig.rpcUrl)

      const contractInterface = new ethers.Interface(RailgunSmartWalletABI)
      const contractAddress = hardhatConfig.railgunContractAddress

      // Get current block for range
      const currentBlock = await provider.getBlockNumber()
      const fromBlock = Math.max(0, currentBlock - 10000)
      const toBlock =
        maxBlockNumber !== undefined ? Math.min(maxBlockNumber, currentBlock) : currentBlock

      const allLogs = await provider.getLogs({
        address: contractAddress,
        fromBlock,
        toBlock,
      })

      const commitments: Array<{ hash: string; position: number; blockNumber: number }> = []

      for (const log of allLogs) {
        try {
          const parsedLog = contractInterface.parseLog(log)

          if (parsedLog?.name === 'Transact') {
            const args = parsedLog.args
            if (args && args.length >= 3) {
              const [treeNumber, startPosition, transactCommitments] = args

              // Only process commitments for our target tree
              if (Number(treeNumber) === targetTree) {
                // Transact event structure: commitments array contains raw commitment hashes
                const commitmentsArray = Array.from(transactCommitments as any[])

                for (let i = 0; i < commitmentsArray.length; i++) {
                  const commitmentHash = commitmentsArray[i].toString()
                  const position = Number(startPosition) + i

                  commitments.push({
                    hash: commitmentHash,
                    position,
                    blockNumber: log.blockNumber,
                  })
                }
              }
            }
          }
        } catch (error) {
          // Skip unparseable logs
        }
      }

      return commitments
    } catch (error) {
      console.error('Error fetching Transact commitments from chain:', error)
      return []
    }
  }
}

export type {
  Chain,
  AdaptID,
  TXO,
  UnshieldData,
  GlobalBoundParams,
  PrivateInputsRailgun,
  PublicInputsRailgun,
  UnprovedTransactionInputs,
  RailgunTransactionRequest,
  CommitmentPreimageStruct,
  BoundParamsStruct,
  CommitmentCiphertextStruct,
  G1PointStruct,
  G2PointStruct,
  SnarkProofStruct,
  TransactionStruct,
}
export { UnshieldFlag, Transaction }
