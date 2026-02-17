import type { BalanceBucket, NetworkName } from '@/types/network'

// Core wallet types for minimal implementation

// Transaction type constants
const TRANSACTION_TYPES = {
  SHIELD: 'Shield',
  UNSHIELD: 'Unshield',
  TRANSFER: 'Private Send',
  UNKNOWN: 'Unknown',
} as const

type TransactionType = (typeof TRANSACTION_TYPES)[keyof typeof TRANSACTION_TYPES]
type KnownTransactionType = Exclude<TransactionType, 'Unknown'>

// PPOI commitment type constants
const POI_COMMITMENT_TYPES = {
  SHIELD: 'Shield',
  TRANSACT: 'Transact',
  UNSHIELD: 'Unshield',
} as const

type POICommitmentType = (typeof POI_COMMITMENT_TYPES)[keyof typeof POI_COMMITMENT_TYPES]

interface RailgunWallet {
  id: string
  address: string // 0zk address
  viewingKey: string
  spendingKey: string
  nullifyingKey: string // For nullifier generation (required)
  masterPublicKey: string
  mnemonic?: string // Optional for imported wallets
  derivationIndex: number
  ethereumAddress: string
  createdAt: number
  nickname?: string
}

// Metadata for saved wallets (stored in localStorage)
interface SavedWalletMetadata {
  id: string
  nickname: string
  address: string // 0zk address (first 20 chars for display)
  ethereumAddress: string // 0x address
  createdAt: number
  encryptedMnemonic: string // AES encrypted mnemonic
}

/**
 * Minimal wallet data needed for gas payment only.
 * Contains the 0x address and decrypted mnemonic for signing transactions.
 * Used when a different wallet pays gas for privacy-enhancing transactions.
 */
interface GasPayerWallet {
  id: string
  nickname: string
  ethereumAddress: string
  mnemonic: string
}

interface TokenBalance {
  tokenAddress: string
  symbol: string
  decimals: number
  balance: bigint
  balanceBucket: string // PPOI status
}

interface DetailedTransaction {
  // Core transaction data
  txid: string
  railgunTxid?: string
  blockNumber: number
  timestamp: number
  status: 'pending' | 'confirmed' | 'failed'

  // Transaction categorization
  type: KnownTransactionType
  category: string // More specific categorization

  // Token movements
  transferredTokens: Array<{
    tokenAddress: string
    symbol: string
    amount: bigint
    decimals: number
    direction: 'sent' | 'received'
    recipientAddress?: string
    memoText?: string
  }>

  // PPOI data
  blindedCommitments: Array<{
    commitment: string
    type: POICommitmentType
    poiStatus?: POIStatus
    isSpent?: boolean // True if this is a spent input, false if it's a received output
  }>

  // Fees
  shieldFee?: bigint
  unshieldFee?: bigint
  relayerFee?: bigint
  gasCost?: bigint // Gas cost in wei (gasUsed * gasPrice) — populated for public 0x transactions

  // Additional metadata
  version: number
  walletSource?: string

  // Local metadata (stored off-chain, not available from blockchain)
  metadata?: {
    recipientAddress?: string // 0zk address of recipient (for sent transactions)
    recipientLabel?: string // Custom label for recipient
    memo?: string // User's note/memo
    tags?: string[] // Custom tags
    senderMasterPublicKey?: string // Sender's MPK (for received transactions, extracted from decrypted note)
    senderAddress?: string // Reconstructed full 0zk address of sender (for received transactions in normal mode)
  }
}

// Subsquid response types based on actual RAILGUN Subsquid schema
interface SubsquidTransaction {
  id: string
  transactionHash: string
  blockNumber: number
  blockTimestamp: string
  commitments: string[]
  nullifiers: string[]
  boundParamsHash: string
  hasUnshield: boolean
  utxoTreeIn: number
  utxoTreeOut: number
  utxoBatchStartPositionOut: number
  unshieldToken?: {
    tokenType: number
    tokenSubID: string
    tokenAddress: string
  }
  unshieldToAddress?: string
  unshieldValue?: string
}

// Base commitment interface
interface SubsquidCommitmentBase {
  id: string
  treeNumber: number
  batchStartTreePosition: number
  treePosition: number
  blockNumber: number
  transactionHash: string
  blockTimestamp: string
  commitmentType:
    | 'LegacyGeneratedCommitment'
    | 'LegacyEncryptedCommitment'
    | 'ShieldCommitment'
    | 'TransactCommitment'
  hash: string
}

// Legacy Generated Commitment type
interface SubsquidLegacyGeneratedCommitment extends SubsquidCommitmentBase {
  commitmentType: 'LegacyGeneratedCommitment'
  encryptedRandom: string[]
  preimage: {
    id: string
    npk: string
    value: string
    token: {
      id: string
      tokenType: number
      tokenSubID: string
      tokenAddress: string
    }
  }
}

// Legacy Encrypted Commitment type
interface SubsquidLegacyEncryptedCommitment extends SubsquidCommitmentBase {
  commitmentType: 'LegacyEncryptedCommitment'
  legacyCiphertext: {
    id: string
    ciphertext: {
      id: string
      iv: string
      tag: string
      data: string[]
    }
    ephemeralKeys: string[]
    memo: string[]
  }
}

// Shield Commitment type
interface SubsquidShieldCommitment extends SubsquidCommitmentBase {
  commitmentType: 'ShieldCommitment'
  shieldKey: string
  fee?: string
  encryptedBundle: string[]
  preimage: {
    id: string
    npk: string
    value: string
    token: {
      id: string
      tokenType: number
      tokenSubID: string
      tokenAddress: string
    }
  }
}

// Transact Commitment type
interface SubsquidTransactCommitment extends SubsquidCommitmentBase {
  commitmentType: 'TransactCommitment'
  ciphertext: {
    id: string
    ciphertext: {
      id: string
      iv: string
      tag: string
      data: string[]
    }
    blindedSenderViewingKey: string
    blindedReceiverViewingKey: string
    annotationData: string
    memo: string
  }
}

// Union type for all commitment types
type SubsquidCommitment =
  | SubsquidLegacyGeneratedCommitment
  | SubsquidLegacyEncryptedCommitment
  | SubsquidShieldCommitment
  | SubsquidTransactCommitment

// Nullifier event type for spent UTXO detection
interface SubsquidNullifier {
  id: string
  nullifier: string
  blockNumber: number
  transactionHash: string
  blockTimestamp: number
}

// PPOI types
interface POIProof {
  listKey: string
  snarkProof: {
    pi_a: string[]
    pi_b: string[][]
    pi_c: string[]
  }
  txidMerkleroot: string
  txidMerklerootIndex: number
  blindedCommitmentsOut: string[]
  railgunTxidIfHasUnshield: string
  poiMerkleroots: string[]
}

interface POIStatus {
  listKey: string
  status: 'valid' | 'invalid' | 'pending' | 'missing'
  proof?: POIProof
}

// Wallet state management
interface WalletState {
  isInitialized: boolean
  currentWallet?: RailgunWallet
  currentNetwork: NetworkName
  balances: TokenBalance[]
  transactions: DetailedTransaction[]
  balanceMode: 'private' | 'public'
  lastBalanceUpdate?: number // Timestamp of last balance refresh
}

// Decrypted commitment from balance scanning
interface DecryptedCommitment {
  id: string
  hash: string
  txid: string
  blockNumber: number
  treeNumber: number
  batchStartTreePosition: number
  position: number
  commitmentType: string
  tokenAddress: string
  tokenType: number
  tokenSubID: string
  value: bigint
  npk: string
  isSpent: boolean
  timestamp: number
  random: string
  senderMasterPublicKey?: string
  blindedSenderViewingKey?: string
  isSentNote?: boolean
  isSentToOther?: boolean // True if this commitment was sent to another wallet (not change, not our UTXO)
  outputType?: number // OutputType from annotation data: 0=Transfer, 1=Withdraw, 2=Change
  memoText?: string // Decrypted memo from on-chain annotationData
  receiverAddress?: string // Reconstructed 0zk address of receiver (for sent-to-other commitments)
  balanceBucket?: BalanceBucket
  poisPerList?: Record<string, 'Valid' | 'Invalid' | 'Missing' | 'ProofSubmitted' | 'ShieldBlocked'>
}

// Token information from on-chain or cached data
interface TokenInfo {
  address: string
  symbol: string
  name: string
  decimals: number
}

// Parameters for shield transactions
interface ShieldTransactionParams {
  tokenAddress: string
  amount: string // Amount in token's smallest unit (wei for ETH, etc.)
  recipientRailgunAddress: string
}

export type {
  TransactionType,
  KnownTransactionType,
  POICommitmentType,
  RailgunWallet,
  SavedWalletMetadata,
  GasPayerWallet,
  TokenBalance,
  DetailedTransaction,
  SubsquidTransaction,
  SubsquidCommitmentBase,
  SubsquidLegacyGeneratedCommitment,
  SubsquidLegacyEncryptedCommitment,
  SubsquidShieldCommitment,
  SubsquidTransactCommitment,
  SubsquidCommitment,
  SubsquidNullifier,
  POIProof,
  POIStatus,
  WalletState,
  DecryptedCommitment,
  TokenInfo,
  ShieldTransactionParams,
}
export { TRANSACTION_TYPES, POI_COMMITMENT_TYPES }
