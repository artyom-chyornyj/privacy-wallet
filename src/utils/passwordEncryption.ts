/**
 * Password-based encryption utilities for wallet data
 * Uses Web Crypto API with PBKDF2 for key derivation and AES-GCM for encryption
 */

// Configuration
const PBKDF2_ITERATIONS = 600000 // OWASP 2023 recommendation for PBKDF2-SHA256
const SALT_LENGTH = 16 // bytes
const IV_LENGTH = 12 // bytes for AES-GCM

// Rate limiting configuration
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_DURATION_MS = 15 * 60 * 1000 // 15 minutes
const ATTEMPT_WINDOW_MS = 60 * 1000 // 1 minute window for counting attempts

// Rate limiting state persisted to localStorage (shared across tabs for brute-force protection)
const RATE_LIMIT_KEY = 'railgun_rate_limit'

interface RateLimitState {
  attempts: number
  firstAttemptTime: number
  lockedUntil: number | null
}

/**
 * Loads the current rate limiting state from localStorage.
 * @returns The persisted rate limit state or a fresh default state
 */
function loadRateLimitState (): RateLimitState {
  try {
    const stored = localStorage.getItem(RATE_LIMIT_KEY)
    if (stored) return JSON.parse(stored)
  } catch {
    /* localStorage unavailable or corrupted */
  }
  return { attempts: 0, firstAttemptTime: 0, lockedUntil: null }
}

/**
 * Persists the rate limiting state to localStorage for cross-tab brute-force protection.
 * @param state - The rate limit state to save
 */
function saveRateLimitState (state: RateLimitState): void {
  try {
    localStorage.setItem(RATE_LIMIT_KEY, JSON.stringify(state))
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * Check if password attempts are currently rate limited
 * @returns Object with isLocked status and remainingTime in seconds
 */
function checkRateLimit (): { isLocked: boolean; remainingTime: number } {
  const now = Date.now()
  const state = loadRateLimitState()

  // Check if currently locked out
  if (state.lockedUntil && now < state.lockedUntil) {
    return {
      isLocked: true,
      remainingTime: Math.ceil((state.lockedUntil - now) / 1000),
    }
  }

  // Reset lockout if it has expired
  if (state.lockedUntil && now >= state.lockedUntil) {
    state.lockedUntil = null
    state.attempts = 0
    saveRateLimitState(state)
  }

  return { isLocked: false, remainingTime: 0 }
}

/**
 * Record a failed password attempt and check if lockout should be triggered
 * @returns true if account is now locked out
 */
function recordFailedAttempt (): boolean {
  const now = Date.now()
  const state = loadRateLimitState()

  // Reset attempt counter if window has passed
  if (now - state.firstAttemptTime > ATTEMPT_WINDOW_MS) {
    state.attempts = 0
    state.firstAttemptTime = now
  }

  // Record this attempt
  if (state.attempts === 0) {
    state.firstAttemptTime = now
  }
  state.attempts++

  // Check if lockout should be triggered
  if (state.attempts >= MAX_FAILED_ATTEMPTS) {
    state.lockedUntil = now + LOCKOUT_DURATION_MS
    saveRateLimitState(state)
    return true
  }

  saveRateLimitState(state)
  return false
}

/**
 * Reset rate limiting state (call after successful authentication)
 */
function resetRateLimit (): void {
  saveRateLimitState({ attempts: 0, firstAttemptTime: 0, lockedUntil: null })
}

/**
 * Derives an encryption key from a password using PBKDF2
 * @param password - The plaintext password to derive a key from
 * @param salt - Random salt bytes for PBKDF2 derivation
 * @returns The derived AES-GCM CryptoKey
 */
async function deriveKey (password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const encoder = new TextEncoder()
  const passwordBuffer = encoder.encode(password)

  // Import password as a key
  const passwordKey = await crypto.subtle.importKey('raw', passwordBuffer, 'PBKDF2', false, [
    'deriveBits',
    'deriveKey',
  ])

  // Derive encryption key using PBKDF2
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

/**
 * Encrypts data with a password
 * @param data - The data to encrypt (e.g., mnemonic phrase)
 * @param password - The password to use for encryption
 * @returns Base64-encoded encrypted data with salt and IV prepended
 */
async function encryptWithPassword (data: string, password: string): Promise<string> {
  const encoder = new TextEncoder()
  const dataBuffer = encoder.encode(data)

  // Generate random salt and IV
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))

  // Derive key from password
  const key = await deriveKey(password, salt)

  // Encrypt data
  const encryptedBuffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, dataBuffer)

  // Combine salt + IV + encrypted data
  const combined = new Uint8Array(salt.length + iv.length + encryptedBuffer.byteLength)
  combined.set(salt, 0)
  combined.set(iv, salt.length)
  combined.set(new Uint8Array(encryptedBuffer), salt.length + iv.length)

  // Convert to base64
  return btoa(String.fromCharCode(...combined))
}

/**
 * Decrypts data with a password
 * @param encryptedData - Base64-encoded encrypted data with salt and IV prepended
 * @param password - The password to use for decryption
 * @returns The decrypted data
 * @throws Error if decryption fails (wrong password or corrupted data)
 */
async function decryptWithPassword (
  encryptedData: string,
  password: string
): Promise<string> {
  try {
    // Decode from base64
    const combined = Uint8Array.from(atob(encryptedData), (c) => c.charCodeAt(0))

    // Extract salt, IV, and encrypted data
    const salt = combined.slice(0, SALT_LENGTH)
    const iv = combined.slice(SALT_LENGTH, SALT_LENGTH + IV_LENGTH)
    const encrypted = combined.slice(SALT_LENGTH + IV_LENGTH)

    // Derive key from password
    const key = await deriveKey(password, salt)

    // Decrypt data
    const decryptedBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted)

    // Convert to string
    const decoder = new TextDecoder()
    return decoder.decode(decryptedBuffer)
  } catch (error) {
    throw new Error('Failed to decrypt: incorrect password or corrupted data')
  }
}

/**
 * Validates if a password can decrypt the given encrypted data
 * Includes rate limiting to prevent brute force attacks
 * @param encryptedData - Base64-encoded encrypted data
 * @param password - The password to validate
 * @returns true if password is correct, false otherwise
 * @throws Error if rate limited
 */
async function validatePassword (encryptedData: string, password: string): Promise<boolean> {
  // Check rate limiting first
  const { isLocked, remainingTime } = checkRateLimit()
  if (isLocked) {
    throw new Error(
      `Too many failed attempts. Please wait ${remainingTime} seconds before trying again.`
    )
  }

  try {
    await decryptWithPassword(encryptedData, password)
    // Success - reset rate limiting
    resetRateLimit()
    return true
  } catch {
    // Failed attempt - record it
    const nowLocked = recordFailedAttempt()
    if (nowLocked) {
      throw new Error('Too many failed attempts. Account locked for 15 minutes.')
    }
    return false
  }
}

export {
  resetRateLimit,
  encryptWithPassword,
  decryptWithPassword,
  validatePassword,
}
