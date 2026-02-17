import { ethers } from 'ethers'

import type { NetworkName } from '@/types/network'
import type { RailgunWallet } from '@/types/wallet'
import { createProvider } from '@/utils/rpc'

const ERC20_TRANSFER_ABI = ['function transfer(address to, uint256 amount) returns (bool)']

interface PublicTransferParams {
  tokenAddress: string
  amount: string // Amount in token's smallest unit (wei for ETH)
  recipientAddress: string // 0x address
}

interface PublicTransferResult {
  txHash: string
}

/**
 * Service for basic 0x -> 0x public transfers.
 * Handles native ETH and ERC-20 token transfers.
 */
class PublicTransferService {
  /** Singleton instance of the public transfer service. */
  private static instance: PublicTransferService

  /** Private constructor to enforce singleton pattern. */
  private constructor () {}

  /**
   * Returns the singleton instance of PublicTransferService.
   * @returns The shared PublicTransferService instance
   */
  static getInstance (): PublicTransferService {
    if (!this.instance) {
      this.instance = new PublicTransferService()
    }
    return this.instance
  }

  /**
   * Executes a public 0x-to-0x transfer of native ETH or an ERC-20 token.
   * @param wallet - The wallet containing the mnemonic for signing
   * @param network - The network to execute the transfer on
   * @param params - Transfer parameters including token address, amount, and recipient
   * @returns The transaction hash of the submitted transfer
   */
  async executeTransfer (
    wallet: RailgunWallet,
    network: NetworkName,
    params: PublicTransferParams
  ): Promise<PublicTransferResult> {
    if (!wallet.mnemonic) {
      throw new Error('Wallet mnemonic not available')
    }

    const provider = createProvider(network)
    const signer = ethers.Wallet.fromPhrase(wallet.mnemonic).connect(provider)

    const isNativeETH =
      !params.tokenAddress || params.tokenAddress === '0x0000000000000000000000000000000000000000'

    let txResponse: ethers.TransactionResponse

    if (isNativeETH) {
      txResponse = await signer.sendTransaction({
        to: params.recipientAddress,
        value: BigInt(params.amount),
      })
    } else {
      const contract = new ethers.Contract(params.tokenAddress, ERC20_TRANSFER_ABI, signer)
      const transferFn = contract['transfer'] as (
        to: string,
        amount: bigint,
      ) => Promise<ethers.TransactionResponse>
      txResponse = await transferFn(params.recipientAddress, BigInt(params.amount))
    }

    await txResponse.wait()

    return { txHash: txResponse.hash }
  }
}

export type { PublicTransferParams, PublicTransferResult }
export { PublicTransferService }
