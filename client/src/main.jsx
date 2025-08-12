import React from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import App from './App'
import './styles.css'
import Room from './pages/Room'
import Host from './pages/Host'

const router = createBrowserRouter([
  { path: '/', element: <App /> },
  { path: '/room/:roomId', element: <Room /> },
  { path: '/host/:roomId', element: <Host /> },
], {
  future: {
    v7_startTransition: true
  }
})

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>
)