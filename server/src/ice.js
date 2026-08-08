const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

export function buildIceServers() {
  const servers = [...STUN_SERVERS]
  const urls = String(process.env.TURN_URLS || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)
  const username = process.env.TURN_USERNAME
  const credential = process.env.TURN_CREDENTIAL

  if (urls.length > 0 && username && credential) {
    servers.push({ urls, username, credential })
  }

  return servers
}
