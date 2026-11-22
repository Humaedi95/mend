// mend: one patch tool for every AI edit format.
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// Reads a unified diff, SEARCH/REPLACE blocks, a V4A patch or JSON
// text-editor tool calls and applies them to the tree in the working
// directory, all files or none. Node 22, standard library only.
// The whole behaviour is SPEC.md; this file is written from it.

import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------- output

function out(text: string): void {
  writeSync(1, text);
}

// ------------------------------------------------------------- CLI parsing

type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json' | 'auto';

interface CliArgs {
  format: FormatName;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): CliArgs | null {
  let format: FormatName = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let patch: string | null = null;
  let positionals = 0;
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positionals += 1;
      if (positionals > 1) return null;
      patch = a;
    }
  }
  return { format, check, strict, patch };
}

function readPatchText(patch: string | null): string | null {
  if (patch === null || patch === '-') {
    return readFileSync(0, 'utf8');
  }
  try {
    return readFileSync(patch, 'utf8');
  } catch {
    return null;
  }
}

// A patch's lines: split at \n, one trailing \r removed from each,
// without the empty piece after a final \n.
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function stripTrailingWs(line: string): string {
  return line.replace(/[ \t]+$/, '');
}

// ---------------------------------------------------------- format detect

function detectFormat(lines: string[]): FormatName | null {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  const firstText = lines[first].trim();
  if (firstText === '*** Begin Patch') return 'v4a';
  const firstChar = firstText[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (const l of lines) {
    if (stripTrailingWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ------------------------------------------------------------------ files

// One file of the tree, as lines plus its own line break and whether it
// ends with one. Parsing a text into this shape and writing it back is
// the identity, so a file a JSON create writes byte for byte keeps its
// bytes exactly.
interface FileState {
  exists: boolean;
  lines: string[];
  brk: '\n' | '\r\n';
  eol: boolean;
  origExists: boolean;
  origText: string | null;
}

function parseFileText(text: string): { lines: string[]; brk: '\n' | '\r\n'; eol: boolean } {
  if (text === '') return { lines: [], brk: '\n', eol: false };
  const firstLf = text.indexOf('\n');
  const brk: '\n' | '\r\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let eol = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    eol = true;
  }
  return { lines: parts, brk, eol };
}

function serializeFile(lines: string[], brk: '\n' | '\r\n', eol: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(brk) + (eol ? brk : '');
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

class Tree {
  private map = new Map<string, FileState>();

  get(path: string): FileState {
    let f = this.map.get(path);
    if (f === undefined) {
      f = this.load(path);
      this.map.set(path, f);
    }
    return f;
  }

  exists(path: string): boolean {
    return this.get(path).exists;
  }

  entries(): Array<[string, FileState]> {
    return [...this.map.entries()];
  }

  private load(path: string): FileState {
    try {
      const text = readFileSync(join(process.cwd(), ...path.split('/')), 'utf8');
      const parsed = parseFileText(text);
      return { exists: true, lines: parsed.lines, brk: parsed.brk, eol: parsed.eol, origExists: true, origText: text };
    } catch {
      return { exists: false, lines: [], brk: '\n', eol: false, origExists: false, origText: null };
    }
  }

  writeChanged(): void {
    const changed: Array<[string, FileState]> = [];
    for (const [p, f] of this.map) {
      const now = f.exists ? serializeFile(f.lines, f.brk, f.eol) : null;
      if (f.origExists !== f.exists || (f.origExists && now !== f.origText)) changed.push([p, f]);
    }
    for (const [p, f] of changed) {
      if (!f.exists) rmSync(join(process.cwd(), ...p.split('/')), { force: true });
    }
    for (const [p, f] of changed) {
      if (!f.exists) continue;
      const target = join(process.cwd(), ...p.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, serializeFile(f.lines, f.brk, f.eol), 'utf8');
    }
  }
}

// ------------------------------------------------------------ line matching

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function lineKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(lines: string[], oLines: string[], tier: number): number[] {
  const out: number[] = [];
  const k = oLines.length;
  if (k === 0 || k > lines.length) return out;
  const oKeys = oLines.map((l) => lineKey(l, tier));
  for (let i = 0; i + k <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (lineKey(lines[i + j], tier) !== oKeys[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

// First tier (0, 1, 2, or only 0 when strict) at which O occurs at least
// once, at or after `from`.
function findTier(lines: string[], oLines: string[], from: number, strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(lines, oLines, t).filter((p) => p >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// One body line of a hunk or chunk: context, old, new. A `\` line is a
// marker and never reaches O or N.
interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

interface SplitOps {
  oLines: string[];
  // N's lines in order; a context line is taken from the file at the
  // matching O position, an added line from the patch.
  nItems: Array<{ fromFile: boolean; oIndex: number; text: string }>;
}

function splitOps(ops: Op[]): SplitOps {
  const oLines: string[] = [];
  const nItems: SplitOps['nItems'] = [];
  for (const op of ops) {
    if (op.kind === 'ctx') {
      oLines.push(op.text);
      nItems.push({ fromFile: true, oIndex: oLines.length - 1, text: op.text });
    } else if (op.kind === 'del') {
      oLines.push(op.text);
    } else {
      nItems.push({ fromFile: false, oIndex: -1, text: op.text });
    }
  }
  return { oLines, nItems };
}

// Build N's lines at the occurrence starting at `at`: context lines are
// the file's own matched lines; at tier 2 the other lines are re-indented
// from O's first line's leading whitespace to the file's.
function buildNewLines(nItems: SplitOps['nItems'], fileLines: string[], at: number, tier: number, oLines: string[]): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && oLines.length > 0) {
    p = leadingWs(oLines[0]);
    f = leadingWs(fileLines[at]);
  }
  for (const it of nItems) {
    if (it.fromFile) {
      out.push(fileLines[at + it.oIndex]);
      continue;
    }
    let t = it.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

// ------------------------------------------------------------------ edits

interface Fail {
  code: 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe';
  path: string;
}

type Edit =
  | { kind: 'unified'; section: USection }
  | { kind: 'search'; block: SBlock }
  | { kind: 'v4a'; section: VSection }
  | { kind: 'json'; op: JsonOp };

// ------------------------------------------------------------- unified

interface Hunk {
  a: number;
  ops: Op[];
  // A `\` line follows the hunk's last context or `+` line.
  noFinalBreak: boolean;
  // A `\` line follows the hunk's last `+` line.
  lastAddNoBreak: boolean;
}

interface USection {
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function dashPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab !== -1) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/')) rest = rest.slice(2);
  else if (rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function parseDiffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const idx = rest.indexOf(' b/', 2);
  if (idx === -1) return null;
  const x = rest.slice(2, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

function parseHunkHeader(line: string): { a: number } | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) return null;
  return { a: Number(m[1]) };
}

function newUSection(): USection {
  return {
    pairOld: null,
    pairNew: null,
    renOld: null,
    renNew: null,
    diffOld: null,
    diffNew: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  };
}

// A hunk body is the lines after the header starting with ` `, `-`, `+`
// or `\`, or empty. Its items are collected raw (including `\` markers)
// and finished here: trailing empty context lines are not part of it,
// and the `\` marks are read off the last context/`+` line and the last
// `+` line.
function finishHunk(raw: Array<{ type: 'ctx' | 'del' | 'add' | 'bs'; text: string }>, a: number): Hunk {
  while (raw.length > 0) {
    const last = raw[raw.length - 1];
    if (last.type === 'ctx' && last.text === '') raw.pop();
    else break;
  }
  let lastCtxAdd = -1;
  let lastAdd = -1;
  for (let k = 0; k < raw.length; k += 1) {
    if (raw[k].type === 'ctx' || raw[k].type === 'add') lastCtxAdd = k;
    if (raw[k].type === 'add') lastAdd = k;
  }
  const noFinalBreak = lastCtxAdd >= 0 && lastCtxAdd + 1 < raw.length && raw[lastCtxAdd + 1].type === 'bs';
  const lastAddNoBreak = lastAdd >= 0 && lastAdd + 1 < raw.length && raw[lastAdd + 1].type === 'bs';
  const ops: Op[] = [];
  for (const item of raw) {
    if (item.type === 'bs') continue;
    ops.push({ kind: item.type, text: item.text });
  }
  return { a, ops, noFinalBreak, lastAddNoBreak };
}

function parseUnified(lines: string[]): { edits: Edit[] } | { error: number } {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let curRaw: Array<{ type: 'ctx' | 'del' | 'add' | 'bs'; text: string }> | null = null;
  let curA = 0;
  const inHeader = (): boolean => cur !== null && cur.hunks.length === 0 && curRaw === null;
  const endBody = (): void => {
    if (curRaw === null || cur === null) return;
    cur.hunks.push(finishHunk(curRaw, curA));
    curRaw = null;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (curRaw !== null) {
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
          endBody();
          continue;
        }
        if (line === '') curRaw.push({ type: 'ctx', text: '' });
        else if (line[0] === ' ') curRaw.push({ type: 'ctx', text: line.slice(1) });
        else if (line[0] === '-') curRaw.push({ type: 'del', text: line.slice(1) });
        else if (line[0] === '+') curRaw.push({ type: 'add', text: line.slice(1) });
        else curRaw.push({ type: 'bs', text: line.slice(1) });
        i += 1;
        continue;
      }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = parseDiffGit(line);
      if (m === null) return { error: i + 1 };
      cur = newUSection();
      cur.diffOld = m[0];
      cur.diffNew = m[1];
      sections.push(cur);
      i += 1;
    } else if (line.startsWith('--- ')) {
      if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        const oldP = dashPath(line);
        const newP = dashPath(lines[i + 1]);
        if (inHeader() && cur !== null) {
          cur.pairOld = oldP;
          cur.pairNew = newP;
        } else {
          cur = newUSection();
          cur.pairOld = oldP;
          cur.pairNew = newP;
          sections.push(cur);
        }
        i += 2;
      } else if (inHeader()) {
        return { error: i + 2 };
      } else {
        i += 1;
      }
    } else if (line.startsWith('+++ ')) {
      if (inHeader() && cur !== null) cur.pairNew = dashPath(line);
      i += 1;
    } else if (line.startsWith('@@')) {
      if (cur === null) return { error: i + 1 };
      const h = parseHunkHeader(line);
      if (h === null) return { error: i + 1 };
      curA = h.a;
      curRaw = [];
      i += 1;
    } else if (line.startsWith('rename from ')) {
      if (inHeader() && cur !== null) cur.renOld = line.slice('rename from '.length).trim();
      i += 1;
    } else if (line.startsWith('rename to ')) {
      if (inHeader() && cur !== null) cur.renNew = line.slice('rename to '.length).trim();
      i += 1;
    } else if (line.startsWith('new file mode')) {
      if (inHeader() && cur !== null) cur.isCreate = true;
      i += 1;
    } else if (line.startsWith('deleted file mode')) {
      if (inHeader() && cur !== null) cur.isDelete = true;
      i += 1;
    } else {
      i += 1;
    }
  }
  endBody();
  if (sections.length === 0) return { error: 1 };
  return { edits: sections.map((section) => ({ kind: 'unified' as const, section })) };
}

function applyUnified(sec: USection, tree: Tree, strict: boolean, moves: Array<{ old: string; next: string }>): Fail | null {
  const oldPath = sec.pairOld ?? sec.renOld ?? sec.diffOld ?? '';
  const newPath = sec.pairNew ?? sec.renNew ?? sec.diffNew ?? '';
  // `/dev/null` names no file, so it is never an unsafe path.
  if (oldPath !== '/dev/null' && !isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
  if (newPath !== '/dev/null' && !isSafePath(newPath)) return { code: 'unsafe', path: newPath };
  const isCreate = sec.isCreate || oldPath === '/dev/null';
  const isDelete = !isCreate && (sec.isDelete || newPath === '/dev/null');
  if (isCreate) {
    if (tree.exists(newPath)) return { code: 'exists', path: newPath };
    const made: string[] = [];
    let eol = false;
    for (const h of sec.hunks) {
      const { nItems } = splitOps(h.ops);
      let sawAdd = false;
      for (const it of nItems) {
        if (it.fromFile) continue;
        made.push(it.text);
        sawAdd = true;
      }
      if (sawAdd) eol = !h.lastAddNoBreak;
    }
    const f = tree.get(newPath);
    f.exists = true;
    f.lines = made;
    f.brk = '\n';
    f.eol = made.length > 0 && eol;
    return null;
  }
  if (isDelete) {
    if (!tree.exists(oldPath)) return { code: 'missing', path: oldPath };
    tree.get(oldPath).exists = false;
    return null;
  }
  const isMove = oldPath !== newPath;
  const file = tree.get(oldPath);
  if (!file.exists) return { code: 'missing', path: oldPath };
  if (isMove && tree.exists(newPath)) return { code: 'exists', path: newPath };
  let lines = [...file.lines];
  let eol = file.eol;
  let d = 0;
  for (const h of sec.hunks) {
    const { oLines, nItems } = splitOps(h.ops);
    if (oLines.length === 0) {
      const at = Math.min(h.a + d, lines.length);
      const atEnd = h.a + d >= lines.length;
      const ins: string[] = [];
      for (const it of nItems) if (!it.fromFile) ins.push(it.text);
      lines.splice(at, 0, ...ins);
      if (atEnd) eol = !h.noFinalBreak;
      d += nItems.length;
      continue;
    }
    const found = findTier(lines, oLines, 0, strict);
    if (found === null) return { code: 'no-match', path: oldPath };
    const target = h.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const at = best;
    const replacement = buildNewLines(nItems, lines, at, found.tier, oLines);
    const runsToEnd = at + oLines.length === lines.length;
    lines.splice(at, oLines.length, ...replacement);
    if (runsToEnd) eol = !h.noFinalBreak;
    d += nItems.length - oLines.length;
  }
  if (isMove) {
    tree.get(oldPath).exists = false;
    const nf = tree.get(newPath);
    nf.exists = true;
    nf.lines = lines;
    nf.brk = file.brk;
    nf.eol = eol;
    moves.push({ old: oldPath, next: newPath });
  } else {
    file.lines = lines;
    file.eol = eol;
  }
  return null;
}

// -------------------------------------------------------- SEARCH/REPLACE

interface SBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): { edits: Edit[] } | { error: number } {
  const blocks: SBlock[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (stripTrailingWs(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let sep = -1;
    let end = -1;
    let j = searchLine + 1;
    while (j < lines.length) {
      const t = stripTrailingWs(lines[j]);
      if (t === '=======') {
        sep = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (sep === -1) return { error: searchLine + 1 };
    j = sep + 1;
    while (j < lines.length) {
      const t = stripTrailingWs(lines[j]);
      if (t === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      j += 1;
    }
    if (end === -1) return { error: searchLine + 1 };
    let path: string | null = null;
    for (let k = searchLine - 1; k > prevReplace; k -= 1) {
      if (isBlank(lines[k])) continue;
      const t = lines[k].trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) return { error: searchLine + 1 };
      path = prevPath;
    }
    blocks.push({
      path,
      oldLines: lines.slice(searchLine + 1, sep),
      newLines: lines.slice(sep + 1, end),
    });
    prevPath = path;
    prevReplace = end;
    i = end + 1;
  }
  if (blocks.length === 0) return { error: 1 };
  return { edits: blocks.map((block) => ({ kind: 'search' as const, block })) };
}

function applySearch(b: SBlock, tree: Tree, strict: boolean): Fail | null {
  if (!isSafePath(b.path)) return { code: 'unsafe', path: b.path };
  if (b.oldLines.length === 0) {
    if (tree.exists(b.path)) return { code: 'exists', path: b.path };
    const f = tree.get(b.path);
    f.exists = true;
    f.lines = [...b.newLines];
    f.brk = '\n';
    f.eol = b.newLines.length > 0;
    return null;
  }
  const file = tree.get(b.path);
  if (!file.exists) return { code: 'missing', path: b.path };
  const found = findTier(file.lines, b.oldLines, 0, strict);
  if (found === null) return { code: 'no-match', path: b.path };
  if (found.occ.length > 1) return { code: 'ambiguous', path: b.path };
  const at = found.occ[0];
  const nItems = b.newLines.map((text) => ({ fromFile: false, oIndex: -1, text }));
  const replacement = buildNewLines(nItems, file.lines, at, found.tier, b.oldLines);
  file.lines.splice(at, b.oldLines.length, ...replacement);
  return null;
}

// --------------------------------------------------------------------- V4A

interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  pathLine: number;
  lines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function parseV4a(lines: string[]): { edits: Edit[] } | { error: number } {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return { error: 1 };
  if (lines[first].trim() !== '*** Begin Patch') return { error: first + 1 };
  if (lines[last].trim() !== '*** End Patch') return { error: lines.length + 1 };
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let curLines: string[] = [];
  let curStart = 0;
  const sectionStart = (line: string): 'add' | 'delete' | 'update' | null => {
    if (line.startsWith('*** Add File: ')) return 'add';
    if (line.startsWith('*** Delete File: ')) return 'delete';
    if (line.startsWith('*** Update File: ')) return 'update';
    return null;
  };
  const finishSection = (): { error: number } | null => {
    if (cur === null) return null;
    while (curLines.length > 0 && isBlank(curLines[curLines.length - 1])) curLines.pop();
    const parsed = finishVSection(cur, curLines);
    if ('error' in parsed) return parsed;
    sections.push(parsed.section);
    cur = null;
    curLines = [];
    return null;
  };
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i];
    const kind = sectionStart(line);
    if (kind !== null) {
      const err = finishSection();
      if (err !== null) return err;
      const path = line.slice(line.indexOf(': ') + 2).trim();
      cur = { kind, path, pathLine: i + 1, lines: [], moveTo: null, chunks: [] };
      curStart = i + 1;
      continue;
    }
    if (cur === null) {
      if (isBlank(line)) continue;
      return { error: i + 1 };
    }
    curLines.push(line);
  }
  const err = finishSection();
  if (err !== null) return err;
  if (sections.length === 0) return { error: 1 };
  return { edits: sections.map((section) => ({ kind: 'v4a' as const, section })) };
}

function finishVSection(sec: VSection, rawLines: string[]): { section: VSection } | { error: number } {
  if (sec.kind === 'add') {
    const made: string[] = [];
    for (let k = 0; k < rawLines.length; k += 1) {
      const l = rawLines[k];
      if (l.startsWith('+')) made.push(l.slice(1));
      else if (l === '') made.push('');
      else return { error: sec.pathLine + 1 + k };
    }
    sec.lines = made;
    return { section: sec };
  }
  if (sec.kind === 'delete') {
    for (let k = 0; k < rawLines.length; k += 1) {
      if (!isBlank(rawLines[k])) return { error: sec.pathLine + 1 + k };
    }
    return { section: sec };
  }
  // update
  let idx = 0;
  if (idx < rawLines.length && rawLines[idx].startsWith('*** Move to: ')) {
    sec.moveTo = rawLines[idx].slice('*** Move to: '.length).trim();
    idx += 1;
  }
  let chunk: VChunk | null = null;
  let started = false;
  const closeChunk = (): void => {
    if (chunk !== null) {
      sec.chunks.push(chunk);
      chunk = null;
    }
  };
  for (; idx < rawLines.length; idx += 1) {
    const l = rawLines[idx];
    const lineNo = sec.pathLine + 1 + idx;
    if (l.startsWith('@@')) {
      closeChunk();
      chunk = { anchor: l.slice(2).trim(), eof: false, ops: [] };
      started = true;
    } else if (l === '*** End of File') {
      if (chunk === null) return { error: lineNo };
      chunk.eof = true;
      closeChunk();
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (chunk === null) {
        if (started) return { error: lineNo };
        chunk = { anchor: null, eof: false, ops: [] };
        started = true;
      }
      if (l === '') chunk.ops.push({ kind: 'ctx', text: '' });
      else if (l[0] === ' ') chunk.ops.push({ kind: 'ctx', text: l.slice(1) });
      else if (l[0] === '-') chunk.ops.push({ kind: 'del', text: l.slice(1) });
      else chunk.ops.push({ kind: 'add', text: l.slice(1) });
    } else {
      return { error: lineNo };
    }
  }
  closeChunk();
  if (sec.chunks.length === 0 && sec.moveTo === null) return { error: sec.pathLine };
  return { section: sec };
}

function applyV4a(sec: VSection, tree: Tree, strict: boolean, moves: Array<{ old: string; next: string }>): Fail | null {
  if (sec.kind === 'add') {
    if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
    if (tree.exists(sec.path)) return { code: 'exists', path: sec.path };
    const f = tree.get(sec.path);
    f.exists = true;
    f.lines = [...sec.lines];
    f.brk = '\n';
    f.eol = sec.lines.length > 0;
    return null;
  }
  if (sec.kind === 'delete') {
    if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
    if (!tree.exists(sec.path)) return { code: 'missing', path: sec.path };
    tree.get(sec.path).exists = false;
    return null;
  }
  if (!isSafePath(sec.path)) return { code: 'unsafe', path: sec.path };
  if (sec.moveTo !== null && !isSafePath(sec.moveTo)) return { code: 'unsafe', path: sec.moveTo };
  const file = tree.get(sec.path);
  if (!file.exists) return { code: 'missing', path: sec.path };
  if (sec.moveTo !== null && tree.exists(sec.moveTo)) return { code: 'exists', path: sec.moveTo };
  let lines = [...file.lines];
  let cursor = 0;
  for (const ch of sec.chunks) {
    if (ch.anchor !== null && ch.anchor !== '') {
      const found = findTier(lines, [ch.anchor], cursor, strict);
      if (found === null) return { code: 'no-match', path: sec.path };
      cursor = found.occ[0] + 1;
    }
    const { oLines, nItems } = splitOps(ch.ops);
    if (oLines.length === 0) {
      const ins: string[] = [];
      for (const it of nItems) if (!it.fromFile) ins.push(it.text);
      const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
      lines.splice(at, 0, ...ins);
      cursor = at + ins.length;
      continue;
    }
    const found = findTier(lines, oLines, cursor, strict);
    if (found === null) return { code: 'no-match', path: sec.path };
    let at = -1;
    for (const pos of found.occ) {
      if (ch.eof && pos + oLines.length !== lines.length) continue;
      at = pos;
      break;
    }
    if (at === -1) return { code: 'no-match', path: sec.path };
    const replacement = buildNewLines(nItems, lines, at, found.tier, oLines);
    lines.splice(at, oLines.length, ...replacement);
    cursor = at + replacement.length;
  }
  if (sec.moveTo !== null) {
    tree.get(sec.path).exists = false;
    const nf = tree.get(sec.moveTo);
    nf.exists = true;
    nf.lines = lines;
    nf.brk = file.brk;
    nf.eol = file.eol;
    moves.push({ old: sec.path, next: sec.moveTo });
  } else {
    file.lines = lines;
  }
  return null;
}

// -------------------------------------------------------------------- JSON

type JsonOp =
  | { kind: 'create'; path: string; fileText: string }
  | { kind: 'str-replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'insert'; path: string; insertLine: number; newStr: string };

function parseJsonObject(v: unknown): JsonOp | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o['path'] !== 'string') return null;
  if (typeof o['command'] !== 'string') return null;
  const path = o['path'] as string;
  if (o['command'] === 'create') {
    if (typeof o['file_text'] !== 'string') return null;
    return { kind: 'create', path, fileText: o['file_text'] as string };
  }
  if (o['command'] === 'str_replace') {
    if (typeof o['old_str'] !== 'string' || (o['old_str'] as string) === '') return null;
    if (o['new_str'] === undefined) o['new_str'] = '';
    if (typeof o['new_str'] !== 'string') return null;
    return { kind: 'str-replace', path, oldStr: o['old_str'] as string, newStr: o['new_str'] as string };
  }
  if (o['command'] === 'insert') {
    if (typeof o['insert_line'] !== 'number' || !Number.isInteger(o['insert_line'])) return null;
    if (typeof o['new_str'] !== 'string') return null;
    return { kind: 'insert', path, insertLine: o['insert_line'] as number, newStr: o['new_str'] as string };
  }
  return null;
}

function parseJson(lines: string[]): { edits: Edit[] } | { error: number } {
  let first = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) return { error: 1 };
  const ops: JsonOp[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    const startLine = first + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines.join('\n'));
    } catch {
      return { error: startLine };
    }
    if (!Array.isArray(parsed)) return { error: startLine };
    if (parsed.length === 0) return { error: 1 };
    for (const el of parsed) {
      const op = parseJsonObject(el);
      if (op === null) return { error: startLine };
      ops.push(op);
    }
  } else {
    for (let i = 0; i < lines.length; i += 1) {
      if (isBlank(lines[i])) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        return { error: i + 1 };
      }
      const op = parseJsonObject(parsed);
      if (op === null) return { error: i + 1 };
      ops.push(op);
    }
    if (ops.length === 0) return { error: 1 };
  }
  return { edits: ops.map((op) => ({ kind: 'json' as const, op })) };
}

function countOccurrences(text: string, sub: string): number {
  let n = 0;
  let i = 0;
  for (;;) {
    const j = text.indexOf(sub, i);
    if (j === -1) return n;
    n += 1;
    i = j + 1;
  }
}

function splitNewStr(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function applyJson(op: JsonOp, tree: Tree): Fail | null {
  if (!isSafePath(op.path)) return { code: 'unsafe', path: op.path };
  if (op.kind === 'create') {
    if (tree.exists(op.path)) return { code: 'exists', path: op.path };
    const f = tree.get(op.path);
    const parsed = parseFileText(op.fileText);
    f.exists = true;
    f.lines = parsed.lines;
    f.brk = parsed.brk;
    f.eol = parsed.eol;
    return null;
  }
  const file = tree.get(op.path);
  if (!file.exists) return { code: 'missing', path: op.path };
  if (op.kind === 'str-replace') {
    let text = serializeFile(file.lines, file.brk, file.eol);
    let oldStr = op.oldStr;
    let newStr = op.newStr;
    if (file.brk === '\r\n') {
      text = text.replace(/\r\n/g, '\n');
      oldStr = oldStr.replace(/\r\n/g, '\n');
      newStr = newStr.replace(/\r\n/g, '\n');
    }
    const count = countOccurrences(text, oldStr);
    if (count === 0) return { code: 'no-match', path: op.path };
    if (count > 1) return { code: 'ambiguous', path: op.path };
    const at = text.indexOf(oldStr);
    let done = text.slice(0, at) + newStr + text.slice(at + oldStr.length);
    if (file.brk === '\r\n') done = done.replace(/\n/g, '\r\n');
    const parsed = parseFileText(done);
    file.lines = parsed.lines;
    file.brk = parsed.brk;
    file.eol = parsed.eol;
    return null;
  }
  // insert
  if (op.insertLine < 0 || op.insertLine > file.lines.length) return { code: 'no-match', path: op.path };
  const ins = splitNewStr(op.newStr);
  file.lines.splice(op.insertLine, 0, ...ins);
  return null;
}

// --------------------------------------------------------------- top level

function parsePatch(format: FormatName, lines: string[]): { edits: Edit[] } | { error: number } {
  if (format === 'unified') return parseUnified(lines);
  if (format === 'search-replace') return parseSearchReplace(lines);
  if (format === 'v4a') return parseV4a(lines);
  return parseJson(lines);
}

function applyEdit(edit: Edit, tree: Tree, strict: boolean, moves: Array<{ old: string; next: string }>): Fail | null {
  if (edit.kind === 'unified') return applyUnified(edit.section, tree, strict, moves);
  if (edit.kind === 'search') return applySearch(edit.block, tree, strict);
  if (edit.kind === 'v4a') return applyV4a(edit.section, tree, strict, moves);
  return applyJson(edit.op, tree);
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function runCli(argv: string[]): number {
  const args = parseArgs(argv);
  if (args === null) {
    out('error: usage\n');
    return 2;
  }
  const patchText = readPatchText(args.patch);
  if (patchText === null) {
    out('error: no-patch\n');
    return 2;
  }
  const lines = splitPatchLines(patchText);
  let format = args.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      out('error: format\n');
      return 2;
    }
    format = detected;
  }
  const parsed = parsePatch(format, lines);
  if ('error' in parsed) {
    out(`error: parse ${parsed.error}\n`);
    return 2;
  }
  const edits = parsed.edits;
  const tree = new Tree();
  const moves: Array<{ old: string; next: string }> = [];
  const failures: Fail[] = [];
  for (const edit of edits) {
    const fail = applyEdit(edit, tree, args.strict, moves);
    if (fail !== null) failures.push(fail);
  }
  if (failures.length > 0) {
    let text = '';
    for (const f of failures) text += `error: ${f.code} ${f.path}\n`;
    text += `failed: ${failures.length} of ${edits.length} edits\n`;
    out(text);
    return 1;
  }
  // Change listing: R lines replace their move's D and A lines.
  const changed = new Map<string, string>();
  for (const [p, f] of tree.entries()) {
    const now = f.exists ? serializeFile(f.lines, f.brk, f.eol) : null;
    if (f.origExists === f.exists && (!f.origExists || now === f.origText)) continue;
    if (!f.exists) changed.set(p, `D ${p}`);
    else if (!f.origExists) changed.set(p, `A ${p}`);
    else changed.set(p, `M ${p}`);
  }
  const rows: Array<{ key: string; line: string }> = [];
  for (const [p, line] of changed) rows.push({ key: p, line });
  for (const m of moves) {
    const oldF = tree.get(m.old);
    const newF = tree.get(m.next);
    if (oldF.origExists && !newF.origExists && !oldF.exists && newF.exists) {
      rows.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
      const oi = rows.findIndex((r) => r.line === `D ${m.old}`);
      if (oi !== -1) rows.splice(oi, 1);
      const ni = rows.findIndex((r) => r.line === `A ${m.next}`);
      if (ni !== -1) rows.splice(ni, 1);
    }
  }
  rows.sort((a, b) => byteOrder(a.key, b.key) || byteOrder(a.line, b.line));
  let text = '';
  for (const r of rows) text += `${r.line}\n`;
  const n = rows.length;
  text += n === 1 ? 'ok: 1 file\n' : `ok: ${n} files\n`;
  if (!args.check) tree.writeChanged();
  out(text);
  return 0;
}

const envUrl = process.env['MAKEFUN_ENV_URL'];
if (envUrl !== undefined && envUrl !== '') {
  await runTrial(envUrl);
} else {
  process.exitCode = runCli(process.argv.slice(2));
}
