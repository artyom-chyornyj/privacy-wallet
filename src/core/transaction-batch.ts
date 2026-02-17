import { InMemoryDatabase } from './merkletrees/database'
import type { TokenData, TokenType } from './transact-note'
import { TransactNote } from './transact-note'
import type { AdaptID, Chain, TXO, UnshieldData } from './transaction'
import { Transaction } from './transaction'

import { OnChainBalanceScanner } from '@/services/OnChainBalanceScanner'
import { POIService } from '@/services/POIService'
import { SubsquidBalanceScanner } from '@/services/SubsquidBalanceScanner'
import { NetworkName } from '@/types/network'
import type { DecryptedCommitment, RailgunWallet } from '@/types/wallet'
import { getTokenDataHash } from '@/utils/railgun-crypto'

export interface SpendingSolutionGroup {
  tokenData: TokenData
  utxos: TXO[]
  spendingTree: number
  amount: bigint
  tokenOutputs: TransactNote[]
  unshieldValue: bigint
}

/**
 * Manages a batch of RAILGUN transaction outputs and generates spending solution groups.
 */
export class TransactionBatch {
  /** The adapt ID for cross-contract calls, defaults to zero address. */
  private adaptID: AdaptID = {
    contract: '0x0000000000000000000000000000000000000000',
    parameters: '0x0000000000000000000000000000000000000000000000000000000000000000',
  }

  /** The list of output notes to include in the transaction. */
  private outputs: TransactNote[] = []
  /** Map of token hash to unshield data for each token being unshielded. */
  private unshieldDataMap: { [tokenHash: string]: UnshieldData } = {}
  /** The minimum gas price for the overall batch. */
  private overallBatchMinGasPrice: bigint
  /** The network this transaction batch targets. */
  private networkName: NetworkName

  /**
   * Creates a new TransactionBatch for the given network.
   * @param networkName - The target network for this batch
   * @param overallBatchMinGasPrice - The minimum gas price for the batch
   */
  constructor (networkName: NetworkName, overallBatchMinGasPrice: bigint = BigInt(0)) {
    this.networkName = networkName
    this.overallBatchMinGasPrice = overallBatchMinGasPrice
  }

  /**
   * Returns the minimum gas price configured for this batch.
   * @returns The minimum gas price as a bigint
   */
  getOverallBatchMinGasPrice (): bigint {
    return this.overallBatchMinGasPrice
  }

  /**
   * Adds a transaction output note to the batch.
   * @param output - The TransactNote to add as an output
   */
  addOutput (output: TransactNote) {
    this.outputs.push(output)
  }

  /**
   * Clears all output notes from the batch.
   */
  resetOutputs () {
    this.outputs = []
  }

  /**
   * Sets the adapt ID for cross-contract call integration.
   * @param adaptID - The adapt ID containing contract address and parameters
   */
  setAdaptID (adaptID: AdaptID) {
    this.adaptID = adaptID
  }

  /**
   * Registers unshield data for a token. Only one unshield per token per batch is allowed.
   * @param unshieldData - The unshield parameters including token data and value
   */
  addUnshieldData (unshieldData: UnshieldData) {
    const tokenHash = getTokenDataHash(unshieldData.tokenData)
    if (this.unshieldDataMap[tokenHash]) {
      throw new Error(
        'You may only call .addUnshieldData once per token for a given TransactionBatch.'
      )
    }
    if (unshieldData.value === 0n) {
      throw new Error('Unshield value must be greater than 0.')
    }
    this.unshieldDataMap[tokenHash] = unshieldData
  }

  /**
   * Clears all registered unshield data from the batch.
   */
  resetUnshieldData () {
    this.unshieldDataMap = {}
  }

  /**
   * Returns the total unshield value for a token, or zero if none registered.
   * @param tokenHash - The token data hash to look up
   * @returns The unshield value as a bigint
   */
  private unshieldTotal (tokenHash: string): bigint {
    return this.unshieldDataMap[tokenHash] ? this.unshieldDataMap[tokenHash].value : BigInt(0)
  }

  /**
   * Generate spending solution groups for all outputs
   * @param wallet - The wallet to select spendable UTXOs from
   * @returns Array of spending solution groups, one per token
   */
  async generateSpendingSolutionGroups (wallet: RailgunWallet): Promise<SpendingSolutionGroup[]> {
    const tokenDatas = this.getOutputTokenDatas()
    const spendingSolutionGroups: SpendingSolutionGroup[] = []

    for (const tokenData of tokenDatas) {
      const tokenHash = getTokenDataHash(tokenData)
      const tokenOutputs = this.outputs.filter((output) => output.tokenHash === tokenHash)

      const outputTotal = TransactNote.calculateTotalNoteValues(tokenOutputs)
      const unshieldValue = this.unshieldTotal(tokenHash)
      const totalRequired = outputTotal + unshieldValue

      if (totalRequired === 0n) continue

      // Get available UTXOs from balance scanner
      // Use OnChainBalanceScanner for Hardhat, SubsquidBalanceScanner for other networks
      let allUTXOs: any[]
      if (this.networkName === 'Hardhat') {
        const scanner = OnChainBalanceScanner.getInstance()
        allUTXOs = scanner.getDecryptedCommitmentsForWallet(wallet.id)
      } else {
        const scanner = SubsquidBalanceScanner.getInstance()
        allUTXOs = scanner.getDecryptedCommitmentsForWallet(wallet.id)
      }

      // Filter UTXOs: unspent, matching token, and valid PPOI status
      const poiService = POIService.getInstance()
      const subsquidScanner =
        this.networkName !== 'Hardhat' ? SubsquidBalanceScanner.getInstance() : null

      const availableUTXOs = allUTXOs
        .filter((utxo: DecryptedCommitment) => {
          const isNotSpent = !utxo.isSpent
          const tokenMatch =
            utxo.tokenAddress.toLowerCase() === tokenData.tokenAddress.toLowerCase()
          if (!isNotSpent || !tokenMatch || utxo.isSentToOther) return false

          // Enforce PPOI: only spend UTXOs with valid PPOI status (skip for Hardhat local testnet)
          if (subsquidScanner) {
            const blindedCommitment = subsquidScanner.blindedCommitmentOf(utxo)
            const commitmentType =
              utxo.commitmentType === 'ShieldCommitment' ? 'Shield' : 'Transact'
            const cachedStatus = poiService.getPOIStatusForCommitmentsFromCacheOnly(
              this.networkName,
              [{ blindedCommitment, type: commitmentType as 'Shield' | 'Transact' | 'Unshield' }]
            )
            const poiStatus = cachedStatus[blindedCommitment]?.status
            return poiStatus === 'valid'
          }
          return true
        })
        .sort((a: DecryptedCommitment, b: DecryptedCommitment) => Number(b.value - a.value)) // Sort by value descending

      // Simple greedy selection
      let totalSelected = 0n
      const selectedUTXOs: DecryptedCommitment[] = []

      for (const utxo of availableUTXOs) {
        if (totalSelected >= totalRequired) break
        selectedUTXOs.push(utxo)
        totalSelected += utxo.value
      }

      if (totalSelected < totalRequired) {
        throw new Error(
          `Insufficient spendable balance for ${tokenData.tokenAddress}. ` +
            `Required: ${totalRequired.toString()}, PPOI-valid available: ${totalSelected.toString()}. ` +
            'Some funds may be pending PPOI validation.'
        )
      }

      spendingSolutionGroups.push({
        tokenData,
        utxos: this.convertToTXOs(selectedUTXOs),
        spendingTree: selectedUTXOs[0]?.treeNumber ?? 0,
        amount: totalSelected,
        tokenOutputs,
        unshieldValue,
      })
    }

    return spendingSolutionGroups
  }

  /**
   * Convert DecryptedCommitment objects to TXO objects
   * @param commitments - Array of decrypted commitments to convert
   * @returns Array of TXO objects suitable for transaction construction
   */
  private convertToTXOs (commitments: DecryptedCommitment[]): TXO[] {
    return commitments.map((commitment): TXO => {
      const txo: TXO = {
        tree: commitment.treeNumber,
        position: commitment.position,
        blockNumber: commitment.blockNumber,
        spendtxid: commitment.isSpent,
        note: {
          npk: commitment.npk,
          value: commitment.value,
          tokenData: {
            tokenType: commitment.tokenType as TokenType,
            tokenAddress: commitment.tokenAddress,
            tokenSubID: commitment.tokenSubID,
          },
          random: commitment.random,
        },
        txid: commitment.txid,
        commitmentType: commitment.commitmentType === 'ShieldCommitment' ? 0 : 1,
        nullifier: '', // Will be computed when needed
      }

      if (commitment.timestamp != null) {
        txo.timestamp = commitment.timestamp
      }
      if (commitment.poisPerList) {
        txo.poisPerList = commitment.poisPerList
      }
      if ((commitment as any).blindedCommitment) {
        txo.blindedCommitment = (commitment as any).blindedCommitment
      }
      if ((commitment as any).transactCreationRailgunTxid) {
        txo.transactCreationRailgunTxid = (commitment as any).transactCreationRailgunTxid
      }

      return txo
    })
  }

  /**
   * Get change output if spending more than required
   * @param wallet - The wallet to send change back to
   * @param spendingSolutionGroup - The spending solution to compute change for
   * @returns A TransactNote for the change output, or undefined if no change is needed
   */
  static getChangeOutput (
    wallet: RailgunWallet,
    spendingSolutionGroup: SpendingSolutionGroup
  ): TransactNote | undefined {
    // Calculate total input from UTXOs
    const totalIn = spendingSolutionGroup.utxos.reduce((sum, utxo) => sum + utxo.note.value, 0n)

    // Calculate total output (note values + unshield)
    const totalOutputNoteValues = TransactNote.calculateTotalNoteValues(
      spendingSolutionGroup.tokenOutputs
    )
    const totalOut = totalOutputNoteValues + spendingSolutionGroup.unshieldValue

    const change = totalIn - totalOut
    if (change < 0n) {
      throw new Error('Negative change value - transaction not possible.')
    }

    // Only create change output if there's actual change
    const requiresChangeOutput = change > 0n
    const changeOutput = requiresChangeOutput
      ? TransactNote.createTransfer(
        wallet.address,
        {
          masterPublicKey: BigInt(wallet.masterPublicKey),
          viewingPublicKey: new Uint8Array(),
        },
        change,
        spendingSolutionGroup.tokenData,
        true // showSenderAddressToRecipient
      )
      : undefined
    return changeOutput
  }

  /**
   * Collects the unique token data from all outputs and unshield entries.
   * @returns Array of deduplicated TokenData objects
   */
  private getOutputTokenDatas (): TokenData[] {
    const tokenHashes: string[] = []
    const tokenDatas: TokenData[] = []
    const outputTokenDatas: TokenData[] = this.outputs.map((output) => output.tokenData)
    const unshieldTokenDatas: TokenData[] = Object.values(this.unshieldDataMap).map(
      (output) => output.tokenData
    )
    for (const tokenData of [...outputTokenDatas, ...unshieldTokenDatas]) {
      const tokenHash = getTokenDataHash(tokenData)
      if (!tokenHashes.includes(tokenHash)) {
        tokenHashes.push(tokenHash)
        tokenDatas.push(tokenData)
      }
    }
    return tokenDatas
  }

  /**
   * Returns a shallow copy of all output notes in this batch.
   * @returns Array of TransactNote outputs
   */
  getOutputs (): TransactNote[] {
    return [...this.outputs]
  }

  /**
   * Returns all registered unshield data entries.
   * @returns Array of UnshieldData objects
   */
  getUnshieldData (): UnshieldData[] {
    return Object.values(this.unshieldDataMap)
  }

  /**
   * Checks whether this batch includes any unshield operations.
   * @returns True if at least one unshield data entry is registered
   */
  hasUnshield (): boolean {
    return Object.keys(this.unshieldDataMap).length > 0
  }

  /**
   * Generate a transaction for a spending solution group
   * @param networkName - The target network for the transaction
   * @param spendingSolutionGroup - The spending solution containing UTXOs and outputs
   * @param changeOutput - Optional change output note to include
   * @returns A Transaction instance ready for proof generation
   */
  generateTransactionForSpendingSolutionGroup (
    networkName: NetworkName,
    spendingSolutionGroup: SpendingSolutionGroup,
    changeOutput: TransactNote | undefined
  ): Transaction {
    const chain: Chain = {
      type: 0,
      id: this.getChainId(networkName),
    }

    const { spendingTree, utxos, tokenOutputs, unshieldValue, tokenData } = spendingSolutionGroup
    const allOutputs = changeOutput ? [...tokenOutputs, changeOutput] : tokenOutputs

    const db = new InMemoryDatabase()
    const transaction = new Transaction(
      chain,
      tokenData,
      spendingTree,
      utxos,
      allOutputs,
      this.adaptID,
      db
    )

    const tokenHash = getTokenDataHash(tokenData)
    if (this.unshieldDataMap[tokenHash] && unshieldValue > 0n) {
      transaction.addUnshieldData(this.unshieldDataMap[tokenHash], unshieldValue)
    }

    return transaction
  }

  /**
   * Maps a network name to its corresponding chain ID.
   * @param networkName - The network name to resolve
   * @returns The numeric chain ID
   */
  private getChainId (networkName: NetworkName): number {
    switch (networkName) {
      case NetworkName.EthereumSepolia:
        return 11155111
      default:
        return 31337 // hardhat local
    }
  }
}
