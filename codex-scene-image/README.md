# Codex 장면 이미지 서버 플러그인

실리태번 UI 확장에서 받은 프롬프트를 로컬 Codex CLI의 `app-server`로 전달하고 생성된 PNG를 저장합니다. 추가 npm 패키지는 필요하지 않습니다.

## 설치

1. 실리태번 서버를 실행하는 환경에 Codex CLI를 설치합니다. 같은 OS 계정에서 `codex login`으로 ChatGPT에 로그인하고 `codex login status`를 확인합니다.
2. ZIP의 `index.mjs`를 실리태번의 `plugins/codex-scene-image/index.mjs`에 넣습니다.
3. 실리태번의 `config.yaml`에서 `enableServerPlugins: true`로 바꾸고 서버를 재시작합니다.
4. UI 확장을 설치한 뒤 브라우저를 새로고침합니다.

서버는 기본적으로 `codex` 실행 파일을 찾습니다. 별도 경로가 필요한 경우 실리태번을 실행하는 환경의 `ST_CODEX_EXECUTABLE`에 `codex.exe` 또는 npm 패키지의 `bin/codex.js` 절대 경로를 지정할 수 있습니다. Docker로 실행하는 경우에는 컨테이너 안에서 Codex가 실행되고 로그인되어 있어야 합니다.

PNG는 실리태번 사용자 데이터 폴더 아래 `codex-scene-images/<작업 ID>/image.png`에 저장됩니다. 다중 사용자 설정에서는 실리태번 관리자 계정에서 사용할 수 있습니다.

## GitHub에 수동 등록

서버 플러그인용 저장소를 만들고 ZIP의 `index.mjs`와 `README.md`를 저장소 최상위에 올립니다. 설치 폴더의 이름은 `codex-scene-image`를 사용하세요.
