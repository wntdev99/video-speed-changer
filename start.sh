#!/usr/bin/env bash
set -e

# FFmpeg 설치 확인
if ! command -v ffmpeg &> /dev/null; then
  echo "[오류] FFmpeg가 설치되어 있지 않습니다."
  echo "  Ubuntu: sudo apt install ffmpeg"
  echo "  macOS:  brew install ffmpeg"
  exit 1
fi

echo "FFmpeg 버전: $(ffmpeg -version 2>&1 | head -n1)"
echo ""

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── 기존 프로세스 종료 ─────────────────────────
# 이전 실행이 남아 있으면 포트 충돌로 새 서버가 시작되지 않음
kill_existing() {
  local port=$1 name=$2
  local pid
  pid=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "  기존 $name 종료 (PID $pid, 포트 $port)"
    kill $pid 2>/dev/null
    sleep 1
    kill -9 $pid 2>/dev/null || true
  fi
}
kill_existing 8000 "백엔드"
kill_existing 5173 "프론트엔드"

# ── 백엔드 시작 ──────────────────────────────
echo "[1/2] 백엔드 패키지 설치 및 실행..."
cd "$ROOT_DIR/backend"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
# pip 설치 (시스템 패키지 의존성 경고는 우리 앱과 무관하므로 필터링)
pip install -r requirements.txt -q 2>&1 | grep -v "dependency resolver" | grep -v "^\s*$" || true

uvicorn main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!
deactivate
cd "$ROOT_DIR"

# ── 프론트엔드 시작 ──────────────────────────
echo "[2/2] 프론트엔드 패키지 설치 및 실행..."
cd "$ROOT_DIR/frontend"
npm install --silent
npm run dev &
FRONTEND_PID=$!
cd "$ROOT_DIR"

echo ""
echo "────────────────────────────────────────"
echo "  백엔드  : http://localhost:8000"
echo "  프론트  : http://localhost:5173"
echo "────────────────────────────────────────"
echo "  Ctrl+C 로 종료"
echo ""

# 종료 시 두 프로세스 모두 kill
trap "echo ''; echo '종료 중...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM
wait
