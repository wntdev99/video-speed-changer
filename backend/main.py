import asyncio
import json
import re
import shutil
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any, Dict

import aiofiles
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

app = FastAPI(title="Video Speed Changer")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

TEMP_DIR = Path("temp")
TEMP_DIR.mkdir(exist_ok=True)

# job_id -> { status, progress, output_path, error, filename }
jobs: Dict[str, Dict[str, Any]] = {}


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


def run_ffmpeg(job_id: str, input_path: str, output_path: str, speed: float) -> None:
    try:
        input_duration = get_video_duration(input_path)
        output_duration = input_duration / speed if speed > 0 else input_duration

        video_filter = f"setpts=PTS/{speed}"
        cmd = ["ffmpeg", "-i", input_path, "-vf", video_filter]

        # 100x 초과 시 오디오 제거, 이하에서는 atempo 체인 사용
        if speed > 100:
            cmd.append("-an")
        else:
            cmd.extend(["-af", build_atempo_filter(speed)])

        cmd.extend(["-y", output_path])

        process = subprocess.Popen(
            cmd,
            stderr=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )

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
) -> dict:
    if speed <= 0 or speed > 1000:
        raise HTTPException(status_code=400, detail="speed는 0 초과 1000 이하여야 합니다.")

    job_id = str(uuid.uuid4())
    job_dir = TEMP_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    filename = file.filename or "video.mp4"
    suffix = Path(filename).suffix or ".mp4"
    input_path = str(job_dir / f"input{suffix}")
    output_path = str(job_dir / f"output{suffix}")

    # 청크 단위 저장 (대용량 파일 메모리 절약)
    async with aiofiles.open(input_path, "wb") as f:
        while True:
            chunk = await file.read(1024 * 1024)  # 1MB
            if not chunk:
                break
            await f.write(chunk)

    jobs[job_id] = {
        "status": "processing",
        "progress": 0,
        "output_path": None,
        "error": None,
        "filename": f"speed_{speed}x_{filename}",
    }

    thread = threading.Thread(
        target=run_ffmpeg,
        args=(job_id, input_path, output_path, speed),
        daemon=True,
    )
    thread.start()

    return {"job_id": job_id}


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

            if job["status"] in ("done", "error"):
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


@app.delete("/api/cleanup/{job_id}")
async def cleanup(job_id: str) -> dict:
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    job_dir = TEMP_DIR / job_id
    if job_dir.exists():
        shutil.rmtree(job_dir)

    del jobs[job_id]
    return {"message": "정리 완료"}
