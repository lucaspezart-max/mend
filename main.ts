// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Moves that succeeded in this run, for the `R` output lines (SPEC.md section 2). */
let MOVES: [string, string][] = [];

interface FL {
  lines: string[];
  br: string;
  fin: boolean;
}

/** A file's lines, its own line break and whether it ends with one (SPEC.md section 3). */
function splitFile(text: string): FL {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(f: FL): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}

const trimR = (s: string): string => s.replace(/[ \t]+$/, '');
const trimB = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function eqAt(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimR(a) === trimR(b);
  return trimB(a) === trimB(b);
}

/** Occurrences of O in lines at the first tier with any (SPEC.md section 5), at or after `from`.
 *  A file that ends with a line break has a phantom final empty line: an occurrence may extend one
 *  line past the end when O's last line is empty and the file ends with a break; such a position p
 *  has p + O.length === lines.length + 1. */
function findOcc(lines: string[], O: string[], strict: boolean, from = 0, toEnd = false, fin = false): { tier: number; pos: number[] } {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos: number[] = [];
    for (let i = from; i + O.length <= lines.length; i++) {
      if (toEnd && i + O.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (!eqAt(tier, lines[i + j]!, O[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (fin && O.length > 0) {
      const i = lines.length + 1 - O.length;
      if (i >= from && i > lines.length - O.length) {
        let ok = eqAt(tier, '', O[O.length - 1]!);
        for (let j = 0; ok && j < O.length - 1; j++) if (!eqAt(tier, lines[i + j]!, O[j]!)) ok = false;
        if (ok && (!toEnd || i + O.length === lines.length + 1)) pos.push(i);
      }
    }
    if (pos.length) return { tier, pos };
  }
  return { tier: -1, pos: [] };
}

/** Splice a match into lines, dropping the phantom line from the segment when the match used it. */
function spliceMatch(lines: string[], pos: number, O: string[], ops: Op[], seg: string[]): void {
  let del = O.length;
  let use = seg;
  if (pos + O.length === lines.length + 1) {
    const lastO = [...ops].reverse().find((o) => o.t !== 'a');
    if (lastO !== undefined && lastO.t === 'c') {
      del -= 1;
      use = seg.slice(0, -1);
    }
  }
  lines.splice(pos, del, ...use);
}

interface Op {
  t: 'c' | 'd' | 'a';
  s: string;
  nonl?: boolean;
}

/** The lines that replace the matched region: context lines are the file's own, adds are written as they are (tier 2 re-indents, SPEC.md section 5). */
function buildSegment(fileLines: string[], pos: number, ops: Op[], tier: number, O: string[]): string[] {
  const out: string[] = [];
  let fi = pos;
  let F = '';
  let P = '';
  if (tier === 2 && O.length) {
    F = /^[ \t]*/.exec(fileLines[pos] ?? '')![0];
    P = /^[ \t]*/.exec(O[0]!)![0];
  }
  for (const op of ops) {
    if (op.t === 'c') {
      out.push(fileLines[fi] ?? '');
      fi += 1;
    } else if (op.t === 'd') {
      fi += 1;
    } else {
      let s = op.s;
      if (tier === 2 && s.trim() !== '' && s.startsWith(P)) s = F + s.slice(P.length);
      out.push(s);
    }
  }
  return out;
}

function opsOf(ops: Op[]): { O: string[]; seg: number } {
  return { O: ops.filter((o) => o.t !== 'a').map((o) => o.s), seg: ops.filter((o) => o.t !== 'd').length };
}

/** Apply one section's hunks in order to a file's lines (SPEC.md section 6). */
function applyHunks(f: FL, hunks: { a: number; ops: Op[]; noNLAfter: boolean; hasCtxAdd: boolean }[], strict: boolean, path: string): FL {
  const lines = [...f.lines];
  let fin = f.fin;
  let d = 0;
  for (const h of hunks) {
    const { O } = opsOf(h.ops);
    if (O.length === 0) {
      const seg = h.ops.filter((o) => o.t === 'a').map((o) => o.s);
      const at = Math.max(0, Math.min(h.a + d, lines.length));
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...seg);
      if (atEnd) fin = !h.noNLAfter;
      d += seg.length;
    } else {
      const { tier, pos } = findOcc(lines, O, strict, 0, false, fin);
      if (!pos.length) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = pos[0]!;
      for (const p of pos) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      const seg = buildSegment(lines, best, h.ops, tier, O);
      const atEnd = best + O.length >= lines.length;
      spliceMatch(lines, best, O, h.ops, seg);
      if (atEnd && h.hasCtxAdd) fin = !h.noNLAfter;
      d += seg.length - O.length;
    }
  }
  return { lines, br: f.br, fin };
}

function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function headerPath(raw: string): string {
  const cut = raw.split('\t')[0]!.trim();
  return cut === '/dev/null' ? cut : stripPrefix(cut);
}

interface USec {
  oldPath: string | null;
  newPath: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: { a: number; ops: Op[]; noNLAfter: boolean; hasCtxAdd: boolean }[];
}

function parseHunkBody(lines: string[], start: number): { ops: Op[]; next: number } {
  const raw: Op[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    const c = l[0];
    if (l === '') raw.push({ t: 'c', s: '' });
    else if (c === ' ') raw.push({ t: 'c', s: l.slice(1) });
    else if (c === '-') raw.push({ t: 'd', s: l.slice(1) });
    else if (c === '+') raw.push({ t: 'a', s: l.slice(1) });
    else if (c === '\\') {
      if (raw.length) raw[raw.length - 1]!.nonl = true;
    } else break;
    i += 1;
  }
  while (raw.length && raw[raw.length - 1]!.t === 'c' && raw[raw.length - 1]!.s === '' && !raw[raw.length - 1]!.nonl) raw.pop();
  return { ops: raw, next: i };
}

function unifiedEdit(sec: USec, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (sec.creation || oldP === '/dev/null') {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let lastAdd: Op | undefined;
      for (const h of sec.hunks)
        for (const op of h.ops)
          if (op.t === 'a') {
            out.push(op.s);
            lastAdd = op;
          }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (lastAdd !== undefined && lastAdd.nonl ? '' : '\n'));
      return;
    }
    if (sec.deletion || newP === '/dev/null') {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const o = oldP!;
    const n = newP!;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (o !== n && !safe(n)) throw new Fail('unsafe', n);
    const t = tree.get(o);
    if (t === null) throw new Fail('missing', o);
    if (o !== n && tree.get(n) !== null) throw new Fail('exists', n);
    const res = applyHunks(splitFile(t), sec.hunks, strict, o);
    if (o !== n) {
      tree.now.set(o, null);
      tree.now.set(n, joinFile(res));
      MOVES.push([o, n]);
    } else {
      tree.now.set(o, joinFile(res));
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const isSectionStart = (j: number): boolean =>
    lines[j]!.startsWith('diff --git ') || (lines[j]!.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '));
  while (i < lines.length) {
    if (lines[i]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (!isSectionStart(i)) {
      i += 1;
      continue;
    }
    const sec: USec = { oldPath: null, newPath: null, creation: false, deletion: false, hunks: [] };
    if (lines[i]!.startsWith('diff --git ')) {
      const rest = lines[i]!.slice(11);
      const sep = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (sep < 0) throw new Exit2(`error: parse ${i + 1}`);
      sec.oldPath = rest.slice(2, sep);
      sec.newPath = rest.slice(sep + 3);
      i += 1;
    }
    let sawPair = false;
    while (i < lines.length) {
      const l = lines[i]!;
      if (l.startsWith('@@')) break;
      if (l.startsWith('diff --git ')) break;
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && sawPair) break;
      if (l.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        sec.oldPath = headerPath(l.slice(4));
        sec.newPath = headerPath(lines[i + 1]!.slice(4));
        sawPair = true;
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) sec.oldPath = l.slice(12).trim();
      else if (l.startsWith('rename to ')) sec.newPath = l.slice(10).trim();
      else if (l.startsWith('new file mode')) sec.creation = true;
      else if (l.startsWith('deleted file mode')) sec.deletion = true;
      i += 1;
    }
    while (i < lines.length && lines[i]!.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(lines[i]!);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i += 1;
      const body = parseHunkBody(lines, i);
      i = body.next;
      let lastCA: Op | undefined;
      for (const op of body.ops) if (op.t === 'c' || op.t === 'a') lastCA = op;
      sec.hunks.push({ a, ops: body.ops, noNLAfter: lastCA !== undefined && lastCA.nonl === true, hasCtxAdd: lastCA !== undefined });
    }
    edits.push(unifiedEdit(sec, strict));
  }
  return edits;
}

function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    const f = splitFile(t);
    const { tier, pos } = findOcc(f.lines, oldLines, strict, 0, false, f.fin);
    if (!pos.length) throw new Fail('no-match', p);
    if (pos.length > 1) throw new Fail('ambiguous', p);
    const ops: Op[] = [...oldLines.map((s): Op => ({ t: 'd', s })), ...newLines.map((s): Op => ({ t: 'a', s }))];
    const seg = buildSegment(f.lines, pos[0]!, ops, tier, oldLines);
    const lines = [...f.lines];
    spliceMatch(lines, pos[0]!, oldLines, ops, seg);
    tree.now.set(p, joinFile({ lines, br: f.br, fin: f.fin }));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const isMark = (l: string, m: string): boolean => l.trimEnd() === m;
  let prevPath: string | null = null;
  let boundary = 0;
  let i = 0;
  while (i < lines.length) {
    if (!isMark(lines[i]!, '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    const searchLine = i;
    let p: string | null = null;
    for (let j = i - 1; j >= boundary; j--) {
      if (!blank(lines[j]!) && !lines[j]!.trim().startsWith('```')) {
        p = lines[j]!.trim();
        break;
      }
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let j = i + 1;
    while (j < lines.length && !isMark(lines[j]!, '=======')) j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    let k = j + 1;
    while (k < lines.length && !isMark(lines[k]!, '>>>>>>> REPLACE')) k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(p, lines.slice(i + 1, j), lines.slice(j + 1, k), strict));
    prevPath = p;
    boundary = k + 1;
    i = k + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

function v4aUpdate(p: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(t);
    const lines = [...f.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          for (let x = cursor; x < lines.length; x++) {
            if (eqAt(tier, lines[x]!, ch.anchor)) {
              at = x;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const { O } = opsOf(ch.ops);
      if (O.length === 0) {
        const seg = ch.ops.filter((o) => o.t === 'a').map((o) => o.s);
        const at = ch.eof ? lines.length : Math.min(cursor, lines.length);
        lines.splice(at, 0, ...seg);
        cursor = at + seg.length;
      } else {
        const { tier, pos } = findOcc(lines, O, strict, cursor, ch.eof, f.fin);
        if (!pos.length) throw new Fail('no-match', p);
        const at = pos[0]!;
        const seg = buildSegment(lines, at, ch.ops, tier, O);
        spliceMatch(lines, at, O, ch.ops, seg);
        cursor = at + seg.length;
      }
    }
    const out = joinFile({ lines, br: f.br, fin: f.fin });
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      MOVES.push([p, moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const secStart = (l: string): { kind: string; path: string } | null => {
    for (const [pre, kind] of [['*** Add File: ', 'add'], ['*** Delete File: ', 'del'], ['*** Update File: ', 'upd']] as const) {
      if (l.startsWith(pre)) return { kind, path: l.slice(pre.length).trim() };
    }
    return null;
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    const sec = secStart(l);
    if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
    const secLine = i;
    i += 1;
    const body: { line: string; n: number }[] = [];
    while (i < last && secStart(lines[i]!) === null) {
      body.push({ line: lines[i]!, n: i + 1 });
      i += 1;
    }
    while (body.length && body[body.length - 1]!.line === '') body.pop();
    if (sec.kind === 'add') {
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.line.startsWith('+')) fileLines.push(b.line.slice(1));
        else if (b.line === '') fileLines.push('');
        else throw new Exit2(`error: parse ${b.n}`);
      }
      const p = sec.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (sec.kind === 'del') {
      for (const b of body) if (!blank(b.line)) throw new Exit2(`error: parse ${b.n}`);
      const p = sec.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      let moveTo: string | null = null;
      let at = 0;
      if (body.length && body[0]!.line.startsWith('*** Move to: ')) {
        moveTo = body[0]!.line.slice(13).trim();
        at = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; at < body.length; at++) {
        const b = body[at]!;
        const bl = b.line;
        if (bl.startsWith('@@')) {
          cur = { anchor: bl.slice(2).trim() === '' ? null : bl.slice(2).trim(), eof: false, ops: [] };
          chunks.push(cur);
        } else if (bl.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: false, ops: [] };
            chunks.push(cur);
          }
          cur.eof = true;
          cur = null;
        } else if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, ops: [] };
            chunks.push(cur);
          }
          cur.ops.push(bl === '' ? { t: 'c', s: '' } : { t: bl[0] === ' ' ? 'c' : bl[0] === '-' ? 'd' : 'a', s: bl.slice(1) });
        } else {
          throw new Exit2(`error: parse ${b.n}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine + 1}`);
      edits.push(v4aUpdate(sec.path, moveTo, chunks, strict));
    }
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  MOVES = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const byBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const movedTo = new Map<string, string>();
  for (const [o, n] of MOVES) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) != null) movedTo.set(n, o);
  }
  const covered = new Set<string>();
  for (const [n, o] of movedTo) {
    covered.add(n);
    covered.add(o);
  }
  const rows: { key: string; text: string }[] = [];
  for (const p of changed) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [n, o] of movedTo) rows.push({ key: n, text: `R ${o} -> ${n}` });
  rows.sort((a, b) => byBytes(a.key, b.key));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
