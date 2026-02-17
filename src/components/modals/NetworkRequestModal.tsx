import { useState } from 'react'

import { useNetworkRequestStore } from '@/stores/networkRequestStore'
import './shared-modal.css'
import './NetworkRequestModal.css'

/**
 * Modal that prompts the user to approve or deny pending outgoing network requests.
 * @returns The network request approval modal or null when no requests are pending
 */
export function NetworkRequestModal () {
  const { pendingRequests, approveRequest, denyRequest, approveAll } = useNetworkRequestStore()
  const [rememberDomain, setRememberDomain] = useState(true)

  if (pendingRequests.length === 0) return null

  const current = pendingRequests[0]!
  const remaining = pendingRequests.length - 1

  let domain: string
  try {
    domain = new URL(current.url).hostname
  } catch {
    domain = current.url
  }

  return (
    <div className='modal-overlay network-request-overlay'>
      <div className='modal-content network-request-modal'>
        <div className='modal-header'>
          <h2>Network Request</h2>
          {remaining > 0 && <span className='network-request-count'>+{remaining} pending</span>}
        </div>

        <div className='modal-body'>
          <p className='network-request-description'>
            This action requires a network connection. Allow this request?
          </p>

          <div className='network-request-details'>
            <div className='network-request-row'>
              <span className='network-request-label'>Destination</span>
              <span className='network-request-value'>{current.destination}</span>
            </div>
            <div className='network-request-row'>
              <span className='network-request-label'>Domain</span>
              <span className='network-request-value network-request-domain'>{domain}</span>
            </div>
            <div className='network-request-row'>
              <span className='network-request-label'>Method</span>
              <span className='network-request-value'>{current.method}</span>
            </div>
            <div className='network-request-row'>
              <span className='network-request-label'>Purpose</span>
              <span className='network-request-value'>{current.purpose}</span>
            </div>
          </div>

          <label className='network-request-remember'>
            <input
              type='checkbox'
              checked={rememberDomain}
              onChange={(e) => setRememberDomain(e.target.checked)}
            />
            <span>Remember for this session (auto-allow {domain})</span>
          </label>
        </div>

        <div className='network-request-actions'>
          <button className='btn-secondary' onClick={() => denyRequest(current.id)}>
            Deny
          </button>
          {remaining > 0 && (
            <button className='btn-secondary' onClick={approveAll}>
              Allow All ({pendingRequests.length})
            </button>
          )}
          <button
            className='btn-primary'
            onClick={() => approveRequest(current.id, rememberDomain)}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  )
}
