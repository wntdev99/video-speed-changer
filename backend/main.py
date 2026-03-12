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


def get_video_info(path: str) -> dict:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "stream=width,height,r_frame_rate,codec_name,codec_type",
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

    video_stream = next(
        (s for s in data.get("streams", []) if s.get("codec_type") == "video"),
        {},
    )
    fmt = data.get("format", {})

    fps = 0.0
    r_frame_rate = video_stream.get("r_frame_rate", "0/1")
    try:
        num, den = r_frame_rate.split("/")
        fps = round(float(num) / float(den), 3) if float(den) != 0 else 0.0
    except (ValueError, ZeroDivisionError):
        fps = 0.0

    return {
        "width": video_stream.get("width"),
        "height": video_stream.get("height"),
        "fps": fps,
        "codec": video_stream.get("codec_name"),
        "duration": float(fmt.get("duration") or 0),
        "size": int(fmt.get("size") or 0),
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


def run_ffmpeg(
    job_id: str,
    input_path: str,
    output_path: str,
    speed: float,
    trim_start: float = 0.0,
    trim_end: float = 0.0,
    crf: int = 23,
    output_format: str = "mp4",
) -> None:
    try:
        input_duration = get_video_duration(input_path)
        clip_duration = (trim_end - trim_start) if trim_end > 0 else input_duration
        output_duration = clip_duration / speed if speed > 0 else clip_duration

        # -ss/-t 를 -i 앞(입력 옵션)으로 배치
        # -ss: 빠른 keyframe seek / -t: 입력 자체를 잘라내어 이후 속도 필터와 독립적으로 동작
        cmd = ["ffmpeg"]
        if trim_start > 0:
            cmd.extend(["-ss", str(trim_start)])
        if trim_end > 0:
            cmd.extend(["-t", str(trim_end - trim_start)])
        cmd.extend(["-i", input_path])

        video_filter = f"setpts=PTS/{speed}"
        cmd.extend(["-vf", video_filter])

        # 100x 초과 시 오디오 제거, 이하에서는 atempo 체인 사용
        if speed > 100:
            cmd.append("-an")
        else:
            cmd.extend(["-af", build_atempo_filter(speed)])

        # 포맷별 코덱 설정
        if output_format == "webm":
            cmd.extend(["-c:v", "libvpx-vp9", "-b:v", "0", "-c:a", "libopus"])

        cmd.extend(["-crf", str(crf)])
        cmd.extend(["-y", output_path])

        process = subprocess.Popen(
            cmd,
            stderr=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        jobs[job_id]["process"] = process

        time_pattern = re.compile(r"time=(\d{2}:\d{2}:\d{2}\.\d+)")

        assert process.stderr is not None
        for line in process.stderr:
            match = time_pattern.search(line)
            if match and output_duration > 0:
                current = parse_time_to_seconds(match.group(1))
                jobs[job_id]["progress"] = min(99, int(current / output_duration * 100))

        process.wait()

        if process.returncode == 0:
            jobs[job_id]["status"] = "done"
            jobs[job_id]["progress"] = 100
            jobs[job_id]["output_path"] = output_path
        elif jobs[job_id]["status"] == "cancelled":
            # cancel 엔드포인트가 이미 cancelled 로 설정한 경우 덮어쓰지 않음
            # (FFmpeg는 SIGTERM 수신 시 returncode=255 등 양수로 종료할 수 있음)
            pass
        elif process.returncode < 0:
            # Python subprocess가 음수 returncode를 반환하는 경우 (일부 플랫폼)
            jobs[job_id]["status"] = "cancelled"
        else:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = "FFmpeg 변환 실패 (returncode={})".format(process.returncode)

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
) -> dict:
    if speed <= 0 or speed > 1000:
        raise HTTPException(status_code=400, detail="speed는 0 초과 1000 이하여야 합니다.")

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

    thread = threading.Thread(
        target=run_ffmpeg,
        args=(job_id, input_path, output_path, speed, trim_start, trim_end, crf, output_format),
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

    return FileResponse(
        job["output_path"],
        filename=job["filename"],
        media_type="application/octet-stream",
    )


@app.delete("/api/cancel/{job_id}")
async def cancel_job(job_id: str) -> dict:
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job = jobs[job_id]
    process = job.get("process")
    if process and job["status"] == "processing":
        process.terminate()
        jobs[job_id]["status"] = "cancelled"

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
