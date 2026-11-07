// Fails when a GitHub workflow job can run in the jakvbs/pi fork although it needs what only earendil-works/pi has:
// its secrets, environments, release tags or package registry. Such jobs fail after every push in the fork, and
// upstream workflows arrive in the fork unreviewed with each rebase onto upstream/main.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Workflows that run in the fork. A workflow that is not listed must skip every job outside earendil-works/pi; a
 * listed one must skip each job that uses a secret other than GITHUB_TOKEN or an environment, which the fork lacks.
 * List a workflow only when its other jobs work in jakvbs/pi.
 */
const forkWorkflows = new Set([
	"approve-contributor.yml",
	"build-binaries.yml",
	"ci.yml",
	"env-daemons.yml",
	"env.yml",
	"issue-analysis.yml",
	"issue-gate.yml",
	"issue-triage-labels.yml",
	"nix.yml",
	"npm-audit.yml",
	"pr-gate.yml",
	"remove-inprogress-on-close.yml",
]);

const guard = "github.repository == 'earendil-works/pi'";
const directory = process.argv[2] ?? ".github/workflows";
const failures = [];

for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
	const { jobs } = parse(readFileSync(join(directory, file), "utf8"));
	for (const [id, job] of Object.entries(jobs)) {
		const needs = forkWorkflows.has(file) ? upstreamResources(job) : ["earendil-works/pi (workflow not in forkWorkflows)"];
		if (needs.length > 0 && !skippedInFork(jobs, id)) failures.push(`${file}: job ${id} needs ${needs.join(", ")}`);
	}
}

if (failures.length > 0) {
	console.error(`These workflow jobs run in the jakvbs/pi fork, where they fail:\n${failures.join("\n")}`);
	console.error(
		`Start each job's if with \`${guard} &&\` (see p2-cloud-bundle.yml). If the job works in the fork, list its workflow in forkWorkflows in scripts/check-fork-workflows.mjs.`,
	);
	process.exit(1);
}

/** The secrets other than GITHUB_TOKEN and the environment that a job uses. */
function upstreamResources(job) {
	const text = JSON.stringify(job);
	const secrets = new Set(text.match(/secrets\.\w+/g)?.filter((secret) => secret !== "secrets.GITHUB_TOKEN"));
	const environment = job.environment ? [`environment ${job.environment.name ?? job.environment}`] : [];
	return [...secrets, ...environment];
}

/** Whether the job's if starts with the guard, or it needs a skipped job and has no status function that runs it then. */
function skippedInFork(jobs, id) {
	const condition = String(jobs[id].if ?? "")
		.replace(/^\s*\$\{\{|\}\}\s*$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (condition === guard || condition.startsWith(`${guard} &&`)) return true;
	if (/\b(always|failure|cancelled)\(\)/.test(condition)) return false;
	const needs = [jobs[id].needs ?? []].flat();
	return needs.some((need) => skippedInFork(jobs, need));
}
