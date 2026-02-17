import axios from 'axios'

import type { PendingNetworkRequest } from '@/stores/networkRequestStore'
import { useNetworkRequestStore } from '@/stores/networkRequestStore'

let requestCounter = 0

/**
 * Classifies a network request URL into a human-readable destination and purpose.
 * @param url - The request URL to classify.
 * @returns An object containing the destination name and purpose description.
 */
function classifyRequest (url: string): { destination: string; purpose: string } {
  const urlLower = url.toLowerCase()

  if (urlLower.includes('ppoi') || urlLower.includes('fdi.network')) {
    return { destination: 'PPOI Aggregator Node', purpose: 'Proof of Innocence verification' }
  }
  if (
    urlLower.includes('subsquid') ||
    urlLower.includes('sqd.dev') ||
    urlLower.includes('graphql')
  ) {
    return { destination: 'Subsquid Indexer', purpose: 'Fetching commitment/transaction data' }
  }
  if (
    urlLower.includes('infura') ||
    urlLower.includes('alchemy') ||
    urlLower.includes('rpc') ||
    urlLower.includes('eth_') ||
    urlLower.includes('chainid') ||
    urlLower.includes('sepolia') ||
    urlLower.includes('ethereum')
  ) {
    return { destination: 'RPC Node', purpose: 'Blockchain interaction' }
  }
  if (urlLower.includes('localhost') || urlLower.includes('127.0.0.1')) {
    return { destination: 'Local Service', purpose: 'Local development' }
  }
  return { destination: 'External Service', purpose: 'Network request' }
}

/**
 * Extracts the hostname from a URL string, returning the raw string on parse failure.
 * @param url - The URL to extract the hostname from.
 * @returns The hostname portion of the URL.
 */
function getDomain (url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Determines whether a request URL should be intercepted for user approval.
 * @param url - The request URL to evaluate.
 * @returns True if the request should be intercepted, false for local or extension URLs.
 */
function shouldIntercept (url: string): boolean {
  // Skip local/extension requests
  if (url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) return false
  if (url.startsWith('data:') || url.startsWith('blob:')) return false
  // Skip local dev server requests
  const domain = getDomain(url)
  if (domain === 'localhost' || domain === '127.0.0.1') return false
  return true
}

/**
 * Requests user permission before allowing a network request to proceed.
 * @param url - The target URL of the network request.
 * @param method - The HTTP method (GET, POST, etc.).
 * @returns A promise that resolves to true if the user approves, false if denied.
 */
async function requestPermission (url: string, method: string): Promise<boolean> {
  const store = useNetworkRequestStore.getState()

  if (!store.isInterceptionEnabled) return true

  // Check if domain is already approved for this session
  const domain = getDomain(url)
  if (store.sessionApprovedDomains.has(domain)) return true

  const { destination, purpose } = classifyRequest(url)
  const id = `nr_${++requestCounter}_${Date.now()}`

  return new Promise<boolean>((resolve) => {
    const request: PendingNetworkRequest = {
      id,
      url,
      method: method.toUpperCase(),
      destination,
      purpose,
      timestamp: Date.now(),
      resolve,
    }
    store.addRequest(request)
  })
}

// Store original fetch reference
const originalFetch = window.fetch.bind(window)

/**
 * Replacement for window.fetch that requests user approval before external requests.
 * @param input - The fetch resource (URL string, URL object, or Request).
 * @param init - Optional fetch initialization options.
 * @returns A promise resolving to the fetch Response, or rejecting if the user denies the request.
 */
function interceptedFetch (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let url: string
  let method = 'GET'

  if (typeof input === 'string') {
    url = input
  } else if (input instanceof URL) {
    url = input.toString()
  } else {
    url = input.url
    method = input.method || 'GET'
  }
  if (init?.method) method = init.method

  if (!shouldIntercept(url)) {
    return originalFetch(input, init)
  }

  return requestPermission(url, method).then((allowed) => {
    if (!allowed) {
      return Promise.reject(new Error(`Network request to ${getDomain(url)} denied by user`))
    }
    return originalFetch(input, init)
  })
}

let isInstalled = false

/**
 * Installs the network request interceptor on both fetch and axios, prompting user approval for external requests.
 */
function installNetworkInterceptor (): void {
  if (isInstalled) return
  isInstalled = true

  // Intercept fetch (used by ethers.js)
  window.fetch = interceptedFetch as typeof window.fetch

  // Intercept axios (used by PPOI, Subsquid)
  axios.interceptors.request.use(async (config) => {
    const url = config.url || ''
    const fullUrl = config.baseURL ? `${config.baseURL}${url}` : url
    const method = config.method || 'GET'

    if (!shouldIntercept(fullUrl)) return config

    const allowed = await requestPermission(fullUrl, method)
    if (!allowed) {
      throw new axios.Cancel(`Network request to ${getDomain(fullUrl)} denied by user`)
    }
    return config
  })
}

/**
 * Removes the network request interceptor and restores the original fetch implementation.
 */
function uninstallNetworkInterceptor (): void {
  if (!isInstalled) return
  isInstalled = false
  window.fetch = originalFetch
  // Note: axios interceptors can't be easily removed, but disabling interception
  // via the store flag achieves the same effect
}

export { installNetworkInterceptor, uninstallNetworkInterceptor }
