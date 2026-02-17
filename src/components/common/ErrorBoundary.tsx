import type { ReactNode } from 'react'
import React, { Component } from 'react'

import { isProduction } from '@/utils/security'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * Error Boundary to catch unhandled React errors and prevent page reloads
 */
export class ErrorBoundary extends Component<Props, State> {
  /**
   * Initializes the ErrorBoundary with default non-error state.
   * @param props - The component props including children and optional fallback UI
   */
  constructor (props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  /**
   * Updates component state when a descendant throws an error.
   * @param error - The error thrown by a descendant component
   * @returns Updated state with error information for rendering fallback UI
   */
  static getDerivedStateFromError (error: Error): State {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error }
  }

  /**
   * Logs caught errors and their component stack trace to the console.
   * @param error - The error that was thrown
   * @param errorInfo - React error info containing the component stack
   */
  override componentDidCatch (error: Error, errorInfo: React.ErrorInfo) {
    // Log the error to console for debugging
    console.error('ErrorBoundary caught an error:', error)
    console.error('Error details:', errorInfo)
  }

  /**
   * Renders the fallback UI when an error is caught, or the children otherwise.
   * @returns The fallback error UI or the child component tree
   */
  override render () {
    if (this.state.hasError) {
      // Render fallback UI
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div
          className='error-boundary-fallback'
          style={{
            padding: '20px',
            margin: '20px',
            border: '2px solid #ff4444',
            borderRadius: '8px',
            backgroundColor: '#fff5f5',
          }}
        >
          <h2 style={{ color: '#cc0000' }}>⚠️ Something went wrong</h2>

          <p>An unexpected error occurred. The application has been stabilized.</p>

          {this.state.error && !isProduction() && (
            <details style={{ marginTop: '10px' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 'bold' }}>Error details</summary>

              <pre
                style={{
                  marginTop: '10px',
                  padding: '10px',
                  backgroundColor: '#f5f5f5',
                  borderRadius: '4px',
                  overflow: 'auto',
                  fontSize: '12px',
                }}
              >
                {this.state.error.message}

                {'\n\n'}

                {this.state.error.stack}
              </pre>
            </details>
          )}

          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              marginTop: '15px',
              padding: '10px 20px',
              backgroundColor: '#0066cc',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Try Again
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
