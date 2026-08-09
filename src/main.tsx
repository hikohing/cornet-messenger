import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Self-hosted (not Google Fonts CDN) so the app keeps working under network
// restrictions and doesn't leak a request to Google on every launch.
import '@fontsource-variable/inter'
import './index.css'
import App from './App.tsx'
import { hydrateSecureStorage } from './native/storage'
import { setupNativeShell } from './native/shell'

function mount() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

// В нативной сборке session token и ключи лежат в Keychain, а он асинхронный:
// без этого ожидания первый же запрос ушёл бы без авторизации. В браузере
// промис резолвится сразу и рендер не задерживается.
void hydrateSecureStorage()
  .catch(() => undefined)
  .then(() => {
    void setupNativeShell()
    mount()
  })
