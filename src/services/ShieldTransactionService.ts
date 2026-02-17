import { ethers } from 'ethers'

import type { NetworkName } from '@/types/network'
import { NETWORK_CONFIG } from '@/types/network'
import type { RailgunWallet, ShieldTransactionParams } from '@/types/wallet'
import { AES } from '@/utils/aes'
import { ByteLength, ByteUtils, getPublicViewingKey } from '@/utils/crypto'
import { dlog, dwarn } from '@/utils/debug'
import { poseidon } from '@/utils/poseidon'
import { decodeRailgunAddress } from '@/utils/railgun-address'
import { getSharedSymmetricKey } from '@/utils/railgun-crypto'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEFAULT_GAS_PRICE = 20_000_000_000n // 20 gwei

interface ShieldTransactionResult {
  transaction: ethers.ContractTransaction
  gasEstimate: bigint
  shieldPrivateKey: string
}

interface GasEstimate {
  gasLimit: bigint
  gasPrice?: bigint
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  totalCost: bigint
}

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
]

// RelayAdapt Contract ABI (for ETH wrapping and shielding)
const RELAY_ADAPT_ABI = [
  'function wrapBase(uint256 _amount)',
  'function shield(tuple(tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] _shieldRequests)',
  'function multicall(bool _requireSuccess, tuple(address to, bytes data, uint256 value)[] _calls) payable',
  'function wBase() view returns (address)',
  'error CallFailed(uint256 callIndex, bytes revertReason)',
  'event CallError(uint256 callIndex, bytes revertReason)',
]

// RAILGUN Smart Wallet Contract ABI for shield function
const RAILGUN_SHIELD_ABI = [
  'function tokenBlocklist(address token) view returns (bool)',
  {
    inputs: [
      {
        components: [
          {
            components: [
              { internalType: 'bytes32', name: 'npk', type: 'bytes32' },
              {
                components: [
                  { internalType: 'enum TokenType', name: 'tokenType', type: 'uint8' },
                  { internalType: 'address', name: 'tokenAddress', type: 'address' },
                  { internalType: 'uint256', name: 'tokenSubID', type: 'uint256' },
                ],
                internalType: 'struct TokenData',
                name: 'token',
                type: 'tuple',
              },
              { internalType: 'uint120', name: 'value', type: 'uint120' },
            ],
            internalType: 'struct CommitmentPreimage',
            name: 'preimage',
            type: 'tuple',
          },
          {
            components: [
              { internalType: 'bytes32[3]', name: 'encryptedBundle', type: 'bytes32[3]' },
              { internalType: 'bytes32', name: 'shieldKey', type: 'bytes32' },
            ],
            internalType: 'struct ShieldCiphertext',
            name: 'ciphertext',
            type: 'tuple',
          },
        ],
        internalType: 'struct ShieldRequest[]',
        name: '_shieldRequests',
        type: 'tuple[]',
      },
    ],
    name: 'shield',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
]

/**
 * Shield Request interfaces matching RAILGUN contract structure
 */
interface TokenData {
  tokenType: number // 0 = ERC20, 1 = ERC721, 2 = ERC1155
  tokenAddress: string
  tokenSubID: bigint
}

interface CommitmentPreimage {
  npk: string // bytes32 - note public key
  token: TokenData
  value: bigint // uint120 - note value
}

interface ShieldCiphertext {
  encryptedBundle: [string, string, string] // bytes32[3]
  shieldKey: string // bytes32
}

interface ShieldRequest {
  preimage: CommitmentPreimage
  ciphertext: ShieldCiphertext
}

/**
 * Check whether the given token address represents native ETH (zero address or empty).
 * @param tokenAddress - The token contract address to check
 * @returns True if the address is the zero address or empty
 */
function isNativeETH (tokenAddress: string): boolean {
  return !tokenAddress || tokenAddress === ZERO_ADDRESS
}

/**
 * Build a GasEstimate from fee data and a gas limit.
 * @param provider - The ethers provider to fetch fee data from
 * @param gasLimit - The gas limit for the transaction
 * @returns A GasEstimate containing gas limit, price, and total cost
 */
async function buildGasEstimate (provider: ethers.Provider, gasLimit: bigint): Promise<GasEstimate> {
  const feeData = await provider.getFeeData()
  const gasPrice = feeData.gasPrice || DEFAULT_GAS_PRICE

  const result: GasEstimate = {
    gasLimit,
    gasPrice,
    totalCost: gasLimit * gasPrice,
  }

  if (feeData.maxFeePerGas) {
    result.maxFeePerGas = feeData.maxFeePerGas
  }
  if (feeData.maxPriorityFeePerGas) {
    result.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
  }

  return result
}

/**
 * Apply gas parameters from a GasEstimate to a transaction.
 * @param transaction - The contract transaction to apply gas parameters to
 * @param gasEstimate - The gas estimate containing gas limit and pricing data
 */
function applyGasToTransaction (
  transaction: ethers.ContractTransaction,
  gasEstimate: GasEstimate
): void {
  transaction.gasLimit = gasEstimate.gasLimit
  if (gasEstimate.maxFeePerGas && gasEstimate.maxPriorityFeePerGas) {
    transaction.maxFeePerGas = gasEstimate.maxFeePerGas
    transaction.maxPriorityFeePerGas = gasEstimate.maxPriorityFeePerGas
    transaction.type = 2 // EIP-1559
  } else if (gasEstimate.gasPrice) {
    transaction.gasPrice = gasEstimate.gasPrice
    transaction.type = 0 // Legacy
  }
}

/**
 * Create ShieldNoteERC20 for shield transaction.
 * Replicates RAILGUN engine ShieldNote for ERC20 tokens.
 */
class ShieldNoteERC20 {
  /**
   * The receiver's master public key used to derive the note public key.
   */
  readonly masterPublicKey: bigint
  /**
   * Random hex value used as entropy for the note commitment.
   */
  readonly random: string
  /**
   * The token amount in base units to shield.
   */
  readonly value: bigint
  /**
   * The ERC20 token contract address being shielded.
   */
  readonly tokenAddress: string
  /**
   * The derived note public key, computed from masterPublicKey and random.
   */
  readonly notePublicKey: bigint

  /**
   * Create a new ShieldNoteERC20 for an ERC20 shield transaction.
   * @param masterPublicKey - The receiver's master public key
   * @param random - Random hex entropy for the note commitment
   * @param value - The token amount in base units to shield
   * @param tokenAddress - The ERC20 token contract address
   */
  constructor (masterPublicKey: bigint, random: string, value: bigint, tokenAddress: string) {
    this.masterPublicKey = masterPublicKey
    this.random = random
    this.value = value
    this.tokenAddress = tokenAddress
    this.notePublicKey = poseidon([masterPublicKey, ByteUtils.hexToBigInt(random)])
  }

  /**
   * Serialize shield request for contract submission.
   * PROPER RAILGUN IMPLEMENTATION - ShieldNote.serialize
   * @param shieldPrivateKey - The ephemeral private key used for encryption
   * @param receiverViewingPublicKey - The receiver's viewing public key for shared key derivation
   * @returns The serialized ShieldRequest containing preimage and ciphertext
   */
  async serialize (
    shieldPrivateKey: Uint8Array,
    receiverViewingPublicKey: Uint8Array
  ): Promise<ShieldRequest> {
    // Get shared key for encryption
    const sharedKey = await getSharedSymmetricKey(shieldPrivateKey, receiverViewingPublicKey)
    if (!sharedKey) {
      throw new Error('Failed to generate shared symmetric key')
    }

    // Encrypt the random value using AES-GCM
    const encryptedRandom = AES.encryptGCM([this.random], sharedKey)

    // Encrypt receiver public key using AES-CTR
    const encryptedReceiver = AES.encryptCTR(
      [ByteUtils.fastBytesToHex(receiverViewingPublicKey)],
      shieldPrivateKey
    )

    // Get shield key from shield private key
    const shieldKey = ByteUtils.fastBytesToHex(await getPublicViewingKey(shieldPrivateKey))

    // Create encrypted bundle:
    // [0] = iv + tag from GCM encryption (32 bytes total)
    // [1] = encrypted random data + receiver encryption iv (32 bytes)
    // [2] = encrypted receiver data (32 bytes)
    const encryptedBundle: [string, string, string] = [
      ByteUtils.hexlify(`${encryptedRandom.iv}${encryptedRandom.tag}`, true),
      ByteUtils.hexlify(
        ByteUtils.combine([
          ...encryptedRandom.data,
          ByteUtils.hexStringToBytes(encryptedReceiver.iv),
        ]),
        true
      ),
      ByteUtils.hexlify(ByteUtils.combine(encryptedReceiver.data), true),
    ]

    return {
      preimage: {
        npk: ByteUtils.nToHex(this.notePublicKey, ByteLength.UINT_256, true),
        token: {
          tokenType: 0, // ERC20
          tokenAddress: this.tokenAddress,
          tokenSubID: 0n,
        },
        value: this.value,
      },
      ciphertext: {
        encryptedBundle,
        shieldKey: ByteUtils.hexlify(shieldKey, true),
      },
    }
  }
}

/**
 * Production Shield Transaction Service
 *
 * Handles the creation and execution of shield transactions to convert
 * public tokens into private RAILGUN commitments using real RAILGUN contracts.
 */
export class ShieldTransactionService {
  /**
   * Singleton instance of the ShieldTransactionService.
   */
  private static instance: ShieldTransactionService

  /**
   * Private constructor to enforce singleton pattern.
   */
  private constructor () {}

  /**
   * Get the singleton ShieldTransactionService instance, creating it if necessary.
   * @returns The ShieldTransactionService singleton instance
   */
  static getInstance (): ShieldTransactionService {
    if (!this.instance) {
      this.instance = new ShieldTransactionService()
    }
    return this.instance
  }

  /**
   * Get the shield approval contract address for the network.
   * @param networkName - The target network name
   * @returns The RAILGUN smart wallet contract address for the network
   */
  getShieldApprovalContractAddress (networkName: NetworkName): string {
    const networkConfig = NETWORK_CONFIG[networkName]
    if (!networkConfig) {
      throw new Error(`Unsupported network: ${networkName}`)
    }
    return networkConfig.railgunContractAddress
  }

  /**
   * Check if token is approved for shielding.
   * @param tokenAddress - The ERC20 token contract address
   * @param walletAddress - The wallet's Ethereum address
   * @param networkName - The target network name
   * @param provider - The ethers provider for on-chain queries
   * @param amount - Optional minimum allowance amount to check against
   * @returns True if the token allowance is sufficient for shielding
   */
  async isTokenApprovedForShield (
    tokenAddress: string,
    walletAddress: string,
    networkName: NetworkName,
    provider: ethers.Provider,
    amount?: bigint
  ): Promise<boolean> {
    try {
      if (isNativeETH(tokenAddress)) {
        return true
      }

      const spenderAddress = this.getShieldApprovalContractAddress(networkName)
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider)
      const allowance = await tokenContract['allowance']!(walletAddress, spenderAddress)

      return amount ? allowance >= amount : allowance > 0n
    } catch (error) {
      console.error('Error checking token approval:', error)
      return false
    }
  }

  /**
   * Create token approval transaction for shield operations.
   * @param tokenAddress - The ERC20 token contract address to approve
   * @param amount - The approval amount in base units as a string
   * @param walletAddress - The wallet's Ethereum address
   * @param networkName - The target network name
   * @param provider - The ethers provider for on-chain queries
   * @returns A populated contract transaction for the ERC20 approval
   */
  async createTokenApprovalTransaction (
    tokenAddress: string,
    amount: string,
    walletAddress: string,
    networkName: NetworkName,
    provider: ethers.Provider
  ): Promise<ethers.ContractTransaction> {
    if (isNativeETH(tokenAddress)) {
      throw new Error('Native ETH does not require approval transaction')
    }

    const networkConfig = NETWORK_CONFIG[networkName]
    if (!networkConfig) {
      throw new Error(`Unsupported network: ${networkName}`)
    }

    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider)
    const balance = await tokenContract['balanceOf']!(walletAddress)
    const amountBigInt = BigInt(amount)

    if (balance < amountBigInt) {
      throw new Error(
        `Insufficient token balance for approval. Required: ${ethers.formatUnits(amountBigInt, 18)}, Available: ${ethers.formatUnits(balance, 18)}`
      )
    }

    const transaction = await tokenContract['approve']!.populateTransaction(
      networkConfig.railgunContractAddress,
      amountBigInt
    )

    const gasEstimate = await provider.estimateGas({
      ...transaction,
      from: walletAddress,
    })
    transaction.gasLimit = gasEstimate

    try {
      const feeData = await provider.getFeeData()
      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        transaction.maxFeePerGas = feeData.maxFeePerGas
        transaction.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas
        transaction.type = 2
      } else if (feeData.gasPrice) {
        transaction.gasPrice = feeData.gasPrice
        transaction.type = 0
      }
    } catch (gasError) {
      dwarn('Failed to get fee data, using default gas pricing:', gasError)
      transaction.gasPrice = ethers.parseUnits('20', 'gwei')
      transaction.type = 0
    }

    dlog('Simulating token approval transaction...')
    const simulationResult = await this.simulateTransaction(transaction, walletAddress, provider)
    if (!simulationResult.success) {
      throw new Error(`Approval simulation failed: ${simulationResult.error}`)
    }
    dlog('Approval transaction simulation successful')

    return transaction
  }

  /**
   * Estimate gas for shield transaction using proper RAILGUN contracts.
   * @param params - The shield transaction parameters including token and amount
   * @param wallet - The RAILGUN wallet performing the shield
   * @param networkName - The target network name
   * @param provider - The ethers provider for on-chain queries
   * @returns A gas estimate with limit, price, and total cost
   */
  async estimateShieldGas (
    params: ShieldTransactionParams,
    wallet: RailgunWallet,
    networkName: NetworkName,
    provider: ethers.Provider
  ): Promise<GasEstimate> {
    const networkConfig = NETWORK_CONFIG[networkName]
    if (!networkConfig) {
      throw new Error(`Unsupported network: ${networkName}`)
    }

    const walletAddress = wallet.ethereumAddress
    if (!walletAddress) {
      throw new Error('No Ethereum address available for approval operations')
    }

    const amount = BigInt(params.amount)
    const isApproved = await this.isTokenApprovedForShield(
      params.tokenAddress,
      walletAddress,
      networkName,
      provider,
      amount
    )

    // If not approved and it's an ERC-20, return approval gas estimate
    if (!isApproved && !isNativeETH(params.tokenAddress)) {
      const approvalTx = await this.createTokenApprovalTransaction(
        params.tokenAddress,
        params.amount,
        walletAddress,
        networkName,
        provider
      )

      const gasLimit = await provider.estimateGas({
        ...approvalTx,
        from: walletAddress,
      })

      return buildGasEstimate(provider, gasLimit)
    }

    // Shield gas estimation with conservative estimates
    dlog('Using conservative gas estimation for shield transaction')

    // RAILGUN shield transactions typically use 800k-1.2M gas
    const baseGasLimit = isNativeETH(params.tokenAddress)
      ? 1_400_000n // Slightly more for ETH shields (RelayAdapt wrap + shield)
      : 1_200_000n

    // Add 20% buffer for safety
    const bufferedGasLimit = (baseGasLimit * 120n) / 100n

    return buildGasEstimate(provider, bufferedGasLimit)
  }

  /**
   * Execute shield transaction by creating, signing, and submitting it on-chain.
   * @param params - The shield transaction parameters including token and amount
   * @param wallet - The RAILGUN wallet performing the shield
   * @param networkName - The target network name
   * @param provider - The ethers provider for on-chain interaction
   * @param onProgress - Optional callback for reporting transaction progress
   * @returns An object containing the confirmed transaction hash
   */
  async executeShieldTransaction (
    params: ShieldTransactionParams,
    wallet: RailgunWallet,
    networkName: NetworkName,
    provider: ethers.Provider,
    onProgress?: (status: string) => void
  ): Promise<{ txHash: string }> {
    onProgress?.('Creating shield transaction...')

    const { transaction } = await this.createShieldTransaction(
      params,
      wallet,
      networkName,
      provider
    )

    onProgress?.('Signing transaction...')

    if (!wallet.mnemonic) {
      throw new Error('Cannot sign transaction without mnemonic')
    }
    const signer = ethers.Wallet.fromPhrase(wallet.mnemonic).connect(provider)

    onProgress?.('Submitting to network...')

    const txResponse = await signer.sendTransaction(transaction)
    onProgress?.('Submitted. Waiting for confirmation...')

    const receipt = await txResponse.wait(1)
    if (receipt?.status !== 1) {
      const sim = await this.simulateTransaction(transaction, wallet.ethereumAddress!, provider)
      onProgress?.('Transaction failed')
      throw new Error(sim.error || 'On-chain transaction reverted')
    }

    onProgress?.('Transaction confirmed')

    return { txHash: txResponse.hash }
  }

  /**
   * Check if token can be shielded by querying RAILGUN contract's tokenBlocklist.
   * @param tokenAddress - The token contract address to check
   * @param networkName - The target network name
   * @param provider - Optional ethers provider for on-chain blocklist query
   * @returns True if the token is not blocklisted and can be shielded
   */
  async canShieldToken (
    tokenAddress: string,
    networkName: NetworkName,
    provider?: ethers.Provider
  ): Promise<boolean> {
    try {
      const networkConfig = NETWORK_CONFIG[networkName]
      if (!networkConfig) {
        return false
      }

      if (isNativeETH(tokenAddress)) {
        return true
      }

      if (provider) {
        const railgunContract = new ethers.Contract(
          networkConfig.railgunContractAddress,
          RAILGUN_SHIELD_ABI,
          provider
        )

        if (!railgunContract['tokenBlocklist']) {
          return true
        }
        const isBlocked: boolean = await railgunContract['tokenBlocklist']!(tokenAddress)
        return !isBlocked
      }

      return true
    } catch (error) {
      console.error('Error checking if token can be shielded:', error)
      return false
    }
  }

  /**
   * Simulate transaction execution to check for potential failures.
   * Uses provider.call() to detect reverts, then estimateGas for gas usage.
   * @param transaction - The contract transaction to simulate
   * @param fromAddress - The sender's Ethereum address
   * @param provider - The ethers provider for simulation
   * @returns An object indicating success/failure, optional error message, and gas used
   */
  private async simulateTransaction (
    transaction: ethers.ContractTransaction,
    fromAddress: string,
    provider: ethers.Provider
  ): Promise<{ success: boolean; error?: string; gasUsed?: bigint }> {
    try {
      dlog('Simulating contract execution...')

      // Check if the contract exists
      const contractCode = await provider.getCode(transaction.to!)
      if (contractCode === '0x') {
        return {
          success: false,
          error:
            'Contract does not exist at the specified address. Please check the network configuration.',
        }
      }

      // Use provider.call() to detect contract reverts
      try {
        await provider.call({
          to: transaction.to,
          data: transaction.data,
          value: transaction.value || 0,
          from: fromAddress,
          gasLimit: (transaction as any).gasLimit,
        })
      } catch (callError: unknown) {
        console.error('Contract call would revert:', callError)
        const decoded = this.decodeRelayAdaptRevert(callError)
        return {
          success: false,
          error: decoded ?? (callError instanceof Error ? callError.message : 'Contract execution would revert'),
        }
      }

      // Only if the contract call succeeds, estimate gas
      const gasUsed = await provider.estimateGas({
        ...transaction,
        from: fromAddress,
      })

      dlog('Simulation successful')

      return { success: true, gasUsed }
    } catch (error: unknown) {
      console.error('Transaction simulation failed:', error)

      const errMsg = error instanceof Error ? error.message : ''
      let errorMessage = 'Transaction would fail'
      if (errMsg) {
        if (errMsg.includes('insufficient funds')) {
          errorMessage = 'Insufficient funds to execute transaction'
        } else if (errMsg.includes('allowance')) {
          errorMessage = 'Token allowance insufficient'
        } else if (errMsg.includes('balance')) {
          errorMessage = 'Token balance insufficient'
        } else if (errMsg.includes('revert')) {
          errorMessage = 'Transaction would revert - check token approval and balance'
        } else {
          errorMessage = errMsg
        }
      }

      return { success: false, error: errorMessage }
    }
  }

  /**
   * Decode RelayAdapt CallFailed custom error and inner revert reason, if present.
   * @param err - The error object from a failed RelayAdapt call
   * @returns A human-readable error message, or undefined if not decodable
   */
  private decodeRelayAdaptRevert (err: unknown): string | undefined {
    try {
      const data: string | undefined =
        (err as any)?.data ||
        (err as any)?.error?.data ||
        (err as any)?.info?.error?.data ||
        (err as any)?.revert?.data
      if (!data || typeof data !== 'string' || !data.startsWith('0x')) return undefined

      // Manual decode for CallFailed selector 0x5c0dee5d
      if (data.toLowerCase().startsWith('0x5c0dee5d')) {
        try {
          const abiCoder = ethers.AbiCoder.defaultAbiCoder()
          const decoded = abiCoder.decode(
            ['uint256', 'bytes'],
            '0x' + data.slice(10)
          ) as unknown as [bigint, string]
          const innerMsg =
            this.decodeRevertString(decoded[1]) ?? this.decodeRawRevertData(decoded[1])
          return `RelayAdapt multicall failed at call index ${decoded[0]}: ${innerMsg}`
        } catch {}
      }

      const iface = new ethers.Interface(RELAY_ADAPT_ABI as any)
      try {
        const parsed = iface.parseError(data)
        if (parsed?.name === 'CallFailed') {
          const inner: string = parsed.args[1]
          const innerMsg = this.decodeRevertString(inner) ?? this.decodeRawRevertData(inner)
          return `RelayAdapt multicall failed at call index ${Number(parsed.args[0])}: ${innerMsg}`
        }
      } catch {
        const generic = this.decodeRevertString(data)
        if (generic) return generic
      }

      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * Decode a standard Solidity Error(string) revert reason from ABI-encoded data.
   * @param revertData - The hex-encoded revert data starting with the Error(string) selector
   * @returns The decoded revert reason string, or undefined if not decodable
   */
  private decodeRevertString (revertData: string): string | undefined {
    try {
      const lower = revertData.toLowerCase()
      // Standard Error(string) selector 0x08c379a0
      if (lower.startsWith('0x08c379a0') && lower.length >= 10) {
        const abiCoder = ethers.AbiCoder.defaultAbiCoder()
        const reason = abiCoder.decode(['string'], `0x${lower.slice(10)}`)[0] as string
        return reason
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * Format raw revert data as a hex string for display when no standard decoding is possible.
   * @param revertData - The hex-encoded revert data
   * @returns A hex-prefixed string of the raw revert data, or a message if empty
   */
  private decodeRawRevertData (revertData: string): string {
    const hex = `0x${revertData.replace(/^0x/i, '')}`
    if (hex === '0x') return 'No revert data (likely out of gas)'
    return hex
  }

  /**
   * Create shield transaction with proper RAILGUN shield requests.
   * @param params - The shield transaction parameters including token and amount
   * @param wallet - The RAILGUN wallet performing the shield
   * @param networkName - The target network name
   * @param provider - The ethers provider for on-chain interaction
   * @returns The shield transaction result with populated transaction, gas estimate, and shield private key
   */
  private async createShieldTransaction (
    params: ShieldTransactionParams,
    wallet: RailgunWallet,
    networkName: NetworkName,
    provider: ethers.Provider
  ): Promise<ShieldTransactionResult> {
    const networkConfig = NETWORK_CONFIG[networkName]
    if (!networkConfig) {
      throw new Error(`Unsupported network: ${networkName}`)
    }

    const walletAddress = wallet.ethereumAddress
    if (!walletAddress) {
      throw new Error('No Ethereum address available for approval check')
    }

    const amount = BigInt(params.amount)

    if (isNativeETH(params.tokenAddress)) {
      dlog('Using RelayAdapt for ETH shielding (automatic ETH-to-WETH conversion)')

      const wethAddress = await this.getWETHAddressFromRelayAdapt(networkName, provider)

      const ethBalance = await provider.getBalance(walletAddress)
      if (ethBalance < amount) {
        throw new Error(
          `Insufficient ETH balance. Required: ${ethers.formatEther(amount)}, Available: ${ethers.formatEther(ethBalance)}`
        )
      }

      return this.createRelayAdaptShieldTransaction(
        { ...params, tokenAddress: wethAddress },
        wallet,
        networkName,
        provider,
        amount
      )
    }

    // Regular ERC-20 token shielding
    dlog('Using standard RAILGUN shield for ERC-20 token')

    const isApproved = await this.isTokenApprovedForShield(
      params.tokenAddress,
      walletAddress,
      networkName,
      provider,
      amount
    )
    if (!isApproved) {
      throw new Error('Token not approved for shielding. Please approve token first.')
    }

    const tokenContract = new ethers.Contract(params.tokenAddress, ERC20_ABI, provider)
    const balance = await tokenContract['balanceOf']!(walletAddress)
    if (balance < amount) {
      throw new Error(
        `Insufficient token balance. Required: ${ethers.formatUnits(amount, 18)}, Available: ${ethers.formatUnits(balance, 18)}`
      )
    }

    return this.createStandardShieldTransaction(params, wallet, networkName, provider)
  }

  /**
   * Get the RelayAdapt contract address for the specified network.
   * @param networkName - The target network name
   * @returns The RelayAdapt contract address
   */
  private getRelayAdaptContractAddress (networkName: NetworkName): string {
    const relayAdaptAddress = NETWORK_CONFIG[networkName]?.relayAdaptContract
    if (!relayAdaptAddress) {
      throw new Error(`RelayAdapt contract not available on network: ${networkName}`)
    }
    return relayAdaptAddress
  }

  /**
   * Query the RelayAdapt contract to get the wrapped base token (WETH) address.
   * @param networkName - The target network name
   * @param provider - The ethers provider for on-chain query
   * @returns The WETH contract address for the network
   */
  private async getWETHAddressFromRelayAdapt (
    networkName: NetworkName,
    provider: ethers.Provider
  ): Promise<string> {
    const relayAdaptAddress = this.getRelayAdaptContractAddress(networkName)
    const relayAdaptContract = new ethers.Contract(relayAdaptAddress, RELAY_ADAPT_ABI, provider)
    const wethAddress = await relayAdaptContract['wBase']!()
    dlog(`WETH address from RelayAdapt on ${networkName}: ${wethAddress}`)
    return wethAddress
  }

  /**
   * Check token blocklist on Railgun contract and throw if the token is blocked.
   * @param tokenAddress - The token contract address to check
   * @param networkName - The target network name
   * @param provider - The ethers provider for on-chain query
   */
  private async checkTokenBlocklist (
    tokenAddress: string,
    networkName: NetworkName,
    provider: ethers.Provider
  ): Promise<void> {
    const railgunAddress = NETWORK_CONFIG[networkName].railgunContractAddress
    const railgunContract = new ethers.Contract(railgunAddress, RAILGUN_SHIELD_ABI, provider)
    const isBlocked: boolean = await railgunContract['tokenBlocklist']!(tokenAddress)
    if (isBlocked) {
      throw new Error('RailgunSmartWallet: Unsupported Token')
    }
  }

  /**
   * Generate shield note and serialize it for a shield request.
   * @param params - The shield transaction parameters including recipient address and token
   * @param amount - The token amount in base units to shield
   * @returns The serialized shield request and the ephemeral shield private key
   */
  private async buildShieldRequest (
    params: ShieldTransactionParams,
    amount: bigint
  ): Promise<{ shieldRequest: ShieldRequest; shieldPrivateKey: string }> {
    const shieldPrivateKey = ByteUtils.randomHex(32)
    const { masterPublicKey, viewingPublicKey } = decodeRailgunAddress(
      params.recipientRailgunAddress
    )
    const random = ByteUtils.randomHex(16)

    const shieldNote = new ShieldNoteERC20(masterPublicKey, random, amount, params.tokenAddress)
    const shieldPrivateKeyBytes = ByteUtils.hexToBytes(shieldPrivateKey)
    const shieldRequest = await shieldNote.serialize(shieldPrivateKeyBytes, viewingPublicKey)

    return { shieldRequest, shieldPrivateKey }
  }

  /**
   * Create RelayAdapt shield transaction for ETH (wraps to WETH and shields).
   * @param params - The shield transaction parameters with WETH token address
   * @param wallet - The RAILGUN wallet performing the shield
   * @param networkName - The target network name
   * @param provider - The ethers provider for on-chain interaction
   * @param ethAmount - The ETH amount in wei to wrap and shield
   * @returns The shield transaction result with populated multicall transaction, gas estimate, and shield private key
   */
  private async createRelayAdaptShieldTransaction (
    params: ShieldTransactionParams,
    wallet: RailgunWallet,
    networkName: NetworkName,
    provider: ethers.Provider,
    ethAmount: bigint
  ): Promise<ShieldTransactionResult> {
    dlog('Creating RelayAdapt shield transaction for ETH->WETH shielding')

    const { shieldRequest, shieldPrivateKey } = await this.buildShieldRequest(params, ethAmount)

    await this.checkTokenBlocklist(params.tokenAddress, networkName, provider)

    const relayAdaptAddress = this.getRelayAdaptContractAddress(networkName)
    const relayAdaptContract = new ethers.Contract(relayAdaptAddress, RELAY_ADAPT_ABI, provider)

    const wrapCall = await relayAdaptContract['wrapBase']!.populateTransaction(ethAmount)
    const shieldCall = await relayAdaptContract['shield']!.populateTransaction([shieldRequest])

    const multicallCalls = [
      { to: relayAdaptAddress, data: wrapCall.data as string, value: 0n },
      { to: relayAdaptAddress, data: shieldCall.data as string, value: 0n },
    ]

    const multicallTx = await relayAdaptContract['multicall']!.populateTransaction(
      true,
      multicallCalls
    )
    multicallTx.value = ethAmount
    multicallTx.to = relayAdaptAddress

    dlog('RelayAdapt multicall: wrapBase -> shield, ETH Value:', ethers.formatEther(ethAmount))

    // Estimate gas via requireSuccess=false probe, fallback to conservative estimate
    let gasEstimate: GasEstimate
    try {
      const probeCall = await relayAdaptContract['multicall']!.populateTransaction(
        false,
        multicallCalls
      )
      probeCall.to = relayAdaptAddress
      probeCall.value = ethAmount
      const estGas = await provider.estimateGas({
        ...probeCall,
        from: wallet.ethereumAddress!,
      })
      gasEstimate = await buildGasEstimate(provider, (estGas * 12n) / 10n) // +20% buffer
    } catch {
      // Fallback: conservative estimate for RelayAdapt (wrap + shield)
      gasEstimate = await buildGasEstimate(provider, 840_000n)
    }

    applyGasToTransaction(multicallTx, gasEstimate)

    const simulationResult = await this.simulateTransaction(
      multicallTx,
      wallet.ethereumAddress!,
      provider
    )
    if (!simulationResult.success) {
      throw new Error(`RelayAdapt shield simulation failed: ${simulationResult.error}`)
    }

    dlog('RelayAdapt shield simulation successful')

    return {
      transaction: multicallTx,
      gasEstimate: gasEstimate.totalCost,
      shieldPrivateKey,
    }
  }

  /**
   * Create standard RAILGUN shield transaction for ERC-20 tokens.
   * @param params - The shield transaction parameters including token and amount
   * @param wallet - The RAILGUN wallet performing the shield
   * @param networkName - The target network name
   * @param provider - The ethers provider for on-chain interaction
   * @returns The shield transaction result with populated transaction, gas estimate, and shield private key
   */
  private async createStandardShieldTransaction (
    params: ShieldTransactionParams,
    wallet: RailgunWallet,
    networkName: NetworkName,
    provider: ethers.Provider
  ): Promise<ShieldTransactionResult> {
    const networkConfig = NETWORK_CONFIG[networkName]
    const amount = BigInt(params.amount)

    const { shieldRequest, shieldPrivateKey } = await this.buildShieldRequest(params, amount)

    await this.checkTokenBlocklist(params.tokenAddress, networkName, provider)

    const railgunContract = new ethers.Contract(
      networkConfig.railgunContractAddress,
      RAILGUN_SHIELD_ABI,
      provider
    )

    const transaction = await railgunContract['shield']!.populateTransaction([shieldRequest])

    const simulationResult = await this.simulateTransaction(
      transaction,
      wallet.ethereumAddress!,
      provider
    )
    if (!simulationResult.success) {
      throw new Error(`Shield simulation failed: ${simulationResult.error}`)
    }

    dlog('Standard shield simulation successful')

    const gasEstimate = await this.estimateShieldGas(params, wallet, networkName, provider)
    applyGasToTransaction(transaction, gasEstimate)

    return {
      transaction,
      gasEstimate: gasEstimate.totalCost,
      shieldPrivateKey,
    }
  }
}
