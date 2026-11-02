export type WebRTCState = 'connecting' | 'signaling' | 'receiving' | 'playing' | 'failed' | 'disconnected'

export class WebRTCManager {
  private socket: WebSocket | null = null
  private peer: RTCPeerConnection | null = null
  private pendingStart = false
  private starting = false

  constructor(
    private readonly onStream: (stream: MediaStream) => void,
    private readonly onState: (state: WebRTCState) => void,
  ) {}

  connect(): void {
    this.onState('connecting')
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    this.socket = new WebSocket(`${protocol}//${window.location.host}/ws/webrtc`)
    this.socket.onopen = () => {
      this.onState('signaling')
      if (this.pendingStart) this.startCombinedStream().catch(console.error)
    }
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data) as { type: string; sdp?: string }
      if (message.type === 'answer' && message.sdp && this.peer) {
        void this.peer.setRemoteDescription({ type: 'answer', sdp: message.sdp }).then(() => {
          if (this.peer?.connectionState !== 'connected') this.onState('receiving')
        }).catch(error => {
          this.onState('failed')
          console.error('WebRTC answer rejected:', error)
        })
      }
      if (message.type === 'error') {
        this.onState('failed')
        console.error('WebRTC signaling error:', message)
      }
      if (message.type === 'ping') this.socket?.send(JSON.stringify({ type: 'pong' }))
    }
    this.socket.onerror = () => this.onState('failed')
    this.socket.onclose = () => this.onState('disconnected')
  }

  async startCombinedStream(): Promise<void> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.pendingStart = true
      return
    }
    if (this.starting) return
    this.starting = true
    this.pendingStart = false
    this.starting = false
    this.peer?.close()
    const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    this.peer = peer
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') this.onState('receiving')
      if (peer.connectionState === 'failed') this.onState('failed')
      if (peer.connectionState === 'disconnected' || peer.connectionState === 'closed') {
        this.onState('disconnected')
      }
    }
    peer.oniceconnectionstatechange = () => {
      if (peer.iceConnectionState === 'failed') this.onState('failed')
    }
    peer.addTransceiver('video', { direction: 'recvonly' })
    peer.ontrack = event => {
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
    this.peer?.close()
    this.peer = null
    this.socket?.close(1000)
    this.socket = null
    this.onState('disconnected')
  }
}
