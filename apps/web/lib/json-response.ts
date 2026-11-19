// Next.js 16.4.6+ strips `Content-Encoding` from route-handler Responses before
// running its own HTTP compression middleware (`compress: true`), so manually
// gzipping here causes double-compressed payloads. Return plain UTF-8 JSON and
// let Next.js compress responses uniformly across all API routes.
export function jsonResponse(
  _request: Request,
  data: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}
