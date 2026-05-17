export async function onRequestGet({ params, env }) {
  const value = await env.HESTIA_KV.get(`home:${params.homeId}`);
  if (!value) return Response.json({ found: false });

  return new Response(JSON.stringify({ found: true, ...JSON.parse(value) }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

export async function onRequestDelete({ params, env }) {
  await env.HESTIA_KV.delete(`home:${params.homeId}`);
  return Response.json({ status: 'ok' });
}
