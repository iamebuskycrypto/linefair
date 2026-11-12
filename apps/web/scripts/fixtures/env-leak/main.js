// Test fixture only (scripts/bundle-env.test.ts): reproduces the old main.tsx pattern of
// passing the whole env object, which inlines every VITE_* variable. The guard must fail this build.
console.log(JSON.stringify(import.meta.env));
