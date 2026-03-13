import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Phase = 'upload' | 'ready' | 'converting' | 'done' | 'error'

interface VideoInfo {
  width: number | null
  height: number | null
  fps: number
  codec: string | null
  duration: number
  size: number
}

interface CropRegion {
  x: number
  y: number
  w: number
  h: number
}

// 로그 스케일: 슬라이더 0~1 → 0.1x~1000x
const MIN_SPEED = 0.1
const MAX_SPEED = 1000
const LOG_RATIO = Math.log(MAX_SPEED / MIN_SPEED)

const toSlider = (speed: number): number =>
  Math.log(speed / MIN_SPEED) / LOG_RATIO

const fromSlider = (val: number): number =>
  MIN_SPEED * Math.exp(val * LOG_RATIO)

function formatSpeed(speed: number): string {
  if (speed >= 100) return speed.toFixed(0)
  if (speed >= 10) return speed.toFixed(1).replace(/\.0$/, '')
  if (speed >= 1) return speed.toFixed(2).replace(/\.?0+$/, '')
  return speed.toFixed(3).replace(/\.?0+$/, '')
}

function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = Math.floor(secs % 60)
  return [h, m, s].map((v) => String(v).padStart(2, '0')).join(':')
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

const PRESETS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 100]
const ACCEPTED_TYPES = /\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v|ts|mts)$/i
const OUTPUT_FORMATS = ['mp4', 'mov', 'webm'] as const
type OutputFormat = (typeof OUTPUT_FORMATS)[number]

export default function App() {
  const [phase, setPhase] = useState<Phase>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [speed, setSpeed] = useState<number>(2)
  const [speedInput, setSpeedInput] = useState<string>('2')
  const [jobId, setJobId] = useState<string | null>(null)
  const [progress, setProgress] = useState<number>(0)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  // A: 비디오 정보
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null)
  // D: 구간 선택
  const [trimStart, setTrimStart] = useState<number>(0)
  const [trimEnd, setTrimEnd] = useState<number>(0)
  // E: CRF
  const [crf, setCrf] = useState<number>(23)
  // F: 출력 포맷
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('mp4')
  // 고급 옵션 접기/펼치기
  const [showAdvanced, setShowAdvanced] = useState(false)
  // 크롭
  const [cropRegion, setCropRegion] = useState<CropRegion | null>(null)
  const [cropMode, setCropMode] = useState(false)
  // 드래그 중 화면에 보여줄 사각형 (컨테이너 좌표, px)
  const [dragRect, setDragRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)
  const cropOverlayRef = useRef<HTMLDivElement>(null)
  const cropDragStartRef = useRef<{ x: number; y: number } | null>(null)

  // 미리보기: HTML5 playbackRate 동기화 (브라우저 최대 ~16x)
  useEffect(() => {
    if (videoRef.current) {
      const capped = Math.min(Math.max(speed, 0.0625), 16)
      videoRef.current.playbackRate = capped
    }
  }, [speed])

  // Object URL 정리
  useEffect(() => {
    return () => {
      if (videoUrl) URL.revokeObjectURL(videoUrl)
    }
  }, [videoUrl])

  // cropMode 진입 시 기존 cropRegion을 displayRect로 복원
  useEffect(() => {
    if (cropMode && cropRegion) {
      const dr = cropRegionToDisplayRect(cropRegion)
      if (dr) setDragRect(dr)
    }
  }, [cropMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── 크롭 좌표 변환 헬퍼 ───────────────────────────────────────────────────
  // video element는 object-contain이므로 실제 렌더링 영역과 컨테이너가 다를 수 있음
  const getVideoRenderBounds = () => {
    const video = videoRef.current
    if (!video || !video.videoWidth || !video.videoHeight) return null
    const cW = video.clientWidth
    const cH = video.clientHeight
    const vW = video.videoWidth
    const vH = video.videoHeight
    const scale = Math.min(cW / vW, cH / vH)
    const renderedW = vW * scale
    const renderedH = vH * scale
    return {
      scale,
      offsetX: (cW - renderedW) / 2,
      offsetY: (cH - renderedH) / 2,
      renderedW,
      renderedH,
    }
  }

  // 오버레이(컨테이너) 좌표 → 실제 비디오 픽셀 좌표
  const containerToVideo = (cx: number, cy: number): { x: number; y: number } | null => {
    const bounds = getVideoRenderBounds()
    const video = videoRef.current
    if (!bounds || !video) return null
    const { scale, offsetX, offsetY } = bounds
    return {
      x: Math.round(Math.max(0, Math.min(video.videoWidth,  (cx - offsetX) / scale))),
      y: Math.round(Math.max(0, Math.min(video.videoHeight, (cy - offsetY) / scale))),
    }
  }

  // 실제 비디오 픽셀 좌표 → 오버레이(컨테이너) 좌표
  const cropRegionToDisplayRect = (cr: CropRegion) => {
    const bounds = getVideoRenderBounds()
    if (!bounds) return null
    const { scale, offsetX, offsetY } = bounds
    return {
      x: cr.x * scale + offsetX,
      y: cr.y * scale + offsetY,
      w: cr.w * scale,
      h: cr.h * scale,
    }
  }

  // ─── 크롭 드래그 핸들러 ────────────────────────────────────────────────────
  const getOverlayRelativePos = (e: React.MouseEvent) => {
    const overlay = cropOverlayRef.current
    if (!overlay) return null
    const rect = overlay.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const handleCropMouseDown = (e: React.MouseEvent) => {
    const pos = getOverlayRelativePos(e)
    if (!pos) return
    cropDragStartRef.current = pos
    setDragRect({ x: pos.x, y: pos.y, w: 0, h: 0 })
  }

  const handleCropMouseMove = (e: React.MouseEvent) => {
    if (!cropDragStartRef.current) return
    const pos = getOverlayRelativePos(e)
    if (!pos) return
    const { x: sx, y: sy } = cropDragStartRef.current
    setDragRect({
      x: Math.min(sx, pos.x),
      y: Math.min(sy, pos.y),
      w: Math.abs(pos.x - sx),
      h: Math.abs(pos.y - sy),
    })
  }

  const handleCropMouseUp = (e: React.MouseEvent) => {
    if (!cropDragStartRef.current) return
    const pos = getOverlayRelativePos(e)
    cropDragStartRef.current = null
    if (!pos) return

    const rect = dragRect
    if (!rect || rect.w < 5 || rect.h < 5) {
      // 너무 작은 드래그는 무시
      return
    }

    // 컨테이너 좌표 → 비디오 픽셀 좌표 변환
    const topLeft     = containerToVideo(rect.x,          rect.y)
    const bottomRight = containerToVideo(rect.x + rect.w, rect.y + rect.h)
    if (topLeft && bottomRight) {
      const newCrop: CropRegion = {
        x: topLeft.x,
        y: topLeft.y,
        w: bottomRight.x - topLeft.x,
        h: bottomRight.y - topLeft.y,
      }
      // FFmpeg crop 홀수 크기 오류 방지: 짝수로 강제
      newCrop.w = newCrop.w % 2 === 0 ? newCrop.w : newCrop.w - 1
      newCrop.h = newCrop.h % 2 === 0 ? newCrop.h : newCrop.h - 1
      if (newCrop.w > 0 && newCrop.h > 0) setCropRegion(newCrop)
    }
  }

  const handleCropMouseLeave = () => {
    // 마우스가 오버레이 밖으로 나가면 드래그 종료
    if (cropDragStartRef.current) {
      cropDragStartRef.current = null
    }
  }

  // ─── 파일 핸들링 ─────────────────────────────────────────────────────────
  const handleFile = useCallback((f: File) => {
    if (!f.type.startsWith('video/') && !ACCEPTED_TYPES.test(f.name)) {
      setError('비디오 파일만 지원됩니다. (MP4, MOV, AVI, MKV, WebM 등)')
      return
    }
    setFile(f)
    const url = URL.createObjectURL(f)
    setVideoUrl(url)
    setPhase('ready')
    setError(null)
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      const f = e.dataTransfer.files[0]
      if (f) handleFile(f)
    },
    [handleFile]
  )

  const handleSpeedChange = (val: number) => {
    const clamped = Math.min(Math.max(val, 0.01), 1000)
    setSpeed(clamped)
    setSpeedInput(formatSpeed(clamped))
  }

  const commitSpeedInput = () => {
    const val = parseFloat(speedInput)
    if (!isNaN(val) && val > 0) {
      handleSpeedChange(val)
    } else {
      setSpeedInput(formatSpeed(speed))
    }
  }

  const handleReset = () => {
    eventSourceRef.current?.close()
    if (videoUrl) URL.revokeObjectURL(videoUrl)
    setPhase('upload')
    setFile(null)
    setVideoUrl(null)
    setJobId(null)
    setProgress(0)
    setError(null)
    setSpeed(2)
    setSpeedInput('2')
    setVideoInfo(null)
    setTrimStart(0)
    setTrimEnd(0)
    setCrf(23)
    setOutputFormat('mp4')
    setShowAdvanced(false)
    setCropRegion(null)
    setCropMode(false)
    setDragRect(null)
  }

  const handleConvert = async () => {
    if (!file) return
    setPhase('converting')
    setProgress(0)
    setError(null)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('speed', speed.toString())
    formData.append('trim_start', trimStart.toString())
    formData.append('trim_end', trimEnd.toString())
    formData.append('crf', crf.toString())
    formData.append('output_format', outputFormat)
    if (cropRegion) {
      formData.append('crop_x', cropRegion.x.toString())
      formData.append('crop_y', cropRegion.y.toString())
      formData.append('crop_w', cropRegion.w.toString())
      formData.append('crop_h', cropRegion.h.toString())
    }

    try {
      const res = await fetch('/api/convert', { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || '업로드 실패')
      }
      const data = await res.json()
      setJobId(data.job_id)
      if (data.video_info) setVideoInfo(data.video_info)

      // SSE로 진행률 수신
      const es = new EventSource(`/api/progress/${data.job_id}`)
      eventSourceRef.current = es

      es.onmessage = (event) => {
        const d = JSON.parse(event.data)
        setProgress(d.progress ?? 0)
        if (d.status === 'done') {
          es.close()
          setPhase('done')
        } else if (d.status === 'cancelled') {
          es.close()
          handleReset()
        } else if (d.status === 'error') {
          es.close()
          setPhase('error')
          setError(d.error ?? '변환 중 오류가 발생했습니다.')
        }
      }
      es.onerror = () => {
        es.close()
        setPhase('error')
        setError('서버 연결이 끊어졌습니다.')
      }
    } catch (err) {
      setPhase('error')
      setError(err instanceof Error ? err.message : '알 수 없는 오류')
    }
  }

  // B: 변환 취소
  const handleCancel = () => {
    if (!jobId) return
    fetch(`/api/cancel/${jobId}`, { method: 'DELETE' }).catch(() => {})
    handleReset()
  }

  // C: 다운로드 후 서버 파일 자동 정리
  const handleDownload = async () => {
    if (!jobId) return
    const res = await fetch(`/api/download/${jobId}`)
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const disposition = res.headers.get('content-disposition') ?? ''
    const match = disposition.match(/filename="?([^"]+)"?/)
    const filename = match ? match[1] : `output.${outputFormat}`
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    fetch(`/api/cleanup/${jobId}`, { method: 'DELETE' }).catch(() => {})
  }

  // 변환 결과 예측 (설정 변경 시 실시간 재계산)
  const estimatedOutput = useMemo(() => {
    if (!videoInfo || !videoInfo.duration) return null

    // 길이: trim → speed 순으로 계산
    const clipDuration =
      trimEnd > 0
        ? Math.max(0, trimEnd - trimStart)
        : Math.max(0, videoInfo.duration - trimStart)
    const outputDuration = speed > 0 ? clipDuration / speed : clipDuration

    // 해상도: 크롭 적용 여부
    const outputW = cropRegion ? cropRegion.w : (videoInfo.width ?? 0)
    const outputH = cropRegion ? cropRegion.h : (videoInfo.height ?? 0)

    // 용량 추정:
    //   원본 bytes/sec × 출력길이 × CRF보정 × 크롭면적비 × 포맷보정
    //   CRF: 6 단위마다 약 2배 차이 (H.264 경험 법칙)
    //   WebM(VP9): 동일 화질에서 H.264 대비 약 40% 절감
    const bytesPerSec = videoInfo.size / videoInfo.duration
    const crfFactor = Math.pow(2, (23 - crf) / 6)
    const cropFactor =
      cropRegion && videoInfo.width && videoInfo.height
        ? (cropRegion.w * cropRegion.h) / (videoInfo.width * videoInfo.height)
        : 1.0
    const formatFactor = outputFormat === 'webm' ? 0.6 : 1.0
    const estimatedBytes = bytesPerSec * outputDuration * crfFactor * cropFactor * formatFactor

    return { duration: outputDuration, width: outputW, height: outputH, estimatedBytes }
  }, [videoInfo, trimStart, trimEnd, speed, cropRegion, crf, outputFormat])

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex flex-col items-center justify-center p-4 py-12">
      {/* 헤더 */}
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-white mb-2 tracking-tight">
          Video Speed Changer
        </h1>
        <p className="text-slate-400 text-base">
          0.01x 슬로우모션부터 1000x 초고속까지 — FFmpeg 서버 사이드 처리
        </p>
      </div>

      {/* 메인 카드 */}
      <div className="w-full max-w-3xl bg-slate-800/60 backdrop-blur-sm border border-slate-700/50 rounded-2xl shadow-2xl">

        {/* ─── 업로드 단계 ─── */}
        {phase === 'upload' && (
          <div className="p-8">
            <div
              className={`border-2 border-dashed rounded-xl p-16 text-center cursor-pointer transition-all duration-200 ${
                isDragging ? 'drop-zone-active' : 'border-slate-600 hover:border-blue-500 hover:bg-slate-700/30'
              }`}
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true) }}
              onDragLeave={() => setIsDragging(false)}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="text-6xl mb-4 select-none">🎬</div>
              <p className="text-xl text-slate-100 font-medium mb-2">
                비디오를 드래그&amp;드롭하거나 클릭하여 선택
              </p>
              <p className="text-slate-500 text-sm">
                MP4 · MOV · AVI · MKV · WebM · FLV · WMV · TS 지원
              </p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
            />
            {error && <p className="mt-4 text-red-400 text-sm text-center">{error}</p>}
          </div>
        )}

        {/* ─── 준비 단계 ─── */}
        {phase === 'ready' && file && videoUrl && (
          <div className="p-6 space-y-5">
            {/* 파일 정보 바 */}
            <div className="flex items-center gap-3 px-4 py-3 bg-slate-700/50 rounded-xl">
              <span className="text-2xl">🎬</span>
              <div className="flex-1 min-w-0">
                <p className="text-slate-100 font-medium truncate">{file.name}</p>
                <p className="text-slate-400 text-xs mt-0.5">
                  {(file.size / 1024 / 1024).toFixed(1)} MB
                </p>
              </div>
              <button
                onClick={handleReset}
                className="text-slate-400 hover:text-slate-100 text-sm px-3 py-1.5 rounded-lg hover:bg-slate-600 transition-colors"
              >
                변경
              </button>
            </div>

            {/* A: 비디오 정보 뱃지 */}
            {videoInfo && (
              <div className="flex flex-wrap gap-2">
                {videoInfo.width && videoInfo.height && (
                  <span className="text-xs px-2.5 py-1 bg-slate-700 text-slate-300 rounded-full">
                    {videoInfo.width}×{videoInfo.height}
                  </span>
                )}
                {videoInfo.fps > 0 && (
                  <span className="text-xs px-2.5 py-1 bg-slate-700 text-slate-300 rounded-full">
                    {Number.isInteger(videoInfo.fps) ? videoInfo.fps : videoInfo.fps.toFixed(2)}fps
                  </span>
                )}
                {videoInfo.codec && (
                  <span className="text-xs px-2.5 py-1 bg-slate-700 text-slate-300 rounded-full uppercase">
                    {videoInfo.codec}
                  </span>
                )}
                {videoInfo.duration > 0 && (
                  <span className="text-xs px-2.5 py-1 bg-slate-700 text-slate-300 rounded-full">
                    {formatDuration(videoInfo.duration)}
                  </span>
                )}
                {videoInfo.size > 0 && (
                  <span className="text-xs px-2.5 py-1 bg-slate-700 text-slate-300 rounded-full">
                    {formatFileSize(videoInfo.size)}
                  </span>
                )}
              </div>
            )}

            {/* 비디오 미리보기 + 크롭 오버레이 */}
            <div className="rounded-xl overflow-hidden bg-black aspect-video relative">
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                className="w-full h-full object-contain"
              />

              {/* 크롭 모드 오버레이 */}
              {cropMode && (
                <div
                  ref={cropOverlayRef}
                  className="absolute inset-0 cursor-crosshair select-none"
                  onMouseDown={handleCropMouseDown}
                  onMouseMove={handleCropMouseMove}
                  onMouseUp={handleCropMouseUp}
                  onMouseLeave={handleCropMouseLeave}
                >
                  {dragRect && dragRect.w > 0 && dragRect.h > 0 ? (
                    <>
                      {/* 선택 영역 외부를 어둡게 (box-shadow 트릭) */}
                      <div
                        className="absolute border-2 border-blue-400 pointer-events-none"
                        style={{
                          left: dragRect.x,
                          top: dragRect.y,
                          width: dragRect.w,
                          height: dragRect.h,
                          boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                        }}
                      />
                      {/* 크기 레이블 */}
                      {cropRegion && (
                        <div
                          className="absolute text-xs text-white bg-blue-600 px-1.5 py-0.5 rounded pointer-events-none"
                          style={{
                            left: dragRect.x,
                            top: Math.max(0, dragRect.y - 22),
                          }}
                        >
                          {cropRegion.w}×{cropRegion.h}
                        </div>
                      )}
                    </>
                  ) : (
                    /* 아직 선택 전: 전체 어두운 오버레이 + 안내 */
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <p className="text-white/70 text-sm pointer-events-none">
                        드래그하여 크롭 영역을 지정하세요
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 크롭 컨트롤 */}
            <div className="px-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-slate-300 font-medium text-sm">크롭</span>
                  {cropRegion && (
                    <span className="text-xs px-2 py-0.5 bg-orange-500/20 border border-orange-500/30 text-orange-300 rounded-full">
                      {cropRegion.w}×{cropRegion.h}  ({cropRegion.x}, {cropRegion.y})
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  {cropRegion && (
                    <button
                      onClick={() => { setCropRegion(null); setDragRect(null) }}
                      className="text-xs px-2.5 py-1.5 bg-slate-700 hover:bg-red-600/70 text-slate-400 hover:text-white rounded-lg transition-colors"
                    >
                      초기화
                    </button>
                  )}
                  <button
                    onClick={() => {
                      if (cropMode) {
                        // 완료: 모드 종료
                        setCropMode(false)
                      } else {
                        // 진입: dragRect 초기화 후 모드 활성
                        setDragRect(cropRegion ? cropRegionToDisplayRect(cropRegion) ?? null : null)
                        setCropMode(true)
                      }
                    }}
                    className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-all ${
                      cropMode
                        ? 'bg-orange-600 hover:bg-orange-500 text-white'
                        : 'bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white'
                    }`}
                  >
                    {cropMode ? '완료' : '영역 지정'}
                  </button>
                </div>
              </div>
              {cropMode && (
                <p className="text-slate-500 text-xs mt-1.5">
                  비디오 위에서 드래그하여 유지할 영역을 선택하세요. 재생 컨트롤은 비활성됩니다.
                </p>
              )}
            </div>

            {/* D: 구간 선택 */}
            <div className="space-y-3 px-1">
              <p className="text-slate-300 font-medium text-sm">구간 선택 <span className="text-slate-500 font-normal">(선택 사항)</span></p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-slate-400 text-xs mb-1.5 block">시작 (초)</label>
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      min={0}
                      max={videoInfo?.duration ?? undefined}
                      step={0.1}
                      value={trimStart || ''}
                      placeholder="0"
                      onChange={(e) => setTrimStart(parseFloat(e.target.value) || 0)}
                      className="flex-1 bg-slate-700 text-white text-sm px-3 py-2 rounded-lg border border-slate-600 focus:border-blue-500 focus:outline-none"
                    />
                    <button
                      onClick={() => setTrimStart(Math.round((videoRef.current?.currentTime ?? 0) * 10) / 10)}
                      className="px-2.5 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-lg border border-slate-600 transition-colors"
                    >
                      현재
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-slate-400 text-xs mb-1.5 block">종료 (초, 0 = 끝까지)</label>
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      min={0}
                      max={videoInfo?.duration ?? undefined}
                      step={0.1}
                      value={trimEnd || ''}
                      placeholder="끝까지"
                      onChange={(e) => setTrimEnd(parseFloat(e.target.value) || 0)}
                      className="flex-1 bg-slate-700 text-white text-sm px-3 py-2 rounded-lg border border-slate-600 focus:border-blue-500 focus:outline-none"
                    />
                    <button
                      onClick={() => setTrimEnd(Math.round((videoRef.current?.currentTime ?? 0) * 10) / 10)}
                      className="px-2.5 py-2 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-lg border border-slate-600 transition-colors"
                    >
                      현재
                    </button>
                  </div>
                </div>
              </div>
              {(trimStart > 0 || trimEnd > 0) && (
                <p className="text-slate-500 text-xs">
                  {formatDuration(trimStart)} ~ {trimEnd > 0 ? formatDuration(trimEnd) : (videoInfo ? formatDuration(videoInfo.duration) : '끝')}
                  {trimEnd > trimStart && trimEnd > 0 && (
                    <span className="ml-2 text-blue-400">({formatDuration(trimEnd - trimStart)} 구간)</span>
                  )}
                </p>
              )}
            </div>

            {/* 속도 컨트롤 */}
            <div className="space-y-4 px-1">
              <div className="flex items-center justify-between">
                <span className="text-slate-300 font-medium">재생 속도 설정</span>
                {speed > 100 && (
                  <span className="text-yellow-400 text-xs bg-yellow-400/10 border border-yellow-400/20 px-2 py-1 rounded-full">
                    100x 초과 → 오디오 자동 제거
                  </span>
                )}
              </div>

              {/* 속도 숫자 입력 */}
              <div className="flex items-baseline justify-center gap-2">
                <input
                  type="text"
                  value={speedInput}
                  onChange={(e) => setSpeedInput(e.target.value)}
                  onBlur={commitSpeedInput}
                  onKeyDown={(e) => e.key === 'Enter' && commitSpeedInput()}
                  className="text-6xl font-bold text-white bg-transparent border-b-2 border-blue-500 focus:border-blue-400 text-center w-40 focus:outline-none transition-colors pb-1"
                />
                <span className="text-3xl font-bold text-slate-400">x</span>
              </div>

              {/* 로그 스케일 슬라이더 */}
              <input
                type="range"
                min={0}
                max={1}
                step={0.001}
                value={toSlider(speed)}
                onChange={(e) => handleSpeedChange(fromSlider(parseFloat(e.target.value)))}
              />
              <div className="flex justify-between text-xs text-slate-600 -mt-2 px-0.5">
                <span>0.1x</span>
                <span>1x</span>
                <span>10x</span>
                <span>100x</span>
                <span>1000x</span>
              </div>

              {/* 프리셋 버튼 */}
              <div className="flex flex-wrap gap-2 pt-1">
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    onClick={() => handleSpeedChange(p)}
                    className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 ${
                      Math.abs(speed - p) < 0.001
                        ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
                        : 'bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white'
                    }`}
                  >
                    {p}x
                  </button>
                ))}
              </div>

              {/* 미리보기 제한 안내 */}
              {speed > 16 && (
                <p className="text-slate-600 text-xs text-center pt-1">
                  미리보기는 브라우저 제한으로 최대 16x까지 표시됩니다.
                  변환은 서버에서 <span className="text-slate-400 font-medium">{formatSpeed(speed)}x</span>로 처리됩니다.
                </p>
              )}
            </div>

            {/* E + F: 고급 옵션 */}
            <div className="px-1">
              <button
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 text-slate-400 hover:text-slate-200 text-sm transition-colors"
              >
                <span
                  className="inline-block transition-transform duration-200"
                  style={{ transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0deg)' }}
                >
                  ▶
                </span>
                고급 옵션
              </button>

              {showAdvanced && (
                <div className="mt-4 space-y-5 pl-4 border-l border-slate-700">
                  {/* F: 출력 포맷 */}
                  <div>
                    <p className="text-slate-400 text-xs mb-2">출력 포맷</p>
                    <div className="flex gap-2">
                      {OUTPUT_FORMATS.map((fmt) => (
                        <button
                          key={fmt}
                          onClick={() => setOutputFormat(fmt)}
                          className={`px-5 py-1.5 rounded-lg text-sm font-medium transition-all ${
                            outputFormat === fmt
                              ? 'bg-blue-600 text-white shadow-md shadow-blue-500/30'
                              : 'bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white'
                          }`}
                        >
                          {fmt.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* E: CRF 슬라이더 */}
                  <div>
                    <div className="flex justify-between items-center mb-2">
                      <p className="text-slate-400 text-xs">화질 조절</p>
                      <span className="text-slate-300 text-xs font-mono bg-slate-700 px-2 py-0.5 rounded">
                        CRF {crf}
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={51}
                      step={1}
                      value={crf}
                      onChange={(e) => setCrf(parseInt(e.target.value))}
                      className="w-full"
                    />
                    <div className="flex justify-between text-xs text-slate-600 mt-1">
                      <span>고화질 (큰 파일)</span>
                      <span>저화질 (작은 파일)</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 변환 결과 예측 */}
            {estimatedOutput && (
              <div className="rounded-xl bg-slate-700/40 border border-slate-600/50 px-4 py-3 space-y-2">
                <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">변환 후 예상</p>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-slate-500">길이</span>
                    <span className="text-slate-100 font-medium tabular-nums">
                      {formatDuration(estimatedOutput.duration)}
                      {estimatedOutput.duration !== (videoInfo?.duration ?? 0) && (
                        <span className="text-slate-500 font-normal ml-1.5 text-xs">
                          (원본 {formatDuration(videoInfo?.duration ?? 0)})
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">해상도</span>
                    <span className="text-slate-100 font-medium">
                      {estimatedOutput.width}×{estimatedOutput.height}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">포맷</span>
                    <span className="text-slate-100 font-medium uppercase">{outputFormat}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">예상 용량</span>
                    <span className="text-slate-100 font-medium">
                      ~{formatFileSize(estimatedOutput.estimatedBytes)}
                      <span className="text-slate-600 font-normal text-xs ml-1">추정</span>
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* 변환 버튼 */}
            <button
              onClick={handleConvert}
              className="w-full py-4 bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-semibold text-lg rounded-xl transition-all duration-200 shadow-lg hover:shadow-blue-500/30 active:scale-[0.98]"
            >
              {formatSpeed(speed)}x 속도로 변환 시작
            </button>
          </div>
        )}

        {/* ─── 변환 중 ─── */}
        {phase === 'converting' && (
          <div className="p-10 text-center space-y-6">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-blue-500/10 border border-blue-500/20 mb-2">
              <span className="text-4xl animate-spin" style={{ animationDuration: '2s' }}>⚙️</span>
            </div>
            <div>
              <p className="text-2xl text-white font-bold mb-1">변환 중...</p>
              <p className="text-slate-400 text-sm">{file?.name}</p>
              <p className="text-blue-400 font-medium mt-1">{formatSpeed(speed)}x 배속 처리</p>
            </div>

            {/* 프로그레스 바 */}
            <div className="space-y-2">
              <div className="flex justify-between text-sm px-0.5">
                <span className="text-slate-400">진행률</span>
                <span className="text-white font-bold tabular-nums">{progress}%</span>
              </div>
              <div className="h-3 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full progress-bar-animated transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.max(progress, 2)}%` }}
                />
              </div>
            </div>

            {/* B: 취소 버튼 */}
            <button
              onClick={handleCancel}
              className="px-6 py-2.5 bg-slate-700 hover:bg-red-600/80 text-slate-300 hover:text-white font-medium rounded-xl transition-all duration-200"
            >
              취소
            </button>

            <p className="text-slate-600 text-xs">
              브라우저를 닫지 마세요 — 서버에서 FFmpeg로 처리 중입니다.
            </p>
          </div>
        )}

        {/* ─── 완료 ─── */}
        {phase === 'done' && (
          <div className="p-10 text-center space-y-6">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-green-500/10 border border-green-500/20">
              <span className="text-4xl">✅</span>
            </div>
            <div>
              <p className="text-2xl text-white font-bold mb-2">변환 완료!</p>
              <p className="text-slate-400">
                <span className="text-green-400 font-medium">{formatSpeed(speed)}x</span> 배속으로 변환이 완료되었습니다.
              </p>
            </div>
            <div className="flex gap-3 justify-center">
              <button
                onClick={handleDownload}
                className="px-8 py-3 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 text-white font-semibold rounded-xl transition-all duration-200 shadow-lg hover:shadow-green-500/30 active:scale-[0.98]"
              >
                다운로드
              </button>
              <button
                onClick={handleReset}
                className="px-6 py-3 bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium rounded-xl transition-all"
              >
                새로 변환
              </button>
            </div>
          </div>
        )}

        {/* ─── 오류 ─── */}
        {phase === 'error' && (
          <div className="p-10 text-center space-y-6">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-red-500/10 border border-red-500/20">
              <span className="text-4xl">❌</span>
            </div>
            <div>
              <p className="text-xl text-white font-bold mb-2">변환 실패</p>
              <p className="text-red-400 text-sm bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 max-w-md mx-auto">
                {error}
              </p>
            </div>
            <button
              onClick={handleReset}
              className="px-6 py-3 bg-slate-700 hover:bg-slate-600 text-slate-200 font-medium rounded-xl transition-all"
            >
              다시 시도
            </button>
          </div>
        )}
      </div>

      {/* 푸터 */}
      <p className="mt-6 text-slate-700 text-xs text-center">
        FFmpeg 서버 사이드 변환 · 최대 1000x 배속 · SSE 실시간 진행률
      </p>
    </div>
  )
}
