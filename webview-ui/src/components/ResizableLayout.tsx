import React, { useState, useEffect, useRef } from 'react';
import '../App.css';

interface ResizableLayoutProps {
    left: React.ReactNode;
    center: React.ReactNode;
    right: React.ReactNode;
}

export const ResizableLayout: React.FC<ResizableLayoutProps> = ({ left, center, right }) => {
    // Initial widths in percentage
    const [leftWidth, setLeftWidth] = useState(20);
    const [rightWidth, setRightWidth] = useState(25);
    const containerRef = useRef<HTMLDivElement>(null);
    const isDraggingLeft = useRef(false);
    const isDraggingRight = useRef(false);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!containerRef.current) return;

            const containerRect = containerRef.current.getBoundingClientRect();
            const containerWidth = containerRect.width;
            const mouseX = e.clientX - containerRect.left; // Relative to container

            if (isDraggingLeft.current) {
                // Calculate new left width percentage
                let newLeftWidth = (mouseX / containerWidth) * 100;

                // Constraints - allow very small minimums (2%)
                if (newLeftWidth < 2) newLeftWidth = 2; // Min 2%
                if (newLeftWidth > 40) newLeftWidth = 40; // Max 40% (prevent crushing center)

                setLeftWidth(newLeftWidth);
            }

            if (isDraggingRight.current) {
                // Calculate new right width percentage (from right edge)
                // mouseX is position from left. Distance from right is containerWidth - mouseX
                const widthFromRightPx = containerWidth - mouseX;
                let newRightWidth = (widthFromRightPx / containerWidth) * 100;

                // Constraints - allow very small minimums (2%)
                if (newRightWidth < 2) newRightWidth = 2; // Min 2%
                if (newRightWidth > 90) newRightWidth = 90; // Max 90% (increased for better diff review)

                setRightWidth(newRightWidth);
            }
        };

        const handleMouseUp = () => {
            isDraggingLeft.current = false;
            isDraggingRight.current = false;
            document.body.style.cursor = 'default';
        };



        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        return () => {
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };
    }, []);

    const startResizeLeft = () => {
        isDraggingLeft.current = true;
        document.body.style.cursor = 'col-resize';
    };

    const startResizeRight = () => {
        isDraggingRight.current = true;
        document.body.style.cursor = 'col-resize';
    };

    return (
        <div className="resizable-container" ref={containerRef}>
            <div className="pane-left" style={{ width: `${leftWidth}%` }}>
                {left}
            </div>

            <div className="resizer-handle" onMouseDown={startResizeLeft}>
                <div className="resizer-line"></div>
            </div>

            <div className="pane-center" style={{ flex: 1 }}>
                {center}
            </div>

            <div className="resizer-handle" onMouseDown={startResizeRight}>
                <div className="resizer-line"></div>
            </div>

            <div className="pane-right" style={{ width: `${rightWidth}%` }}>
                {right}
            </div>
        </div>
    );
};
