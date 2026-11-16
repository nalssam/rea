// Owner of download file names and the Content-Disposition header built from them.

const MAX_BASENAME_CHARS = 120;
const FALLBACK_BASENAME = 'video';

/** Turns an arbitrary remote title into a safe file base name (no extension). */
export function sanitizeBasename(title) {
  let name = typeof title === 'string' ? title.normalize('NFC') : '';
  name = name
    // control chars, bidi overrides, zero-width chars
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    // path separators and characters Windows/macOS refuse
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // no leading dots (hidden files, "..") and no trailing dots/spaces (Windows)
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');

  const chars = Array.from(name); // code points, so surrogate pairs are never split
  if (chars.length > MAX_BASENAME_CHARS) {
    name = chars.slice(0, MAX_BASENAME_CHARS).join('').replace(/[.\s]+$/, '');
  }
  if (name === '' || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) return FALLBACK_BASENAME;
  return name;
}

export function buildFilename(title, ext) {
  const cleanExt = String(ext).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
  return `${sanitizeBasename(title)}.${cleanExt}`;
}

/** RFC 6266 header value: ASCII fallback plus RFC 5987 UTF-8 filename*. */
export function contentDisposition(filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  const asciiBase = base
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\%;]/g, '_')
    .replace(/_+/g, '_')
    .trim();
  const ascii = `${/[A-Za-z0-9]/.test(asciiBase) ? asciiBase : 'download'}${ext}`;
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const CONTENT_TYPES = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
};

export function mediaContentType(ext) {
  return CONTENT_TYPES[String(ext).toLowerCase()] ?? 'application/octet-stream';
}
