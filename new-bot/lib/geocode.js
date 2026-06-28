const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// Nominatim usage policy: max 1 request/sec, must set a User-Agent.
async function geocodeAddress(address) {
  const url = new URL(NOMINATIM_URL);
  url.searchParams.set('q', address);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  const res = await fetch(url, {
    headers: { 'User-Agent': 'new-bot/1.0 (gas-station-finder)' },
  });
  const data = await res.json();
  if (!data.length) {
    return null;
  }
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

module.exports = { geocodeAddress };
