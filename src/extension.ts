import * as vscode from "vscode";
import { searchAndReplace, expandSelection } from "./search-and-replace";

export const activate = (context: vscode.ExtensionContext) => {
  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "vim-search-and-replace.start",
      searchAndReplace
    ),
    vscode.commands.registerCommand(
      "vim-search-and-replace.expandSelection",
      expandSelection
    )
  );
};

export const deactivate = () => {};
