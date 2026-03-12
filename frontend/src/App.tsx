import { useCallback, useEffect, useRef, useState } from 'react'

type Phase = 'upload' | 'ready' | 'converting' | 'done' | 'error'

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

const PRESETS = [0.25, 0.5, 1, 2, 4, 8, 16, 32, 100]
const ACCEPTED_TYPES = /\.(mp4|mov|avi|mkv|webm|flv|wmv|m4v|ts|mts)$/i

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

  const videoRef = useRef<HTMLVideoElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const eventSourceRef = useRef<EventSource | null>(null)

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

  const handleConvert = async () => {
    if (!file) return
    setPhase('converting')
    setProgress(0)
    setError(null)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('speed', speed.toString())

    try {
      const res = await fetch('/api/convert', { method: 'POST', body: formData })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail || '업로드 실패')
      }
      const { job_id } = await res.json()
      setJobId(job_id)

      // SSE로 진행률 수신
      const es = new EventSource(`/api/progress/${job_id}`)
      eventSourceRef.current = es

      es.onmessage = (event) => {
        const data = JSON.parse(event.data)
        setProgress(data.progress ?? 0)
        if (data.status === 'done') {
          es.close()
          setPhase('done')
        } else if (data.status === 'error') {
          es.close()
          setPhase('error')
          setError(data.error ?? '변환 중 오류가 발생했습니다.')
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

  const handleDownload = () => {
    if (jobId) window.open(`/api/download/${jobId}`, '_blank')
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
  }

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

            {/* 비디오 미리보기 */}
            <div className="rounded-xl overflow-hidden bg-black aspect-video">
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                className="w-full h-full object-contain"
              />
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
