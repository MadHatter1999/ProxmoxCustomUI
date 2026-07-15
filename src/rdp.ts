/**
 * Builds a full-fat .rdp file: the machine's IP, the login assigned at spin-up
 * (as a local account, `.\user`), 1080p, and everything shared/redirected.
 */
export function buildRdp(ip: string, user?: string): string {
  const lines = [
    `full address:s:${ip}`,
    ...(user ? [`username:s:.\\${user}`] : []),
    'prompt for credentials:i:0',
    'administrative session:i:0',
    'screen mode id:i:2',
    'use multimon:i:0',
    'desktopwidth:i:1920',
    'desktopheight:i:1080',
    'session bpp:i:32',
    'compression:i:1',
    'keyboardhook:i:2',
    'audiocapturemode:i:0',
    'videoplaybackmode:i:1',
    'connection type:i:7',
    'networkautodetect:i:1',
    'bandwidthautodetect:i:1',
    'displayconnectionbar:i:1',
    'enableworkspacereconnect:i:0',
    'disable wallpaper:i:0',
    'allow font smoothing:i:1',
    'allow desktop composition:i:1',
    'disable full window drag:i:0',
    'disable menu anims:i:0',
    'disable themes:i:0',
    'disable cursor setting:i:0',
    'bitmapcachepersistenable:i:1',
    // share everything
    'audiomode:i:0',
    'redirectclipboard:i:1',
    'redirectdrives:i:1',
    'drivestoredirect:s:*',
    'redirectprinters:i:1',
    'redirectcomports:i:1',
    'redirectsmartcards:i:1',
    'redirectposdevices:i:0',
    'autoreconnection enabled:i:1'
  ]
  return lines.join('\r\n') + '\r\n'
}

export function downloadRdp(name: string, ip: string, user?: string) {
  const blob = new Blob([buildRdp(ip, user)], { type: 'application/x-rdp' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${name}.rdp`
  a.click()
  URL.revokeObjectURL(a.href)
}
