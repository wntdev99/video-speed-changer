# Video Speed Changer

비디오 파일의 재생 속도를 자유롭게 조절할 수 있는 웹 애플리케이션입니다.
**0.01x 슬로우모션**부터 **1000x 초고속**까지 지원하며, FFmpeg 서버 사이드 처리로 실제 파일을 변환하여 다운로드할 수 있습니다.

---

## 주요 기능

- **광범위한 배속 지원** — 0.01x ~ 1000x (슬라이더 · 프리셋 · 직접 입력)
- **로그 스케일 슬라이더** — 0.1x / 1x / 10x / 100x / 1000x 구간이 균등하게 배치
- **실시간 진행률** — SSE(Server-Sent Events)로 변환 진행률을 0.3초 단위로 표시
- **오디오 자동 처리** — 100x 이하: atempo 필터 체인, 100x 초과: 오디오 자동 제거
- **HTML5 미리보기** — 변환 전 브라우저에서 즉시 속도 미리보기 (최대 16x)
- **대용량 파일 지원** — 1MB 청크 단위 업로드로 메모리 절약
- **다양한 포맷** — MP4, MOV, AVI, MKV, WebM, FLV, WMV, TS 등

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| 프론트엔드 | React 18 + TypeScript + Tailwind CSS |
| 빌드 도구 | Vite 5 |
| 백엔드 | FastAPI (Python) |
| 비디오 처리 | FFmpeg (`setpts` · `atempo` 필터) |
| 실시간 통신 | SSE (Server-Sent Events) |

---

## 사전 요구사항

- **Python 3.10+**
- **Node.js 18+**
- **FFmpeg**

```bash
# Ubuntu / Debian
sudo apt install ffmpeg

# macOS
brew install ffmpeg
```

---

## 실행 방법

### 원클릭 실행 (권장)

```bash
bash start.sh
```

| 서버 | 주소 |
|------|------|
| 프론트엔드 | http://localhost:5173 |
| 백엔드 API | http://localhost:8000 |

---

### 수동 실행

**백엔드**

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

**프론트엔드** (별도 터미널)

```bash
cd frontend
npm install
npm run dev
```

---

## 프로젝트 구조

```
video_speed_changer/
├── start.sh                  # 백엔드 + 프론트엔드 원클릭 실행
├── backend/
│   ├── main.py               # FastAPI 앱 (변환 · 진행률 SSE · 다운로드)
│   └── requirements.txt
└── frontend/
    ├── src/
    │   ├── App.tsx           # 메인 UI (업로드 → 속도설정 → 변환 → 다운로드)
    │   ├── main.tsx
    │   └── index.css         # Tailwind + 커스텀 슬라이더 · 애니메이션
    ├── vite.config.ts        # /api → localhost:8000 프록시
    └── package.json
```

---

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/convert` | 비디오 업로드 및 변환 시작 → `job_id` 반환 |
| `GET` | `/api/progress/{job_id}` | SSE 스트림으로 진행률 수신 |
| `GET` | `/api/download/{job_id}` | 변환 완료 파일 다운로드 |
| `DELETE` | `/api/cleanup/{job_id}` | 임시 파일 정리 |

---

## FFmpeg 처리 방식

**영상 속도 변경** — `setpts` 필터

```
setpts=PTS/N    # N배속 (N=2 이면 2배속, N=0.5 이면 슬로우모션)
```

**오디오 속도 변경** — `atempo` 필터 체인 (단일 필터는 0.5~2.0 범위만 허용)

```bash
# 8배속 오디오: 2.0 × 2.0 × 2.0
-af "atempo=2.0,atempo=2.0,atempo=2.0"

# 0.1배속 오디오: 0.5 × 0.5 × 0.5 × 0.8
-af "atempo=0.5,atempo=0.5,atempo=0.5,atempo=0.8"

# 100배속 초과: 오디오 트랙 제거
-an
```
