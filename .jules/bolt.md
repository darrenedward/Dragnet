## 2025-05-14 - [Quadratic Complexity in Graph Resolution]
**Learning:** Found an $O(C \times S)$ bottleneck in `resolveCallsToEdges` where every call site ($C$) triggered a full scan of the symbol lookup table ($S$) to find method/suffix matches. This scales poorly as the codebase grows.
**Action:** In graph construction or symbol resolution logic, avoid `Object.keys().filter()` or similar linear scans inside loops. Pre-calculate suffix or fuzzy match indices into `Map` objects to maintain $O(S + C)$ complexity.
