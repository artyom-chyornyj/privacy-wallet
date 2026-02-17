import React, { useEffect, useState } from 'react'

import { TransactionHistoryService } from '@/services/TransactionHistoryService'
import { useWalletStore } from '@/stores/walletStore'
import type { NetworkName } from '@/types/network'
import type { DetailedTransaction, POIStatus } from '@/types/wallet'
import {
  formatTokenAmount,
  formatTxDate,
  getExplorerAddressUrl,
  getExplorerTxUrl,
  getPPOIInfoUrl,
  shortenAddress,
} from '@/utils/format'
import './TransactionList.css'

interface TransactionListProps {
  className?: string
}

interface TransactionRowProps {
  transaction: DetailedTransaction
  network: NetworkName
  onRefreshPOI: (commitment: { commitment: string; type: string }) => void
  onSubmitPOI: (transaction: DetailedTransaction) => Promise<void>
  isRefreshing: boolean
  isSubmittingPOI: boolean
  /** Commitments that have been status-checked via a network call (or loaded from cache). */
  checkedCommitments: Set<string>
}

/**
 * Translate technical PPOI errors into plain-English messages.
 * @param raw - The raw error message string from PPOI submission
 * @returns A user-friendly error message
 */
function friendlyPPOIError (raw?: string): string {
  if (!raw) return 'Something went wrong while submitting PPOI. Please try again.'

  if (raw.includes('depends on')) {
    return 'This transaction can\'t be submitted yet — an older transaction needs its PPOI submitted first. Scroll down in History and submit PPOI for older "Missing" transactions, then come back to this one.'
  }

  if (raw.includes('missing NPK')) {
    return "Unable to submit PPOI — the wallet couldn't decrypt one of the outputs for this transaction. This can happen with older transactions made before output data was stored locally."
  }

  if (raw.includes('status code 500')) {
    return 'The PPOI node rejected the request. This usually means an older transaction\'s PPOI needs to be submitted first, or the node is temporarily unavailable. Try submitting PPOI for older "Missing" transactions first.'
  }

  if (raw.includes('No spent TXOs')) {
    return "This transaction doesn't appear to belong to this wallet, so PPOI can't be generated for it."
  }

  if (raw.includes('not decrypted all commitments')) {
    return "The wallet couldn't decrypt all parts of this transaction. PPOI can't be generated without the full transaction data."
  }

  if (raw.includes('No list keys')) {
    return 'No PPOI list keys are available. The PPOI system may not be configured for this network.'
  }

  return 'Failed to submit PPOI. Check the browser console for details.'
}

/**
 * Copies the given text to the system clipboard.
 * @param text - The text string to copy
 */
const copyToClipboard = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text)
  } catch (err) {
    console.error('Failed to copy:', err)
  }
}

/**
 * Returns an emoji icon representing the transaction type.
 * @param type - The transaction type (e.g. 'shield', 'private send', 'unshield')
 * @returns An emoji string for the transaction type
 */
const getTransactionIcon = (type: string) => {
  switch (type.toLowerCase()) {
    case 'shield':
      return '🛡️'
    case 'private send':
      return '💸'
    case 'unshield':
      return '🔓'
    default:
      return '📄'
  }
}

/**
 * Returns the CSS class name for a transaction status badge.
 * @param txStatus - The transaction confirmation status
 * @param poiStatus - The PPOI verification status
 * @returns The CSS class string for styling the badge
 */
const getStatusBadgeClass = (
  txStatus: 'pending' | 'confirmed' | 'failed',
  poiStatus: POIStatus['status'] | 'unknown'
) => {
  if (txStatus === 'failed') return 'failed'
  if (txStatus === 'pending') return 'pending'
  if (poiStatus === 'valid') return 'confirmed'
  if (poiStatus === 'missing' || poiStatus === 'unknown') return 'poi-missing'
  if (poiStatus === 'pending') return 'poi-pending'
  if (poiStatus === 'invalid') return 'failed'
  return 'confirmed'
}

/**
 * Returns the display text for a transaction status badge.
 * @param txStatus - The transaction confirmation status
 * @param poiStatus - The PPOI verification status
 * @returns A human-readable status label
 */
const getStatusBadgeText = (
  txStatus: 'pending' | 'confirmed' | 'failed',
  poiStatus: POIStatus['status'] | 'unknown'
) => {
  if (txStatus === 'failed') return 'Failed'
  if (txStatus === 'pending') return 'Pending'
  if (poiStatus === 'valid') return 'Confirmed'
  if (poiStatus === 'missing') return 'PPOI Missing'
  if (poiStatus === 'unknown') return 'PPOI Unknown'
  if (poiStatus === 'pending') return 'PPOI Pending'
  if (poiStatus === 'invalid') return 'PPOI Blocked'
  return 'Confirmed'
}

/**
 * Map transaction type to PPOI API expected type
 * @param transactionType - The UI transaction type string
 * @returns The PPOI API commitment type string
 */
const mapTransactionTypeToPOIType = (
  transactionType: string
): 'Shield' | 'Transact' | 'Unshield' => {
  switch (transactionType.toLowerCase()) {
    case 'shield':
      return 'Shield'
    case 'unshield':
      return 'Unshield'
    case 'private send':
    default:
      return 'Transact'
  }
}

/**
 * Renders a single RAILGUN (private) transaction row with expandable details and PPOI actions.
 * @param root0 - The component props
 * @param root0.transaction - The detailed transaction data to display
 * @param root0.network - The current network name
 * @param root0.onRefreshPOI - Callback to refresh PPOI status for a commitment
 * @param root0.onSubmitPOI - Callback to submit a PPOI proof for a transaction
 * @param root0.isRefreshing - Whether a PPOI status refresh is in progress
 * @param root0.isSubmittingPOI - Whether a PPOI submission is in progress
 * @param root0.checkedCommitments - Set of commitment hashes that have been status-checked
 * @returns The rendered transaction row element
 */
const TransactionRow: React.FC<TransactionRowProps> = ({
  transaction,
  network,
  onRefreshPOI,
  onSubmitPOI,
  isRefreshing,
  isSubmittingPOI,
  checkedCommitments,
}) => {
  const [expanded, setExpanded] = useState(false)
  const [showCommitments, setShowCommitments] = useState(false)
  const savedWallets = useWalletStore((s) => s.savedWallets)

  /**
   * Attempts to find a user-friendly wallet name for the recipient address, if available in saved wallets.
   * @param address - The recipient address to look up
   * @returns The wallet nickname if found, otherwise undefined
   */
  const getRecipientWalletName = (address: string | undefined): string | undefined => {
    if (!address) return undefined
    const addrLower = address.toLowerCase()
    return savedWallets.find(
      (w) => w.address === address || w.ethereumAddress.toLowerCase() === addrLower
    )?.nickname
  }

  /**
   * Returns the first blinded commitment from the transaction, or a default empty object.
   * @returns The first blinded commitment entry
   */
  const getFirstCommitment = () => {
    return transaction.blindedCommitments[0] ?? { commitment: '', type: '' as any }
  }

  // Get overall PPOI status for the transaction using the service logic
  /**
   * Computes the aggregate PPOI status across all commitments in this transaction.
   * @returns The overall PPOI status or 'unknown' if not determinable
   */
  const getOverallPOIStatus = (): POIStatus['status'] | 'unknown' => {
    if (transaction.blindedCommitments.length === 0) {
      return 'unknown'
    }

    const commitmentStatuses = transaction.blindedCommitments
      .map((c) => c.poiStatus)
      .filter(Boolean) as POIStatus[]

    if (commitmentStatuses.length === 0) {
      return 'unknown'
    }

    if (commitmentStatuses.length < transaction.blindedCommitments.length) {
      return 'unknown'
    }

    try {
      const transactionHistoryService = TransactionHistoryService.getInstance()
      const poiStatus = transactionHistoryService.getTransactionPOIStatus(transaction)
      return poiStatus.status
    } catch (error) {
      console.error('Error getting transaction PPOI status:', error)
      return 'unknown'
    }
  }

  const primaryToken = transaction.transferredTokens[0]
  const hasMultipleTokens = transaction.transferredTokens.length > 1
  const overallPOIStatus = getOverallPOIStatus()

  return (
    <>
      <div
        className={`tx-row ${expanded ? 'expanded' : ''}`}
        onClick={() => setExpanded(!expanded)}
      >
        <div className='tx-type'>
          {getTransactionIcon(transaction.type)} {transaction.type}
        </div>
        <div className='tx-date'>{formatTxDate(transaction.timestamp)}</div>

        <div className='tx-amount'>
          {primaryToken && (
            <>
              <div
                className='amount-value'
                title={`${primaryToken.direction === 'sent' ? '-' : '+'}${formatTokenAmount(primaryToken.amount, primaryToken.decimals)} ${primaryToken.symbol}`}
              >
                {primaryToken.direction === 'sent' ? '-' : '+'}
                {formatTokenAmount(primaryToken.amount, primaryToken.decimals)}{' '}
                {primaryToken.symbol}
              </div>
              {hasMultipleTokens && (
                <div className='amount-extra'>+{transaction.transferredTokens.length - 1} more</div>
              )}
            </>
          )}
        </div>

        <div
          className={`status-badge ${getStatusBadgeClass(transaction.status, overallPOIStatus)}`}
        >
          {getStatusBadgeText(transaction.status, overallPOIStatus)}
        </div>
      </div>

      {expanded && (
        <div className='tx-details'>
          <div className='details-grid'>
            <div className='detail-section'>
              <h4>Transaction Details</h4>
              <div className='detail-row'>
                <span>Type:</span>
                <span>{transaction.type}</span>
              </div>
              <div className='detail-row'>
                <span>Hash:</span>
                <div className='hash-container'>
                  <code className='hash-value'>{transaction.txid}</code>
                  <button
                    className='icon-btn'
                    onClick={() => copyToClipboard(transaction.txid)}
                    title='Copy'
                  >
                    📋
                  </button>
                  <a
                    href={getExplorerTxUrl(network, transaction.txid)}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='icon-btn'
                    title='View on Explorer'
                  >
                    🔗
                  </a>
                </div>
              </div>
              <div className='detail-row'>
                <span>Block:</span>
                <span>{transaction.blockNumber}</span>
              </div>
              <div className='detail-row'>
                <span>Time:</span>
                <span>{new Date(transaction.timestamp * 1000).toLocaleString()}</span>
              </div>

              {/* Recipient/Sender Information */}
              {transaction.transferredTokens.some((t) => t.direction === 'sent') && (
                <div className='detail-row'>
                  <span>
                    Recipient{transaction.metadata?.recipientAddress
                    ? ` (${transaction.metadata.recipientAddress.startsWith('0x') ? '0x' : '0zk'})`
                    : ''}:
                    {!transaction.metadata?.recipientAddress && (
                      <span
                        className='info-icon'
                        title="Recipient address is not available. Due to RAILGUN's privacy design, recipient information is encrypted on-chain and cannot be derived after the transaction is sent unless it was stored locally when the transaction was created."
                        style={{ marginLeft: '4px', cursor: 'help', color: '#888' }}
                      >
                        ℹ️
                      </span>
                    )}
                  </span>
                  <span>
                    {transaction.metadata?.recipientAddress
                      ? (
                        <div className='hash-container'>
                          <code className='hash-value' style={{ fontSize: '0.85em' }}>
                            {getRecipientWalletName(transaction.metadata.recipientAddress) ||
                            transaction.metadata.recipientLabel ||
                            transaction.metadata.recipientAddress}
                          </code>
                          <button
                            className='icon-btn'
                            onClick={() => copyToClipboard(transaction.metadata!.recipientAddress!)}
                            title='Copy recipient address'
                          >
                            📋
                          </button>
                        </div>
                        )
                      : (
                        <span style={{ color: '#888', fontStyle: 'italic' }}>N/A</span>
                        )}
                  </span>
                </div>
              )}

              {transaction.transferredTokens.some((t) => t.direction === 'received') &&
                (transaction.metadata?.senderAddress ||
                  transaction.metadata?.senderMasterPublicKey ||
                  !transaction.transferredTokens.some((t) => t.direction === 'sent')) && (
                    <div className='detail-row'>
                      <span>
                        {transaction.type === 'Shield' ? 'Shielded from:' : 'Sender:'}
                        {!transaction.metadata?.senderAddress &&
                        !transaction.metadata?.senderMasterPublicKey && (
                          <span
                            className='info-icon'
                            title="Sender information not available. For RAILGUN payments, the sender's identity can be derived from encrypted on-chain data using your private key. If this field is empty, it may indicate: (1) The transaction data hasn't been fully processed yet, or (2) There was an issue during decryption."
                            style={{ marginLeft: '4px', cursor: 'help', color: '#888' }}
                          >
                            ℹ️
                          </span>
                        )}
                      </span>
                      <span>
                        {transaction.metadata?.senderAddress
                          ? (
                            <div className='hash-container' style={{ maxWidth: 'none' }}>
                              <code
                                className='hash-value'
                                style={{
                                  fontSize: '0.85em',
                                  overflow: 'visible',
                                  textOverflow: 'unset',
                                }}
                              >
                                {shortenAddress(transaction.metadata.senderAddress, 10, 6)}
                              </code>
                              <button
                                className='icon-btn'
                                onClick={() => copyToClipboard(transaction.metadata!.senderAddress!)}
                                title={
                              transaction.type === 'Shield'
                                ? 'Copy Ethereum address'
                                : "Copy sender's RAILGUN address"
                            }
                              >
                                📋
                              </button>
                            </div>
                            )
                          : (
                            <span style={{ color: '#888', fontStyle: 'italic' }}>Not Available</span>
                            )}
                      </span>
                    </div>
              )}

              {transaction.metadata?.memo && (
                <div className='detail-row'>
                  <span>Memo:</span>
                  <span style={{ fontStyle: 'italic' }}>{transaction.metadata.memo}</span>
                </div>
              )}

              {transaction.metadata?.tags && transaction.metadata.tags.length > 0 && (
                <div className='detail-row'>
                  <span>Tags:</span>
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {transaction.metadata.tags.map((tag, i) => (
                      <span
                        key={i}
                        style={{
                          backgroundColor: '#e0e0e0',
                          padding: '2px 8px',
                          borderRadius: '12px',
                          fontSize: '0.85em',
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {transaction.transferredTokens.length > 0 && (
              <div className='detail-section'>
                <h4>Tokens ({transaction.transferredTokens.length})</h4>
                {transaction.transferredTokens.map((token, index) => (
                  <div key={index} className='token-row'>
                    <span className='token-symbol'>{token.symbol}</span>
                    <span className='token-amount'>
                      {token.direction === 'sent' ? '-' : '+'}
                      {formatTokenAmount(token.amount, token.decimals)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {transaction.blindedCommitments.length > 0 && (
              <div className='detail-section ppoi-section'>
                <h4>PPOI Status</h4>
                <div className='detail-row'>
                  <span>Status:</span>
                  <span>
                    <span className={`ppoi-summary-badge ppoi-${overallPOIStatus}`}>
                      {overallPOIStatus === 'valid' && '✅ Verified'}
                      {overallPOIStatus === 'missing' && '⚠️ Missing'}
                      {overallPOIStatus === 'unknown' && '❓ Unknown'}
                      {overallPOIStatus === 'pending' && '⏳ Pending'}
                      {overallPOIStatus === 'invalid' && '🚫 Blocked'}
                    </span>
                  </span>
                </div>
                <div className='detail-row'>
                  <span>Commitments:</span>
                  <span className='ppoi-commitments-value'>
                    {transaction.blindedCommitments.length}
                    <a
                      href={getPPOIInfoUrl(network, transaction.txid)}
                      target='_blank'
                      rel='noopener noreferrer'
                      className='ppoi-info-link'
                      title='View on ppoi.info'
                    >
                      🔍
                    </a>
                  </span>
                </div>
                {(overallPOIStatus === 'missing' || overallPOIStatus === 'unknown') &&
                  (() => {
                    const isShield = transaction.type.toLowerCase() === 'shield'
                    const allCommitmentsChecked = transaction.blindedCommitments.every((c) =>
                      checkedCommitments.has(c.commitment)
                    )

                    return (
                      <div className='ppoi-box-actions'>
                        {isShield
                          ? (
                            <div className='ppoi-received-notice'>
                              <span className='ppoi-notice-icon'>ℹ️</span>
                              <span className='ppoi-notice-text'>
                                Shield PPOI is generated automatically by PPOI nodes. Please wait for
                                it to be mined.
                              </span>
                            </div>
                            )
                          : allCommitmentsChecked
                            ? (
                              <button
                                className='submit-poi-btn'
                                onClick={(e) => {
                                  e.stopPropagation()
                                  onSubmitPOI(transaction)
                                }}
                                disabled={isSubmittingPOI}
                              >
                                {isSubmittingPOI ? '⏳ Submitting...' : '🛡️ Submit PPOI'}
                              </button>
                              )
                            : (
                              <div className='ppoi-received-notice'>
                                <span className='ppoi-notice-icon'>ℹ️</span>
                                <span className='ppoi-notice-text'>
                                  Check status first to confirm PPOI is missing before submitting.
                                </span>
                              </div>
                              )}
                        <button
                          className='refresh-poi-btn'
                          onClick={() => {
                            const first = getFirstCommitment()
                            onRefreshPOI({
                              commitment: first.commitment,
                              type: first.type,
                            })
                          }}
                          disabled={isRefreshing}
                        >
                          {isRefreshing
                            ? '⏳ Refreshing...'
                            : allCommitmentsChecked
                              ? '🔄 Refresh Status'
                              : '🔍 Check Status'}
                        </button>
                      </div>
                    )
                  })()}
                {overallPOIStatus === 'invalid' && transaction.type.toLowerCase() === 'shield' && (
                  <div className='ppoi-box-actions'>
                    <div className='ppoi-received-notice'>
                      <span className='ppoi-notice-icon'>🚫</span>
                      <span className='ppoi-notice-text'>
                        This shield has been blocked. You may only unshield these funds back to the
                        original shielding address. Use the Transact tab to unshield blocked funds.
                      </span>
                    </div>
                  </div>
                )}
                <button
                  className={`ppoi-details-toggle ${showCommitments ? 'open' : ''}`}
                  onClick={() => setShowCommitments(!showCommitments)}
                >
                  <span className='ppoi-toggle-chevron'>›</span>
                  {showCommitments ? 'Hide' : 'Show'} Commitment Details
                </button>
                {showCommitments && (
                  <div className='ppoi-commitments-list'>
                    {transaction.blindedCommitments.map((commitment, index) => (
                      <div key={index} className='ppoi-commitment-row'>
                        <span className='ppoi-commitment-index'>#{index + 1}</span>
                        <code className='ppoi-commitment-hash'>
                          {commitment.commitment.slice(0, 10)}...{commitment.commitment.slice(-8)}
                        </code>
                        <button
                          className='icon-btn'
                          onClick={() => copyToClipboard(commitment.commitment)}
                          title='Copy blinded commitment'
                        >
                          📋
                        </button>
                        {commitment.isSpent !== undefined && (
                          <span
                            className={`ppoi-commitment-type ${commitment.isSpent ? 'spent' : 'output'}`}
                          >
                            {commitment.isSpent ? 'Input' : 'Output'}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Lightweight row for public (0x) transactions -- no PPOI fields.
 * @param root0 - The component props
 * @param root0.tx - The detailed transaction data to display
 * @param root0.primaryToken - The primary transferred token, if any
 * @param root0.isSent - Whether the transaction was an outgoing transfer
 * @param root0.network - The current network name
 * @returns The rendered public transaction row element
 */
const PublicTxRow: React.FC<{
  tx: DetailedTransaction
  primaryToken: DetailedTransaction['transferredTokens'][0] | undefined
  isSent: boolean
  network: NetworkName
}> = ({ tx, primaryToken, isSent, network }) => {
  const [expanded, setExpanded] = useState(false)

  const isRailgun = tx.category?.startsWith('RAILGUN')
  const isUnshield = tx.category === 'RAILGUN Unshield' || tx.type === 'Unshield'

  return (
    <>
      <div
        className={`tx-row ${expanded ? 'expanded' : ''}`}
        onClick={() => setExpanded(!expanded)}
      >
        <div className='tx-type'>
          {isUnshield ? '🔓' : isRailgun ? '🛡️' : isSent ? '📤' : '📥'} {tx.category || 'Transfer'}
        </div>
        <div className='tx-date'>{formatTxDate(tx.timestamp)}</div>
        <div className='tx-amount'>
          {primaryToken && (
            <div
              className='amount-value'
              title={`${isSent ? '-' : '+'}${formatTokenAmount(primaryToken.amount, primaryToken.decimals)} ${primaryToken.symbol}`}
            >
              {isSent ? '-' : '+'}
              {formatTokenAmount(primaryToken.amount, primaryToken.decimals)} {primaryToken.symbol}
            </div>
          )}
          {!primaryToken && (
            <div className='amount-value' style={{ color: 'var(--text-muted)' }}>
              Contract Call
            </div>
          )}
          {tx.transferredTokens.length > 1 && (
            <div className='amount-extra'>+{tx.transferredTokens.length - 1} more</div>
          )}
        </div>
        <div className={`status-badge ${tx.status === 'failed' ? 'failed' : 'confirmed'}`}>
          {tx.status === 'failed' ? 'Failed' : 'Confirmed'}
        </div>
      </div>

      {expanded && (
        <div className='tx-details'>
          <div className='details-grid'>
            <div className='detail-section'>
              <h4>Transaction Details</h4>
              <div className='detail-row'>
                <span>Hash:</span>
                <div className='hash-container'>
                  <code className='hash-value'>{tx.txid}</code>
                  <button
                    className='icon-btn'
                    onClick={() => copyToClipboard(tx.txid)}
                    title='Copy'
                  >
                    📋
                  </button>
                  <a
                    href={getExplorerTxUrl(network, tx.txid)}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='icon-btn'
                    title='View on Explorer'
                  >
                    🔗
                  </a>
                </div>
              </div>
              <div className='detail-row'>
                <span>Block:</span>
                <span>{tx.blockNumber}</span>
              </div>
              <div className='detail-row'>
                <span>Time:</span>
                <span>{new Date(tx.timestamp * 1000).toLocaleString()}</span>
              </div>
              {tx.metadata?.recipientAddress && (
                <div className='detail-row'>
                  <span>To:</span>
                  <div className='hash-container'>
                    <code className='hash-value'>
                      {shortenAddress(tx.metadata.recipientAddress)}
                    </code>
                    <button
                      className='icon-btn'
                      onClick={() => copyToClipboard(tx.metadata!.recipientAddress!)}
                      title='Copy'
                    >
                      📋
                    </button>
                  </div>
                </div>
              )}
              {tx.metadata?.senderAddress && (
                <div className='detail-row'>
                  <span>From:</span>
                  <div className='hash-container'>
                    <code className='hash-value'>{shortenAddress(tx.metadata.senderAddress)}</code>
                    <button
                      className='icon-btn'
                      onClick={() => copyToClipboard(tx.metadata!.senderAddress!)}
                      title='Copy'
                    >
                      📋
                    </button>
                  </div>
                </div>
              )}
              {isRailgun &&
                (tx.metadata?.recipientAddress || tx.metadata?.senderAddress) &&
                (() => {
                  const contractAddr = tx.metadata?.recipientAddress || tx.metadata?.senderAddress!
                  return (
                    <div className='detail-row'>
                      <span>Contract:</span>
                      <div className='hash-container'>
                        <code className='hash-value' style={{ color: '#7b61ff' }}>
                          RAILGUN ({shortenAddress(contractAddr)})
                        </code>
                        <button
                          className='icon-btn'
                          onClick={() => copyToClipboard(contractAddr)}
                          title='Copy'
                        >
                          📋
                        </button>
                      </div>
                    </div>
                  )
                })()}
              {tx.gasCost != null && BigInt(tx.gasCost) > 0n && (
                <div className='detail-row'>
                  <span>Gas Cost:</span>
                  <span>{formatTokenAmount(BigInt(tx.gasCost), 18)} ETH</span>
                </div>
              )}
            </div>
            {tx.transferredTokens.length > 0 && (
              <div className='detail-section'>
                <h4>Tokens ({tx.transferredTokens.length})</h4>
                {tx.transferredTokens.map((token, i) => (
                  <div key={i} className='token-row'>
                    <span className='token-symbol'>{token.symbol}</span>
                    <span className='token-amount'>
                      {token.direction === 'sent' ? '-' : '+'}
                      {formatTokenAmount(token.amount, token.decimals)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/**
 * Displays a list of RAILGUN private or public transactions with PPOI status management.
 * @param root0 - The component props
 * @param root0.className - Optional additional CSS class name
 * @returns The rendered transaction list component
 */
export const TransactionList: React.FC<TransactionListProps> = ({ className }) => {
  const {
    currentWallet,
    currentNetwork,
    transactions: storeTransactions,
    balanceMode,
    refreshBalances,
    commitmentPOIStatus,
    checkedCommitments,
    isCheckingPOI,
    poiCheckProgress,
    getUncheckedPOICount,
    checkAllCommitmentPOI,
    checkSingleCommitmentPOI,
    clearCommitmentPOIStatus,
    lastBalanceUpdate,
  } = useWalletStore()
  const [transactions, setTransactions] = useState<DetailedTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [totalCount, setTotalCount] = useState(0)
  const [refreshingCommitment, setRefreshingCommitment] = useState<string | null>(null)
  const [submittingPOITxid, setSubmittingPOITxid] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<{
    text: string
    type: 'success' | 'error' | 'info'
  } | null>(null)
  const transactionHistoryService = TransactionHistoryService.getInstance()

  /**
   * Formats a Unix millisecond timestamp into a human-readable relative time string.
   * @param timestamp - The timestamp in milliseconds since epoch
   * @returns A relative time string such as 'just now', '5 minutes ago', or a full date
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

  const network = currentNetwork as NetworkName

  /**
   * Show an inline status message that auto-dismisses after a delay.
   * @param text - The message text to display
   * @param type - The severity level controlling styling
   * @param durationMs - Milliseconds before the message auto-dismisses
   */
  const showStatus = (text: string, type: 'success' | 'error' | 'info', durationMs = 8000) => {
    setStatusMessage({ text, type })
    if (durationMs > 0) {
      setTimeout(() => setStatusMessage(null), durationMs)
    }
  }

  // Enrich transactions with PPOI status from the shared store state
  /**
   * Merges cached PPOI status from the store into each transaction's blinded commitments.
   * @param transactionsList - The transactions to enrich with PPOI status data
   * @returns A new array of transactions with updated commitment PPOI statuses
   */
  const enrichTransactionsWithPOI = (
    transactionsList: DetailedTransaction[]
  ): DetailedTransaction[] => {
    return transactionsList.map((tx) => {
      const updatedCommitments = tx.blindedCommitments.map((c) => {
        const storeStatus = commitmentPOIStatus[c.commitment]
        if (storeStatus && storeStatus !== c.poiStatus) {
          return { ...c, poiStatus: storeStatus }
        }
        return c
      })

      const hasChanges = updatedCommitments.some(
        (c, idx) => c.poiStatus !== tx.blindedCommitments[idx]?.poiStatus
      )

      return hasChanges ? { ...tx, blindedCommitments: updatedCommitments } : tx
    })
  }

  /**
   * Refreshes the transaction list by re-fetching wallet balances and history.
   */
  const refreshTransactions = async () => {
    if (!currentWallet || !currentNetwork) return

    setLoading(true)
    try {
      await refreshBalances()
    } catch (err) {
      console.error('Error during refresh:', err)
    } finally {
      setLoading(false)
    }
  }

  /**
   * Refreshes PPOI status for a commitment and attempts re-submission if missing.
   * @param commitment - The commitment to check
   * @param commitment.commitment - The blinded commitment hash
   * @param commitment.type - The commitment type (Shield, Transact, or Unshield)
   */
  const refreshCommitmentPOI = async (commitment: { commitment: string; type: string }) => {
    if (!currentNetwork || !currentWallet) return

    setRefreshingCommitment(commitment.commitment)
    try {
      // Find the transaction containing this commitment so we can check ALL its commitments
      const parentTx = transactions.find((tx) =>
        tx.blindedCommitments.some((c) => c.commitment === commitment.commitment)
      )

      if (parentTx) {
        for (const bc of parentTx.blindedCommitments) {
          await checkSingleCommitmentPOI(bc.commitment, mapTransactionTypeToPOIType(parentTx.type))
        }
      } else {
        await checkSingleCommitmentPOI(
          commitment.commitment,
          commitment.type as 'Shield' | 'Transact' | 'Unshield'
        )
      }

      // Read the updated status from the store
      const result = useWalletStore.getState().commitmentPOIStatus[commitment.commitment]

      // If PPOI is missing for Transact/Unshield after fresh check, attempt to re-submit
      if (
        (!result || result.status === 'missing') &&
        (commitment.type === 'Transact' || commitment.type === 'Unshield')
      ) {
        const transaction = transactions.find((tx) =>
          tx.blindedCommitments.some((c) => c.commitment === commitment.commitment)
        )

        if (transaction && currentWallet) {
          const generateResult = await transactionHistoryService.generatePOIProofForTransaction(
            transaction,
            network,
            currentWallet
          )

          if (generateResult.success) {
            showStatus(
              'PPOI proof submitted. Status should update within about a minute.',
              'success'
            )

            setTimeout(async () => {
              await checkSingleCommitmentPOI(
                commitment.commitment,
                mapTransactionTypeToPOIType(commitment.type)
              )
            }, 30000)
          } else {
            console.error('Failed to generate PPOI proof:', generateResult.error)
            showStatus(friendlyPPOIError(generateResult.error), 'error', 15000)
          }
        } else if (!currentWallet) {
          showStatus('No wallet available. Please unlock your wallet first.', 'error')
        }
      }
    } catch (error) {
      console.error('Error refreshing commitment PPOI:', error)
      showStatus('Failed to refresh PPOI status. Please try again.', 'error')
    } finally {
      setRefreshingCommitment(null)
    }
  }

  // Sync local state from the Zustand store whenever store transactions or PPOI status change
  useEffect(() => {
    if (storeTransactions && storeTransactions.length > 0) {
      const sorted = [...storeTransactions].sort((a, b) => b.timestamp - a.timestamp)
      const withPOI = enrichTransactionsWithPOI(sorted)
      setTransactions(withPOI)
      setTotalCount(withPOI.length)
      setLoading(false)
    }
  }, [storeTransactions, commitmentPOIStatus])

  useEffect(() => {
    if (currentWallet) {
      if (storeTransactions && storeTransactions.length > 0) {
        const sorted = [...storeTransactions].sort((a, b) => b.timestamp - a.timestamp)
        const withPOI = enrichTransactionsWithPOI(sorted)
        setTransactions(withPOI)
        setTotalCount(withPOI.length)
        setLoading(false)
      } else {
        setTransactions([])
        setTotalCount(0)
        setLoading(false)
      }
    } else {
      setTransactions([])
      setTotalCount(0)
      setLoading(false)
    }
  }, [currentWallet, currentNetwork])

  // Submit PPOI for a specific transaction
  /**
   * Generates and submits a PPOI proof for the given transaction.
   * @param transaction - The transaction to generate and submit a PPOI proof for
   */
  const submitTransactionPOI = async (transaction: DetailedTransaction) => {
    if (!currentWallet || !currentNetwork) return

    setSubmittingPOITxid(transaction.txid)

    try {
      const result = await transactionHistoryService.generatePOIProofForTransaction(
        transaction,
        network,
        currentWallet
      )

      if (result.success) {
        // Clear cached PPOI status so the next manual check fetches fresh data
        for (const commitment of transaction.blindedCommitments) {
          clearCommitmentPOIStatus(commitment.commitment)
        }

        showStatus(
          'PPOI submitted successfully! Use "Refresh" or "Check Status" to verify.',
          'success'
        )
      } else {
        console.error('Failed to submit PPOI:', result.error)
        showStatus(friendlyPPOIError(result.error), 'error', 15000)
      }
    } catch (error) {
      console.error('Error submitting PPOI:', error)
      showStatus(
        friendlyPPOIError(error instanceof Error ? error.message : undefined),
        'error',
        15000
      )
    } finally {
      setSubmittingPOITxid(null)
    }
  }

  if (!currentWallet) {
    return (
      <div className='transaction-list empty'>
        <p>No wallet selected</p>
      </div>
    )
  }

  // Show public (0x) transaction history
  if (balanceMode === 'public') {
    const eoa = currentWallet.ethereumAddress
    const addressUrl = eoa ? getExplorerAddressUrl(network, eoa) : undefined
    const publicTxs = storeTransactions || []

    return (
      <div className={`transaction-list ${className || ''}`}>
        <div className='transaction-list-header'>
          <div className='header-left'>
            {publicTxs.length > 0 && (
              <span className='badge'>
                {publicTxs.length} Transaction{publicTxs.length !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className='header-actions'>
            {addressUrl && (
              <a
                href={addressUrl}
                target='_blank'
                rel='noopener noreferrer'
                className='refresh-btn'
                style={{ textDecoration: 'none' }}
              >
                Explorer
              </a>
            )}
            <button className='refresh-btn' onClick={refreshTransactions} disabled={loading}>
              {loading ? 'Refreshing...' : 'Refresh'}
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

        {loading && publicTxs.length === 0
          ? (
            <div className='loading-state'>
              <div className='loading-spinner' />
              <p>Loading transactions...</p>
            </div>
            )
          : publicTxs.length === 0
            ? (
              <div className='empty-state'>
                <div className='empty-icon'>📄</div>
                <h4>No transactions found</h4>
                <p>Click Refresh to load public transaction history</p>
              </div>
              )
            : (
              <div className='transaction-table'>
                <div className='table-header'>
                  <div className='col-type'>Type</div>
                  <div className='col-date'>Date</div>
                  <div className='col-amount'>Amount</div>
                  <div className='col-status'>Status</div>
                </div>
                <div className='table-body'>
                  {publicTxs.map((tx) => {
                    const primaryToken = tx.transferredTokens[0]
                    const isSent = primaryToken?.direction === 'sent'
                    return (
                      <PublicTxRow
                        key={tx.txid}
                        tx={tx}
                        primaryToken={primaryToken}
                        isSent={isSent}
                        network={network}
                      />
                    )
                  })}
                </div>
              </div>
              )}
      </div>
    )
  }

  return (
    <div className={`transaction-list ${className || ''}`}>
      <div className='transaction-list-header'>
        <div className='header-left'>
          {totalCount > 0 && (
            <span className='badge'>
              {totalCount} Transaction{totalCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className='header-actions'>
          <button
            className='check-all-poi-btn'
            onClick={checkAllCommitmentPOI}
            disabled={loading || isCheckingPOI || getUncheckedPOICount() === 0}
            title={
              getUncheckedPOICount() === 0
                ? 'All commitments already have PPOI status'
                : `Check PPOI status for ${getUncheckedPOICount()} unchecked commitments`
            }
          >
            {isCheckingPOI
              ? poiCheckProgress.total > 0
                ? `⏳ ${poiCheckProgress.checked}/${poiCheckProgress.total}`
                : '⏳ Checking...'
              : getUncheckedPOICount() > 0
                ? `🛡️ Check ${getUncheckedPOICount()} PPOI`
                : '🛡️ All PPOI Checked'}
          </button>
          <button className='refresh-btn' onClick={refreshTransactions} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
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

      {statusMessage && (
        <div
          className={`shield-status-strip status-${statusMessage.type === 'success' ? 'ok' : statusMessage.type}`}
          style={{ margin: '0.5rem 1rem', cursor: 'pointer' }}
          onClick={() => setStatusMessage(null)}
        >
          {statusMessage.text}
        </div>
      )}

      {loading && transactions.length === 0
        ? (
          <div className='loading-state'>
            <div className='loading-spinner' />
            <p>Loading transactions...</p>
          </div>
          )
        : transactions.length === 0
          ? (
            <div className='empty-state'>
              <div className='empty-icon'>📄</div>
              <h4>No transactions found</h4>
              <p>Start by refreshing your transaction history</p>
            </div>
            )
          : (
            <div className='transaction-table'>
              <div className='table-header'>
                <div className='col-type'>Type</div>
                <div className='col-date'>Date</div>
                <div className='col-amount'>Amount</div>
                <div className='col-status'>Status</div>
              </div>
              <div className='table-body'>
                {transactions.map((transaction) => (
                  <TransactionRow
                    key={transaction.txid}
                    transaction={transaction}
                    network={network}
                    onRefreshPOI={refreshCommitmentPOI}
                    onSubmitPOI={submitTransactionPOI}
                    isRefreshing={transaction.blindedCommitments.some(
                      (c) => c.commitment === refreshingCommitment
                    )}
                    isSubmittingPOI={submittingPOITxid === transaction.txid}
                    checkedCommitments={checkedCommitments}
                  />
                ))}
              </div>
            </div>
            )}
    </div>
  )
}
