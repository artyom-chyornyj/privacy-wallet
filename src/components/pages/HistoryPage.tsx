import React from 'react'

import { TransactionList } from '@/components/common/TransactionList'
import './HistoryPage.css'

/**
 * Page component displaying the transaction history list.
 * @returns The history page with the transaction list
 */
export const HistoryPage: React.FC = () => {
  return (
    <div className='page-container history-page'>
      <div className='history-content'>
        <TransactionList />
      </div>
    </div>
  )
}
