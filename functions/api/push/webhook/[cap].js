/* The capability-bearing device-event webhook.
 *
 * Maker API POSTs here when the household has registered
 * https://hestari.com/api/push/webhook/<cap> as its postURL. The capability is
 * a path segment rather than a query string on purpose: Hubitat's docs specify
 * /postURL/[URL] with the target "URL encoded" and are silent on whether a
 * query string survives that round trip, and unconfirmed platform behaviour is
 * how this project has nearly shipped three separate bugs. A path segment
 * cannot be dropped without breaking postURL for everyone.
 *
 * Cloudflare Pages routing, verified against its docs 2026-10-02: one set of
 * brackets is a single path segment, the value arrives on context.params, and
 * "more specific routes take precedence", so the static ../webhook.js keeps
 * serving the uncapped path during the grace window.
 *
 * All the logic lives in ../webhook.js so there is exactly one copy of the
 * categorisation, the Activity Log rules and the dispatch gating. Two copies
 * of that would drift, and the half that drifted would be the one nobody is
 * watching.
 */
import { processDeviceEvent } from '../webhook.js';

export async function onRequestPost({ request, env, params }) {
  const cap = typeof params.cap === 'string' ? params.cap : null;
  return processDeviceEvent({ request, env, cap });
}
