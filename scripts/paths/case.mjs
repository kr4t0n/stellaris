// Names that Linux keeps apart and a Mac's disk takes as one. macOS's default disk ignores case and
// Unicode normalization, so a checkout there holds one file where git holds two, and a module beside
// another whose name differs only in case is read in its place: TypeScript tries `.ts` before
// `.tsx`, so `./Quota.js` beside `quota.ts` reads `quota.ts`. check-case.mjs runs this over the
// files git knows.

/** What a module's import may change or leave out: TypeScript reads `./x.js` as `x.ts` or `x.tsx`. */
const MODULE_EXTENSION = /\.(?:d\.)?(?:[cm]?[jt]s|[jt]sx)$/u;

/** A module's path without its extension. */
function stem(file) {
  return file.replace(MODULE_EXTENSION, "");
}

/** A name as a disk that ignores case and normalization compares it. */
function folded(name) {
  return name.normalize("NFC").toLowerCase();
}

/** Each group of more than one name to which `keyOf` gives the same key. */
function grouped(names, keyOf) {
  const groups = new Map();
  for (const name of names) {
    const key = keyOf(name);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [name]);
    else group.push(name);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * The clashes among `files`, paths from the repository's root: `path` for files or folders whose
 * paths differ only in case or normalization, and `module` for modules in one folder whose names,
 * the extension left out, do, as `Quota.tsx` and `quota.ts`.
 */
export function caseClashes(files) {
  const paths = new Set();
  for (const file of files) {
    const parts = file.split("/");
    for (let end = 1; end <= parts.length; end++) paths.add(parts.slice(0, end).join("/"));
  }
  // Modules alike to the stem, as `x.js` and `x.d.ts`, are alike on every disk, and modules whose
  // whole paths clash are reported once, as a path clash.
  const modules = grouped(
    files.filter((file) => MODULE_EXTENSION.test(file)),
    (file) => folded(stem(file)),
  ).filter((group) => new Set(group.map(stem)).size > 1 && new Set(group.map(folded)).size > 1);
  return [
    ...grouped(paths, folded).map((names) => ({ kind: "path", names: names.toSorted() })),
    ...modules.map((names) => ({ kind: "module", names: names.toSorted() })),
  ];
}
