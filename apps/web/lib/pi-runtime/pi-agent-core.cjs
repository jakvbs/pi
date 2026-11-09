// Loads @earendil-works/pi-agent-core at run time instead of bundling it (next.config.ts, turbopack.resolveAlias).
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = require(/* turbopackIgnore: true */ "@earendil-works/pi-agent-core");
