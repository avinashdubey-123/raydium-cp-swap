import { useEffect, useState } from 'react'
import Header from './components/Header/Header'
import { useLocation } from 'react-router-dom'
import Liquidity from './pages/Liquidity/Liquidity'
import InitializeLiquidity from './pages/InitializeForm/InitializeForm'
import DepositForm from './pages/DepositForm/DepositForm'
import Swap from './pages/Swap/Swap'
import Portfolio from './pages/Portfolio/Portfolio'
import CreatorFees from './pages/CreatorFees/CreatorFees'
import Admin from './pages/Admin/Admin'
import WithdrawForm from './pages/WithdrawForm/WithdrawForm'
import CollectFees from './pages/Admin/CollectFees'

function PersistentPages({ activePath }: { activePath: string }) {
  const [visited, setVisited] = useState<Record<string, boolean>>({
    '/liquidity': true,
  })

  useEffect(() => {
    // Treat '/' as '/liquidity'
    const path = activePath === '/' ? '/liquidity' : activePath;
    if (path && !visited[path]) {
      setVisited((current) => ({ ...current, [path]: true }))
    }
  }, [activePath, visited])

  const isPath = (path: string) => {
    if (path === '/liquidity' && (activePath === '/' || activePath === '/liquidity')) return true;
    return activePath === path;
  };

  return (
    <>
      {visited['/liquidity'] && (
        <div style={{ display: isPath('/liquidity') ? 'block' : 'none' }}>
          <Liquidity />
        </div>
      )}
      {visited['/swap'] && (
        <div style={{ display: isPath('/swap') ? 'block' : 'none' }}>
          <Swap />
        </div>
      )}
      {visited['/portfolio'] && (
        <div style={{ display: isPath('/portfolio') ? 'block' : 'none' }}>
          <Portfolio />
        </div>
      )}
      {visited['/liquidity/create'] && (
        <div style={{ display: isPath('/liquidity/create') ? 'block' : 'none' }}>
          <InitializeLiquidity />
        </div>
      )}
      {visited['/liquidity/deposit'] && (
        <div style={{ display: isPath('/liquidity/deposit') ? 'block' : 'none' }}>
          <DepositForm />
        </div>
      )}
      {visited['/liquidity/withdraw'] && (
        <div style={{ display: isPath('/liquidity/withdraw') ? 'block' : 'none' }}>
          <WithdrawForm />
        </div>
      )}
      {visited['/portfolio/creator-fees'] && (
        <div style={{ display: isPath('/portfolio/creator-fees') ? 'block' : 'none' }}>
          <CreatorFees />
        </div>
      )}
      {visited['/admin'] && (
        <div style={{ display: isPath('/admin') ? 'block' : 'none' }}>
          <Admin />
        </div>
      )}
      {visited['/admin/collect-fees'] && (
        <div style={{ display: isPath('/admin/collect-fees') ? 'block' : 'none' }}>
          <CollectFees />
        </div>
      )}
    </>
  )
}

function App() {
  const location = useLocation()
  const path = location.pathname

  return (
    <>
      <Header />
      <main>
        <PersistentPages activePath={path} />
      </main>
    </>
  )
}

export default App
