// Under `bun test` the UI suites register a Bun bundler plugin to emulate the
// asset transforms Vite performs (`?worker&url`, eager `import.meta.glob`).
// Under Vitest, Vite performs those transforms itself, so the plugin is a no-op
// and `gc` (Bun's explicit garbage collector) has no Node equivalent.
export type BunPluginDefinition = {
  name: string;
  setup: (build: {
    onLoad: (options: { filter: RegExp }, callback: (args: { path: string }) => void) => void;
  }) => void;
};

export const plugin = (_definition: BunPluginDefinition): void => undefined;

export const gc = (): void => undefined;
