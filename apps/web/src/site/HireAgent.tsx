"use client";

import { useState } from "react";

import { ARL_AGENT, hireLink, hireSpec } from "@/content/hire.ts";
import { withBase } from "@/core/basePath.ts";

const field =
  "h-11 rounded-[12px] border border-line bg-transparent px-3 font-mono text-[14px] text-fg";
const label = "flex flex-col gap-2 text-[14px] text-fg-muted";
const pill =
  "glass-pill inline-flex h-11 items-center rounded-full px-6 text-[15px] font-semibold text-fg";
const step = "glass flex flex-col gap-4 rounded-[22px] p-6";

/**
 * The three steps of hiring the agent: describe the run (the spec is built here, in the browser),
 * publish the spec, and open the job in the app with the form already filled. Nothing is sent
 * from this page; the job is opened and paid in the app, from the wallet of the visitor.
 */
export function HireAgent() {
  const [repository, setRepository] = useState("");
  const [commit, setCommit] = useState("");
  const [directory, setDirectory] = useState("");
  const [specUrl, setSpecUrl] = useState("");
  const [copied, setCopied] = useState(false);

  const started = repository.trim() !== "" || commit.trim() !== "";
  const built = hireSpec({ repository, commit, directory });
  const jobLink = hireLink(specUrl);

  function copy(text: string) {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
      },
      () => {
        setCopied(false);
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className={step} aria-labelledby="hire-describe">
        <h2 id="hire-describe" className="text-[15px] font-extrabold">
          1. Describe the run
        </h2>
        <label className={label}>
          Repository (the https link you clone it from)
          <input
            className={field}
            value={repository}
            onChange={(e) => {
              setRepository(e.target.value);
              setCopied(false);
            }}
            placeholder="https://github.com/you/project"
            autoComplete="off"
            spellCheck={false}
            data-testid="hire-repository"
          />
        </label>
        <label className={label}>
          Commit (the full id)
          <input
            className={field}
            value={commit}
            onChange={(e) => {
              setCommit(e.target.value);
              setCopied(false);
            }}
            placeholder="40 characters"
            autoComplete="off"
            spellCheck={false}
            data-testid="hire-commit"
          />
        </label>
        <label className={label}>
          Directory with the tests (optional; the repository root when empty)
          <input
            className={field}
            value={directory}
            onChange={(e) => {
              setDirectory(e.target.value);
              setCopied(false);
            }}
            placeholder="packages/api"
            autoComplete="off"
            spellCheck={false}
            data-testid="hire-directory"
          />
        </label>
        {started && !built.ok && (
          <p role="status" className="text-[14px] text-fg-muted" data-testid="hire-problem">
            {built.error}
          </p>
        )}
        {built.ok && (
          <div className="flex flex-col gap-3">
            <p className="text-[14px] leading-[1.6] text-fg-muted">
              This is the job, exactly as the agent and the validators will run it. Its hash is
              recorded on Base when you open the job:
            </p>
            <p
              className="font-mono text-[12px] [overflow-wrap:anywhere] text-fg"
              data-testid="hire-hash"
            >
              {built.hash}
            </p>
            <pre
              className="max-h-[320px] overflow-auto rounded-[12px] border border-line p-4 font-mono text-[12px] leading-[1.5] text-fg-muted"
              data-testid="hire-spec"
            >
              {built.json}
            </pre>
            <div className="flex flex-wrap items-center gap-3">
              <a
                className={pill}
                href={`data:application/json;charset=utf-8,${encodeURIComponent(built.json)}`}
                download="spec.json"
              >
                Download spec.json
              </a>
              <button
                type="button"
                className={pill}
                onClick={() => {
                  copy(built.json);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </section>

      <section className={step} aria-labelledby="hire-publish">
        <h2 id="hire-publish" className="text-[15px] font-extrabold">
          2. Publish the spec
        </h2>
        <p className="text-[14px] leading-[1.6] text-fg-muted">
          Save the file anywhere it can be read over https, for example in your repository or in a
          gist, and paste the link to the raw file. The job records the hash of the spec, so a file
          that is changed afterwards is refused by the validators.
        </p>
        <label className={label}>
          Link to the spec file
          <input
            className={field}
            value={specUrl}
            onChange={(e) => {
              setSpecUrl(e.target.value);
            }}
            placeholder="https://…/spec.json"
            autoComplete="off"
            spellCheck={false}
            data-testid="hire-spec-url"
          />
        </label>
      </section>

      <section className={step} aria-labelledby="hire-open">
        <h2 id="hire-open" className="text-[15px] font-extrabold">
          3. Open the job
        </h2>
        <p className="text-[14px] leading-[1.6] text-fg-muted">
          The app opens with the job filled in: the spec, {ARL_AGENT.name} as the provider and a
          budget of {ARL_AGENT.minBudget} ARL. You connect a wallet on Base, review it and confirm.
          The agent then approves the committee, runs the tests and submits the result; the
          validators re-run them and vote.
        </p>
        <div>
          {jobLink ? (
            <a className={pill} href={withBase(jobLink)} data-testid="hire-open-link">
              Open the job in the app
            </a>
          ) : (
            <span
              className={`${pill} opacity-50`}
              aria-disabled="true"
              data-testid="hire-open-waiting"
            >
              Paste the spec link first
            </span>
          )}
        </div>
      </section>
    </div>
  );
}
