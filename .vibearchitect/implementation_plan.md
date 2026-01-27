# Implementation Plan: Reading Pane Width Expansion

## Current State Analysis

The `ResizableLayout.tsx` component defines a three-panel layout with JavaScript constraints:

### Left Panel (Conversation):
- Initial: 20%
- Min: 10%
- Max: 40%

### Right Panel (Reading/Preview Pane):
- Initial: 25%
- Min: 15%
- Max: 75%

### Center Panel (Diff Logger):
- Uses `flex: 1` (takes remaining space)

## Target State

To achieve 90% reading pane width:
- Change left panel min from 10% to 5%
- Change right panel min from 15% to 5%
- Change right panel max from 75% to 90%

## Technical Changes

### File: `webview-ui/src/components/ResizableLayout.tsx`

1. Left panel constraints (line ~30-31):
   - Change `if (newLeftWidth < 10)` → `if (newLeftWidth < 5)`

2. Right panel constraints (line ~40-41):
   - Change `if (newRightWidth < 15)` → `if (newRightWidth < 5)`
   - Change `if (newRightWidth > 75)` → `if (newRightWidth > 90)`

## Risk Assessment

- **Low Risk**: Only modifying resize constraints
- **Impact**: Users can now drag dividers to make reading pane 90% wide
- **Backward Compatible**: Initial widths remain unchanged (20%/flex/25%)
