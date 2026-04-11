import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function run(command, args, cwd) {
  await execFileAsync(command, args, {
    cwd,
    env: process.env,
  });
}

export async function prepare(pluginConfig, context) {
  const { cwd, nextRelease, logger } = context;
  const tarballDir = path.resolve(cwd, pluginConfig.tarballDir || "release-artifacts");

  logger.log("Writing version %s to package.json", nextRelease.version);
  await run("npm", ["version", nextRelease.version, "--no-git-tag-version", "--allow-same-version"], cwd);

  logger.log("Packing npm tarball into %s", tarballDir);
  await mkdir(tarballDir, { recursive: true });
  await run("yarn", ["pack", "--filename", path.join(tarballDir, "package.tgz")], cwd);
}
