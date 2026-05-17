export async function onRequestGet({ request }) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  return Response.json({ ip }, {
    headers: { 'Cache-Control': 'no-store' }
  });
}
