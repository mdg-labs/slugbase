import { isSupportedNode, REQUIRED_MAJOR, REQUIRED_RANGE } from "./node-version.mjs";

if (!isSupportedNode(process.versions.node)) {
  process.stderr.write(
    `SlugBase requires Node.js ${REQUIRED_RANGE}, but this is Node.js ${process.versions.node}.\n` +
      `Install Node.js ${REQUIRED_MAJOR} (the version in .nvmrc, for example with "nvm use") and run the command again.\n`,
  );
  process.exit(1);
}
