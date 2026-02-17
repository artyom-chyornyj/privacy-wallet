/**
 * Shared transaction utilities used across PrivateSendService and UnshieldService.
 */

/**
 * Recursively convert BigInt values to strings for ethers.js ABI compatibility.
 * @param obj - The value or object to convert
 * @returns A copy with all BigInt values replaced by their string representations
 */
function convertBigIntsToStrings (obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === 'bigint') return obj.toString()
  if (Array.isArray(obj)) return obj.map((item) => convertBigIntsToStrings(item))
  if (typeof obj === 'object') {
    const converted: any = {}
    for (const [key, value] of Object.entries(obj)) {
      converted[key] = convertBigIntsToStrings(value)
    }
    return converted
  }
  return obj
}

/**
 * Format a proved transaction for the RAILGUN contract ABI.
 * Converts BigInt values to strings and removes boundParamsHash
 * (which is only used internally for proof generation, not part of the contract struct).
 * @param provedTransaction - The proved transaction object from proof generation
 * @returns The formatted transaction ready for contract submission
 */
export function formatTransactionForContract (provedTransaction: any): any {
  const formatted = convertBigIntsToStrings(provedTransaction)
  // boundParamsHash is NOT part of the contract's Transaction struct ABI
  delete formatted.boundParamsHash
  return formatted
}
