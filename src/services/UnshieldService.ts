import { AbiCoder, ethers, keccak256 } from 'ethers'

import { POIService } from './POIService'
import { SubsquidBalanceScanner } from './SubsquidBalanceScanner'
import { TransactionMetadataService } from './TransactionMetadataService'

import RailgunSmartWalletABI from '@/core/abis/RailgunSmartWallet.json'
import RelayAdaptABI from '@/core/abis/RelayAdapt.json'
import { InMemoryDatabase } from '@/core/merkletrees/database'
import { TokenType } from '@/core/transact-note'
import type { TransactionStruct } from '@/core/transaction'
import { Transaction } from '@/core/transaction'
import type { SpendingSolutionGroup } from '@/core/transaction-batch'
import { TransactionBatch } from '@/core/transaction-batch'
import type { NetworkName } from '@/types/network'
import { NETWORK_CONFIG } from '@/types/network'
import type { RailgunWallet } from '@/types/wallet'
import { ByteUtils } from '@/utils/crypto'
import { formatTransactionForContract } from '@/utils/transaction-utils'

type UnshieldParams = {
  tokenAddress: string
  amount: string // smallest units
  recipient: string // 0x address
}

/**
 * Service for executing RAILGUN unshield transactions that move funds from private to public addresses.
 */
export class UnshieldService {
  /**
   * Singleton instance of the UnshieldService.
   */
  private static instance: UnshieldService

  /**
   * Returns the singleton instance of UnshieldService, creating it if necessary.
   * @returns The singleton UnshieldService instance
   */
  static getInstance (): UnshieldService {
    if (!this.instance) this.instance = new UnshieldService()
    return this.instance
  }

  /**
   * Executes a standard unshield transaction that moves ERC20 tokens from RAILGUN private balance to a public address.
   * @param wallet - The RAILGUN wallet containing the private balance to unshield from
   * @param networkName - The network to execute the unshield transaction on
   * @param params - Unshield parameters including token address, amount, and recipient
   * @param provider - Ethers provider for blockchain interaction
   * @param onStatus - Optional callback for reporting transaction progress status
   * @param gasPayerMnemonic - Optional mnemonic for a separate gas-paying wallet for privacy
   * @returns The transaction hash and optional PPOI data for immediate proof submission
   */
  async executeUnshield (
    wallet: RailgunWallet,
    networkName: NetworkName,
    params: UnshieldParams,
    provider: ethers.Provider,
    onStatus?: (s: string) => void,
    gasPayerMnemonic?: string // Optional: Use different wallet for gas payment (privacy feature)
  ): Promise<{
    txHash: string
    ppoiData?: { nullifiers: string[]; commitments: string[]; boundParamsHash: string }
  }> {
    const network = NETWORK_CONFIG[networkName]
    if (!network) throw new Error(`Unsupported network: ${networkName}`)
    if (!wallet.mnemonic) throw new Error('Wallet missing mnemonic for signing')

    // Fast-fail: verify PPOI-valid balance before expensive proof generation
    this.validateSpendableBalance(
      wallet.id,
      networkName,
      params.tokenAddress,
      BigInt(params.amount)
    )

    onStatus?.('Generating unshield proof…')

    // Build V2 unshield transaction — returns the proved transaction object
    const provedTransaction = await this.buildV2UnshieldTransaction(wallet, params, networkName)

    onStatus?.('Submitting to network…')
    // Create signer - use gasPayerMnemonic if provided, otherwise wallet's mnemonic
    const signerMnemonic = gasPayerMnemonic || wallet.mnemonic
    const signer = ethers.Wallet.fromPhrase(signerMnemonic).connect(provider)

    // Get gas price with buffer (same approach as PrivateSendService)
    const feeData = await provider.getFeeData()
    const gasPrice = feeData.gasPrice
      ? (feeData.gasPrice * 150n) / 100n
      : ethers.parseUnits('50', 'gwei')

    // Use contract interface for gas estimation and submission (like PrivateSendService)
    const contract = new ethers.Contract(network.railgunV2Contract, RailgunSmartWalletABI, signer)

    const transactFn = contract['transact'] as ethers.BaseContractMethod
    if (!transactFn) {
      throw new Error('Contract does not have transact function')
    }

    // Format proved transaction for contract call (convert BigInts to strings for ethers.js ABI)
    const formattedTransactions = [formatTransactionForContract(provedTransaction)]

    const gasEstimate = await transactFn.estimateGas(formattedTransactions, {
      gasPrice,
    })

    const tx = await transactFn(formattedTransactions, {
      gasLimit: Math.floor(Number(gasEstimate) * 1.2),
      gasPrice,
    })

    onStatus?.('Waiting for confirmation…')
    const receipt = await tx.wait(1)

    if (receipt?.status === 0) {
      throw new Error(`Transaction failed: ${tx.hash}`)
    }

    onStatus?.('Confirmed')

    // Cache recipient address so it appears in history without Subsquid lookup
    try {
      TransactionMetadataService.getInstance().saveMetadata({
        txid: tx.hash,
        walletId: wallet.id,
        recipientAddress: params.recipient,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    } catch {
      // Non-fatal
    }

    // Extract PPOI data from proved transaction for immediate PPOI submission
    if (provedTransaction.boundParamsHash) {
      return {
        txHash: tx.hash,
        ppoiData: {
          nullifiers: provedTransaction.nullifiers,
          commitments: provedTransaction.commitments,
          boundParamsHash: provedTransaction.boundParamsHash,
        },
      }
    }

    return { txHash: tx.hash }
  }

  /**
   * Unshield WETH from private balance and unwrap to native ETH for the recipient.
   *
   * Atomic flow via RelayAdapt contract (single transaction):
   * 1. RAILGUN unshields WETH to RelayAdapt contract
   * 2. RelayAdapt calls unwrapBase() to convert WETH → ETH
   * 3. RelayAdapt calls transfer() to send ETH to the recipient
   *
   * Populate unshield base token transaction via RelayAdaptV2.
   * @param wallet - The RAILGUN wallet containing the private WETH balance to unshield
   * @param networkName - The network to execute the unshield transaction on
   * @param params - Unshield parameters including WETH token address, amount, and ETH recipient
   * @param provider - Ethers provider for blockchain interaction
   * @param onStatus - Optional callback for reporting transaction progress status
   * @param gasPayerMnemonic - Optional mnemonic for a separate gas-paying wallet for privacy
   * @returns The transaction hash and optional PPOI data for immediate proof submission
   */
  async executeUnshieldToNative (
    wallet: RailgunWallet,
    networkName: NetworkName,
    params: UnshieldParams,
    provider: ethers.Provider,
    onStatus?: (s: string) => void,
    gasPayerMnemonic?: string
  ): Promise<{
    txHash: string
    ppoiData?: { nullifiers: string[]; commitments: string[]; boundParamsHash: string }
  }> {
    const network = NETWORK_CONFIG[networkName]
    if (!network) throw new Error(`Unsupported network: ${networkName}`)
    if (!wallet.mnemonic) throw new Error('Wallet missing mnemonic for signing')

    const relayAdaptAddress = NETWORK_CONFIG[networkName]?.relayAdaptContract
    if (!relayAdaptAddress || relayAdaptAddress === '0x0000000000000000000000000000000000000000') {
      throw new Error(`RelayAdapt not available for network: ${networkName}`)
    }

    // Fast-fail: verify PPOI-valid balance before expensive proof generation
    this.validateSpendableBalance(
      wallet.id,
      networkName,
      params.tokenAddress,
      BigInt(params.amount)
    )

    onStatus?.('Building atomic unshield-to-ETH transaction…')

    // Build the proved transaction + relay call data
    const { relayCallData, provedTransaction } = await this.buildV2UnshieldBaseTokenTransaction(
      wallet,
      params,
      networkName,
      relayAdaptAddress
    )

    onStatus?.('Submitting to network…')
    const signerMnemonic = gasPayerMnemonic || wallet.mnemonic
    const signer = ethers.Wallet.fromPhrase(signerMnemonic).connect(provider)

    const feeData = await provider.getFeeData()
    const gasPrice = feeData.gasPrice
      ? (feeData.gasPrice * 150n) / 100n
      : ethers.parseUnits('50', 'gwei')

    // Send the populated relay transaction to the RelayAdapt contract
    const tx = await signer.sendTransaction({
      to: relayAdaptAddress,
      data: relayCallData,
      gasLimit: 5_000_000n, // RelayAdapt needs higher gas limit
      gasPrice,
    })

    onStatus?.('Waiting for confirmation…')
    const receipt = await tx.wait(1)

    if (receipt?.status === 0) {
      throw new Error(`Unshield-to-ETH transaction failed: ${tx.hash}`)
    }

    onStatus?.('Confirmed')

    // Cache the real ETH recipient (not the RelayAdapt intermediary) for history display
    try {
      TransactionMetadataService.getInstance().saveMetadata({
        txid: tx.hash,
        walletId: wallet.id,
        recipientAddress: params.recipient,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    } catch {
      // Non-fatal
    }

    if (provedTransaction.boundParamsHash) {
      return {
        txHash: tx.hash,
        ppoiData: {
          nullifiers: provedTransaction.nullifiers,
          commitments: provedTransaction.commitments,
          boundParamsHash: provedTransaction.boundParamsHash,
        },
      }
    }

    return { txHash: tx.hash }
  }

  /**
   * Pre-flight check: verify sufficient PPOI-valid balance before expensive proof generation.
   * @param walletId - The wallet ID to check balances for
   * @param networkName - The network to validate balances on
   * @param tokenAddress - The token contract address to check the balance of
   * @param amount - The required amount in smallest token units
   */
  private validateSpendableBalance (
    walletId: string,
    networkName: NetworkName,
    tokenAddress: string,
    amount: bigint
  ): void {
    const scanner = SubsquidBalanceScanner.getInstance()
    const allCommitments = scanner.getDecryptedCommitmentsForWallet(walletId)
    const poiService = POIService.getInstance()

    const validTxos = allCommitments.filter((c) => {
      if (c.isSpent || c.isSentToOther || c.tokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) return false

      const blindedCommitment = scanner.blindedCommitmentOf(c)
      const commitmentType = c.commitmentType === 'ShieldCommitment' ? 'Shield' : 'Transact'
      const cachedStatus = poiService.getPOIStatusForCommitmentsFromCacheOnly(networkName, [
        { blindedCommitment, type: commitmentType as 'Shield' | 'Transact' | 'Unshield' },
      ])
      return cachedStatus[blindedCommitment]?.status === 'valid'
    })

    if (!validTxos.length) {
      throw new Error(
        'No spendable private balance for token. Funds may be pending PPOI validation.'
      )
    }

    const spendableBalance = validTxos.reduce((sum, c) => sum + c.value, 0n)
    if (spendableBalance < amount) {
      throw new Error(
        `RAILGUN spendable private balance too low for ${tokenAddress}. Amount required: ${amount.toString()}. Balance: ${spendableBalance.toString()}.`
      )
    }
  }

  /**
   * Build a standard V2 unshield transaction (WETH/ERC20 directly to recipient).
   * @param wallet - The RAILGUN wallet providing spending keys and UTXOs
   * @param params - Unshield parameters including token, amount, and recipient address
   * @param networkName - The network to build the transaction for
   * @returns The proved transaction struct ready for on-chain submission
   */
  private async buildV2UnshieldTransaction (
    wallet: RailgunWallet,
    params: UnshieldParams,
    networkName: NetworkName
  ): Promise<TransactionStruct> {
    const transactionBatch = new TransactionBatch(networkName, 1000000000n)

    const unshieldTokenData = {
      tokenType: TokenType.ERC20,
      tokenAddress: params.tokenAddress,
      tokenSubID: '0x00',
    }

    transactionBatch.addUnshieldData({
      toAddress: params.recipient,
      value: BigInt(params.amount),
      tokenData: unshieldTokenData,
    })

    const spendingSolutionGroups = await transactionBatch.generateSpendingSolutionGroups(wallet)
    if (!spendingSolutionGroups.length) {
      throw new Error('No valid spending solutions found for unshield')
    }
    const spendingSolutionGroup = spendingSolutionGroups[0]!

    const changeOutput = TransactionBatch.getChangeOutput(wallet, spendingSolutionGroup)

    const transaction = this.createTransactionForUnshield(
      spendingSolutionGroup,
      changeOutput,
      networkName,
      params.recipient,
      BigInt(params.amount),
      {
        contract: '0x0000000000000000000000000000000000000000',
        parameters: '0x0000000000000000000000000000000000000000000000000000000000000000',
      }
    )

    const globalBoundParams = {
      minGasPrice: transactionBatch.getOverallBatchMinGasPrice(),
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
      () => {}
    )

    return provedTransaction
  }

  /**
   * Build an atomic unshield-to-ETH transaction via RelayAdapt.
   *
   * Replicates the flow from:
   * - wallet/tx-proof-unshield.ts: generateProofUnshieldBaseToken
   *
   * The proof commits to the RelayAdapt contract address + params hash via adaptID,
   * so the unshield MUST go through RelayAdapt — the contract verifies this.
   * @param wallet - The RAILGUN wallet providing spending keys and UTXOs
   * @param params - Unshield parameters including WETH token address, amount, and ETH recipient
   * @param networkName - The network to build the transaction for
   * @param relayAdaptAddress - The deployed RelayAdapt contract address for this network
   * @returns The relay call data for the RelayAdapt contract and the proved transaction struct
   */
  private async buildV2UnshieldBaseTokenTransaction (
    wallet: RailgunWallet,
    params: UnshieldParams,
    networkName: NetworkName,
    relayAdaptAddress: string
  ): Promise<{ relayCallData: string; provedTransaction: TransactionStruct }> {
    const unshieldValue = BigInt(params.amount)
    const unshieldTokenData = {
      tokenType: TokenType.ERC20,
      tokenAddress: params.tokenAddress,
      tokenSubID: '0x00',
    }

    // Step 1: Build dummy proof to compute relayAdaptParams hash
    // The unshield recipient is the RelayAdapt contract (not the user)
    const dummyBatch = new TransactionBatch(networkName, 1000000000n)
    dummyBatch.addUnshieldData({
      toAddress: relayAdaptAddress,
      value: unshieldValue,
      tokenData: unshieldTokenData,
    })

    const spendingSolutionGroups = await dummyBatch.generateSpendingSolutionGroups(wallet)
    if (!spendingSolutionGroups.length) {
      throw new Error('No valid spending solutions found for unshield base token')
    }
    const ssg = spendingSolutionGroups[0]!

    const changeOutput = TransactionBatch.getChangeOutput(wallet, ssg)

    // Create dummy transaction with zero adaptID to get serialized structure
    const dummyTransaction = this.createTransactionForUnshield(
      ssg,
      changeOutput,
      networkName,
      relayAdaptAddress,
      unshieldValue,
      {
        contract: '0x0000000000000000000000000000000000000000',
        parameters: '0x0000000000000000000000000000000000000000000000000000000000000000',
      }
    )

    const dummyGlobalBoundParams = {
      minGasPrice: dummyBatch.getOverallBatchMinGasPrice(),
      chainID: NETWORK_CONFIG[networkName].chainId,
      senderCiphertext: '0x',
      to: '0x0000000000000000000000000000000000000000',
      data: '0x',
    }

    const dummyRequest = await dummyTransaction.generateTransactionRequest(
      wallet,
      dummyGlobalBoundParams
    )
    // Use dummy proof (zero proof) — we only need nullifiers for relayAdaptParams hash,
    // not a real ZK proof. This avoids a ~2GB WASM allocation that would exhaust browser memory
    // before the real proof generation.
    const dummyProved = await dummyTransaction.generateDummyProvedTransaction(dummyRequest)

    // Step 2: Build the ordered calls for RelayAdapt (unwrapBase + transfer)
    const relayAdaptContract = new ethers.Contract(relayAdaptAddress, RelayAdaptABI)

    // unwrapBase(0) — 0 means "unwrap entire balance"
    const unwrapBaseFn = relayAdaptContract['unwrapBase'] as ethers.BaseContractMethod
    const unwrapBaseTx = await unwrapBaseFn.populateTransaction(0n)
    // transfer([{token: {ERC20, 0x0, 0}, to: recipient, value: 0}]) — 0 value means "transfer entire balance"
    const baseTokenData = {
      tokenType: 0,
      tokenAddress: '0x0000000000000000000000000000000000000000',
      tokenSubID: 0n,
    }
    const transferFn = relayAdaptContract['transfer'] as ethers.BaseContractMethod
    const transferTx = await transferFn.populateTransaction([
      { token: baseTokenData, to: params.recipient, value: 0n },
    ])

    const orderedCalls = [unwrapBaseTx, transferTx]

    // Step 3: Compute relayAdaptParams hash
    // Compute relay adapt params
    const relayAdaptParamsRandom = ByteUtils.randomHex(31) // 31 bytes = 62 hex chars (no 0x prefix)
    const randomBytes = ByteUtils.hexToBytes(relayAdaptParamsRandom)
    const requireSuccess = true // sendWithPublicWallet = true for self-submitted

    const formattedCalls = orderedCalls.map((call) => ({
      to: call.to || '',
      data: call.data || '',
      value: call.value ?? 0n,
    }))

    const actionData = {
      random: randomBytes,
      requireSuccess,
      minGasLimit: 0n,
      calls: formattedCalls,
    }

    // Hash: keccak256(encode(nullifiers[][], transactionsLength, actionData))
    const dummyFormatted = formatTransactionForContract(dummyProved)
    const nullifiers = [dummyFormatted.nullifiers || []]

    const relayAdaptParams = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        [
          'bytes32[][] nullifiers',
          'uint256 transactionsLength',
          'tuple(bytes31 random, bool requireSuccess, uint256 minGasLimit, tuple(address to, bytes data, uint256 value)[] calls) actionData',
        ],
        [
          nullifiers,
          1, // one transaction
          actionData,
        ]
      )
    )

    // Step 4: Re-build with the real adaptID
    const realAdaptID = {
      contract: relayAdaptAddress,
      parameters: relayAdaptParams,
    }

    // Need a fresh TransactionBatch since we can't reuse spent solution groups
    const realBatch = new TransactionBatch(networkName, 1000000000n)
    realBatch.setAdaptID(realAdaptID)
    realBatch.addUnshieldData({
      toAddress: relayAdaptAddress,
      value: unshieldValue,
      tokenData: unshieldTokenData,
    })

    const realSSGs = await realBatch.generateSpendingSolutionGroups(wallet)
    if (!realSSGs.length) {
      throw new Error('No valid spending solutions for real proof')
    }
    const realSSG = realSSGs[0]!
    const realChangeOutput = TransactionBatch.getChangeOutput(wallet, realSSG)

    const realTransaction = this.createTransactionForUnshield(
      realSSG,
      realChangeOutput,
      networkName,
      relayAdaptAddress,
      unshieldValue,
      realAdaptID
    )

    const realGlobalBoundParams = {
      minGasPrice: realBatch.getOverallBatchMinGasPrice(),
      chainID: NETWORK_CONFIG[networkName].chainId,
      senderCiphertext: '0x',
      to: '0x0000000000000000000000000000000000000000',
      data: '0x',
    }

    const realRequest = await realTransaction.generateTransactionRequest(
      wallet,
      realGlobalBoundParams
    )
    const realProved = await realTransaction.generateProvedTransaction(realRequest, () => {})

    // Step 5: Populate the RelayAdapt.relay() call
    const formattedRealTx = formatTransactionForContract(realProved)

    const relayFn = relayAdaptContract['relay'] as ethers.BaseContractMethod
    const relayTx = await relayFn.populateTransaction([formattedRealTx], actionData)

    return {
      relayCallData: relayTx.data as string,
      provedTransaction: realProved,
    }
  }

  /**
   * Create a Transaction object for unshield, with the given adaptID.
   * Shared between standard unshield and base token unshield.
   * @param spendingSolutionGroup - The spending solution containing UTXOs and token outputs to use
   * @param changeOutput - The change output to return remaining balance to the wallet, or null
   * @param networkName - The network to create the transaction for
   * @param unshieldRecipient - The recipient address for the unshielded tokens
   * @param unshieldValue - The amount to unshield in smallest token units
   * @param adaptID - The adapt ID binding the proof to a specific contract and parameters
   * @param adaptID.contract - The adapt contract address (zero address for standard unshield)
   * @param adaptID.parameters - The adapt parameters hash (zero hash for standard unshield)
   * @returns A Transaction object configured for the unshield with proof generation capabilities
   */
  private createTransactionForUnshield (
    spendingSolutionGroup: SpendingSolutionGroup,
    changeOutput: ReturnType<typeof TransactionBatch.getChangeOutput>,
    networkName: NetworkName,
    unshieldRecipient: string,
    unshieldValue: bigint,
    adaptID: { contract: string; parameters: string }
  ): Transaction {
    const { spendingTree, utxos, tokenOutputs, tokenData } = spendingSolutionGroup

    const internalOutputs = changeOutput ? [...tokenOutputs, changeOutput] : tokenOutputs

    const network = NETWORK_CONFIG[networkName]
    const chain = {
      type: 0,
      id: network.chainId,
    }

    const db = new InMemoryDatabase()
    const transaction = new Transaction(
      chain,
      tokenData,
      spendingTree,
      utxos,
      internalOutputs,
      adaptID,
      db
    )

    transaction.addUnshieldData(
      {
        toAddress: unshieldRecipient,
        tokenData,
        value: unshieldValue,
      },
      unshieldValue
    )

    return transaction
  }
}
