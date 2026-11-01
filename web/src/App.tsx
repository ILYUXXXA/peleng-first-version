import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import { VisionWebSocketService, type VisionMetadata } from './services/VisionWebSocket'
import { WebRTCManager, type WebRTCState } from './services/WebRTCManager'
import { PhonePublisher } from './PhonePublisher'

type Screen = 'dashboard' | 'world' | 'settings'
type Status = {
  enabled: boolean
  model: string
  detector_backend: string
  tracker_backend: string
  vision_fps: number
  avg_processing_time_ms: number
  calibration: { valid: boolean; camera_ids: number[] }
  target: { state: string; mode?: string }
}
type Camera = {
  id: number
  name: string
  stream_url: string
  enabled: boolean
  status: string
}

const emptyStatus: Status = {
  enabled: false,
  model: '—',
  detector_backend: '—',
  tracker_backend: '—',
  vision_fps: 0,
  avg_processing_time_ms: 0,
  calibration: { valid: false, camera_ids: [] },
  target: { state: 'idle' },
}

function DesktopApp() {
  const [screen, setScreen] = useState<Screen>('dashboard')
  const [status, setStatus] = useState<Status>(emptyStatus)
  const [metadata, setMetadata] = useState<VisionMetadata | null>(null)
  const [classIds, setClassIds] = useState('0')
  const [weights, setWeights] = useState('yolo26n.pt')
  const [tracker, setTracker] = useState('deepsort')
  const [notice, setNotice] = useState('')
  const [cameraNotice, setCameraNotice] = useState('')
  const [cameras, setCameras] = useState<Camera[]>([])
  const [cameraForm, setCameraForm] = useState({ id: '0', name: 'iPhone RTSP', url: '' })
  const [cameraSize, setCameraSize] = useState({ width: 720, height: 480 })
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null)
  const [webrtcState, setWebRTCState] = useState<WebRTCState>('connecting')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const webrtc = useRef<WebRTCManager | null>(null)

  const refreshStatus = async () => {
    const response = await fetch('/api/vision/status')
    if (response.ok) {
      const next = await response.json() as Status
      setStatus(next)
      setWeights(next.model)
      setTracker(next.tracker_backend)
    }
  }

  const refreshCameras = async () => {
    const response = await fetch('/api/cameras')
    if (response.ok) setCameras(await response.json() as Camera[])
  }

  useEffect(() => {
    refreshStatus().catch(() => undefined)
    refreshCameras().catch(() => undefined)
    fetch('/api/cameras/config').then(response => response.json()).then(data => setCameraSize(data.individual_resolution)).catch(() => undefined)
    const vision = new VisionWebSocketService()
    vision.onMessage = message => {
      if (message.type === 'vision_metadata') setMetadata(message)
    }
    vision.connect()
    const rtc = new WebRTCManager(setMediaStream, setWebRTCState)
    rtc.connect()
    webrtc.current = rtc
    const timer = window.setTimeout(() => rtc.startCombinedStream().catch(() => undefined), 300)
    return () => {
      window.clearTimeout(timer)
      vision.disconnect()
      rtc.disconnect()
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (screen !== 'dashboard' || !video || !mediaStream) return
    video.srcObject = mediaStream
    video.play().catch(() => setWebRTCState('failed'))
    return () => {
      if (video.srcObject === mediaStream) video.srcObject = null
    }
  }, [mediaStream, screen])

  const tracks = useMemo(
    () => Object.entries(metadata?.all_streams ?? {}).flatMap(([cameraId, stream]) =>
      stream.tracks.map(track => ({ ...track, cameraId: Number(cameraId) }))),
    [metadata],
  )

  const selectTrack = async (cameraId: number, trackId: string) => {
    await fetch('/api/vision/target', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'track', camera_id: cameraId, track_id: trackId }),
    })
    await refreshStatus()
  }

  const selectClasses = async () => {
    const ids = classIds.split(',').map(value => Number(value.trim())).filter(Number.isFinite)
    await fetch('/api/vision/target', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'class', class_ids: ids }),
    })
    await refreshStatus()
  }

  const restart = async () => {
    setNotice('Проверяем и прогреваем новую конфигурацию…')
    const response = await fetch('/api/vision/restart', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vision: {
        detector: { backend: 'ultralytics', weights, confidence: 0.25, iou: 0.7, device: 'auto', image_size: 640 },
        tracker: { backend: tracker },
        geometry: { mode: 'auto', calibration_file: 'config/calibration.yaml', max_sync_skew_ms: 50, max_reprojection_error_px: 5 },
        fps: 10,
      }}),
    })
    setNotice(response.ok ? 'Конфигурация применена.' : 'Новая конфигурация отклонена; активная не изменена.')
    await refreshStatus()
  }

  const toggleVision = async () => {
    await fetch(`/api/cameras/tracking/${status.enabled ? 'stop' : 'start'}`, { method: 'POST' })
    await refreshStatus()
  }

  const addCamera = async () => {
    setCameraNotice('Подключаем источник…')
    const response = await fetch('/api/cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: Number(cameraForm.id),
        name: cameraForm.name,
        url: cameraForm.url,
        enabled: true,
      }),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Не удалось добавить камеру' }))
      const detail = Array.isArray(error.detail) ? error.detail[0]?.msg : error.detail
      setCameraNotice(detail ?? 'Не удалось добавить камеру')
      return
    }
    setCameraForm(current => ({ ...current, url: '' }))
    setCameraNotice('Камера добавлена. Подключение продолжается в фоне.')
    await refreshCameras()
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div><p className="eyebrow">Space Hackathon · prototype</p><h1>Peleng Tracker</h1></div>
        <button className={`health ${status.enabled ? 'online' : ''}`} onClick={toggleVision}><span />{status.enabled ? 'Vision online' : 'Start vision'}</button>
      </header>
      <nav className="tabs" aria-label="Основные экраны">
        {([['dashboard', 'Dashboard'], ['world', 'World View'], ['settings', 'Calibration / Settings']] as const).map(([id, label]) =>
          <button key={id} className={screen === id ? 'active' : ''} onClick={() => setScreen(id)}>{label}</button>)}
      </nav>

      {screen === 'dashboard' && <main className="dashboard">
        <section className="video-panel panel">
          <div className="section-title"><div><p className="eyebrow">Live</p><h2>Объединённый поток</h2></div><span>{metadata?.active_stream_ids.length ?? 0} камер</span></div>
          <div className="video-stage"><video ref={videoRef} id="combined-video-main" autoPlay playsInline muted onPlaying={() => setWebRTCState('playing')} /><div className={`video-empty ${webrtcState === 'playing' ? 'hidden' : ''}`}>{webrtcState === 'failed' ? 'Ошибка WebRTC — обновите страницу' : webrtcState === 'disconnected' ? 'WebRTC отключён' : 'Подключаем WebRTC-поток…'}</div>
            <div className="box-overlay">{tracks.map(track => {
              const cameraIds = metadata?.active_stream_ids ?? []
              const index = Math.max(0, cameraIds.indexOf(track.cameraId))
              const columns = Math.max(1, Math.ceil(Math.sqrt(cameraIds.length || 1)))
              const rows = Math.max(1, Math.ceil((cameraIds.length || 1) / columns))
              const [x, y, width, height] = track.bbox
              return <button aria-label={`Выбрать ${track.class_name} ${track.id}`} key={`box:${track.cameraId}:${track.id}`} className="target-box" onClick={() => selectTrack(track.cameraId, track.id)} style={{ left: `${((index % columns) + x / cameraSize.width) * 100 / columns}%`, top: `${(Math.floor(index / columns) + y / cameraSize.height) * 100 / rows}%`, width: `${width * 100 / cameraSize.width / columns}%`, height: `${height * 100 / cameraSize.height / rows}%` }}><span>{track.class_name} #{track.id}</span></button>
            })}</div>
          </div>
          <p className="hint">Нажмите на активный трек ниже, чтобы назначить конкретную цель.</p>
          <div className="track-list">
            {tracks.map(track => <button key={`${track.cameraId}:${track.id}`} onClick={() => selectTrack(track.cameraId, track.id)}>
              <span className="track-id">#{track.id}</span><span>{track.class_name}</span><small>camera {track.cameraId}</small>
            </button>)}
            {!tracks.length && <p className="muted">Треки появятся после запуска vision pipeline.</p>}
          </div>
        </section>
        <aside className="side-column">
          <section className="panel"><p className="eyebrow">Target</p><h2>{status.target.state}</h2>
            <label>Классы COCO<input value={classIds} onChange={event => setClassIds(event.target.value)} placeholder="0, 2, 7" /></label>
            <button className="primary" onClick={selectClasses}>Искать по классу</button>
          </section>
          <section className="panel metrics"><p className="eyebrow">Runtime</p>
            <dl><div><dt>Model</dt><dd>{status.model}</dd></div><div><dt>Tracker</dt><dd>{status.tracker_backend}</dd></div><div><dt>FPS</dt><dd>{status.vision_fps.toFixed(1)}</dd></div><div><dt>Latency</dt><dd>{status.avg_processing_time_ms.toFixed(1)} ms</dd></div><div><dt>Sync skew</dt><dd>{metadata?.sync_skew_ms.toFixed(1) ?? '0.0'} ms</dd></div></dl>
          </section>
        </aside>
      </main>}

      {screen === 'world' && <main className="world-layout">
        <section className="panel world-map"><div className="section-title"><div><p className="eyebrow">Meters · right-handed</p><h2>World View</h2></div></div>
          <div className="grid-map">{metadata?.world_tracks.map(track => track.position_xyz_m && <button key={track.global_id} className={track.is_target ? 'world-dot target' : 'world-dot'} style={{ left: `${50 + track.position_xyz_m[0] * 5}%`, top: `${50 - track.position_xyz_m[1] * 5}%` }} title={track.global_id} />)}</div>
        </section>
        <section className="panel world-cards">{metadata?.world_tracks.map(track => <article key={track.global_id}><strong>{track.global_id}</strong><span>{track.class_name}</span><code>{track.position_xyz_m ? track.position_xyz_m.map(v => v.toFixed(2)).join(', ') : 'unavailable'}</code><small>{track.position_status}</small></article>)}{!metadata?.world_tracks.length && <p className="muted">Нет мировых треков.</p>}</section>
      </main>}

      {screen === 'settings' && <main className="settings-layout">
        <section className="panel"><p className="eyebrow">Controlled restart</p><h2>Модель и трекер</h2>
          <label>YOLO weights<input value={weights} onChange={event => setWeights(event.target.value)} /></label>
          <label>Tracker<select value={tracker} onChange={event => setTracker(event.target.value)}><option value="deepsort">DeepSORT</option><option value="botsort">BoT-SORT</option></select></label>
          <button className="primary" onClick={restart}>Проверить и применить</button>{notice && <p className="notice">{notice}</p>}
        </section>
        <section className="panel"><p className="eyebrow">Calibration</p><h2>{status.calibration.valid ? 'ready' : 'unavailable'}</h2><p>{status.calibration.camera_ids.length} откалиброванных камер</p>
          <label>Calibration YAML / JSON<input type="file" accept=".yaml,.yml,.json" onChange={async event => { const file = event.target.files?.[0]; if (!file) return; await fetch('/api/calibration/3d', { method: 'POST', headers: { 'Content-Type': file.name.endsWith('.json') ? 'application/json' : 'application/yaml' }, body: await file.text() }); await refreshStatus() }} /></label>
        </section>
        <section className="panel camera-settings"><p className="eyebrow">Runtime source</p><h2>Добавить камеру</h2>
          <p className="muted">Поддерживаются RTSP, RTSPS, RTMP и HTTP/MJPEG. Источник действует до перезапуска сервера.</p>
          <div className="camera-fields">
            <label>Camera ID<input type="number" min="0" value={cameraForm.id} onChange={event => setCameraForm(current => ({ ...current, id: event.target.value }))} /></label>
            <label>Название<input value={cameraForm.name} maxLength={80} onChange={event => setCameraForm(current => ({ ...current, name: event.target.value }))} /></label>
          </div>
          <label>Ссылка на поток<input type="url" value={cameraForm.url} placeholder="rtsp://user:password@192.168.1.20:8554/live" autoComplete="off" spellCheck={false} onChange={event => setCameraForm(current => ({ ...current, url: event.target.value }))} /></label>
          <button className="primary" disabled={!cameraForm.name.trim() || !cameraForm.url.trim()} onClick={addCamera}>Добавить без перезапуска</button>
          {cameraNotice && <p className="notice">{cameraNotice}</p>}
          <div className="camera-list" aria-live="polite">
            {cameras.map(camera => <article key={camera.id}><div><strong>{camera.name}</strong><small>camera {camera.id}</small></div><code>{camera.stream_url}</code><span className={`camera-status ${camera.status}`}>{camera.status}</span></article>)}
            {!cameras.length && <p className="muted">Камеры пока не добавлены.</p>}
          </div>
        </section>
      </main>}
    </div>
  )
}

function App() {
  return window.location.pathname === '/phone' ? <PhonePublisher /> : <DesktopApp />
}

export default App
