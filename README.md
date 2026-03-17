# Video Speed Changer

비디오 파일의 재생 속도를 자유롭게 조절할 수 있는 웹 애플리케이션입니다.
**0.01x 슬로우모션**부터 **1000x 초고속**까지 지원하며, FFmpeg 서버 사이드 처리로 실제 파일을 변환하여 다운로드할 수 있습니다.

---

## 주요 기능

- **광범위한 배속 지원** — 0.01x ~ 1000x (로그 스케일 슬라이더 · 프리셋 · 직접 입력)
- **고품질 변환** — minterpolate 프레임 보간 적용 (고급 옵션에서 토글)
- **구간 선택(Trim)** — 시작·종료 시점을 초 단위로 지정하거나 현재 재생 위치로 설정
- **크롭(Crop)** — 비디오 위에서 드래그하여 유지할 영역 지정
- **화질 조절(CRF)** — CRF 0~51 슬라이더로 파일 크기 vs 화질 직접 제어
- **출력 포맷 선택** — MP4 / MOV / WebM
- **실시간 진행률** — SSE(Server-Sent Events)로 0.3초 단위 스트리밍
- **변환 취소** — 진행 중 취소 가능, FFmpeg 프로세스 즉시 종료
- **오디오 자동 처리** — 100x 이하: atempo 필터 체인, 100x 초과: 오디오 자동 제거
- **HTML5 미리보기** — 변환 전 브라우저에서 즉시 속도 미리보기 (최대 16x)
- **변환 결과 예측** — 출력 길이 · 해상도 · 예상 파일 크기 실시간 표시
- **대용량 파일 지원** — 1MB 청크 단위 업로드로 메모리 절약

---

## 기술 스택

| 레이어 | 기술 |
|--------|------|
| 프론트엔드 | React 18 + TypeScript + Tailwind CSS |
| 빌드 도구 | Vite 5 |
| 백엔드 | FastAPI (Python 3.12) |
| 비디오 처리 | FFmpeg (`minterpolate` · `setpts` · `atempo` 필터) |
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

### 최초 설치

```bash
bash setup.sh
```

의존성 설치만 수행합니다 (백엔드 venv · pip, 프론트엔드 npm).

### 서버 시작 (권장)

```bash
bash start.sh
```

| 서버 | 주소 |
|------|------|
| 프론트엔드 | http://localhost:5173 |
| 백엔드 API | http://localhost:8000 |

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
├── setup.sh                  # 최초 의존성 설치
├── start.sh                  # 백엔드 + 프론트엔드 원클릭 실행
├── backend/
│   ├── main.py               # FastAPI 앱 (변환 · 진행률 SSE · 다운로드 · 취소)
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
| `DELETE` | `/api/cancel/{job_id}` | 변환 취소 및 FFmpeg 프로세스 종료 |
| `DELETE` | `/api/cleanup/{job_id}` | 임시 파일 정리 |

### POST `/api/convert` 파라미터

| 파라미터 | 타입 | 기본값 | 설명 |
|----------|------|--------|------|
| `file` | File | 필수 | 입력 비디오 |
| `speed` | float | 필수 | 배속 (0 초과 ~ 1000) |
| `trim_start` | float | 0.0 | 구간 시작 (초) |
| `trim_end` | float | 0.0 | 구간 종료 (초, 0 = 끝까지) |
| `crf` | int | 23 | 화질 (0=최고 ~ 51=최저) |
| `output_format` | string | mp4 | 출력 포맷 (`mp4` / `mov` / `webm`) |
| `crop_x` | int | 0 | 크롭 X 좌표 |
| `crop_y` | int | 0 | 크롭 Y 좌표 |
| `crop_w` | int | 0 | 크롭 너비 (0 = 크롭 없음) |
| `crop_h` | int | 0 | 크롭 높이 (0 = 크롭 없음) |
| `high_quality` | bool | false | minterpolate 프레임 보간 사용 |

---

## FFmpeg 처리 방식

### 기본 모드 (빠른 처리)

```
fps(CFR 정규화) → setpts=PTS/N → fps
```

VFR(가변 프레임레이트) 입력을 CFR로 정규화한 뒤 `setpts`로 타임스탬프를 조정하고 목표 fps로 리샘플링합니다.

### 고품질 모드 (minterpolate 보간)

**가속 (1x < speed ≤ 8x)**
```
fps → minterpolate(fps=speed×input_fps, mi_mode=blend) → setpts=PTS/N → fps
```
버려질 프레임을 블렌딩 보간으로 먼저 채운 뒤 속도를 높입니다.

**감속 (speed < 1x)**
```
fps → setpts=PTS/N → minterpolate(fps=input_fps, mi_mode=blend)
```
늘어난 프레임 간격을 블렌딩 보간으로 채웁니다.

> speed > 8x 또는 보간 필터 오류 시 자동으로 기본 모드로 폴백합니다.

### 오디오 속도 변경 — `atempo` 필터 체인

단일 `atempo` 필터는 0.5~2.0 범위만 허용하므로 체인으로 연결합니다.

```bash
# 8배속: 2.0 × 2.0 × 2.0
-af "atempo=2.0,atempo=2.0,atempo=2.0"

# 0.1배속: 0.5 × 0.5 × 0.5 × 0.8
-af "atempo=0.5,atempo=0.5,atempo=0.5,atempo=0.8"

# 100배속 초과: 오디오 트랙 제거
-an
```
