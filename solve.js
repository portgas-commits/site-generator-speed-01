// Fast static site builder: a from-scratch, dependency-free reimplementation of
// makefun-site 1.0.0's build, tuned for speed. It reads one site
// ({ site, templates, files }) and returns the same output tree makefun-site
// returns, byte for byte, but faster: templates are compiled once into plain
// JavaScript render functions, Markdown is rendered by a single-pass scanner
// with batched plain-text runs, slugs are cached, and hot helpers avoid
// regular expressions wherever a manual scan is cheaper.
//
// run(input) is the only export: the harness calls it once per case.

const SLUG_MAX = 64;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED_DIRS = ['posts', 'tags', 'page'];
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// ---------------------------------------------------------------- text bits

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;

/** `s` with & < > " ' escaped; unchanged when it holds none of them. */
function esc(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_ALL, (c) => ESC_MAP[c]);
}

/**
 * `esc` with a per-run cache: template values (titles, urls, tag names) are
 * rendered again and again, and the same string object comes back each time,
 * so the escape is paid once per distinct value instead of once per render.
 */
function makeEscCached() {
  const cache = new Map();
  return (s) => {
    const hit = cache.get(s);
    if (hit !== undefined) return hit;
    const r = esc(s);
    if (cache.size < 20000) cache.set(s, r);
    return r;
  };
}

/** One escaped character, for the backslash-escape branch of inline rendering. */
function escChar(c) {
  if (c === '>') return '&gt;';
  if (c === '"') return '&quot;';
  if (c === "'") return '&#39;';
  return c;
}

// ---------------------------------------------------------------- slugs

const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, each run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure-ASCII input skips normalisation: it is already NFKD and holds no marks.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const result = out === '' ? 'untitled' : out;
  if (slugCache.size < 50000) slugCache.set(text, result);
  return result;
}

/**
 * `slug` made unique against `taken` (and added to it): the first of slug,
 * slug-2, slug-3 ... not taken. `next` remembers, per base slug, the suffix
 * where the last search stopped, so a repeated slug never rescans from 2.
 */
function uniqueSlug(slug, taken, next) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let n = next.get(slug) || 2;
  let cand = slug + '-' + n;
  while (taken.has(cand)) {
    n++;
    cand = slug + '-' + n;
  }
  next.set(slug, n + 1);
  taken.add(cand);
  return cand;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
}

// ---------------------------------------------------------------- word count

/** Whether a UTF-16 code unit is JavaScript whitespace (the \s set). */
function isWS(code) {
  return code === 32 || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
    code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f ||
    code === 0x3000 || code === 0xfeff;
}

/** A lookup table for the same set, so the word count scans without a call per character. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [32, 9, 10, 11, 12, 13, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- line bits

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs dropped at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return line.slice(a, b);
}

/** Whether `s` holds only spaces and tabs. */
function onlySpacesTabs(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || t.includes('"') || t.includes('[') || t.includes(']'))) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * One front-matter line, or null when it is not "key: value": the key, and the
 * value with its trailing spaces and tabs dropped.
 */
function parseKeyLine(line) {
  let i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 97 && c <= 122) || c === 95) i++;
    else break;
  }
  if (i === 0 || line.charCodeAt(i) !== 58) return null;
  const key = line.slice(0, i);
  let raw;
  if (i + 1 === line.length) raw = '';
  else if (line.charCodeAt(i + 1) === 32) raw = line.slice(i + 2);
  else return null;
  let end = raw.length;
  while (end > 0) {
    const c = raw.charCodeAt(end - 1);
    if (c === 32 || c === 9) end--;
    else break;
  }
  return { key, raw: raw.slice(0, end) };
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Only the front
 * matter itself is split into lines; the body is sliced out whole.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let closeStart = -1;
  let searchFrom = 3;
  while (true) {
    const idx = text.indexOf('\n---', searchFrom);
    if (idx === -1) break;
    const after = idx + 4;
    if (after === text.length || text.charCodeAt(after) === 10) {
      closeStart = idx + 1;
      break;
    }
    searchFrom = idx + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const fmLines = text.slice(4, closeStart - 1).split('\n');
  const data = {};
  for (let j = 0; j < fmLines.length; j++) {
    const line = fmLines[j];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const kv = parseKeyLine(line);
    if (kv === null) return { error: `line ${j + 2} is not "key: value"` };
    if (!FM_KEYS.has(kv.key)) return { error: `unknown key "${kv.key}"` };
    if (Object.hasOwn(data, kv.key)) return { error: `key "${kv.key}" is given twice` };
    if (kv.raw === '') return { error: `key "${kv.key}" has no value` };
    const v = valueOf(kv.key, kv.raw);
    if ('error' in v) return v;
    data[kv.key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeStart + 3) };
}

// ---------------------------------------------------------------- Markdown

/** Whether a backslash escapes the character with this code. */
function isEscapable(code) {
  return code === 92 || code === 96 || code === 42 || code === 95 || code === 91 || code === 93 ||
    code === 40 || code === 41 || code === 35 || code === 43 || code === 45 || code === 46 ||
    code === 33 || code === 62;
}

/** A fence-open line's language, or null when the line opens no fence. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = line.slice(3, j);
  while (j < line.length) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

/** Whether a line closes a fence. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (d >= line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let j = d;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === j) return null;
  return { depth: d, text: line.slice(j, end) };
}

/** Whether a line is a thematic break. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** A bullet list line's item text, or null. */
function bulletItem(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered list line's item text, or null. */
function orderedItem(line) {
  let j = 0;
  while (j < line.length && j < 9) {
    const c = line.charCodeAt(j);
    if (c >= 48 && c <= 57) j++;
    else break;
  }
  if (j >= 1 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) return line.slice(j + 2);
  return null;
}

/** An ordered list line's first number, or null when it is no ordered item. */
function orderedStart(line) {
  let j = 0;
  while (j < line.length && j < 9) {
    const c = line.charCodeAt(j);
    if (c >= 48 && c <= 57) j++;
    else break;
  }
  if (j >= 1 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) return Number(line.slice(0, j));
  return null;
}

/** Whether a line continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j < line.length && !isWS(line.charCodeAt(j));
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The inline specials a scan jumps between: backslash, backtick, star, bracket. */
const INLINE_SPECIAL = /[\\`*[]/g;

/**
 * `s` rendered inline; `link(target)` is a link's href. A native scan jumps
 * from one special character to the next, and plain text between them is
 * copied in whole runs and escaped once per run.
 */
function inlineRender(s, link) {
  const out = [];
  let plain = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s[j];
    if (c === '\\' && j + 1 < n && isEscapable(s.charCodeAt(j + 1))) {
      if (j > plain) out.push(esc(s.slice(plain, j)));
      out.push(escChar(s[j + 1]));
      i = j + 2;
      plain = i;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(esc(s.slice(plain, j)));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (j > plain) out.push(esc(s.slice(plain, j)));
          out.push('<strong>', inlineRender(s.slice(j + 2, k), link), '</strong>');
          i = k + 2;
          plain = i;
          continue;
        }
        i = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        if (j > plain) out.push(esc(s.slice(plain, j)));
        out.push('<em>', inlineRender(s.slice(j + 1, k), link), '</em>');
        i = k + 1;
        plain = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    if (c === '[') {
      const kk = findUnescaped(s, ']', j + 1);
      const mm = kk !== -1 && s[kk + 1] === '(' ? s.indexOf(')', kk + 2) : -1;
      const target = mm === -1 ? '' : s.slice(kk + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (j > plain) out.push(esc(s.slice(plain, j)));
        out.push('<a href="', esc(link(target)), '">', inlineRender(s.slice(j + 1, kk), link), '</a>');
        i = mm + 1;
        plain = i;
        continue;
      }
      i = j + 1;
      continue;
    }
    i = j + 1;
  }
  if (n > plain) out.push(esc(s.slice(plain, n)));
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the
 * last), its table of contents (every level 2 and 3 heading: level, id and
 * its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  const idNext = new Map();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      let code = '<pre><code';
      if (lang !== '') code += ' class="language-' + esc(lang) + '"';
      code += '>';
      for (let b = 0; b < body.length; b++) {
        code += esc(body[b]);
        code += '\n';
      }
      code += '</code></pre>';
      blocks.push(code);
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text), ids, idNext);
      const html = inlineRender(hd.text, link);
      blocks.push('<h' + hd.depth + ' id="' + id + '">' + html + '</h' + hd.depth + '>');
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.startsWith('> ') ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inlineRender(kept.join('\n'), link) + '</p>\n</blockquote>');
      continue;
    }
    const bullet = bulletItem(line);
    const ordered = bullet === null ? orderedStart(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const m = isOrdered ? orderedItem(lines[i]) : bulletItem(lines[i]);
        if (m !== null) {
          items.push([trimLine(m)]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered !== 1 ? '<ol start="' + ordered + '">' : '<' + tag + '>';
      let html = open + '\n';
      for (let it = 0; it < items.length; it++) html += '<li>' + inlineRender(items[it].join('\n'), link) + '</li>\n';
      html += '</' + tag + '>';
      blocks.push(html);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineRender(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.map((b) => b + '\n').join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = onlySpacesTabs(src.slice(lineStart, open)) && onlySpacesTabs(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else !== null ? parent.else : parent.then);
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The helpers a compiled template calls: the escape, the value-as-text and the if-truthiness. */
function makeHelpers() {
  return { esc: makeEscCached(), txt: textOf, tru: truthy };
}

/**
 * A parsed template compiled into a render function (S, O, D, M, H): S is the
 * scope (a null-prototype object holding the page's values and the loop
 * bindings in force), O the output chunks, D the include depth, M the map of
 * compiled templates by name, H the helpers above. A for loop writes its
 * element and its loop record into S and restores them afterwards, so an
 * include renders in exactly the scope its caller had, and a path's first
 * name is one property read instead of a walk up a scope chain.
 */
function compileTemplate(nodes) {
  const parts = [];
  const temps = [];
  let tmp = 0;
  let forCount = 0;

  /** Code that sets a fresh temp to the value at `path` in S; returns the temp. */
  function lookup(path) {
    const t = '_v' + (tmp++);
    temps.push(t);
    let code = t + '=S.' + path[0] + ';\n';
    for (let k = 1; k < path.length; k++) {
      code += 'if(' + t + '!==null&&typeof ' + t + '==="object"&&Object.hasOwn(' + t + ',' + JSON.stringify(path[k]) + '))' + t + '=' + t + '.' + path[k] + ';else ' + t + '=undefined;\n';
    }
    return { t, code };
  }

  function emit(list) {
    for (const n of list) {
      if (n.kind === 'text') {
        parts.push('O.push(' + JSON.stringify(n.text) + ');');
      } else if (n.kind === 'var' || n.kind === 'raw') {
        const l = lookup(n.path);
        parts.push(l.code);
        parts.push(n.kind === 'var' ? 'O.push(H.esc(H.txt(' + l.t + ')));' : 'O.push(H.txt(' + l.t + '));');
      } else if (n.kind === 'if') {
        const l = lookup(n.path);
        parts.push(l.code);
        parts.push('if(' + (n.not ? '!' : '') + 'H.tru(' + l.t + ')){');
        emit(n.then);
        if (n.else !== null) {
          parts.push('}else{');
          emit(n.else);
        }
        parts.push('}');
      } else if (n.kind === 'for') {
        const l = lookup(n.path);
        const id = forCount++;
        const xs = '_x' + id;
        const nn = '_n' + id;
        const kk = '_k' + id;
        const sv = '_s' + id;
        const sl = '_l' + id;
        const lo = '_o' + id;
        parts.push(l.code);
        parts.push('if(Array.isArray(' + l.t + ')){');
        parts.push('const ' + xs + '=' + l.t + ',' + nn + '=' + xs + '.length,' + sv + '=S.' + n.name + ',' + sl + '=S.loop,' + lo + '={index:0,first:false,last:false,length:' + nn + '};');
        parts.push('S.loop=' + lo + ';');
        parts.push('for(let ' + kk + '=0;' + kk + '<' + nn + ';' + kk + '++){');
        parts.push('S.' + n.name + '=' + xs + '[' + kk + '];S.loop=' + lo + ';' + lo + '.index=' + kk + '+1;' + lo + '.first=' + kk + '===0;' + lo + '.last=' + kk + '===' + nn + '-1;');
        emit(n.body);
        parts.push('}');
        parts.push('S.' + n.name + '=' + sv + ';S.loop=' + sl + ';');
        parts.push('}');
      } else if (n.kind === 'include') {
        parts.push('if(D<' + INCLUDE_DEPTH + '){const _f=M.get(' + JSON.stringify(n.name) + ');if(_f!==undefined)_f(S,O,D+1,M,H);}');
      }
    }
  }

  emit(nodes);
  const decl = temps.length > 0 ? 'let ' + temps.join(',') + ';\n' : '';
  return new Function('S', 'O', 'D', 'M', 'H', decl + parts.join('\n'));
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
function linkOf(s) {
  return s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s, card) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const report = [];

  // Templates, parsed in code-unit order of their names; one that does not
  // parse is reported and left out. Identical sources share one compilation.
  const fns = new Map();
  const compiledBySource = new Map();
  const names = Object.keys(input.templates).sort();
  for (let ni = 0; ni < names.length; ni++) {
    const name = names[ni];
    const src = input.templates[name];
    try {
      const nodes = parseTemplate(name, src);
      let fn = compiledBySource.get(src);
      if (fn === undefined) {
        fn = compileTemplate(nodes);
        compiledBySource.set(src, fn);
      }
      fns.set(name, fn);
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  // Front matter and the checks, in order: refused, generator-owned
  // directory, a post with no date, an unknown layout, then a draft.
  const kept = [];
  for (let si = 0; si < sources.length; si++) {
    const s = sources[si];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    if (s.path.startsWith('tags/')) {
      report.push(`refused ${s.path}: tags/ is the generator's own`);
      continue;
    }
    if (s.path.startsWith('page/')) {
      report.push(`refused ${s.path}: page/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!fns.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug, unique in its directory, in source order.
  const bySource = new Map();
  const takenByDir = new Map();
  const nextByDir = new Map();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let taken = takenByDir.get(dir);
    if (taken === undefined) {
      taken = new Set(dir === '' ? RESERVED_DIRS : []);
      takenByDir.set(dir, taken);
    }
    let next = nextByDir.get(dir);
    if (next === undefined) {
      next = new Map();
      nextByDir.set(dir, next);
    }
    s.slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), taken, next);
    s.outDir = dir === '' ? s.slug : dir + '/' + s.slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const dir = dirOf(s.path);
    const link = (target) => {
      if (SCHEME.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return pg.url + frag;
        if (staticPaths.has(path)) return base + '/' + path + frag;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, then by slug; each post's
  // newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => {
    if (y.data.date !== x.data.date) return y.data.date < x.data.date ? -1 : 1;
    if (x.slug !== y.slug) return x.slug < y.slug ? -1 : 1;
    return 0;
  });
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts'
  // order, ordered by count and then slug.
  const bySlug = new Map();
  for (let pi = 0; pi < posts.length; pi++) {
    const p = posts[pi];
    p.tagRefs = [];
    const seen = new Set();
    const names = p.data.tags !== undefined ? p.data.tags : [];
    for (let ti = 0; ti < names.length; ti++) {
      const name = names[ti];
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    if (s.post) continue;
    s.tagRefs = [];
    const seen = new Set();
    const names = s.data.tags !== undefined ? s.data.tags : [];
    for (let ti = 0; ti < names.length; ti++) {
      const name = names[ti];
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      const tag = bySlug.get(slug);
      s.tagRefs.push(tag !== undefined ? tag : { name, slug, url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => {
    if (y.posts.length !== x.posts.length) return y.posts.length - x.posts.length;
    if (x.slug !== y.slug) return x.slug < y.slug ? -1 : 1;
    return 0;
  });

  // Layouts: every page through its layout, the index pages and the tag
  // pages through theirs, then the static files at their own paths.
  const cards = new Map();
  for (let pi = 0; pi < posts.length; pi++) cards.set(posts[pi], cardOf(posts[pi]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const helpers = makeHelpers();
  const output = {};
  const render = (name, vars) => {
    const fn = fns.get(name);
    if (fn === undefined) return null;
    const S = Object.create(null);
    S.site = site;
    S.tags = allTags;
    S.recent = recent;
    if (vars.page !== undefined) S.page = vars.page;
    if (vars.posts !== undefined) S.posts = vars.posts;
    if (vars.pager !== undefined) S.pager = vars.pager;
    if (vars.tag !== undefined) S.tag = vars.tag;
    const O = [];
    fn(S, O, 0, fns, helpers);
    return O.join('');
  };
  for (let si = 0; si < kept.length; si++) {
    const s = kept[si];
    const card = s.post ? cards.get(s) : cardOf(s);
    output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s, card) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let ti = 0; ti < tags.length; ti++) {
    const t = tags[ti];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let fi = 0; fi < statics.length; fi++) {
    const f = statics[fi];
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort();
  let pageCount = 0;
  for (let si = 0; si < kept.length; si++) if (!kept[si].post) pageCount++;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = lines.join('\n') + '\n';
  return output;
}
