import { create } from 'zustand'

interface PendingNetworkRequest {
  id: string
  url: string
  method: string
  destination: string // Human-readable destination (e.g., "RPC Node", "Subsquid Indexer")
  purpose: string // Human-readable purpose
  timestamp: number
  resolve: (allowed: boolean) => void
}

interface NetworkRequestStore {
  pendingRequests: PendingNetworkRequest[]
  /** URLs the user has approved for the current session (auto-allow) */
  sessionApprovedDomains: Set<string>
  addRequest: (request: PendingNetworkRequest) => void
  removeRequest: (id: string) => void
  approveRequest: (id: string, rememberDomain: boolean) => void
  denyRequest: (id: string) => void
  approveAll: () => void
  isInterceptionEnabled: boolean
  setInterceptionEnabled: (enabled: boolean) => void
}

/**
 * Extracts the hostname from a URL string, falling back to the raw string on parse failure.
 * @param url - The URL to extract the domain from
 * @returns The hostname portion of the URL
 */
function getDomain (url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

const useNetworkRequestStore = create<NetworkRequestStore>((set, get) => ({
  pendingRequests: [],
  sessionApprovedDomains: new Set<string>(),
  isInterceptionEnabled: true,

  /**
   * Adds a pending network request to the queue for user approval.
   * @param request - The network request awaiting user approval
   */
  addRequest: (request) => {
    set((state) => ({
      pendingRequests: [...state.pendingRequests, request],
    }))
  },

  /**
   * Removes a pending network request from the queue by its ID.
   * @param id - The unique identifier of the request to remove
   */
  removeRequest: (id) => {
    set((state) => ({
      pendingRequests: state.pendingRequests.filter((r) => r.id !== id),
    }))
  },

  /**
   * Approves a pending network request and optionally remembers the domain for the session.
   * @param id - The unique identifier of the request to approve
   * @param rememberDomain - Whether to auto-approve future requests to this domain
   */
  approveRequest: (id, rememberDomain) => {
    const request = get().pendingRequests.find((r) => r.id === id)
    if (request) {
      if (rememberDomain) {
        const domain = getDomain(request.url)
        set((state) => {
          const newApproved = new Set(state.sessionApprovedDomains)
          newApproved.add(domain)
          return {
            sessionApprovedDomains: newApproved,
            pendingRequests: state.pendingRequests.filter((r) => r.id !== id),
          }
        })
      } else {
        set((state) => ({
          pendingRequests: state.pendingRequests.filter((r) => r.id !== id),
        }))
      }
      request.resolve(true)
    }
  },

  /**
   * Denies a pending network request and resolves its promise with false.
   * @param id - The unique identifier of the request to deny
   */
  denyRequest: (id) => {
    const request = get().pendingRequests.find((r) => r.id === id)
    if (request) {
      set((state) => ({
        pendingRequests: state.pendingRequests.filter((r) => r.id !== id),
      }))
      request.resolve(false)
    }
  },

  /**
   * Approves all pending network requests and clears the queue.
   */
  approveAll: () => {
    const requests = get().pendingRequests
    for (const r of requests) {
      r.resolve(true)
    }
    set({ pendingRequests: [] })
  },

  /**
   * Toggles whether outgoing network requests are intercepted for user approval.
   * @param enabled - Whether interception should be active
   */
  setInterceptionEnabled: (enabled) => {
    set({ isInterceptionEnabled: enabled })
  },
}))

export type { PendingNetworkRequest }
export { useNetworkRequestStore }
