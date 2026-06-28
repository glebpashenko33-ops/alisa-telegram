const fs = require('fs');
const path = require('path');
const { geocodeAddress } = require('./geocode');

const STATIONS_FILE = path.join(__dirname, '..', 'stations.json');

function loadStations() {
  return JSON.parse(fs.readFileSync(STATIONS_FILE, 'utf8'));
}

function saveStations(stations) {
  fs.writeFileSync(STATIONS_FILE, JSON.stringify(stations, null, 2));
}

// Geocodes any station missing lat/lon and caches the result back to stations.json.
async function ensureCoordinates() {
  const stations = loadStations();
  let changed = false;

  for (const station of stations) {
    if (station.lat == null || station.lon == null) {
      const coords = await geocodeAddress(station.address);
      if (coords) {
        station.lat = coords.lat;
        station.lon = coords.lon;
        changed = true;
      } else {
        console.warn(`Could not geocode address: ${station.address}`);
      }
      // Respect Nominatim's 1 request/sec limit.
      await new Promise((resolve) => setTimeout(resolve, 1100));
    }
  }

  if (changed) {
    saveStations(stations);
  }
  return stations;
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function findNearby(lat, lon, limit = 5) {
  const stations = await ensureCoordinates();
  return stations
    .filter((s) => s.lat != null && s.lon != null)
    .map((s) => ({ ...s, distanceKm: haversineDistanceKm(lat, lon, s.lat, s.lon) }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

module.exports = { findNearby };
