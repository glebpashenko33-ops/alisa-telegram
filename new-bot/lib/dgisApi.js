const DGIS_API_KEY = process.env.DGIS_API_KEY;
const BASE_URL = 'https://catalog.api.2gis.com/3.0';

async function dgisRequest(path, params) {
  if (!DGIS_API_KEY) {
    throw new Error('DGIS_API_KEY env var is required');
  }
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('key', DGIS_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const res = await fetch(url);
  const data = await res.json();
  if (data.meta && data.meta.error) {
    throw new Error(`2GIS API error: ${data.meta.error.message}`);
  }
  return data;
}

async function findGasStationsNearby(lat, lon, radius = 3000, limit = 5) {
  const data = await dgisRequest('/items', {
    q: 'АЗС',
    point: `${lon},${lat}`,
    radius,
    sort: 'distance',
    fields: 'items.point,items.address_name',
    page_size: limit,
  });
  return (data.result && data.result.items) || [];
}

async function geocodeAddress(address) {
  const data = await dgisRequest('/items/geocode', {
    q: address,
    fields: 'items.point',
  });
  const items = (data.result && data.result.items) || [];
  return items[0] || null;
}

module.exports = { findGasStationsNearby, geocodeAddress };
