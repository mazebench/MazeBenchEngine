export function isTrustedLocalRequest(request, port) {
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  const host = String(request.headers.host || "").toLowerCase();
  if (!allowedHosts.has(host)) return false;
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  return true;
}
