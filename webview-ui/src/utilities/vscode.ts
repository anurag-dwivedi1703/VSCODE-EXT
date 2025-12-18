/**
 * Utility to manage the VS Code Webview API.
 * Ensures acquireVsCodeApi is called only once.
 */

// @ts-ignore
const vscodeAPI = window.acquireVsCodeApi ? window.acquireVsCodeApi() : { postMessage: () => { } };

export const vscode = {
    postMessage: (message: any) => {
        if (vscodeAPI) {
            vscodeAPI.postMessage(message);
        }
    }
};
