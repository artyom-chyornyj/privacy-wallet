import { ethers } from 'ethers'

import type { NetworkName } from '@/types/network'
import { NETWORK_CONFIG, getEffectiveRpcUrl } from '@/types/network'

/**
 * Create a JsonRpcProvider with explicit network config to avoid
 * auto-detection RPC calls (eth_chainId).
 * @param networkName - The network to create a provider for
 * @returns A JsonRpcProvider configured with the network's chain ID and RPC URL
 */
export function createProvider (networkName: NetworkName): ethers.JsonRpcProvider {
  const config = NETWORK_CONFIG[networkName]
  if (!config) {
    throw new Error(`No network config for: ${networkName}`)
  }
  const rpcUrl = getEffectiveRpcUrl(networkName)
  return new ethers.JsonRpcProvider(rpcUrl, {
    name: networkName.toLowerCase(),
    chainId: config.chainId,
  })
}
