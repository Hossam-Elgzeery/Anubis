import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import * as ts from "typescript";

const execFileAsync = promisify(execFile);
const supportedExtensions = /\.(js|jsx|ts|tsx)$/i;
const TARGET_CHUNK_CHARS = 3000;
const OVERLAP_LINES = 18;
const MAX_DIFF_CHARS_PER_CHUNK = 1200;
const MAX_DEPENDENCY_CHARS = 1200;

export interface ReviewChunk {
  file: string;
  startLine: number;
  endLine: number;
  /** Only findings in this inclusive range are owned by this chunk. */
  ownedStartLine: number;
  ownedEndLine: number;
  context: string;
}

interface Range {
  start: number;
  end: number;
}

function isSafeFile(file: string, cwd: string): boolean {
  if (!file || isAbsolute(file) || !supportedExtensions.test(file))
    return false;
  const path = relative(cwd, resolve(cwd, file));
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

export async function getChangedFiles(cwd = process.cwd()): Promise<string[]> {
  const commands = [
    ["diff", "--name-only", "-z", "--diff-filter=ACMR"],
    ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  const results = await Promise.all(commands.map((args) => runGit(args, cwd)));
  return [...new Set(results.flatMap((s) => s.split("\0").filter(Boolean)))]
    .filter((file) => isSafeFile(file, cwd))
    .sort();
}

export async function getGitDiff(cwd = process.cwd()): Promise<string> {
  const [unstaged, staged] = await Promise.all([
    runGit(["diff", "--no-ext-diff", "--no-textconv", "--", "."], cwd),
    runGit(
      ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", "."],
      cwd,
    ),
  ]);
  return [
    "=== UNSTAGED CHANGES ===",
    unstaged,
    "=== STAGED CHANGES ===",
    staged,
  ].join("\n");
}

async function getFileDiff(file: string, cwd: string): Promise<string> {
  const [unstaged, staged] = await Promise.all([
    runGit(["diff", "--no-ext-diff", "--no-textconv", "--", file], cwd),
    runGit(
      ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", file],
      cwd,
    ),
  ]);
  const combined = [unstaged, staged].filter(Boolean).join("\n");
  if (!combined)
    return "(Untracked or no patch available; source lines are authoritative.)";
  if (combined.length <= MAX_DIFF_CHARS_PER_CHUNK) return combined;
  let output = "";
  for (const line of combined.split("\n")) {
    if (output.length + line.length + 1 > MAX_DIFF_CHARS_PER_CHUNK) break;
    output += `${line}\n`;
  }
  return `${output}[DIFF EXCERPT OMITTED; review the source lines below]`;
}

function scriptKind(file: string): ts.ScriptKind {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.ts$/i.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function lineOf(source: ts.SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line;
}

/** Prefer complete statements. Descend into a large function/component only when needed. */
function syntaxRanges(source: ts.SourceFile, lines: string[]): Range[] {
  const boundaries = new Set<number>([0, lines.length]);
  const endLine = (node: ts.Node): number => {
    const loc = source.getLineAndCharacterOfPosition(node.getEnd());
    return Math.min(lines.length, loc.line + (loc.character > 0 ? 1 : 0));
  };
  const addStatements = (statements: ts.NodeArray<ts.Statement>): void => {
    for (const statement of statements) {
      const start = lineOf(source, statement.getStart(source));
      const end = endLine(statement);
      if (end <= start) continue;
      boundaries.add(start);
      boundaries.add(end);
      if (charCount(lines, start, end) > TARGET_CHUNK_CHARS) {
        // A large component should be divided at its top-level body statements,
        // not at arbitrary nested expressions, JSX nodes, or callback internals.
        const body = ts.isFunctionDeclaration(statement)
          ? statement.body
          : ts.isClassDeclaration(statement)
            ? undefined
            : ts.isVariableStatement(statement)
              ? (() => {
                  const decl = statement.declarationList.declarations[0];
                  const init = decl?.initializer;
                  return init &&
                    (ts.isArrowFunction(init) ||
                      ts.isFunctionExpression(init)) &&
                    ts.isBlock(init.body)
                    ? init.body
                    : undefined;
                })()
              : undefined;
        if (body && ts.isBlock(body)) {
          for (const child of body.statements) {
            boundaries.add(lineOf(source, child.getStart(source)));
            boundaries.add(endLine(child));
          }
        }
      }
    }
  };
  addStatements(source.statements);
  const points = [...boundaries]
    .filter((n) => n >= 0 && n <= lines.length)
    .sort((a, b) => a - b);
  return points.slice(1).map((end, i) => ({ start: points[i], end }));
}

function charCount(lines: string[], start: number, end: number): number {
  let count = 0;
  for (let i = start; i < end; i++)
    count += lines[i].length + `[L${i + 1}] `.length + 1;
  return count;
}

function planRanges(lines: string[], syntax: Range[]): Range[] {
  const result: Range[] = [];
  let start = 0;
  while (start < lines.length) {
    let best = start;
    for (const range of syntax) {
      if (range.end <= start) continue;
      if (charCount(lines, start, range.end) > TARGET_CHUNK_CHARS) break;
      best = range.end;
    }
    if (best === start) {
      // Oversized statement: retain all lines and progress even for long single lines.
      let size = 0;
      while (best < lines.length) {
        const next = charCount(lines, best, best + 1);
        if (best > start && size + next > TARGET_CHUNK_CHARS) break;
        size += next;
        best++;
      }
    }
    result.push({ start, end: best });
    start = best;
  }
  return result;
}

interface Declaration {
  name: string;
  start: number;
  end: number;
  priority: number;
}

/** Gather declarations as complete line ranges, never isolated matching expressions. */
function collectDeclarations(source: ts.SourceFile): Declaration[] {
  const declarations: Declaration[] = [];
  const add = (name: string, node: ts.Node, priority: number): void => {
    const loc = source.getLineAndCharacterOfPosition(node.getEnd());
    declarations.push({
      name,
      start: lineOf(source, node.getStart(source)),
      end: loc.line + (loc.character > 0 ? 1 : 0),
      priority,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const parent = node.parent.parent;
      const names: string[] = [];
      const collectNames = (name: ts.BindingName): void => {
        if (ts.isIdentifier(name)) names.push(name.text);
        else
          for (const element of name.elements)
            if (ts.isBindingElement(element)) collectNames(element.name);
      };
      collectNames(node.name);
      const state =
        !!node.initializer &&
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "useState";
      for (const name of names) add(name, parent, state ? 0 : 2);
    } else if (
      (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      node.name
    ) {
      add(node.name.text, node, 1);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, node, 3);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return declarations;
}

function dependencyContext(
  source: ts.SourceFile,
  lines: string[],
  owned: Range,
  visibleStart: number,
): string {
  const identifiers = new Set<string>();
  const startPos = source.getPositionOfLineAndCharacter(owned.start, 0);
  const endPos =
    owned.end < source.getLineStarts().length
      ? source.getPositionOfLineAndCharacter(owned.end, 0)
      : source.end;
  const visit = (node: ts.Node): void => {
    if (node.end <= startPos || node.pos >= endPos) return;
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);

  const candidates = collectDeclarations(source)
    .filter(
      (d) =>
        identifiers.has(d.name) && d.end <= visibleStart && d.end > d.start,
    )
    .sort((a, b) => a.priority - b.priority || a.start - b.start);
  const snippets: string[] = [];
  const seen = new Set<string>();
  let budget = MAX_DEPENDENCY_CHARS;
  for (const decl of candidates) {
    const key = `${decl.start}:${decl.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = lines
      .slice(decl.start, decl.end)
      .map((line, i) => `[L${decl.start + i + 1}] ${line}`)
      .join("\n");
    // Don't inject incomplete functions just to meet the budget.
    if (snippet.length > budget) continue;
    snippets.push(snippet);
    budget -= snippet.length;
  }
  return snippets.length
    ? [
        "=== REFERENCED DECLARATIONS (READ-ONLY CONTEXT; DO NOT REPORT HERE) ===",
        ...snippets,
      ].join("\n")
    : "";
}

export async function getReviewChunks(
  files: string[],
  cwd = process.cwd(),
): Promise<ReviewChunk[]> {
  const chunks: ReviewChunk[] = [];
  for (const file of files) {
    if (!isSafeFile(file, cwd)) throw new Error(`Unsafe review path: ${file}`);
    const sourceText = await readFile(resolve(cwd, file), "utf8");
    const lines = sourceText.split(/\r?\n/);
    const diff = await getFileDiff(file, cwd);
    const source = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(file),
    );
    const ranges = planRanges(lines, syntaxRanges(source, lines));
    for (const owned of ranges) {
      const start = Math.max(0, owned.start - OVERLAP_LINES);
      const numbered = lines
        .slice(start, owned.end)
        .map((line, i) => `[L${start + i + 1}] ${line}`)
        .join("\n");
      const context = [
        "=== GIT DIFF ===",
        diff,
        "",
        "=== CHANGED FILE CONTENT ===",
        `--- FILE: ${file} ---`,
        `[REVIEW SCOPE: ${file}, lines ${owned.start + 1}-${owned.end}]`,
        `[CONTEXT LINES: ${start + 1}-${owned.end}; overlap is for context only]`,
        "[Report findings only for REVIEW SCOPE lines. Use original file line numbers.]",
        numbered,
        dependencyContext(source, lines, owned, start),
      ]
        .filter(Boolean)
        .join("\n");
      chunks.push({
        file,
        startLine: start + 1,
        endLine: owned.end,
        ownedStartLine: owned.start + 1,
        ownedEndLine: owned.end,
        context,
      });
    }
  }
  return chunks;
}

export async function getReviewContext(
  files: string[],
  cwd = process.cwd(),
): Promise<string> {
  return (await getReviewChunks(files, cwd))
    .map((chunk) => chunk.context)
    .join("\n\n");
}
