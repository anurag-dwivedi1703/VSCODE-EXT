import React, { useState, useEffect, useRef } from 'react';
import './TypewriterText.css';

interface TypewriterTextProps {
    text: string;
    speed?: number; // milliseconds per character
    onComplete?: () => void;
    isActive?: boolean; // Only animate if active
    className?: string;
}

/**
 * TypewriterText - Reveals text character by character with a typing animation.
 * 
 * Features:
 * - Configurable typing speed
 * - Blinking cursor during typing
 * - Smart chunking for better performance (processes multiple chars at once)
 * - Callback when typing completes
 * - Only animates when isActive is true
 */
export const TypewriterText: React.FC<TypewriterTextProps> = ({ 
    text, 
    speed = 12, 
    onComplete, 
    isActive = true,
    className = ''
}) => {
    const [displayedText, setDisplayedText] = useState('');
    const [isTyping, setIsTyping] = useState(false);
    const previousTextRef = useRef('');
    
    useEffect(() => {
        // If not active or text is empty, show full text immediately
        if (!isActive || !text) {
            setDisplayedText(text);
            setIsTyping(false);
            return;
        }

        // Check if this is new text or an update to existing text
        const isNewText = !text.startsWith(previousTextRef.current);
        const startIndex = isNewText ? 0 : previousTextRef.current.length;
        
        // If no new characters to type, we're done
        if (startIndex >= text.length) {
            setDisplayedText(text);
            setIsTyping(false);
            previousTextRef.current = text;
            return;
        }

        setIsTyping(true);
        
        // Start from either the beginning (new text) or where we left off (appended text)
        let currentIndex = startIndex;
        if (isNewText) {
            setDisplayedText('');
        }

        const timer = setInterval(() => {
            if (currentIndex < text.length) {
                // Process characters in small chunks for smoother appearance
                // but still character-by-character feel
                const chunkSize = Math.min(2, text.length - currentIndex);
                currentIndex += chunkSize;
                setDisplayedText(text.slice(0, currentIndex));
            } else {
                clearInterval(timer);
                setIsTyping(false);
                previousTextRef.current = text;
                onComplete?.();
            }
        }, speed);

        return () => clearInterval(timer);
    }, [text, speed, isActive, onComplete]);

    // Reset when text changes completely
    useEffect(() => {
        if (text && !text.startsWith(previousTextRef.current.slice(0, 20))) {
            previousTextRef.current = '';
        }
    }, [text]);

    return (
        <span className={`typewriter-text ${className}`}>
            {displayedText}
            {isTyping && <span className="typewriter-cursor">|</span>}
        </span>
    );
};

export default TypewriterText;
