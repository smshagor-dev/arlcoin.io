// Publishing a research job's files where validators can fetch them over https: a folder in a git
// checkout whose branch is served by a public raw-file host (for example GitHub's
// raw.githubusercontent.com). Each job gets its own folder; the files never change once pushed,
// and the proof binds each one by its SHA-256 anyway.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitPublisherOptions {
  /** A git checkout of the branch that is served publicly; the provider pushes to it. */
  dir: string;
  /** The https URL that serves `dir`'s `jobs/` folder, ending in a slash. */
  jobsUri: string;
  /** Chain id, part of each job's folder name so jobs on two chains never collide. */
  chainId: number;
}

export function gitPublisher(opts: GitPublisherOptions) {
  if (!opts.jobsUri.startsWith("https://") || !opts.jobsUri.endsWith("/")) {
    throw new Error("the jobs URI must be https and end with a slash");
  }
  const folder = (jobId: bigint) => `${String(opts.chainId)}-${jobId.toString()}`;
  return {
    baseUri: (jobId: bigint) => `${opts.jobsUri}${folder(jobId)}/`,
    publish: async (jobId: bigint, files: Record<string, Buffer>): Promise<void> => {
      const rel = join("jobs", folder(jobId));
      await mkdir(join(opts.dir, rel), { recursive: true });
      for (const [name, bytes] of Object.entries(files)) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`unsafe file name: ${name}`);
        await writeFile(join(opts.dir, rel, name), bytes);
      }
      const git = (...args: string[]) => run("git", ["-C", opts.dir, ...args]);
      await git("add", "--", rel);
      await git("commit", "-m", `Research job ${folder(jobId)}`, "--", rel);
      await git("push");
    },
  };
}
