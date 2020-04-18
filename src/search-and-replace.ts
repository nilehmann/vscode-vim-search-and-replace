import * as vscode from "vscode";
import { type } from "os";

const matchHighlight = vscode.window.createTextEditorDecorationType({
  backgroundColor: "rgba(255,0,0,.35)",
});

export function searchAndReplace(
  textEditor: vscode.TextEditor,
  _editBuilder: vscode.TextEditorEdit,
  arg?: any
) {
  const searchAndReplace = new SearchAndReplace(textEditor);
  if (typeof arg === "string") {
    searchAndReplace.show(arg);
  } else {
    searchAndReplace.show();
  }
}

export function expandSelection(arg?: any) {
  SearchAndReplace.activeInstance?.replaceRangeBySelection();
  if (arg !== undefined) {
    const params = { up: 0, down: 0 };
    if (typeof arg.up === "number") {
      params.up = arg.up;
    }
    if (typeof arg.down === "number") {
      params.down = arg.down;
    }
    SearchAndReplace.activeInstance?.expandSelection(params);
  } else {
    SearchAndReplace.activeInstance?.expandSelection({ down: 1 });
  }
}

class SearchAndReplace {
  // This is a hack to communicate the expandSelection* commands with
  // the active instance.
  static activeInstance: SearchAndReplace | undefined = undefined;

  private edits: Edit[] = [];
  private disposables: vscode.Disposable[] = [];
  private inputBox: vscode.InputBox;

  constructor(private textEditor: vscode.TextEditor) {
    this.inputBox = vscode.window.createInputBox();
    this.inputBox.onDidChangeValue(this.onDidChangeValue);
    this.inputBox.onDidAccept(this.onDidAccept);
    this.inputBox.onDidHide(this.onDidHide);

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.onDidChangeValue(this.inputBox.value);
      })
    );
  }

  show(value?: string) {
    if (SearchAndReplace.activeInstance) {
      return;
    }
    SearchAndReplace.activeInstance = this;
    vscode.commands.executeCommand(
      "setContext",
      "vim-search-and-replace.active",
      true
    );
    this.inputBox.show();
    let prefix = this.getInitialPrefix(value);
    this.inputBox.value = prefix;
    this.onDidChangeValue(prefix);
  }

  onDidHide = () => {
    SearchAndReplace.activeInstance = undefined;
    this.dispose();
    vscode.commands.executeCommand(
      "setContext",
      "vim-search-and-replace.active",
      false
    );
    this.textEditor.setDecorations(matchHighlight, []);
    this.textEditor.selection = new vscode.Selection(
      this.textEditor.selection.start,
      this.textEditor.selection.start
    );
  };

  dispose() {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.inputBox.dispose();
  }

  onDidChangeValue = (value: string) => {
    const cmd = SubstCmd.parse(value, this.textEditor.selection);
    if (!cmd) {
      this.edits = [];
      this.inputBox.validationMessage = "malformed expression";
      return;
    }
    this.inputBox.validationMessage = "";
    this.textEditor.setDecorations(matchHighlight, []);

    this.edits = cmd.findMatches(this.textEditor.document).map((m) => {
      let replacement;
      if (typeof cmd.replace === "string") {
        replacement = m.text.replace(cmd.search, cmd.replace);
      }
      return new Edit(m.text, m.range, replacement);
    });
    this.textEditor.setDecorations(
      matchHighlight,
      this.edits.map((edit) => edit.getDecoration())
    );
  };

  onDidAccept = () => {
    this.textEditor.edit((builder) => {
      for (let edit of this.edits) {
        if (typeof edit.replacement === "string") {
          builder.replace(edit.range, edit.replacement);
        }
      }
    });
    this.inputBox.hide();
  };

  replaceRangeBySelection() {
    let value = SubstCmd.replaceRangeBySelection(this.inputBox.value);
    this.inputBox.value = value;
  }

  expandSelection({ up = 0, down = 0 }) {
    const document = this.textEditor.document;
    const selection = this.textEditor.selection;
    if (selection.isSingleLine) {
      const line = document.lineAt(selection.start.line);
      if (!line.range.isEqual(selection)) {
        this.textEditor.selection = new vscode.Selection(
          line.range.start,
          line.range.end
        );
        return;
      }
    }
    const startLine = document.lineAt(
      clamp(selection.start.line - up, 0, document.lineCount - 1)
    );
    const endLine = document.lineAt(
      clamp(selection.end.line + down, 0, document.lineCount - 1)
    );
    this.textEditor.selection = new vscode.Selection(
      startLine.range.start,
      endLine.range.end
    );
  }

  getInitialPrefix(value?: string): string {
    let selection = this.textEditor.selection;
    let prefix;
    if (this.textEditor.selection.isEmpty) {
      prefix = "%s/";
    } else {
      prefix = "'<,'>s/";
    }
    if (value) {
      prefix += escapeStringRegex(value) + "/";
    }
    return prefix;
  }
}

function escapeStringRegex(str: string): string {
  return str.replace(/[|\\{}()[\]^$+*?.\/]/g, "\\$&");
}

class Edit {
  constructor(
    public text: string,
    public range: vscode.Range,
    public replacement: string | undefined
  ) {}

  getDecoration() {
    let hoverMessage = new vscode.MarkdownString();
    const arrow = "&nbsp;&nbsp;&nbsp;⟶&nbsp;&nbsp;&nbsp;";
    if (this.replacement === undefined) {
      hoverMessage.appendMarkdown("*no replacement*");
    } else {
      hoverMessage.appendMarkdown(backTickSurround(this.text));
      hoverMessage.appendText(arrow);
      if (this.replacement === "") {
        hoverMessage.appendMarkdown("*empty string*");
      } else {
        hoverMessage.appendMarkdown(backTickSurround(this.replacement));
      }
    }
    return { range: this.range, hoverMessage };
  }
}

function backTickSurround(str: string): string {
  const backTicks = longestBackTickSubstring(str) + 1;
  return "`".repeat(backTicks) + ` ${str} ` + "`".repeat(backTicks);
}

function longestBackTickSubstring(str: string): number {
  let count = 0;
  let max = 0;
  for (let c of str) {
    if (c === "`") {
      count += 1;
    } else {
      max = Math.max(max, count);
      count = 0;
    }
  }
  return Math.max(max, count);
}

interface LineRange {
  start: number;
  end: number;
}

interface Match {
  text: string;
  range: vscode.Range;
}

class SubstCmd {
  private static regex = new RegExp(
    /^s*((?:(?:\d+|'<)\s*,\s*(?:\d+|'>))|%)?(\s*s\s*\/((?:[^\/\\]|\\.)*)(?:\/((?:[^\/\\]|\\.)*))?(?:\/([gmi]*))?\s*)$/
  );

  constructor(
    public search: RegExp,
    public replace: string | undefined,
    public lineRange: LineRange | undefined
  ) {}

  static parse(str: string, selection: vscode.Selection): SubstCmd | undefined {
    try {
      let m = str.match(SubstCmd.regex);
      if (m) {
        let regex = new RegExp(m[3], m[5]);
        return new SubstCmd(regex, m[4], SubstCmd.parseRange(m[1], selection));
      }
    } catch {}
    return undefined;
  }

  static replaceRangeBySelection(cmd: string): string {
    return cmd.replace(SubstCmd.regex, "'<,'>$2");
  }

  static parseRange(
    str: string | undefined,
    selection: vscode.Selection
  ): LineRange | undefined {
    if (!str) {
      let activeLine = selection.active.line;
      return { start: activeLine, end: activeLine };
    }
    let [x, y] = str.split(/\s*,\s*/);
    if (x && y) {
      let start = x === "'<" ? selection.start.line : parseInt(x) - 1;
      let end = y === "'>" ? selection.end.line : parseInt(y) - 1;
      return { start, end };
    } else {
      return undefined;
    }
  }

  adjustRange(document: vscode.TextDocument): LineRange {
    let range = this.lineRange || { start: 0, end: document.lineCount - 1 };
    return {
      start: clamp(range.start, 0, document.lineCount - 1),
      end: clamp(range.end, 0, document.lineCount - 1),
    };
  }

  findMatches(document: vscode.TextDocument): Match[] {
    if (this.search.multiline) {
      return this.findMatchesMultiline(document);
    } else {
      return this.findMatchesByLine(document);
    }
  }

  findMatchesMultiline(document: vscode.TextDocument): Match[] {
    const lineRange = this.adjustRange(document);
    const start = document.lineAt(lineRange.start).range.start;
    const end = document.lineAt(lineRange.end).range.end;
    const range = new vscode.Range(start, end);
    return matchAll(this.search, document.getText(range)).map((match) => {
      return {
        text: match[0],
        range: new vscode.Range(
          document.positionAt(match.index),
          document.positionAt(match.index + match[0].length)
        ),
      };
    });
  }

  findMatchesByLine(document: vscode.TextDocument): Match[] {
    const lineRange = this.adjustRange(document);
    const matches: Match[] = [];
    for (let i = lineRange.start; i <= lineRange.end; ++i) {
      const line = document.lineAt(i);
      const start = line.range.start;
      matches.push(
        ...matchAll(this.search, line.text).map((m) => {
          return {
            text: m[0],
            range: new vscode.Range(
              start.translate(0, m.index),
              start.translate(0, m.index + m[0].length)
            ),
          };
        })
      );
    }
    return matches;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function matchAll(regex: RegExp, str: string): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((regex.global || !matches.length) && (match = regex.exec(str))) {
    matches.push(match);
    // Handle empty matches
    if (regex.lastIndex === match.index) {
      regex.lastIndex++;
    }
  }
  return matches;
}
