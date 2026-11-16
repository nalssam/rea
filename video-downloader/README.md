# 모아받기

YouTube · Instagram · Facebook(그리고 시험 지원인 Threads)의 **공개 영상** 링크를 여러 개 붙여 넣고, 각각을 MP4(화질 선택) 또는 MP3 파일로 한 번에 내려받는 셀프 호스팅 웹 앱입니다. 링크마다 개별 파일로 저장되며 zip으로 묶지 않습니다.

- npm 런타임 의존성 0개 (Node 내장 `http` 서버 + 정적 프런트엔드, 빌드 단계 없음)
- 실제 추출/변환은 [yt-dlp](https://github.com/yt-dlp/yt-dlp)와 ffmpeg가 담당합니다.
- 모든 상태는 메모리에만 있고, 받은 파일은 전송이 끝난 뒤 짧은 유예 시간(기본 60초)이 지나면 지워집니다.

## 실행

필요한 것: Node.js 20 이상(22 권장), `yt-dlp`, `ffmpeg`(PATH에 있어야 함).

yt-dlp는 반드시 **`pip install "yt-dlp[default]"`** 로 설치하세요(`yt-dlp-ejs` 포함). YouTube는 JS 챌린지를 풀어야 형식 목록이 나오는데, 이 앱은 안전을 위해 `--no-remote-components`로 풀이 스크립트의 원격 다운로드를 막아 두었기 때문에 `yt-dlp-ejs`가 없는 단독 실행 파일/최소 설치에서는 YouTube 화질이 빠지거나 추출이 실패할 수 있습니다. JS 실행기는 따로 설치하지 않아도 서버를 돌리는 Node가 기본으로 쓰입니다(`YTDLP_JS_RUNTIMES` 참고). `yt-dlp -v`의 `JS runtimes:` 줄로 확인할 수 있습니다.

```bash
cd video-downloader
npm start            # http://localhost:3000
```

```bash
SITE_NAME="우리집 받기" PORT=8080 MAX_CONCURRENT=2 npm start
```

### 테스트

```bash
npm test                 # 가짜 yt-dlp로 전체 동작 검증 (네트워크 불필요)
REAL_YTDLP=1 npm test    # + 실제 yt-dlp/ffmpeg: 로컬 mp4/mp3, 세로 영상(HLS) 화질 선택, 리다이렉트·임베드 SSRF 차단
```

`test/fixtures/fake-ytdlp.mjs`는 `YTDLP_PATH`로 끼워 넣는 테스트용 대역입니다. 가짜 도구로 통과한 테스트는 실제 사이트에서의 동작을 보장하지 않습니다(아래 "알아 둘 점" 참고).

## 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `SITE_NAME` | `모아받기` | 화면에 표시되는 사이트 이름 |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 수신 포트와 주소 |
| `TRUST_PROXY` | `0` | 앱 앞에 있는 **신뢰하는 리버스 프록시의 수**. `1`이면 `X-Forwarded-For`의 **오른쪽에서 첫 번째**(프록시가 직접 본 주소), `2`면 오른쪽에서 두 번째 값을 접속자 IP로 씁니다. 왼쪽 값들은 접속자가 마음대로 보낼 수 있으므로 쓰지 않습니다. 프록시가 헤더를 덮어쓰는(값이 하나뿐인) 구성에서는 그 값이 그대로 쓰입니다. 프록시 없이 직접 노출할 때는 반드시 `0`. |
| `MAX_CONCURRENT` | `3` | 동시에 실행하는 다운로드 수 (나머지는 선착순 대기) |
| `MAX_QUEUED` | `100` | 전체 대기열 최대 길이. 넘으면 `busy` |
| `MAX_BATCH` | `20` | IP 하나가 동시에 가질 수 있는 끝나지 않은 작업 수. 대기·다운로드·변환 중인 작업과 **완성됐지만 아직 받아 가지 않은 파일**을 셉니다(받아 간 파일은 세지 않음) |
| `DAILY_PER_IP` | `50` | IP당 하루 작업 생성 횟수. 한국 시간(Asia/Seoul) 자정에 초기화 |
| `MAX_HEIGHT` | `1080` | 허용하는 최대 세로 해상도 |
| `MAX_FILE_MB` | `500` | 파일 하나의 최대 크기 |
| `MAX_STORED_MB` | `3000`(또는 `MAX_FILE_MB`×2 중 큰 값) | 임시 공간 예산. 보관 중인 완성 파일 + 실행 중인 다운로드의 최악 크기가 이 값을 넘으면 새 다운로드는 대기열에서 기다립니다 |
| `DELIVERED_GRACE_SECONDS` | `60` | 전송이 끝난 파일을 지우기 전 유예 시간. 브라우저가 저장에 실패했을 때 다시 받을 수 있게 합니다(`0`이면 즉시 삭제) |
| `FILE_MIN_KBPS` | `64` | 파일 전송의 최소 평균 속도(KB/s). 이보다 느린 수신은 `30초 + 크기/속도` 뒤에 끊습니다 |
| `JOB_TTL_SECONDS` | `900` | 받아 가지 않은 파일과 끝난 작업 기록의 보관 시간 |
| `YTDLP_PATH` | `yt-dlp` | yt-dlp 실행 파일 경로 |
| `YTDLP_JS_RUNTIMES` | 서버를 실행 중인 Node (`node:<경로>`) | yt-dlp `--js-runtimes` 값(쉼표 구분, 예: `deno:/usr/bin/deno`). `auto`로 두면 yt-dlp 기본 동작(deno 탐색)에 맡깁니다 |
| `EGRESS_GUARD` | `1` | 내장 송신 보호(아래 "보안" 참고). `0`이면 끕니다 — 그 경우 방화벽 등으로 직접 막아야 합니다 |
| `HTTPS_PROXY` / `HTTP_PROXY` | (없음) | 서버가 외부로 나갈 때 써야 하는 상위 프록시(`http://` 형식). 송신 보호가 검사를 마친 뒤 이 프록시로 넘깁니다 |
| `EXTRA_ALLOWED_HOSTS` | (없음) | 추가로 허용할 호스트(쉼표 구분, `host` 또는 `host:port`). 정확히 일치하는 호스트만 허용되며 이 호스트들은 `http`와 IP 주소도 허용됩니다. 테스트·사내 서버용 |
| `DOWNLOAD_TIMEOUT_SECONDS` | `1200` | 다운로드 한 건의 최대 실행 시간. 넘으면 프로세스 그룹 전체를 강제 종료 |
| `INFO_TIMEOUT_SECONDS` | `45` | 영상 정보 조회의 최대 실행 시간 |
| `SOCKET_TIMEOUT_SECONDS` | `20` | yt-dlp `--socket-timeout` |
| `INFO_CONCURRENCY` / `INFO_MAX_WAITING` | `2` / `40` | 정보 조회 동시 실행 수 / 대기 가능 수 |
| `INFO_CACHE_SECONDS` | `300` | 정보 조회 결과의 메모리 캐시 시간 |
| `INFO_PER_MINUTE` | `60` | IP당 분당 정보 조회 횟수 |
| `INFO_PER_IP_CONCURRENT` | `4` | IP 하나가 동시에 걸어 둘 수 있는 정보 조회 수(실행 + 대기). 넘으면 `429 busy` |
| `DEBUG` | `0` | `1`이면 실패한 yt-dlp의 마지막 오류 줄을 stderr에 기록(영상 ID가 포함될 수 있음) |

잘못된 값(숫자가 아닌 `PORT` 등)이 있으면 서버는 시작하지 않고 이유를 출력합니다.

## API

오류는 모두 `{"error":{"code":"...","message":"한국어 안내문"}}` 형식입니다.

| 메서드 · 경로 | 설명 |
| --- | --- |
| `GET /api/config` | `{siteName, platforms:[{id,name,experimental}], extraHosts:[...], limits:{...}}` — `extraHosts`는 `EXTRA_ALLOWED_HOSTS`(화면의 링크 사전 검사용) |
| `GET /api/status` | `{active, queued, maxConcurrent, ipToday, dailyPerIp}` |
| `POST /api/info` `{url}` | 제목·업로더·길이·썸네일·선택 가능한 화질(`heights`). 화질 값은 **짧은 변** 기준입니다(1080×1920 세로 영상 = `1080`) |
| `POST /api/jobs` `{url, format:"video"\|"audio", height?}` | `202 {id, status:"queued"}` |
| `GET /api/jobs/:id` | 상태(`queued`/`downloading`/`processing`/`ready`/`error`/`canceled`/`expired`), 진행률, 대기 순번, 파일 이름 |
| `GET /api/jobs/:id/file` | 완성된 파일(첨부). 끝까지 전송되면 `DELIVERED_GRACE_SECONDS`(기본 60초) 동안은 다시 받을 수 있고, 그 뒤 삭제되어 작업이 `expired`가 됩니다. 중간에 끊긴 전송은 TTL 안에서 다시 받을 수 있습니다. 한 파일의 동시 전송은 2개까지(`429 busy`) |
| `DELETE /api/jobs/:id` | 취소(프로세스 트리 종료 + 임시 파일 삭제), `204` |

오류 코드: `invalid_url`, `unsupported_site`, `batch_limit`, `daily_limit`, `too_large`, `not_found`, `not_ready`, `extract_failed`, `busy`, `bad_request`, `internal`.

`POST`/`DELETE`는 이 사이트의 화면에서 보낸 요청만 받습니다: `POST`는 `Content-Type: application/json`이 아니면 `415`, 브라우저가 다른 사이트에서 보낸 요청(`Sec-Fetch-Site`가 `same-origin`이 아니거나 `Origin`이 `Host`와 다름)은 `403`(`bad_request`)입니다. curl 같은 비브라우저 클라이언트는 `Content-Type`만 맞추면 됩니다.

## 동작 방식과 제한

- **허용 링크**: `https`만, 자격 증명·IP 주소·비표준 포트 불가, 길이 2048자 이하. 호스트는 youtube.com, youtu.be, youtube-nocookie.com, instagram.com, threads.net, threads.com, facebook.com, fb.watch와 그 하위 도메인(`m.`, `www.`, `music.` 등)만 허용합니다(`evilyoutube.com`, `youtube.com.evil.com` 같은 주소는 거부).
- **yt-dlp 실행**: 셸 없이 인자 배열로 실행하고 URL은 `--` 뒤에 둡니다. `--ignore-config --no-plugin-dirs --no-remote-components --no-cache-dir --no-cookies --no-exec --no-playlist --playlist-items 1 --max-filesize --socket-timeout`을 항상 붙이며, 실시간 방송은 받지 않습니다.
- **추출기 제한**: 링크의 사이트에 맞는 yt-dlp 전용 추출기만 켭니다(`--use-extractors`: YouTube → `youtube.*`, Instagram → `instagram.*`, Facebook → `facebook.*`). 아무 페이지나 따라가는 범용(generic) 추출기는 꼭 필요한 경우에만 켭니다: 공유 단축 링크(`fb.watch/…`, `facebook.com/share/…`, `instagram.com/share/…` — 리다이렉트를 따라가야 함), Threads, `EXTRA_ALLOWED_HOSTS`.
- **Threads는 시험 지원**: yt-dlp(2026.10 기준)에는 Threads 전용 추출기가 없어 범용 추출기에 의존하며, 실제 게시물에서 동작하는지는 확인하지 못했습니다. 실패하면 그 사실을 알리는 안내문이 나옵니다. 화면과 `/api/config`에도 `experimental`로 표시됩니다.
- **영상**: 요청 화질과 `MAX_HEIGHT` 이하에서 H.264+AAC(mp4/m4a)를 우선 선택해 mp4로 합치고, 없으면 그 범위 안의 최선 형식을 mp4로 담습니다. 화질은 **짧은 변** 기준이라 세로 영상(Shorts·Reels, 1080×1920)도 1080p로 받습니다. **음성**: 최선의 오디오를 MP3로 변환합니다.
- **임시 파일**: 작업마다 `os.tmpdir()` 아래 `moabatgi-XXXXXX` 디렉터리를 만들고, 전송 완료(유예 시간 뒤)·실패·취소·TTL 만료·서버 종료(SIGINT/SIGTERM/SIGHUP/SIGQUIT, 처리되지 않은 오류 포함) 시 지웁니다. 삭제에 실패한 디렉터리는 계속 추적하며 주기적으로 다시 지웁니다. 서버가 강제 종료(SIGKILL, 정전)되어 남은 디렉터리는 다음 시작 때 충분히 오래된 것(다운로드 제한 시간 + TTL + 10분 이상)만 골라 지웁니다.
- **기록**: 접속 IP는 횟수 제한을 위해 메모리에만 두고, URL·IP를 로그로 남기지 않습니다. 재시작하면 대기열·횟수·캐시가 모두 초기화됩니다(프로세스 1개 전제. 여러 인스턴스로 확장하려면 공유 저장소가 필요합니다).
- 한 플레이리스트/여러 영상이 든 게시물은 첫 번째 항목만 받습니다.

## 보안

- **송신 보호(SSRF 방지)**: 링크 검사는 사용자가 넣은 주소만 봅니다. 그 뒤 yt-dlp가 따라가는 리다이렉트·임베드·CDN 주소까지 막기 위해, 서버는 127.0.0.1의 임의 포트에 작은 전달 프록시를 띄우고 모든 yt-dlp를 `--proxy`로 그 프록시에 묶습니다. 이 프록시는 목적지 이름을 직접 조회해 **루프백·사설망(10/8, 172.16/12, 192.168/16)·링크 로컬(169.254/16, 클라우드 메타데이터)·CGNAT·멀티캐스트·IPv6 내부 대역**이면 거부하고, 검사한 그 주소로만 연결합니다(DNS 재바인딩 방지). 포트는 80/443만 허용합니다. `EXTRA_ALLOWED_HOSTS`에 적은 `host[:port]`만 예외입니다.
  - 상위 프록시(`HTTPS_PROXY`/`HTTP_PROXY`)를 쓰는 환경에서는 검사 후 그 프록시로 넘기므로, 주소 고정은 상위 프록시의 몫입니다.
  - 방어를 겹치려면 컨테이너/호스트 방화벽에서도 yt-dlp가 내부망으로 나가지 못하게 막으세요(예: 전용 Docker 네트워크, `iptables`로 RFC1918·169.254.0.0/16 차단). `EGRESS_GUARD=0`으로 끈 경우에는 이것이 유일한 방어선입니다.
- **다른 사이트발 요청 차단**: 위 API 절 참고. 제3의 웹페이지가 방문자의 브라우저로 다운로드를 걸어 방문자의 하루 횟수와 서버 자원을 쓰는 것을 막습니다.
- **자원 한도**: IP당 정보 조회 동시 수, 받아 가지 않은 파일을 포함한 `MAX_BATCH`, 전체 임시 공간 예산(`MAX_STORED_MB`), 느린 수신 차단(`FILE_MIN_KBPS`)으로 한 접속자가 조회 슬롯이나 디스크를 독점하지 못하게 합니다.

## 배포

### Docker

```bash
docker build -t moabatgi .
# 같은 호스트의 리버스 프록시(nginx/Caddy) 뒤에 둘 때: 루프백에만 공개하고 TRUST_PROXY=1
docker run -d --name moabatgi -p 127.0.0.1:3000:3000 \
  -e SITE_NAME="모아받기" -e TRUST_PROXY=1 \
  --tmpfs /tmp:rw,size=4g \
  moabatgi

# 프록시 없이 포트를 직접 공개할 때: TRUST_PROXY를 켜지 마세요
docker run -d --name moabatgi -p 3000:3000 --tmpfs /tmp:rw,size=4g moabatgi
```

> **주의**: `TRUST_PROXY`를 켠 채 포트를 인터넷에 직접 공개하면 접속자가 `X-Forwarded-For`를 꾸며 IP별 제한(하루 횟수, 동시 작업 수)을 전부 우회할 수 있습니다. 프록시를 거치지 않는 경로는 방화벽이나 `127.0.0.1` 바인딩으로 막아 두세요.

- 이미지에는 Node 22, ffmpeg, yt-dlp(`pip install "yt-dlp[default]"`)가 들어갑니다. yt-dlp는 사이트 변경에 맞춰 자주 갱신되므로 **주기적으로 이미지를 다시 빌드**하세요.
- 임시 공간: 완성 파일과 실행 중인 다운로드는 `MAX_STORED_MB`(기본 3000MB) 안에서 관리되지만, 영상+음성을 합치는 동안에는 작업당 최대 `MAX_FILE_MB`만큼이 잠시 더 필요합니다. `/tmp`는 `MAX_STORED_MB + MAX_FILE_MB × MAX_CONCURRENT`보다 크게 잡으세요(기본값이면 4.5GB — 위 예시의 4GB tmpfs를 쓰려면 `-e MAX_STORED_MB=2500`). tmpfs는 RAM을 쓰므로 메모리가 부족하면 디스크 볼륨을 `/tmp`에 연결하세요.
- YouTube 추출에 필요한 JS 실행기로는 서버의 Node가 쓰입니다. 더 엄격한 격리를 원하면 deno를 설치하고 `YTDLP_JS_RUNTIMES=deno:/경로`로 지정하세요.

### 리버스 프록시

HTTPS는 nginx/Caddy 등에서 종료하고 `TRUST_PROXY=1`을 켭니다(CDN + nginx처럼 두 단계면 `2`). 앱은 프록시가 붙인 **맨 오른쪽** 주소만 믿으므로 `$remote_addr`로 덮어쓰든 `$proxy_add_x_forwarded_for`로 덧붙이든 접속자가 IP를 속일 수 없습니다. `Host` 헤더는 원래 값을 그대로 넘겨 주세요(같은 사이트 요청인지 확인하는 데 쓰입니다). 큰 파일 전송을 위해 프록시의 응답 버퍼링을 끄는 것이 좋습니다.

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Host $host;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_buffering off;
  proxy_read_timeout 300s;
}
```

## 알아 둘 점

- **실제 사이트 검증 범위**: 개발 환경의 네트워크 제한 때문에 실제 YouTube·Instagram·Facebook·Threads 파일을 끝까지 받아 보는 검증은 하지 못했습니다. 실제 yt-dlp/ffmpeg 경로(가로·세로 HLS, DASH 병합, MP3 변환, 크기 제한, SSRF 차단)는 로컬 원본 서버로 검증했습니다. 공개 배포 전에 각 사이트의 링크로 직접 확인해 보세요.
- 새로 고침하면 진행 중인 다운로드는 취소되고(브라우저가 먼저 확인을 묻습니다) 하루 횟수는 돌아오지 않습니다. 링크 목록은 같은 탭에서 다시 불러옵니다.
- 클라우드/데이터센터 IP에서는 YouTube가 "봇이 아님을 확인" 요구로 추출을 막는 일이 잦고, Instagram·Threads·Facebook은 로그인 없이는 일부 게시물만 받을 수 있습니다. 이 앱은 쿠키나 로그인을 사용하지 않으므로 그런 경우 `extract_failed`로 안내합니다.
- 누구나 접속할 수 있는 곳에 공개하면 서버의 회선과 CPU를 다른 사람이 쓰게 됩니다. 제한값을 낮추거나 프록시에서 접근 제어를 걸어 주세요.

## 법적 고지

이 도구는 **본인이 권리를 가진 콘텐츠이거나 저장을 허락받은 콘텐츠**를 개인적으로 보관하기 위한 것입니다. 저작권자의 허락 없이 콘텐츠를 내려받거나 다시 배포하는 것은 저작권법과 각 서비스의 이용 약관에 어긋날 수 있으며, 그 책임은 이용자와 운영자에게 있습니다. DRM 등 기술적 보호 조치를 우회하지 않습니다.
