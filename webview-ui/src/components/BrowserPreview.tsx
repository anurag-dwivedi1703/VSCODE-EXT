import * as React from 'react';
import { useState, useEffect } from 'react';
import { vscode } from '../utilities/vscode';

interface BrowserPreviewProps {
    taskId: string;
}

export function BrowserPreview({ taskId }: BrowserPreviewProps) {
    const [url, setUrl] = useState('http://localhost:3000');
    const [inputUrl, setInputUrl] = useState('http://localhost:3000');
    const [isCommenting, setIsCommenting] = useState(false);
    const [clickCoords, setClickCoords] = useState<{ x: number, y: number } | null>(null);
    const [commentText, setCommentText] = useState('');
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        const messageHandler = (event: MessageEvent) => {
            if (event.data.command === 'reloadBrowser') {
                // Force reload by appending/updating timestamp
                setReloadKey(prev => prev + 1);
                setUrl(currentUrl => {
                    const cleanUrl = currentUrl.split('?')[0];
                    return `${cleanUrl}?t=${Date.now()}`;
                });
            }
        };
        window.addEventListener('message', messageHandler);
        return () => window.removeEventListener('message', messageHandler);
    }, []);

    const handleNavigate = () => {
        let target = inputUrl;
        if (!target.startsWith('http')) {
            target = 'http://' + target;
        }
        setUrl(target);
    };

    const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!isCommenting) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100; // Percentage
        const y = ((e.clientY - rect.top) / rect.height) * 100; // Percentage

        setClickCoords({ x: Math.round(x), y: Math.round(y) });
    };

    const submitComment = () => {
        if (!clickCoords || !commentText.trim()) return;

        vscode.postMessage({
            command: 'saveBrowserComment',
            taskId: taskId,
            comment: commentText,
            x: clickCoords.x + '%',
            y: clickCoords.y + '%',
            url: url
        });

        setCommentText('');
        setClickCoords(null);
        setIsCommenting(false);
    };

    return (
        <div className="browser-preview-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
            {/* Toolbar */}
            <div className="browser-toolbar" style={{ display: 'flex', padding: '8px', borderBottom: '1px solid var(--vscode-panel-border)', gap: '8px', alignItems: 'center' }}>
                <input
                    type="text"
                    value={inputUrl}
                    onChange={(e) => setInputUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleNavigate()}
                    style={{ flex: 1, padding: '4px', background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)', border: '1px solid var(--vscode-input-border)' }}
                />
                <button onClick={handleNavigate} style={{ padding: '4px 8px', cursor: 'pointer' }}>Go</button>
                <button
                    onClick={() => {
                        setReloadKey(prev => prev + 1);
                        setUrl(currentUrl => {
                            const cleanUrl = currentUrl.split('?')[0];
                            return `${cleanUrl}?t=${Date.now()}`;
                        });
                    }}
                    style={{ padding: '4px 8px', cursor: 'pointer', marginLeft: '4px' }}
                    title="Force Reload"
                >
                    ↻
                </button>
                <div style={{ width: '1px', height: '20px', background: 'var(--vscode-panel-border)', margin: '0 4px' }}></div>
                <button
                    onClick={() => {
                        setIsCommenting(!isCommenting);
                        setClickCoords(null);
                    }}
                    style={{
                        padding: '4px 8px',
                        cursor: 'pointer',
                        background: isCommenting ? 'var(--vscode-button-background)' : 'transparent',
                        color: isCommenting ? 'var(--vscode-button-foreground)' : 'var(--vscode-foreground)',
                        border: '1px solid var(--vscode-button-border)'
                    }}
                >
                    {isCommenting ? 'Exit Comment Mode' : 'Add Comment'}
                </button>
            </div>

            {/* Browser Frame */}
            <div className="browser-frame-wrapper" style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
                <iframe
                    key={reloadKey}
                    src={url}
                    style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
                    title="Browser Preview"
                />

                {/* Comment Overlay */}
                {isCommenting && (
                    <div
                        className="comment-overlay"
                        onClick={handleOverlayClick}
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: 0,
                            width: '100%',
                            height: '100%',
                            cursor: 'crosshair',
                            background: 'rgba(0, 0, 0, 0.1)', // Slight dim to show active mode
                            zIndex: 10
                        }}
                    >
                        {/* Instruction Tooltip */}
                        <div style={{
                            position: 'absolute',
                            top: '10px',
                            left: '50%',
                            transform: 'translateX(-50%)',
                            background: 'var(--vscode-editor-background)',
                            padding: '4px 12px',
                            borderRadius: '4px',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                            pointerEvents: 'none'
                        }}>
                            Click anywhere to leave a comment
                        </div>
                    </div>
                )}

                {/* Comment Popup */}
                {clickCoords && (
                    <div className="comment-popup" style={{
                        position: 'absolute',
                        left: clickCoords.x + '%',
                        top: clickCoords.y + '%',
                        transform: 'translate(-50%, -100%)', // Anchor above the click
                        background: 'var(--vscode-editor-background)',
                        padding: '8px',
                        border: '1px solid var(--vscode-focusBorder)',
                        borderRadius: '4px',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                        zIndex: 20,
                        minWidth: '250px'
                    }}>
                        <div style={{ marginBottom: '4px', fontSize: '11px', opacity: 0.8 }}>New Comment at {clickCoords.x}%, {clickCoords.y}%</div>
                        <textarea
                            autoFocus
                            value={commentText}
                            onChange={(e) => setCommentText(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    submitComment();
                                }
                            }}
                            placeholder="Type feedback..."
                            style={{
                                width: '100%',
                                height: '60px',
                                marginBottom: '8px',
                                background: 'var(--vscode-input-background)',
                                color: 'var(--vscode-input-foreground)',
                                padding: '4px'
                            }}
                        />
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                            <button onClick={() => setClickCoords(null)} style={{ padding: '2px 8px' }}>Cancel</button>
                            <button onClick={submitComment} style={{ padding: '2px 8px', background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)' }}>Send</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
