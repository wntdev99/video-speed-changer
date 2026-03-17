import asyncio
import json
import re
import shutil
import subprocess
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Dict

import aiofiles
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

TEMP_DIR = Path("temp")
TEMP_DIR.mkdir(exist_ok=True)

# job_id -> { status, progress, output_path, error, filename, process, created_at }
jobs: Dict[str, Dict[str, Any]] = {}


async def cleanup_expired_jobs() -> None:
    while True:
        await asyncio.sleep(60)
        now = datetime.now()
        for job_id, job in list(jobs.items()):
            age = (now - job["created_at"]).total_seconds()
            if age > 1800 and job["status"] in ("done", "error", "cancelled"):
                shutil.rmtree(TEMP_DIR / job_id, ignore_errors=True)
                del jobs[job_id]


@asynccontextmanager
async def lifespan(app: Any):
    asyncio.create_task(cleanup_expired_jobs())
    yield


app = FastAPI(title="Video Speed Changer", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_video_duration(path: str) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        capture_output=True,
        text=True,
    )
    try:
        return float(result.stdout.strip())
    except ValueError:
        return 0.0


def _parse_frame_rate(rate_str: str) -> float:
    try:
        num, den = rate_str.split("/")
        return round(float(num) / float(den), 3) if float(den) != 0 else 0.0
    except (ValueError, ZeroDivisionError):
        return 0.0


def get_video_info(path: str) -> dict:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "stream=width,height,r_frame_rate,avg_frame_rate,codec_name,codec_type",
            "-show_entries", "format=duration,size",
            "-of", "json",
            path,
        ],
        capture_output=True,
        text=True,
    )
    try:
        data = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        return {}

    streams = data.get("streams", [])
    video_stream = next(
        (s for s in streams if s.get("codec_type") == "video"),
        {},
    )
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    fmt = data.get("format", {})

    # fps 결정: r_frame_rate → avg_frame_rate → 30.0 (기본값)
    # 화면 녹화(VFR)는 r_frame_rate=1000/1 같은 비정상 값을 가질 수 있음
    r_fps = _parse_frame_rate(video_stream.get("r_frame_rate", "0/1"))
    avg_fps = _parse_frame_rate(video_stream.get("avg_frame_rate", "0/1"))

    if 1 <= r_fps <= 120:
        fps = r_fps
    elif 1 <= avg_fps <= 120:
        fps = avg_fps
    elif r_fps > 120 or avg_fps > 120:
        fps = 30.0  # VFR 영상 — 안전한 기본값
    else:
        fps = 0.0

    try:
        duration = float(fmt.get("duration") or 0)
    except (ValueError, TypeError):
        duration = 0.0

    try:
        size = int(fmt.get("size") or 0)
    except (ValueError, TypeError):
        size = 0

    return {
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "fps": fps,
        "codec": video_stream.get("codec_name"),
        "duration": duration,
        "size": size,
        "has_audio": has_audio,
    }


def build_atempo_filter(speed: float) -> str:
    """atempo 필터는 0.5~2.0 범위만 지원 -> 체인으로 연결해 임의 배속 처리"""
    filters: list[str] = []
    remaining = speed

    # 속도 증가 (>2.0): atempo=2.0 반복
    while remaining > 2.0:
        filters.append("atempo=2.0")
        remaining /= 2.0

    # 속도 감소 (<0.5): atempo=0.5 반복
    while remaining < 0.5:
        filters.append("atempo=0.5")
        remaining /= 0.5  # /0.5 == *2 → remaining이 0.5 이상이 될 때까지

    filters.append(f"atempo={remaining:.6f}")
    return ",".join(filters)


def parse_time_to_seconds(time_str: str) -> float:
    parts = time_str.split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    return 0.0


def _build_ffmpeg_cmd(
    input_path: str,
    output_path: str,
    speed: float,
    trim_start: float,
    trim_end: float,
    crf: int,
    output_format: str,
    crop_x: int,
    crop_y: int,
    crop_w: int,
    crop_h: int,
    input_fps: float,
    use_blend: bool,
    has_audio: bool = True,
) -> list[str]:
    """FFmpeg 명령어 리스트를 생성한다.

    가속(speed > 1.0, speed <= 8.0):
      use_blend=True  → minterpolate(blend 사전 보간) → setpts → fps
      use_blend=False → setpts → fps  [폴백]
    감속(speed < 1.0):
      use_blend=True  → setpts → minterpolate(blend 보간)
      use_blend=False → setpts → fps  [폴백]
    """
    cmd = ["ffmpeg"]
    if trim_start > 0:
        cmd.extend(["-ss", str(trim_start)])
    if trim_end > 0:
        cmd.extend(["-t", str(trim_end - trim_start)])
    cmd.extend(["-i", input_path])

    # 비디오 필터 체인: crop → fps(VFR 정규화) → setpts → (minterpolate|fps)
    vf_chain: list[str] = []
    if crop_w > 0 and crop_h > 0:
        vf_chain.append(f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y}")

    # VFR(가변 프레임레이트) 입력을 CFR로 정규화 — 화면 녹화 등에서 필수
    if input_fps > 0:
        vf_chain.append(f"fps={input_fps}")

    if input_fps > 0:
        if use_blend and speed > 1.0 and speed <= 8.0:
            # 가속 (공식 방식): minterpolate 사전 보간 → setpts → fps
            # 가속 전에 중간 프레임을 먼저 생성해 버리는 프레임을 모두 보간된 프레임으로 대체
            # mi_mode=blend: 단방향 블렌딩 — 내부 버퍼 없이 즉시 출력 (진행률 정상 동작)
            # mi_mode=mci(양방향 모션 추정)는 미래 프레임 버퍼링으로 진행률이 0%에 고착됨
            # speed > 8 이상은 보간 후 드롭 비율이 너무 커 효과가 없으므로 폴백 사용
            pre_interp_fps = min(120.0, input_fps * speed)
            vf_chain.append(f"minterpolate=fps={pre_interp_fps}:mi_mode=blend")
            vf_chain.append(f"setpts=PTS/{speed}")
            vf_chain.append(f"fps={input_fps}")
        elif use_blend and speed < 1.0:
            # 감속: setpts → minterpolate 블렌딩 보간
            vf_chain.append(f"setpts=PTS/{speed}")
            vf_chain.append(f"minterpolate=fps={input_fps}:mi_mode=blend")
        else:
            # 폴백: setpts → fps (균일한 프레임 선택)
            vf_chain.append(f"setpts=PTS/{speed}")
            vf_chain.append(f"fps={input_fps}")
    else:
        vf_chain.append(f"setpts=PTS/{speed}")

    # H.264/H.265 인코더는 가로·세로 모두 짝수여야 함
    # 화면 녹화 등 홀수 해상도 입력에서 인코딩 실패 방지
    vf_chain.append("pad=ceil(iw/2)*2:ceil(ih/2)*2")

    cmd.extend(["-vf", ",".join(vf_chain)])

    if speed > 100 or not has_audio:
        cmd.append("-an")
    else:
        cmd.extend(["-af", build_atempo_filter(speed)])

    if output_format == "webm":
        cmd.extend(["-c:v", "libvpx-vp9", "-b:v", "0", "-c:a", "libopus"])

    cmd.extend(["-crf", str(crf)])
    cmd.extend(["-y", output_path])
    return cmd


def _run_ffmpeg_process(job_id: str, cmd: list[str], output_duration: float) -> tuple[int, str]:
    """FFmpeg 프로세스를 실행하고 진행률을 추적한다. (returncode, stderr_tail)를 반환."""
    process = subprocess.Popen(
        cmd,
        stderr=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )
    jobs[job_id]["process"] = process

    time_pattern = re.compile(r"time=(\d{2}:\d{2}:\d{2}\.\d+)")
    stderr_lines: list[str] = []

    assert process.stderr is not None
    for line in process.stderr:
        stderr_lines.append(line)
        if len(stderr_lines) > 30:
            stderr_lines.pop(0)
        match = time_pattern.search(line)
        if match and output_duration > 0:
            current = parse_time_to_seconds(match.group(1))
            jobs[job_id]["progress"] = min(99, int(current / output_duration * 100))

    process.wait()
    return process.returncode, "".join(stderr_lines[-10:])


def run_ffmpeg(
    job_id: str,
    input_path: str,
    output_path: str,
    speed: float,
    trim_start: float = 0.0,
    trim_end: float = 0.0,
    crf: int = 23,
    output_format: str = "mp4",
    crop_x: int = 0,
    crop_y: int = 0,
    crop_w: int = 0,
    crop_h: int = 0,
    input_fps: float = 0.0,
    has_audio: bool = True,
) -> None:
    try:
        # 취소 요청이 이미 들어왔는지 확인 (cancel race condition 방지)
        if jobs[job_id]["status"] == "cancelled":
            return

        input_duration = get_video_duration(input_path)
        clip_duration = (trim_end - trim_start) if trim_end > 0 else input_duration
        output_duration = clip_duration / speed if speed > 0 else clip_duration

        build_args = (
            input_path, output_path, speed, trim_start, trim_end,
            crf, output_format, crop_x, crop_y, crop_w, crop_h, input_fps,
        )
        build_kwargs = {"has_audio": has_audio}

        # 1차 시도: minterpolate 보간 필터 적용
        cmd = _build_ffmpeg_cmd(*build_args, use_blend=True, **build_kwargs)
        returncode, stderr_tail = _run_ffmpeg_process(job_id, cmd, output_duration)

        # 블렌딩 필터 실패 시 단순 setpts 방식으로 폴백
        if returncode != 0 and jobs[job_id]["status"] != "cancelled":
            jobs[job_id]["progress"] = 0
            cmd = _build_ffmpeg_cmd(*build_args, use_blend=False, **build_kwargs)
            returncode, stderr_tail = _run_ffmpeg_process(job_id, cmd, output_duration)

        if returncode == 0:
            jobs[job_id]["status"] = "done"
            jobs[job_id]["progress"] = 100
            jobs[job_id]["output_path"] = output_path
        elif jobs[job_id]["status"] == "cancelled":
            pass
        elif returncode < 0:
            jobs[job_id]["status"] = "cancelled"
        else:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = "FFmpeg 실패 (rc={}): {}".format(
                returncode, stderr_tail.strip()[-200:] if stderr_tail else "unknown"
            )

    except Exception as exc:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(exc)


@app.post("/api/convert")
async def convert_video(
    file: UploadFile = File(...),
    speed: float = Form(...),
    trim_start: float = Form(0.0),
    trim_end: float = Form(0.0),
    crf: int = Form(23),
    output_format: str = Form("mp4"),
    crop_x: int = Form(0),
    crop_y: int = Form(0),
    crop_w: int = Form(0),
    crop_h: int = Form(0),
) -> dict:
    if speed <= 0 or speed > 1000:
        raise HTTPException(status_code=400, detail="speed는 0 초과 1000 이하여야 합니다.")

    ALLOWED_FORMATS = {"mp4", "mov", "webm"}
    if output_format not in ALLOWED_FORMATS:
        raise HTTPException(status_code=400, detail=f"output_format은 {ALLOWED_FORMATS} 중 하나여야 합니다.")

    crf = max(0, min(51, crf))

    if trim_end > 0 and trim_end <= trim_start:
        raise HTTPException(status_code=400, detail="trim_end는 trim_start보다 커야 합니다.")

    job_id = str(uuid.uuid4())
    job_dir = TEMP_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    filename = file.filename or "video.mp4"
    suffix = Path(filename).suffix or ".mp4"
    input_path = str(job_dir / f"input{suffix}")
    output_path = str(job_dir / f"output.{output_format}")

    # 청크 단위 저장 (대용량 파일 메모리 절약)
    async with aiofiles.open(input_path, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)  # 1MB
            if not chunk:
                break
            await f.write(chunk)

    # 비디오 정보 수집 (A)
    video_info = get_video_info(input_path)

    stem = Path(filename).stem
    jobs[job_id] = {
        "status": "processing",
        "progress": 0,
        "output_path": None,
        "error": None,
        "filename": f"speed_{speed}x_{stem}.{output_format}",
        "process": None,
        "created_at": datetime.now(),
    }

    input_fps = video_info.get("fps") or 0.0
    has_audio = video_info.get("has_audio", True)

    thread = threading.Thread(
        target=run_ffmpeg,
        args=(job_id, input_path, output_path, speed, trim_start, trim_end, crf, output_format,
              crop_x, crop_y, crop_w, crop_h, input_fps, has_audio),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id, "video_info": video_info}


@app.get("/api/progress/{job_id}")
async def stream_progress(job_id: str) -> StreamingResponse:
    """SSE로 변환 진행률 실시간 스트리밍"""

    async def generate():
        while True:
            if job_id not in jobs:
                yield f"data: {json.dumps({'error': 'Job not found'})}\n\n"
                break

            job = jobs[job_id]
            payload = {
                "status": job["status"],
                "progress": job["progress"],
                "error": job.get("error"),
            }
            yield f"data: {json.dumps(payload)}\n\n"

            if job["status"] in ("done", "error", "cancelled"):
                break

            await asyncio.sleep(0.3)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/download/{job_id}")
async def download_file(job_id: str) -> FileResponse:
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[job_id]
    if job["status"] != "done":
        raise HTTPException(status_code=400, detail="변환이 완료되지 않았습니다.")

    output_path = job.get("output_path")
    if not output_path or not Path(output_path).exists():
        raise HTTPException(status_code=404, detail="출력 파일을 찾을 수 없습니다. 이미 정리되었을 수 있습니다.")

    return FileResponse(
        output_path,
        filename=job["filename"],
        media_type="application/octet-stream",
    )


@app.delete("/api/cancel/{job_id}")
async def cancel_job(job_id: str) -> dict:
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[job_id]
    if job["status"] == "processing":
        jobs[job_id]["status"] = "cancelled"
        process = job.get("process")
        if process:
            process.terminate()

    return {"message": "취소 요청 완료"}


@app.delete("/api/cleanup/{job_id}")
async def cleanup(job_id: str) -> dict:
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job_dir = TEMP_DIR / job_id
    if job_dir.exists():
        shutil.rmtree(job_dir)

    del jobs[job_id]
    return {"message": "정리 완료"}
