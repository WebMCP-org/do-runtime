---
"@cloudflare/shell": patch
---

The `state` declarations in `STATE_TYPES` now type `readJson` and `queryJson`
as `<T = any>(...) => Promise<T>`. Model-written code such as
`const data = await state.readJson({ path }); data.items` passes TypeScript
preflight without a cast; callers can still pass a type argument for a precise
shape. Previously both returned `Promise<unknown>`, so every property access
failed until the code cast to `any`.
