# Token Limit Handling - Strategies 2 & 3 (Future Implementation)

> **Status:** Saved for future implementation  
> **Strategy 1 (Differential Edits):** ✅ Implemented and validated on 2500-line codebase  
> **Last Updated:** 2026-01-13

---

## Strategy 2: Recursive Continuation Architecture

### Purpose
Auto-recover when the model response is truncated mid-output (e.g., incomplete code block, JSON cut off). This handles edge cases where even differential edits might exceed the ~4096 token output limit.

### Implementation Details

#### File: `src/ai/CopilotClaudeClient.ts`

**1. Add truncation detection method:**

```typescript
private detectTruncation(text: string): boolean {
    const trimmed = text.trim();
    
    // Check for incomplete JSON (tool calls)
    if (trimmed.includes('```tool_call') && !trimmed.endsWith('```')) {
        return true;
    }
    
    // Check for incomplete code blocks
    const codeBlockStarts = (trimmed.match(/```/g) || []).length;
    if (codeBlockStarts % 2 !== 0) return true;
    
    // Check for incomplete SEARCH/REPLACE
    if (trimmed.includes('<<<<<<< SEARCH') && !trimmed.includes('>>>>>>> REPLACE')) {
        return true;
    }
    
    // Check for mid-word truncation (ends with incomplete word)
    if (/[a-zA-Z]$/.test(trimmed) && !trimmed.endsWith('.')) {
        const lastNewline = trimmed.lastIndexOf('\n');
        const lastLine = trimmed.slice(lastNewline + 1);
        if (lastLine.length < 10 && !/[.!?:}\])"]$/.test(lastLine)) {
            return true;
        }
    }
    
    return false;
}
```

**2. Add continuation logic in `sendMessage`:**

```typescript
// Inside sendMessage, after collecting responseText:

const isTruncated = this.detectTruncation(responseText);

if (isTruncated) {
    console.log('[CopilotClaudeClient] Truncation detected, continuing...');
    
    // Inject partial response as assistant message
    messages.push(vscode.LanguageModelChatMessage.Assistant(responseText));
    messages.push(vscode.LanguageModelChatMessage.User("Continue exactly where you left off. Do not repeat."));
    
    // Recursively get continuation (with loop limit)
    const continuation = await this.continueGeneration(model, messages, token, 0);
    responseText = this.stitchResponses(responseText, continuation);
}
```

**3. Add response stitching:**

```typescript
private stitchResponses(first: string, continuation: string): string {
    // Remove any "continuation filler" from the start
    const fillerPatterns = [
        /^(Here is the rest|Continuing|I'll continue|Resuming|\.\.\.)/i,
        /^```\w*\n/ // Remove duplicate code fence
    ];
    
    let cleaned = continuation;
    for (const pattern of fillerPatterns) {
        cleaned = cleaned.replace(pattern, '');
    }
    
    return first + cleaned;
}

private async continueGeneration(
    model: vscode.LanguageModelChat,
    messages: vscode.LanguageModelChatMessage[],
    token: vscode.CancellationToken,
    depth: number
): Promise<string> {
    if (depth >= 5) {
        console.warn('[CopilotClaudeClient] Max continuation depth reached');
        return '';
    }
    
    const response = await model.sendRequest(messages, {}, token);
    let text = '';
    for await (const fragment of response.text) {
        text += fragment;
    }
    
    if (this.detectTruncation(text)) {
        messages.push(vscode.LanguageModelChatMessage.Assistant(text));
        messages.push(vscode.LanguageModelChatMessage.User("Continue."));
        const more = await this.continueGeneration(model, messages, token, depth + 1);
        return this.stitchResponses(text, more);
    }
    
    return text;
}
```

---

## Strategy 3: Token Budget Management

### Purpose
Proactively prevent input token overflow on very long sessions by:
1. Estimating token usage before sending requests
2. Pruning old message history when approaching limits
3. Tracking rate limits (8k OTPM for Copilot Claude)

### Implementation Details

#### New File: `src/utils/TokenBudget.ts`

```typescript
/**
 * Token counting and budget management for vscode.lm API
 * Based on Claude's ~0.25 tokens per character heuristic (4 chars ≈ 1 token)
 */

export class TokenBudget {
    private readonly MAX_INPUT_TOKENS = 100000; // Conservative for Copilot
    private readonly MAX_OUTPUT_TOKENS = 4096;  // Typical vscode.lm limit
    private readonly SAFETY_MARGIN = 0.8;       // Use 80% of limit
    
    /**
     * Estimate token count for text (rough approximation)
     */
    estimateTokens(text: string): number {
        // ~4 characters per token for English text/code
        return Math.ceil(text.length / 4);
    }
    
    /**
     * Check if messages are within input budget
     */
    isWithinBudget(messages: { content: string }[]): boolean {
        const totalTokens = messages.reduce(
            (sum, m) => sum + this.estimateTokens(m.content || ''), 
            0
        );
        return totalTokens < this.MAX_INPUT_TOKENS * this.SAFETY_MARGIN;
    }
    
    /**
     * Get current usage percentage
     */
    getUsagePercentage(messages: { content: string }[]): number {
        const totalTokens = messages.reduce(
            (sum, m) => sum + this.estimateTokens(m.content || ''), 
            0
        );
        return (totalTokens / this.MAX_INPUT_TOKENS) * 100;
    }
}
```

#### Modify: `src/ai/CopilotClaudeClient.ts`

**Add context pruning before sending:**

```typescript
import { TokenBudget } from '../utils/TokenBudget';

// In sendMessage, before the model.sendRequest call:

const tokenBudget = new TokenBudget();
const usage = tokenBudget.getUsagePercentage(
    messages.map(m => ({ content: m.content || '' }))
);

if (usage > 80) {
    console.warn(`[CopilotClaudeClient] Token budget at ${usage.toFixed(1)}%, pruning...`);
    messages = this.pruneMessageHistory(messages);
}

// Add the pruning method:
private pruneMessageHistory(
    messages: vscode.LanguageModelChatMessage[]
): vscode.LanguageModelChatMessage[] {
    // Keep: System prompt (first message) + last 10 messages
    if (messages.length <= 11) return messages;
    
    const systemPrompt = messages[0];
    const recentMessages = messages.slice(-10);
    
    // Insert summary of pruned content
    const prunedSummary = vscode.LanguageModelChatMessage.User(
        "[Context Note: Earlier conversation history was pruned to fit token budget. " +
        "The mission objective and recent tool results are preserved.]"
    );
    
    console.log(`[CopilotClaudeClient] Pruned ${messages.length - 11} messages`);
    return [systemPrompt, prunedSummary, ...recentMessages];
}
```

---

## Testing Checklist (When Implementing)

### Strategy 2 Tests:
- [ ] Trigger truncation by requesting very long code generation
- [ ] Verify continuation stitches cleanly (no duplicate code fences)
- [ ] Test max depth limit (5 continuations)
- [ ] Verify tool calls parse correctly across continuation boundaries

### Strategy 3 Tests:
- [ ] Run a very long session (50+ tool calls)
- [ ] Verify pruning triggers around 80% usage
- [ ] Verify system prompt is always preserved
- [ ] Verify agent still functions after pruning

---

## Priority Notes

| Strategy | When Needed | Risk if Skipped |
|----------|-------------|-----------------|
| 1 (Differential Edits) | ✅ Always - most token savings | High - frequent failures |
| 2 (Recursive Continuation) | Edge cases - very large single outputs | Medium - occasional truncation |
| 3 (Token Budget) | Long sessions - many tool calls | Low - session restart works |

**Recommendation:** Test Strategy 1 thoroughly first. If you encounter:
- Truncated outputs → Implement Strategy 2
- "Input token exceeded" on long sessions → Implement Strategy 3
