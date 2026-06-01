import { useEffect, useState } from 'react'
import Header from './components/Header/Header'
import { Routes, Route, useLocation } from 'react-router-dom'
import Liquidity from './pages/Liquidity/Liquidity'
import InitializeLiquidity from './pages/InitializeForm/InitializeForm'
import DepositForm from './pages/DepositForm/DepositForm'
import Swap from './pages/Swap/Swap'
import Portfolio from './pages/Portfolio/Portfolio'
import CreatorFees from './pages/CreatorFees/CreatorFees'
import Admin from './pages/Admin/Admin'
import WithdrawForm from './pages/WithdrawForm/WithdrawForm'
import CollectFees from './pages/Admin/CollectFees'

function PersistentMainPages({ activePath }: { activePath: '/liquidity' | '/swap' | '/portfolio' }) {
  const [visited, setVisited] = useState<{ liquidity: boolean; swap: boolean; portfolio: boolean }>({
    liquidity: true,
    swap: false,
    portfolio: false,
  })

  useEffect(() => {
    if (activePath === '/liquidity' && !visited.liquidity) {
      setVisited((current) => ({ ...current, liquidity: true }))
    }
    if (activePath === '/swap' && !visited.swap) {
      setVisited((current) => ({ ...current, swap: true }))
    }
    if (activePath === '/portfolio' && !visited.portfolio) {
      setVisited((current) => ({ ...current, portfolio: true }))
    }
  }, [activePath, visited.liquidity, visited.swap, visited.portfolio])

  return (
    <>
      {visited.liquidity && (
        <div style={{ display: activePath === '/liquidity' ? 'block' : 'none' }}>
          <Liquidity />
        </div>
      )}
      {visited.swap && (
        <div style={{ display: activePath === '/swap' ? 'block' : 'none' }}>
          <Swap />
        </div>
      )}
      {visited.portfolio && (
        <div style={{ display: activePath === '/portfolio' ? 'block' : 'none' }}>
          <Portfolio />
        </div>
      )}
    </>
  )
}

function App() {
  const location = useLocation()
  const path = location.pathname
  const activePersistentPath = path === '/' ? '/liquidity' : path
  const showPersistent = activePersistentPath === '/liquidity' || activePersistentPath === '/swap' || activePersistentPath === '/portfolio'

  return (
    <>
      <Header />
      <main>
        {showPersistent ? (
          <PersistentMainPages activePath={activePersistentPath as '/liquidity' | '/swap' | '/portfolio'} />
        ) : (
          <Routes>
            <Route path="/liquidity/create" element={<InitializeLiquidity />} />
            <Route path="/liquidity/deposit" element={<DepositForm />} />
            <Route path='/liquidity/withdraw' element={<WithdrawForm />} />
            <Route path='/portfolio/creator-fees' element={<CreatorFees />} />
            <Route path='/admin' element={<Admin />} />
            <Route path='/admin/collect-fees' element={<CollectFees />} />
          </Routes>
        )}
      </main>
    </>
  )
}

export default App
