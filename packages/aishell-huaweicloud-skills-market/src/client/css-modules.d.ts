/**
 * The client bundle's CSS-module contract.
 *
 * `shared/tsdown.client.ts` compiles every `*.module.css` import into a class map
 * and injects the compiled text as one style tag owned by this plugin, so the
 * loader removes the styles with the plugin. TypeScript has no built-in notion of
 * that, and without this declaration the import below does not typecheck. Same
 * shape as `aishell-brand`'s declaration, one directory over.
 */
declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}