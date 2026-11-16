// Single owner of API error codes, HTTP statuses and Korean user-facing messages.

const CATALOG = {
  bad_request: [400, '요청 형식이 올바르지 않습니다.'],
  invalid_url: [400, '올바른 링크가 아닙니다. https:// 로 시작하는 영상 주소를 넣어 주세요.'],
  unsupported_site: [400, '지원하지 않는 사이트입니다. YouTube, Instagram, Threads, Facebook 링크만 받을 수 있습니다.'],
  batch_limit: [429, '한 번에 받을 수 있는 개수를 넘었습니다. 진행 중인 다운로드가 끝난 뒤 다시 시도해 주세요.'],
  daily_limit: [429, '오늘 받을 수 있는 횟수를 모두 사용했습니다. 내일(한국 시간 자정 이후) 다시 이용해 주세요.'],
  too_large: [413, '파일이 너무 커서 받을 수 없습니다. 더 낮은 화질을 선택해 보세요.'],
  not_found: [404, '요청한 항목을 찾을 수 없습니다. 이미 만료되었을 수 있습니다.'],
  not_ready: [409, '아직 파일이 준비되지 않았습니다.'],
  extract_failed: [502, '영상을 가져오지 못했습니다. 공개된 영상인지 확인한 뒤 다시 시도해 주세요.'],
  internal: [500, '서버에서 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.'],
  busy: [503, '지금은 이용자가 많습니다. 잠시 후 다시 시도해 주세요.'],
};

export class AppError extends Error {
  constructor(code, message, status) {
    const entry = CATALOG[code];
    if (!entry) throw new TypeError(`unknown error code: ${code}`);
    super(message ?? entry[1]);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? entry[0];
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

export const ERROR_CODES = Object.freeze(Object.keys(CATALOG));
