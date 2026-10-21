---
"sqlite-wasm-miniprogram": patch
---

Bundle `TextEncoder` / `TextDecoder` for real devices. The glue converts strings to and from wasm memory with them, and mini programs and mini games on devices have neither (WeChat DevTools does, which is why 0.1.0 only failed on devices: "Exception loading sqlite3 module: TextDecoder is not defined"). They are injected at bundle time like the other shims, use the native implementations when present, and fall back to a pure-JS UTF-8 codec that decodes exactly like `TextDecoder` (invalid sequences included). Verified on an Android device.
