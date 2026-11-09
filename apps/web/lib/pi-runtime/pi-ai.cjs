// Loads @earendil-works/pi-ai at run time instead of bundling it (next.config.ts, turbopack.resolveAlias).
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = require(/* turbopackIgnore: true */ "@earendil-works/pi-ai");
