import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-maskable.svg'],
      manifest: {
        name: 'The Proxbox',
        short_name: 'The Proxbox',
        description: 'Spin up a machine. Connect. Get to work.',
        theme_color: '#0d0d0d',
        background_color: '#0d0d0d',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }
        ]
      },
      workbox: {
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api2/]
      }
    })
  ],
  server: {
    proxy: {
      '/api2': {
        target: process.env.PVE_HOST || 'https://192.168.200.100:8006',
        changeOrigin: true,
        secure: false
      }
    }
  }
})
