# Web app

The browser editor, MazeBench renderer assets, Cloudflare worker entry point,
and web-specific tests live here. Turn physics is not implemented in this app;
`app/physicsEngine.ts` only marshals data to the WebAssembly build produced from
the shared C++ engine in `../../engine`.
