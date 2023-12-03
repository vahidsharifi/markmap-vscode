import { JSItem, type CSSItem, type IMarkmapJSONOptions } from 'markmap-common';
import {
  CancellationToken,
  CustomTextEditorProvider,
  ExtensionContext,
  TextDocument,
  ViewColumn,
  WebviewPanel,
  commands,
  window as vscodeWindow,
  workspace,
  Uri,
} from 'vscode';
import debounce from 'lodash.debounce';
import { Utils } from 'vscode-uri';
import {
  getAssets,
  mergeAssets,
  setExportMode,
  transformerLocal,
  transformerExport,
} from './util';

const PREFIX = 'markmap-vscode';
const VIEW_TYPE = `${PREFIX}.markmap`;

const renderToolbar = () => {
  const { markmap, mm } = window as any;
  const { el } = markmap.Toolbar.create(mm);
  el.setAttribute('style', 'position:absolute;bottom:20px;right:20px');
  document.body.append(el);
};

class MarkmapEditor implements CustomTextEditorProvider {
  constructor(private context: ExtensionContext) {}

  private resolveAssetPath(relPath: string) {
    return Utils.joinPath(this.context.extensionUri, relPath);
  }

  private async loadAsset(relPath: string) {
    const bytes = await workspace.fs.readFile(this.resolveAssetPath(relPath));
    const decoder = new TextDecoder();
    const data = decoder.decode(bytes);
    return data;
  }

  public async resolveCustomTextEditor(
    document: TextDocument,
    webviewPanel: WebviewPanel,
    token: CancellationToken
  ): Promise<void> {
    webviewPanel.webview.options = {
      enableScripts: true,
    };
    const resolveUrl = (relPath: string) =>
      webviewPanel.webview
        .asWebviewUri(this.resolveAssetPath(relPath))
        .toString();
    const { allAssets } = getAssets(transformerLocal);
    const resolvedAssets = {
      ...allAssets,
      styles: allAssets.styles?.map((item) => {
        if (item.type === 'stylesheet') {
          return {
            ...item,
            data: {
              href: resolveUrl(item.data.href),
            },
          };
        }
        return item;
      }),
      scripts: allAssets.scripts?.map((item) => {
        if (item.type === 'script' && item.data.src) {
          return {
            ...item,
            data: {
              ...item.data,
              src: resolveUrl(item.data.src),
            },
          };
        }
        return item;
      }),
    };
    webviewPanel.webview.html = transformerLocal.fillTemplate(
      undefined,
      resolvedAssets,
      { baseJs: [] }
    );
    const updateCursor = () => {
      const editor = vscodeWindow.activeTextEditor;
      if (editor?.document === document) {
        webviewPanel.webview.postMessage({
          type: 'setCursor',
          data: editor.selection.active.line,
        });
      }
    };
    let defaultOptions: IMarkmapJSONOptions;
    let customCSS: string;
    const updateOptions = () => {
      const raw = workspace
        .getConfiguration('markmap')
        .get<string>('defaultOptions');
      try {
        defaultOptions = raw && JSON.parse(raw);
      } catch {
        defaultOptions = null;
      }
      update();
    };
    const updateCSS = () => {
      customCSS = workspace
        .getConfiguration('markmap')
        .get<string>('customCSS');
      webviewPanel.webview.postMessage({
        type: 'setCSS',
        data: customCSS,
      });
    };
    const update = () => {
      const md = document.getText();
      const { root, frontmatter } = transformerLocal.transform(md);
      webviewPanel.webview.postMessage({
        type: 'setData',
        data: {
          root,
          jsonOptions: {
            ...defaultOptions,
            ...(frontmatter as any)?.markmap,
          },
        },
      });
      updateCursor();
    };
    const debouncedUpdateCursor = debounce(updateCursor, 300);
    const debouncedUpdate = debounce(update, 300);

    const messageHandlers: { [key: string]: (data?: any) => void } = {
      refresh: update,
      editAsText: () => {
        vscodeWindow.showTextDocument(document, {
          viewColumn: ViewColumn.Beside,
        });
      },
      exportAsHtml: async () => {
        const targetUri = await vscodeWindow.showSaveDialog({
          saveLabel: 'Export',
          filters: {
            HTML: ['html'],
          },
        });
        if (!targetUri) return;
        const md = document.getText();
        const { root, features, frontmatter } = transformerExport.transform(md);
        const jsonOptions = {
          ...defaultOptions,
          ...(frontmatter as any)?.markmap,
        };
        const { embedAssets } = jsonOptions as { embedAssets?: boolean };
        setExportMode(embedAssets);
        let assets = transformerExport.getUsedAssets(features);
        const { baseAssets, toolbarAssets } = getAssets(transformerExport);
        assets = mergeAssets(baseAssets, assets, toolbarAssets, {
          styles: [
            ...(customCSS
              ? [
                  {
                    type: 'style',
                    data: customCSS,
                  } as CSSItem,
                ]
              : []),
          ],
          scripts: [
            {
              type: 'iife',
              data: {
                fn: (r: typeof renderToolbar) => {
                  setTimeout(r);
                },
                getParams: () => [renderToolbar],
              },
            },
          ],
        });
        if (embedAssets) {
          const [styles, scripts] = await Promise.all([
            Promise.all(
              (assets.styles || []).map(async (item): Promise<CSSItem> => {
                if (item.type === 'stylesheet') {
                  return {
                    type: 'style',
                    data: await this.loadAsset(item.data.href),
                  };
                }
                return item;
              })
            ),
            Promise.all(
              (assets.scripts || []).map(async (item): Promise<JSItem> => {
                if (item.type === 'script' && item.data.src) {
                  return {
                    ...item,
                    data: {
                      textContent: await this.loadAsset(item.data.src),
                    },
                  };
                }
                return item;
              })
            ),
          ]);
          assets = {
            styles,
            scripts,
          };
        }
        const html = transformerExport.fillTemplate(root, assets, {
          baseJs: [],
          jsonOptions,
        });
        const encoder = new TextEncoder();
        const data = encoder.encode(html);
        try {
          await workspace.fs.writeFile(targetUri, data);
        } catch (e) {
          vscodeWindow.showErrorMessage(
            `Cannot write file "${targetUri.toString()}"!`
          );
        }
      },
      openFile(relPath: string) {
        const filePath = Utils.joinPath(Utils.dirname(document.uri), relPath);
        commands.executeCommand('vscode.open', filePath);
      },
    };
    const logger = vscodeWindow.createOutputChannel('Markmap');
    messageHandlers.log = (data: string) => {
      logger.appendLine(data);
    };
    webviewPanel.webview.onDidReceiveMessage((e) => {
      const handler = messageHandlers[e.type];
      handler?.(e.data);
    });
    workspace.onDidChangeTextDocument((e) => {
      if (e.document === document) {
        debouncedUpdate();
      }
    });
    vscodeWindow.onDidChangeTextEditorSelection(() => {
      debouncedUpdateCursor();
    });
    updateOptions();
    updateCSS();
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('markmap.defaultOptions')) updateOptions();
      if (e.affectsConfiguration('markmap.customCSS')) updateCSS();
    });
  }
}

export function activate(context: ExtensionContext) {
  context.subscriptions.push(
    commands.registerCommand(`${PREFIX}.open`, (uri?: Uri) => {
      uri ??= vscodeWindow.activeTextEditor?.document.uri;
      commands.executeCommand(
        'vscode.openWith',
        uri,
        VIEW_TYPE,
        ViewColumn.Beside
      );
    })
  );
  const markmapEditor = new MarkmapEditor(context);
  context.subscriptions.push(
    vscodeWindow.registerCustomEditorProvider(VIEW_TYPE, markmapEditor, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
}

export function deactivate() {
  // noop
}
