const baseUrl = `http://127.0.0.1:${process.env.WIREMOCK_HOST_PORT ?? 8080}`;

async function admin(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`WireMock ${method} ${path} returned ${response.status}: ${await response.text()}`);
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export async function resetWireMock() {
  await admin('/__admin/requests', { method: 'DELETE' });
  await admin('/__admin/scenarios/reset', { method: 'POST' });
}

export async function countRequests({ path, eventId }) {
  const requestPattern = { method: 'POST', urlPath: path };
  if (eventId) requestPattern.headers = { 'Idempotency-Key': { equalTo: eventId } };
  const result = await admin('/__admin/requests/count', { method: 'POST', body: requestPattern });
  return Number(result?.count ?? 0);
}

export async function requestsFor({ path, eventId }) {
  const requestPattern = { method: 'POST', urlPath: path };
  if (eventId) requestPattern.headers = { 'Idempotency-Key': { equalTo: eventId } };
  const result = await admin('/__admin/requests/find', { method: 'POST', body: requestPattern });
  return result?.requests ?? [];
}
