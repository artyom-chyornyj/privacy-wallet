// Network configuration
enum NetworkName {
  EthereumSepolia = 'EthereumSepolia',
  Hardhat = 'Hardhat',
}

interface NetworkConfig {
  chainId: number
  name: NetworkName
  publicName: string
  rpcUrls: string[]
  rpcUrl: string // Primary RPC URL
  subsquidUrl?: string
  railgunContractAddress: string
  railgunProxyContract: string // Proxy contract address
  railgunV2Contract: string // V2 contract address (same as proxy)
  relayAdaptContract?: string // RelayAdapt contract address for atomic shield/unshield
  deploymentBlock: number
  blockExplorerUrl?: string // Block explorer base URL
  poi?: {
    // Block number when PPOI was launched on this network.
    // Transactions before this block use legacy PPOI proofs.
    // If not set, defaults to 0 (all transactions require PPOI).
    launchBlock: number
  }
}

const NETWORK_CONFIG: Record<NetworkName, NetworkConfig> = {
  [NetworkName.EthereumSepolia]: {
    chainId: 11155111,
    name: NetworkName.EthereumSepolia,
    publicName: 'Ethereum Sepolia',
    rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    subsquidUrl: 'https://rail-squid.squids.live/squid-railgun-eth-sepolia-v2/graphql',
    railgunContractAddress: '0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea',
    railgunProxyContract: '0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea',
    railgunV2Contract: '0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea',
    relayAdaptContract: '0x7e3d929EbD5bDC84d02Bd3205c777578f33A214D',
    deploymentBlock: 2842100,
    blockExplorerUrl: 'https://sepolia.etherscan.io',
    poi: {
      // PPOI was always required on Sepolia testnet from deployment
      launchBlock: 0,
    },
  },
  [NetworkName.Hardhat]: {
    chainId: 31337,
    name: NetworkName.Hardhat,
    publicName: 'Hardhat Local',
    rpcUrls: ['http://127.0.0.1:8545'],
    rpcUrl: 'http://127.0.0.1:8545',
    // These addresses match the hardhat deploy:test output - proxy is the main contract
    railgunContractAddress: '0x610178dA211FEF7D417bC0e6FeD39F05609AD788', // Proxy
    railgunProxyContract: '0x610178dA211FEF7D417bC0e6FeD39F05609AD788', // Proxy
    railgunV2Contract: '0x610178dA211FEF7D417bC0e6FeD39F05609AD788', // Proxy
    deploymentBlock: 0,
    // No block explorer for hardhat local network
    // PPOI is not possible using hardhat without further indexing, like Subsquid, for railgunTxid merkletree formation
  },
}

// PPOI Configuration
const POI_REQUIRED_NODE_URLS = ['https://ppoi.fdi.network']

const POI_REQUIRED_LIST_KEYS = {
  CHAINALYSIS_OFAC: 'efc6ddb59c098a13fb2b618fdae94c1c3a807abc8fb1837c93620c9143ee9e88',
}

/**
 * Get the block explorer URL for a transaction hash
 * @param network - The network to look up the explorer for
 * @param txHash - The transaction hash to build the URL for
 * @returns The full block explorer URL for the transaction, or null if no explorer is configured
 */
function getBlockExplorerUrl (network: NetworkName, txHash: string): string | null {
  const config = NETWORK_CONFIG[network]
  if (!config.blockExplorerUrl) {
    return null
  }
  return `${config.blockExplorerUrl}/tx/${txHash}`
}

/**
 * Get the effective RPC URL for a network, checking for user-configured custom URLs first.
 * Reads directly from localStorage to avoid circular imports with Zustand stores.
 * @param network - The network to get the RPC URL for
 * @returns The custom RPC URL if configured, otherwise the default RPC URL
 */
function getEffectiveRpcUrl (network: NetworkName): string {
  try {
    if (typeof window !== 'undefined') {
      const settingsRaw = window.localStorage?.getItem('privacy-wallet-settings')
      if (settingsRaw) {
        const settings = JSON.parse(settingsRaw)
        const customUrl = settings?.state?.customRpcUrls?.[network]
        if (customUrl && typeof customUrl === 'string' && customUrl.length > 0) {
          return customUrl
        }
      }
    }
  } catch {}

  return NETWORK_CONFIG[network].rpcUrl
}

// Wrapped base token (WETH) addresses per network
const WRAPPED_BASE_TOKEN: Record<NetworkName, string> = {
  [NetworkName.EthereumSepolia]: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  [NetworkName.Hardhat]: '0x0000000000000000000000000000000000000000', // No WETH on hardhat by default
}

/**
 * Check if a token address is the wrapped base token (WETH) for the given network
 * @param tokenAddress - The token contract address to check
 * @param network - The network to check the WETH address for
 * @returns True if the token address matches the wrapped base token for the network
 */
function isWrappedBaseToken (tokenAddress: string, network: NetworkName): boolean {
  const wethAddress = WRAPPED_BASE_TOKEN[network]
  if (!wethAddress || wethAddress === '0x0000000000000000000000000000000000000000') return false
  return tokenAddress.toLowerCase() === wethAddress.toLowerCase()
}

// Balance buckets for PPOI status
enum BalanceBucket {
  Spendable = 'Spendable',
  ShieldPending = 'ShieldPending',
  ShieldBlocked = 'ShieldBlocked',
  ProofSubmitted = 'ProofSubmitted',
  MissingInternalPOI = 'MissingInternalPOI',
  MissingExternalPOI = 'MissingExternalPOI',
  /** Status has not been checked yet — user must check before submitting. */
  Unknown = 'Unknown',
  Spent = 'Spent',
}

export type { NetworkConfig }
export {
  NetworkName,
  NETWORK_CONFIG,
  POI_REQUIRED_NODE_URLS,
  POI_REQUIRED_LIST_KEYS,
  getBlockExplorerUrl,
  getEffectiveRpcUrl,
  WRAPPED_BASE_TOKEN,
  isWrappedBaseToken,
  BalanceBucket,
}
