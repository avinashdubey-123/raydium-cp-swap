import Header from './components/Header/Header'
import { Routes, Route } from 'react-router-dom'
import Liquidity from './pages/Liquidity/Liquidity'
import InitializeLiquidity from './pages/InitializeForm/InitializeForm'
import DepositForm from './pages/DepositForm/DepositForm'
import Swap from './pages/Swap/Swap'
import Portfolio from './pages/Portfolio/Portfolio'
import CreatorFees from './pages/CreatorFees/CreatorFees'
import Admin from './pages/Admin/Admin'
import WithdrawForm from './pages/WithdrawForm/WithdrawForm'
import CollectFees from './pages/Admin/CollectFees'

function App() {

  return (
    <>
      <Header />
      <main>
        <Routes>
          <Route path='/' element={<Liquidity />} />
          <Route path='/liquidity' element={<Liquidity />} />
          <Route path="/swap" element={<Swap />} />
          <Route path="/liquidity/create" element={<InitializeLiquidity />} />
          <Route path="/liquidity/deposit" element={<DepositForm />} />
          <Route path='/liquidity/withdraw' element={<WithdrawForm />} />
          <Route path='/portfolio' element={<Portfolio />} />
          <Route path='/portfolio/creator-fees' element={<CreatorFees />} />
          <Route path='/admin' element={<Admin />} />
          <Route path='/admin/collect-fees' element={<CollectFees />} />
          
        </Routes>
      </main>
    </>
  )
}

export default App
