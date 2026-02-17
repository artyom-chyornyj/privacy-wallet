/**
 * Checks environment variables and localStorage flags to determine if debug logging is enabled.
 * @returns True if any debug flag is set
 */
const isDebug = (): boolean => {
  try {
    // Node/Vitest
    if (
      typeof process !== 'undefined' &&
      process.env &&
      (process.env['DEBUG'] === '1')
    ) {
      return true
    }
  } catch {}

  try {
    // Browser: check settings store (read directly from localStorage to avoid circular imports)
    if (typeof window !== 'undefined') {
      const settingsRaw = window.localStorage?.getItem('privacy-wallet-settings')
      if (settingsRaw) {
        try {
          const settings = JSON.parse(settingsRaw)
          if (settings?.state?.debugEnabled) return true
        } catch {}
      }
    }
  } catch {}

  return false
}

/**
 * Logs a message to the console only when debug mode is enabled.
 * @param args - The values to log
 */
const dlog = (...args: unknown[]) => {
  if (isDebug()) {
    console.log(...args)
  }
}

/**
 * Logs a warning to the console only when debug mode is enabled.
 * @param args - The values to log as a warning
 */
const dwarn = (...args: unknown[]) => {
  if (isDebug()) {
    console.warn(...args)
  }
}

/**
 * Logs an error to the console only when debug mode is enabled.
 * @param args - The values to log as an error
 */
const derror = (...args: unknown[]) => {
  if (isDebug()) {
    console.error(...args)
  }
}

export { dlog, dwarn, derror }
