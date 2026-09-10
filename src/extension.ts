import * as vscode from 'vscode';
import { ReaderPanel } from './preview';

/** The Markdown document the reader should open for, if there is one. */
function targetDocument(): vscode.TextDocument | undefined {
  const active = vscode.window.activeTextEditor?.document;
  if (active && (active.languageId === 'markdown' || active.uri.fsPath.toLowerCase().endsWith('.md'))) {
    return active;
  }
  return undefined;
}

async function openReader(extensionUri: vscode.Uri, toSide: boolean): Promise<void> {
  const doc = targetDocument();
  if (!doc) {
    void vscode.window.showInformationMessage('MarkFlow: open a Markdown file first.');
    return;
  }
  const active = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
  const column = toSide ? active + 1 : active;
  ReaderPanel.show(extensionUri, doc, column);
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('markflow.openReader', () => openReader(context.extensionUri, false)),
    vscode.commands.registerCommand('markflow.openReaderToSide', () => openReader(context.extensionUri, true))
  );
}

export function deactivate(): void {
  /* nothing to clean up: panels dispose themselves */
}
