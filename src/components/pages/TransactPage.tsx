import React, { useState } from 'react'

import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { TransactForm } from '@/components/forms/TransactForm'
import './TransactPage.css'

/**
 * Page component hosting the transaction form with error handling.
 * @returns The transact page with error boundary wrapped form
 */
export const TransactPage: React.FC = () => {
  const [errorMessage, setErrorMessage] = useState<string>('')

  /**
   * Displays a transaction error message that auto-dismisses after 10 seconds.
   * @param error - The error message to display
   */
  const handleTransactionError = (error: string) => {
    setErrorMessage(error)
    setTimeout(() => setErrorMessage(''), 10000)
  }

  return (
    <div className='transact-page'>
      {errorMessage && <div className='message message-error'>{errorMessage}</div>}

      <ErrorBoundary
        fallback={
          <div className='message message-error'>
            Transaction form encountered an error. Please refresh the page and try again.
          </div>
        }
      >
        <TransactForm onError={handleTransactionError} />
      </ErrorBoundary>
    </div>
  )
}
