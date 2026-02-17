/**
 * Security utilities for production-ready wallet
 */
import { dlog } from '@/utils/debug'

// Session timeout duration (15 minutes of inactivity)
const SESSION_TIMEOUT_MS = 15 * 60 * 1000

// Password strength requirements (minimum 4 to allow PINs)
const PASSWORD_REQUIREMENTS = {
  minLength: 4,
  requireUppercase: false,
  requireLowercase: false,
  requireNumber: false,
  requireSpecial: false,
}

/**
 * Validates password strength beyond just length
 * @param password - The password string to validate.
 * @returns Object with isValid boolean, array of error messages, and strength rating.
 */
function validatePasswordStrength (password: string): {
  isValid: boolean
  errors: string[]
  strength: 'weak' | 'medium' | 'strong'
} {
  const errors: string[] = []
  let score = 0

  // Check minimum length
  if (password.length < PASSWORD_REQUIREMENTS.minLength) {
    errors.push(`Password must be at least ${PASSWORD_REQUIREMENTS.minLength} characters`)
  } else {
    score += 1
  }

  // Check for uppercase
  if (PASSWORD_REQUIREMENTS.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter')
  } else if (/[A-Z]/.test(password)) {
    score += 1
  }

  // Check for lowercase
  if (PASSWORD_REQUIREMENTS.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter')
  } else if (/[a-z]/.test(password)) {
    score += 1
  }

  // Check for number
  if (PASSWORD_REQUIREMENTS.requireNumber && !/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number')
  } else if (/[0-9]/.test(password)) {
    score += 1
  }

  // Check for special character (bonus, not required by default)
  if (/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
    score += 1
  }

  // Additional length bonus
  if (password.length >= 12) {
    score += 1
  }
  if (password.length >= 16) {
    score += 1
  }

  // Determine strength
  let strength: 'weak' | 'medium' | 'strong'
  if (score <= 2) {
    strength = 'weak'
  } else if (score <= 4) {
    strength = 'medium'
  } else {
    strength = 'strong'
  }

  return {
    isValid: errors.length === 0,
    errors,
    strength,
  }
}

/**
 * Checks if the app is running in production mode.
 * @returns True if the app is in production, false otherwise.
 */
function isProduction (): boolean {
  // Check for Vite's production flag
  try {
    // @ts-expect-error - Vite injects this at build time
    return import.meta.env?.PROD === true
  } catch {
    // Fallback for environments where import.meta isn't available
    return process.env['NODE_ENV'] === 'production'
  }
}

/**
 * Safe console logger that filters sensitive data in production
 */
const secureLog = {
  /**
   * Logs messages only in non-production environments.
   * @param args - Values to log to the console.
   */
  log: (...args: unknown[]) => {
    if (!isProduction()) {
      console.log(...args)
    }
  },
  /**
   * Logs warning messages in all environments.
   * @param args - Values to log as warnings.
   */
  warn: (...args: unknown[]) => {
    console.warn(...args) // Always show warnings
  },
  /**
   * Logs error messages in all environments.
   * @param args - Values to log as errors.
   */
  error: (...args: unknown[]) => {
    console.error(...args) // Always show errors
  },
  /**
   * Logs debug messages using the debug logger utility.
   * @param args - Values to log at debug level.
   */
  debug: (...args: unknown[]) => {
    dlog('[DEBUG]', ...args)
  },
}

/**
 * Session timeout manager
 */
class SessionTimeoutManager {
  /** Handle for the active setTimeout timer, or null if none is running. */
  private timeoutId: ReturnType<typeof setTimeout> | null = null
  /** Timestamp of the last detected user activity in milliseconds. */
  private lastActivity: number = Date.now()
  /** Callback invoked when the session times out due to inactivity. */
  private onTimeout: () => void
  /** Duration of inactivity in milliseconds before the session times out. */
  private timeoutDuration: number

  /**
   * Creates a new session timeout manager.
   * @param onTimeout - Callback to invoke when the session times out.
   * @param timeoutDuration - Inactivity duration in milliseconds before timeout.
   */
  constructor (onTimeout: () => void, timeoutDuration: number = SESSION_TIMEOUT_MS) {
    this.onTimeout = onTimeout
    this.timeoutDuration = timeoutDuration
  }

  /**
   * Start monitoring for session timeout
   */
  start (): void {
    this.resetTimer()

    // Listen for user activity
    if (typeof window !== 'undefined') {
      window.addEventListener('mousemove', this.handleActivity)
      window.addEventListener('keydown', this.handleActivity)
      window.addEventListener('click', this.handleActivity)
      window.addEventListener('scroll', this.handleActivity)
      window.addEventListener('touchstart', this.handleActivity)
    }
  }

  /**
   * Stop monitoring and clean up
   */
  stop (): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
      this.timeoutId = null
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('mousemove', this.handleActivity)
      window.removeEventListener('keydown', this.handleActivity)
      window.removeEventListener('click', this.handleActivity)
      window.removeEventListener('scroll', this.handleActivity)
      window.removeEventListener('touchstart', this.handleActivity)
    }
  }

  /**
   * Handle user activity - reset the timeout timer
   */
  private handleActivity = (): void => {
    this.lastActivity = Date.now()
    this.resetTimer()
  }

  /**
   * Reset the timeout timer
   */
  private resetTimer (): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId)
    }

    this.timeoutId = setTimeout(() => {
      this.onTimeout()
    }, this.timeoutDuration)
  }

  /**
   * Get time remaining until timeout.
   * @returns The number of milliseconds remaining before the session times out.
   */
  getTimeRemaining (): number {
    return Math.max(0, this.timeoutDuration - (Date.now() - this.lastActivity))
  }
}

export {
  SESSION_TIMEOUT_MS,
  validatePasswordStrength,
  isProduction,
  secureLog,
  SessionTimeoutManager,
}
