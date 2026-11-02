export type WebRTCState = 'connecting' | 'signaling' | 'receiving' | 'playing' | 'failed' | 'disconnected'

export class WebRTCManager {
  private socket: WebSocket | null = null
  private peer: RTCPeerConnection | null = null
  private pendingStart = false
  private starting = false
  private connectionTimer: number | null = null

  constructor(
    private readonly onStream: (stream: MediaStream) => void,
    private readonly onState: (state: WebRTCState) => void,
  ) {}

  connect(): void {
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return
    this.onState('connecting')
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/webrtc`)
    this.socket = socket
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.onState('signaling')
      if (this.pendingStart) void this.startCombinedStream()
    }
    socket.onmessage = event => {
      if (this.socket !== socket) return
      let message: { type?: string; sdp?: string; message?: string }
      try {
        message = JSON.parse(event.data) as typeof message
      } catch (error) {
        console.error('Invalid WebRTC signaling message:', error)
        return
      }
      if (message.type === 'answer' && message.sdp && this.peer) {
        const peer = this.peer
        void peer.setRemoteDescription({ type: 'answer', sdp: message.sdp }).then(() => {
          if (this.peer === peer && peer.connectionState !== 'connected') this.onState('receiving')
          this.startConnectionTimeout(peer)
        }).catch(error => {
          this.onState('failed')
          console.error('WebRTC answer rejected:', error)
        })
      } else if (message.type === 'error') {
        this.onState('failed')
        console.error('WebRTC signaling error:', message.message ?? message)
      } else if (message.type === 'ping' && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'pong' }))
      }
    }
    socket.onerror = event => {
      console.error('WebRTC signaling socket error:', event)
      if (this.socket === socket) this.onState('failed')
    }
    socket.onclose = () => {
      if (this.socket === socket) {
        this.clearConnectionTimeout()
        this.onState('disconnected')
      }
    }
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimer !== null) {
      window.clearTimeout(this.connectionTimer)
      this.connectionTimer = null
    }
  }

  private startConnectionTimeout(peer: RTCPeerConnection): void {
    this.clearConnectionTimeout()
    this.connectionTimer = window.setTimeout(() => {
      if (this.peer === peer && peer.connectionState !== 'connected') {
        console.error('WebRTC ICE did not connect within 20 seconds:', {
          connectionState: peer.connectionState,
          iceConnectionState: peer.iceConnectionState,
          iceGatheringState: peer.iceGatheringState,
        })
        this.onState('failed')
      }
    }, 20000)
  }

  async startCombinedStream(): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.pendingStart = true
      return
    }
    if (this.starting) return
    this.starting = true
    this.pendingStart = false
    this.clearConnectionTimeout()
    this.peer?.close()

    // Dashboard and phones are on the same LAN. Host candidates avoid
    // depending on public STUN reachability or router NAT hairpin behaviour.
    const peer = new RTCPeerConnection({ iceServers: [] })
    this.peer = peer

    peer.onconnectionstatechange = () => {
      if (this.peer !== peer) return
      console.info('WebRTC connection state:', peer.connectionState, 'ICE:', peer.iceConnectionState)
      if (peer.connectionState === 'connected') {
        this.clearConnectionTimeout()
        this.onState('receiving')
      } else if (peer.connectionState === 'failed') {
        this.clearConnectionTimeout()
        this.onState('failed')
      } else if (peer.connectionState === 'disconnected' || peer.connectionState === 'closed') {
        this.onState('disconnected')
      }
    }
    peer.oniceconnectionstatechange = () => {
      if (this.peer !== peer) return
      console.info('WebRTC ICE state:', peer.iceConnectionState)
      if (peer.iceConnectionState === 'failed') this.onState('failed')
    }
    peer.addTransceiver('video', { direction: 'recvonly' })
    peer.ontrack = event => {
      if (this.peer !== peer) return
      const stream = event.streams[0] ?? new MediaStream([event.track])
      this.onStream(stream)
      this.onState('receiving')
    }

    try {
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      await new Promise<void>((resolve, reject) => {
        if (peer.iceGatheringState === 'complete') return resolve()
        const timeout = window.setTimeout(() => {
          if (peer.iceGatheringState === 'complete') resolve()
          else reject(new Error('ICE gathering timed out before local candidates were collected'))
        }, 10000)
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') {
            window.clearTimeout(timeout)
            resolve()
          }
        })
      })
      if (this.socket?.readyState !== WebSocket.OPEN || this.peer !== peer) {
        throw new Error('WebRTC signaling socket closed before offer was sent')
      }
      const sdp = peer.localDescription?.sdp
      if (!sdp) throw new Error('Browser produced an empty WebRTC offer')
      console.info('Sending WebRTC offer; host ICE candidates:', (sdp.match(/^a=candidate:/gm) ?? []).length)
      this.socket.send(JSON.stringify({ type: 'offer', sdp }))
    } catch (error) {
      this.onState('failed')
      console.error('Could not start WebRTC stream:', error)
      peer.close()
      if (this.peer === peer) this.peer = null
    } finally {
      this.starting = false
    }
  }

  disconnect(): void {
    this.pendingStart = false
    this.starting = false
    this.clearConnectionTimeout()
    this.peer?.close()
    this.peer = null
    this.socket?.close(1000)
    this.socket = null
    this.onState('disconnected')
  }
}
