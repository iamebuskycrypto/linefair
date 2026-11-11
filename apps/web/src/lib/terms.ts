// Single import point for the shared TypeScript canonical terms encoder
// (packages/shared-schemas). Relative path so that Vite, tsc and the Node
// test runner resolve it identically, with no alias configuration.
export * from "../../../../packages/shared-schemas/ts/src/index.ts";
