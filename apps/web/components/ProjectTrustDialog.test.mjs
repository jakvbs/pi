import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const {
  ProjectTrustDialog,
  ProjectTrustDialogView,
  ProjectTrustStatusSection,
  projectTrustStatusFrom,
} = await jiti.import("./ProjectTrustDialog.tsx");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const source = await readFile(new URL("./ProjectTrustDialog.tsx", import.meta.url), "utf8");
const apiTypesSource = await readFile(new URL("../lib/api-types.ts", import.meta.url), "utf8");
const settingsCss = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");

const h = React.createElement;
const messages = enLocale.messages;

function render(element) {
  return renderToStaticMarkup(h(I18nProvider, null, element));
}

function decode(html) {
  return html.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** The text of the markup, tags dropped, entities decoded. */
function text(html) {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

const untrusted = { requiresTrust: true, trusted: false, decision: null, inherited: false };

function loaded(status = untrusted) {
  return { state: "loaded", status };
}

function view(props) {
  return render(h(ProjectTrustDialogView, {
    cwd: "/repo",
    busy: false,
    error: null,
    trust: loaded(),
    onCancel() {},
    onConfirm() {},
    ...props,
  }));
}

test("while the status loads it says so, and Trust waits for it", () => {
  const html = render(h(ProjectTrustDialog, { cwd: "/repo", busy: false, error: null, onCancel() {}, onConfirm() {} }));
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="project-trust-title" aria-describedby="project-trust-description" tabindex="-1" class="project-trust-dialog"/);
  assert.match(html, /<p id="project-trust-status" role="status" class="project-trust-status">Reading this project&#x27;s trust…<\/p>/);
  assert.match(html, /<button type="button" class="project-trust-button is-primary" disabled="" aria-describedby="project-trust-status">Trust project<\/button>/);
  assert.match(html, /<button type="button" class="project-trust-button">Cancel<\/button>/);
  assert.match(html, /<code class="project-trust-path">\/repo<\/code>/);
  // Padding and layout live in CSS, so the safe-area rules and the scrolling body apply.
  assert.doesNotMatch(html, /style="/);
});

test("hidden characters in the folder's path are shown escaped", () => {
  const html = view({ cwd: "/repo/\u202Esj.revres/a\u200Bb" });
  assert.ok(!/[\u202E\u200B]/.test(html), "no override or zero-width space reaches the markup");
  assert.match(html, /<code class="project-trust-path">\/repo\/\\u\{202E\}sj\.revres\/a\\u\{200B\}b<\/code>/);
});

test("the trust error stays outside the scrolling body, translated from its reason", () => {
  const busy = render(h(ProjectTrustDialog, {
    cwd: "/repo",
    busy: true,
    error: { error: "Wait for the active session to finish before trusting this project", reason: "session-busy" },
    onCancel() {},
    onConfirm() {},
  }));
  assert.match(
    busy,
    /<\/div><\/div><div role="alert" class="project-trust-error">Wait for the running session in this folder to finish, then trust the project\.<\/div><div class="project-trust-footer">/,
  );
  assert.match(busy, /disabled="" aria-busy="true" aria-describedby="project-trust-status">Trusting\.\.\.<\/button>/);

  // An internal or network failure has nothing to translate: its diagnostic follows a generic line.
  const internal = view({ error: { error: "Lock file is already being held", reason: "internal" } });
  assert.match(internal, /<div role="alert" class="project-trust-error">Could not trust this project\.<code class="project-trust-error-detail">Lock file is already being held<\/code><\/div>/);
  const network = view({ error: { error: "Failed to fetch" } });
  assert.match(network, /Could not trust this project\.<code class="project-trust-error-detail">Failed to fetch<\/code>/);
});

test("a folder trusted meanwhile, or no longer needing trust, is not offered Trust", () => {
  const trusted = view({ trust: loaded({ ...untrusted, trusted: true, decision: true, decisionPath: "/", inherited: true }) });
  assert.match(trusted, /<p id="project-trust-notice" role="status" class="project-trust-notice">This project is already trusted\.<\/p>/);
  assert.doesNotMatch(trusted, /Trust project/);
  assert.match(trusted, /<button type="button" class="project-trust-button">Close<\/button>/);

  const fresh = view({ trust: loaded({ requiresTrust: false, trusted: true, decision: null, inherited: false }) });
  assert.match(fresh, /This project has no resources that need trust anymore\./);
  assert.doesNotMatch(fresh, /Trust project/);

  const open = view({});
  assert.match(open, /<button type="button" class="project-trust-button is-primary">Trust project<\/button>/);
  assert.doesNotMatch(open, /project-trust-notice/);
});

test("a trust store that cannot be read is said so, and Trust stays offered", () => {
  const html = view({ trust: { state: "failed", error: "Lock file is already being held", reason: "trust-unreadable" } });
  assert.match(
    text(html),
    /Could not read this project's trust\. Pi Web cannot read the trust store \(trust\.json\), or another program has it locked\./,
  );
  assert.match(html, /class="project-trust-button is-primary">Trust project<\/button>/);
});

test("a GET answer becomes a status, or the reason it carries none", () => {
  assert.deepEqual(projectTrustStatusFrom(true, 200, { ...untrusted, decisionPath: "/repo" }), {
    state: "loaded",
    status: { ...untrusted, decisionPath: "/repo" },
  });
  assert.deepEqual(projectTrustStatusFrom(false, 500, { error: "locked", reason: "trust-unreadable" }), {
    state: "failed",
    error: "locked",
    reason: "trust-unreadable",
  });
  assert.deepEqual(projectTrustStatusFrom(false, 403, { error: "Access denied", reason: "cwd-denied" }), {
    state: "failed",
    error: "Access denied",
    reason: "cwd-denied",
  });
  assert.deepEqual(projectTrustStatusFrom(false, 502, {}), { state: "failed", error: "HTTP 502", reason: undefined });
});

test("a status that failed names why, or gives its diagnostic when there is nothing to translate", () => {
  assert.equal(
    text(render(h(ProjectTrustStatusSection, { trust: { state: "failed", error: "Access denied", reason: "cwd-denied" } }))),
    "Could not read this project's trust. Pi Web may not read this folder.",
  );
  assert.equal(
    text(render(h(ProjectTrustStatusSection, { trust: { state: "failed", error: "trust.json is locked", reason: "internal" } }))),
    "Could not read this project's trust. trust.json is locked",
  );
  assert.equal(
    text(render(h(ProjectTrustStatusSection, { trust: { state: "failed", timedOut: true } }))),
    "Reading this project's trust took too long.",
  );
  assert.equal(render(h(ProjectTrustStatusSection, { trust: loaded() })), "");
});

test("every string the dialog shows is translated", () => {
  const literalKeys = [...source.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]);
  const ternaryKeys = [...source.matchAll(/\? "([a-z]+\.[\w.-]+)" : "([a-z]+\.[\w.-]+)"/g)].flatMap((match) => [match[1], match[2]]);
  const returnedKeys = [...source.matchAll(/return "([a-z]+\.[\w.-]+)";/g)].map((match) => match[1]);
  const reasonCodes = [...apiTypesSource.slice(
    apiTypesSource.indexOf("export type RouteRefusalReason"),
    apiTypesSource.indexOf("export interface RouteErrorResponse"),
  ).matchAll(/\| "([a-z-]+)"/g)].map((match) => match[1]).filter((code) => code !== "internal");
  // Every reason but `internal`, whose diagnostic is shown instead, is translated.
  assert.equal(reasonCodes.length, 9);
  const keys = [
    ...literalKeys,
    ...ternaryKeys,
    ...returnedKeys,
    ...reasonCodes.map((code) => `trust.reason.${code}`),
  ];
  assert.ok(literalKeys.length >= 8);
  assert.deepEqual(returnedKeys.sort(), ["trust.alreadyTrusted", "trust.reason.trust-not-required"]);
  for (const key of keys) assert.equal(typeof messages[key], "string", `${key} is missing from en.ts`);
});

test("text in the dialog never keeps its own line breaks or runs of spaces", () => {
  // Either could push a value's tail out of view of the person deciding trust.
  const block = settingsCss.slice(settingsCss.indexOf(".project-trust-detail {"));
  assert.match(block.slice(0, block.indexOf("}")), /white-space: normal;/);
});
