// Builds the npm packages into release/<dir>, after `pnpm build` and `pnpm build:web`. Each package
// bundles its apps together with the workspace packages they import, since those are not
// published, and keeps every other import external: those become the package's dependencies, at
// the exact versions the workspace pins. release/manifest.json lists what was built.
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "../..");
const release = path.join(root, "release");
const { STELLARIS_VERSION } = await import(
  pathToFileURL(path.join(root, "packages/shared/dist/index.js")).href
);

const common = {
  version: STELLARIS_VERSION,
  license: "MIT",
  homepage: "https://github.com/kr4t0n/stellaris",
  repository: { type: "git", url: "git+https://github.com/kr4t0n/stellaris.git" },
  bugs: "https://github.com/kr4t0n/stellaris/issues",
  type: "module",
  engines: { node: ">=24" },
  publishConfig: { access: "public" },
};

const PACKAGES = [
  {
    dir: "stellaris",
    name: "@kubitnodes/stellaris",
    description:
      "A society of autonomous CLI agents on one shared board: the admin CLI and the board server with its interface",
    keywords: ["stellaris", "agents", "claude-code", "codex", "multi-agent"],
    // The server looks for the interface at ../../web/dist from its own file, so its bundle sits two
    // levels down and the interface at web/dist, as in the repository.
    entries: [
      { app: "apps/cli", out: "dist/cli/index.js", bin: "stellaris" },
      { app: "apps/server", out: "dist/server/index.js", bin: "stellaris-server" },
    ],
    web: true,
  },
  {
    dir: "stellaris-runner",
    name: "@kubitnodes/stellaris-runner",
    description:
      "The Stellaris runner: runs a society's turns with Claude Code and Codex on the machine it is started on",
    keywords: ["stellaris", "agents", "claude-code", "codex", "runner"],
    entries: [{ app: "apps/runner", out: "dist/index.js", bin: "stellaris-runner" }],
    web: false,
  },
];

/** Every dependency a workspace package declares, by name, at its pinned version. */
async function workspaceDependencies() {
  const versions = new Map();
  const workspaceNames = new Set();
  for (const group of ["apps", "packages"]) {
    for (const entry of await readdir(path.join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const manifest = JSON.parse(
        await readFile(path.join(root, group, entry.name, "package.json"), "utf8"),
      );
      workspaceNames.add(manifest.name);
      for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
        if (version.startsWith("workspace:")) {
          continue;
        }
        const known = versions.get(name);
        if (known !== undefined && known !== version) {
          throw new Error(`${name} is pinned at both ${known} and ${version} in the workspace`);
        }
        versions.set(name, version);
      }
    }
  }
  return { versions, workspaceNames };
}

/** The package an import names: `@scope/name/sub` is `@scope/name`, `name/sub` is `name`. */
function packageOf(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const { versions, workspaceNames } = await workspaceDependencies();

/** Bundles the workspace's own packages and leaves everything else to npm. */
const keepExternal = {
  name: "keep-external",
  setup(bundler) {
    bundler.onResolve({ filter: /^[^./]/ }, (args) =>
      workspaceNames.has(packageOf(args.path)) ? undefined : { path: args.path, external: true },
    );
  },
};

await rm(release, { recursive: true, force: true });
const manifest = [];
for (const pkg of PACKAGES) {
  const out = path.join(release, pkg.dir);
  const imported = new Set();
  for (const entry of pkg.entries) {
    const result = await build({
      entryPoints: [path.join(root, entry.app, "dist/index.js")],
      outfile: path.join(out, entry.out),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      plugins: [keepExternal],
      metafile: true,
      logLevel: "warning",
    });
    for (const output of Object.values(result.metafile.outputs)) {
      for (const used of output.imports) {
        if (used.external && !isBuiltin(used.path)) {
          imported.add(packageOf(used.path));
        }
      }
    }
  }
  const dependencies = {};
  for (const name of [...imported].toSorted((a, b) => a.localeCompare(b))) {
    const version = versions.get(name);
    if (version === undefined) {
      throw new Error(`${pkg.name} imports ${name}, which no workspace package depends on`);
    }
    dependencies[name] = version;
  }
  if (pkg.web) {
    await cp(path.join(root, "apps/web/dist"), path.join(out, "web/dist"), { recursive: true });
  }
  await cp(path.join(import.meta.dirname, `${pkg.dir}.md`), path.join(out, "README.md"));
  await cp(path.join(root, "LICENSE"), path.join(out, "LICENSE"));
  await writeFile(
    path.join(out, "package.json"),
    `${JSON.stringify(
      {
        name: pkg.name,
        description: pkg.description,
        keywords: pkg.keywords,
        ...common,
        bin: Object.fromEntries(pkg.entries.map((entry) => [entry.bin, entry.out])),
        files: ["dist", ...(pkg.web ? ["web"] : [])],
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  manifest.push({ name: pkg.name, version: STELLARIS_VERSION, dir: pkg.dir });
  console.log(`${pkg.name}@${STELLARIS_VERSION} in release/${pkg.dir}`);
}
await mkdir(release, { recursive: true });
await writeFile(path.join(release, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
