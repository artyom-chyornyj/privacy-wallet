import { NetworkName } from '@/types/network'
import type { TokenInfo } from '@/types/wallet'
import { decryptWithPassword, encryptWithPassword } from '@/utils/passwordEncryption'

const CUSTOM_TOKENS_STORAGE_KEY = 'railgun-custom-tokens'
const HIDDEN_TOKENS_STORAGE_PREFIX = 'railgun-hidden-tokens'

/**
 * Token metadata service for resolving token symbols, names, and decimals
 */
class TokenService {
  /** Singleton instance of TokenService. */
  private static instance: TokenService
  /** In-memory cache of resolved token info keyed by "network:address". */
  private tokenCache: Map<string, TokenInfo> = new Map()
  /** User-added custom tokens keyed by "network:address". */
  private customTokens: Map<string, TokenInfo> = new Map()
  // Hidden tokens per wallet+network, keyed by "walletId:networkName"
  /** Set of hidden token addresses per wallet and network, keyed by "walletId:networkName". */
  private hiddenTokens: Map<string, Set<string>> = new Map()

  /**
   * Initializes the service and loads custom tokens from localStorage.
   */
  private constructor () {
    this.loadCustomTokens()
  }

  /**
   * Returns the singleton instance, creating it if necessary.
   * @returns The TokenService singleton
   */
  static getInstance (): TokenService {
    if (!this.instance) {
      this.instance = new TokenService()
    }
    return this.instance
  }

  /**
   * Get token information (symbol, name, decimals) for a given token address and network
   * @param tokenAddress - The ERC-20 token contract address
   * @param networkName - The network the token is on
   * @returns The resolved token metadata
   */
  async getTokenInfo (tokenAddress: string, networkName: NetworkName): Promise<TokenInfo> {
    const normalizedAddress = tokenAddress.toLowerCase()
    const cacheKey = `${networkName}:${normalizedAddress}`

    // Check cache first
    if (this.tokenCache.has(cacheKey)) {
      return this.tokenCache.get(cacheKey)!
    }

    // Try to resolve from static lists first (faster)
    const staticToken = this.getTokenFromStaticLists(normalizedAddress, networkName)
    if (staticToken) {
      this.tokenCache.set(cacheKey, staticToken)
      return staticToken
    }

    // Fallback to default unknown token
    const unknownToken: TokenInfo = {
      address: normalizedAddress,
      symbol: 'UNKNOWN',
      name: 'Unknown Token',
      decimals: 18,
    }

    this.tokenCache.set(cacheKey, unknownToken)
    return unknownToken
  }

  /**
   * Get token symbol quickly (uses cache or static lists only)
   * @param tokenAddress - The ERC-20 token contract address
   * @param networkName - Optional network name for network-specific lookups
   * @returns The token symbol string, or 'UNKNOWN' if not found
   */
  getTokenSymbol (tokenAddress: string, networkName?: NetworkName): string {
    if (!networkName) {
      return this.getTokenSymbolFromGenericList(tokenAddress)
    }

    const normalizedAddress = tokenAddress.toLowerCase()
    const cacheKey = `${networkName}:${normalizedAddress}`

    // Check cache first
    if (this.tokenCache.has(cacheKey)) {
      return this.tokenCache.get(cacheKey)!.symbol
    }

    // Try static lists
    const staticToken = this.getTokenFromStaticLists(normalizedAddress, networkName)
    if (staticToken) {
      this.tokenCache.set(cacheKey, staticToken)
      return staticToken.symbol
    }

    // Fallback to generic list
    return this.getTokenSymbolFromGenericList(tokenAddress)
  }

  /**
   * Resolve token from static/predefined lists and custom tokens
   * @param normalizedAddress - The lowercase token address to look up
   * @param networkName - The network to check network-specific token lists
   * @returns The matching TokenInfo, or null if not found in any list
   */
  private getTokenFromStaticLists (
    normalizedAddress: string,
    networkName: NetworkName
  ): TokenInfo | null {
    // Check network-specific tokens first
    const networkTokens = NETWORK_TOKENS[networkName]
    if (networkTokens && networkTokens[normalizedAddress]) {
      return networkTokens[normalizedAddress]
    }

    // Check common tokens across all networks
    const commonToken = COMMON_TOKENS[normalizedAddress]
    if (commonToken) {
      return commonToken
    }

    // Check user-added custom tokens
    const customKey = `${networkName}:${normalizedAddress}`
    const customToken = this.customTokens.get(customKey)
    if (customToken) {
      return customToken
    }

    return null
  }

  /**
   * Fallback method using generic token mappings
   * @param tokenAddress - The token address to look up across all generic lists
   * @returns The token symbol, or 'UNKNOWN' if not found
   */
  private getTokenSymbolFromGenericList (tokenAddress: string): string {
    const normalizedAddress = tokenAddress.toLowerCase()

    // Check common tokens
    const commonToken = COMMON_TOKENS[normalizedAddress]
    if (commonToken) {
      return commonToken.symbol
    }

    // Check custom tokens across all networks
    for (const [, token] of this.customTokens) {
      if (token.address === normalizedAddress) {
        return token.symbol
      }
    }

    return 'UNKNOWN'
  }

  /**
   * Add a custom token for a specific network. Persists to localStorage.
   * @param token - The token metadata to add
   * @param networkName - The network the token belongs to
   */
  addCustomToken (token: TokenInfo, networkName: NetworkName): void {
    const normalizedAddress = token.address.toLowerCase()
    const storageKey = `${networkName}:${normalizedAddress}`
    const normalizedToken: TokenInfo = {
      ...token,
      address: normalizedAddress,
    }
    this.customTokens.set(storageKey, normalizedToken)

    // Also populate the in-memory cache so lookups work immediately
    this.tokenCache.set(storageKey, normalizedToken)

    this.saveCustomTokens()
  }

  /**
   * Remove a custom token for a specific network. Persists to localStorage.
   * @param tokenAddress - The address of the custom token to remove
   * @param networkName - The network the token belongs to
   */
  removeCustomToken (tokenAddress: string, networkName: NetworkName): void {
    const normalizedAddress = tokenAddress.toLowerCase()
    const storageKey = `${networkName}:${normalizedAddress}`
    this.customTokens.delete(storageKey)
    this.tokenCache.delete(storageKey)
    this.saveCustomTokens()
  }

  /**
   * Get all custom tokens for a specific network.
   * @param networkName - The network to retrieve custom tokens for
   * @returns Array of custom TokenInfo entries for the network
   */
  getCustomTokens (networkName: NetworkName): TokenInfo[] {
    const prefix = `${networkName}:`
    const tokens: TokenInfo[] = []
    for (const [key, token] of this.customTokens) {
      if (key.startsWith(prefix)) {
        tokens.push(token)
      }
    }
    return tokens
  }

  /**
   * Get all built-in ERC-20 tokens for a network (excludes native ETH).
   * Used by PublicBalanceService to auto-check known token balances.
   * @param networkName - The network to retrieve built-in tokens for
   * @returns Array of built-in TokenInfo entries for the network
   */
  getBuiltInTokens (networkName: NetworkName): TokenInfo[] {
    const networkTokens = NETWORK_TOKENS[networkName]
    return networkTokens ? Object.values(networkTokens) : []
  }

  /**
   * Check if a token address is a user-added custom token.
   * @param tokenAddress - The token address to check
   * @param networkName - The network to check against
   * @returns True if the token was added as a custom token on this network
   */
  isCustomToken (tokenAddress: string, networkName: NetworkName): boolean {
    const normalizedAddress = tokenAddress.toLowerCase()
    const storageKey = `${networkName}:${normalizedAddress}`
    return this.customTokens.has(storageKey)
  }

  /**
   * Hide a token for a specific wallet and network. Encrypts and persists to localStorage.
   * @param tokenAddress - The token address to hide
   * @param walletId - The wallet ID the hiding applies to
   * @param networkName - The network the token is on
   * @param password - The wallet password used for encrypting persisted data
   */
  async hideToken (
    tokenAddress: string,
    walletId: string,
    networkName: NetworkName,
    password: string
  ): Promise<void> {
    const normalizedAddress = tokenAddress.toLowerCase()
    const key = `${walletId}:${networkName}`
    if (!this.hiddenTokens.has(key)) {
      this.hiddenTokens.set(key, new Set())
    }
    this.hiddenTokens.get(key)!.add(normalizedAddress)
    await this.saveHiddenTokens(walletId, networkName, password)
  }

  /**
   * Check if a token is hidden for a specific wallet and network.
   * @param tokenAddress - The token address to check
   * @param walletId - The wallet ID to check against
   * @param networkName - The network to check against
   * @returns True if the token is hidden for this wallet and network
   */
  isTokenHidden (tokenAddress: string, walletId: string, networkName: NetworkName): boolean {
    const normalizedAddress = tokenAddress.toLowerCase()
    const key = `${walletId}:${networkName}`
    return this.hiddenTokens.get(key)?.has(normalizedAddress) ?? false
  }

  /**
   * Load hidden tokens from encrypted localStorage for a wallet+network.
   * Call on wallet unlock/switch.
   * @param walletId - The wallet ID to load hidden tokens for
   * @param networkName - The network to load hidden tokens for
   * @param password - The wallet password used to decrypt stored data
   */
  async loadHiddenTokens (
    walletId: string,
    networkName: NetworkName,
    password: string
  ): Promise<void> {
    const storageKey = `${HIDDEN_TOKENS_STORAGE_PREFIX}:${walletId}:${networkName}`
    const mapKey = `${walletId}:${networkName}`
    try {
      const encrypted = localStorage.getItem(storageKey)
      if (!encrypted) {
        this.hiddenTokens.set(mapKey, new Set())
        return
      }
      const decrypted = await decryptWithPassword(encrypted, password)
      const addresses: string[] = JSON.parse(decrypted)
      this.hiddenTokens.set(mapKey, new Set(addresses))
    } catch {
      // Decryption failed or corrupt data — start fresh
      this.hiddenTokens.set(mapKey, new Set())
    }
  }

  /**
   * Clear in-memory hidden tokens cache. Call on lock/logout.
   */
  clearHiddenTokensCache (): void {
    this.hiddenTokens.clear()
  }

  /**
   * Encrypts and persists the hidden token set for a wallet and network to localStorage.
   * @param walletId - The wallet ID to save hidden tokens for
   * @param networkName - The network to save hidden tokens for
   * @param password - The wallet password used for encryption
   */
  private async saveHiddenTokens (
    walletId: string,
    networkName: NetworkName,
    password: string
  ): Promise<void> {
    const storageKey = `${HIDDEN_TOKENS_STORAGE_PREFIX}:${walletId}:${networkName}`
    const mapKey = `${walletId}:${networkName}`
    const set = this.hiddenTokens.get(mapKey)
    if (!set || set.size === 0) {
      localStorage.removeItem(storageKey)
      return
    }
    try {
      const plaintext = JSON.stringify(Array.from(set))
      const encrypted = await encryptWithPassword(plaintext, password)
      localStorage.setItem(storageKey, encrypted)
    } catch {
      // Encryption failed — don't persist
    }
  }

  /**
   * Loads custom tokens from localStorage into the in-memory maps.
   */
  private loadCustomTokens (): void {
    try {
      const stored = localStorage.getItem(CUSTOM_TOKENS_STORAGE_KEY)
      if (!stored) return
      const entries: Array<[string, TokenInfo]> = JSON.parse(stored)
      for (const [key, token] of entries) {
        this.customTokens.set(key, token)
        // Pre-populate the cache too
        this.tokenCache.set(key, token)
      }
    } catch {
      // Ignore corrupt localStorage data
    }
  }

  /**
   * Persists the custom tokens map to localStorage.
   */
  private saveCustomTokens (): void {
    try {
      const entries = Array.from(this.customTokens.entries())
      localStorage.setItem(CUSTOM_TOKENS_STORAGE_KEY, JSON.stringify(entries))
    } catch {
      // localStorage may be full or unavailable
    }
  }
}

/**
 * Common tokens that appear across multiple networks
 */
const COMMON_TOKENS: Record<string, TokenInfo> = {
  '0x0000000000000000000000000000000000000000': {
    address: '0x0000000000000000000000000000000000000000',
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
  },
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': {
    address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    symbol: 'WETH',
    name: 'Wrapped Ether (Mainnet)',
    decimals: 18,
  },
}

/**
 * Network-specific token lists
 */
const NETWORK_TOKENS: Record<NetworkName, Record<string, TokenInfo>> = {
  [NetworkName.EthereumSepolia]: {
    '0x3e622317f8c93f7328350cf0b56d9ed4c620c5d6': {
      address: '0x3e622317f8c93f7328350cf0b56d9ed4c620c5d6',
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
    },
    '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238': {
      address: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
    '0xfff9976782d46cc05630d1f6ebab18b2324d6b14': {
      address: '0xfff9976782d46cc05630d1f6ebab18b2324d6b14',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
    },
  },
  [NetworkName.Hardhat]: {
    // Hardhat local testnet tokens
  },
}

export { TokenService }
