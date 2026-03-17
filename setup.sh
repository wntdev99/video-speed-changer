#!/usr/bin/env bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "======================================"
echo "  Video Speed Changer — 초기 설치"
echo "======================================"
echo ""

# ── 요구사항 확인 ────────────────────────────────────
check_cmd() {
  local cmd=$1 label=$2 hint=$3
  if command -v "$cmd" &> /dev/null; then
    echo "  [OK] $label: $(${cmd} --version 2>&1 | head -n1)"
  else
    echo "  [오류] $label 가 설치되어 있지 않습니다."
    echo "         $hint"
    exit 1
  fi
}

echo "[사전 요구사항 확인]"
check_cmd python3  "Python 3" "https://www.python.org/downloads/"
check_cmd node     "Node.js"  "https://nodejs.org/"
check_cmd npm      "npm"      "Node.js 설치 시 함께 제공됩니다."
check_cmd ffmpeg   "FFmpeg"   "Ubuntu: sudo apt install ffmpeg  /  macOS: brew install ffmpeg"
echo ""

# ── Python 버전 확인 (3.10+) ─────────────────────────
PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
  echo "  [오류] Python 3.10 이상이 필요합니다. (현재: $PY_VER)"
  exit 1
fi

# ── Node.js 버전 확인 (18+) ──────────────────────────
NODE_VER=$(node -e "process.stdout.write(process.version.slice(1))")
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  [오류] Node.js 18 이상이 필요합니다. (현재: $NODE_VER)"
  exit 1
fi

# ── 백엔드 설치 ──────────────────────────────────────
echo "[1/2] 백엔드 의존성 설치..."
cd "$ROOT_DIR/backend"

if [ ! -d ".venv" ]; then
  echo "  가상환경 생성 중..."
  python3 -m venv .venv
fi

source .venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt -q
deactivate

echo "  완료: backend/.venv"

# ── 프론트엔드 설치 ──────────────────────────────────
echo "[2/2] 프론트엔드 의존성 설치..."
cd "$ROOT_DIR/frontend"
npm install --silent
echo "  완료: frontend/node_modules"

# ── 완료 ─────────────────────────────────────────────
echo ""
echo "======================================"
echo "  설치 완료!"
echo ""
echo "  실행: bash start.sh"
echo "======================================"
