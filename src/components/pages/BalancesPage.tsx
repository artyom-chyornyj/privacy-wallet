import React, { useCallback, useEffect, useState } from 'react'

import { AddTokenModal } from '@/components/modals/AddTokenModal'
import { SubsquidBalanceScanner } from '@/services/SubsquidBalanceScanner'
import { TokenService } from '@/services/TokenService'
import { TransactionHistoryService } from '@/services/TransactionHistoryService'
import { useWalletStore } from '@/stores/walletStore'
import type { NetworkName } from '@/types/network'
import { BalanceBucket } from '@/types/network'
import type { DecryptedCommitment } from '@/types/wallet'
import './BalancesPage.css'
import { dlog, dwarn } from '@/utils/debug'

// Commitment with its PPOI status for display
interface CommitmentWithStatus {
  commitment: DecryptedCommitment
  poiStatus: 'valid' | 'invalid' | 'pending' | 'missing' | 'unknown'
  bucket: BalanceBucket
  isSpent: boolean
}

// Token balance grouped with individual commitments
interface TokenBalanceGroup {
  tokenAddress: string
  symbol: string
  decimals: number
  totalBalance: bigint
  spendableBalance: bigint
  pendingBalance: bigint
  commitments: CommitmentWithStatus[]
  spentCommitments: CommitmentWithStatus[]
  hasActionRequired: boolean // True if any commitment needs user action (missing PPOI)
}

// Renders a single commitment item (active or spent)
/**
 * Renders a single commitment item with its PPOI status, proof actions, and balance details.
 * @param root0 - Component props object
 * @param root0.commitmentWithStatus - The commitment data with its current PPOI status and bucket
 * @param root0.group - Token group containing decimals and symbol for display formatting
 * @param root0.submittingProof - Hash of the commitment currently having its proof submitted, or null
 * @param root0.proofProgress - Progress message for the current proof submission
 * @param root0.proofSubmittedHashes - Set of commitment hashes that have had proofs submitted
 * @param root0.checkingPPOIHash - Hash of the commitment currently being checked for PPOI status, or null
 * @param root0.isCheckingPOI - Whether a PPOI status check is currently in progress
 * @param root0.spentExplanation - Optional explanation text for why a spent commitment still needs PPOI
 * @param root0.onSubmitProof - Callback to submit a PPOI proof for a commitment
 * @param root0.onCheckSubmittedPPOI - Callback to check PPOI status after proof submission
 * @param root0.onCheckPPOI - Callback to check the PPOI status of a commitment
 * @param root0.getBucketLabel - Function that returns label and description for a balance bucket
 * @param root0.formatBalance - Function that formats a bigint balance with the given decimals
 * @returns The rendered commitment item element with status badge and action buttons
 */
const CommitmentItem: React.FC<{
  commitmentWithStatus: CommitmentWithStatus
  group: { decimals: number; symbol: string }
  submittingProof: string | null
  proofProgress: string
  proofSubmittedHashes: Set<string>
  checkingPPOIHash: string | null
  isCheckingPOI: boolean
  spentExplanation?: string
  onSubmitProof: (c: CommitmentWithStatus) => void
  onCheckSubmittedPPOI: (c: CommitmentWithStatus) => void
  onCheckPPOI: (c: CommitmentWithStatus) => void
  getBucketLabel: (bucket: BalanceBucket) => { label: string; description: string }
  formatBalance: (balance: bigint, decimals: number) => string
}> = ({
  commitmentWithStatus,
  group,
  submittingProof,
  proofProgress,
  proofSubmittedHashes,
  checkingPPOIHash,
  isCheckingPOI,
  spentExplanation,
  onSubmitProof,
  onCheckSubmittedPPOI,
  onCheckPPOI,
  getBucketLabel,
  formatBalance,
}) => {
  const { commitment, bucket, isSpent } = commitmentWithStatus
  const bucketInfo = getBucketLabel(bucket)
  const isSubmitting = submittingProof === commitment.hash
  const hasSubmittedProof = proofSubmittedHashes.has(commitment.hash)
  const canSubmitProof = bucket === BalanceBucket.MissingInternalPOI && !hasSubmittedProof
  const canCheckPPOI = bucket === BalanceBucket.ShieldPending || bucket === BalanceBucket.Unknown
  const isCheckingThis = checkingPPOIHash === commitment.hash

  const displayBucket =
    hasSubmittedProof && bucket === BalanceBucket.MissingInternalPOI
      ? BalanceBucket.ProofSubmitted
      : bucket
  const displayBucketInfo =
    hasSubmittedProof && bucket === BalanceBucket.MissingInternalPOI
      ? {
          label: 'Proof submitted',
          description:
            'Your proof has been submitted to the PPOI node. Check the status to confirm it has been validated.',
        }
      : bucketInfo

  const descriptionText = spentExplanation || displayBucketInfo.description
  const descriptionClass = spentExplanation
    ? 'status-description spent-explanation'
    : 'status-description'

  return (
    <div className={`commitment-item${isSpent ? ' spent' : ''}`}>
      <div className='commitment-main'>
        <div className={`commitment-value${isSpent ? ' spent-value' : ''}`}>
          {formatBalance(commitment.value, group.decimals)} {group.symbol}
        </div>
        <div className={`commitment-status ${displayBucket.toLowerCase()}`}>
          {displayBucketInfo.label}
        </div>
      </div>

      <div className='commitment-details'>
        <div className='commitment-type'>
          <span className='label'>Type:</span>
          <span>{commitment.commitmentType.replace('Commitment', '')}</span>
        </div>
        {isSpent && <span className='spent-badge'>Spent</span>}
      </div>

      {displayBucket !== BalanceBucket.Spendable && (
        <div className='commitment-action-area'>
          <p className={descriptionClass}>{descriptionText}</p>

          {canSubmitProof && (
            <div className='proof-action'>
              {isSubmitting
                ? (
                  <div className='proof-progress'>
                    <div className='spinner' />
                    <span>{proofProgress}</span>
                  </div>
                  )
                : (
                  <button
                    className='submit-proof-btn'
                    onClick={(e) => {
                      e.stopPropagation()
                      onSubmitProof(commitmentWithStatus)
                    }}
                    disabled={!!submittingProof}
                  >
                    Submit Proof
                  </button>
                  )}
            </div>
          )}

          {hasSubmittedProof && bucket === BalanceBucket.MissingInternalPOI && (
            <div className='proof-action'>
              <button
                className='check-ppoi-btn'
                onClick={(e) => {
                  e.stopPropagation()
                  onCheckSubmittedPPOI(commitmentWithStatus)
                }}
                disabled={isCheckingThis}
              >
                {isCheckingThis ? 'Checking...' : 'Check PPOI Status'}
              </button>
            </div>
          )}

          {canCheckPPOI && (
            <div className='proof-action'>
              <button
                className='check-ppoi-btn'
                onClick={(e) => {
                  e.stopPropagation()
                  onCheckPPOI(commitmentWithStatus)
                }}
                disabled={isCheckingThis || isCheckingPOI}
              >
                {isCheckingThis ? 'Checking...' : 'Check PPOI'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Main balances page component that displays private and public token balances with PPOI status management.
 * @returns The rendered balances page with token groups, commitment details, and PPOI proof actions
 */
export const BalancesPage: React.FC = () => {
  const {
    refreshBalances,
    balanceMode,
    isSyncing,
    currentWallet,
    currentNetwork,
    loadWalletScopedState,
    lastBalanceUpdate,
    commitmentPOIStatus,
    isCheckingPOI,
    poiCheckProgress,
    getUncheckedPOICount,
    checkAllCommitmentPOI,
    checkSingleCommitmentPOI,
    clearCommitmentPOIStatus,
  } = useWalletStore()

  const [expandedTokens, setExpandedTokens] = useState<Set<string>>(new Set())
  const [tokenGroups, setTokenGroups] = useState<TokenBalanceGroup[]>([])
  const [submittingProof, setSubmittingProof] = useState<string | null>(null) // commitment hash being submitted
  const [proofProgress, setProofProgress] = useState<string>('')
  const [isSubmittingAll, setIsSubmittingAll] = useState(false)
  const [submitAllProgress, setSubmitAllProgress] = useState<string>('')
  const [checkingPPOIHash, setCheckingPPOIHash] = useState<string | null>(null)
  // Track commitments that have had proofs submitted (waiting for PPOI node confirmation)
  const [proofSubmittedHashes, setProofSubmittedHashes] = useState<Set<string>>(new Set())
  const [showAddToken, setShowAddToken] = useState(false)

  // Load commitments and compute token groups
  const loadTokenGroups = useCallback(async () => {
    if (!currentWallet || !currentNetwork || balanceMode !== 'private') {
      setTokenGroups([])
      return
    }

    const scanner = SubsquidBalanceScanner.getInstance()
    const tokenService = TokenService.getInstance()

    const allCommitments = scanner.getDecryptedCommitmentsForWallet(currentWallet.id)
    const unspentCommitments = allCommitments.filter((c) => !c.isSpent && !c.isSentToOther)
    const spentCommitments = allCommitments.filter((c) => c.isSpent)

    // If scanner has no commitments, fall back to cached balances from the store
    if (unspentCommitments.length === 0 && spentCommitments.length === 0) {
      const cachedBalances = useWalletStore.getState().balances
      if (cachedBalances.length > 0) {
        const fallbackMap = new Map<string, TokenBalanceGroup>()
        for (const b of cachedBalances) {
          if (b.balance <= 0n) continue
          const key = b.tokenAddress.toLowerCase()
          const existing = fallbackMap.get(key)
          if (existing) {
            existing.totalBalance += b.balance
            if (b.balanceBucket === 'Spendable') {
              existing.spendableBalance += b.balance
            } else {
              existing.pendingBalance += b.balance
            }
          } else {
            fallbackMap.set(key, {
              tokenAddress: b.tokenAddress,
              symbol: b.symbol,
              decimals: b.decimals,
              totalBalance: b.balance,
              spendableBalance: b.balanceBucket === 'Spendable' ? b.balance : 0n,
              pendingBalance: b.balanceBucket !== 'Spendable' ? b.balance : 0n,
              commitments: [],
              spentCommitments: [],
              hasActionRequired: false,
            })
          }
        }
        const fallbackGroups = Array.from(fallbackMap.values())
        fallbackGroups.sort((a, b) => (b.totalBalance > a.totalBalance ? 1 : -1))
        setTokenGroups(fallbackGroups)
        return
      }
    }

    // Group unspent by token address
    const groupMap = new Map<
      string,
      { unspent: CommitmentWithStatus[]; spent: CommitmentWithStatus[] }
    >()

    for (const commitment of unspentCommitments) {
      const tokenKey = commitment.tokenAddress.toLowerCase()
      if (!groupMap.has(tokenKey)) {
        groupMap.set(tokenKey, { unspent: [], spent: [] })
      }

      // Get PPOI status from shared store state
      const blindedCommitment = scanner.blindedCommitmentOf(commitment)
      const poiStatus = commitmentPOIStatus[blindedCommitment]?.status || 'unknown'
      const bucket = determineBucket(commitment, poiStatus)

      groupMap.get(tokenKey)!.unspent.push({
        commitment,
        poiStatus,
        bucket,
        isSpent: false,
      })
    }

    // Group spent commitments that still need PPOI
    for (const commitment of spentCommitments) {
      const tokenKey = commitment.tokenAddress.toLowerCase()
      if (!groupMap.has(tokenKey)) {
        groupMap.set(tokenKey, { unspent: [], spent: [] })
      }

      const blindedCommitment = scanner.blindedCommitmentOf(commitment)
      const poiStatus = commitmentPOIStatus[blindedCommitment]?.status || 'unknown'
      const bucket = determineBucket(commitment, poiStatus)

      groupMap.get(tokenKey)!.spent.push({
        commitment,
        poiStatus,
        bucket,
        isSpent: true,
      })
    }

    // Convert to TokenBalanceGroup array
    const groups: TokenBalanceGroup[] = []

    for (const [tokenAddress, { unspent: unspentGroup, spent: spentGroup }] of groupMap) {
      const firstCommitment = unspentGroup[0]?.commitment || spentGroup[0]?.commitment
      if (!firstCommitment) continue

      // Fetch token info (async)
      let symbol = 'UNKNOWN'
      let decimals = 18
      try {
        const tokenInfo = await tokenService.getTokenInfo(
          tokenAddress,
          currentNetwork as NetworkName
        )
        symbol = tokenInfo?.symbol || 'UNKNOWN'
        decimals = tokenInfo?.decimals || 18
      } catch (e) {
        dwarn(`Failed to get token info for ${tokenAddress}:`, e)
      }

      let totalBalance = 0n
      let spendableBalance = 0n
      let pendingBalance = 0n
      let hasActionRequired = false

      for (const { commitment, bucket } of unspentGroup) {
        totalBalance += commitment.value

        if (bucket === BalanceBucket.Spendable) {
          spendableBalance += commitment.value
        } else {
          pendingBalance += commitment.value
        }

        // Check if user action is required (only internal PPOI can be submitted by this wallet)
        if (bucket === BalanceBucket.MissingInternalPOI) {
          hasActionRequired = true
        }
      }

      // Spent commitments needing PPOI also require action
      if (spentGroup.some((c) => c.bucket === BalanceBucket.MissingInternalPOI)) {
        hasActionRequired = true
      }

      groups.push({
        tokenAddress,
        symbol,
        decimals,
        totalBalance,
        spendableBalance,
        pendingBalance,
        commitments: unspentGroup,
        spentCommitments: spentGroup,
        hasActionRequired,
      })
    }

    // Sort by total balance (descending)
    groups.sort((a, b) => (b.totalBalance > a.totalBalance ? 1 : -1))

    setTokenGroups(groups)
  }, [currentWallet, currentNetwork, balanceMode, commitmentPOIStatus])

  // Determine balance bucket based on commitment type and PPOI status
  /**
   * Determines the balance bucket category for a commitment based on its type and PPOI validation status.
   * @param commitment - The decrypted commitment to categorize
   * @param poiStatus - The current PPOI status string for the commitment
   * @returns The appropriate balance bucket classification
   */
  function determineBucket (commitment: DecryptedCommitment, poiStatus: string): BalanceBucket {
    const isShield = commitment.commitmentType === 'ShieldCommitment'

    if (poiStatus === 'valid') {
      return BalanceBucket.Spendable
    }

    if (poiStatus === 'invalid') {
      return BalanceBucket.ShieldBlocked
    }

    if (poiStatus === 'pending') {
      return BalanceBucket.ProofSubmitted
    }

    if (poiStatus === 'unknown') {
      // Status hasn't been checked yet — show as Unknown until user checks
      if (isShield) {
        return BalanceBucket.ShieldPending
      }
      return BalanceBucket.Unknown
    }

    if (poiStatus === 'missing') {
      if (isShield) {
        return BalanceBucket.ShieldPending
      }
      return BalanceBucket.MissingInternalPOI
    }

    return BalanceBucket.ShieldPending
  }

  // Handle PPOI proof submission for a commitment
  /**
   * Generates and submits a PPOI proof for a single commitment by finding its transaction and calling the proof service.
   * @param commitmentWithStatus - The commitment with its current PPOI status to generate a proof for
   */
  const handleSubmitProof = async (commitmentWithStatus: CommitmentWithStatus) => {
    if (!currentWallet || !currentNetwork) return

    const { commitment } = commitmentWithStatus
    setSubmittingProof(commitment.hash)
    setProofProgress('Preparing proof generation...')

    try {
      const transactionHistoryService = TransactionHistoryService.getInstance()

      // Build a minimal DetailedTransaction for PPOI submission
      setProofProgress('Building transaction data...')

      // Get the transaction for this commitment
      const scanner = SubsquidBalanceScanner.getInstance()
      const result = await transactionHistoryService.getTransactionHistory(
        currentWallet,
        currentNetwork as NetworkName,
        scanner,
        0,
        100
      )

      // Find the transaction containing this commitment
      const transaction = result.transactions.find((tx) => tx.txid === commitment.txid)

      if (!transaction) {
        throw new Error('Could not find transaction for this commitment')
      }

      setProofProgress('Generating SNARK proof (this may take a moment)...')

      const generateResult = await transactionHistoryService.generatePOIProofForTransaction(
        transaction,
        currentNetwork as NetworkName,
        currentWallet
      )

      if (generateResult.success) {
        setProofProgress('Proof submitted!')

        // Clear the PPOI cache for this commitment so future checks are fresh
        const blindedCommitment = scanner.blindedCommitmentOf(commitment)
        clearCommitmentPOIStatus(blindedCommitment)

        // Track this commitment as having a submitted proof
        setProofSubmittedHashes((prev) => new Set(prev).add(commitment.hash))

        // Clear submission state after brief delay
        setTimeout(() => {
          setSubmittingProof(null)
          setProofProgress('')
        }, 1500)
      } else {
        throw new Error(generateResult.error || 'Failed to generate proof')
      }
    } catch (error) {
      dwarn('Error submitting PPOI proof:', error)
      setProofProgress(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`)

      setTimeout(() => {
        setSubmittingProof(null)
        setProofProgress('')
      }, 3000)
    }
  }

  // Check PPOI status for a single commitment and clear submitted tracking if now valid
  /**
   * Checks the PPOI status of a commitment that has had a proof submitted and clears the submitted tracking if now valid.
   * @param commitmentWithStatus - The commitment with its current PPOI status to check
   */
  const handleCheckSubmittedPPOI = async (commitmentWithStatus: CommitmentWithStatus) => {
    await handleCheckPPOI(commitmentWithStatus)
  }

  // Handle submitting PPOI proofs for ALL commitments with missing PPOI
  // This walks through commitments in chronological order (oldest first) to handle dependency chains
  // AND recursively resolves dependencies by finding source transactions for missing INPUT commitments
  /**
   * Submits PPOI proofs for all commitments with missing PPOI, resolving dependency chains by processing transactions in chronological order.
   */
  const handleSubmitAllMissingPOI = async () => {
    if (!currentWallet || !currentNetwork) return

    setIsSubmittingAll(true)
    setSubmitAllProgress('Scanning for commitments with missing PPOI...')

    const transactionHistoryService = TransactionHistoryService.getInstance()
    const scanner = SubsquidBalanceScanner.getInstance()

    // Get ALL decrypted commitments (including spent ones) to build dependency graph
    const allCommitments = scanner.getDecryptedCommitmentsForWallet(currentWallet.id)
    dlog(`Found ${allCommitments.length} total commitments in wallet`)

    // Get all transactions
    const result = await transactionHistoryService.getTransactionHistory(
      currentWallet,
      currentNetwork as NetworkName,
      scanner,
      0,
      200 // Get more transactions to find dependencies
    )

    // Build a map of commitment hash -> commitment data for dependency resolution
    const commitmentHashToData = new Map<string, DecryptedCommitment>()
    for (const c of allCommitments) {
      // Use the blinded commitment hash as key
      const blindedHash = scanner.blindedCommitmentOf(c)
      commitmentHashToData.set(blindedHash.toLowerCase(), c)
      // Also map by raw hash for fallback
      commitmentHashToData.set(c.hash.toLowerCase(), c)
    }

    // Build txid -> transaction mapping
    const txidToTransaction = new Map<string, (typeof result.transactions)[0]>()
    for (const tx of result.transactions) {
      txidToTransaction.set(tx.txid, tx)
    }

    // Collect all transactions that need PPOI (have missing PPOI commitments)
    // This includes both displayed "missing" commitments AND their source transactions
    const transactionsNeedingPOI = new Set<string>()
    const processedTxids = new Set<string>()

    // Start with commitments shown as missing in the UI (only internal — this wallet is the sender)
    for (const group of tokenGroups) {
      for (const { commitment, bucket } of group.commitments) {
        if (bucket === BalanceBucket.MissingInternalPOI) {
          transactionsNeedingPOI.add(commitment.txid)
        }
      }
    }

    // Recursively find source transactions for all INPUT commitments
    // This resolves the dependency chain
    /**
     * Recursively finds source transactions for spent input commitments to resolve the PPOI dependency chain.
     * @param txid - The transaction ID whose input dependencies should be traced
     * @param depth - Current recursion depth to prevent infinite loops
     */
    const findSourceTransactions = (txid: string, depth: number = 0): void => {
      if (depth > 10 || processedTxids.has(txid)) return // Prevent infinite loops
      processedTxids.add(txid)

      const tx = txidToTransaction.get(txid)
      if (!tx) return

      // For each spent INPUT commitment in this transaction, find its source transaction
      for (const blindedCommitment of tx.blindedCommitments) {
        if (blindedCommitment.isSpent) {
          // This is an INPUT - find which transaction CREATED this commitment
          const sourceCommitment = commitmentHashToData.get(
            blindedCommitment.commitment.toLowerCase()
          )
          if (sourceCommitment && sourceCommitment.txid && sourceCommitment.txid !== txid) {
            dlog(
              `Found dependency: tx ${txid.slice(0, 10)}... uses input from tx ${sourceCommitment.txid.slice(0, 10)}...`
            )
            transactionsNeedingPOI.add(sourceCommitment.txid)
            // Recursively check the source transaction's dependencies
            findSourceTransactions(sourceCommitment.txid, depth + 1)
          }
        }
      }
    }

    // Find all dependencies for transactions with missing PPOI
    setSubmitAllProgress('Resolving dependency chain...')
    for (const txid of Array.from(transactionsNeedingPOI)) {
      findSourceTransactions(txid)
    }

    dlog(`Total transactions needing PPOI (including dependencies): ${transactionsNeedingPOI.size}`)

    if (transactionsNeedingPOI.size === 0) {
      setSubmitAllProgress('No commitments with missing PPOI found.')
      setIsSubmittingAll(false)
      setTimeout(() => setSubmitAllProgress(''), 3000)
      return
    }

    // Build list of transactions to process, sorted by block number (oldest first)
    const transactionsToProcess: Array<{
      txid: string
      transaction: (typeof result.transactions)[0]
      blockNumber: number
    }> = []

    for (const txid of transactionsNeedingPOI) {
      const transaction = txidToTransaction.get(txid)
      if (transaction) {
        transactionsToProcess.push({
          txid,
          transaction,
          blockNumber: transaction.blockNumber || 0,
        })
      }
    }

    // Sort by block number (oldest first) - critical for dependency chains
    transactionsToProcess.sort((a, b) => a.blockNumber - b.blockNumber)

    setSubmitAllProgress(
      `Found ${transactionsToProcess.length} transactions to process (including dependencies)...`
    )

    let successCount = 0
    let failCount = 0
    let skippedCount = 0
    let dependencyFailures = 0

    const totalTxs = transactionsToProcess.length
    let processedTxs = 0

    // Track which transactions failed due to dependencies for potential retry
    const dependencyFailedTxids: string[] = []

    // Process all transactions in chronological order
    for (const { txid, transaction } of transactionsToProcess) {
      processedTxs++
      setSubmitAllProgress(
        `Processing ${processedTxs}/${totalTxs}: ${txid.slice(0, 10)}... (block ${transaction.blockNumber})`
      )

      // Check if this is a Shield transaction (PPOI is auto-generated by nodes)
      if (transaction.type === 'Shield') {
        dlog(`Transaction ${txid.slice(0, 10)}... is a Shield - PPOI auto-generated`)
        skippedCount++
        continue
      }

      try {
        const generateResult = await transactionHistoryService.generatePOIProofForTransaction(
          transaction,
          currentNetwork as NetworkName,
          currentWallet
        )

        if (generateResult.success) {
          successCount++
          dlog(`PPOI submitted for tx ${txid.slice(0, 10)}... (block ${transaction.blockNumber})`)
          // Track all commitments in this transaction as submitted
          const allWalletCommitments = scanner.getDecryptedCommitmentsForWallet(currentWallet.id)
          const txCommitments = allWalletCommitments.filter((c) => c.txid === txid)
          setProofSubmittedHashes((prev) => {
            const next = new Set(prev)
            for (const c of txCommitments) next.add(c.hash)
            return next
          })
          // Wait a bit for PPOI node to process before next submission
          await new Promise((resolve) => setTimeout(resolve, 1000))
        } else {
          // Check if it's a dependency issue
          const isDependencyIssue =
            generateResult.error?.includes('MISSING from PPOI tree') ||
            generateResult.error?.includes('INPUT commitments') ||
            generateResult.error?.includes('not found in PPOI') ||
            generateResult.error?.includes('No PPOI node for')

          if (isDependencyIssue) {
            dependencyFailures++
            dependencyFailedTxids.push(txid)
            dwarn(
              `Dependency issue for tx ${txid.slice(0, 10)}...: ${generateResult.error?.slice(0, 100)}`
            )
          } else {
            failCount++
            dwarn(`Failed for tx ${txid.slice(0, 10)}...: ${generateResult.error}`)
          }
        }

        // Small delay between submissions
        await new Promise((resolve) => setTimeout(resolve, 500))
      } catch (error) {
        dwarn(`Error processing tx ${txid}:`, error)
        failCount++
      }
    }

    // If we had dependency failures but also some successes, retry the failed ones
    // (the successful submissions might have resolved the dependencies)
    if (dependencyFailedTxids.length > 0 && successCount > 0) {
      setSubmitAllProgress(
        `Retrying ${dependencyFailedTxids.length} transactions after resolving dependencies...`
      )
      await new Promise((resolve) => setTimeout(resolve, 3000)) // Wait for PPOI nodes to process

      for (const txid of dependencyFailedTxids) {
        const item = transactionsToProcess.find((t) => t.txid === txid)
        if (!item?.transaction) continue

        setSubmitAllProgress(`Retrying: ${txid.slice(0, 10)}...`)

        try {
          const generateResult = await transactionHistoryService.generatePOIProofForTransaction(
            item.transaction,
            currentNetwork as NetworkName,
            currentWallet
          )

          if (generateResult.success) {
            successCount++
            dependencyFailures--
            dlog(`Retry succeeded for tx ${txid.slice(0, 10)}...`)
          }
        } catch (error) {
          // Keep the original failure count
        }

        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }

    // Show final summary
    let summary = ''
    if (successCount > 0) summary += `✅ ${successCount} submitted. `
    if (failCount > 0) summary += `❌ ${failCount} failed. `
    if (dependencyFailures > 0) { summary += `⏳ ${dependencyFailures} blocked (external dependency). ` }
    if (skippedCount > 0) summary += `⏭️ ${skippedCount} skipped (Shield).`

    setSubmitAllProgress(summary || 'Complete!')
    setIsSubmittingAll(false)

    // Refresh after a moment
    setTimeout(async () => {
      await loadTokenGroups()
      setSubmitAllProgress('')
    }, 4000)
  }

  // Check PPOI status for a single commitment (delegates to shared store action)
  /**
   * Checks the PPOI status for a single commitment by querying the PPOI node and updates the store state accordingly.
   * @param commitmentWithStatus - The commitment with its current status to check against the PPOI node
   */
  const handleCheckPPOI = async (commitmentWithStatus: CommitmentWithStatus) => {
    if (!currentWallet || !currentNetwork) return

    const { commitment } = commitmentWithStatus
    setCheckingPPOIHash(commitment.hash)

    try {
      const scanner = SubsquidBalanceScanner.getInstance()
      const blindedCommitment = scanner.blindedCommitmentOf(commitment)
      const commitmentType =
        commitment.commitmentType === 'ShieldCommitment' ? 'Shield' : 'Transact'
      await checkSingleCommitmentPOI(
        blindedCommitment,
        commitmentType as 'Shield' | 'Transact' | 'Unshield'
      )

      // If now valid, clear from submitted tracking
      const newStatus = useWalletStore.getState().commitmentPOIStatus[blindedCommitment]?.status
      if (newStatus === 'valid') {
        setProofSubmittedHashes((prev) => {
          const next = new Set(prev)
          next.delete(commitment.hash)
          return next
        })
      }
    } catch (error) {
      dwarn('Error checking PPOI status:', error)
    } finally {
      setCheckingPPOIHash(null)
    }
  }

  /**
   * Refreshes wallet balances by re-scanning and then reloading the token group display.
   */
  const handleRefreshBalances = async () => {
    await refreshBalances()
    await loadTokenGroups()
  }

  /**
   * Formats a bigint token balance into a human-readable decimal string truncated to 6 decimal places.
   * @param balance - The raw token balance as a bigint in smallest units
   * @param decimals - The number of decimal places for the token
   * @returns The formatted balance string with up to 6 decimal places
   */
  const formatBalance = (balance: bigint, decimals: number): string => {
    const divisor = BigInt(10 ** decimals)
    const wholePart = balance / divisor
    const fractionalPart = balance % divisor
    const fractionalStr = fractionalPart.toString().padStart(decimals, '0')
    return `${wholePart}.${fractionalStr.slice(0, 6)}`
  }

  /**
   * Toggles the expanded/collapsed state of a token's detail view in the balances list.
   * @param tokenAddress - The token contract address to toggle expansion for
   */
  const toggleTokenDetails = (tokenAddress: string) => {
    setExpandedTokens((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(tokenAddress)) {
        newSet.delete(tokenAddress)
      } else {
        newSet.add(tokenAddress)
      }
      return newSet
    })
  }

  /**
   * Copies the provided text to the system clipboard.
   * @param text - The text string to copy to the clipboard
   */
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch (err) {
      dwarn('Failed to copy:', err)
    }
  }

  /**
   * Formats a Unix timestamp into a human-readable relative time string (e.g. "5 minutes ago") or absolute date.
   * @param timestamp - The Unix timestamp in milliseconds to format
   * @returns A relative time string for recent timestamps or an absolute date string for older ones
   */
  const formatTimestamp = (timestamp: number): string => {
    const now = Date.now()
    const diff = now - timestamp

    if (diff < 60000) return 'just now'
    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000)
      return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
    }
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000)
      return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
    }
    return new Date(timestamp).toLocaleString()
  }

  // Get explanatory text for why a spent commitment still needs PPOI
  /**
   * Returns an explanation string describing why a spent commitment still requires PPOI proof submission.
   * @param commitment - The spent commitment to generate an explanation for
   * @returns A human-readable explanation of the PPOI requirement for the spent commitment
   */
  const getSpentExplanation = (commitment: DecryptedCommitment): string => {
    const isShield = commitment.commitmentType === 'ShieldCommitment'
    const outputType = commitment.outputType

    if (isShield) {
      return 'This shielded commitment has been spent, but still requires PPOI for compliance verification.'
    }

    // outputType: 0=Transfer, 1=Withdraw/Unshield, 2=Change
    if (outputType === 1) {
      return 'Spent — requires PPOI to prove valid status outside RAILGUN.'
    }

    // Transfer or Change (both are private sends)
    return 'Spent — requires PPOI to be spent by receiver.'
  }

  /**
   * Maps a balance bucket enum value to its display label and description text for the UI.
   * @param bucket - The balance bucket classification to get display information for
   * @returns An object containing the display label and description for the bucket
   */
  const getBucketLabel = (bucket: BalanceBucket): { label: string; description: string } => {
    switch (bucket) {
      case BalanceBucket.Spendable:
        return { label: 'Available', description: 'Ready to spend' }
      case BalanceBucket.ShieldPending:
        return { label: 'Pending proof', description: 'Awaiting innocence proof generation' }
      case BalanceBucket.ShieldBlocked:
        return { label: 'Blocked', description: 'Failed innocence verification' }
      case BalanceBucket.ProofSubmitted:
        return { label: 'Verifying', description: 'Proof submitted, awaiting verification' }
      case BalanceBucket.MissingInternalPOI:
        return {
          label: 'Missing proof',
          description: 'You need to submit the PPOI proof for this transaction',
        }
      case BalanceBucket.MissingExternalPOI:
        return {
          label: 'Waiting for sender',
          description: 'The sender of this transaction must submit their PPOI proof',
        }
      case BalanceBucket.Unknown:
        return {
          label: 'PPOI Unknown',
          description: 'Status has not been checked yet. Check status before submitting.',
        }
      case BalanceBucket.Spent:
        return { label: 'Spent', description: 'Balance already spent' }
      default:
        return { label: 'Unknown', description: 'Unknown status' }
    }
  }

  // Load cached state on mount
  useEffect(() => {
    if (!currentWallet || !currentNetwork) return
    loadWalletScopedState()
  }, [currentWallet, currentNetwork, balanceMode, loadWalletScopedState])

  // Load token groups when wallet state changes
  useEffect(() => {
    loadTokenGroups()
  }, [loadTokenGroups, lastBalanceUpdate])

  // For public balances, use the store's balances directly
  const publicBalances = useWalletStore((state) => state.balances)

  if (balanceMode === 'public') {
    // Render simplified public balance view
    return (
      <div className='balance-list-container'>
        <div className='balance-list-header'>
          <div>
            <div className='header-left'>
              <h3>Public Balances</h3>
              <span className='badge'>{publicBalances.length} tokens</span>
            </div>
          </div>
          <div className='header-actions'>
            <button onClick={() => setShowAddToken(true)} className='add-token-btn'>
              Add Token
            </button>
            <button onClick={handleRefreshBalances} className='refresh-btn' disabled={isSyncing}>
              {isSyncing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        </div>

        {lastBalanceUpdate && (
          <div className='update-info'>
            <span className='last-update-text'>
              Last updated: {formatTimestamp(lastBalanceUpdate)}
            </span>
          </div>
        )}

        {publicBalances.length === 0 && (
          <div className='empty-state'>
            <div className='empty-state-icon'>💰</div>
            <h4 className='empty-state-title'>No Balances</h4>
            <p className='empty-state-description'>No public balances found</p>
          </div>
        )}
        {publicBalances.length > 0 && (
          <div className='balance-table'>
            <div className='balance-table-header'>
              <div>Token</div>
              <div>Balance</div>
              <div />
            </div>
            <div className='balance-table-body'>
              {publicBalances.map((balance, index) => {
                const isCustom = TokenService.getInstance().isCustomToken(
                  balance.tokenAddress,
                  currentNetwork as NetworkName
                )
                const isNativeETH =
                  balance.tokenAddress === '0x0000000000000000000000000000000000000000'
                const isExpanded = expandedTokens.has(balance.tokenAddress)
                return (
                  <React.Fragment key={`${balance.tokenAddress}-${index}`}>
                    <div
                      className={`balance-row clickable ${isExpanded ? 'expanded' : ''}`}
                      onClick={() => toggleTokenDetails(balance.tokenAddress)}
                    >
                      <div className='balance-token'>{balance.symbol}</div>
                      <div className='balance-amount'>
                        {formatBalance(balance.balance, balance.decimals)}
                      </div>
                      <div />
                    </div>
                    {isExpanded && (
                      <div className='public-token-details'>
                        <div className='detail-row'>
                          <span>Address:</span>
                          <span className='detail-address'>
                            {balance.tokenAddress}
                            <button
                              className='icon-btn'
                              onClick={() => copyToClipboard(balance.tokenAddress)}
                              title='Copy address'
                            >
                              📋
                            </button>
                          </span>
                        </div>
                        <div className='detail-row'>
                          <span>Decimals:</span>
                          <span>{balance.decimals}</span>
                        </div>
                        <div className='detail-row'>
                          <span>Type:</span>
                          <span>
                            {isNativeETH ? 'Native' : isCustom ? 'Custom' : 'Built-in'}
                          </span>
                        </div>
                        {!isNativeETH && (
                          <button
                            className='remove-token-detail-btn'
                            onClick={async () => {
                              const store = useWalletStore.getState()
                              const tokenService = TokenService.getInstance()

                              if (isCustom) {
                                tokenService.removeCustomToken(
                                  balance.tokenAddress,
                                  currentNetwork as NetworkName
                                )
                              }

                              // Persist the hiding so it survives refresh/reload
                              if (store.currentWallet && store.sessionPassword) {
                                await tokenService.hideToken(
                                  balance.tokenAddress,
                                  store.currentWallet.id,
                                  currentNetwork as NetworkName,
                                  store.sessionPassword
                                )
                              }

                              // Remove from current balances list immediately
                              const filtered = store.balances.filter(
                                (b) => b.tokenAddress !== balance.tokenAddress
                              )
                              useWalletStore.setState({ balances: filtered })
                              setExpandedTokens((prev) => {
                                const next = new Set(prev)
                                next.delete(balance.tokenAddress)
                                return next
                              })
                            }}
                          >
                            Remove {balance.symbol}
                          </button>
                        )}
                      </div>
                    )}
                  </React.Fragment>
                )
              })}
            </div>
          </div>
        )}

        <AddTokenModal
          isOpen={showAddToken}
          onClose={() => setShowAddToken(false)}
          networkName={currentNetwork as NetworkName}
          onTokenAdded={() => refreshBalances()}
        />
      </div>
    )
  }

  // Private balance view with commitment details
  return (
    <div className='balance-list-container'>
      <div className='balance-list-header'>
        <div>
          <div className='header-left'>
            <button onClick={() => setShowAddToken(true)} className='add-token-btn'>
              Add Token
            </button>
          </div>
        </div>
        <div className='header-actions'>
          <button onClick={handleRefreshBalances} className='refresh-btn' disabled={isSyncing}>
            {isSyncing ? 'Refreshing...' : 'Refresh'}
          </button>
          {tokenGroups.some((g) =>
            g.commitments.some((c) => c.bucket === BalanceBucket.MissingInternalPOI)
          ) && (
            <button
              onClick={handleSubmitAllMissingPOI}
              className='submit-all-poi-btn'
              disabled={isSyncing || isSubmittingAll}
              title='Submit PPOI proofs for all commitments with missing PPOI'
            >
              {isSubmittingAll ? 'Submitting...' : 'Submit All PPOI'}
            </button>
          )}
          {(() => {
            const uncheckedCount = getUncheckedPOICount()
            if (uncheckedCount === 0) return null
            return (
              <button
                onClick={checkAllCommitmentPOI}
                className='check-ppoi-btn'
                disabled={isSyncing || isCheckingPOI}
                title={`Check PPOI status for ${uncheckedCount} unchecked commitments`}
              >
                {isCheckingPOI
                  ? poiCheckProgress.total > 0
                    ? `⏳ ${poiCheckProgress.checked}/${poiCheckProgress.total}`
                    : '⏳ Checking...'
                  : `🛡️ Check ${uncheckedCount} PPOI`}
              </button>
            )
          })()}
        </div>
      </div>

      {/* Submit All Progress Bar */}
      {submitAllProgress && (
        <div className='submit-all-progress'>
          <span>{submitAllProgress}</span>
        </div>
      )}

      {lastBalanceUpdate && (
        <div className='update-info'>
          <span className='last-update-text'>
            Last updated: {formatTimestamp(lastBalanceUpdate)}
          </span>
        </div>
      )}

      {tokenGroups.length === 0
        ? (
          <div className='empty-state'>
            <div className='empty-state-icon'>💰</div>
            <h4 className='empty-state-title'>No Balances</h4>
            <p className='empty-state-description'>No private balances found</p>
          </div>
          )
        : (
          <div className='balance-table'>
            <div className='balance-table-header'>
              <div>Token</div>
              <div>Amount</div>
              <div>Status</div>
            </div>
            <div className='balance-table-body'>
              {tokenGroups.map((group) => {
                const isExpanded = expandedTokens.has(group.tokenAddress)
                const isFullySpendable = group.spendableBalance === group.totalBalance
                const hasCommitments =
                group.commitments.length > 0 || group.spentCommitments.length > 0

                return (
                  <React.Fragment key={group.tokenAddress}>
                    <div
                      className={`balance-row ${isExpanded ? 'expanded' : ''}`}
                      onClick={() => hasCommitments && toggleTokenDetails(group.tokenAddress)}
                    >
                      <div className='balance-token'>{group.symbol}</div>
                      <div className='balance-amount'>
                        {formatBalance(group.totalBalance, group.decimals)}
                      </div>
                      <div className='balance-status'>
                        {isFullySpendable
                          ? (
                            <span className='status-badge spendable'>Available</span>
                            )
                          : (
                            <span className='status-badge pending'>
                              {formatBalance(group.pendingBalance, group.decimals)} pending
                            </span>
                            )}
                      </div>
                    </div>

                    {isExpanded && (
                      <div className='balance-details'>
                        <div className='commitment-list'>
                          <h4>Active Commitments ({group.commitments.length})</h4>
                          {group.commitments.map((cws) => (
                            <CommitmentItem
                              key={cws.commitment.hash}
                              commitmentWithStatus={cws}
                              group={group}
                              submittingProof={submittingProof}
                              proofProgress={proofProgress}
                              proofSubmittedHashes={proofSubmittedHashes}
                              checkingPPOIHash={checkingPPOIHash}
                              isCheckingPOI={isCheckingPOI}
                              onSubmitProof={handleSubmitProof}
                              onCheckSubmittedPPOI={handleCheckSubmittedPPOI}
                              onCheckPPOI={handleCheckPPOI}
                              getBucketLabel={getBucketLabel}
                              formatBalance={formatBalance}
                            />
                          ))}
                        </div>

                        {group.spentCommitments.length > 0 && (
                          <div className='commitment-list spent-commitments-section'>
                            <h4>Spent Commitments ({group.spentCommitments.length})</h4>
                            {group.spentCommitments.some(
                              (c) => c.bucket !== BalanceBucket.Spendable
                            )
                              ? (
                                <p className='spent-commitments-info'>
                                  These commitments have been spent but still require PPOI proof
                                  submission.
                                </p>
                                )
                              : (
                                <p className='spent-commitments-info'>
                                  These commitments have been spent. All PPOI proofs are valid.
                                </p>
                                )}
                            {group.spentCommitments.map((cws) => (
                              <CommitmentItem
                                key={cws.commitment.hash}
                                commitmentWithStatus={cws}
                                group={group}
                                submittingProof={submittingProof}
                                proofProgress={proofProgress}
                                proofSubmittedHashes={proofSubmittedHashes}
                                checkingPPOIHash={checkingPPOIHash}
                                isCheckingPOI={isCheckingPOI}
                                spentExplanation={getSpentExplanation(cws.commitment)}
                                onSubmitProof={handleSubmitProof}
                                onCheckSubmittedPPOI={handleCheckSubmittedPPOI}
                                onCheckPPOI={handleCheckPPOI}
                                getBucketLabel={getBucketLabel}
                                formatBalance={formatBalance}
                              />
                            ))}
                          </div>
                        )}

                        <div className='token-details-section'>
                          <h4>Token Details</h4>
                          <div className='detail-row'>
                            <span>Token Address:</span>
                            <div className='hash-container'>
                              <code className='hash-value'>{group.tokenAddress}</code>
                              <button
                                className='icon-btn'
                                onClick={() => copyToClipboard(group.tokenAddress)}
                                title='Copy address'
                              >
                                📋
                              </button>
                            </div>
                          </div>
                          <div className='detail-row'>
                            <span>Decimals:</span>
                            <span>{group.decimals}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </React.Fragment>
                )
              })}
            </div>
          </div>
          )}

      <AddTokenModal
        isOpen={showAddToken}
        onClose={() => setShowAddToken(false)}
        networkName={currentNetwork as NetworkName}
        onTokenAdded={() => refreshBalances()}
      />
    </div>
  )
}
