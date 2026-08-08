import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted (not Google Fonts CDN) so the app keeps working under network
// restrictions and doesn't leak a request to Google on every launch.
import '@fontsource-variable/inter'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
