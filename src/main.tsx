import React from 'react'
import ReactDOM from 'react-dom/client'

import App from '@/App'
import './index.css'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'

// Global error handlers to prevent page reloads on unhandled errors
/**
 * Global error handler that catches unhandled errors and prevents page reloads.
 * @param message - The error message string
 * @param source - The URL of the script where the error occurred
 * @param lineno - The line number where the error occurred
 * @param colno - The column number where the error occurred
 * @param error - The Error object if available
 * @returns True to prevent the default browser error handling
 */
window.onerror = (message, source, lineno, colno, error) => {
  console.error('Global error caught:', { message, source, lineno, colno, error })
  return true
}

/**
 * Catches unhandled promise rejections and prevents them from causing page reloads.
 * @param event - The PromiseRejectionEvent containing the rejection reason
 */
window.onunhandledrejection = (event) => {
  console.error('Unhandled promise rejection:', event.reason)
  event.preventDefault()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
