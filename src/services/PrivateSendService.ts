import { ethers } from 'ethers'

import { OnChainBalanceScanner } from './OnChainBalanceScanner'
import { SentTransactionStorage } from './SentTransactionStorage'
import { TransactionMetadataService } from './TransactionMetadataService'

import RailgunSmartWalletABI from '@/core/abis/RailgunSmartWallet.json'
import { InMemoryDatabase } from '@/core/merkletrees/database'
import { TokenType, TransactNote } from '@/core/transact-note'
import { Transaction } from '@/core/transaction'
import type { SpendingSolutionGroup } from '@/core/transaction-batch'
import { TransactionBatch } from '@/core/transaction-batch'
import type { AddressData } from '@/types/core'
import type { NetworkName } from '@/types/network'
import { NETWORK_CONFIG } from '@/types/network'
import type { RailgunWallet } from '@/types/wallet'
import { ByteUtils, getPublicViewingKey } from '@/utils/crypto'
import { derror, dlog } from '@/utils/debug'
import { decodeRailgunAddress } from '@/utils/railgun-address'
import { formatTransactionForContract } from '@/utils/transaction-utils'

type SendParams = {
  tokenAddress: string
  amount: string // smallest units
  recipientRailgunAddress: string
  memoText?: string // encrypted on-chain memo (max 30 bytes)
}

/**
 * Private Send Service using TransactionBatch system
 */
export class PrivateSendService {
  /**
   * Singleton instance of the service.
   */
  private static instance: PrivateSendService

  /**
   * Get the singleton instance of PrivateSendService.
   * @returns The shared PrivateSendService instance
   */
  static getInstance (): PrivateSendService {
    if (!this.instance) this.instance = new PrivateSendService()
    return this.instance
  }

  /**
   * Derive AddressData (with public viewing key) from a RailgunWallet.
   * @param wallet - The RAILGUN wallet to extract address data from
   * @returns The address data containing masterPublicKey and viewingPublicKey
   */
  private async walletToAddressData (wallet: RailgunWallet): Promise<AddressData> {
    if (!wallet.masterPublicKey) {
      throw new Error('Wallet missing masterPublicKey - ensure wallet is properly initialized')
    }
    if (!wallet.viewingKey) {
      throw new Error('Wallet missing viewingKey - ensure wallet is properly initialized')
    }

    // viewingKey is the PRIVATE key - derive the PUBLIC key from it
    const viewingPublicKey = await getPublicViewingKey(
      ByteUtils.hexStringToBytes(wallet.viewingKey)
    )

    return {
      masterPublicKey: BigInt(wallet.masterPublicKey),
      viewingPublicKey,
    }
  }

  /**
   * Execute private send using TransactionBatch system with real zk-SNARK proofs.
   * @param wallet - The RAILGUN wallet sending the transaction
   * @param networkName - The network to send on
   * @param params - The send parameters including token, amount, and recipient
   * @param provider - The ethers JSON-RPC provider for on-chain interaction
   * @param onStatus - Optional callback for status updates during the send process
   * @param dryRun - If true, only simulates with staticCall without submitting
   * @param gasPayerMnemonic - Optional mnemonic for a separate gas-paying wallet
   * @returns The transaction hash and optional PPOI data for proof submission
   */
  async executePrivateSend (
    wallet: RailgunWallet,
    networkName: NetworkName,
    params: SendParams,
    provider?: any,
    onStatus?: (s: string) => void,
    dryRun: boolean = false,
    gasPayerMnemonic?: string
  ): Promise<{
    txHash: string
    ppoiData?: {
      nullifiers: string[]
      commitments: string[]
      boundParamsHash: string
    }
  }> {
    try {
      const network = NETWORK_CONFIG[networkName]
      if (!network) throw new Error(`Unsupported network: ${networkName}`)
      if (!wallet.mnemonic) throw new Error('Wallet missing mnemonic for signing')
      if (!wallet.masterPublicKey) { throw new Error('Wallet missing masterPublicKey - please re-create wallet') }
      if (!wallet.nullifyingKey) { throw new Error('Wallet missing nullifyingKey - please re-create wallet') }
      if (!wallet.viewingKey) throw new Error('Wallet missing viewingKey - please re-create wallet')
      if (!wallet.spendingKey) { throw new Error('Wallet missing spendingKey - please re-create wallet') }

      onStatus?.('Building transaction with TransactionBatch…')

      // Get current gas price from provider
      let minGasPrice = BigInt(1000000000) // 1 gwei fallback
      if (provider) {
        try {
          const feeData = await provider.getFeeData()
          minGasPrice = feeData.gasPrice || minGasPrice
        } catch {
          // Use fallback gas price
        }
      }

      const transactionBatch = new TransactionBatch(networkName, minGasPrice)
      const senderAddressData = await this.walletToAddressData(wallet)

      // Validate recipient address
      try {
        decodeRailgunAddress(params.recipientRailgunAddress)
      } catch (error: unknown) {
        throw new Error(`Invalid recipient address: ${error instanceof Error ? error.message : String(error)}`)
      }

      const transferOutput = TransactNote.createTransfer(
        params.recipientRailgunAddress,
        senderAddressData,
        BigInt(params.amount),
        {
          tokenType: TokenType.ERC20,
          tokenAddress: params.tokenAddress,
          tokenSubID: '0x00',
        },
        true, // showSenderAddressToRecipient
        params.memoText
      )

      transactionBatch.addOutput(transferOutput)

      onStatus?.('Selecting UTXOs with SpendingSolutionGroups…')

      const spendingSolutionGroups = await transactionBatch.generateSpendingSolutionGroups(wallet)
      if (!spendingSolutionGroups.length) {
        throw new Error('No spending solution groups found - insufficient balance')
      }

      dlog(`Generated ${spendingSolutionGroups.length} spending solution groups`)
      onStatus?.('Generating zero-knowledge proofs…')

      // Build Transaction objects for each spending solution group
      const transactions: Transaction[] = []
      for (const group of spendingSolutionGroups) {
        const change = group.amount - transferOutput.value

        let changeOutput: TransactNote | undefined
        if (change > 0n) {
          changeOutput = TransactNote.createTransfer(
            wallet.address,
            senderAddressData,
            change,
            {
              tokenType: TokenType.ERC20,
              tokenAddress: params.tokenAddress,
              tokenSubID: '0x00',
            },
            true,
            undefined
          )
          dlog('Change output created')
        }

        const transaction = this.buildTransactionFromGroup(group, changeOutput, networkName)
        transactions.push(transaction)
      }

      // Generate SNARK proofs
      dlog('Generating zero-knowledge proofs...')
      const provedTransactions = []

      for (const transaction of transactions) {
        const batchMinGasPrice = transactionBatch.getOverallBatchMinGasPrice()
        dlog(
          `boundParams.minGasPrice: ${batchMinGasPrice} wei (${ethers.formatUnits(batchMinGasPrice, 'gwei')} gwei)`
        )

        const globalBoundParams = {
          minGasPrice: batchMinGasPrice,
          chainID: NETWORK_CONFIG[networkName].chainId,
          senderCiphertext: '0x',
          to: '0x0000000000000000000000000000000000000000',
          data: '0x',
        }

        const transactionRequest = await transaction.generateTransactionRequest(
          wallet,
          globalBoundParams
        )
        const provedTransaction = await transaction.generateProvedTransaction(
          transactionRequest,
          (progress: number) => {
            onStatus?.(`Generating proof: ${progress}%`)
          }
        )

        provedTransactions.push(provedTransaction)
      }

      if (!provider) {
        throw new Error('Provider required for on-chain transaction submission')
      }

      const txHash = await this.submitTransactionsToContract(
        provedTransactions,
        provider,
        networkName,
        wallet,
        dryRun,
        gasPayerMnemonic
      )

      if (!dryRun) {
        // Clear UTXO cache to force rescan on next balance check
        try {
          const scanner = OnChainBalanceScanner.getInstance()
          scanner.clearStoredTXOs(wallet.id)
        } catch {
          // Non-fatal
        }

        // Save transaction metadata for UI display
        try {
          TransactionMetadataService.getInstance().saveMetadata({
            txid: txHash,
            walletId: wallet.id,
            recipientAddress: params.recipientRailgunAddress,
            ...(params.memoText ? { memo: params.memoText } : {}),
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        } catch {
          // Non-fatal
        }

        // Update SentTransactionStorage with the actual transaction hash for PPOI proof retrieval
        try {
          const sentStorage = SentTransactionStorage.getInstance()
          const storedOutputs = sentStorage.getSentOutputs(wallet.address)
          const emptyHashOutputs = storedOutputs.filter(
            (o) => !o.transactionHash || o.transactionHash === ''
          )
          if (emptyHashOutputs.length > 0) {
            for (const output of emptyHashOutputs) {
              output.transactionHash = txHash
            }
            sentStorage.clearWalletOutputs(wallet.address)
            sentStorage.storeSentOutputs(wallet.address, storedOutputs)
            dlog(
              `Updated ${emptyHashOutputs.length} sent outputs with txHash: ${txHash.slice(0, 10)}...`
            )
          }
        } catch (storageError) {
          console.warn('Failed to update sent transaction storage:', storageError)
        }
      }

      // Return PPOI data from proved transactions for immediate PPOI submission
      if (provedTransactions.length > 0 && provedTransactions[0]) {
        const ppoiData = {
          nullifiers: provedTransactions[0].nullifiers as string[],
          commitments: provedTransactions[0].commitments as string[],
          boundParamsHash: provedTransactions[0].boundParamsHash as string,
        }
        return { txHash, ppoiData }
      }

      return { txHash }
    } catch (error) {
      derror('Error in executePrivateSend:', error)
      throw error
    }
  }

  /**
   * Submit proved transactions to RAILGUN smart contract.
   * @param provedTransactions - The transactions with generated zk-SNARK proofs
   * @param provider - The ethers JSON-RPC provider
   * @param networkName - The network to submit on
   * @param wallet - The RAILGUN wallet for transaction signing
   * @param dryRun - Whether to only simulate via staticCall
   * @param gasPayerMnemonic - Optional mnemonic for a separate gas-paying wallet
   * @returns The on-chain transaction hash
   */
  private async submitTransactionsToContract (
    provedTransactions: any[],
    provider: any,
    networkName: NetworkName,
    wallet: RailgunWallet,
    dryRun: boolean = false,
    gasPayerMnemonic?: string
  ): Promise<string> {
    const network = NETWORK_CONFIG[networkName]
    if (!network) throw new Error(`Network ${networkName} not configured`)

    const signerMnemonic = gasPayerMnemonic || wallet.mnemonic
    if (!signerMnemonic) {
      throw new Error('No mnemonic available for transaction signing')
    }
    const signer = ethers.Wallet.fromPhrase(signerMnemonic).connect(provider)
    const contract = new ethers.Contract(
      network.railgunProxyContract,
      RailgunSmartWalletABI,
      signer
    )

    const formattedTransactions = provedTransactions.map((tx) => formatTransactionForContract(tx))

    // Verify bound params hash matches between proof and contract
    const hashBoundParamsFn = contract['hashBoundParams'] as (params: any) => Promise<bigint>
    const contractBoundParamsHash = await hashBoundParamsFn(formattedTransactions[0].boundParams)
    const proofBoundParamsHash = provedTransactions[0].boundParamsHash

    if (contractBoundParamsHash.toString() !== proofBoundParamsHash?.toString()) {
      throw new Error(
        'Bound params hash mismatch detected! Proof cannot be verified with different bound params.'
      )
    }

    // Verify all public inputs match
    const tx0 = formattedTransactions[0]
    const merkleRootMatch = provedTransactions[0].merkleRoot === tx0.merkleRoot
    const boundParamsHashMatch = proofBoundParamsHash === contractBoundParamsHash.toString()
    const nullifiersMatch =
      JSON.stringify(provedTransactions[0].nullifiers) === JSON.stringify(tx0.nullifiers)
    const commitmentsMatch =
      JSON.stringify(provedTransactions[0].commitments) === JSON.stringify(tx0.commitments)

    if (!merkleRootMatch || !boundParamsHashMatch || !nullifiersMatch || !commitmentsMatch) {
      throw new Error('Public inputs mismatch between proof generation and contract verification')
    }

    // Verify verification key exists for this circuit size
    const nullifiersCount = formattedTransactions[0].nullifiers?.length || 0
    const commitmentsCount = formattedTransactions[0].commitments?.length || 0
    try {
      const getVerificationKeyFn = contract['getVerificationKey'] as (
        n: number,
        c: number,
      ) => Promise<any>
      const verificationKey = await getVerificationKeyFn(nullifiersCount, commitmentsCount)
      if (verificationKey.alpha1.x.toString() === '0') {
        throw new Error(
          `No verification key set for circuit (${nullifiersCount}x${commitmentsCount})`
        )
      }
    } catch {
      // Verification key check non-fatal
    }

    // Verify merkle root hasn't changed since proof generation
    const merkleRootFn = contract['merkleRoot'] as () => Promise<string>
    const currentContractMerkleRoot = await merkleRootFn()
    const proofMerkleRootBigInt = BigInt(formattedTransactions[0].merkleRoot)
    const contractMerkleRootBigInt = BigInt(currentContractMerkleRoot)

    if (contractMerkleRootBigInt !== proofMerkleRootBigInt) {
      throw new Error(
        `Merkle root mismatch! Proof was generated with ${proofMerkleRootBigInt}, ` +
          `but contract now has ${contractMerkleRootBigInt}. The merkle tree has changed since proof generation.`
      )
    }

    // Validate proof structure
    const proof = formattedTransactions[0].proof
    if (!proof || !proof.a || !proof.b || !proof.c) {
      throw new Error('Proof structure is invalid - missing a, b, or c components')
    }

    // Gas price with 50% buffer
    const feeData = await provider.getFeeData()
    const gasPrice = feeData.gasPrice
      ? (feeData.gasPrice * 150n) / 100n
      : ethers.parseUnits('50', 'gwei')
    dlog('Using gas price:', ethers.formatUnits(gasPrice, 'gwei'), 'gwei')

    const transactFn = contract['transact'] as ethers.BaseContractMethod
    if (!transactFn) {
      throw new Error('Contract does not have transact function')
    }

    // Contract checks tx.gasprice >= boundParams.minGasPrice
    const gasEstimate = await transactFn.estimateGas(formattedTransactions, { gasPrice })
    dlog('Gas estimate for transact:', gasEstimate.toString())

    if (dryRun) {
      dlog('DRY RUN: Simulating with staticCall...')
      await transactFn.staticCall(formattedTransactions, {
        gasLimit: Math.floor(Number(gasEstimate) * 1.2),
        gasPrice,
      })
      dlog('Static call succeeded - transaction would be valid on-chain')
      return '0x' + '0'.repeat(64)
    }

    const txResponse = await transactFn(formattedTransactions, {
      gasLimit: Math.floor(Number(gasEstimate) * 1.2),
      gasPrice,
    })

    dlog('Transaction submitted, waiting for confirmation...')
    const receipt = await txResponse.wait()
    dlog('Transaction confirmed')

    return receipt.hash
  }

  /**
   * Build a Transaction from a SpendingSolutionGroup.
   * @param group - The spending solution group containing UTXOs and outputs
   * @param changeOutput - The optional change output note to send back to the sender
   * @param networkName - The network for chain configuration
   * @returns The constructed Transaction ready for proof generation
   */
  private buildTransactionFromGroup (
    group: SpendingSolutionGroup,
    changeOutput: TransactNote | undefined,
    networkName: NetworkName
  ): Transaction {
    const { spendingTree, utxos, tokenOutputs, unshieldValue, tokenData } = group

    if (unshieldValue > 0) {
      throw new Error(
        'Private send should not have unshield value. Use UnshieldService for unshield operations.'
      )
    }

    const allOutputs = changeOutput ? [...tokenOutputs, changeOutput] : tokenOutputs

    const network = NETWORK_CONFIG[networkName]
    const chain = { type: 0, id: network.chainId } // EVM
    const adaptID = {
      contract: '0x0000000000000000000000000000000000000000',
      parameters: '0x0000000000000000000000000000000000000000000000000000000000000000',
    }

    const db = new InMemoryDatabase()
    return new Transaction(chain, tokenData, spendingTree, utxos, allOutputs, adaptID, db)
  }
}
