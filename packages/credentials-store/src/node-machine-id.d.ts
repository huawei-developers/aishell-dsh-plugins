/**
 * Ambient type for node-machine-id — the package ships a `declare module` in
 * types/index.d.ts without a default export, but our code uses a CJS default
 * import (enabled by esModuleInterop). This ambient declaration covers both
 * the default-import namespace shape and the named exports.
 */
declare module 'node-machine-id' {
  export function machineIdSync(original?: boolean): string
  export function machineId(original?: boolean): Promise<string>
  const _default: { machineIdSync: typeof machineIdSync; machineId: typeof machineId }
  export default _default
}
