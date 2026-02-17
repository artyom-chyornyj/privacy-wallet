import { ethers } from 'ethers'

import type { NetworkName } from '@/types/network'
import type { TokenInfo } from '@/types/wallet'
import { dlog } from '@/utils/debug'
import { createProvider } from '@/utils/rpc'

/**
 * Service for fetching public (on-chain) balances for Ethereum addresses
 * This handles standard ETH and ERC20 token balance queries
 */
export class PublicBalanceService {
  /**
   * Singleton instance of the service.
   */
  private static instance: PublicBalanceService

  /**
   * Private constructor to enforce singleton pattern.
   */
  private constructor () {}

  /**
   * Get the singleton instance of PublicBalanceService.
   * @returns The shared PublicBalanceService instance
   */
  static getInstance (): PublicBalanceService {
    if (!this.instance) {
      this.instance = new PublicBalanceService()
    }
    return this.instance
  }

  /**
   * Get ETH balance for an address.
   * @param address - The Ethereum address to query
   * @param networkName - The network to query the balance on
   * @returns The ETH balance in wei
   */
  async getETHBalance (address: string, networkName: NetworkName): Promise<bigint> {
    try {
      dlog(`[RPC] Creating provider for ${networkName}`)
      const provider = this.getProvider(networkName)
      dlog(`[RPC] getBalance(${address})`)
      const balance = await provider.getBalance(address)
      dlog(`[RPC] Balance result: ${balance.toString()}`)
      return BigInt(balance.toString())
    } catch (error) {
      console.error('Error fetching ETH balance:', error)
      return BigInt(0)
    }
  }

  /**
   * Get ERC20 token balance for an address.
   * @param tokenAddress - The ERC20 token contract address
   * @param walletAddress - The wallet address to query the balance for
   * @param networkName - The network to query the balance on
   * @returns The token balance in smallest units
   */
  async getERC20Balance (
    tokenAddress: string,
    walletAddress: string,
    networkName: NetworkName
  ): Promise<bigint> {
    try {
      const provider = this.getProvider(networkName)

      // ERC20 balanceOf ABI
      const erc20ABI = ['function balanceOf(address owner) view returns (uint256)']

      const contract = new ethers.Contract(tokenAddress, erc20ABI, provider)
      const balanceOfFn = contract['balanceOf'] as (addr: string) => Promise<bigint>
      const balance = await balanceOfFn(walletAddress)
      return BigInt(balance.toString())
    } catch (error) {
      console.error('Error fetching ERC20 balance:', error)
      return BigInt(0)
    }
  }

  /**
   * Get token metadata (symbol, decimals, name).
   * @param tokenAddress - The ERC20 token contract address
   * @param networkName - The network the token is deployed on
   * @returns The token symbol, decimals, and name
   */
  async getTokenMetadata (
    tokenAddress: string,
    networkName: NetworkName
  ): Promise<{ symbol: string; decimals: number; name: string }> {
    try {
      const provider = this.getProvider(networkName)

      // Handle ETH (native token)
      if (tokenAddress === '0x0000000000000000000000000000000000000000') {
        return {
          symbol: 'ETH',
          decimals: 18,
          name: 'Ethereum',
        }
      }

      const erc20ABI = [
        'function decimals() view returns (uint8)',
        'function symbol() view returns (string)',
        'function name() view returns (string)',
      ]

      const contract = new ethers.Contract(tokenAddress, erc20ABI, provider)

      const symbolFn = contract['symbol'] as () => Promise<string>
      const decimalsFn = contract['decimals'] as () => Promise<number>
      const nameFn = contract['name'] as () => Promise<string>

      const [symbol, decimals, name] = await Promise.all([symbolFn(), decimalsFn(), nameFn()])

      return {
        symbol,
        decimals: Number(decimals),
        name,
      }
    } catch (error) {
      console.error('Error fetching token metadata:', error)
      return {
        symbol: 'UNKNOWN',
        decimals: 18,
        name: 'Unknown Token',
      }
    }
  }

  /**
   * Get token balances for an address - checks ETH plus any user-added custom tokens.
   * @param address - The Ethereum address to check balances for
   * @param networkName - The network to query balances on
   * @param customTokens - Optional array of user-added custom tokens to check
   * @returns An array of token balance entries with metadata
   */
  async getCommonTokenBalances (
    address: string,
    networkName: NetworkName,
    customTokens?: TokenInfo[]
  ): Promise<
    Array<{
      tokenAddress: string
      symbol: string
      decimals: number
      balance: bigint
      balanceBucket: string
    }>
  > {
    const balances = []

    try {
      dlog(`Checking ETH balance for: ${address}`)

      const ethBalance = await this.getETHBalance(address, networkName)
      if (ethBalance > 0n) {
        balances.push({
          tokenAddress: '0x0000000000000000000000000000000000000000',
          symbol: 'ETH',
          decimals: 18,
          balance: ethBalance,
          balanceBucket: 'Public',
        })
      }

      // Check balances for user-added custom tokens
      if (customTokens && customTokens.length > 0) {
        dlog(`Checking ${customTokens.length} custom token balances`)
        for (const token of customTokens) {
          try {
            const tokenBalance = await this.getERC20Balance(token.address, address, networkName)
            balances.push({
              tokenAddress: token.address.toLowerCase(),
              symbol: token.symbol,
              decimals: token.decimals,
              balance: tokenBalance,
              balanceBucket: 'Public',
            })
          } catch (error) {
            console.error(`Error fetching balance for ${token.symbol} (${token.address}):`, error)
          }
        }
      }
    } catch (error) {
      console.error('Error fetching public balances:', error)
    }

    dlog(`Public balance check complete: found ${balances.length} balances`)
    return balances
  }

  /**
   * Create a JSON-RPC provider for the specified network.
   * @param networkName - The network to create a provider for
   * @returns A configured ethers JsonRpcProvider instance
   */
  private getProvider (networkName: NetworkName): ethers.JsonRpcProvider {
    return createProvider(networkName)
  }
}
