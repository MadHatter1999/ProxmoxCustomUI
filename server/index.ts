import express from 'express'
import { createProxyMiddleware } from 'http-proxy-middleware'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PVE_HOST = process.env.PVE_HOST ?? 'https://192.168.200.100:8006'
const PORT = Number(process.env.PORT ?? 8080)

const app = express()

// Proxy the Proxmox API: solves browser CORS and the self-signed PVE certificate.
app.use(
  createProxyMiddleware({
    pathFilter: '/api2',
    target: PVE_HOST,
    changeOrigin: true,
    secure: false
  })
)

const dist = path.resolve(here, '..', 'dist')
app.use(express.static(dist))
app.get('*', (_req, res) => {
  res.sendFile(path.join(dist, 'index.html'))
})

if (process.env.HTTPS === '1') {
  // PWA installability needs a secure context off-localhost; generate a
  // self-signed cert on first run (team accepts it once per browser).
  const certDir = path.resolve(here, '..', '.cert')
  const keyFile = path.join(certDir, 'key.pem')
  const certFile = path.join(certDir, 'cert.pem')
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    const { default: selfsigned } = await import('selfsigned')
    const pems = selfsigned.generate([{ name: 'commonName', value: 'proxbox.local' }], {
      days: 3650,
      keySize: 2048
    })
    fs.mkdirSync(certDir, { recursive: true })
    fs.writeFileSync(keyFile, pems.private)
    fs.writeFileSync(certFile, pems.cert)
    console.log(`Generated self-signed certificate in ${certDir}`)
  }
  https
    .createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, app)
    .listen(PORT, () => console.log(`ProxBox Spin-Up (https) on port ${PORT} → ${PVE_HOST}`))
} else {
  app.listen(PORT, () => console.log(`ProxBox Spin-Up on port ${PORT} → ${PVE_HOST}`))
}
