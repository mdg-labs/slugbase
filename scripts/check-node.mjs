const REQUIRED_MAJOR = 24;
const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

if (major !== REQUIRED_MAJOR) {
  process.stderr.write(
    `SlugBase requires Node.js ${REQUIRED_MAJOR}.x, but this is Node.js ${process.versions.node}.\n` +
      `Install Node.js ${REQUIRED_MAJOR} (the version in .nvmrc, for example with "nvm use") and run the command again.\n`,
  );
  process.exit(1);
}
