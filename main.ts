// mend: one patch tool for every AI edit format (SPEC.md v1).
// Node 22 standard library only. Deterministic: no clock, no randomness.
// Written from scratch from SPEC.md (this session); the kit's runner.ts is
// kept verbatim beside it and is only called for the trial hand-over.
import { runTrial } from './runner.ts';
import * as fs from 'node:fs';

// Entry point is at the bottom of the file (after every declaration),
// so the classes main() uses are initialized before it runs.

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

function out(lines: string[]): void {
  process.stdout.write(lines.join('\n') + '\n');
}

function isBlankLine(l: string): boolean {
  return l.trim() === '';
}

/** A patch's lines: split at \n, one trailing \r removed from each, without the empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  const lines = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/** A path is safe when it is not empty, does not start with /, holds no \, and no segment is empty, . or ... */
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function trimEndWS(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWS(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function isOnlyWS(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

// ---------------------------------------------------------------------------
// The tree: files are read lazily from disk on first touch and only the
// files a patch changed are written back, so untouched files keep their bytes.
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  brk: '\r\n' | '\n';
  eol: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', eol: false };
  const firstLF = text.indexOf('\n');
  const brk: '\r\n' | '\n' = firstLF > 0 && text[firstLF - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let eol = false;
  if (text.endsWith(brk)) {
    parts.pop();
    eol = true;
  }
  return { lines: parts, brk, eol };
}

function serialize(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.brk) + (st.eol ? st.brk : '');
}

class Tree {
  private cache = new Map<string, FileState | null>();
  private original = new Map<string, string | null>();

  /** Current state, or null when the path holds no file. */
  get(p: string): FileState | null {
    if (this.cache.has(p)) return this.cache.get(p) as FileState | null;
    let st: FileState | null = null;
    try {
      const s = fs.statSync(p);
      if (s.isFile()) {
        const text = fs.readFileSync(p, 'utf8');
        st = parseFile(text);
        this.original.set(p, text);
      } else {
        this.original.set(p, null);
      }
    } catch {
      this.original.set(p, null);
    }
    this.cache.set(p, st);
    return st;
  }

  exists(p: string): boolean {
    return this.get(p) !== null;
  }

  set(p: string, st: FileState): void {
    this.get(p);
    this.cache.set(p, st);
  }

  del(p: string): void {
    this.get(p);
    this.cache.set(p, null);
  }

  /** Every path the patch touched, with its before/after bytes. */
  touched(): { path: string; before: string | null; after: string | null }[] {
    const outList: { path: string; before: string | null; after: string | null }[] = [];
    for (const [p, cur] of this.cache) {
      outList.push({ path: p, before: this.original.get(p) ?? null, after: cur === null ? null : serialize(cur) });
    }
    return outList;
  }

  /** Write every change to disk (only files whose bytes differ). */
  writeAll(): void {
    for (const t of this.touched()) {
      if (t.before === t.after) continue;
      if (t.after === null) {
        fs.unlinkSync(t.path);
      } else {
        const dir = t.path.split('/').slice(0, -1).join('/');
        if (dir !== '') fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(t.path, t.after, 'utf8');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Matching (section 5): three tiers, first tier with an occurrence wins.
// ---------------------------------------------------------------------------

function lineEqAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWS(a) === trimEndWS(b);
  return trimWS(a) === trimWS(b);
}

function findOccurrences(lines: string[], o: string[], tier: number): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEqAtTier(lines[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

interface TierHit {
  tier: number;
  positions: number[];
}

function findTier(lines: string[], o: string[], strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = findOccurrences(lines, o, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

interface NEntry {
  text: string;
  /** A context line: written as the file's own matched line. */
  ctx: boolean;
  /** Index of this line inside O (context lines only). */
  oIndex: number;
  /** A \ line immediately follows this body line. */
  bs: boolean;
}

/**
 * The lines N writes when O matched at `pos`. Context lines come from the
 * file; at tier 2 the other lines are re-indented from O's first line's
 * leading whitespace to the file's first matched line's.
 */
function buildReplacement(
  fileLines: string[],
  pos: number,
  o: string[],
  n: NEntry[],
  tier: number,
): string[] {
  const outLines: string[] = [];
  const f = o.length > 0 ? leadingWS(fileLines[pos]) : '';
  const p = o.length > 0 ? leadingWS(o[0]) : '';
  for (const e of n) {
    if (e.ctx) {
      outLines.push(fileLines[pos + e.oIndex]);
    } else if (tier === 2 && o.length > 0) {
      const t = e.text;
      if (t !== '' && !isOnlyWS(t) && t.startsWith(p)) outLines.push(f + t.slice(p.length));
      else outLines.push(t);
    } else {
      outLines.push(e.text);
    }
  }
  return outLines;
}

// ---------------------------------------------------------------------------
// Edits and the apply driver (section 10: order and atomicity).
// ---------------------------------------------------------------------------

type ApplyOk = { ok: true; move?: { old: string; nw: string } };
type ApplyFail = { ok: false; code: string; path: string };
type ApplyResult = ApplyOk | ApplyFail;

interface Edit {
  run(tree: Tree, strict: boolean): ApplyResult;
}

function fail(code: string, path: string): ApplyFail {
  return { ok: false, code, path };
}

/** Byte order of paths (UTF-8), for the exit-0 change lines. */
function byteCompare(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return Buffer.compare(ba, bb);
}

function computeChanges(tree: Tree, moves: { old: string; nw: string }[]): string[] {
  const lines: { key: string; text: string }[] = [];
  const moveNew = new Map<string, string>(); // new path -> old path, for R lines that hold
  const moveOld = new Set<string>();
  for (const m of moves) {
    const beforeOld = tree.touched().find((t) => t.path === m.old);
    const beforeNew = tree.touched().find((t) => t.path === m.nw);
    const oldGone = beforeOld !== undefined && beforeOld.before !== null && beforeOld.after === null;
    const newCame = beforeNew !== undefined && beforeNew.before === null && beforeNew.after !== null;
    if (oldGone && newCame) {
      moveNew.set(m.nw, m.old);
      moveOld.add(m.old);
    }
  }
  for (const t of tree.touched()) {
    if (t.before === t.after) continue;
    if (moveOld.has(t.path)) continue; // covered by an R line
    if (moveNew.has(t.path)) continue; // covered by an R line
    if (t.before === null && t.after !== null) lines.push({ key: t.path, text: `A ${t.path}` });
    else if (t.before !== null && t.after === null) lines.push({ key: t.path, text: `D ${t.path}` });
    else lines.push({ key: t.path, text: `M ${t.path}` });
  }
  for (const [nw, old] of moveNew) {
    lines.push({ key: nw, text: `R ${old} -> ${nw}` });
  }
  lines.sort((a, b) => byteCompare(a.key, b.key));
  return lines.map((l) => l.text);
}

// ---------------------------------------------------------------------------
// Invocation (section 1) and the main flow (section 2).
// ---------------------------------------------------------------------------

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): { opts: Options } | { usage: true } {
  let format = 'auto';
  let check = false;
  let strict = false;
  let formatSeen = false;
  let checkSeen = false;
  let strictSeen = false;
  const positionals: string[] = [];
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (formatSeen) return { usage: true };
        formatSeen = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') {
          return { usage: true };
        }
        format = v;
      } else if (a === '--check') {
        if (checkSeen) return { usage: true };
        checkSeen = true;
        check = true;
      } else if (a === '--strict') {
        if (strictSeen) return { usage: true };
        strictSeen = true;
        strict = true;
      } else {
        return { usage: true };
      }
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length > 1) return { usage: true };
  return { opts: { format, check, strict, patch: positionals.length === 1 ? positionals[0] : null } };
}

/** Format detection (section 4): the first of these that holds. */
function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | null = null;
  for (const l of lines) {
    if (!isBlankLine(l)) {
      firstNonBlank = l;
      break;
    }
  }
  if (firstNonBlank !== null) {
    if (firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
    const c = firstNonBlank.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ('usage' in parsed) {
    out(['error: usage']);
    process.exitCode = 2;
    return;
  }
  const { format, check, strict, patch } = parsed.opts;

  let patchText: string;
  if (patch === null || patch === '-') {
    patchText = fs.readFileSync(0, 'utf8');
  } else {
    try {
      patchText = fs.readFileSync(patch, 'utf8');
    } catch {
      out(['error: no-patch']);
      process.exitCode = 2;
      return;
    }
  }
  const lines = splitPatchLines(patchText);

  let fmt = format;
  if (fmt === 'auto') {
    const d = detectFormat(lines);
    if (!d) {
      out(['error: format']);
      process.exitCode = 2;
      return;
    }
    fmt = d;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines);
  } catch (e) {
    if (e instanceof ParseError) {
      out([`error: parse ${e.line}`]);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  if (edits.length === 0) {
    out(['error: parse 1']);
    process.exitCode = 2;
    return;
  }

  const tree = new Tree();
  const failures: { code: string; path: string }[] = [];
  const moves: { old: string; nw: string }[] = [];
  for (const edit of edits) {
    const res = edit.run(tree, strict);
    if (!res.ok) failures.push({ code: res.code, path: res.path });
    else if (res.move) moves.push(res.move);
  }
  if (failures.length > 0) {
    const outLines = failures.map((f) => `error: ${f.code} ${f.path}`);
    outLines.push(`failed: ${failures.length} of ${edits.length} edits`);
    out(outLines);
    process.exitCode = 1;
    return;
  }

  const changeLines = computeChanges(tree, moves);
  if (!check) tree.writeAll();
  out([...changeLines, `ok: ${changeLines.length} ${changeLines.length === 1 ? 'file' : 'files'}`]);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6).
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  o: string[];
  n: NEntry[];
  /** Whether a \ line follows the hunk's last context or + line. */
  lastCtxPlusBs: boolean;
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hasPair: boolean;
  hunks: Hunk[];
}

/** The path after ---/+++: text after the four characters, up to the first tab, spaces removed, a/ or b/ removed. */
function headerPath(line: string): string {
  let p = line.slice(4).split('\t')[0].trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function isDiffGitLine(line: string): boolean {
  return line === 'diff --git' || line.startsWith('diff --git ');
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface BodyEntry {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

/** Parse one hunk body starting at `start` (the line after the @@ header). Returns the hunk and the index after the body. */
function parseHunkBody(lines: string[], start: number): { hunk: Hunk; next: number } {
  const body: BodyEntry[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j];
    // The body ends at a --- line followed by a +++ line (a new section starts there).
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l === '') {
      body.push({ kind: ' ', text: '' });
      j++;
    } else if (l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push({ kind: l[0] as BodyEntry['kind'], text: l.slice(1) });
      j++;
    } else {
      break;
    }
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1].kind === ' ' && body[body.length - 1].text === '') body.pop();

  const o: string[] = [];
  const n: NEntry[] = [];
  let lastCtxPlusBs = false;
  for (let k = 0; k < body.length; k++) {
    const e = body[k];
    const bs = k + 1 < body.length && body[k + 1].kind === '\\';
    if (e.kind === ' ') {
      o.push(e.text);
      n.push({ text: e.text, ctx: true, oIndex: o.length - 1, bs });
    } else if (e.kind === '-') {
      o.push(e.text);
    } else if (e.kind === '+') {
      n.push({ text: e.text, ctx: false, oIndex: -1, bs });
    }
    // A \ line refers to the body line before it; it carries no line of its own.
  }
  // Whether a \ line follows the hunk's last context or + line.
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k].kind === ' ' || body[k].kind === '+') {
      lastCtxPlusBs = k + 1 < body.length && body[k + 1].kind === '\\';
      break;
    }
  }
  return { hunk: { a: 0, o, n, lastCtxPlusBs }, next: j };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let oldByRename = false;
  let newByRename = false;

  const pushCur = (): void => {
    if (cur) sections.push(cur);
    cur = null;
  };
  const newSection = (oldPath: string | null, newPath: string | null, hasPair: boolean): void => {
    pushCur();
    cur = { oldPath, newPath, newFileMode: false, deletedFileMode: false, hasPair, hunks: [] };
    inHeader = true;
    oldByRename = false;
    newByRename = false;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isDiffGitLine(line)) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m) throw new ParseError(i + 1);
      newSection(m[1], m[2], false);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!cur) throw new ParseError(i + 1);
      const m = HUNK_RE.exec(line);
      if (!m) throw new ParseError(i + 1);
      const parsed = parseHunkBody(lines, i + 1);
      parsed.hunk.a = Number(m[1]);
      cur.hunks.push(parsed.hunk);
      inHeader = false;
      i = parsed.next;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const oldP = headerPath(line);
      const newP = headerPath(lines[i + 1]);
      if (cur && inHeader && !cur.hasPair) {
        cur.oldPath = oldP === '/dev/null' ? null : oldP;
        cur.newPath = newP === '/dev/null' ? null : newP;
        cur.hasPair = true;
      } else {
        newSection(oldP === '/dev/null' ? null : oldP, newP === '/dev/null' ? null : newP, true);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur && inHeader) {
      // A --- line not followed by a +++ line, inside a section's header.
      throw new ParseError(i + 2);
    }
    if (cur && inHeader) {
      if (line.startsWith('rename from ')) {
        if (!cur.hasPair && !oldByRename) {
          cur.oldPath = line.slice('rename from '.length).trim();
          oldByRename = true;
        }
      } else if (line.startsWith('rename to ')) {
        if (!cur.hasPair && !newByRename) {
          cur.newPath = line.slice('rename to '.length).trim();
          newByRename = true;
        }
      } else if (line.startsWith('new file mode')) {
        cur.newFileMode = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletedFileMode = true;
      } else if (line.startsWith('+++ ')) {
        // A lone +++ line in a header names the new path (it does not override a pair).
        if (!cur.hasPair) cur.newPath = headerPath(line) === '/dev/null' ? null : headerPath(line);
      }
      // index, old mode, new mode, similarity index, dissimilarity index,
      // Index: lines and any other line are ignored.
      i++;
      continue;
    }
    // Outside a section header: prose, code fences and other lines are ignored.
    i++;
  }
  pushCur();
  return sections.map((sec) => makeUnifiedEdit(sec));
}

function makeUnifiedEdit(sec: UniSection): Edit {
  return {
    run(tree: Tree, strict: boolean): ApplyResult {
      if (sec.oldPath === null && sec.newPath === null) return { ok: true };
      if (sec.oldPath === null || sec.newFileMode) {
        // Creation: the new path does not exist; the file is the + lines of all its hunks.
        const p = sec.newPath as string;
        if (!isSafePath(p)) return fail('unsafe', p);
        if (tree.exists(p)) return fail('exists', p);
        const content: string[] = [];
        let lastPlusBs = false;
        let hasPlus = false;
        for (const h of sec.hunks) {
          for (const e of h.n) {
            if (!e.ctx) {
              content.push(e.text);
              hasPlus = true;
              lastPlusBs = e.bs;
            }
          }
        }
        tree.set(p, { lines: content, brk: '\n', eol: hasPlus ? !lastPlusBs : false });
        return { ok: true };
      }
      if (sec.newPath === null || sec.deletedFileMode) {
        // Deletion: the old path exists; it is deleted, and its hunks are not read.
        const p = sec.oldPath as string;
        if (!isSafePath(p)) return fail('unsafe', p);
        if (!tree.exists(p)) return fail('missing', p);
        tree.del(p);
        return { ok: true };
      }
      const oldP = sec.oldPath as string;
      const newP = sec.newPath as string;
      if (!isSafePath(oldP)) return fail('unsafe', oldP);
      if (oldP !== newP && !isSafePath(newP)) return fail('unsafe', newP);
      const isMove = oldP !== newP;
      if (isMove) {
        if (!tree.exists(oldP)) return fail('missing', oldP);
        if (tree.exists(newP)) return fail('exists', newP);
      } else if (!tree.exists(oldP)) {
        return fail('missing', oldP);
      }
      const st = tree.get(oldP) as FileState;
      let curLines = [...st.lines];
      let eol = st.eol;
      let d = 0;
      for (const h of sec.hunks) {
        if (h.o.length === 0) {
          // Empty O: N is inserted after the first A + d lines (all of them when the file has fewer).
          let idx = h.a + d;
          if (idx < 0) idx = 0;
          if (idx > curLines.length) idx = curLines.length;
          const atEnd = idx === curLines.length;
          const ins = h.n.map((e) => e.text);
          curLines.splice(idx, 0, ...ins);
          if (atEnd) eol = !h.lastCtxPlusBs;
          d += ins.length;
        } else {
          const found = findTier(curLines, h.o, strict);
          if (!found) return fail('no-match', oldP);
          const target = h.a - 1 + d;
          let best = found.positions[0];
          let bestDist = Math.abs(best - target);
          for (const p of found.positions) {
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              best = p;
              bestDist = dist;
            }
          }
          const nLines = buildReplacement(curLines, best, h.o, h.n, found.tier);
          const runsToEnd = best + h.o.length === curLines.length;
          curLines.splice(best, h.o.length, ...nLines);
          if (runsToEnd) eol = !h.lastCtxPlusBs;
          d += h.n.length - h.o.length;
        }
      }
      const newState: FileState = { lines: curLines, brk: st.brk, eol };
      if (isMove) {
        tree.del(oldP);
        tree.set(newP, newState);
        return { ok: true, move: { old: oldP, nw: newP } };
      }
      tree.set(oldP, newState);
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7).
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0; // index just after the previous block's >>>>>>> REPLACE line
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    // The path is the nearest line before SEARCH, after the previous block's
    // REPLACE line, that is not blank and does not start with three backticks.
    let pathLine: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j];
      if (l.trim() === '') continue;
      if (l.trimStart().startsWith('```')) continue;
      pathLine = l.trim();
      break;
    }
    let p: string;
    if (pathLine !== null) p = pathLine;
    else if (prevPath !== null) p = prevPath;
    else throw new ParseError(searchLine);
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new ParseError(searchLine);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseError(searchLine);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSearchReplaceEdit(p, oldLines, newLines));
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function makeSearchReplaceEdit(p: string, oldLines: string[], newLines: string[]): Edit {
  return {
    run(tree: Tree, strict: boolean): ApplyResult {
      if (!isSafePath(p)) return fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.exists(p)) return fail('exists', p);
        tree.set(p, { lines: [...newLines], brk: '\n', eol: true });
        return { ok: true };
      }
      const st = tree.get(p);
      if (!st) return fail('missing', p);
      const found = findTier(st.lines, oldLines, strict);
      if (!found) return fail('no-match', p);
      if (found.positions.length > 1) return fail('ambiguous', p);
      const pos = found.positions[0];
      const nEntries: NEntry[] = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1, bs: false }));
      const nLines = buildReplacement(st.lines, pos, oldLines, nEntries, found.tier);
      const next = [...st.lines.slice(0, pos), ...nLines, ...st.lines.slice(pos + oldLines.length)];
      tree.set(p, { lines: next, brk: st.brk, eol: st.eol });
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// V4A patches (section 8).
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: { kind: ' ' | '-' | '+'; text: string }[];
  eof: boolean;
}

interface V4aSectionStart {
  kind: 'add' | 'delete' | 'update';
  path: string;
}

function matchSectionStart(line: string): V4aSectionStart | null {
  if (line.startsWith('*** Add File:')) return { kind: 'add', path: line.slice('*** Add File:'.length).trim() };
  if (line.startsWith('*** Delete File:')) return { kind: 'delete', path: line.slice('*** Delete File:'.length).trim() };
  if (line.startsWith('*** Update File:')) return { kind: 'update', path: line.slice('*** Update File:'.length).trim() };
  return null;
}

function parseV4a(lines: string[]): Edit[] {
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) throw new ParseError(1);
  if (lines[firstIdx].trim() !== '*** Begin Patch') throw new ParseError(firstIdx + 1);
  let lastIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlankLine(lines[i])) {
      lastIdx = i;
      break;
    }
  }
  if (lines[lastIdx].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const edits: Edit[] = [];
  const end = lastIdx; // exclusive: the End Patch line itself
  let i = firstIdx + 1;
  while (i < end) {
    const l = lines[i];
    if (isBlankLine(l)) {
      i++;
      continue;
    }
    const secStart = matchSectionStart(l);
    if (!secStart) throw new ParseError(i + 1);
    if (secStart.kind === 'add') {
      const p = secStart.path;
      i++;
      const raw: string[] = [];
      while (i < end) {
        const m = lines[i];
        if (matchSectionStart(m)) break;
        if (m === '') {
          raw.push('');
          i++;
          continue;
        }
        if (m.startsWith('+')) {
          raw.push(m.slice(1));
          i++;
          continue;
        }
        throw new ParseError(i + 1);
      }
      // Blank lines at the end of a section are not part of it.
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      edits.push(makeV4aAddEdit(p, raw));
    } else if (secStart.kind === 'delete') {
      const p = secStart.path;
      i++;
      while (i < end) {
        const m = lines[i];
        if (isBlankLine(m)) {
          i++;
          continue;
        }
        if (matchSectionStart(m)) break;
        throw new ParseError(i + 1);
      }
      edits.push(makeV4aDeleteEdit(p));
    } else {
      const p = secStart.path;
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i].startsWith('*** Move to:')) {
        moveTo = lines[i].slice('*** Move to:'.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let curChunk: V4aChunk | null = null;
      let needAnchor = false;
      while (i < end) {
        const m = lines[i];
        if (isBlankLine(m)) {
          // Inside an open chunk this is an empty context line; elsewhere it is ignored.
          if (curChunk) curChunk.body.push({ kind: ' ', text: '' });
          i++;
          continue;
        }
        if (matchSectionStart(m)) break;
        if (m.startsWith('@@')) {
          if (curChunk) chunks.push(curChunk);
          curChunk = { anchor: m.slice(2).trim(), body: [], eof: false };
          needAnchor = false;
          i++;
          continue;
        }
        if (m.trimEnd() === '*** End of File') {
          if (!curChunk) throw new ParseError(i + 1);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          needAnchor = true;
          i++;
          continue;
        }
        if (m.startsWith(' ') || m.startsWith('-') || m.startsWith('+')) {
          if (needAnchor) throw new ParseError(i + 1);
          if (!curChunk) curChunk = { anchor: null, body: [], eof: false };
          curChunk.body.push({ kind: m[0] as ' ' | '-' | '+', text: m.slice(1) });
          i++;
          continue;
        }
        throw new ParseError(i + 1);
      }
      if (curChunk) chunks.push(curChunk);
      if (chunks.length > 0) {
        // Blank lines at the end of a section are not part of it.
        const last = chunks[chunks.length - 1];
        while (
          last.body.length > 0 &&
          last.body[last.body.length - 1].kind === ' ' &&
          isOnlyWS(last.body[last.body.length - 1].text)
        ) {
          last.body.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseError(updateLine);
      edits.push(makeV4aUpdateEdit(p, moveTo, chunks));
    }
  }
  return edits;
}

function makeV4aAddEdit(p: string, content: string[]): Edit {
  return {
    run(tree: Tree): ApplyResult {
      if (!isSafePath(p)) return fail('unsafe', p);
      if (tree.exists(p)) return fail('exists', p);
      tree.set(p, { lines: [...content], brk: '\n', eol: true });
      return { ok: true };
    },
  };
}

function makeV4aDeleteEdit(p: string): Edit {
  return {
    run(tree: Tree): ApplyResult {
      if (!isSafePath(p)) return fail('unsafe', p);
      if (!tree.exists(p)) return fail('missing', p);
      tree.del(p);
      return { ok: true };
    },
  };
}

function makeV4aUpdateEdit(p: string, moveTo: string | null, chunks: V4aChunk[]): Edit {
  return {
    run(tree: Tree, strict: boolean): ApplyResult {
      if (!isSafePath(p)) return fail('unsafe', p);
      if (moveTo !== null && !isSafePath(moveTo)) return fail('unsafe', moveTo);
      const st = tree.get(p);
      if (!st) return fail('missing', p);
      if (moveTo !== null && tree.exists(moveTo)) return fail('exists', moveTo);
      let curLines = [...st.lines];
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null && ch.anchor !== '') {
          // Find the first line at or after the cursor equal to the anchor, at the first tier with one.
          let anchorIdx = -1;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            for (let k = cursor; k < curLines.length; k++) {
              if (lineEqAtTier(curLines[k], ch.anchor, t)) {
                anchorIdx = k;
                break;
              }
            }
            if (anchorIdx !== -1) break;
          }
          if (anchorIdx === -1) return fail('no-match', p);
          cursor = anchorIdx + 1;
        }
        const o: string[] = [];
        const n: NEntry[] = [];
        for (const b of ch.body) {
          if (b.kind === ' ') {
            o.push(b.text);
            n.push({ text: b.text, ctx: true, oIndex: o.length - 1, bs: false });
          } else if (b.kind === '-') {
            o.push(b.text);
          } else {
            n.push({ text: b.text, ctx: false, oIndex: -1, bs: false });
          }
        }
        if (o.length === 0) {
          const ins = n.map((e) => e.text);
          const idx = ch.eof ? curLines.length : cursor;
          curLines.splice(idx, 0, ...ins);
          cursor = idx + ins.length;
        } else {
          // First occurrence of O at or after the cursor, at the first tier with one.
          let hit: TierHit | null = null;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const t of tiers) {
            const positions = findOccurrences(curLines, o, t).filter((pos) => pos >= cursor);
            if (positions.length > 0) {
              hit = { tier: t, positions };
              break;
            }
          }
          if (!hit) return fail('no-match', p);
          let pos = -1;
          for (const cand of hit.positions) {
            if (ch.eof && cand + o.length !== curLines.length) continue;
            pos = cand;
            break;
          }
          if (pos === -1) return fail('no-match', p);
          const nLines = buildReplacement(curLines, pos, o, n, hit.tier);
          curLines.splice(pos, o.length, ...nLines);
          cursor = pos + nLines.length;
        }
      }
      const newState: FileState = { lines: curLines, brk: st.brk, eol: st.eol };
      if (moveTo !== null) {
        tree.del(p);
        tree.set(moveTo, newState);
        return { ok: true, move: { old: p, nw: moveTo } };
      }
      tree.set(p, newState);
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// JSON edits (section 9).
// ---------------------------------------------------------------------------

interface JsonEditObj {
  path: string;
  command: 'create' | 'str_replace' | 'insert';
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
}

function validateJsonEdit(obj: unknown): JsonEditObj | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { path: o.path, command: 'create', file_text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return { path: o.path, command: 'str_replace', old_str: o.old_str, new_str: o.new_str ?? '' };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { path: o.path, command: 'insert', insert_line: o.insert_line, new_str: o.new_str };
  }
  return null;
}

function parseJson(lines: string[]): Edit[] {
  // The first non-blank line decides the form: [ starts an array, { starts JSON Lines.
  let firstIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlankLine(lines[i])) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) throw new ParseError(1);
  const firstChar = lines[firstIdx].trimStart()[0];
  if (firstChar === '[') {
    // Array form: any fault is a parse error at the line where the array starts.
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines.join('\n'));
    } catch {
      throw new ParseError(firstIdx + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseError(firstIdx + 1);
    const edits: Edit[] = [];
    for (const item of parsed) {
      const e = validateJsonEdit(item);
      if (!e) throw new ParseError(firstIdx + 1);
      edits.push(makeJsonEdit(e));
    }
    return edits;
  }
  if (firstChar === '{' || (firstChar !== '[' && firstChar !== '{')) {
    // JSON Lines form: one edit object a line, blank lines ignored. A line
    // that does not hold one valid edit object is a parse error at that line.
    const edits: Edit[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (isBlankLine(lines[i])) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        throw new ParseError(i + 1);
      }
      const e = validateJsonEdit(parsed);
      if (!e) throw new ParseError(i + 1);
      edits.push(makeJsonEdit(e));
    }
    return edits;
  }
  // Unreachable: firstChar is '[' here, handled above.
  throw new ParseError(1);
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = text.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + 1;
  }
}

function makeJsonEdit(e: JsonEditObj): Edit {
  return {
    run(tree: Tree): ApplyResult {
      if (!isSafePath(e.path)) return fail('unsafe', e.path);
      if (e.command === 'create') {
        if (tree.exists(e.path)) return fail('exists', e.path);
        const st = parseFile(e.file_text as string);
        tree.set(e.path, st);
        return { ok: true };
      }
      if (e.command === 'str_replace') {
        const st = tree.get(e.path);
        if (!st) return fail('missing', e.path);
        const text = serialize(st);
        if (st.brk === '\r\n') {
          const normText = text.split('\r\n').join('\n');
          const normOld = (e.old_str as string).split('\r\n').join('\n');
          const normNew = (e.new_str as string).split('\r\n').join('\n');
          const count = countOccurrences(normText, normOld);
          if (count === 0) return fail('no-match', e.path);
          if (count > 1) return fail('ambiguous', e.path);
          const idx = normText.indexOf(normOld);
          const replaced = normText.slice(0, idx) + normNew + normText.slice(idx + normOld.length);
          tree.set(e.path, parseFile(replaced.split('\n').join('\r\n')));
          return { ok: true };
        }
        const count = countOccurrences(text, e.old_str as string);
        if (count === 0) return fail('no-match', e.path);
        if (count > 1) return fail('ambiguous', e.path);
        const idx = text.indexOf(e.old_str as string);
        const replaced = text.slice(0, idx) + (e.new_str as string) + text.slice(idx + (e.old_str as string).length);
        tree.set(e.path, parseFile(replaced));
        return { ok: true };
      }
      // insert
      const st = tree.get(e.path);
      if (!st) return fail('missing', e.path);
      const line = e.insert_line as number;
      if (line < 0 || line > st.lines.length) return fail('no-match', e.path);
      const newStr = e.new_str as string;
      const newLines = newStr === '' ? [] : splitPatchLines(newStr);
      const next = [...st.lines.slice(0, line), ...newLines, ...st.lines.slice(line)];
      tree.set(e.path, { lines: next, brk: st.brk, eol: st.eol });
      return { ok: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

if (process.env.MAKEFUN_ENV_URL) {
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  main();
}
