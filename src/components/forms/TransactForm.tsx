import { ethers } from 'ethers'
import React, { useEffect, useMemo, useRef, useState } from 'react'

import { GasWalletSelector } from '@/components/common/GasWalletSelector'
import { POIService } from '@/services/POIService'
import { PrivateSendService } from '@/services/PrivateSendService'
import { PublicTransferService } from '@/services/PublicTransferService'
import { SubsquidBalanceScanner } from '@/services/SubsquidBalanceScanner'
import { TokenService } from '@/services/TokenService'
import { TransactionHistoryService } from '@/services/TransactionHistoryService'
import { UnshieldService } from '@/services/UnshieldService'
import { useWalletStore } from '@/stores/walletStore'
import type { NetworkName } from '@/types/network'
import {
  NETWORK_CONFIG,
  getBlockExplorerUrl,
  getEffectiveRpcUrl,
  isWrappedBaseToken,
} from '@/types/network'
import type { ShieldTransactionParams, TokenBalance } from '@/types/wallet'
import './TransactForm.css'

interface TransactFormProps {
  onSuccess?: (txHash: string) => void
  onError?: (error: string) => void
}

type TransactionPath = 'public-transfer' | 'shield' | 'private-send' | 'unshield' | 'undetermined'

/**
 * Parse raw ethers/RPC error messages into user-friendly text.
 * @param raw - The raw error message string from ethers or the RPC provider
 * @returns A user-friendly error message string
 */
function formatTransactionError (raw: string): string {
  if (/INSUFFICIENT_FUNDS|insufficient funds/i.test(raw)) {
    const costMatch = /tx cost (\d+)/.exec(raw)
    if (costMatch && costMatch[1]) {
      const costWei = BigInt(costMatch[1])
      const costEth = ethers.formatEther(costWei)
      return `Insufficient ETH for gas. The transaction requires approximately ${Number(costEth).toFixed(6)} ETH in the gas payer wallet.`
    }
    return 'Insufficient ETH in the gas payer wallet to cover transaction gas fees.'
  }
  if (/NONCE_EXPIRED|nonce.*too low/i.test(raw)) {
    return 'Transaction nonce conflict. Please try again.'
  }
  if (/CALL_EXCEPTION|execution reverted/i.test(raw)) {
    const reasonMatch = /reason="([^"]+)"/.exec(raw)
    return reasonMatch
      ? `Transaction reverted: ${reasonMatch[1]}`
      : 'Transaction reverted by the contract.'
  }
  if (/NETWORK_ERROR|could not detect network/i.test(raw)) {
    return 'Network connection error. Please check your internet connection and try again.'
  }
  if (/TIMEOUT|timeout/i.test(raw)) {
    return 'Transaction timed out. It may still be pending — check the block explorer.'
  }
  // Truncate overly long messages (e.g. ones containing raw tx hex)
  if (raw.length > 200) {
    const firstSentence = raw.split(/[.(]/)[0] || ''
    return firstSentence.length > 10 ? firstSentence : raw.slice(0, 200) + '...'
  }
  return raw
}

const PATH_LABELS: Record<TransactionPath, string> = {
  'public-transfer': 'Public Transfer',
  shield: 'Shield to Private',
  'private-send': 'Private Send',
  unshield: 'Unshield to Public',
  undetermined: '',
}

const PATH_ICONS: Record<TransactionPath, string> = {
  'public-transfer': '\u{1f4e4}',
  shield: '\u{1f6e1}',
  'private-send': '\u{1f510}',
  unshield: '\u{1f513}',
  undetermined: '\u{2194}',
}

type GasSpeed = 'slow' | 'standard' | 'fast'
const GAS_MULTIPLIERS: Record<GasSpeed, { label: string; multiplier: number }> = {
  slow: { label: 'Slow', multiplier: 0.85 },
  standard: { label: 'Standard', multiplier: 1.0 },
  fast: { label: 'Fast', multiplier: 1.5 },
}

/**
 * Render an address with a colored 0x/0zk prefix.
 * @param root0 - The component props
 * @param root0.address - The wallet address string to display
 * @param root0.maxLen - Optional maximum display length before truncating
 * @returns A span element with the address prefix colored by type
 */
const ColoredAddress: React.FC<{ address: string; maxLen?: number }> = ({ address, maxLen }) => {
  const is0zk = address.startsWith('0zk')
  const prefix = is0zk ? address.slice(0, 3) : address.slice(0, 2)
  const rest = is0zk ? address.slice(3) : address.slice(2)
  const truncatedRest = maxLen
    ? rest.slice(0, maxLen - prefix.length) + '...' + address.slice(-4)
    : rest
  return (
    <span className='colored-addr'>
      <span className={is0zk ? 'addr-prefix-private' : 'addr-prefix-public'}>{prefix}</span>
      {truncatedRest}
    </span>
  )
}

interface AddressOption {
  walletId: string
  label: string
  address: string
  type: '0x' | '0zk'
  isSelf: boolean
}

/**
 * Main transaction form component supporting public transfers, shields, private sends, and unshields.
 * @param root0 - The component props
 * @param root0.onSuccess - Optional callback invoked with the transaction hash on success
 * @param root0.onError - Optional callback invoked with an error message on failure
 * @returns The rendered transaction form component
 */
export const TransactForm: React.FC<TransactFormProps> = ({ onSuccess, onError }) => {
  const {
    currentWallet,
    currentNetwork,
    balances,
    isSyncing,
    executeShieldTransaction,
    canShieldToken,
    approveTokenForShield,
    checkTokenApprovalStatus,
    getGasPayerWallet,
    savedWallets,
    balanceMode,
    refreshBalances,
  } = useWalletStore()

  // From address is always derived from the selected wallet + balance mode
  const fromAddress = useMemo(() => {
    if (!currentWallet) return ''
    return balanceMode === 'private'
      ? currentWallet.address || currentWallet.ethereumAddress || ''
      : currentWallet.ethereumAddress || ''
  }, [currentWallet, balanceMode])

  const fromType = useMemo((): '0x' | '0zk' => {
    if (fromAddress.startsWith('0zk')) return '0zk'
    return '0x'
  }, [fromAddress])

  const walletNickname = currentWallet?.nickname || 'Wallet'

  // Core form state
  const [selectedToken, setSelectedToken] = useState<string>('')
  const [amount, setAmount] = useState<string>('')
  const [toAddress, setToAddress] = useState<string>('')
  const [memoText, setMemoText] = useState<string>('')

  // Transaction execution state
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [suggestionDisplay, setSuggestionDisplay] = useState<string | null>(null)

  // Recipient dropdown state
  const [showRecipientDropdown, setShowRecipientDropdown] = useState(false)
  const recipientDropdownRef = useRef<HTMLDivElement>(null)

  // Reset token/amount when wallet changes (covers same-mode wallet switches
  // where fromType stays the same but available balances differ)
  useEffect(() => {
    setSelectedToken('')
    setAmount('')
    setMemoText('')
  }, [currentWallet])

  // Close dropdown on click outside
  useEffect(() => {
    /**
     * Close the recipient dropdown when clicking outside of it.
     * @param e - The mouse event from the document listener
     */
    const handleClickOutside = (e: MouseEvent) => {
      if (
        recipientDropdownRef.current &&
        !recipientDropdownRef.current.contains(e.target as Node)
      ) {
        setShowRecipientDropdown(false)
      }
    }
    if (showRecipientDropdown) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showRecipientDropdown])

  // Build recipient address options from saved wallets
  const recipientOptions = useMemo((): AddressOption[] => {
    const options: AddressOption[] = []
    for (const w of savedWallets) {
      const isSelf = currentWallet ? w.id === currentWallet.id : false
      if (w.ethereumAddress) {
        options.push({
          walletId: w.id,
          label: isSelf ? `${w.nickname || 'Wallet'} (self)` : w.nickname || 'Wallet',
          address: w.ethereumAddress,
          type: '0x',
          isSelf,
        })
      }
      if (w.address) {
        options.push({
          walletId: w.id,
          label: isSelf ? `${w.nickname || 'Wallet'} (self)` : w.nickname || 'Wallet',
          address: w.address,
          type: '0zk',
          isSelf,
        })
      }
    }
    return options
  }, [savedWallets, currentWallet])

  // Post-transaction state
  const [completedTxHash, setCompletedTxHash] = useState<string>('')
  const [isWaitingForConfirmation, setIsWaitingForConfirmation] = useState(false)

  // PPOI state (for private send)
  const [poiStatus, setPoiStatus] = useState<'pending' | 'submitting' | 'success' | 'error' | null>(
    null
  )
  const [poiError, setPoiError] = useState<string | null>(null)
  const [balancesRefreshed, setBalancesRefreshed] = useState(false)
  const [isRefreshingBalances, setIsRefreshingBalances] = useState(false)

  // Unshield to native ETH toggle (when unshielding WETH)
  const [unshieldToNative, setUnshieldToNative] = useState(false)

  // Approval state (for shield path with ERC-20)
  const [approvalStatus, setApprovalStatus] = useState<{
    isApproved: boolean
    allowance: string
    isChecking: boolean
  }>({ isApproved: false, allowance: '0', isChecking: false })
  const [isApproving, setIsApproving] = useState(false)
  const [canShield, setCanShield] = useState(true)

  // Gas & fee state
  const [gasSpeed, setGasSpeed] = useState<GasSpeed>('standard')
  const [gasEstimate, setGasEstimate] = useState<{
    totalCostWei: bigint
    totalCostEth: string
    isEstimating: boolean
    error: string | null
  } | null>(null)
  const [protocolFees, setProtocolFees] = useState<{
    shieldFeeBps: bigint
    unshieldFeeBps: bigint
    shieldFeePercent: string
    unshieldFeePercent: string
  } | null>(null)
  const [addFeeToAmount, setAddFeeToAmount] = useState(false)

  // Cached provider ref to avoid creating new instances on each estimation
  const providerRef = useRef<ethers.JsonRpcProvider | null>(null)
  const providerNetworkRef = useRef<string>('')
  const gasEstimateVersionRef = useRef(0)

  // Shared provider: reuses a single cached instance per network to avoid
  // redundant eth_chainId calls and duplicate provider creation.
  /**
   * Get or create a cached JSON-RPC provider for the current network.
   * @returns A reusable JsonRpcProvider instance for the current network
   */
  const getOrCreateProvider = (): ethers.JsonRpcProvider => {
    if (providerRef.current && providerNetworkRef.current === currentNetwork) {
      return providerRef.current
    }
    const config = NETWORK_CONFIG[currentNetwork as NetworkName]
    const provider = new ethers.JsonRpcProvider(getEffectiveRpcUrl(currentNetwork as NetworkName), {
      name: (currentNetwork as string).toLowerCase(),
      chainId: config.chainId,
    })
    providerRef.current = provider
    providerNetworkRef.current = currentNetwork as string
    return provider
  }

  // Detect To address type
  const toType = useMemo((): '0x' | '0zk' | 'unknown' => {
    if (!toAddress || toAddress.length < 2) return 'unknown'
    if (toAddress.startsWith('0zk')) return '0zk'
    if (toAddress.startsWith('0x') || toAddress.startsWith('0X')) return '0x'
    return 'unknown'
  }, [toAddress])

  // Detect transaction path
  const transactionPath = useMemo((): TransactionPath => {
    if (toType === 'unknown') return 'undetermined'
    if (fromType === '0x' && toType === '0x') return 'public-transfer'
    if (fromType === '0x' && toType === '0zk') return 'shield'
    if (fromType === '0zk' && toType === '0zk') return 'private-send'
    if (fromType === '0zk' && toType === '0x') return 'unshield'
    return 'undetermined'
  }, [fromType, toType])

  // Get available tokens based on from type
  // For private (0zk) balances, check live PPOI cache (same source as BalancesPage)
  // to determine spendable amounts, since the store's balanceBucket can be stale.
  const availableTokens = useMemo(() => {
    if (fromType === '0x') {
      return balances.filter(
        (b: TokenBalance) =>
          b.balance > 0n &&
          (b.balanceBucket === 'spendable-public' ||
            b.balanceBucket === 'available' ||
            !b.balanceBucket?.includes('private'))
      )
    }

    // 0zk: Check live PPOI cache per commitment to compute accurate spendable amounts.
    // The store's balanceBucket can be stale if PPOI was submitted/confirmed after the last scan.
    const scanner = SubsquidBalanceScanner.getInstance()
    const poiService = POIService.getInstance()
    const commitments = currentWallet
      ? scanner.getDecryptedCommitmentsForWallet(currentWallet.id)
      : []
    const unspentCommitments = commitments.filter((c) => !c.isSpent && !c.isSentToOther)

    if (unspentCommitments.length > 0) {
      // Use commitment-level PPOI cache (same approach as BalancesPage)
      const tokenMap = new Map<string, TokenBalance & { spendableBalance: bigint }>()

      for (const commitment of unspentCommitments) {
        const tokenKey = commitment.tokenAddress.toLowerCase()
        const blindedCommitment = scanner.blindedCommitmentOf(commitment)
        const commitmentType =
          commitment.commitmentType === 'ShieldCommitment' ? 'Shield' : 'Transact'
        const cachedStatus = poiService.getPOIStatusForCommitmentsFromCacheOnly(
          currentNetwork as NetworkName,
          [{ blindedCommitment, type: commitmentType as 'Shield' | 'Transact' | 'Unshield' }]
        )
        const poiStatus = cachedStatus[blindedCommitment]?.status || 'unknown'
        const isSpendable = poiStatus === 'valid'

        const existing = tokenMap.get(tokenKey)
        if (existing) {
          existing.balance += commitment.value
          if (isSpendable) {
            existing.spendableBalance += commitment.value
          }
        } else {
          // Look up token info from store balances first, then TokenService as fallback
          const storeBalance = balances.find((b) => b.tokenAddress.toLowerCase() === tokenKey)
          const resolvedSymbol =
            storeBalance?.symbol ||
            TokenService.getInstance().getTokenSymbol(tokenKey, currentNetwork as NetworkName)
          tokenMap.set(tokenKey, {
            tokenAddress: commitment.tokenAddress,
            symbol: resolvedSymbol,
            decimals:
              storeBalance?.decimals ??
              scanner.getTokenDecimals(tokenKey, currentNetwork as NetworkName),
            balance: commitment.value,
            spendableBalance: isSpendable ? commitment.value : 0n,
            balanceBucket: isSpendable ? 'Spendable' : 'MissingExternalPOI',
          })
        }
      }

      return Array.from(tokenMap.values())
    }

    // Fallback: no commitments in scanner, use store balances with their buckets
    const excludedBuckets = ['spent', 'shieldblocked']
    const tokenMap = new Map<string, TokenBalance & { spendableBalance: bigint }>()

    for (const b of balances) {
      if (b.balance <= 0n) continue
      if (excludedBuckets.includes(b.balanceBucket?.toLowerCase?.() ?? '')) continue

      const key = b.tokenAddress.toLowerCase()
      const existing = tokenMap.get(key)
      const isSpendable = b.balanceBucket === 'Spendable'

      if (existing) {
        existing.balance += b.balance
        if (isSpendable) {
          existing.spendableBalance += b.balance
        }
      } else {
        tokenMap.set(key, {
          ...b,
          tokenAddress: b.tokenAddress,
          balance: b.balance,
          spendableBalance: isSpendable ? b.balance : 0n,
          balanceBucket: isSpendable ? 'Spendable' : b.balanceBucket,
        })
      }
    }

    return Array.from(tokenMap.values())
  }, [balances, fromType, currentWallet, currentNetwork])

  // Helper: get the spendable balance for the currently selected private token
  const selectedTokenSpendable = useMemo(() => {
    if (fromType !== '0zk' || !selectedToken) return undefined
    const token = availableTokens.find(
      (b) => b.tokenAddress.toLowerCase() === selectedToken.toLowerCase()
    )
    return token
      ? (token as TokenBalance & { spendableBalance: bigint }).spendableBalance
      : undefined
  }, [fromType, selectedToken, availableTokens])

  // Detect if the selected token is WETH (wrapped base token) for the current network
  const isSelectedTokenWETH = useMemo(() => {
    if (!selectedToken || !currentNetwork) return false
    return isWrappedBaseToken(selectedToken, currentNetwork as NetworkName)
  }, [selectedToken, currentNetwork])

  // Show "Unshield to ETH" option when unshielding WETH
  const showUnshieldToNativeOption = transactionPath === 'unshield' && isSelectedTokenWETH

  // Reset unshieldToNative when conditions change
  useEffect(() => {
    if (!showUnshieldToNativeOption) {
      setUnshieldToNative(false)
    }
  }, [showUnshieldToNativeOption])

  // Reset token selection when from type changes
  useEffect(() => {
    setSelectedToken('')
    setAmount('')
    setApprovalStatus({ isApproved: false, allowance: '0', isChecking: false })
  }, [fromType])

  // Check shield-ability for shield path
  useEffect(() => {
    if (transactionPath === 'shield' && selectedToken) {
      canShieldToken(selectedToken)
        .then(setCanShield)
        .catch(() => setCanShield(false))
    } else {
      setCanShield(true)
    }
  }, [selectedToken, transactionPath, canShieldToken])

  // Check token approval for shield path (debounced)
  useEffect(() => {
    if (transactionPath !== 'shield') {
      setApprovalStatus({ isApproved: false, allowance: '0', isChecking: false })
      return
    }

    /**
     * Check whether the selected ERC-20 token is approved for the RAILGUN shield contract.
     */
    const checkApproval = async () => {
      if (!selectedToken || !amount) {
        setApprovalStatus({ isApproved: false, allowance: '0', isChecking: false })
        return
      }

      const amountNum = parseFloat(amount)
      if (amountNum <= 0 || isNaN(amountNum)) {
        setApprovalStatus({ isApproved: false, allowance: '0', isChecking: false })
        return
      }

      const isNativeETH = selectedToken === '0x0000000000000000000000000000000000000000'
      if (isNativeETH) {
        setApprovalStatus({ isApproved: true, allowance: 'unlimited', isChecking: false })
        return
      }

      try {
        setApprovalStatus((prev) => ({ ...prev, isChecking: true }))
        const tokenBalance = balances.find((b: TokenBalance) => b.tokenAddress === selectedToken)
        if (!tokenBalance) throw new Error('Token not found')

        const amountWei = ethers.parseUnits(amount, tokenBalance.decimals)
        const result = await checkTokenApprovalStatus(selectedToken, amountWei.toString())
        setApprovalStatus({
          isApproved: result.isApproved,
          allowance: result.allowance,
          isChecking: false,
        })
      } catch {
        setApprovalStatus({ isApproved: false, allowance: '0', isChecking: false })
      }
    }

    const timeoutId = setTimeout(checkApproval, 500)
    return () => clearTimeout(timeoutId)
  }, [selectedToken, amount, transactionPath, balances, checkTokenApprovalStatus])

  // Fetch RAILGUN protocol fees from on-chain contract only when user enters shield/unshield path
  const protocolFeesFetchedForRef = useRef<string>('')
  useEffect(() => {
    if (!currentNetwork) return
    if (transactionPath !== 'shield' && transactionPath !== 'unshield') return
    // Only fetch once per network to avoid repeated RPC calls
    if (protocolFeesFetchedForRef.current === currentNetwork) return
    /**
     * Fetch RAILGUN shield and unshield fee rates from the on-chain contract.
     */
    const fetchFees = async () => {
      try {
        const config = NETWORK_CONFIG[currentNetwork as NetworkName]
        if (!config) return
        const provider = getOrCreateProvider()
        const contract = new ethers.Contract(
          config.railgunContractAddress,
          [
            'function shieldFee() view returns (uint120)',
            'function unshieldFee() view returns (uint120)',
          ],
          provider
        )
        const shieldFeeFn = contract['shieldFee']
        const unshieldFeeFn = contract['unshieldFee']
        if (!shieldFeeFn || !unshieldFeeFn) throw new Error('Contract missing fee functions')
        const [shieldFee, unshieldFee] = await Promise.all([
          shieldFeeFn() as Promise<bigint>,
          unshieldFeeFn() as Promise<bigint>,
        ])
        protocolFeesFetchedForRef.current = currentNetwork as string
        setProtocolFees({
          shieldFeeBps: shieldFee,
          unshieldFeeBps: unshieldFee,
          shieldFeePercent: (Number(shieldFee) / 100).toFixed(2),
          unshieldFeePercent: (Number(unshieldFee) / 100).toFixed(2),
        })
      } catch (err) {
        console.error('Failed to fetch RAILGUN protocol fees:', err)
      }
    }
    fetchFees()
  }, [currentNetwork, transactionPath])

  // Reset addFeeToAmount when leaving shield/unshield path
  useEffect(() => {
    if (transactionPath !== 'shield' && transactionPath !== 'unshield') {
      setAddFeeToAmount(false)
    }
  }, [transactionPath])

  // Debounced gas estimation
  useEffect(() => {
    if (!selectedToken || !amount || !toAddress || transactionPath === 'undetermined') {
      setGasEstimate(null)
      return
    }
    const amountNum = parseFloat(amount)
    if (amountNum <= 0 || isNaN(amountNum)) {
      setGasEstimate(null)
      return
    }

    const version = ++gasEstimateVersionRef.current

    /**
     * Estimate gas cost for the current transaction based on path type and gas speed.
     */
    const estimateGas = async () => {
      setGasEstimate((prev) =>
        prev
          ? { ...prev, isEstimating: true, error: null }
          : { totalCostWei: 0n, totalCostEth: '0', isEstimating: true, error: null }
      )

      try {
        const provider = getOrCreateProvider()
        const feeData = await provider.getFeeData()
        const baseGasPrice = feeData.maxFeePerGas || feeData.gasPrice || BigInt(20_000_000_000)
        const multiplier = GAS_MULTIPLIERS[gasSpeed].multiplier
        const adjustedGasPrice = (baseGasPrice * BigInt(Math.floor(multiplier * 100))) / 100n

        let gasLimit: bigint

        switch (transactionPath) {
          case 'public-transfer': {
            const isNativeETH = selectedToken === '0x0000000000000000000000000000000000000000'
            gasLimit = isNativeETH ? 21000n : 65000n
            break
          }
          case 'shield': {
            const isNativeETH = selectedToken === '0x0000000000000000000000000000000000000000'
            gasLimit = isNativeETH ? BigInt(500_000) : BigInt(420_000)
            break
          }
          case 'private-send':
            gasLimit = BigInt(800_000)
            break
          case 'unshield':
            gasLimit = unshieldToNative ? BigInt(350_000) : BigInt(250_000)
            break
          default:
            gasLimit = BigInt(250_000)
        }

        const totalCostWei = gasLimit * adjustedGasPrice
        const totalCostEth = ethers.formatEther(totalCostWei)

        // Discard stale results
        if (version !== gasEstimateVersionRef.current) return

        setGasEstimate({
          totalCostWei,
          totalCostEth: parseFloat(totalCostEth).toFixed(6),
          isEstimating: false,
          error: null,
        })
      } catch (err) {
        if (version !== gasEstimateVersionRef.current) return
        setGasEstimate({
          totalCostWei: 0n,
          totalCostEth: '0',
          isEstimating: false,
          error: 'Failed to estimate gas',
        })
      }
    }

    const timeoutId = setTimeout(estimateGas, 800)
    return () => clearTimeout(timeoutId)
  }, [
    selectedToken,
    amount,
    toAddress,
    transactionPath,
    currentNetwork,
    gasSpeed,
    unshieldToNative,
  ])

  const selectedTokenBalance = availableTokens.find(
    (b: TokenBalance) => b.tokenAddress === selectedToken
  )

  // Computed: RAILGUN protocol fee for current transaction
  const protocolFeeAmount = useMemo(() => {
    if (!protocolFees || !amount) return null
    const amountNum = parseFloat(amount)
    if (amountNum <= 0 || isNaN(amountNum)) return null

    if (transactionPath === 'shield') {
      const feePercent = Number(protocolFees.shieldFeeBps) / 10000
      const feeAmt = amountNum * feePercent
      return { percent: protocolFees.shieldFeePercent, amount: feeAmt.toFixed(8), type: 'Shield' }
    }
    if (transactionPath === 'unshield') {
      const feePercent = Number(protocolFees.unshieldFeeBps) / 10000
      const feeAmt = amountNum * feePercent
      return {
        percent: protocolFees.unshieldFeePercent,
        amount: feeAmt.toFixed(8),
        type: 'Unshield',
      }
    }
    return null
  }, [protocolFees, amount, transactionPath])

  // Computed: adjusted amount when addFeeToAmount is toggled
  const adjustedAmount = useMemo(() => {
    if (!addFeeToAmount || !protocolFees || !amount || !selectedTokenBalance) return amount
    const amountNum = parseFloat(amount)
    if (amountNum <= 0 || isNaN(amountNum)) return amount

    let feeBps: bigint
    if (transactionPath === 'shield') {
      feeBps = protocolFees.shieldFeeBps
    } else if (transactionPath === 'unshield') {
      feeBps = protocolFees.unshieldFeeBps
    } else {
      return amount
    }

    const feeMultiplier = 1 + Number(feeBps) / 10000
    const adjusted = amountNum * feeMultiplier
    return adjusted.toFixed(Math.min(selectedTokenBalance.decimals, 18))
  }, [addFeeToAmount, protocolFees, amount, transactionPath, selectedTokenBalance])

  /**
   * Format a raw token balance from its smallest unit to a human-readable decimal string.
   * @param balance - The token balance in its smallest unit (wei)
   * @param decimals - The number of decimals the token uses
   * @returns The formatted balance as a decimal string
   */
  const formatBalance = (balance: bigint, decimals: number): string => {
    return ethers.formatUnits(balance, decimals)
  }

  // --- Execution Handlers ---

  /**
   * Approve the selected ERC-20 token for the RAILGUN shield contract.
   */
  const handleApproveToken = async () => {
    if (!selectedToken || !amount) return
    try {
      setIsApproving(true)
      setError('')
      const tokenBalance = balances.find((b: TokenBalance) => b.tokenAddress === selectedToken)
      if (!tokenBalance) throw new Error('Token not found')

      const amountWei = ethers.parseUnits(amount, tokenBalance.decimals)
      await approveTokenForShield(selectedToken, amountWei.toString())
      setApprovalStatus({ isApproved: true, allowance: amountWei.toString(), isChecking: false })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Approval failed'
      setError(msg)
      onError?.(msg)
    } finally {
      setIsApproving(false)
    }
  }

  /**
   * Execute a public ERC-20 or native ETH transfer to a 0x address.
   */
  const executePublicTransfer = async () => {
    if (!currentWallet || !ethers.isAddress(toAddress)) {
      throw new Error('Invalid recipient address')
    }
    const tokenBalance = balances.find((b: TokenBalance) => b.tokenAddress === selectedToken)
    if (!tokenBalance) throw new Error('Token not found')

    const amountWei = ethers.parseUnits(amount, tokenBalance.decimals)
    if (amountWei > tokenBalance.balance) throw new Error('Insufficient balance')

    const svc = PublicTransferService.getInstance()
    const result = await svc.executeTransfer(currentWallet, currentNetwork as NetworkName, {
      tokenAddress: selectedToken,
      amount: amountWei.toString(),
      recipientAddress: toAddress,
    })

    setCompletedTxHash(result.txHash)
    setStatus('Transfer completed!')
    onSuccess?.(result.txHash)
  }

  /**
   * Execute a shield transaction to move tokens from public to private balance.
   */
  const executeShield = async () => {
    if (!currentWallet) throw new Error('No wallet')
    const tokenBalance = balances.find((b: TokenBalance) => b.tokenAddress === selectedToken)
    if (!tokenBalance) throw new Error('Token not found')

    const effectiveAmount = addFeeToAmount ? adjustedAmount : amount
    const amountWei = ethers.parseUnits(effectiveAmount, tokenBalance.decimals)
    if (amountWei > tokenBalance.balance) throw new Error('Insufficient balance')

    const params: ShieldTransactionParams = {
      tokenAddress: selectedToken,
      amount: amountWei.toString(),
      recipientRailgunAddress: toAddress,
    }

    const result = await executeShieldTransaction(params)
    setCompletedTxHash(result.txHash)
    setStatus('Shield completed!')
    setSelectedToken('')
    setAmount('')
    setApprovalStatus({ isApproved: false, allowance: '0', isChecking: false })
    onSuccess?.(result.txHash)
  }

  /**
   * Execute a private send transaction between two 0zk RAILGUN addresses.
   */
  const executePrivateSend = async () => {
    if (!currentWallet) throw new Error('No wallet')
    if (!toAddress.startsWith('0zk') || !toAddress.includes('1')) {
      throw new Error('Invalid 0zk recipient address')
    }

    const tokenInfo = await TokenService.getInstance().getTokenInfo(
      selectedToken,
      currentNetwork as NetworkName
    )
    const amountSmallest = ethers.parseUnits(amount, tokenInfo.decimals).toString()
    const provider = getOrCreateProvider()
    const svc = PrivateSendService.getInstance()
    const gasPayerWallet = getGasPayerWallet()

    setIsWaitingForConfirmation(true)
    setStatus('Submitting transaction and waiting for confirmation...')

    const result = await svc.executePrivateSend(
      currentWallet,
      currentNetwork as NetworkName,
      { tokenAddress: selectedToken, amount: amountSmallest, recipientRailgunAddress: toAddress, ...(memoText ? { memoText } : {}) },
      provider,
      (s: string) => setStatus(s),
      false,
      gasPayerWallet?.mnemonic
    )

    setIsWaitingForConfirmation(false)
    const { txHash } = result

    if (txHash.length === 66 && txHash.startsWith('0x') && !txHash.startsWith('0x00000000')) {
      setCompletedTxHash(txHash)
      setStatus('Private send completed! Submit PPOI to make funds spendable.')
      setPoiStatus('pending')
      setPoiError(null)
    }
    onSuccess?.(txHash)
  }

  /**
   * Execute an unshield transaction to move tokens from private to a public 0x address.
   */
  const executeUnshield = async () => {
    if (!currentWallet) throw new Error('No wallet')
    if (!ethers.isAddress(toAddress)) throw new Error('Invalid 0x recipient address')

    const tokenInfo = await TokenService.getInstance().getTokenInfo(
      selectedToken,
      currentNetwork as NetworkName
    )
    const effectiveAmount = addFeeToAmount ? adjustedAmount : amount
    const amountSmallest = ethers.parseUnits(effectiveAmount, tokenInfo.decimals).toString()
    const provider = getOrCreateProvider()
    const svc = UnshieldService.getInstance()
    const gasPayerWallet = getGasPayerWallet()

    // Pre-flight check: ensure gas payer has enough ETH for gas
    const gasPayerMnemonic = gasPayerWallet?.mnemonic || currentWallet.mnemonic
    if (!gasPayerMnemonic) throw new Error('No mnemonic available for gas payment')
    const gasPayerSigner = ethers.Wallet.fromPhrase(gasPayerMnemonic)
    const gasPayerAddress = gasPayerSigner.address
    const [ethBalance, feeData] = await Promise.all([
      provider.getBalance(gasPayerAddress),
      provider.getFeeData(),
    ])
    const estimatedGasPrice = feeData.gasPrice
      ? (feeData.gasPrice * 150n) / 100n
      : ethers.parseUnits('50', 'gwei')
    // Unshield to native needs extra gas for unwrap + transfer (~1.5M + 100k)
    const gasMultiplier = unshieldToNative ? 1_700_000n : 1_500_000n
    const estimatedGasCost = estimatedGasPrice * gasMultiplier
    if (ethBalance < estimatedGasCost) {
      const needed = ethers.formatEther(estimatedGasCost)
      const have = ethers.formatEther(ethBalance)
      const shortAddr = `${gasPayerAddress.slice(0, 6)}...${gasPayerAddress.slice(-4)}`
      throw new Error(
        `Gas payer wallet (${shortAddr}) has insufficient ETH for gas. ` +
          `Has ${have} ETH, needs ~${needed} ETH. ` +
          'Please fund this wallet or select a different gas payer.'
      )
    }

    setIsWaitingForConfirmation(true)
    setStatus('Submitting transaction and waiting for confirmation...')

    let txHash: string
    if (unshieldToNative) {
      // Unshield WETH -> unwrap to ETH -> send to recipient
      const result = await svc.executeUnshieldToNative(
        currentWallet,
        currentNetwork as NetworkName,
        { tokenAddress: selectedToken, amount: amountSmallest, recipient: toAddress },
        provider,
        (s: string) => setStatus(s),
        gasPayerWallet?.mnemonic
      )
      txHash = result.txHash
    } else {
      // Standard WETH unshield
      const result = await svc.executeUnshield(
        currentWallet,
        currentNetwork as NetworkName,
        { tokenAddress: selectedToken, amount: amountSmallest, recipient: toAddress },
        provider,
        (s: string) => setStatus(s),
        gasPayerWallet?.mnemonic
      )
      txHash = result.txHash
    }

    setIsWaitingForConfirmation(false)
    if (txHash.length === 66 && txHash.startsWith('0x') && !txHash.startsWith('0x00000000')) {
      setCompletedTxHash(txHash)
      setStatus(
        unshieldToNative
          ? 'Unshield to ETH successful! Submit PPOI to make remaining funds spendable.'
          : 'Unshield successful! Submit PPOI to make remaining funds spendable.'
      )
      setPoiStatus('pending')
      setPoiError(null)
    }
    onSuccess?.(txHash)
  }

  /**
   * Dispatch the transaction based on the detected transaction path.
   */
  const executeSend = async () => {
    try {
      setBusy(true)
      setError('')
      setStatus('')
      setSuggestionDisplay(null)
      setCompletedTxHash('')
      setPoiStatus(null)
      setBalancesRefreshed(false)

      switch (transactionPath) {
        case 'public-transfer':
          await executePublicTransfer()
          break
        case 'shield':
          await executeShield()
          break
        case 'private-send':
          await executePrivateSend()
          break
        case 'unshield':
          await executeUnshield()
          break
      }
    } catch (err: unknown) {
      setIsWaitingForConfirmation(false)
      const rawMsg = err instanceof Error ? err.message : 'Transaction failed'
      const msg = formatTransactionError(rawMsg)
      setError(msg)

      // Try to extract amount suggestion
      const match = /Try amount:\s*(\d+)\.?/.exec(msg)
      if (match && match[1]) {
        try {
          const tokenInfo = await TokenService.getInstance().getTokenInfo(
            selectedToken,
            currentNetwork as NetworkName
          )
          setSuggestionDisplay(ethers.formatUnits(match[1], tokenInfo.decimals))
        } catch {
          /* ignore */
        }
      } else {
        onError?.(msg)
      }
    } finally {
      setBusy(false)
    }
  }

  /**
   * Handle form submission by validating inputs and executing the transaction.
   * @param e - The form submit event
   */
  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedToken || !amount || !toAddress || transactionPath === 'undetermined') return
    await executeSend()
  }

  /**
   * Refresh wallet balances after a transaction to sync new data before PPOI submission.
   */
  const handleRefreshBalances = async () => {
    if (!currentWallet || !currentNetwork) return
    setIsRefreshingBalances(true)
    try {
      await refreshBalances()
      setBalancesRefreshed(true)
    } catch (err: unknown) {
      setPoiError('Failed to refresh balances: ' + (err instanceof Error ? err.message : 'Unknown error'))
    } finally {
      setIsRefreshingBalances(false)
    }
  }

  /**
   * Generate and submit a PPOI proof for the completed transaction.
   */
  const handleSubmitPOI = async () => {
    if (!currentWallet || !currentNetwork || !completedTxHash) return
    setPoiStatus('submitting')
    setPoiError(null)

    try {
      const txHistoryService = TransactionHistoryService.getInstance()
      const scanner = SubsquidBalanceScanner.getInstance()

      // Same approach as Balances page: fetch transaction history, find the
      // matching transaction, and call generatePOIProofForTransaction.
      const historyResult = await txHistoryService.getTransactionHistory(
        currentWallet,
        currentNetwork as NetworkName,
        scanner,
        0,
        100
      )

      const transaction = historyResult.transactions.find(
        (tx) => tx.txid.toLowerCase() === completedTxHash.toLowerCase()
      )

      if (!transaction) {
        setPoiStatus('error')
        setPoiError('Could not find transaction in history. Try refreshing balances first.')
        return
      }

      const result = await txHistoryService.generatePOIProofForTransaction(
        transaction,
        currentNetwork as NetworkName,
        currentWallet
      )

      if (result.success) {
        setPoiStatus('success')
        setStatus('PPOI submitted successfully! Check status on the History page.')
      } else {
        setPoiStatus('error')
        setPoiError(result.error || 'Failed to submit PPOI')
      }
    } catch (err: unknown) {
      setPoiStatus('error')
      setPoiError(err instanceof Error ? err.message : 'Failed to submit PPOI')
    }
  }

  /**
   * Copy the given text to the system clipboard.
   * @param text - The text string to copy
   */
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
  }

  // --- Action Button Logic ---
  const needsApproval =
    transactionPath === 'shield' &&
    selectedToken !== '0x0000000000000000000000000000000000000000' &&
    selectedToken !== '' &&
    !approvalStatus.isApproved

  // Check if the entered amount exceeds the spendable (PPOI-valid) balance for private sends/unshields
  const exceedsSpendable = useMemo(() => {
    if (fromType !== '0zk' || !selectedToken || !amount || selectedTokenSpendable === undefined) { return false }
    if (!selectedTokenBalance) return false
    const amountNum = parseFloat(amount)
    if (amountNum <= 0 || isNaN(amountNum)) return false
    try {
      const amountWei = ethers.parseUnits(amount, selectedTokenBalance.decimals)
      return amountWei > selectedTokenSpendable
    } catch {
      return false
    }
  }, [fromType, selectedToken, amount, selectedTokenSpendable, selectedTokenBalance])

  // Check if the selected token has zero spendable balance (all pending PPOI)
  const hasNoSpendable =
    fromType === '0zk' &&
    selectedTokenSpendable !== undefined &&
    selectedTokenSpendable === 0n &&
    selectedToken !== ''

  /**
   * Determine the label text for the main action button based on current form state.
   * @returns The appropriate button label string
   */
  const getActionButtonLabel = (): string => {
    if (busy) return 'Processing...'
    if (!selectedToken || !amount) return 'Enter an Amount'
    if (!toAddress) return 'Enter Recipient'
    if (transactionPath === 'undetermined') return 'Enter 0zk or 0x Address'

    // Block private spends when PPOI is missing
    if (hasNoSpendable && (transactionPath === 'private-send' || transactionPath === 'unshield')) {
      return 'PPOI Required'
    }
    if (
      exceedsSpendable &&
      (transactionPath === 'private-send' || transactionPath === 'unshield')
    ) {
      return 'Exceeds Spendable Balance'
    }

    if (transactionPath === 'shield') {
      if (isApproving) return 'Approving...'
      if (approvalStatus.isChecking) return 'Checking Approval...'
      if (needsApproval) {
        const symbol =
          availableTokens.find((t) => t.tokenAddress === selectedToken)?.symbol ?? 'Token'
        return `Approve ${symbol}`
      }
      if (!canShield) return 'Token Cannot Be Sent'
      return 'Send'
    }

    if (transactionPath === 'public-transfer') return 'Send'
    if (transactionPath === 'private-send') return 'Send Privately'
    if (transactionPath === 'unshield') return 'Unshield'
    return 'Send'
  }

  const isApprovalAction =
    transactionPath === 'shield' && needsApproval && !approvalStatus.isChecking && !isApproving

  const isSubmitDisabled =
    !selectedToken ||
    !amount ||
    !toAddress ||
    transactionPath === 'undetermined' ||
    busy ||
    isSyncing ||
    isApproving ||
    (transactionPath === 'shield' && approvalStatus.isChecking) ||
    (transactionPath === 'shield' && needsApproval) ||
    (transactionPath === 'shield' && !canShield) ||
    ((transactionPath === 'private-send' || transactionPath === 'unshield') &&
      (hasNoSpendable || exceedsSpendable))

  // --- Render ---

  if (!currentWallet) {
    return (
      <div className='shield-card'>
        <div className='shield-placeholder'>
          <div className='shield-placeholder-icon'>&#x1f512;</div>
          <h3>Connect Wallet to Send Tokens</h3>
          <p>Connect a wallet to send tokens.</p>
        </div>
      </div>
    )
  }

  const showGasWallet = transactionPath === 'private-send' || transactionPath === 'unshield'

  return (
    <div className='shield-card'>
      {/* Header */}
      <div className='shield-card-header'>
        <h3 className='shield-card-title'>Send</h3>
        {transactionPath !== 'undetermined' && (
          <div className='shield-flow-badge'>
            <span>{PATH_ICONS[transactionPath]}</span>
            <span>{PATH_LABELS[transactionPath]}</span>
          </div>
        )}
      </div>

      <form onSubmit={onSubmit}>
        {/* FROM Panel */}
        <div className='shield-panel'>
          <div className='shield-panel-label'>From</div>

          <div className='from-display'>
            <span className='from-display-label'>{walletNickname}</span>
            <ColoredAddress address={fromAddress} maxLen={16} />
          </div>

          <div className='shield-token-amount-row'>
            <select
              className='shield-token-select'
              value={selectedToken}
              onChange={(e) => setSelectedToken(e.target.value)}
              required
            >
              <option value=''>Select token</option>
              {availableTokens.map((balance: any) => {
                const hasSpendable =
                  fromType !== '0zk' ||
                  (balance.spendableBalance !== undefined && balance.spendableBalance > 0n)
                return (
                  <option key={balance.tokenAddress} value={balance.tokenAddress}>
                    {balance.symbol}
                    {fromType === '0zk' && !hasSpendable ? ' (not spendable)' : ''}
                  </option>
                )
              })}
            </select>

            <input
              className='shield-amount-input'
              type='number'
              step='any'
              min='0'
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder='0'
              required
            />
          </div>

          <div className='shield-balance-row'>
            <span className='shield-balance-text'>
              {selectedTokenBalance
                ? fromType === '0zk' &&
                  selectedTokenSpendable !== undefined &&
                  selectedTokenSpendable < selectedTokenBalance.balance
                  ? `Spendable: ${formatBalance(selectedTokenSpendable, selectedTokenBalance.decimals)} / Total: ${formatBalance(selectedTokenBalance.balance, selectedTokenBalance.decimals)}`
                  : `Balance: ${formatBalance(selectedTokenBalance.balance, selectedTokenBalance.decimals)}`
                : 'Select a token'}
            </span>
            {selectedToken && selectedTokenBalance && (
              <button
                type='button'
                className='shield-max-btn'
                onClick={() => {
                  // For private balances, MAX should be the spendable amount, not total
                  const maxAmount =
                    fromType === '0zk' && selectedTokenSpendable !== undefined
                      ? selectedTokenSpendable
                      : selectedTokenBalance.balance
                  setAmount(formatBalance(maxAmount, selectedTokenBalance.decimals))
                }}
              >
                MAX
              </button>
            )}
          </div>
        </div>

        {/* Direction Indicator */}
        <div className='shield-direction'>
          <div className='shield-direction-icon'>{PATH_ICONS[transactionPath]}</div>
        </div>

        {/* TO Panel */}
        <div className='shield-panel'>
          <div className='shield-panel-label'>To</div>
          <div className='recipient-combo' ref={recipientDropdownRef}>
            <div className='recipient-input-row'>
              <input
                className='shield-recipient-input'
                type='text'
                value={toAddress}
                onChange={(e) => {
                  setToAddress(e.target.value)
                  setShowRecipientDropdown(false)
                }}
                placeholder='0x... or 0zk...'
                required
              />
              {recipientOptions.length > 0 && (
                <button
                  type='button'
                  className='recipient-dropdown-toggle'
                  onClick={() => setShowRecipientDropdown(!showRecipientDropdown)}
                  title='Select from local wallets'
                >
                  <svg
                    width='14'
                    height='14'
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2.5'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                  >
                    <polyline
                      points={showRecipientDropdown ? '18,15 12,9 6,15' : '6,9 12,15 18,9'}
                    />
                  </svg>
                </button>
              )}
            </div>
            {showRecipientDropdown && recipientOptions.length > 0 && (
              <div className='addr-dropdown'>
                {recipientOptions.map((opt, i) => (
                  <button
                    key={`${opt.type}-${opt.walletId}-${i}`}
                    type='button'
                    className={`addr-dropdown-item ${opt.address === toAddress ? 'selected' : ''}`}
                    onClick={() => {
                      setToAddress(opt.address)
                      setShowRecipientDropdown(false)
                    }}
                  >
                    <span className='addr-dropdown-name'>{opt.label}</span>
                    <ColoredAddress address={opt.address} maxLen={14} />
                  </button>
                ))}
              </div>
            )}
          </div>
          {toType !== 'unknown' && (
            <div className='send-to-badge-row'>
              <span className={`send-from-badge ${toType === '0zk' ? 'private' : 'public'}`}>
                {toType === '0zk' ? 'Private' : 'Public'}
              </span>
            </div>
          )}
          {transactionPath === 'undetermined' && toAddress.length > 0 && (
            <div className='shield-recipient-note'>
              Enter a 0zk address for private send/shield, or 0x address for public
              transfer/unshield
            </div>
          )}
        </div>

        {/* Memo field (private sends only) */}
        {transactionPath === 'private-send' && (
          <div className='shield-panel memo-panel'>
            <div className='shield-panel-label'>Memo (optional)</div>
            <input
              className='memo-input'
              type='text'
              value={memoText}
              onChange={(e) => {
                const bytes = new TextEncoder().encode(e.target.value)
                if (bytes.length <= 30) setMemoText(e.target.value)
              }}
              placeholder='Short message, e.g. invoice #1234'
              disabled={busy}
            />
            <div className='memo-byte-count'>
              {new TextEncoder().encode(memoText).length}/30 bytes
            </div>
          </div>
        )}

        {/* Unshield to ETH option (when unshielding WETH) */}
        {showUnshieldToNativeOption && (
          <div className='shield-panel unshield-native-panel'>
            <div className='shield-panel-label'>Receive As</div>
            <div className='unshield-native-toggle'>
              <button
                type='button'
                className={`unshield-native-btn ${!unshieldToNative ? 'active' : ''}`}
                onClick={() => setUnshieldToNative(false)}
                disabled={busy}
              >
                WETH
              </button>
              <button
                type='button'
                className={`unshield-native-btn ${unshieldToNative ? 'active' : ''}`}
                onClick={() => setUnshieldToNative(true)}
                disabled={busy}
              >
                ETH
              </button>
            </div>
            {unshieldToNative && (
              <div className='unshield-native-note'>
                WETH will be unwrapped to native ETH. Gas costs are slightly higher.
              </div>
            )}
          </div>
        )}

        {/* Gas Wallet Selector (private paths only) */}
        {showGasWallet && (
          <div className='shield-panel'>
            <div className='shield-panel-label'>Gas Payment</div>
            <GasWalletSelector disabled={busy || isSyncing} showLabel={false} />
          </div>
        )}

        {/* Fee Summary Panel */}
        {transactionPath !== 'undetermined' &&
          selectedToken &&
          amount &&
          parseFloat(amount) > 0 && (
            <div className='shield-panel fee-summary-panel'>
              <div className='shield-panel-label'>Estimated Fees</div>

              {/* RAILGUN Protocol Fee (shield/unshield only) */}
              {protocolFeeAmount && (
                <div className='fee-summary-row'>
                  <span className='fee-label'>
                    RAILGUN {protocolFeeAmount.type} Fee ({protocolFeeAmount.percent}%)
                  </span>
                  <span className='fee-value'>
                    {protocolFeeAmount.amount} {selectedTokenBalance?.symbol || ''}
                  </span>
                </div>
              )}

              {/* Gas Fee */}
              <div className='fee-summary-row'>
                <span className='fee-label'>Estimated Gas</span>
                <span className='fee-value'>
                  {gasEstimate?.isEstimating
                    ? 'Estimating...'
                    : gasEstimate?.error
                      ? gasEstimate.error
                      : gasEstimate
                        ? `${gasEstimate.totalCostEth} ETH`
                        : '—'}
                </span>
              </div>

              {/* Gas Speed Selector */}
              <div className='gas-speed-selector'>
                {(['slow', 'standard', 'fast'] as GasSpeed[]).map((speed) => (
                  <button
                    key={speed}
                    type='button'
                    className={`gas-speed-btn ${gasSpeed === speed ? 'active' : ''}`}
                    onClick={() => setGasSpeed(speed)}
                  >
                    {GAS_MULTIPLIERS[speed].label}
                  </button>
                ))}
              </div>

              {/* Add Fee to Amount Toggle (shield/unshield only) */}
              {protocolFeeAmount &&
                (transactionPath === 'shield' || transactionPath === 'unshield') && (
                  <div className='fee-toggle-row'>
                    <label className='fee-toggle-label'>
                      <input
                        type='checkbox'
                        checked={addFeeToAmount}
                        onChange={(e) => setAddFeeToAmount(e.target.checked)}
                        className='fee-toggle-checkbox'
                      />
                      <span className='fee-toggle-text'>
                        {addFeeToAmount
                          ? `Add fee to input — sending ${adjustedAmount} so recipient receives ${amount}`
                          : 'Add fee to input amount'}
                      </span>
                    </label>
                  </div>
              )}
            </div>
        )}

        {/* Status Strips */}
        {error && <div className='shield-status-strip status-error'>{error}</div>}

        {isWaitingForConfirmation && !error && (
          <div className='shield-status-strip status-info'>
            Waiting for transaction confirmation...
          </div>
        )}

        {status && !error && !isWaitingForConfirmation && !completedTxHash && (
          <div className='shield-status-strip status-info'>{status}</div>
        )}

        {transactionPath === 'shield' && selectedToken && !canShield && !error && (
          <div className='shield-status-strip status-warn'>This token cannot be sent</div>
        )}

        {hasNoSpendable &&
          (transactionPath === 'private-send' || transactionPath === 'unshield') &&
          !error && (
            <div className='shield-status-strip status-warn'>
              This balance has no valid PPOI yet. Submit PPOI from the Balances tab to make funds
              spendable.
            </div>
        )}

        {exceedsSpendable &&
          !hasNoSpendable &&
          (transactionPath === 'private-send' || transactionPath === 'unshield') &&
          !error &&
          selectedTokenBalance &&
          selectedTokenSpendable !== undefined && (
            <div className='shield-status-strip status-warn'>
              Amount exceeds spendable balance. Only{' '}
              {formatBalance(selectedTokenSpendable, selectedTokenBalance.decimals)}{' '}
              {selectedTokenBalance.symbol} has valid PPOI.
            </div>
        )}

        {transactionPath === 'shield' &&
          canShield &&
          approvalStatus.isApproved &&
          !error &&
          amount && <div className='shield-status-strip status-ok'>Ready to send</div>}

        {suggestionDisplay && (
          <div className='shield-status-strip status-warn'>
            Suggested amount: {suggestionDisplay}
            <button
              type='button'
              className='suggestion-use-btn'
              onClick={() => {
                setAmount(suggestionDisplay)
                setSuggestionDisplay(null)
              }}
            >
              Use
            </button>
          </div>
        )}

        {/* Post-Transaction Result */}
        {completedTxHash && (
          <div className='private-tx-result'>
            <label>Transaction Hash</label>
            <div className='private-tx-hash-display'>
              <code className='private-tx-hash'>{completedTxHash}</code>
              <button
                type='button'
                className='private-tx-copy-btn'
                onClick={() => copyToClipboard(completedTxHash)}
              >
                Copy
              </button>
            </div>

            {getBlockExplorerUrl(currentNetwork as NetworkName, completedTxHash) && (
              <a
                href={getBlockExplorerUrl(currentNetwork as NetworkName, completedTxHash)!}
                target='_blank'
                rel='noopener noreferrer'
                className='private-tx-explorer'
              >
                View on Block Explorer
              </a>
            )}

            {status && <div className='shield-status-strip status-ok'>{status}</div>}

            {/* PPOI Section (private send and unshield) */}
            {(transactionPath === 'private-send' || transactionPath === 'unshield') &&
              poiStatus &&
              poiStatus !== 'success' && (
                <div className='private-tx-poi'>
                  {!balancesRefreshed
                    ? (
                      <>
                        <button
                          type='button'
                          className='shield-action-btn btn-secondary'
                          onClick={handleRefreshBalances}
                          disabled={isRefreshingBalances}
                        >
                          {isRefreshingBalances
                            ? 'Refreshing Balances...'
                            : 'Step 1: Refresh Balances'}
                        </button>
                        <div className='private-tx-poi-hint'>
                          Refresh balances to sync the new transaction before submitting PPOI.
                        </div>
                      </>
                      )
                    : (
                      <>
                        <button
                          type='button'
                          className='shield-action-btn btn-secondary'
                          onClick={handleSubmitPOI}
                          disabled={poiStatus === 'submitting'}
                        >
                          {poiStatus === 'submitting' ? 'Submitting PPOI...' : 'Step 2: Submit PPOI'}
                        </button>
                        <div className='private-tx-poi-hint'>
                          Submit Private Proof of Innocence to make funds spendable.
                        </div>
                      </>
                      )}
                  {poiStatus === 'error' && poiError && (
                    <div className='shield-status-strip status-error'>{poiError}</div>
                  )}
                </div>
            )}

            {poiStatus === 'success' && !status && (
              <div className='shield-status-strip status-ok'>
                PPOI submitted successfully! Check status on the History page.
              </div>
            )}
          </div>
        )}

        {/* Action Button */}
        {!completedTxHash &&
          (isApprovalAction
            ? (
              <button
                type='button'
                className='shield-action-btn needs-approval'
                onClick={handleApproveToken}
                disabled={isSyncing || isApproving}
              >
                {getActionButtonLabel()}
              </button>
              )
            : (
              <button
                type='submit'
                className={`shield-action-btn ${busy ? 'processing' : ''}`}
                disabled={isSubmitDisabled}
              >
                {getActionButtonLabel()}
              </button>
              ))}
      </form>
    </div>
  )
}
