import { Buffer } from 'buffer'

  ; (window as any).Buffer = Buffer

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Provider } from 'react-redux'
import { SolanaProvider } from './utils/SolanaProvider.tsx'
import { store } from './store'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <SolanaProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </SolanaProvider>
    </Provider>
  </StrictMode>,
)