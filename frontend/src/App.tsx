import Header from './components/Header/Header'
import { Routes, Route } from 'react-router-dom'
import Liquidity from './pages/Liquidity/Liquidity'
import InitializeLiquidity from './pages/InitializeForm/InitializeForm'
import DepositForm from './pages/DepositForm/DepositForm'
import Swap from './pages/Swap/Swap'
import Portfolio from './pages/Portfolio/Portfolio'

function App() {

  return (
    <>
      <Header />
      <main>
        <Routes>
          <Route path='/' element={<Swap />} />
          <Route path="/Liquidity" element={<Liquidity />} />
          <Route path="/liquidity/create" element={<InitializeLiquidity />} />
          <Route path="/liquidity/deposit" element={<DepositForm />} />
          <Route path='/portfolio' element={<Portfolio />} />
        </Routes>
      </main>
    </>
  )
}

export default App
