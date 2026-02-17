import React from 'react'
import './Navigation.css'

type TabType = 'balances' | 'history' | 'transact'

interface NavigationProps {
  activeTab: TabType
  onTabChange: (tab: TabType) => void
}

/**
 * Tab navigation bar for switching between Balances, History, and Transact pages.
 * @param root0 - The component props
 * @param root0.activeTab - The currently selected tab
 * @param root0.onTabChange - Callback invoked when a tab is clicked
 * @returns The navigation component with tab buttons
 */
const Navigation: React.FC<NavigationProps> = ({ activeTab, onTabChange }) => {
  return (
    <nav className='navigation'>
      <button
        className={`nav-tab ${activeTab === 'balances' ? 'active' : ''}`}
        onClick={() => onTabChange('balances')}
      >
        Balances
      </button>
      <button
        className={`nav-tab ${activeTab === 'history' ? 'active' : ''}`}
        onClick={() => onTabChange('history')}
      >
        History
      </button>
      <button
        className={`nav-tab ${activeTab === 'transact' ? 'active' : ''}`}
        onClick={() => onTabChange('transact')}
      >
        Transact
      </button>
    </nav>
  )
}

export type { TabType }
export { Navigation }
