// Parse an HTTP Range header that asks for one byte range.
// Returns { start, end } (both inclusive), null when there is no header,
// or 'invalid' when the header cannot be met (answer 416).
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';

  let start;
  let end;
  if (m[1] === '') {
    const last = Number(m[2]); // "bytes=-500": the last 500 bytes
    if (last === 0) return 'invalid';
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'invalid';
  return { start, end };
}
