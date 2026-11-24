const readLocal = (key, fallback = null) => {
  try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch { return fallback; }
};
const emptyState = () => ({ reports: [], claims: [], privateClues: [], notifications: [], tasks: [] });
const normalizeState = value => {
  value.claims = Array.isArray(value.claims) ? value.claims : [];
  value.privateClues = Array.isArray(value.privateClues) ? value.privateClues : [];
  value.reports.forEach(report => { report.history = report.history || []; report.votes = report.votes || 0; });
  return value;
};
const saved = readLocal("losttrack-data");
let state = normalizeState(saved || emptyState());
let apiReady = false;
let session = readLocal("losttrack-session");
let role = session?.role || "user";
const legacyClaimData = state.reports.some(report => Object.hasOwn(report, "claimDetail")) ||
  (role !== "admin" && state.claims.some(claim => Object.hasOwn(claim, "detail")));
state.reports.forEach(report => { delete report.claimDetail; });
if (role !== "admin") state.claims.forEach(claim => { delete claim.detail; });
if (legacyClaimData) localStorage.setItem("losttrack-data", JSON.stringify(state));
const authToken = () => readLocal("losttrack-session")?.token || "";
let pendingAccounts = [];
let totalCampusUsers = 0;
let activeStaff = [];
let page = localStorage.getItem("losttrack-page") || "home";
let portalTab = "items";
let pendingReportKind = "";
let pendingReportFocus = "";
const app = document.querySelector("#app");
let reportMap = null;
let locationPickerMap = null;
let setLocationPickerPin = null;
let selectedLocationLabel = "";
let bangladeshBoundary = null;
let bangladeshBoundaryPromise = null;
let locationSearchController = null;
let locationSearchSequence = 0;
let photoPreviewUrls = [];
const save = () => {
  localStorage.setItem("losttrack-data", JSON.stringify(state));
  if (!apiReady) {
    if (state.reports.some(report => report.pendingSync)) {
      document.querySelector("#retry-sync").classList.remove("hidden");
      document.querySelector("#retry-sync").textContent = "Offline changes saved. Retry sync";
    }
    return Promise.resolve(false);
  }
  return fetch("/api/state", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + authToken() },
    body: JSON.stringify(state)
  }).then(async response => {
    if (response.status === 401) {
      session = null;
      role = "user";
      localStorage.removeItem("losttrack-session");
      render();
      throw Object.assign(new Error("Please sign in again."), { apiError: true });
    }
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || "Save failed."), { apiError: true });
    return result;
  }).then(result => {
    if (result?.state) {
      const cachedAccounts = state.accounts;
      state = normalizeState(result.state);
      if (role === "admin") state.accounts = cachedAccounts || [];
      localStorage.setItem("losttrack-data", JSON.stringify(state));
      render();
    }
    document.querySelector("#retry-sync").classList.add("hidden");
    apiReady = true;
    return true;
  }).catch(error => {
    if (error.apiError) {
      notify(error.message);
      return false;
    }
    apiReady = false;
    document.querySelector("#retry-sync").classList.remove("hidden");
    document.querySelector("#retry-sync").textContent = `Not synced: ${error.message}. Retry`;
    return false;
  });
};
async function syncFromApi() {
  try {
    const response = await fetch("/api/state", { headers: { Authorization: `Bearer ${authToken()}` } });
    if (response.status === 401) {
      session = null;
      localStorage.removeItem("losttrack-session");
      render();
      return;
    }
    if (!response.ok) throw new Error("API unavailable");
    const remote = await response.json();
    const cached = readLocal("losttrack-data", emptyState());
    const pendingReports = [...new Map(
      [...(cached.reports || []), ...state.reports]
        .filter(report => report.pendingSync && report.createdBy === session?.id)
        .map(report => [String(report.id), report])
    ).values()];
    state = remote;
    state.reports = [
      ...pendingReports.filter(report => !state.reports.some(remoteReport => String(remoteReport.id) === String(report.id))),
      ...state.reports
    ];
    normalizeState(state);
    apiReady = true;
    localStorage.setItem("losttrack-data", JSON.stringify(state));
    if (role === "admin") {
      const accountsResponse = await fetch("/api/admin/accounts", { headers: { Authorization: `Bearer ${authToken()}` } });
      if (!accountsResponse.ok) throw new Error("Could not load account approvals.");
      const accounts = (await accountsResponse.json()).accounts;
      state.accounts = accounts;
      pendingAccounts = accounts.filter(account => account.status === "pending");
      totalCampusUsers = accounts.filter(account => account.role !== "admin" && account.status === "active").length;
      activeStaff = accounts.filter(account => account.role === "staff" && account.status === "active");
    }
    document.querySelector("#retry-sync").classList.add("hidden");
    render();
    if (pendingReports.length) await save();
  } catch (error) {
    apiReady = false;
    document.querySelector("#retry-sync").classList.remove("hidden");
    document.querySelector("#retry-sync").textContent = `Connection issue: ${error.message}. Retry`;
  }
}
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
const itemCategories = ["Wallet", "Phone", "ID card", "Electronics", "Bag", "Bottle", "Other"];
const issueCategories = ["Drainage", "Waste", "Other"];
const allCategories = [...itemCategories.filter(category => category !== "Other"), ...issueCategories];
const categoryOptions = (categories, includeAll = false) =>
  `${includeAll ? '<option value="">All categories</option>' : ""}${categories.map(category => `<option>${esc(category)}</option>`).join("")}`;
const today = () => {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
};
const typeName = type => type === "issue" ? "Campus issue" : type === "found" ? "Found item" : "Lost item";
const icon = type => type === "issue" ? "ISS" : type === "found" ? "FND" : "LST";
const tag = (text, tone = "") => `<span class="tag ${tone}">${esc(text)}</span>`;
const locationPoints = (a, b) => {
  const normalize = value => String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (normalize(a.place) === normalize(b.place)) return 20;
  return (a.campusId || "uftb-main") === (b.campusId || "uftb-main") ? 10 : 0;
};
const notify = text => {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add("visible");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove("visible"), 3500);
};
const log = (item, text) => item.history.unshift(`${text} - ${new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`);
const unread = () => state.notifications.filter(n => !n.read).length;
const getReport = id => state.reports.find(r => String(r.id) === String(id));
const getPrivateClue = id => (state.privateClues || []).find(clue => String(clue.reportId) === String(id));
const duplicateReports = (report, excludeId) => state.reports.filter(existing => {
  const age = Date.now() - new Date(existing.createdAt || existing.date).getTime();
  return String(existing.id) !== String(excludeId) && existing.type === "issue" && existing.status === "Open" &&
    existing.category.toLowerCase() === String(report.category || "").toLowerCase() &&
    existing.place.trim().toLowerCase() === String(report.place || "").trim().toLowerCase() &&
    age >= 0 && age <= 14 * 86400000;
});
const matchScore = (a, b) => {
  if (a.type !== "lost" || b.type !== "found" || String(a.category).toLowerCase() !== String(b.category).toLowerCase()) {
    return {
      score: 0,
      reasons: [],
      factors: [
        { name: "Category", points: 0, max: 30 },
        { name: "Colour", points: 0, max: 20 },
        { name: "Location", points: 0, max: 20 },
        { name: "Date", points: 0, max: 15 },
        { name: "Keywords", points: 0, max: 15 }
      ]
    };
  }
  let score = 30, reasons = ["same category"];
  const factors = [{ name: "Category", points: 30, max: 30 }];
  const colorFamily = value => {
    const color = String(value || "").trim().toLowerCase();
    if (["black", "navy", "dark blue", "charcoal"].includes(color)) return "dark";
    if (["blue", "light blue", "sky blue"].includes(color)) return "blue";
    if (["red", "maroon", "pink"].includes(color)) return "red";
    if (["white", "silver", "gray", "grey"].includes(color)) return "light";
    return color;
  };
  const colors = [a.color, b.color].map(value => String(value || "").trim().toLowerCase());
  const colorPoints = colors[0] && colors[0] === colors[1] ? 20
    : colors[0] && colors[1] && colorFamily(colors[0]) === colorFamily(colors[1]) ? 10 : 0;
  score += colorPoints;
  factors.push({ name: "Colour", points: colorPoints, max: 20 });
  if (colorPoints) reasons.push(colorPoints === 20 ? "colour" : "similar colour");
  const placePoints = locationPoints(a, b);
  score += placePoints;
  factors.push({ name: "Location", points: placePoints, max: 20 });
  if (placePoints === 20) reasons.push("same location");
  else if (placePoints === 10) reasons.push("nearby campus area");
  const days = (new Date(b.date) - new Date(a.date)) / 86400000;
  const datePoints = days >= 0 && days <= 3 ? 15 : days > 3 && days <= 7 ? 8 : 0;
  score += datePoints;
  factors.push({ name: "Date", points: datePoints, max: 15 });
  if (datePoints) reasons.push(datePoints === 15 ? "date within 3 days" : "date within 7 days");
  const stop = new Set([
    "the", "and", "for", "with", "near", "from", "this", "that", "item", "lost", "found",
    "এবং", "কিংবা", "একটি", "আমার", "হারানো", "পাওয়া", "পাওয়া", "জিনিস", "সামনে", "কাছে"
  ]);
  const words = value => new Set(String(value || "").toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu)?.filter(word => word.length > 1 && !stop.has(word)) || []);
  const left = words(a.text), right = words(b.text);
  const union = new Set([...left, ...right]), shared = [...left].filter(word => right.has(word)).length;
  if (union.size) {
    const points = Math.round(15 * shared / union.size);
    score += points;
    factors.push({ name: "Keywords", points, max: 15 });
    if (points) reasons.push(`keywords ${shared}/${union.size}`);
  } else {
    factors.push({ name: "Keywords", points: 0, max: 15 });
  }
  return { score, reasons, factors };
};
const priorityFor = report => {
  const severity = { Low: .33, Medium: .67, High: 1 }[report.severity] || .67;
  const votes = Math.min((report.votes || 0) / 20, 1);
  const risk = report.safetyRisk ? 1 : 0;
  const openedAt = report.status === "Open" ? report.statusChangedAt || report.createdAt || report.date : report.createdAt || report.date;
  const ageDays = Math.max(0, (Date.now() - new Date(openedAt)) / 86400000);
  const score = Math.round(100 * (.4 * severity + .3 * votes + .2 * risk + .1 * Math.min(ageDays / 14, 1)));
  const suggested = report.safetyRisk && report.severity === "High" ? "High" : score >= 70 ? "High" : score >= 40 ? "Medium" : "Low";
  return { score, suggested, overdue: report.type === "issue" && report.status === "Open" && report.priority === "High" && ageDays > 7 };
};

function loadBangladeshBoundary() {
  if (!bangladeshBoundaryPromise) {
    bangladeshBoundaryPromise = fetch("/assets/data/bangladesh-boundary.json")
      .then(response => {
        if (!response.ok) throw new Error(`Bangladesh boundary request failed (${response.status}).`);
        return response.json();
      })
      .then(boundary => {
        if (boundary?.geometry?.type !== "MultiPolygon") {
          throw new Error("Bangladesh boundary data is invalid.");
        }
        bangladeshBoundary = boundary;
        return boundary;
      });
  }
  return bangladeshBoundaryPromise;
}
function pointInBoundaryRing(longitude, latitude, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const [currentLongitude, currentLatitude] = ring[index];
    const [previousLongitude, previousLatitude] = ring[previous];
    const cross = (longitude - currentLongitude) * (previousLatitude - currentLatitude) -
      (latitude - currentLatitude) * (previousLongitude - currentLongitude);
    if (Math.abs(cross) < 1e-9 &&
      longitude >= Math.min(currentLongitude, previousLongitude) &&
      longitude <= Math.max(currentLongitude, previousLongitude) &&
      latitude >= Math.min(currentLatitude, previousLatitude) &&
      latitude <= Math.max(currentLatitude, previousLatitude)) return true;
    if ((currentLatitude > latitude) !== (previousLatitude > latitude) &&
      longitude < (previousLongitude - currentLongitude) * (latitude - currentLatitude) /
      (previousLatitude - currentLatitude) + currentLongitude) inside = !inside;
  }
  return inside;
}
function isBangladeshPoint(latitude, longitude) {
  if (!bangladeshBoundary || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  return bangladeshBoundary.geometry.coordinates.some(polygon =>
    pointInBoundaryRing(longitude, latitude, polygon[0]) &&
    !polygon.slice(1).some(hole => pointInBoundaryRing(longitude, latitude, hole)));
}
function locationNameEnglish(result) {
  return String(result.nameEnglish || result.name || "").trim().slice(0, 155);
}
function pinStatusText(latitude, longitude) {
  const coordinates = `${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}`;
  return `Selected: ${selectedLocationLabel ? `${selectedLocationLabel} · ` : ""}${coordinates}`;
}
function createBangladeshMap(element, tileStatus, boundary) {
  const countryLayer = L.geoJSON(boundary, {
    interactive: false,
    style: { color: "#00897b", weight: 2, fillColor: "#14b8a6", fillOpacity: 0.05 }
  });
  const outsideMask = L.polygon([
    [[85, -180], [85, 180], [-85, 180], [-85, -180]],
    ...boundary.geometry.coordinates.map(polygon =>
      polygon[0].map(([longitude, latitude]) => [latitude, longitude]))
  ], {
    interactive: false,
    stroke: false,
    fillColor: getComputedStyle(element).backgroundColor,
    fillOpacity: 1,
    fillRule: "evenodd"
  });
  const countryBounds = countryLayer.getBounds().pad(0.08);
  const map = L.map(element, {
    zoomControl: false, zoomSnap: 0.5, minZoom: 5, maxZoom: 18,
    maxBounds: countryBounds, maxBoundsViscosity: 1
  }).fitBounds(countryBounds);
  const resizeTimer = setTimeout(() => map.invalidateSize(), 200);
  map.once("unload", () => clearTimeout(resizeTimer));
  L.control.zoom({
    zoomInTitle: "Zoom in",
    zoomOutTitle: "Zoom out"
  }).addTo(map);
  const tiles = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, noWrap: true,
    attribution: 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Sources: Esri, TomTom, Garmin, FAO, NOAA, USGS, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, and the GIS User Community'
  }).addTo(map);
  if (tileStatus) tileStatus.textContent = "English-language map tiles by Esri.";
  tiles.on("tileerror", () => {
    if (tileStatus) tileStatus.textContent = "Some Bangladesh map tiles could not be loaded. Check your internet connection.";
  });
  outsideMask.addTo(map);
  countryLayer.addTo(map);
  return map;
}
async function initializeLocationPicker() {
  const element = document.querySelector("#location-picker-map");
  if (!element) return;
  element.setAttribute("aria-label", "Select a location in Bangladesh");
  const mapPicker = element.closest(".map-picker");
  mapPicker?.setAttribute("translate", "no");
  selectedLocationLabel = "";
  const status = document.querySelector("#location-pin-status");
  const tileStatus = document.querySelector("#location-map-status");
  try {
    const boundary = await loadBangladeshBoundary();
    if (!element.isConnected) return;
    locationPickerMap?.remove();
    locationPickerMap = createBangladeshMap(element, tileStatus, boundary);
    const latitude = document.querySelector('[name="latitude"]');
    const longitude = document.querySelector('[name="longitude"]');
    let marker = null;
    const setPin = (lat, lng, label = "") => {
      latitude.value = lat.toFixed(6);
      longitude.value = lng.toFixed(6);
      selectedLocationLabel = label;
      status.textContent = pinStatusText(lat, lng);
      if (marker) marker.setLatLng([lat, lng]);
      else marker = L.marker([lat, lng]).addTo(locationPickerMap);
      marker.bindPopup(`<strong>${esc(label || "Selected location")}</strong><br>${lat.toFixed(5)}, ${lng.toFixed(5)}`);
    };
    setLocationPickerPin = (lat, lng, label = "") => {
      if (!isBangladeshPoint(lat, lng)) return false;
      setPin(lat, lng, label);
      locationPickerMap.setView([lat, lng], 13);
      return true;
    };
    const savedLatitude = Number(latitude.value), savedLongitude = Number(longitude.value);
    if (latitude.value && longitude.value) {
      if (isBangladeshPoint(savedLatitude, savedLongitude)) {
        setPin(savedLatitude, savedLongitude, document.querySelector("#report-place")?.value || "");
        locationPickerMap.setView([savedLatitude, savedLongitude], 13);
      } else {
        latitude.value = "";
        longitude.value = "";
      }
    }
    locationPickerMap.on("click", event => {
      const { lat, lng } = event.latlng;
      if (!isBangladeshPoint(lat, lng)) {
        notify("Choose a location inside Bangladesh.");
        return;
      }
      setPin(lat, lng);
    });
  } catch (error) {
    status.textContent = "The Bangladesh map could not be loaded. You can still enter the location as text.";
    console.error("Bangladesh location map initialization failed:", error);
  }
}
function initializeLocationSearch() {
  const placeAutocomplete = document.querySelector("#report-place")?.closest(".location-autocomplete");
  if (placeAutocomplete) placeAutocomplete.id = "report-place-autocomplete";
  const mapPicker = document.querySelector(".map-picker");
  const map = document.querySelector("#location-picker-map");
  if (!mapPicker || !map) return;
  const wrapper = document.createElement("div");
  wrapper.className = "location-search-panel";
  wrapper.setAttribute("translate", "no");
  const label = document.createElement("label");
  label.htmlFor = "location-search-query";
  label.textContent = "Search Bangladesh locations";
  const input = document.createElement("input");
  input.id = "location-search-query";
  input.type = "search";
  input.maxLength = 120;
  input.placeholder = "e.g. Dhaka, Chattogram or Rajshahi";
  input.autocomplete = "off";
  label.append(input);
  const button = document.createElement("button");
  button.className = "btn secondary";
  button.id = "search-location";
  button.type = "button";
  button.textContent = "Search locations";
  const notice = document.createElement("p");
  notice.className = "small search-privacy-note";
  notice.textContent = "Search Bangladesh locations only when you press the button. Your query is sent to OpenStreetMap; do not enter personal or confidential information.";
  const attribution = document.createElement("a");
  attribution.className = "small location-search-attribution";
  attribution.href = "https://www.openstreetmap.org/copyright";
  attribution.target = "_blank";
  attribution.rel = "noopener noreferrer";
  attribution.textContent = "© OpenStreetMap contributors";
  const languageNotice = document.createElement("p");
  languageNotice.className = "small bilingual-map-note";
  languageNotice.textContent = "Map labels are in English. Tiles © Esri; data providers are credited on the map.";
  const results = document.createElement("div");
  results.id = "location-search-results";
  results.className = "location-search-results";
  results.setAttribute("aria-live", "polite");
  wrapper.append(label, button);
  map.before(wrapper, notice, languageNotice, attribution, results);
  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchBangladeshLocations();
    }
  });
  window.LostTrackI18n?.apply();
}
function availableCampusLocations(query = "") {
  const locations = [
    "Hightech",
    "Hightech Railway Station",
    "Latifpur",
    ...state.reports.map(report => report.place)
  ];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return [...new Map(locations
    .filter(place => typeof place === "string" && place.trim())
    .map(place => [place.trim().toLocaleLowerCase(), place.trim()])).values()]
    .filter(place => !normalizedQuery || place.toLocaleLowerCase().includes(normalizedQuery))
    .sort((a, b) => {
      const aStarts = a.toLocaleLowerCase().startsWith(normalizedQuery);
      const bStarts = b.toLocaleLowerCase().startsWith(normalizedQuery);
      return Number(bStarts) - Number(aStarts) || a.localeCompare(b);
    })
    .slice(0, 8);
}
function updateLocationSuggestions(query = "") {
  const input = document.querySelector("#report-place");
  const list = document.querySelector("#place-suggestions");
  if (!input || !list) return;
  const value = query.trim();
  const matches = availableCampusLocations(value);
  const exactMatch = matches.some(place => place.toLocaleLowerCase() === value.toLocaleLowerCase());
  const options = value && !exactMatch
    ? [{
      label: localStorage.getItem("losttrack-language") === "bn"
        ? `এই অবস্থানটি ব্যবহার করুন: ${value}`
        : `Use this location: ${value}`,
      value
    }, ...matches.map(place => ({ value: place }))]
    : matches.map(place => ({ value: place }));
  list.replaceChildren();
  options.forEach(option => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "place-option";
    button.setAttribute("role", "option");
    button.dataset.place = option.value;
    button.textContent = option.label || option.value;
    list.append(button);
  });
  if (!options.length) {
    const empty = document.createElement("span");
    empty.className = "place-empty small";
    empty.textContent = "No saved locations yet. You can enter any location.";
    list.append(empty);
  }
  list.classList.remove("hidden");
  input.setAttribute("aria-expanded", "true");
}
function selectCampusLocation(value) {
  const input = document.querySelector("#report-place");
  if (!input) return;
  input.value = value;
  clearMapPinForLocationChange();
  closeLocationSuggestions();
}
function closeLocationSuggestions() {
  const input = document.querySelector("#report-place");
  const list = document.querySelector("#place-suggestions");
  if (!input || !list) return;
  list.classList.add("hidden");
  input.setAttribute("aria-expanded", "false");
}
function initializeReportLocationSearch() {
  const input = document.querySelector("#location-filter");
  if (!input || input.closest("#report-location-autocomplete")) return;
  const wrapper = document.createElement("div");
  wrapper.id = "report-location-autocomplete";
  wrapper.className = "location-autocomplete";
  input.before(wrapper);
  wrapper.append(input);
  input.placeholder = "Search reports by location";
  input.autocomplete = "off";
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", "report-location-suggestions");
  const list = document.createElement("div");
  list.id = "report-location-suggestions";
  list.className = "place-suggestions hidden";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Suggested locations");
  wrapper.append(list);
}
function updateReportLocationSuggestions(query = "") {
  const input = document.querySelector("#location-filter");
  const list = document.querySelector("#report-location-suggestions");
  if (!input || !list) return;
  const value = query.trim();
  const matches = availableCampusLocations(value);
  const exactMatch = matches.some(place => place.toLocaleLowerCase() === value.toLocaleLowerCase());
  const options = value && !exactMatch
    ? [{
      label: localStorage.getItem("losttrack-language") === "bn"
        ? `এই স্থানে রিপোর্ট খুঁজুন: ${value}`
        : `Search reports at: ${value}`,
      value
    }, ...matches.map(place => ({ value: place }))]
    : matches.map(place => ({ value: place }));
  list.replaceChildren();
  options.forEach(option => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "place-option";
    button.setAttribute("role", "option");
    button.dataset.place = option.value;
    button.textContent = option.label || option.value;
    list.append(button);
  });
  list.classList.toggle("hidden", options.length === 0);
  input.setAttribute("aria-expanded", String(options.length > 0));
}
function selectReportLocation(value) {
  const input = document.querySelector("#location-filter");
  if (!input) return;
  input.value = value;
  closeReportLocationSuggestions();
  filterReports();
}
function closeReportLocationSuggestions() {
  const input = document.querySelector("#location-filter");
  const list = document.querySelector("#report-location-suggestions");
  if (!input || !list) return;
  list.classList.add("hidden");
  input.setAttribute("aria-expanded", "false");
}
async function searchBangladeshLocations() {
  const input = document.querySelector("#location-search-query");
  const results = document.querySelector("#location-search-results");
  const button = document.querySelector("#search-location");
  if (!input || !results || !button) return;
  const query = input.value.trim();
  if (query.length < 3) {
    results.textContent = "Enter at least 3 characters to search.";
    input.focus();
    return;
  }
  locationSearchController?.abort();
  locationSearchController = new AbortController();
  const sequence = ++locationSearchSequence;
  button.disabled = true;
  results.textContent = "Searching Bangladesh locations…";
  try {
    const params = new URLSearchParams({ q: query });
    const response = await fetch(`/api/location-search?${params}`, {
      headers: { Authorization: `Bearer ${authToken()}` },
      signal: locationSearchController.signal
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Location search failed.");
    await loadBangladeshBoundary();
    const matches = (Array.isArray(payload.results) ? payload.results : []).filter(result =>
      isBangladeshPoint(Number(result.latitude), Number(result.longitude)));
    results.replaceChildren();
    if (!matches.length) {
      const message = document.createElement("p");
      message.className = "small";
      message.textContent = "No map result found for this spelling.";
      const custom = document.createElement("button");
      custom.type = "button";
      custom.className = "location-search-result";
      custom.dataset.name = query.slice(0, 155);
      custom.dataset.latitude = "";
      custom.dataset.longitude = "";
      const name = document.createElement("strong");
      name.textContent = `Use "${query}" as a text location`;
      const address = document.createElement("small");
      address.textContent = "No map pin will be added.";
      custom.append(name, address);
      results.append(message, custom);
      return;
    }
    matches.forEach(result => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "location-search-result";
      option.dataset.name = locationNameEnglish(result);
      option.dataset.displayName = result.displayName;
      option.dataset.latitude = String(result.latitude);
      option.dataset.longitude = String(result.longitude);
      const name = document.createElement("strong");
      name.textContent = option.dataset.name;
      const address = document.createElement("small");
      address.textContent = result.displayName;
      option.append(name, address);
      results.append(option);
    });
  } catch (error) {
    if (error.name !== "AbortError" && sequence === locationSearchSequence) {
      results.textContent = error.message;
    }
  } finally {
    if (sequence === locationSearchSequence) button.disabled = false;
  }
}
async function selectBangladeshLocation(option) {
  try {
    const name = option.dataset.name.trim().slice(0, 155);
    const latitude = option.dataset.latitude ? Number(option.dataset.latitude) : NaN;
    const longitude = option.dataset.longitude ? Number(option.dataset.longitude) : NaN;
    selectCampusLocation(name);
    if (!name) {
      notify("Enter a location name.");
      return;
    }
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      document.querySelector('[name="latitude"]').value = "";
      document.querySelector('[name="longitude"]').value = "";
      const status = document.querySelector("#location-pin-status");
      if (status) status.textContent = `Selected as text: ${name} · No map pin added`;
      document.querySelector("#location-search-results").replaceChildren();
      return;
    }
    await loadBangladeshBoundary();
    if (!isBangladeshPoint(latitude, longitude)) {
      notify("Choose a valid location in Bangladesh.");
      return;
    }
    document.querySelector('[name="latitude"]').value = latitude.toFixed(6);
    document.querySelector('[name="longitude"]').value = longitude.toFixed(6);
    if (!setLocationPickerPin?.(latitude, longitude, name)) {
      const status = document.querySelector("#location-pin-status");
      if (status) status.textContent = `Selected: ${name} · ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    }
    document.querySelector("#location-search-results").replaceChildren();
  } catch (error) {
    notify(error.message || "Could not select this Bangladesh location.");
  }
}
function clearMapPinForLocationChange() {
  const latitude = document.querySelector('[name="latitude"]');
  const longitude = document.querySelector('[name="longitude"]');
  if (!latitude?.value && !longitude?.value) return;
  latitude.value = "";
  longitude.value = "";
  selectedLocationLabel = "";
  locationPickerMap?.eachLayer(layer => {
    if (layer instanceof L.Marker) locationPickerMap.removeLayer(layer);
  });
  const status = document.querySelector("#location-pin-status");
  if (status) {
    status.textContent = "Location changed. Add a new Bangladesh map pin if needed.";
  }
}
function filteredReports() {
  const q = document.querySelector("#search").value.toLowerCase();
  const location = document.querySelector("#location-filter").value.toLowerCase();
  const color = document.querySelector("#color-filter").value.toLowerCase();
  const date = document.querySelector("#date-filter").value;
  const kind = document.querySelector("#kind").value, cat = document.querySelector("#category").value, status = document.querySelector("#status").value;
  return state.reports.filter(report =>
    `${report.title} ${report.text}`.toLowerCase().includes(q) &&
    report.place.toLowerCase().includes(location) &&
    String(report.color || "").toLowerCase().includes(color) &&
    (!date || report.date === date) &&
    (!kind || report.type === kind) && (!cat || report.category === cat) && (!status || report.status === status));
}
async function updateReportMarkers(reports) {
  const layer = document.querySelector("#reports-map");
  if (!layer) return;
  layer.setAttribute("aria-label", "Map of Bangladesh report locations");
  const tileStatus = document.querySelector("#reports-map-status");
  const panel = layer.closest(".location-map-panel");
  panel?.setAttribute("translate", "no");
  if (tileStatus) tileStatus.textContent = "Only reports pinned inside Bangladesh appear here. Map labels are in English.";
  try {
    if (!layer.isConnected) return;
    const boundary = await loadBangladeshBoundary();
    if (!layer.isConnected) return;
    if (!reportMap || reportMap.getContainer() !== layer) {
      reportMap?.remove();
      reportMap = createBangladeshMap(layer, tileStatus, boundary);
    }
    reportMap.eachLayer(mapLayer => {
      if (mapLayer instanceof L.CircleMarker) reportMap.removeLayer(mapLayer);
    });
    const pinned = reports.filter(report =>
      Number.isFinite(report.latitude) && Number.isFinite(report.longitude) &&
      isBangladeshPoint(report.latitude, report.longitude));
    pinned.forEach(report => {
      const colors = { lost: "#d97706", found: "#07877f", issue: "#dc2626" };
      const typeLabel = report.type === "issue" ? "Campus issue"
        : report.type === "found" ? "Found item" : "Lost item";
      const statusLabel = report.status;
      L.circleMarker([Number(report.latitude), Number(report.longitude)], {
        radius: 8, color: "#fff", weight: 2, fillColor: colors[report.type] || "#102b49", fillOpacity: 1
      }).bindPopup(`<strong>${esc(report.title)}</strong><br>${typeLabel} · ${esc(statusLabel)}<br>${esc(report.place)}<br><a href="#report-card-${encodeURIComponent(report.id)}">View report</a>`)
        .addTo(reportMap);
    });
    document.querySelector("#reports-map-count").textContent =
      `${pinned.length} pinned · ${reports.length - pinned.length} without a Bangladesh pin`;
  } catch (error) {
    tileStatus.textContent = "The Bangladesh map could not be loaded.";
    console.error("Bangladesh reports map initialization failed:", error);
  }
}
function setAuthMessage(element, message, ok = false) {
  if (!element) return;
  element.classList.toggle("success", ok);
  element.textContent = message;
  window.LostTrackI18n?.apply();
}
function render() {
  if (reportMap) { reportMap.remove(); reportMap = null; }
  if (locationPickerMap) { locationPickerMap.remove(); locationPickerMap = null; }
  setLocationPickerPin = null;
  photoPreviewUrls.forEach(URL.revokeObjectURL);
  photoPreviewUrls = [];
  const loggedIn = Boolean(session);
  document.body.classList.toggle("auth-page", !loggedIn);
  document.body.classList.toggle("admin-mode", loggedIn && role === "admin");
  document.querySelector("#site-header").classList.toggle("hidden", !loggedIn);
  document.querySelector("footer").classList.toggle("hidden", !loggedIn);
  if (!loggedIn) {
    const form = pages.auth(localStorage.getItem("losttrack-auth-mode") || "login")
      .replace('<section class="auth-shell">', "")
      .replace("</section>", "");
    app.innerHTML = `<section class="auth-layout auth-simple">
      <div class="auth-controls"><button id="auth-language-toggle" class="btn ghost" type="button">Bangla</button><button id="auth-theme-toggle" class="btn ghost" type="button" aria-pressed="false">Dark</button></div>
      <div class="auth-form-wrap">${form}</div>
    </section>`;
    window.LostTrackI18n?.apply();
    return;
  }
  localStorage.setItem("losttrack-page", page);
  document.body.dataset.connection = navigator.onLine ? "online" : "offline";
  const allowedPages = ["home", "reports", "my-reports", "new", "notifications"];
  if (role !== "user") allowedPages.push("dashboard", "my-tasks");
  if (!allowedPages.includes(page)) page = role === "staff" ? "dashboard" : "home";
  const primary = document.querySelector("#mode-portal");
  const secondary = document.querySelector("#mode-admin");
  const primaryLabel = document.querySelector("#mode-portal-label");
  const secondaryLabel = document.querySelector("#mode-admin-label");
  const claimBadge = document.querySelector("#badge-pending-claims");
  document.querySelector(".admin-nav-group").classList.toggle("hidden", role !== "admin");
  const pendingClaimCount = state.claims.filter(claim => claim.status === "Pending review").length;
  if (role === "admin") {
    primary.dataset.page = "home";
    primaryLabel.textContent = "Campus board";
    secondary.classList.remove("hidden");
    secondary.dataset.page = "dashboard";
    secondaryLabel.textContent = "Admin Dashboard";
    claimBadge.classList.remove("hidden");
    claimBadge.textContent = String(pendingClaimCount);
    primary.classList.toggle("active", page === "home");
    secondary.classList.toggle("active", page === "dashboard");
    document.querySelector("#admin-nav-reports").classList.toggle("active", page === "reports");
    document.querySelector("#admin-nav-new").classList.toggle("active", page === "new");
  } else if (role === "staff") {
    primary.dataset.page = "dashboard";
    primaryLabel.textContent = "Staff Dashboard";
    secondary.classList.remove("hidden");
    secondary.dataset.page = "home";
    secondaryLabel.textContent = "Campus board";
    claimBadge.classList.add("hidden");
    primary.classList.toggle("active", page === "dashboard");
    secondary.classList.toggle("active", page !== "dashboard");
  } else {
    primary.dataset.page = "home";
    primaryLabel.textContent = "Student Portal";
    secondary.classList.add("hidden");
    claimBadge.classList.add("hidden");
    primary.classList.add("active");
    secondary.classList.remove("active");
  }
  const alertCount = document.querySelector("#alert-count");
  if (alertCount) {
    const alerts = unread();
    alertCount.textContent = String(alerts);
    alertCount.classList.toggle("hidden", alerts === 0);
  }
  const userName = document.querySelector("#current-user-name");
  if (userName && session) {
    userName.textContent = session.name;
    document.querySelector("#current-user-email").textContent = session.email;
    document.querySelector("#current-user-initials").textContent = session.name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase();
    const roleLabel = document.querySelector("#current-user-role");
    if (roleLabel) roleLabel.textContent = role === "admin" ? "Administrator" : role === "staff" ? "Staff" : "Student";
  }
  app.innerHTML = (pages[page] || pages.home)();
  if (page === "reports") initializeReportLocationSearch();
  if (page === "new") {
    restoreDraft();
    if (pendingReportKind) {
      const typeField = document.querySelector("#report-type");
      if (typeField) {
        typeField.value = pendingReportKind;
        typeField.dispatchEvent(new Event("change", { bubbles: true }));
      }
      pendingReportKind = "";
    }
    syncReportCategories(document.querySelector("#report-type")?.value || "lost");
    initializeLocationSearch();
    initializeLocationPicker();
  }
  if (page === "reports") updateReportMarkers(filteredReports());
  if (page === "home") bindPortalFilters();
  if (pendingReportFocus) {
    const card = document.getElementById(`report-card-${encodeURIComponent(pendingReportFocus)}`);
    card?.classList.add("focus-report");
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
    pendingReportFocus = "";
  }
  window.LostTrackI18n?.apply();
}
function restoreDraft() {
  let draft;
  try { draft = JSON.parse(localStorage.getItem("losttrack-draft") || "null"); }
  catch { localStorage.removeItem("losttrack-draft"); return; }
  if (!draft) return;
  if (draft.ownerId !== session.id) {
    localStorage.removeItem("losttrack-draft");
    return;
  }
  delete draft.ownerId;
  const form = document.querySelector("#report-form");
  Object.entries(draft).forEach(([name, value]) => {
    const field = form.elements[name];
    if (field && field.type !== "checkbox" && field.type !== "file") field.value = value;
  });
  form.elements.type.dispatchEvent(new Event("change", { bubbles: true }));
  document.querySelector("#draft-note").textContent = "Saved draft restored on this device.";
}
function storeDraft(form) {
  const draft = { ...Object.fromEntries(new FormData(form)), ownerId: session.id };
  delete draft.photos;
  localStorage.setItem("losttrack-draft", JSON.stringify(draft));
}
function fileAsData(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}
function clearPhotoPreviews() {
  photoPreviewUrls.forEach(URL.revokeObjectURL);
  photoPreviewUrls = [];
  document.querySelector("#photo-previews")?.replaceChildren();
}
function updatePhotoPreviews(input) {
  clearPhotoPreviews();
  const files = [...input.files];
  const error = document.querySelector("#photo-error");
  error.textContent = "";
  if (files.length > 3 || files.some(file => !/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 2 * 1024 * 1024)) {
    error.textContent = "Choose up to 3 JPG, PNG or WebP images, each 2 MB or smaller. The server also checks each image's signature.";
    return false;
  }
  const previews = document.querySelector("#photo-previews");
  files.forEach(file => {
    const url = URL.createObjectURL(file);
    photoPreviewUrls.push(url);
    const tile = document.createElement("div");
    tile.className = "photo-preview";
    const image = document.createElement("img");
    image.src = url;
    image.alt = `Preview of ${file.name}`;
    const label = document.createElement("span");
    label.textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB`;
    tile.append(image, label);
    previews.append(tile);
  });
  return true;
}
function openClaimDialog(report, claim = null) {
  document.querySelector("#claim-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "claim-dialog";
  dialog.className = "claim-dialog";
  const supplemental = Boolean(claim);
  dialog.innerHTML = `<form id="claim-form" data-report-id="${esc(report.id)}" ${claim ? `data-claim-id="${esc(claim.id)}"` : ""}><h2>${supplemental ? "Provide more information" : "Make a claim"}</h2><p>Found item: <strong>${esc(report.title)}</strong></p><p>${supplemental ? "Add the requested ownership detail. Do not repeat an identity document or personal contact information." : "Share one private ownership detail only the owner would know."}</p><p>Administrators handling the return can read it; the response will not reveal which detail was correct.</p><label>Private ownership detail<textarea name="detail" required maxlength="300" placeholder="Do not include an ID number, contact details, or an ID photo."></textarea></label><p class="small" data-retention-message="claim"></p><label class="check"><input name="consent" type="checkbox" required> I consent to sending this ownership detail to LostTrack administrators for claim review.</label><div id="claim-error" class="form-error" role="alert"></div><div class="actions"><button type="button" class="btn ghost close-claim">Cancel</button><button class="btn" type="submit">${supplemental ? "Send additional information" : "Submit private claim"}</button></div></form>`;
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  document.body.append(dialog);
  dialog.showModal();
  window.LostTrackI18n?.apply();
}
function openFormDialog(html, onSubmit) {
  document.querySelector("#action-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "action-dialog";
  dialog.className = "claim-dialog";
  dialog.innerHTML = html;
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.querySelector("form").addEventListener("submit", event => {
    event.preventDefault();
    event.stopPropagation();
    const message = onSubmit(Object.fromEntries(new FormData(event.target)));
    const error = dialog.querySelector(".form-error");
    if (message) {
      if (error) error.textContent = message;
      return;
    }
    dialog.close();
  });
  document.body.append(dialog);
  dialog.showModal();
  window.LostTrackI18n?.apply();
}
function syncReportCategories(type) {
  const select = document.querySelector('#report-form [name="category"]');
  if (!select) return;
  const options = type === "issue" ? issueCategories : itemCategories;
  const current = select.value;
  select.innerHTML = categoryOptions(options);
  select.value = options.includes(current) ? current : options[0];
}
function analyticsPanel() {
  const countBy = getLabel => {
    const counts = new Map();
    state.reports.forEach(report => {
      const key = String(getLabel(report) || "").trim();
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return [...counts].sort((a, b) => b[1] - a[1]);
  };
  const months = countBy(report => String(report.createdAt || report.date || "").match(/^\d{4}-\d{2}/)?.[0])
    .sort(([a], [b]) => a.localeCompare(b)).slice(-6);
  const groups = [
    ["By category", "Bar chart", "bar", countBy(report => report.category).slice(0, 5)],
    ["By status", "Pie chart", "pie", countBy(report => report.status).slice(0, 5)],
    ["By location", "Donut chart", "donut", countBy(report => report.place).slice(0, 5)],
    ["By month", "Line chart", "line", months]
  ];
  const cards = groups.map(([title, kind, type, rows]) => analyticsCard(title, kind, type, rows)).join("");
  return `<section class="card dashboard-section"><div class="section-heading"><div><span class="eyebrow">Campus insights</span><h3>Report statistics</h3></div></div><div class="analytics-grid">${cards}</div><p class="analytics-note">All charts use submitted campus reports only.</p></section>`;
}

const chartColors = ["#0f766e", "#f59e0b", "#5473c8", "#db6574", "#2f9e75"];
function chartLegend(rows) {
  return `<ul class="chart-legend">${rows.map(([label, count], index) => `<li><span class="chart-dot" style="--chart-color:${chartColors[index % chartColors.length]}"></span><span>${esc(label)}</span><b>${count}</b></li>`).join("")}</ul>`;
}
function analyticsCard(title, kind, type, rows) {
  if (!rows.length) {
    return `<article class="analytics-card"><div class="analytics-card-head"><h4>${title}</h4><span class="chart-type">${kind}</span></div>${dashboardEmpty("No report data yet.", "New reports will appear here.", "search")}</article>`;
  }
  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  const description = `${title}: ${rows.map(([label, count]) => `${label}, ${count}`).join("; ")}`;
  let chart;
  if (type === "bar") {
    const max = Math.max(...rows.map(([, count]) => count), 1);
    chart = `<div class="chart-bars" role="img" aria-label="${esc(description)}">${rows.map(([label, count]) => `<div class="chart-bar-row"><span>${esc(label)}</span><span class="chart-bar-track"><i style="width:${Math.round(count / max * 100)}%"></i></span><b>${count}</b></div>`).join("")}</div>`;
  } else if (type === "line") {
    const max = Math.max(...rows.map(([, count]) => count), 1);
    const points = rows.map(([, count], index) => `${14 + index * 292 / Math.max(rows.length - 1, 1)},${108 - count / max * 82}`);
    chart = `<div class="chart-line-wrap" role="img" aria-label="${esc(description)}"><svg viewBox="0 0 320 126" aria-hidden="true"><path class="chart-gridlines" d="M14 26H306M14 67H306M14 108H306"/><polyline class="chart-line" points="${points.join(" ")}"/>${points.map(point => { const [x, y] = point.split(","); return `<circle cx="${x}" cy="${y}" r="3"/>`; }).join("")}</svg><div class="chart-axis">${rows.map(([label]) => `<span>${esc(label)}</span>`).join("")}</div></div>${chartLegend(rows)}`;
  } else {
    let end = 0;
    const slices = rows.map(([, count], index) => {
      const start = end;
      end += count / total * 100;
      return `${chartColors[index % chartColors.length]} ${start}% ${end}%`;
    }).join(", ");
    chart = `<div class="chart-pie-wrap"><div class="chart-pie ${type}" style="--chart-parts:conic-gradient(${slices})" role="img" aria-label="${esc(description)}">${type === "donut" ? `<span class="chart-total"><b>${total}</b><small>reports</small></span>` : ""}</div>${chartLegend(rows)}</div>`;
  }
  return `<article class="analytics-card"><div class="analytics-card-head"><h4>${title}</h4><span class="chart-type">${kind}</span></div>${chart}</article>`;
}

function dashboardEmpty(title, suggestion, icon = "box") {
  const icons = {
    box: '<path d="m3 7 9-4 9 4v10l-9 4-9-4z"/><path d="m3 7 9 4 9-4M12 11v10"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1m1-14a3 3 0 0 1 0 6m2 2a5 5 0 0 1 3 5"/>',
    task: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8m-8 4h5"/>'
  };
  return `<div class="dashboard-empty" role="status"><span class="dashboard-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24">${icons[icon] || icons.box}</svg></span><strong>${title}</strong><p>${suggestion}</p></div>`;
}

const statGlyphs = {
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1m1-14a3 3 0 0 1 0 6m2 2a5 5 0 0 1 3 5"/>',
  staff: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M6 16a3 3 0 0 1 6 0m3-5h3m-3 3h3"/>',
  reports: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5m-9 4h5m-5 4h5"/>',
  open: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  issue: '<path d="m12 3 10 18H2z"/><path d="M12 9v5m0 3h.01"/>',
  votes: '<path d="M7 10v11H3V10zm0 10h10a2 2 0 0 0 2-2l1-6a2 2 0 0 0-2-2h-6l1-4-1-2-5 6"/>',
  claim: '<path d="m12 3 8 4v5c0 5-3.5 8-8 10-4.5-2-8-5-8-10V7z"/><path d="m9 12 2 2 4-4"/>',
  overdue: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M5 3 3 5m16-2 2 2"/>'
};
function adminStatCard({ label, value, hint, icon, href, action, filter, tone }) {
  const filterAttribute = filter ? ` data-admin-report-filter="${filter}"` : "";
  return `<a class="card stat dashboard-stat-link" href="${href}"${filterAttribute}><span class="dashboard-stat-top"><span class="small">${label}</span><span class="dashboard-stat-icon ${tone || ""}" aria-hidden="true"><svg viewBox="0 0 24 24">${statGlyphs[icon]}</svg></span></span><strong>${value}</strong><span class="stat-hint">${hint}</span><span class="stat-link-hint"><span>${action}</span> →</span></a>`;
}
function adminStatCards(open, issues, votes, pendingClaims, overdueReports) {
  return [
    ["Campus users", totalCampusUsers, "Active student and staff accounts", "users", "#admin-campus-users", "View users"],
    ["Active staff", activeStaff.length, "Available for assigned work", "staff", "#admin-active-staff", "View staff"],
    ["Total reports", state.reports.length, "Items and campus issues", "reports", "#admin-report-review", "View reports", "all"],
    ["Open reports", open, "Still need a decision or action", "open", "#admin-report-review", "View open reports", "open"],
    ["Campus issues", issues, "Reported for campus follow-up", "issue", "#admin-report-review", "View issues", "issues"],
    ["Upvotes", votes, "Community priority signals", "votes", "#admin-report-review", "View voted issues", "upvotes"],
    ["Claims to review", pendingClaims.length, "Waiting for your decision", "claim", "#admin-report-review", "Review claims", "claims", "warning"],
    ["Overdue issues", overdueReports.length, "High-priority follow-up needed", "overdue", "#admin-report-review", "View overdue", "overdue", "alert"]
  ].map(([label, value, hint, icon, href, action, filter, tone]) =>
    adminStatCard({ label, value, hint, icon, href, action, filter, tone })).join("");
}

const pages = {
  auth: mode => mode === "register"
    ? `<section class="auth-shell"><form id="register-form" class="card auth-form"><img class="login-logo" src="/assets/images/logo-transparent.png" alt="LostTrack logo"><h2>Create account</h2><label>Full name<input name="name" type="text" placeholder="Your name" required minlength="2" maxlength="80" autocomplete="name"></label><label>University email<input name="email" type="email" placeholder="you@uftb.ac.bd" required autocomplete="email"></label><label>Account type<select name="role" required><option value="user">Student (active now)</option><option value="staff">Staff (approval required)</option></select></label><label>Password<span class="password-field"><input id="register-password" name="password" type="password" placeholder="Create a strong password" required minlength="12" autocomplete="new-password"><button type="button" class="password-toggle" data-password-toggle="register-password" aria-label="Show password">Show</button></span><span id="password-strength" class="password-strength">12+ characters, upper/lowercase, number and symbol</span></label><p class="small privacy-note" data-retention-message="registration"></p><label class="check"><input name="privacyConsent" type="checkbox" required> I have read and consent to this privacy notice.</label><div id="register-error" class="form-error"></div><button class="btn" type="submit">Create account</button><button class="btn ghost" type="button" data-auth="login">Already have an account? Sign in</button></form></section>`
    : `<section class="auth-shell"><form id="login-form" class="card auth-form"><img class="login-logo" src="/assets/images/logo-transparent.png" alt="LostTrack logo"><h2>Sign in</h2><label>University email<input name="email" type="email" placeholder="you@uftb.ac.bd" required autocomplete="email"></label><label>Password<span class="password-field"><input id="login-password" name="password" type="password" placeholder="Your password" required autocomplete="current-password"><button type="button" class="password-toggle" data-password-toggle="login-password" aria-label="Show password">Show</button></span></label><div id="login-error" class="form-error"></div><button class="btn" type="submit">Sign in</button><div class="auth-links"><button class="btn ghost" type="button" data-auth="register">Create a new account</button></div></form></section>`,
  home: () => {
    const mine = state.reports.filter(report => report.createdBy === session.id);
    const openMine = mine.filter(report => ["Open", "Found"].includes(report.status)).length;
    const myClaims = state.claims.filter(claim => claim.claimantId === session.id)
      .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
    const pendingClaims = myClaims.filter(claim => claim.status === "Pending review").length;
    const claimsNeedingInfo = myClaims.filter(claim => claim.status === "Needs more information").length;
    const items = portalItemList();
    const issues = state.reports.filter(report => report.type === "issue");
    const boardLabel = role === "user" ? "Student dashboard" : "Campus board";
    return `<div class="portal-screen">
      <p class="role-dashboard-label">${boardLabel}</p>
      <section class="campus-hero portal-hero"><div class="portal-hero-copy"><span class="campus-pill">Blind Verification active · Secure campus returns</span><h2>Lost something?<br><em>Find it on campus.</em></h2><p>Search reports, claim safely with blind verification and track every status in one place.</p><div class="portal-hero-search"><input id="portal-search" type="search" placeholder="Search “black backpack, library...”" aria-label="Search campus reports"><button id="portal-search-submit" class="btn amber" type="button">Search</button></div><div class="portal-quick-filters" aria-label="Filter campus reports"><button type="button" class="active" data-quick-filter="all">All</button><button type="button" data-quick-filter="lost">Lost</button><button type="button" data-quick-filter="found">Found</button><button type="button" data-quick-filter="issues">Issues</button></div><div class="hero-actions"><a class="btn" href="#new" data-page="new" data-report-kind="lost">Report item (Lost/Found)</a><a class="btn amber" href="#new" data-page="new" data-report-kind="issue">Report campus issue</a></div></div><div class="portal-hero-showcase"><div class="portal-hero-showcase-head"><div><span class="eyebrow">Campus board</span><h3>Recent reports</h3></div><span class="portal-live-badge">Live reports</span></div><div class="portal-hero-preview-grid">${items.slice(0, 4).map(portalHeroCard).join("") || `<div class="portal-hero-empty"><strong>No Lost &amp; Found reports yet</strong><span>New campus reports will appear here.</span><a class="dashboard-text-link" href="#new" data-page="new">Create the first report →</a></div>`}</div><p class="portal-hero-caption">Private ownership clues are never shown on the campus board.</p></div></section>
      <span class="visually-hidden" id="portal-tablist-label">Campus board sections</span>
      <div class="portal-tabs" role="tablist" aria-labelledby="portal-tablist-label">
        <button type="button" id="portal-tab-items" role="tab" aria-selected="${portalTab === "items"}" aria-controls="portal-items" tabindex="${portalTab === "items" ? "0" : "-1"}" class="portal-tab ${portalTab === "items" ? "active" : ""}" data-portal-tab="items">Lost &amp; Found items</button>
        <button type="button" id="portal-tab-issues" role="tab" aria-selected="${portalTab === "issues"}" aria-controls="portal-issues" tabindex="${portalTab === "issues" ? "0" : "-1"}" class="portal-tab ${portalTab === "issues" ? "active" : ""}" data-portal-tab="issues">Campus environmental issues <b>${issues.length}</b></button>
        <button type="button" id="portal-tab-activity" role="tab" aria-selected="${portalTab === "activity"}" aria-controls="portal-activity" tabindex="${portalTab === "activity" ? "0" : "-1"}" class="portal-tab ${portalTab === "activity" ? "active" : ""}" data-portal-tab="activity">My activity &amp; claims</button>
      </div>
      <section id="portal-items" class="portal-panel ${portalTab === "items" ? "" : "hidden"}" role="tabpanel" aria-labelledby="portal-tab-items" tabindex="0">
        <div class="portal-toolbar">
          <select id="portal-type" aria-label="Item type"><option value="">All types (Lost &amp; Found)</option><option value="found">Found only</option><option value="lost">Lost only</option></select>
          <select id="portal-category" aria-label="Category">${categoryOptions(allCategories, true)}</select>
          <select id="portal-status" aria-label="Status"><option value="">All statuses</option><option>Open</option><option>Found</option><option>Returned</option><option>Resolved</option></select>
        </div>
        <div id="portal-item-grid" class="portal-grid">${items.length ? items.map(portalItemCard).join("") : `<div class="card empty"><h3>No items yet</h3><p>Report a lost or found item to see it here.</p></div>`}</div>
      </section>
      <section id="portal-issues" class="portal-panel ${portalTab === "issues" ? "" : "hidden"}" role="tabpanel" aria-labelledby="portal-tab-issues" tabindex="0">
        <div class="notice">Upvotes are a signal only. Suggested priority uses severity, votes, safety and age. An administrator sets the final priority.</div>
        <div id="portal-issue-grid" class="portal-issue-grid">${issues.length ? issues.map(portalIssueCard).join("") : `<div class="card empty"><h3>No campus issues yet</h3><p>Report a bin, drain or waste problem to start the queue.</p></div>`}</div>
      </section>
      <section id="portal-activity" class="portal-panel ${portalTab === "activity" ? "" : "hidden"}" role="tabpanel" aria-labelledby="portal-tab-activity" tabindex="0">
        <div class="portal-activity-links"><a class="btn ghost" href="#notifications" data-page="notifications">Notifications${unread() ? ` (${unread()})` : ""}</a><a class="btn ghost" href="#my-reports" data-page="my-reports">My reports</a>${role === "staff" ? `<a class="btn ghost" href="#my-tasks" data-page="my-tasks">My tasks</a>` : ""}<a class="btn ghost" href="#reports" data-page="reports">Map view</a></div>
      <div class="stats dashboard-stats">
        <div class="card stat"><span class="small">My reports</span><strong>${mine.length}</strong><span class="stat-hint">Reports you submitted</span></div>
        <div class="card stat"><span class="small">Needs attention</span><strong>${openMine}</strong><span class="stat-hint">Open reports and found items awaiting return</span></div>
        <div class="card stat"><span class="small">My claims</span><strong>${myClaims.length}</strong><span class="stat-hint"><b>${pendingClaims}</b> <span>awaiting review</span>${claimsNeedingInfo ? ` · <b>${claimsNeedingInfo}</b> <span>need your reply</span>` : ""}</span></div>
        <div class="card stat"><span class="small">New alerts</span><strong>${unread()}</strong><span class="stat-hint">Updates from your campus</span></div>
      </div>
      <div class="user-dashboard-grid">
        <section class="card dashboard-section"><div class="section-heading"><div><span class="eyebrow">Your activity</span><h3>Recent reports</h3></div><a class="dashboard-text-link" href="#my-reports" data-page="my-reports">View all</a></div><div class="report-list dashboard-report-list">${mine.length ? reportCards(mine.slice(0, 4)) : `<div class="empty-message">You have not submitted a report yet.</div>`}</div></section>
        <section class="card dashboard-section quick-actions"><div class="section-heading"><div><span class="eyebrow">Get started</span><h3>Quick actions</h3></div></div><a class="quick-action" href="#reports" data-page="reports"><span class="quick-action-icon">01</span><span><strong>Browse campus reports</strong><small>Search for lost items and current issues</small></span><b aria-hidden="true">→</b></a><a class="quick-action" href="#new" data-page="new"><span class="quick-action-icon">02</span><span><strong>Share an update</strong><small>Report a found item or campus issue</small></span><b aria-hidden="true">→</b></a><a class="quick-action" href="#notifications" data-page="notifications"><span class="quick-action-icon">03</span><span><strong>Check notifications</strong><small>See claim decisions and report updates</small></span><b aria-hidden="true">→</b></a><div class="dashboard-note">Private ownership clues are reviewed by administrators only.</div></section>
      </div>
      <section class="card dashboard-section claim-tracker"><div class="section-heading"><div><span class="eyebrow">Ownership updates</span><h3>My claims</h3></div><span class="tag ${claimsNeedingInfo ? "amber" : "gray"}">${claimsNeedingInfo ? `<b>${claimsNeedingInfo}</b> <span>need your reply</span>` : `<b>${myClaims.length}</b> <span>total</span>`}</span></div>${myClaims.length ? `<div class="claim-tracker-list">${myClaims.slice(0, 4).map(claim => {
        const report = getReport(claim.reportId);
        const needsInfo = claim.status === "Needs more information";
        const tone = claim.status === "Pending review" || needsInfo ? "amber" : claim.status === "Rejected" ? "red" : "gray";
        return `<div class="claim-tracker-row"><div class="claim-tracker-main"><strong>${esc(report?.title || "Found item")}</strong><small>${report ? esc(report.place) : "Item report no longer available"} · <span>Attempt</span> ${Number(claim.attemptNo) || 1}</small></div><span class="tag ${tone}">${esc(claim.status)}</span>${needsInfo && report ? `<button class="btn secondary continue-claim" data-id="${esc(report.id)}" data-claim="${esc(claim.id)}">Provide more information</button>` : ""}</div>`;
      }).join("")}</div>` : `<div class="empty-message">Your ownership claims and their review status will appear here.</div>`}</section>
      </section>
    </div>`;
  },

  reports: () => `<div class="page-head"><div><span class="eyebrow">${role === "admin" ? "Administration" : "Community board"}</span><h2>${role === "admin" ? "All reports" : "Browse reports"}</h2><p>${role === "admin" ? "Review and manage campus reports." : "Search lost items, found items and campus issues."}</p></div>${role !== "admin" ? `<a class="btn" href="#new" data-page="new">+ New report</a>` : ""}</div><div class="filters"><label class="visually-hidden" for="search">Search title or description</label><input id="search" placeholder="Search title or description"><label class="visually-hidden" for="location-filter">Campus location</label><input id="location-filter" placeholder="Campus location"><label class="visually-hidden" for="kind">Filter by report type</label><select id="kind"><option value="">All types</option><option value="lost">Lost items</option><option value="found">Found items</option><option value="issue">Campus issues</option></select><label class="visually-hidden" for="category">Filter by category</label><select id="category">${categoryOptions(allCategories, true)}</select><label class="visually-hidden" for="color-filter">Filter by colour</label><input id="color-filter" placeholder="Colour"><label class="visually-hidden" for="date-filter">Filter by date</label><input id="date-filter" type="date"><label class="visually-hidden" for="status">Filter by status</label><select id="status"><option value="">All statuses</option><option>Open</option><option>Found</option><option>Resolved</option><option>Returned</option><option>Merged</option></select></div><section class="card dashboard-section location-map-panel"><div class="section-heading"><div><span class="eyebrow">Bangladesh locations</span><h3>Report map</h3></div><span id="reports-map-count" class="small">Loading map…</span></div><div id="reports-map" class="location-map" role="region" aria-label="Map of Bangladesh report locations"></div><div class="map-legend"><span><i class="map-legend-dot lost"></i>Lost items</span><span><i class="map-legend-dot found"></i>Found items</span><span><i class="map-legend-dot issue"></i>Campus issues</span></div><p id="reports-map-status" class="small map-status">Reports with pins inside Bangladesh appear on this map. Map labels are in English.</p></section><div id="report-list" class="report-list">${reportCards(state.reports, role === "admin")}</div>`,
  "my-reports": () => {
    const mine = state.reports.filter(report => report.createdBy === session.id);
    return `<div class="page-head"><div><span class="eyebrow">Your activity</span><h2>My reports</h2><p>Track status and history for reports you submitted.</p></div><a class="btn" href="#new" data-page="new">+ New report</a></div><div class="report-list">${mine.length ? reportCards(mine) : `<div class="card empty"><h3>No reports submitted yet</h3><p>Your reports will appear here after you publish one.</p></div>`}</div>`;
  },

  new: () => `<div class="page-head"><div><span class="eyebrow">Quick and clear</span><h2>Create a report</h2><p>Only share the information needed to help your campus.</p></div></div><form id="report-form" class="card form"><label>Report type<select name="type" id="report-type"><option value="lost">I lost an item</option><option value="found">I found an item</option><option value="issue">Campus issue</option></select></label><div class="two"><label>Title<input name="title" required maxlength="120" placeholder="e.g. Black wallet"></label><label>Category<select name="category">${categoryOptions(allCategories)}</select></label></div><div class="two"><label>Location<div class="location-autocomplete"><input name="place" id="report-place" required maxlength="160" placeholder="Search or enter a Bangladesh location" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="place-suggestions"><div id="place-suggestions" class="place-suggestions hidden" role="listbox" aria-label="Suggested locations"></div></div><span class="small">Choose a Bangladesh location or enter another place.</span></label><label>Date<input name="date" type="date" value="${today()}" required></label></div><section class="map-picker"><div class="section-heading"><div><h3>Choose a Bangladesh location (optional)</h3><p class="small">Click inside Bangladesh to add a pin.</p></div><button type="button" id="clear-location-pin" class="btn ghost">Clear pin</button></div><div id="location-picker-map" class="location-map" role="application" aria-label="Select a location in Bangladesh"></div><p id="location-pin-status" class="small map-status">Search or enter a Bangladesh location above, then optionally add its map pin.</p><p class="small map-status">Chosen pins are visible to signed-in campus users. Do not pin private or residential places.</p><p id="location-map-status" class="small map-status">English-language map tiles by Esri.</p><input type="hidden" name="latitude"><input type="hidden" name="longitude"></section><div class="two item-only"><label>Colour<input name="color" maxlength="40" placeholder="e.g. Black"></label><label>Photos<input name="photos" type="file" accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp" multiple></label></div><p class="small photo-guidance">Add up to 3 JPG, PNG or WebP photos, max 2 MB each. Use item or issue photos only; do not upload faces, IDs, receipts, or personal contact details.</p><div class="actions"><button type="button" class="btn ghost" id="clear-photos">Clear selected photos</button></div><div id="photo-error" class="form-error" role="alert"></div><div id="photo-previews" class="photo-previews" aria-live="polite"></div><div class="two issue-only hidden"><label>Severity<select name="severity"><option>Low</option><option selected>Medium</option><option>High</option></select></label><label class="check"><input name="safetyRisk" type="checkbox"> Safety hazard</label></div><label>Description<textarea name="text" required maxlength="2000" placeholder="Add useful details. Do not include private contact or identity information."></textarea><label class="check"><input name="consent" type="checkbox" required> <span data-retention-message="report"></span></label><div id="duplicate-suggestions" class="notice hidden"></div><div id="report-error" class="form-error"></div><div id="draft-note" class="small"></div><div class="actions"><button class="btn">Publish report</button><button type="button" class="btn ghost" id="save-draft">Save draft</button><a class="btn ghost" href="#home" data-page="home">Cancel</a></div></form>`,

  notifications: () => `<div class="page-head"><div><span class="eyebrow">Activity center</span><h2>Notifications</h2><p>Claim decisions, report updates and task changes appear here.</p></div><button class="btn ghost" id="read-all">Mark all read</button></div><div class="card notification-list">${state.notifications.length ? state.notifications.map(n => `<div class="notification ${n.read ? "" : "unread"}"><span>${n.read ? "OK" : "NEW"}</span><div>${esc(n.text)}<small>${n.read ? "Read" : "Unread"}</small></div>${n.refId && getReport(n.refId) ? `<button class="btn ghost open-notification" data-id="${esc(n.id)}" data-ref="${esc(n.refId)}">Open report</button>` : ""}</div>`).join("") : "<p>No notifications yet.</p>"}</div>`,
  "my-tasks": () => {
    const assigned = state.tasks.filter(task => task.assigneeEmail === session.email);
    return `<div class="page-head"><div><span class="eyebrow">Staff workspace</span><h2>My assigned tasks</h2><p>Update work assigned specifically to your staff account.</p></div></div><div class="task-list">${assigned.length ? tasks(assigned) : `<div class="card empty"><h3>No tasks assigned</h3><p>Tasks assigned to your account will appear here.</p></div>`}</div>`;
  },

  dashboard: () => {
    if (role === "staff") return staffDashboard();
    const open = state.reports.filter(r => r.status === "Open").length;
    const issues = state.reports.filter(r => r.type === "issue").length;
    const votes = state.reports.reduce((total, report) => total + report.votes, 0);
    const isAdmin = role === "admin";
    const myTasks = state.tasks.filter(task => task.assigneeEmail === session.email);
    const activeCampusUsers = (state.accounts || []).filter(account => account.role !== "admin" && account.status === "active");
    const pendingClaims = state.claims.filter(claim => claim.status === "Pending review");
    const nextClaim = pendingClaims[0];
    const nextClaimReport = nextClaim && state.reports.find(report => String(report.id) === String(nextClaim.reportId));
    const nextClaimClue = nextClaimReport && getPrivateClue(nextClaimReport.id);
    const overdueReports = state.reports.filter(report => report.type === "issue" && priorityFor(report).overdue);
    const activeTasks = state.tasks.filter(task => task.status !== "Completed");
    const inProgressTasks = myTasks.filter(task => task.status === "In progress").length;
    const completedTasks = myTasks.filter(task => task.status === "Completed").length;
    return `<div class="${isAdmin ? "main-admin-dashboard" : "staff-dashboard"} dashboard-shell">
      <div class="page-head dashboard-head"><div><span class="eyebrow">${isAdmin ? "Main administrator control room" : "Staff workspace"}</span><h2>${isAdmin ? "Main Admin dashboard" : "Staff dashboard"}</h2><p>${isAdmin ? "Approve accounts, review claims, set priorities and assign work." : "Update assigned maintenance tasks without seeing private claim clues."}</p></div>${isAdmin ? `<span class="dashboard-role-badge">Administrator</span>` : `<a class="btn dashboard-primary" href="#my-tasks" data-page="my-tasks">View my tasks</a>`}</div>
      <div class="stats dashboard-stats">${isAdmin ? adminStatCards(open, issues, votes, pendingClaims, overdueReports) : `<div class="card stat"><span class="small">My tasks</span><strong>${myTasks.length}</strong><span class="stat-hint">All work assigned to you</span></div><div class="card stat"><span class="small">Assigned</span><strong>${myTasks.filter(task => task.status === "Assigned").length}</strong><span class="stat-hint">Ready to start</span></div><div class="card stat"><span class="small">In progress</span><strong>${inProgressTasks}</strong><span class="stat-hint">Currently being handled</span></div><div class="card stat"><span class="small">Completed</span><strong>${completedTasks}</strong><span class="stat-hint">Submitted for admin review</span></div>`}</div>
      ${isAdmin ? `<div class="notice admin-guidance">Suggested priority combines votes, severity, safety and age. Admin overrides always need a reason.</div>
      <div class="admin-overview-grid"><section class="card dashboard-section priority-queue"><div class="section-heading"><div><span class="eyebrow">Explainable priority</span><h3>Campus issue queue</h3></div><span class="small">Highest suggested score first</span></div>${(() => {
        const queue = state.reports.filter(report => report.type === "issue" && !["Resolved", "Merged"].includes(report.status))
          .map(report => ({ report, priority: priorityFor(report) }))
          .sort((a, b) => b.priority.score - a.priority.score);
        return queue.length ? `<div class="priority-table">${queue.map(({ report, priority }) => `<a class="priority-row" href="#report-card-${esc(encodeURIComponent(report.id))}"><span><strong>${esc(report.title)}</strong><small>${esc(report.place)} · <span>${esc(report.priority)}</span></small></span><span class="priority-score">${priority.score}<small>/100 ${esc(priority.suggested)}</small></span>${priority.overdue ? `<span class="tag red">Overdue</span>` : `<span class="tag gray">${esc(report.status)}</span>`}</a>`).join("")}</div>` : dashboardEmpty("No open campus issues.", "New environmental reports will appear here by suggested score.", "search");
      })()}</section><section class="card dashboard-section blind-review-panel"><div class="section-heading"><div><span class="eyebrow">Blind verification</span><h3>Claim review</h3></div><span class="tag ${pendingClaims.length ? "amber" : "gray"}"><b>${pendingClaims.length}</b> <span>pending</span></span></div>${nextClaim && nextClaimReport ? `<div class="blind-review-item"><div class="blind-review-title"><strong>${esc(nextClaimReport.title)}</strong><span><span>Attempt</span> ${Number(nextClaim.attemptNo) || 1} <span>of 3</span></span></div><div class="blind-review-comparison"><div><small>Private clue</small><p>${esc(nextClaimClue?.clue || "No private clue recorded yet.")}</p></div><div><small>Claimant's detail</small><p>${esc(nextClaim.detail || "No claim detail supplied.")}</p></div></div><p class="small">Compare privately. A match is a suggestion, not proof; check identity in person at handover.</p><a class="btn" href="#admin-report-review" data-admin-report-filter="claims">Review claim</a></div>` : dashboardEmpty("No claims are waiting for review.", "New claims will appear here for private review.", "box")}</section></div>
      <section class="card dashboard-section admin-action-center"><div class="section-heading"><div><span class="eyebrow">Admin work queue</span><h3>Needs your attention</h3></div><span class="tag ${pendingClaims.length + overdueReports.length + pendingAccounts.length ? "amber" : "gray"}"><b>${pendingClaims.length + overdueReports.length + pendingAccounts.length}</b> <span>urgent actions</span></span></div><div class="admin-queue-list">
        <a class="admin-queue-item" href="${pendingClaims[0] ? `#report-card-${esc(encodeURIComponent(pendingClaims[0].reportId))}` : "#admin-report-review"}"><span class="admin-queue-icon">01</span><span><strong>Review ownership claims</strong><small>${pendingClaims.length ? `<b>${pendingClaims.length}</b> <span>waiting for a decision</span>` : "No pending claims"}</small></span><b>${pendingClaims.length}</b></a>
        <a class="admin-queue-item" href="${overdueReports[0] ? `#report-card-${esc(encodeURIComponent(overdueReports[0].id))}` : "#admin-report-review"}"><span class="admin-queue-icon">02</span><span><strong>Check overdue issues</strong><small>${overdueReports.length ? "High-priority issues need follow-up" : "No overdue issues"}</small></span><b>${overdueReports.length}</b></a>
        <a class="admin-queue-item" href="#admin-approvals"><span class="admin-queue-icon">03</span><span><strong>Approve staff accounts</strong><small>${pendingAccounts.length ? "Review access requests" : "No requests waiting"}</small></span><b>${pendingAccounts.length}</b></a>
        <a class="admin-queue-item" href="#admin-tasks"><span class="admin-queue-icon">04</span><span><strong>Track maintenance work</strong><small>${activeTasks.length ? "Assigned or in-progress tasks" : "All tasks completed"}</small></span><b>${activeTasks.length}</b></a>
      </div></section>${analyticsPanel()}
      <section id="admin-approvals" class="card dashboard-section account-approval"><div class="section-heading"><div><span class="eyebrow">Access management</span><h3>Pending account approvals</h3></div>${tag(`${pendingAccounts.length} pending`, pendingAccounts.length ? "amber" : "gray")}</div>${pendingAccounts.length ? `<div class="approval-list">${pendingAccounts.map(account => `<div class="approval-row"><div><strong>${esc(account.name)}</strong><small>${esc(account.email)} · ${account.requestedRole === "staff" ? "Staff" : "Administrator"}</small></div><button class="btn secondary approve-account" data-email="${esc(account.email)}">Approve</button></div>`).join("")}</div>` : dashboardEmpty("No pending Staff accounts.", "New approval requests will appear here.", "users")}<div id="admin-campus-users" class="active-staff-list"><div class="section-heading"><h4>Active campus users</h4>${tag(`${totalCampusUsers} users`, "gray")}</div>${activeCampusUsers.length ? activeCampusUsers.map(account => `<div class="staff-summary"><span>${esc(account.name)} <small>${account.role === "staff" ? "Staff" : "Student"}</small></span><small>${esc(account.email)}</small></div>`).join("") : dashboardEmpty("No active campus users.", "Approved campus accounts will appear here.", "users")}</div><div id="admin-active-staff" class="active-staff-list"><div class="section-heading"><h4>Active staff</h4>${tag(`${activeStaff.length} staff`, "gray")}</div>${activeStaff.length ? activeStaff.map(account => `<div class="staff-summary"><span>${esc(account.name)}</span><small>${esc(account.email)}</small></div>`).join("") : dashboardEmpty("No Staff accounts approved yet.", "Approve a Staff account before assigning work.", "users")}</div></section>` : ""}
      <section id="admin-report-review" class="card dashboard-section"><div class="section-heading"><div><span class="eyebrow">${isAdmin ? "Review queue" : "Campus activity"}</span><h3>${isAdmin ? "Report review" : "Visible reports"}</h3></div><div class="dashboard-report-controls"><span id="admin-report-filter-label" class="small">Showing all reports</span>${isAdmin ? `<button type="button" class="btn ghost" data-admin-report-filter="all">Show all</button>` : ""}</div></div><div id="admin-dashboard-report-list" class="report-list dashboard-report-list">${reportCards(state.reports, isAdmin)}</div></section>
      <div class="dashboard-bottom"><section id="admin-tasks" class="card dashboard-section"><div class="section-heading"><div><span class="eyebrow">Work tracking</span><h3>${isAdmin ? "Maintenance tasks" : "My assigned tasks"}</h3></div>${tag(`${isAdmin ? state.tasks.length : state.tasks.filter(task => task.assigneeEmail === session.email).length} tasks`, "gray")}</div><div class="task-list">${tasks(isAdmin ? state.tasks : state.tasks.filter(task => task.assigneeEmail === session.email))}</div></section>
      ${isAdmin ? `<section class="card dashboard-section"><div class="section-heading"><div><span class="eyebrow">Administration</span><h3>Data tools</h3></div></div><p class="small">Export a backup or clear cached data from this device.</p><div class="dashboard-tools"><button class="btn ghost" id="export-data">Export JSON</button><button class="btn danger" id="reset-data">Clear local cache</button></div></section>` : ""}</div>
    </div>`;
  },
};

function staffDashboard() {
  const myTasks = state.tasks.filter(task => task.assigneeEmail === session.email);
  const issues = state.reports.filter(report => report.type === "issue" && !["Resolved", "Merged"].includes(report.status));
  return `<div class="staff-dashboard dashboard-shell">
    <div class="page-head dashboard-head"><div><span class="eyebrow">Staff workspace</span><h2>Staff dashboard</h2><p>Update the maintenance tasks assigned to you and follow open campus issues. Private ownership clues stay with administrators.</p></div><span class="dashboard-role-badge">Staff</span></div>
    <div class="stats dashboard-stats">
      <div class="card stat"><span class="small">My tasks</span><strong>${myTasks.length}</strong><span class="stat-hint">All work assigned to you</span></div>
      <div class="card stat"><span class="small">Assigned</span><strong>${myTasks.filter(task => task.status === "Assigned").length}</strong><span class="stat-hint">Ready to start</span></div>
      <div class="card stat"><span class="small">In progress</span><strong>${myTasks.filter(task => task.status === "In progress").length}</strong><span class="stat-hint">Currently being handled</span></div>
      <div class="card stat"><span class="small">Completed</span><strong>${myTasks.filter(task => task.status === "Completed").length}</strong><span class="stat-hint">Submitted for admin review</span></div>
    </div>
    <section class="card dashboard-section"><div class="section-heading"><div><span class="eyebrow">Your work</span><h3>Assigned tasks</h3></div></div><div class="task-list">${myTasks.length ? tasks(myTasks) : `<div class="empty-message">No tasks assigned. An administrator will assign campus work to your account.</div>`}</div></section>
    <section class="card dashboard-section"><div class="section-heading"><div><span class="eyebrow">Campus follow-up</span><h3>Open environmental issues</h3></div><a class="btn amber" href="#new" data-page="new" data-report-kind="issue">Report campus issue</a></div>
      <div class="portal-issue-grid">${issues.length ? issues.map(portalIssueCard).join("") : `<div class="card empty"><h3>No open campus issues</h3><p>New environmental reports will appear here.</p></div>`}</div>
    </section>
    <div class="portal-activity-links"><a class="btn ghost" href="#home" data-page="home">Campus lost and found</a><a class="btn ghost" href="#my-reports" data-page="my-reports">My reports</a><a class="btn ghost" href="#notifications" data-page="notifications">Notifications${unread() ? ` (${unread()})` : ""}</a></div>
  </div>`;
}
function portalItemList() {
  const rank = { Found: 0, Open: 1, Returned: 2, Resolved: 3, Merged: 4 };
  return state.reports.filter(report => report.type !== "issue").sort((a, b) =>
    (rank[a.status] ?? 5) - (rank[b.status] ?? 5) || String(b.date || "").localeCompare(String(a.date || "")));
}
function portalHeroCard(report) {
  return `<a class="portal-hero-card" href="#reports" data-page="reports" data-report-focus="${esc(report.id)}"><span class="portal-hero-card-icon ${esc(report.type)}">${icon(report.type)}</span><span class="portal-hero-card-status">${esc(report.status)}</span><strong>${esc(report.title)}</strong><small>${esc(report.place)} · ${esc(report.date)}</small></a>`;
}
function possibleMatches(report, limit = 3) {
  if (report.type === "issue") return [];
  const isLost = report.type === "lost";
  return state.reports.filter(candidate => candidate.type === (isLost ? "found" : "lost"))
    .map(candidate => ({ report: candidate, result: isLost ? matchScore(report, candidate) : matchScore(candidate, report) }))
    .filter(match => match.result.score >= 50)
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, limit);
}
function portalClaimButton(report) {
  if (report.type !== "found" || report.status !== "Found") return "";
  const myClaims = state.claims.filter(claim => claim.reportId === report.id && claim.claimantId === session.id);
  const latest = myClaims[myClaims.length - 1];
  const reopened = myClaims.some(claim => claim.reopened);
  const limit = reopened ? 4 : 3;
  const canClaim = myClaims.length < limit && (!latest || (latest.status === "Rejected" && (myClaims.length < 3 || latest.reopened)));
  if (latest?.status === "Needs more information") return `<button class="btn secondary continue-claim" data-id="${esc(report.id)}" data-claim="${esc(latest.id)}">Provide more information</button>`;
  if (!canClaim) return "";
  return `<button class="btn claim" data-id="${esc(report.id)}">Claim item</button>`;
}
function portalItemCard(report) {
  const photo = report.photos?.[0];
  const match = possibleMatches(report, 1)[0];
  return `<article class="portal-card">
    <div class="portal-photo">${photo ? `<img src="${esc(photo)}" alt="">` : `<div class="portal-photo-empty">${esc(report.category)}</div>`}
      <span class="portal-type ${esc(report.type)}">${report.type === "found" ? "Found" : "Lost"}</span>
      <span class="portal-status">${esc(report.status)}</span>
    </div>
    <div class="portal-body">
      <h3>${esc(report.title)}</h3>
      <p class="portal-meta"><span>${esc(report.place)}</span><span>${esc(report.date)}</span></p>
      <p class="portal-desc">${esc(report.text)}</p>
      ${match ? `<p class="portal-match">${match.result.score}/100 ${match.result.score >= 75 ? "High" : "Medium"} match · ${match.result.factors.map(factor => `${esc(factor.name)} ${factor.points}/${factor.max}`).join(" · ")}</p>` : ""}
    </div>
    <div class="portal-actions">${portalClaimButton(report)}<button class="btn ghost history-btn" data-id="${esc(report.id)}" title="View history">History</button></div>
    <ol class="history hidden" id="history-${esc(report.id)}">${(report.history || []).map(entry => `<li>${esc(entry)}</li>`).join("")}</ol>
  </article>`;
}
function portalIssueCard(report) {
  const priority = priorityFor(report);
  return `<article class="portal-issue">
    <div class="portal-issue-top"><div><span class="small">${esc(report.category)}</span><h3>${esc(report.title)}</h3><p>${esc(report.place)} · ${esc(report.date)}</p></div>${tag(`${report.priority} priority`, report.priority === "High" ? "red" : "amber")}</div>
    <div class="portal-score"><span>Suggested score</span><strong>${priority.score}/100 · ${esc(priority.suggested)}</strong><div class="portal-score-bar"><i style="width:${priority.score}%"></i></div>${report.possibleDuplicate ? `<p>Possible duplicate</p>` : ""}</div>
    <div class="portal-actions"><button class="btn amber vote" data-id="${esc(report.id)}" ${report.voted ? "disabled" : ""}>${report.voted ? "Upvoted" : "Me too / Upvote"} (${report.votes})</button><span class="small">Status: ${esc(report.status)}</span></div>
  </article>`;
}
function bindPortalFilters() {
  const search = document.querySelector("#portal-search");
  const type = document.querySelector("#portal-type");
  const category = document.querySelector("#portal-category");
  const status = document.querySelector("#portal-status");
  const grid = document.querySelector("#portal-item-grid");
  const issueGrid = document.querySelector("#portal-issue-grid");
  if (!search || !grid) return;
  const activateTab = tab => {
    portalTab = tab;
    document.querySelectorAll("[data-portal-tab]").forEach(button => {
      const selected = button.dataset.portalTab === tab;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelector("#portal-items").classList.toggle("hidden", tab !== "items");
    document.querySelector("#portal-issues").classList.toggle("hidden", tab !== "issues");
    document.querySelector("#portal-activity").classList.toggle("hidden", tab !== "activity");
  };
  const syncQuickFilters = value => {
    document.querySelectorAll("[data-quick-filter]").forEach(button => button.classList.toggle("active", button.dataset.quickFilter === value));
  };
  const apply = () => {
    const query = search.value.trim().toLowerCase();
    const items = portalItemList().filter(report =>
      (!type.value || report.type === type.value)
      && (!category.value || report.category === category.value)
      && (!status.value || report.status === status.value)
      && (!query || `${report.title} ${report.place} ${report.text} ${report.category} ${report.color || ""}`.toLowerCase().includes(query)));
    grid.innerHTML = items.length ? items.map(portalItemCard).join("") : `<div class="card empty"><h3>No matching items</h3><p>Try another word, type or category.</p></div>`;
    const issues = state.reports.filter(report => report.type === "issue"
      && (!category.value || report.category === category.value)
      && (!status.value || report.status === status.value)
      && (!query || `${report.title} ${report.place} ${report.text} ${report.category}`.toLowerCase().includes(query)));
    if (issueGrid) issueGrid.innerHTML = issues.length ? issues.map(portalIssueCard).join("") : `<div class="card empty"><h3>No matching reports</h3><p>Try another search or filter.</p></div>`;
  };
  search.addEventListener("input", apply);
  document.querySelector("#portal-search-submit")?.addEventListener("click", () => {
    apply();
    document.querySelector(portalTab === "issues" ? "#portal-issue-grid" : "#portal-item-grid")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  type.addEventListener("change", () => {
    syncQuickFilters(type.value || "all");
    apply();
  });
  category.addEventListener("change", apply);
  status.addEventListener("change", apply);
  document.querySelectorAll("[data-portal-tab]").forEach(button => {
    button.addEventListener("click", () => activateTab(button.dataset.portalTab));
    button.addEventListener("keydown", event => {
      const tabs = [...document.querySelectorAll("[data-portal-tab]")];
      const index = tabs.indexOf(button);
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home" ? 0
            : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      tabs[next].focus();
      activateTab(tabs[next].dataset.portalTab);
    });
  });
  document.querySelectorAll("[data-quick-filter]").forEach(button => {
    button.addEventListener("click", () => {
      const filter = button.dataset.quickFilter;
      if (filter === "issues") {
        type.value = "";
        activateTab("issues");
      } else {
        type.value = filter === "all" ? "" : filter;
        activateTab("items");
      }
      syncQuickFilters(filter);
      apply();
    });
  });
}
function reportCards(items, admin = false) {
  if (!items.length) return `<div class="card empty">${dashboardEmpty("No reports yet", "New community reports will appear here.", "search")}</div>`;
  return items.map(x => {
    const reportId = esc(x.id);
    const matches = possibleMatches(x);
    const myClaims = state.claims.filter(claim => claim.reportId === x.id && claim.claimantId === session.id);
    const latestMyClaim = myClaims[myClaims.length - 1];
    const claimAttempts = myClaims.length;
    const hasReopenedAttempt = myClaims.some(claim => claim.reopened);
    const claimLimit = hasReopenedAttempt ? 4 : 3;
    const canClaim = claimAttempts < claimLimit && (!latestMyClaim ||
      (latestMyClaim.status === "Rejected" && (claimAttempts < 3 || latestMyClaim.reopened)));
    const nextAttemptLabel = hasReopenedAttempt && claimAttempts === 3
      ? "Make a claim (reopened attempt)"
      : `Make a claim (${claimAttempts + 1}/3)`;
    const privateClue = getPrivateClue(x.id);
    const actions = admin ? adminActions(x)
      : `${x.createdBy === session.id && ["Open", "Found"].includes(x.status) ? `<button class="btn ghost edit-report" data-id="${reportId}">Edit report</button>` : ""}${x.type === "issue" && x.status !== "Resolved" && x.status !== "Merged" ? `<button class="btn secondary vote" data-id="${reportId}" ${x.voted ? "disabled" : ""}>${x.voted ? "Upvoted" : "Upvote"}</button>` : ""}${x.type === "found" && x.status === "Found" && canClaim ? `<button class="btn claim" data-id="${reportId}">${nextAttemptLabel}</button>` : ""}${x.type === "found" && x.status === "Found" && latestMyClaim?.status === "Needs more information" ? `<button class="btn secondary continue-claim" data-id="${reportId}" data-claim="${esc(latestMyClaim.id)}">Provide more information</button>` : ""}<button class="btn ghost history-btn" data-id="${reportId}">View history</button>`;
    const priority = x.type === "issue" ? priorityFor(x) : null;
    const photos = x.photos?.length ? `<div class="report-photos">${x.photos.map(photo => `<img src="${esc(photo)}" alt="Report attachment" loading="lazy">`).join("")}</div>` : "";
    const issueDetails = x.type === "issue"
      ? `<div class="row"><span class="vote-count"><span>Upvotes</span>: <b data-vote-count>${x.votes}</b></span>${tag(x.priority, x.priority === "High" ? "red" : "gray")}</div>${admin ? `<div class="small"><span>Suggested</span>: ${esc(priority.suggested)} (${priority.score}/100) · <span>Severity</span>: <span>${esc(x.severity || "Medium")}</span> · <span>Safety risk</span>: <span>${x.safetyRisk ? "Yes" : "No"}</span></div>` : ""}${x.possibleDuplicate ? `<div class="notice">Possible duplicate report</div>` : ""}`
      : `<span class="small">Possible matches are suggestions only.</span>`;
    const matchCards = matches.map(match => `<div class="match"><strong>${match.result.score}/100 <span>${match.result.score >= 75 ? "High" : "Medium"} possible match</span></strong><br><span class="small">${esc(match.report.title)}</span><div class="match-breakdown">${match.result.factors.map(factor => `<span><b>${esc(factor.name)}</b> ${factor.points}/${factor.max}${factor.name === "Location" && factor.points === 10 ? ` <span class="small">${esc("Nearby campus area")}</span>` : ""}</span>`).join("")}</div><span class="small">Suggestions only; an administrator verifies ownership.</span></div>`).join("");
    const claimCards = admin && x.type === "found"
      ? `<div class="claim-list">${state.claims.filter(claim => String(claim.reportId) === String(x.id)).map(claim => {
        const accountEmail = state.accounts?.find(account => account.id === claim.claimantId)?.email || "Claimant";
        const relatedClaims = state.claims.filter(record => String(record.reportId) === String(x.id) && record.claimantId === claim.claimantId);
        const latestClaim = relatedClaims[relatedClaims.length - 1];
        const attemptsUsed = relatedClaims.length - relatedClaims.filter(record => record.reopened).length;
        const controls = claim.status === "Pending review"
          ? `<button class="btn claim-decision" data-id="${reportId}" data-claim="${esc(claim.id)}" data-decision="Approved">Approve</button><button class="btn danger claim-decision" data-id="${reportId}" data-claim="${esc(claim.id)}" data-decision="Rejected">Reject</button><button class="btn ghost claim-decision" data-id="${reportId}" data-claim="${esc(claim.id)}" data-decision="Needs more information">Request more information</button>`
          : claim.status === "Rejected" && latestClaim?.id === claim.id && attemptsUsed >= 3 && !claim.reopened
            ? `<button class="btn ghost reopen-claim" data-id="${esc(x.id)}" data-claim="${esc(claim.id)}">Reopen one attempt</button>`
            : "";
        return `<div class="notice"><strong>Claim ${claim.attemptNo} · ${esc(claim.status)}</strong><br><span class="small">Trust level: ${esc(claim.trustLevel)} · ${esc(accountEmail)}</span>${claim.trustLevel === "Basic" ? `<p class="small">Verify the campus ID in person before handover. Do not store ID details or images.</p>` : ""}<p>${esc(claim.detail)}</p>${controls}</div>`;
      }).join("")}</div>`
      : "";
    const latestClaim = !admin && x.type === "found" && myClaims.length
      ? `<div class="small">Your latest claim: ${esc(latestMyClaim.status)} · ${claimAttempts}/${claimLimit} attempts</div>`
      : "";
    return `<article id="report-card-${esc(encodeURIComponent(x.id))}" class="card report"><div class="report-top"><div class="icon">${icon(x.type)}</div><div>${tag(typeName(x.type))} ${tag(x.status, x.status === "Open" ? "amber" : "")}${x.pendingSync ? tag("Pending sync", "amber") : ""}${priority?.overdue ? tag("Overdue", "red") : ""}</div></div><div><h3>${esc(x.title)}</h3><span class="small">${esc(x.category)} - ${esc(x.place)} - ${esc(x.date)}</span></div><p>${esc(x.text)}</p>${photos}${issueDetails}${matchCards}${admin && privateClue ? `<div class="notice"><strong>Private clue</strong>: ${esc(privateClue.clue)}</div>` : ""}${claimCards}${latestClaim}<div class="actions">${actions}</div><ol class="history hidden" id="history-${reportId}">${(x.history || []).map(h => `<li>${esc(h)}</li>`).join("")}</ol></article>`;
  }).join("");
}
function adminActions(x) {
  const reportId = esc(x.id);
  const duplicate = x.type === "issue" && x.possibleDuplicate ? duplicateReports(x, x.id)[0] : null;
  return `<button class="btn ghost history-btn" data-id="${reportId}">History</button>${x.status !== "Resolved" && x.status !== "Returned" && x.status !== "Merged" ? `<button class="btn secondary resolve" data-id="${reportId}">Resolve</button>` : ""}${x.type === "found" && x.status === "Found" ? `<button class="btn ghost set-clue" data-id="${reportId}">${getPrivateClue(x.id) ? "Update private clue" : "Record private clue"}</button>` : ""}${x.type === "issue" ? `<button class="btn priority" data-id="${reportId}">Priority</button><button class="btn assign" data-id="${reportId}">Assign</button>${duplicate ? `<button class="btn ghost merge-report" data-id="${reportId}" data-main="${esc(duplicate.id)}">Merge duplicate</button>` : ""}` : ""}${x.type === "found" && state.claims.some(claim => String(claim.reportId) === String(x.id) && claim.status === "Approved") && x.status !== "Returned" ? `<button class="btn returned" data-id="${reportId}">Mark returned</button>` : ""}<button class="btn danger delete-report" data-id="${reportId}">Delete report</button>`;
}
function showAdminDashboardReports(filter) {
  const views = {
    all: { title: "Showing all reports", reports: state.reports },
    open: { title: "Showing open reports", reports: state.reports.filter(report => report.status === "Open") },
    issues: { title: "Showing campus issues", reports: state.reports.filter(report => report.type === "issue") },
    upvotes: { title: "Campus issues ranked by upvotes", reports: state.reports.filter(report => report.type === "issue").sort((a, b) => b.votes - a.votes) },
    claims: { title: "Found items with claims awaiting review", reports: state.reports.filter(report => report.type === "found" && state.claims.some(claim => String(claim.reportId) === String(report.id) && claim.status === "Pending review")) },
    overdue: { title: "Overdue campus issues", reports: state.reports.filter(report => report.type === "issue" && priorityFor(report).overdue) }
  };
  const view = views[filter];
  if (!view) return;
  document.querySelector("#admin-report-filter-label").textContent = view.title;
  document.querySelector("#admin-dashboard-report-list").innerHTML = reportCards(view.reports, true);
  window.LostTrackI18n?.apply();
  document.querySelector("#admin-report-review").scrollIntoView({ behavior: "smooth", block: "start" });
}
function tasks(items = state.tasks) {
  if (!items.length) return `<div class="card empty">${dashboardEmpty("No tasks assigned.", "Tasks assigned to your account will appear here.", "task")}</div>`;
  return items.map(task => {
    const report = getReport(task.reportId);
    const nextLabel = task.status === "Assigned" ? "Start task" : task.status === "In progress" ? "Complete task" : "Completed";
    return `<div class="task card"><div><strong>${esc(task.text)}</strong><small>${esc(task.assignee || task.assigneeEmail)}${report ? ` · ${esc(report.place)}` : ""} · ${tag(task.status, "gray")}</small></div>${role === "staff" && task.assigneeEmail === session.email ? `<button class="btn secondary task-progress" data-id="${task.id}" ${task.status === "Completed" ? "disabled" : ""}>${nextLabel}</button>` : ""}</div>`;
  }).join("");
}

function filterReports() {
  const reports = filteredReports();
  document.querySelector("#report-list").innerHTML = reportCards(reports, role === "admin");
  updateReportMarkers(reports);
}

document.querySelector("#logout").onclick = () => {
  const unsynced = state.reports.filter(report => report.pendingSync).length;
  if (unsynced && !confirm(`${unsynced} report${unsynced === 1 ? "" : "s"} have not synced. Logging out will remove them from this device. Continue?`)) return;
  fetch("/api/logout", { method: "POST", headers: { Authorization: `Bearer ${authToken()}` } }).catch(() => {});
  session = null;
  role = "user";
  state = emptyState();
  apiReady = false;
  pendingAccounts = [];
  totalCampusUsers = 0;
  activeStaff = [];
  localStorage.removeItem("losttrack-session");
  localStorage.removeItem("losttrack-data");
  localStorage.removeItem("losttrack-draft");
  localStorage.setItem("losttrack-auth-mode", "login");
  page = "home";
  render();
};
document.addEventListener("input", e => {
  if (["search", "location-filter", "color-filter", "date-filter", "kind", "category", "status"].includes(e.target.id)) filterReports();
  if (e.target.id === "location-filter") updateReportLocationSuggestions(e.target.value);
  if (e.target.id === "report-place") {
    clearMapPinForLocationChange();
    updateLocationSuggestions(e.target.value);
  }
});
document.addEventListener("focusin", e => {
  if (e.target.id === "report-place") updateLocationSuggestions(e.target.value);
  if (e.target.id === "location-filter") updateReportLocationSuggestions(e.target.value);
});
document.addEventListener("focusout", e => {
  if (e.target.id === "report-place") setTimeout(closeLocationSuggestions, 120);
  if (e.target.id === "location-filter") setTimeout(closeReportLocationSuggestions, 120);
});
document.addEventListener("keydown", e => {
  const reportPlaceInput = e.target.id === "report-place";
  const reportLocationInput = e.target.id === "location-filter";
  if (!reportPlaceInput && !reportLocationInput) return;
  const list = document.querySelector(reportPlaceInput ? "#place-suggestions" : "#report-location-suggestions");
  if (!list || list.classList.contains("hidden")) return;
  const options = [...list.querySelectorAll(".place-option")];
  if (e.key === "Escape") {
    if (reportPlaceInput) closeLocationSuggestions();
    else closeReportLocationSuggestions();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    let activeIndex = options.findIndex(option => option.getAttribute("aria-selected") === "true");
    activeIndex = e.key === "ArrowDown"
      ? Math.min(activeIndex + 1, options.length - 1)
      : Math.max(activeIndex - 1, 0);
    options.forEach((option, index) => {
      option.setAttribute("aria-selected", String(index === activeIndex));
      option.classList.toggle("active", index === activeIndex);
    });
    return;
  }
  if (e.key === "Enter" && options.length) {
    e.preventDefault();
    const activeOption = options.find(option => option.getAttribute("aria-selected") === "true");
    const matchingOption = options.find(option => option.dataset.place.toLocaleLowerCase() === e.target.value.trim().toLocaleLowerCase());
    const value = (activeOption || matchingOption)?.dataset.place || e.target.value.trim();
    if (reportPlaceInput) selectCampusLocation(value);
    else selectReportLocation(value);
  }
});
document.addEventListener("change", e => {
  if (e.target.id === "report-type") {
    document.querySelectorAll(".item-only").forEach(el => {
      el.style.display = "grid";
      el.querySelector("label")?.classList.toggle("hidden", e.target.value === "issue");
    });
    document.querySelectorAll(".issue-only").forEach(el => el.classList.toggle("hidden", e.target.value !== "issue"));
    syncReportCategories(e.target.value);
  }
  if (e.target.name === "photos") updatePhotoPreviews(e.target);
});
document.addEventListener("click", async e => {
  const target = e.target.closest("button, a") || e.target;
  if (target.id === "search-location") {
    await searchBangladeshLocations();
    return;
  }
  if (target.classList.contains("location-search-result")) {
    await selectBangladeshLocation(target);
    return;
  }
  if (target.classList.contains("place-option")) {
    if (target.closest("#report-location-autocomplete")) selectReportLocation(target.dataset.place);
    else selectCampusLocation(target.dataset.place);
    return;
  }
  if (!target.closest("#report-place-autocomplete")) closeLocationSuggestions();
  if (!target.closest("#report-location-autocomplete")) closeReportLocationSuggestions();
  const id = target.dataset.id, item = getReport(id);
  if (target.id === "clear-photos") {
    const input = document.querySelector('[name="photos"]');
    input.value = "";
    updatePhotoPreviews(input);
  }
  if (target.classList.contains("close-claim") || target.classList.contains("close-dialog")) target.closest("dialog")?.close();
  if (target.id === "language-toggle" || target.id === "auth-language-toggle") {
    window.LostTrackI18n.toggle();
    if (page === "reports") updateReportMarkers(filteredReports());
    if (page === "new") {
      const latitude = document.querySelector('[name="latitude"]').value;
      const longitude = document.querySelector('[name="longitude"]').value;
      if (latitude && longitude) document.querySelector("#location-pin-status").textContent =
        pinStatusText(latitude, longitude);
    }
    return;
  }
  if (target.id === "theme-toggle" || target.id === "auth-theme-toggle") { window.LostTrackI18n.toggleTheme(); return; }
  if (target.id === "retry-sync") {
    apiReady = true;
    save().then(() => syncFromApi());
    return;
  }
  if (target.dataset.passwordToggle) {
    const input = document.querySelector(`#${target.dataset.passwordToggle}`);
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    target.textContent = visible ? "Show" : "Hide";
    target.setAttribute("aria-label", visible ? "Show password" : "Hide password");
    return;
  }
  if (target.dataset.auth) {
    localStorage.setItem("losttrack-auth-mode", target.dataset.auth);
    render();
    return;
  }
  if (target.classList.contains("approve-account")) {
    fetch("/api/admin/accounts/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + authToken() },
      body: JSON.stringify({ email: target.dataset.email })
    }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Approval failed.");
      const approved = pendingAccounts.find(account => account.email === target.dataset.email);
      if (approved) {
        const account = { ...approved, role: approved.requestedRole, status: "active" };
        state.accounts = (state.accounts || []).map(current => current.email === account.email ? account : current);
        if (account.role === "staff") activeStaff.push(account);
      }
      pendingAccounts = pendingAccounts.filter(account => account.email !== target.dataset.email);
      totalCampusUsers++;
      render();
    }).catch(error => alert(error.message));
    return;
  }
  if (target.dataset.adminReportFilter && role === "admin") {
    e.preventDefault();
    showAdminDashboardReports(target.dataset.adminReportFilter);
    return;
  }
  if (target.matches("[data-page]")) {
    e.preventDefault();
    if (target.dataset.reportKind) pendingReportKind = target.dataset.reportKind;
    if (target.dataset.reportFocus) pendingReportFocus = target.dataset.reportFocus;
    const adminAnchor = role === "admin" ? target.dataset.adminAnchor : "";
    const adminFilter = role === "admin" ? target.dataset.adminFilter : "";
    page = target.dataset.page;
    render();
    if (adminAnchor) {
      document.querySelectorAll("#mode-admin, .admin-nav-link").forEach(link => link.classList.toggle("active", link === target));
    }
    if (adminFilter) showAdminDashboardReports(adminFilter);
    if (adminAnchor) document.getElementById(adminAnchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  if (target.id === "read-all") { state.notifications.forEach(n => { n.read = true; }); save(); render(); return; }
  if (target.id === "save-draft") { storeDraft(document.querySelector("#report-form")); document.querySelector("#draft-note").textContent = "Draft saved on this device."; return; }
  if (target.closest("#clear-location-pin")) {
    document.querySelector('[name="latitude"]').value = "";
    document.querySelector('[name="longitude"]').value = "";
    document.querySelector("#location-pin-status").textContent = localStorage.getItem("losttrack-language") === "bn"
      ? "অবস্থানের টেক্সট লিখেও রিপোর্ট জমা দিতে পারবেন।"
      : "You can still submit a report using the location text field.";
    if (locationPickerMap) locationPickerMap.eachLayer(layer => { if (layer instanceof L.Marker) locationPickerMap.removeLayer(layer); });
    return;
  }
  if (target.id === "export-data") { const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }), a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "losttrack-data.json"; a.click(); URL.revokeObjectURL(a.href); return; }
  if (target.id === "reset-data" && confirm(window.LostTrackI18n?.text("Clear this device's cached data?") || "Clear this device's cached data?")) { localStorage.removeItem("losttrack-data"); location.reload(); return; }
  if (target.classList.contains("submit-duplicate")) {
    const form = document.querySelector("#report-form");
    form.dataset.allowDuplicate = "true";
    form.requestSubmit();
    return;
  }
  if (target.classList.contains("task-progress") && role === "staff") {
    const task = state.tasks.find(record => String(record.id) === String(id) && record.assigneeEmail === session.email);
    if (!task || task.status === "Completed") return;
    task.status = task.status === "Assigned" ? "In progress" : "Completed";
    save();
    render();
    return;
  }
  if (target.classList.contains("open-notification")) {
    const note = state.notifications.find(entry => entry.id === target.dataset.id);
    if (note) note.read = true;
    pendingReportFocus = target.dataset.ref;
    page = role === "admin" ? "dashboard" : role === "staff" && getReport(target.dataset.ref)?.type === "issue" ? "dashboard" : "reports";
    save();
    render();
    return;
  }
  if (!item) return;
  if (target.classList.contains("vote") && ["user", "staff"].includes(role)) {
    if (item.voted) return alert("You have already voted on this report.");
    target.disabled = true;
    try {
      const response = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken()}` },
        body: JSON.stringify({ reportId: item.id })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Vote could not be counted.");
      state = normalizeState(result.state);
      localStorage.setItem("losttrack-data", JSON.stringify(state));
      apiReady = true;
      target.disabled = true;
      target.textContent = "Upvoted";
      const card = target.closest("article.report");
      const count = card?.querySelector("[data-vote-count]");
      const currentVotes = state.reports.find(report => String(report.id) === String(item.id)).votes;
      if (count) count.textContent = String(currentVotes);
      const suggestionCount = target.closest(".row")?.querySelector(".duplicate-vote-count");
      if (suggestionCount) suggestionCount.textContent = `${currentVotes} ${currentVotes === 1 ? "upvote" : "upvotes"}`;
      notify(`Your vote on ${item.title} was counted.`);
      const issueCard = target.closest(".portal-issue");
      if (issueCard) {
        const fresh = state.reports.find(report => String(report.id) === String(item.id));
        if (fresh) {
          issueCard.outerHTML = portalIssueCard(fresh);
          window.LostTrackI18n?.apply();
        }
      }
    } catch (error) {
      target.disabled = false;
      alert(error.message);
    }
    return;
  }
  if (target.classList.contains("claim") && ["user", "staff"].includes(role)) openClaimDialog(item);
  if (target.classList.contains("continue-claim") && ["user", "staff"].includes(role)) {
    const claim = state.claims.find(record => record.id === target.dataset.claim && record.claimantId === session.id);
    if (claim?.status === "Needs more information") openClaimDialog(item, claim);
  }
  if (target.classList.contains("reopen-claim") && role === "admin") {
    const button = target;
    button.disabled = true;
    try {
      const response = await fetch("/api/admin/claims/reopen", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + authToken() },
        body: JSON.stringify({ claimId: button.dataset.claim })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not reopen the claim.");
      const accounts = state.accounts;
      state = normalizeState(result.state);
      state.accounts = accounts || [];
      localStorage.setItem("losttrack-data", JSON.stringify(state));
      render();
      notify("One additional claim attempt was reopened.");
    } catch (error) {
      button.disabled = false;
      notify(error.message);
    }
  }
  if (target.classList.contains("edit-report") && ["user", "staff"].includes(role)) {
    if (!item || item.createdBy !== session.id) return;
    openFormDialog(`<form><h2>Edit report</h2><label>Title<input name="title" required maxlength="120" value="${esc(item.title)}"></label><label>Location<input name="place" required maxlength="160" value="${esc(item.place)}"></label><label>Colour<input name="color" maxlength="40" value="${esc(item.color || "")}"></label><label>Description<textarea name="text" required maxlength="2000">${esc(item.text)}</textarea></label><div class="form-error" role="alert"></div><div class="actions"><button type="button" class="btn ghost close-dialog">Cancel</button><button class="btn" type="submit">Save changes</button></div></form>`, data => {
      if (!data.title.trim() || !data.place.trim() || !data.text.trim()) return "Title, location and description are required.";
      item.title = data.title.trim().slice(0, 120);
      item.place = data.place.trim().slice(0, 160);
      item.color = data.color.trim().slice(0, 40);
      item.text = data.text.trim().slice(0, 2000);
      save();
      render();
    });
    return;
  }
  if (target.classList.contains("history-btn")) {
    const history = target.closest("article")?.querySelector(".history") || document.getElementById("history-" + id);
    history?.classList.toggle("hidden");
  }
  if (target.classList.contains("resolve") && role === "admin") { item.status = "Resolved"; notify(`${item.title} was marked resolved.`); save(); render(); }
  if (target.classList.contains("priority") && role === "admin") {
    const suggested = priorityFor(item).suggested;
    openFormDialog(`<form><h2>Set priority</h2><p>Suggested priority: <strong>${esc(suggested)}</strong> (${priorityFor(item).score}/100).</p><label>Priority<select name="priority"><option ${item.priority === "Low" ? "selected" : ""}>Low</option><option ${item.priority === "Medium" ? "selected" : ""}>Medium</option><option ${item.priority === "High" ? "selected" : ""}>High</option></select></label><label>Reason for a change<textarea name="reason" maxlength="300" placeholder="Required only when the priority changes."></textarea></label><div class="form-error" role="alert"></div><div class="actions"><button type="button" class="btn ghost close-dialog">Cancel</button><button class="btn" type="submit">Save priority</button></div></form>`, data => {
      if (!["Low", "Medium", "High"].includes(data.priority)) return "Choose Low, Medium or High.";
      if (data.priority !== item.priority && data.reason.trim().length < 3) return "A short reason is required to override priority.";
      item.priority = data.priority;
      item.overrideReason = data.reason.trim();
      save();
      render();
    });
    return;
  }
  if (target.classList.contains("assign") && role === "admin") {
    if (!activeStaff.length) return alert(window.LostTrackI18n?.text("Approve a Staff account before assigning work.") || "Approve a Staff account before assigning work.");
    openFormDialog(`<form><h2>Assign work</h2><p>${esc(item.title)}</p><label>Staff member<select name="email">${activeStaff.map(account => `<option value="${esc(account.email)}">${esc(account.name)} · ${esc(account.email)}</option>`).join("")}</select></label><label>Task<textarea name="text" required maxlength="300">Resolve ${esc(item.title)}</textarea></label><div class="form-error" role="alert"></div><div class="actions"><button type="button" class="btn ghost close-dialog">Cancel</button><button class="btn" type="submit">Assign task</button></div></form>`, data => {
      const assignee = activeStaff.find(account => account.email === data.email);
      if (!assignee) return "Choose an active staff account.";
      if (!data.text.trim()) return "Describe the task.";
      state.tasks.push({ id: Date.now(), reportId: item.id, assignee: assignee.name, assigneeEmail: assignee.email, status: "Assigned", text: data.text.trim().slice(0, 300) });
      log(item, `Task assigned to ${assignee.name}`);
      notify(`A task was assigned for ${item.title}.`);
      save();
      render();
    });
    return;
  }
  if (target.classList.contains("claim-decision") && role === "admin") { const claim = state.claims.find(record => record.id === target.dataset.claim); if (!claim) return; claim.status = target.dataset.decision; notify(`Claim for ${item.title} was updated.`); save(); render(); }
  if (target.classList.contains("returned") && role === "admin") { if (!confirm(window.LostTrackI18n?.text("Confirm that you checked the approved claimant's identity in person at handover. Do not store an ID number or image.") || "Confirm that you checked the approved claimant's identity in person at handover. Do not store an ID number or image.")) return; item.status = "Returned"; item.identityChecked = true; notify(`${item.title} was marked returned.`); save(); render(); }
  if (target.classList.contains("delete-report") && role === "admin") {
    if (!confirm(`Permanently delete "${item.title}" and its related claims, clues, tasks and history?`)) return;
    target.disabled = true;
    try {
      const response = await fetch(`/api/admin/reports/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${authToken()}` }
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 503 && /Report data was deleted/.test(result.error || "")) {
          await syncFromApi();
        }
        throw new Error(result.error || "Report could not be deleted.");
      }
      state = normalizeState(result.state);
      localStorage.setItem("losttrack-data", JSON.stringify(state));
      apiReady = true;
      render();
      notify("Report and related records were deleted.");
    } catch (error) {
      target.disabled = false;
      notify(error.message);
    }
    return;
  }
  if (target.classList.contains("set-clue") && role === "admin") {
    const existing = getPrivateClue(id);
    openFormDialog(`<form><h2>${existing ? "Update private clue" : "Record private clue"}</h2><p>This clue is stored separately and only administrators can read it. Leave it blank to remove the saved clue.</p><label>Private ownership clue<textarea name="clue" maxlength="300" placeholder="Do not store an ID number or photo.">${esc(existing?.clue || "")}</textarea></label><div class="form-error" role="alert"></div><div class="actions"><button type="button" class="btn ghost close-dialog">Cancel</button><button class="btn" type="submit">Save clue</button></div></form>`, data => {
      state.privateClues = state.privateClues.filter(record => String(record.reportId) !== String(id));
      if (data.clue.trim()) state.privateClues.push({ reportId: item.id, clue: data.clue.trim().slice(0, 300) });
      save();
      render();
    });
    return;
  }
  if (target.classList.contains("merge-report") && role === "admin") { const main = getReport(target.dataset.main); if (!main || !confirm(`Merge "${item.title}" into "${main.title}"?`)) return; item.status = "Merged"; item.duplicateOf = main.id; log(item, `Merged into ${main.title}`); notify(`Duplicate report "${item.title}" was merged.`); save(); render(); }
});
document.addEventListener("submit", async e => {
  if (e.target.id === "claim-form") {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.target));
    const error = document.querySelector("#claim-error");
    const submit = e.target.querySelector('[type="submit"]');
    error.textContent = "";
    submit.disabled = true;
    try {
      const response = await fetch("/api/claims", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + authToken() },
        body: JSON.stringify({
          reportId: e.target.dataset.reportId,
          claimId: e.target.dataset.claimId,
          detail: form.detail,
          consent: form.consent === "on"
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not submit the claim.");
      state = normalizeState(result.state);
      localStorage.setItem("losttrack-data", JSON.stringify(state));
      apiReady = true;
      document.querySelector("#claim-dialog")?.close();
      render();
      notify("Your private claim was submitted for administrator review.");
    } catch (errorValue) {
      error.textContent = errorValue.message;
      submit.disabled = false;
    }
    return;
  }
  if (e.target.id === "login-form") {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.target));
    const error = document.querySelector("#login-error");
    fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Login failed.");
        session = result.user;
        role = session.role;
        state = emptyState();
        apiReady = false;
        pendingAccounts = [];
        totalCampusUsers = 0;
        activeStaff = [];
        localStorage.removeItem("losttrack-data");
        localStorage.setItem("losttrack-session", JSON.stringify(session));
        page = role === "user" ? "home" : "dashboard";
        render();
        syncFromApi();
      })
      .catch(errorValue => { error.textContent = errorValue.message; });
    return;
  }
  if (e.target.id === "register-form") {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.target));
    form.privacyConsent = form.privacyConsent === "on";
    const error = document.querySelector("#register-error");
    fetch("/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Account creation failed.");
        localStorage.setItem("losttrack-auth-mode", "login");
        render();
        setAuthMessage(document.querySelector("#login-error"), result.message, true);
      })
      .catch(errorValue => { setAuthMessage(error, errorValue.message); });
    return;
  }
  if (e.target.id !== "report-form") return;
  e.preventDefault();
  const form = new FormData(e.target), item = Object.fromEntries(form);
  item.consent = form.get("consent") === "on";
  const error = document.querySelector("#report-error");
  error.textContent = "";
  if (item.latitude && item.longitude) {
    try {
      await loadBangladeshBoundary();
    } catch (boundaryError) {
      error.textContent = boundaryError.message;
      return;
    }
    item.latitude = Number(item.latitude);
    item.longitude = Number(item.longitude);
    if (!isBangladeshPoint(item.latitude, item.longitude)) {
      error.textContent = "Choose a location inside Bangladesh.";
      return;
    }
  } else {
    delete item.latitude;
    delete item.longitude;
  }
  const files = [...e.target.elements.photos.files];
  if (!updatePhotoPreviews(e.target.elements.photos)) return;
  const duplicates = item.type === "issue" ? duplicateReports(item) : [];
  if (duplicates.length && e.target.dataset.allowDuplicate !== "true") {
    const suggestions = document.querySelector("#duplicate-suggestions");
    suggestions.innerHTML = `<strong>Similar open reports in the last 14 days</strong>${duplicates.map(report => `<div class="row"><span>${esc(report.title)} · ${esc(report.place)} · <span class="duplicate-vote-count">${report.votes} ${report.votes === 1 ? "upvote" : "upvotes"}</span></span><button type="button" class="btn secondary vote" data-id="${esc(report.id)}" ${report.voted ? "disabled" : ""}>${report.voted ? "Upvoted" : "Upvote this instead"}</button></div>`).join("")}<div class="actions"><a class="btn ghost" href="#reports" data-page="reports">Browse reports</a><button type="button" class="btn ghost submit-duplicate">Submit as possible duplicate</button></div>`;
    suggestions.classList.remove("hidden");
    return;
  }
  storeDraft(e.target);
  try {
    if (files.length) {
      const uploadResponse = await fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken()}` },
        body: JSON.stringify({ files: await Promise.all(files.map(async file => ({ data: await fileAsData(file) }))) })
      });
      const uploadResult = await uploadResponse.json();
      if (!uploadResponse.ok) throw new Error(uploadResult.error || "Image upload failed.");
      item.photos = uploadResult.urls;
    } else {
      item.photos = [];
    }
    if (item.type === "issue") {
      item.safetyRisk = item.safetyRisk === "on";
      if (duplicates.length) item.possibleDuplicate = true;
    } else {
      delete item.severity;
      delete item.safetyRisk;
    }
    item.id = Date.now();
    item.votes = 0;
    item.status = item.type === "found" ? "Found" : "Open";
    item.priority = "Medium";
    item.createdAt = new Date().toISOString();
    item.history = [`Reported by ${session.name} - just now`];
    item.createdBy = session.id;
    item.pendingSync = true;
    delete item.photosInput;
    delete item.clue;
    delete e.target.dataset.allowDuplicate;
    state.reports.unshift(item);
    const synced = await save();
    localStorage.removeItem("losttrack-draft");
    notify(synced
      ? `${typeName(item.type)} "${item.title}" was created.`
      : `Saved on this device. It will sync when your connection returns.`);
    page = "reports";
    render();
  } catch (errorValue) {
    storeDraft(e.target);
    error.textContent = `${errorValue.message} Your report details were saved on this device. Retry when connected.${files.length ? " Photos are not stored in the draft; select them again if the form reloads." : ""}`;
  }
});
document.addEventListener("input", e => {
  if (!["login-password", "register-password"].includes(e.target.id)) return;
  const password = e.target.value;
  const strong = password.length >= 12 && /[a-z]/.test(password) && /[A-Z]/.test(password) &&
    /\d/.test(password) && /[^A-Za-z0-9]/.test(password);
  e.target.setCustomValidity(strong ? "" : "Use at least 12 characters with uppercase, lowercase, a number and a symbol.");
  const strength = document.querySelector("#password-strength");
  if (strength) strength.className = `password-strength ${strong ? "valid" : ""}`;
});
window.addEventListener("online", () => {
  document.body.dataset.connection = "online";
  if (session && page !== "new" && state.reports.some(report => report.pendingSync)) syncFromApi();
});
window.addEventListener("offline", () => { document.body.dataset.connection = "offline"; });
render();
if (session) syncFromApi();
