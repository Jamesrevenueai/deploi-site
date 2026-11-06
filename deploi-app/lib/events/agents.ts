/**
 * The modules that register event handlers (onEvent) and loop resumers (registerLoopResumer). The `event.handle`
 * and `loop.resume` jobs import this file before they look a handler up, so a worker that only imported the job
 * queue still finds every pack's handlers. Each pack adds its module here, e.g. `import '../packs/commerce/events'`.
 */
export {}
