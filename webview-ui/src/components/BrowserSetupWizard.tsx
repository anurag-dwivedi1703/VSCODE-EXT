import React, { useState, useEffect } from 'react';
import { vscode } from '../utilities/vscode';
import './BrowserSetupWizard.css';

// ============================================
// TYPES
// ============================================

interface BrowserInfo {
    name: string;
    type: 'chrome' | 'chromium' | 'edge' | 'firefox' | 'unknown';
    executablePath: string;
    version?: string;
    isValid: boolean;
}

interface DependencyStatus {
    name: string;
    installed: boolean;
    version?: string;
    required: boolean;
}

interface BrowserSetupState {
    status: 'loading' | 'ready' | 'downloading' | 'installing-deps' | 'error';
    browsers: BrowserInfo[];
    selectedBrowser: BrowserInfo | null;
    dependencies: DependencyStatus[];
    error?: string;
    downloadProgress?: number;
}

interface BrowserSetupWizardProps {
    onClose: () => void;
    onBrowserSelected?: (browser: BrowserInfo) => void;
}

// ============================================
// COMPONENT
// ============================================

export const BrowserSetupWizard: React.FC<BrowserSetupWizardProps> = ({ 
    onClose, 
    onBrowserSelected 
}) => {
    const [state, setState] = useState<BrowserSetupState>({
        status: 'loading',
        browsers: [],
        selectedBrowser: null,
        dependencies: [],
    });

    // Load available browsers and check dependencies on mount
    useEffect(() => {
        checkDependencies();
        detectBrowsers();
    }, []);

    // Listen for messages from extension
    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const message = event.data;
            
            switch (message.type) {
                case 'browsersDetected':
                    setState(prev => ({
                        ...prev,
                        status: 'ready',
                        browsers: message.browsers || [],
                        selectedBrowser: message.browsers?.[0] || null,
                    }));
                    break;
                    
                case 'dependenciesChecked':
                    setState(prev => ({
                        ...prev,
                        dependencies: message.dependencies || [],
                    }));
                    break;
                    
                case 'dependenciesInstalling':
                    setState(prev => ({
                        ...prev,
                        status: 'installing-deps',
                    }));
                    break;
                    
                case 'dependenciesInstalled':
                    setState(prev => ({
                        ...prev,
                        status: 'ready',
                        dependencies: message.dependencies || prev.dependencies,
                    }));
                    checkDependencies(); // Refresh status
                    break;
                    
                case 'browserDownloadStarted':
                    setState(prev => ({
                        ...prev,
                        status: 'downloading',
                        downloadProgress: 0,
                    }));
                    break;
                    
                case 'browserDownloadProgress':
                    setState(prev => ({
                        ...prev,
                        downloadProgress: message.progress,
                    }));
                    break;
                    
                case 'browserDownloadComplete':
                    setState(prev => ({
                        ...prev,
                        status: 'ready',
                        browsers: [...prev.browsers, message.browser],
                        selectedBrowser: message.browser,
                    }));
                    break;
                    
                case 'browserDownloadError':
                    setState(prev => ({
                        ...prev,
                        status: 'error',
                        error: message.error,
                    }));
                    break;
                    
                case 'browserSelected':
                    if (onBrowserSelected && message.browser) {
                        onBrowserSelected(message.browser);
                    }
                    onClose();
                    break;
            }
        };

        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [onClose, onBrowserSelected]);

    const checkDependencies = () => {
        vscode.postMessage({ command: 'checkBrowserDependencies' });
    };

    const installDependencies = () => {
        vscode.postMessage({ command: 'installBrowserDependencies' });
    };

    const detectBrowsers = () => {
        setState(prev => ({ ...prev, status: 'loading' }));
        vscode.postMessage({ command: 'detectBrowsers' });
    };

    const downloadChromium = () => {
        setState(prev => ({ ...prev, status: 'downloading', downloadProgress: 0 }));
        vscode.postMessage({ type: 'downloadChromium' });
    };

    const selectBrowser = (browser: BrowserInfo) => {
        setState(prev => ({ ...prev, selectedBrowser: browser }));
    };

    const confirmSelection = () => {
        if (state.selectedBrowser) {
            vscode.postMessage({ 
                type: 'selectBrowser', 
                executablePath: state.selectedBrowser.executablePath 
            });
        }
    };

    const getBrowserIcon = (type: string): string => {
        switch (type) {
            case 'chrome': return '🌐';
            case 'chromium': return '⚪';
            case 'edge': return '🔷';
            case 'firefox': return '🦊';
            default: return '🌍';
        }
    };

    return (
        <div className="browser-setup-wizard">
            <div className="wizard-header">
                <h2>🔧 Browser Setup</h2>
                <button className="close-btn" onClick={onClose}>✕</button>
            </div>

            <div className="wizard-content">
                {state.status === 'loading' && (
                    <div className="loading-state">
                        <div className="spinner"></div>
                        <p>Detecting installed browsers...</p>
                    </div>
                )}

                {state.status === 'downloading' && (
                    <div className="downloading-state">
                        <div className="spinner"></div>
                        <p>Downloading Chromium browser...</p>
                        {state.downloadProgress !== undefined && (
                            <div className="progress-bar">
                                <div 
                                    className="progress-fill" 
                                    style={{ width: `${state.downloadProgress}%` }}
                                />
                            </div>
                        )}
                        <p className="download-note">
                            This may take a few minutes depending on your connection.
                        </p>
                    </div>
                )}

                {state.status === 'installing-deps' && (
                    <div className="downloading-state">
                        <div className="spinner"></div>
                        <p>Installing browser automation packages...</p>
                        <p className="download-note">
                            Installing playwright-core and related packages.
                        </p>
                    </div>
                )}

                {state.status === 'error' && (
                    <div className="error-state">
                        <div className="error-icon">⚠️</div>
                        <p className="error-message">{state.error}</p>
                        <button className="retry-btn" onClick={detectBrowsers}>
                            Try Again
                        </button>
                    </div>
                )}

                {state.status === 'ready' && (
                    <>
                        {/* Dependency Status Section */}
                        {state.dependencies.length > 0 && (
                            <div className="dependency-section">
                                <p className="section-label">Dependencies:</p>
                                <div className="dependency-list">
                                    {state.dependencies.map((dep, idx) => (
                                        <div key={idx} className={`dependency-item ${dep.installed ? 'installed' : 'missing'}`}>
                                            <span className="dep-icon">{dep.installed ? '✅' : '❌'}</span>
                                            <span className="dep-name">{dep.name}</span>
                                            {dep.version && <span className="dep-version">v{dep.version}</span>}
                                            {!dep.installed && dep.required && <span className="dep-required">required</span>}
                                        </div>
                                    ))}
                                </div>
                                {state.dependencies.some(d => !d.installed && d.required) && (
                                    <button className="install-deps-btn" onClick={installDependencies}>
                                        📦 Install Missing Dependencies
                                    </button>
                                )}
                            </div>
                        )}

                        {state.browsers.length > 0 ? (
                            <div className="browser-list">
                                <p className="section-label">Select a browser for automation:</p>
                                {state.browsers.map((browser, index) => (
                                    <div
                                        key={index}
                                        className={`browser-item ${state.selectedBrowser === browser ? 'selected' : ''}`}
                                        onClick={() => selectBrowser(browser)}
                                    >
                                        <span className="browser-icon">{getBrowserIcon(browser.type)}</span>
                                        <div className="browser-info">
                                            <span className="browser-name">{browser.name}</span>
                                            {browser.version && (
                                                <span className="browser-version">v{browser.version}</span>
                                            )}
                                            <span className="browser-path" title={browser.executablePath}>
                                                {browser.executablePath.length > 50 
                                                    ? '...' + browser.executablePath.slice(-47)
                                                    : browser.executablePath
                                                }
                                            </span>
                                        </div>
                                        {state.selectedBrowser === browser && (
                                            <span className="check-icon">✓</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="no-browsers">
                                <div className="no-browsers-icon">🔍</div>
                                <p>No compatible browsers found.</p>
                                <p className="hint">
                                    Browser automation requires Chrome, Edge, Chromium, or Firefox.
                                </p>
                            </div>
                        )}

                        <div className="download-section">
                            <button 
                                className="download-btn"
                                onClick={downloadChromium}
                            >
                                📥 Download Chromium
                            </button>
                            <p className="download-hint">
                                Don't have a browser? Download Chromium automatically.
                            </p>
                        </div>
                    </>
                )}
            </div>

            <div className="wizard-footer">
                <button className="cancel-btn" onClick={onClose}>
                    Cancel
                </button>
                {state.status === 'ready' && state.selectedBrowser && (
                    <button className="confirm-btn" onClick={confirmSelection}>
                        Use {state.selectedBrowser.name}
                    </button>
                )}
            </div>
        </div>
    );
};

export default BrowserSetupWizard;
