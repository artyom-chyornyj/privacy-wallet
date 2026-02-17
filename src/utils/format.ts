import { NetworkName } from '@/types/network'

/**
 * Format a bigint token amount to a human-readable decimal string.
 * Trims trailing zeros from the fractional part.
 * @param amount - The raw bigint token amount in smallest units.
 * @param decimals - The number of decimal places for the token.
 * @param maxDecimals - The maximum number of fractional digits to display.
 * @returns The formatted decimal string with trailing zeros trimmed.
 */
function formatTokenAmount (amount: bigint, decimals: number, maxDecimals = 8): string {
  const amt = typeof amount === 'bigint' ? amount : BigInt(amount || '0')
  const divisor = 10n ** BigInt(decimals)
  const quotient = amt / divisor
  const remainder = amt % divisor

  if (remainder === 0n) return quotient.toString()

  const remainderStr = remainder.toString().padStart(decimals, '0')
  const capped = remainderStr.slice(0, maxDecimals)
  const trimmed = capped.replace(/0+$/, '')

  return trimmed ? `${quotient}.${trimmed}` : quotient.toString()
}

/**
 * Format a unix timestamp (seconds) to a short date string.
 * @param timestamp - The unix timestamp in seconds.
 * @returns The formatted date string (e.g. "Jan 1, 2025").
 */
function formatTxDate (timestamp: number): string {
  const date = new Date(timestamp * 1000)
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/**
 * Shorten an address for display: "0x1234...abcd"
 * @param address - The full address string to shorten.
 * @param headLen - Number of characters to keep from the start.
 * @param tailLen - Number of characters to keep from the end.
 * @returns The shortened address with ellipsis, or the original if already short enough.
 */
function shortenAddress (address: string, headLen = 6, tailLen = 4): string {
  if (!address) return ''
  if (address.length <= headLen + tailLen + 3) return address
  return `${address.slice(0, headLen)}...${address.slice(-tailLen)}`
}

/**
 * Get the block explorer URL for a transaction hash on the given network.
 * @param network - The network name to look up the explorer base URL.
 * @param txHash - The transaction hash to link to.
 * @returns The full block explorer URL for the transaction.
 */
function getExplorerTxUrl (network: NetworkName, txHash: string): string {
  const baseUrls: Partial<Record<NetworkName, string>> = {
    [NetworkName.EthereumSepolia]: 'https://sepolia.etherscan.io',
  }
  const base = baseUrls[network] || 'https://sepolia.etherscan.io'
  return `${base}/tx/${txHash}`
}

/**
 * Get the block explorer URL for an address on the given network.
 * @param network - The network name to look up the explorer base URL.
 * @param address - The wallet or contract address to link to.
 * @returns The full block explorer URL for the address.
 */
function getExplorerAddressUrl (network: NetworkName, address: string): string {
  const baseUrls: Partial<Record<NetworkName, string>> = {
    [NetworkName.EthereumSepolia]: 'https://sepolia.etherscan.io',
  }
  const base = baseUrls[network] || 'https://sepolia.etherscan.io'
  return `${base}/address/${address}`
}

/**
 * Get the ppoi.info URL for a transaction.
 * @param network - The network name to map to the ppoi.info network slug.
 * @param txHash - The transaction hash to link to.
 * @returns The full ppoi.info URL for the transaction.
 */
function getPPOIInfoUrl (network: NetworkName, txHash: string): string {
  const networkMap: Partial<Record<NetworkName, string>> = {
    [NetworkName.EthereumSepolia]: 'Ethereum_Sepolia',
  }
  const networkSlug = networkMap[network] || 'Ethereum_Sepolia'
  return `https://ppoi.info/${networkSlug}/tx/${txHash}`
}

export {
  formatTokenAmount,
  formatTxDate,
  shortenAddress,
  getExplorerTxUrl,
  getExplorerAddressUrl,
  getPPOIInfoUrl,
}
