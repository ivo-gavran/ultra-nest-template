// The direct Commitlint packages do not export UserConfig; type the used field
// without depending on a transitive package or adding a tooling dependency.
const config = {
  extends: ['@commitlint/config-conventional'],
} satisfies { extends: string[] };

export default config;
