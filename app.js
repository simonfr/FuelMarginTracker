// App state
let nationalData = [];
let searchIndex = [];
let rankingsData = {};
let selectedFuel = 'e10';
let selectedPeriod = 180;
let nationalChartInstance = null;
let stationChartInstance = null;
let currentStations = [];
let selectedStation = null;

// Brand parsing helpers to handle both string and object types
function parseBrand(brand) {
  let brandStr = 'Station';
  if (brand) {
    if (typeof brand === 'object') {
      brandStr = brand.brand || brand.name || 'Station';
    } else {
      brandStr = brand;
    }
  }
  
  const knownBrands = [
    'Total Access', 'TotalEnergies', 'Total Energies', 'Total', 'Carrefour Contact', 'Carrefour Market', 'Carrefour Express', 'Carrefour',
    'E.Leclerc', 'Leclerc', 'Intermarché Contact', 'Intermarché Super', 'Intermarché Hyper', 'Intermarché',
    'Super U', 'Hyper U', 'U Express', 'Système U', 'Esso Express', 'Esso', 'BP', 'Avia', 'Auchan Supermarché',
    'Auchan', 'Cora', 'Dyneff', 'Elan', 'Shell', 'Colruyt', 'Netto', 'Agip'
  ];
  
  let normalized = brandStr.trim();
  for (const kb of knownBrands) {
    const regex = new RegExp('^' + kb, 'i');
    if (regex.test(normalized)) {
      const short = kb;
      let modifier = normalized.substring(kb.length).trim();
      modifier = modifier.replace(/^[\s\-\,]+/, '');
      return { short, modifier };
    }
  }
  
  const firstSpace = normalized.indexOf(' ');
  if (firstSpace > 0) {
    return {
      short: normalized.substring(0, firstSpace),
      modifier: normalized.substring(firstSpace).trim()
    };
  }
  
  return { short: normalized, modifier: '' };
}

function getBrandName(brand) {
  const p = parseBrand(brand);
  return p.modifier ? `${p.short} - ${p.modifier}` : p.short;
}

function getBrandShort(brand) {
  return parseBrand(brand).short;
}

// French fuel taxes: TVA (20% on pump price -> pumpPrice / 6) & TICPE (fixed per liter)
function getPriceBreakdown(pumpPrice, fuelKey, wtiEur) {
  if (!pumpPrice) return null;
  
  const tva = pumpPrice / 6.0;
  
  let ticpe = 0.0;
  if (fuelKey === 'Gazole') {
    ticpe = 0.5940;
  } else if (fuelKey === 'E10' || fuelKey === 'SP95') {
    ticpe = 0.6629;
  } else if (fuelKey === 'SP98') {
    ticpe = 0.6829;
  } else {
    ticpe = 0.6629;
  }
  
  const rawWti = wtiEur || 0.0;
  
  // Calculate distributor share (clamped at 0 for display)
  let distributor = pumpPrice - (tva + ticpe + rawWti);
  const displayDistributor = Math.max(0, distributor);
  
  return {
    pumpPrice,
    tva,
    ticpe,
    wti: rawWti,
    distributor,
    displayDistributor
  };
}

function updatePriceBreakdown(containerPrefix, breakdown) {
  const container = document.getElementById(`${containerPrefix}-price-breakdown`);
  if (!container) return;
  
  if (!breakdown) {
    container.style.display = 'none';
    return;
  }
  
  container.style.display = 'block';
  
  const { pumpPrice, tva, ticpe, wti, displayDistributor } = breakdown;
  
  // Calculate segments percentages based on the visual sum
  const visualSum = wti + ticpe + tva + displayDistributor;
  
  const pctWti = visualSum > 0 ? (wti / visualSum) * 100 : 0;
  const pctTicpe = visualSum > 0 ? (ticpe / visualSum) * 100 : 0;
  const pctTva = visualSum > 0 ? (tva / visualSum) * 100 : 0;
  const pctDist = visualSum > 0 ? (displayDistributor / visualSum) * 100 : 0;
  
  // Update segment widths
  const barWti = document.getElementById(`${containerPrefix}-bar-wti`);
  const barTicpe = document.getElementById(`${containerPrefix}-bar-ticpe`);
  const barTva = document.getElementById(`${containerPrefix}-bar-tva`);
  const barDist = document.getElementById(`${containerPrefix}-bar-dist`);
  
  if (barWti) barWti.style.width = `${pctWti}%`;
  if (barTicpe) barTicpe.style.width = `${pctTicpe}%`;
  if (barTva) barTva.style.width = `${pctTva}%`;
  if (barDist) barDist.style.width = `${pctDist}%`;
  
  // Update title/legend tooltips
  if (barWti) barWti.title = `Brut WTI : ${wti.toFixed(3)} €/L (${pctWti.toFixed(1)}%)`;
  if (barTicpe) barTicpe.title = `TICPE : ${ticpe.toFixed(4)} €/L (${pctTicpe.toFixed(1)}%)`;
  if (barTva) barTva.title = `TVA (20%) : ${tva.toFixed(3)} €/L (${pctTva.toFixed(1)}%)`;
  if (barDist) barDist.title = `Part Distributeur : ${breakdown.distributor.toFixed(3)} €/L (${pctDist.toFixed(1)}%)`;
  
  // Update legend text
  const lblWti = document.getElementById(`${containerPrefix}-lbl-wti`);
  const lblTicpe = document.getElementById(`${containerPrefix}-lbl-ticpe`);
  const lblTva = document.getElementById(`${containerPrefix}-lbl-tva`);
  const lblDist = document.getElementById(`${containerPrefix}-lbl-dist`);
  
  if (lblWti) lblWti.textContent = `${wti.toFixed(3)} €/L`;
  if (lblTicpe) lblTicpe.textContent = `${ticpe.toFixed(4)} €/L`;
  if (lblTva) lblTva.textContent = `${tva.toFixed(3)} €/L`;
  if (lblDist) {
    lblDist.textContent = `${breakdown.distributor.toFixed(3)} €/L`;
    if (breakdown.distributor < 0) {
      lblDist.style.color = '#ef4444';
    } else {
      lblDist.style.color = '';
    }
  }
}

function filterStationsList(query) {
  if (!query) {
    renderStationsList(currentStations);
    return;
  }
  
  const filtered = currentStations.filter(station => {
    const brandObj = parseBrand(station.brand);
    const brandShort = brandObj.short.toLowerCase();
    const brandMod = brandObj.modifier.toLowerCase();
    const address = station.adresse.toLowerCase();
    const city = station.ville.toLowerCase();
    
    return brandShort.includes(query) || 
           brandMod.includes(query) || 
           address.includes(query) || 
           city.includes(query);
  });
  
  renderStationsList(filtered, true);
}

// Fuel Display Mapping
const fuelLabels = {
  e10: 'SP95-E10',
  gazole: 'Gazole',
  sp95: 'SP95',
  sp98: 'SP98'
};

const fuelKeysMap = {
  e10: 'E10',
  gazole: 'Gazole',
  sp95: 'SP95',
  sp98: 'SP98'
};

const fuelColors = {
  e10: '#10b981',      // Emerald
  gazole: '#94a3b8',   // Slate
  sp95: '#8b5cf6',     // Violet
  sp98: '#ec4899'      // Pink
};

// Theme UI helper
function updateThemeUI() {
  const isDark = document.body.classList.contains('dark-theme');
  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    toggleBtn.textContent = isDark ? '☀️' : '🌙';
  }
}

// Initialize app
window.addEventListener('DOMContentLoaded', async () => {
  // Apply saved theme immediately to prevent flashing
  const savedTheme = localStorage.getItem('theme') || 'light';
  if (savedTheme === 'dark') {
    document.body.classList.add('dark-theme');
  } else {
    document.body.classList.remove('dark-theme');
  }
  updateThemeUI();

  await loadNationalData();
  await loadSearchIndex();
  await loadRankings();
  setupEventListeners();
});

// Load rankings data
async function loadRankings() {
  try {
    const response = await fetch('data/margins_ranking.json?v=' + new Date().getTime());
    if (!response.ok) throw new Error("Failed to load rankings");
    rankingsData = await response.json();
    renderRankings();
  } catch (error) {
    console.error("Error loading rankings:", error);
    document.getElementById('ranking-bottom-tbody').innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--color-sp98); padding: 1rem;">Erreur de chargement du palmarès</td></tr>`;
    document.getElementById('ranking-top-tbody').innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--color-sp98); padding: 1rem;">Erreur de chargement du palmarès</td></tr>`;
  }
}

// Render Rankings Tables
function renderRankings() {
  const fuelKey = fuelKeysMap[selectedFuel];
  document.getElementById('ranking-fuel-label').textContent = `Carburant : ${fuelLabels[selectedFuel]}`;
  
  const fuelRankings = rankingsData[fuelKey] || { top: [], bottom: [] };
  
  const bottomTbody = document.getElementById('ranking-bottom-tbody');
  const topTbody = document.getElementById('ranking-top-tbody');
  
  // Render Bottom 10 (Cheapest)
  bottomTbody.innerHTML = '';
  if (fuelRankings.bottom.length === 0) {
    bottomTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 1rem;">Aucune donnée disponible</td></tr>`;
  } else {
    fuelRankings.bottom.forEach(st => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => {
        // Clicking a ranking station searches for it!
        document.getElementById('search-input').value = st.cp;
        loadStationsByPostalCode(st.cp).then(() => {
          setTimeout(() => {
            const item = Array.from(document.querySelectorAll('.station-item')).find(el => el.dataset.id === st.id);
            if (item) {
              item.click();
              item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }, 300);
        });
      });
      
      const tva = st.price / 6.0;
      let ticpe = 0.6629;
      if (selectedFuel === 'gazole') {
        ticpe = 0.5940;
      } else if (selectedFuel === 'e10' || selectedFuel === 'sp95') {
        ticpe = 0.6629;
      } else if (selectedFuel === 'sp98') {
        ticpe = 0.6829;
      }
      const partDist = st.margin - tva - ticpe;
      
      tr.innerHTML = `
        <td style="padding: 0.625rem 0.5rem; font-weight: 500;">${st.brand}</td>
        <td style="padding: 0.625rem 0.5rem; color: var(--text-secondary); text-transform: capitalize;">${st.ville.toLowerCase()} (${st.cp})</td>
        <td style="padding: 0.625rem 0.5rem; text-align: right; font-weight: 600; color: var(--color-e10);">${st.price.toFixed(3)} €</td>
        <td style="padding: 0.625rem 0.5rem; text-align: right; font-weight: 600; color: var(--color-margin);">${partDist.toFixed(3)} €</td>
      `;
      bottomTbody.appendChild(tr);
    });
  }
  
  // Render Top 10 (Most Expensive)
  topTbody.innerHTML = '';
  if (fuelRankings.top.length === 0) {
    topTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; padding: 1rem;">Aucune donnée disponible</td></tr>`;
  } else {
    fuelRankings.top.forEach(st => {
      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', () => {
        // Clicking a ranking station searches for it!
        document.getElementById('search-input').value = st.cp;
        loadStationsByPostalCode(st.cp).then(() => {
          setTimeout(() => {
            const item = Array.from(document.querySelectorAll('.station-item')).find(el => el.dataset.id === st.id);
            if (item) {
              item.click();
              item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
          }, 300);
        });
      });
      
      const tva = st.price / 6.0;
      let ticpe = 0.6629;
      if (selectedFuel === 'gazole') {
        ticpe = 0.5940;
      } else if (selectedFuel === 'e10' || selectedFuel === 'sp95') {
        ticpe = 0.6629;
      } else if (selectedFuel === 'sp98') {
        ticpe = 0.6829;
      }
      const partDist = st.margin - tva - ticpe;
      
      tr.innerHTML = `
        <td style="padding: 0.625rem 0.5rem; font-weight: 500;">${st.brand}</td>
        <td style="padding: 0.625rem 0.5rem; color: var(--text-secondary); text-transform: capitalize;">${st.ville.toLowerCase()} (${st.cp})</td>
        <td style="padding: 0.625rem 0.5rem; text-align: right; font-weight: 600; color: var(--color-sp98);">${st.price.toFixed(3)} €</td>
        <td style="padding: 0.625rem 0.5rem; text-align: right; font-weight: 600; color: var(--color-margin);">${partDist.toFixed(3)} €</td>
      `;
      topTbody.appendChild(tr);
    });
  }
}

// Load global trend data
async function loadNationalData() {
  try {
    const response = await fetch('data/national.json?v=' + new Date().getTime());
    if (!response.ok) throw new Error("Failed to load national data");
    nationalData = await response.json();
    
    // Sort chronologically just in case
    nationalData.sort((a, b) => a.date.localeCompare(b.date));
    
    // Update dashboard metrics with the latest values
    updateTopMetrics();
    
    // Render the national chart
    renderNationalChart();
  } catch (error) {
    console.error("Error loading national data:", error);
    document.getElementById('national-stats').innerHTML = `
      <div style="grid-column: span 4; text-align: center; color: var(--color-sp98); padding: 1rem;">
        Impossible de charger les statistiques nationales. Veuillez réessayer plus tard.
      </div>
    `;
  }
}

// Load autocomplete search index
async function loadSearchIndex() {
  try {
    const response = await fetch('data/search_index.json?v=' + new Date().getTime());
    if (!response.ok) throw new Error("Failed to load search index");
    searchIndex = await response.json();
  } catch (error) {
    console.error("Error loading search index:", error);
  }
}

// Update Top Metrics
function updateTopMetrics() {
  if (nationalData.length === 0) return;
  
  const latest = nationalData[nationalData.length - 1];
  
  // Format Date for badge
  const updateDate = new Date(latest.date);
  const formattedDate = updateDate.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  document.getElementById('last-update-badge').textContent = `Mise à jour : ${formattedDate}`;
  
  // Update stats
  const wtiVal = latest.wti_eur;
  const gazoleVal = latest.gazole;
  const e10Val = latest.e10;
  
  document.getElementById('stat-wti').textContent = wtiVal ? `${wtiVal.toFixed(3)} €/L` : '- €';
  document.getElementById('stat-gazole').textContent = gazoleVal ? `${gazoleVal.toFixed(3)} €/L` : '- €';
  document.getElementById('stat-e10').textContent = e10Val ? `${e10Val.toFixed(3)} €/L` : '- €';
  
  // Calculate Part Distributeur for active fuel type
  const activeFuelVal = latest[selectedFuel];
  const fuelKey = fuelKeysMap[selectedFuel];
  if (activeFuelVal && wtiVal) {
    const breakdown = getPriceBreakdown(activeFuelVal, fuelKey, wtiVal);
    document.getElementById('stat-margin').textContent = `${breakdown.distributor.toFixed(3)} €/L`;
  } else {
    document.getElementById('stat-margin').textContent = '- €';
  }
  
  // National Price Breakdown
  if (activeFuelVal && wtiVal) {
    const breakdown = getPriceBreakdown(activeFuelVal, fuelKey, wtiVal);
    updatePriceBreakdown('nat', breakdown);
  } else {
    updatePriceBreakdown('nat', null);
  }
}

// Render National Chart
function renderNationalChart() {
  const ctx = document.getElementById('nationalChart').getContext('2d');
  
  // Theme-based colors
  const isDark = document.body.classList.contains('dark-theme');
  const labelColor = isDark ? '#94a3b8' : '#475569';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.06)';
  const tickColor = isDark ? '#64748b' : '#475569';
  const wtiColor = isDark ? '#06b6d4' : '#0891b2';
  const marginColor = isDark ? '#fbbf24' : '#d97706';
  const marginBgColor = isDark ? 'rgba(251, 191, 36, 0.05)' : 'rgba(217, 119, 6, 0.05)';
  
  // Filter national data based on period selection
  const cutOffDate = new Date();
  cutOffDate.setDate(cutOffDate.getDate() - selectedPeriod);
  const cutoffStr = cutOffDate.toISOString().split('T')[0];
  
  const filteredData = nationalData.filter(d => d.date >= cutoffStr);
  
  const labels = filteredData.map(d => {
    const parts = d.date.split('-');
    return `${parts[2]}/${parts[1]}`;
  });
  
  const wtiPrices = filteredData.map(d => d.wti_eur);
  const fuelPrices = filteredData.map(d => d[selectedFuel]);
  
  // Calculate Part Distributeur instead of raw Gross Margin
  const fuelKey = fuelKeysMap[selectedFuel];
  let ticpe = 0.6629;
  if (fuelKey === 'Gazole') {
    ticpe = 0.5940;
  } else if (fuelKey === 'E10' || fuelKey === 'SP95') {
    ticpe = 0.6629;
  } else if (fuelKey === 'SP98') {
    ticpe = 0.6829;
  }
  
  const distributorShares = filteredData.map(d => {
    const pumpPrice = d[selectedFuel];
    const wti = d.wti_eur;
    if (pumpPrice && wti !== null && wti !== undefined) {
      const tva = pumpPrice / 6.0;
      return pumpPrice - (tva + ticpe + wti);
    }
    return null;
  });
  
  if (nationalChartInstance) {
    nationalChartInstance.destroy();
  }
  
  // Visual gradient for fuel price curve area
  const fuelGradient = ctx.createLinearGradient(0, 0, 0, 300);
  fuelGradient.addColorStop(0, fuelColors[selectedFuel] + '22');
  fuelGradient.addColorStop(1, fuelColors[selectedFuel] + '00');
  
  const activeFuelName = fuelLabels[selectedFuel];
  
  nationalChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: `Prix Moyen ${activeFuelName} (€/L)`,
          data: fuelPrices,
          borderColor: fuelColors[selectedFuel],
          backgroundColor: fuelGradient,
          borderWidth: 3,
          fill: true,
          tension: 0.2,
          yAxisID: 'y'
        },
        {
          label: 'Baril de Brut WTI (€/L)',
          data: wtiPrices,
          borderColor: wtiColor,
          borderWidth: 2,
          borderDash: [5, 5],
          fill: false,
          tension: 0.1,
          yAxisID: 'y'
        },
        {
          label: 'Part Distributeur Reste (€/L)',
          data: distributorShares,
          borderColor: marginColor,
          borderWidth: 2.5,
          backgroundColor: marginBgColor,
          fill: false,
          tension: 0.2,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      elements: {
        point: {
          radius: 0,
          hoverRadius: 5
        }
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: labelColor,
            font: { family: 'Outfit', size: 12 }
          }
        },
        tooltip: {
          titleFont: { family: 'Outfit' },
          bodyFont: { family: 'Outfit' }
        }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { family: 'Outfit' } }
        },
        y: {
          position: 'left',
          grid: { color: gridColor },
          ticks: { color: labelColor, font: { family: 'Outfit' } },
          title: { display: true, text: 'Prix à la pompe / WTI (€/L)', color: labelColor, font: { family: 'Outfit' } }
        },
        y1: {
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: marginColor, font: { family: 'Outfit' } },
          title: { display: true, text: 'Part Distributeur (€/L)', color: marginColor, font: { family: 'Outfit' } }
        }
      }
    }
  });
}

// Setup Event Listeners
function setupEventListeners() {
  // Fuel selection
  document.getElementById('fuel-select-group').addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-filter')) {
      document.querySelector('#fuel-select-group .btn-filter.active').classList.remove('active');
      e.target.classList.add('active');
      selectedFuel = e.target.dataset.fuel;
      updateTopMetrics();
      renderNationalChart();
      renderRankings();
      if (selectedStation) {
        updateStationDetailView(selectedStation);
      }
    }
  });
  
  // Period selection
  document.getElementById('period-select-group').addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-filter')) {
      document.querySelector('#period-select-group .btn-filter.active').classList.remove('active');
      e.target.classList.add('active');
      selectedPeriod = parseInt(e.target.dataset.period);
      document.getElementById('national-trend-range').textContent = `Derniers ${selectedPeriod} jours`;
      renderNationalChart();
    }
  });
  
  // Search Autocomplete
  const searchInput = document.getElementById('search-input');
  const dropdown = document.getElementById('autocomplete-dropdown');
  
  searchInput.addEventListener('input', (e) => {
    const val = e.target.value.trim().toLowerCase();
    if (val.length < 2) {
      dropdown.style.display = 'none';
      return;
    }
    
    // Search by postal code or city
    const matches = [];
    const normalizedVal = val.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    for (const item of searchIndex) {
      if (item.cp.startsWith(val)) {
        matches.push(item);
      } else {
        const matchingCity = item.cities.find(c => {
          const normCity = c.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          return normCity.includes(normalizedVal);
        });
        if (matchingCity) {
          matches.push(item);
        }
      }
      if (matches.length >= 10) break; // Limit suggestions
    }
    
    if (matches.length > 0) {
      renderAutocompleteDropdown(matches, searchInput.value);
    } else {
      dropdown.style.display = 'none';
    }
  });
  
  // Hide dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (e.target !== searchInput && e.target !== dropdown) {
      dropdown.style.display = 'none';
    }
  });
  
  searchInput.addEventListener('focus', () => {
    if (dropdown.children.length > 0 && searchInput.value.length >= 2) {
      dropdown.style.display = 'block';
    }
  });
  
  // Local station list filter
  const listFilter = document.getElementById('station-list-filter');
  if (listFilter) {
    listFilter.addEventListener('input', (e) => {
      const val = e.target.value.trim().toLowerCase();
      filterStationsList(val);
    });
  }
  
  // Theme toggle button
  const themeToggleBtn = document.getElementById('theme-toggle');
  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('dark-theme');
      const isDark = document.body.classList.contains('dark-theme');
      localStorage.setItem('theme', isDark ? 'dark' : 'light');
      updateThemeUI();
      
      // Re-render charts with correct themes
      renderNationalChart();
      if (selectedStation) {
        renderStationChart(selectedStation);
      }
    });
  }
}

// Render Autocomplete Dropdown
function renderAutocompleteDropdown(items, query) {
  const dropdown = document.getElementById('autocomplete-dropdown');
  dropdown.innerHTML = '';
  
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'autocomplete-item';
    
    // We show the postal code and primary matching city
    const primaryCity = item.cities.length > 0 ? item.cities[0] : '';
    const otherCities = item.cities.length > 1 ? ` (+${item.cities.length - 1} communes)` : '';
    
    div.innerHTML = `
      <span class="cp">${item.cp}</span>
      <span class="city">${primaryCity}${otherCities}</span>
    `;
    
    div.addEventListener('click', () => {
      document.getElementById('search-input').value = `${item.cp} - ${primaryCity}`;
      dropdown.style.display = 'none';
      loadStationsByPostalCode(item.cp);
    });
    
    dropdown.appendChild(div);
  });
  
  dropdown.style.display = 'block';
}

// Load stations by postal code
async function loadStationsByPostalCode(cp) {
  const stationListContainer = document.getElementById('station-list');
  const title = document.getElementById('stations-list-title');
  
  stationListContainer.innerHTML = `
    <div style="text-align: center; padding: 2rem 0; color: var(--text-secondary);">
      Chargement des stations...
    </div>
  `;
  title.style.display = 'none';
  
  try {
    const response = await fetch(`data/stations/${cp}.json?v=` + new Date().getTime());
    if (!response.ok) throw new Error("Aucune station disponible pour ce code postal.");
    
    const data = await response.json();
    currentStations = data.stations || [];
    
    if (currentStations.length === 0) {
      throw new Error("Aucune station active trouvée dans les données.");
    }
    
    renderStationsList(currentStations);
    title.style.display = 'block';
  } catch (error) {
    stationListContainer.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <p>${error.message}</p>
      </div>
    `;
    resetStationDetailView();
  }
}

// Render Stations List
function renderStationsList(stations, isFiltered) {
  const container = document.getElementById('station-list');
  container.innerHTML = '';
  
  // Show/Hide local filter wrapper based on loaded stations
  const filterWrapper = document.getElementById('station-filter-wrapper');
  if (currentStations.length > 0) {
    filterWrapper.style.display = 'block';
  } else {
    filterWrapper.style.display = 'none';
  }
  
  if (stations.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 2rem 1rem;">
        <div class="empty-state-icon">🔍</div>
        <p>${isFiltered ? "Aucune station ne correspond à votre filtre." : "Aucune station disponible."}</p>
      </div>
    `;
    return;
  }
  
  const fuelKey = fuelKeysMap[selectedFuel];
  
  stations.forEach(station => {
    // Get latest price for active fuel type
    const history = station.history[fuelKey] || [];
    const latestPrice = history.length > 0 ? `${history[history.length - 1].price.toFixed(3)} €` : 'N/A';
    
    const item = document.createElement('div');
    item.className = 'station-item';
    item.dataset.id = station.id;
    if (selectedStation && selectedStation.id === station.id) {
      item.classList.add('active');
    }
    
    // Parse brand to short/modifier
    const brandInfo = parseBrand(station.brand);
    const mainTitle = brandInfo.modifier || brandInfo.short;
    const subTitle = brandInfo.modifier ? brandInfo.short : '';
    
    item.innerHTML = `
      <div class="station-item-header">
        <span class="station-brand">${mainTitle}</span>
        <span class="station-price-tag" style="color: ${fuelColors[selectedFuel]}">${latestPrice}</span>
      </div>
      ${subTitle ? `<div class="station-item-modifier">${subTitle}</div>` : ''}
      <div class="station-item-details">
        <div class="station-item-detail-row">
          <span class="station-item-detail-icon">📍</span>
          <span>${station.adresse.toLowerCase()}</span>
        </div>
        <div class="station-item-detail-row">
          <span class="station-item-detail-icon">🏙️</span>
          <span style="text-transform: capitalize;">${station.ville.toLowerCase()} (${station.cp})</span>
        </div>
      </div>
    `;
    
    item.addEventListener('click', () => {
      // Toggle active states in UI list
      document.querySelectorAll('.station-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      
      // Update Detail View
      selectedStation = station;
      updateStationDetailView(station);
    });
    
    container.appendChild(item);
  });
}

// Reset detailed view
function resetStationDetailView() {
  selectedStation = null;
  const detailCard = document.getElementById('station-detail-card');
  detailCard.style.opacity = '0.4';
  detailCard.style.pointerEvents = 'none';
  
  document.getElementById('station-brand-badge').textContent = 'Aucune';
  document.getElementById('station-name-text').textContent = 'Sélectionnez une station';
  document.getElementById('station-address-text').textContent = 'Veuillez d\'abord chercher un code postal.';
  document.getElementById('latency-indicator').style.display = 'none';
  document.getElementById('st-price-breakdown').style.display = 'none';
  document.getElementById('station-chart-wrapper').style.display = 'none';
  document.getElementById('station-chart-empty').style.display = 'flex';
  
  if (stationChartInstance) {
    stationChartInstance.destroy();
    stationChartInstance = null;
  }
}

// Update Station Details View
function updateStationDetailView(station) {
  const detailCard = document.getElementById('station-detail-card');
  detailCard.style.opacity = '1';
  detailCard.style.pointerEvents = 'auto';
  
  const brandInfo = parseBrand(station.brand);
  document.getElementById('station-brand-badge').textContent = brandInfo.short;
  
  const fullName = brandInfo.modifier ? `${brandInfo.short} - ${brandInfo.modifier}` : brandInfo.short;
  document.getElementById('station-name-text').textContent = fullName;
  
  document.getElementById('station-address-text').textContent = `${station.adresse.toLowerCase()}, ${station.cp} ${station.ville}`;
  
  // Calculate and display latency
  const fuelKey = fuelKeysMap[selectedFuel];
  const latency = calculateLatency(station, nationalData, fuelKey);
  const latencyIndicator = document.getElementById('latency-indicator');
  const latencyText = document.getElementById('latency-days');
  
  if (latency !== null) {
    latencyText.textContent = latency === 1 ? `1 jour` : `${latency} jours`;
    latencyIndicator.style.display = 'block';
  } else {
    latencyText.textContent = `N/A (cours trop stables / données insuffisantes)`;
    latencyIndicator.style.display = 'block';
  }
  
  // Station Price Breakdown
  let latestPrice = null;
  const stationHistory = station.history[fuelKey] || [];
  if (stationHistory.length > 0) {
    latestPrice = stationHistory[stationHistory.length - 1].price;
  }
  
  let stationWti = null;
  if (stationHistory.length > 0) {
    const latestDate = stationHistory[stationHistory.length - 1].date;
    const nationalEntry = nationalData.find(d => d.date === latestDate);
    if (nationalEntry) {
      stationWti = nationalEntry.wti_eur;
    }
  }
  if (!stationWti && nationalData.length > 0) {
    stationWti = nationalData[nationalData.length - 1].wti_eur;
  }
  
  if (latestPrice && stationWti) {
    const breakdown = getPriceBreakdown(latestPrice, fuelKey, stationWti);
    updatePriceBreakdown('st', breakdown);
  } else {
    updatePriceBreakdown('st', null);
  }
  
  // Show chart wrapper
  document.getElementById('station-chart-empty').style.display = 'none';
  document.getElementById('station-chart-wrapper').style.display = 'block';
  
  renderStationChart(station);
}

// Latency algorithm: calculates the average number of days the station takes to reflect WTI price drops
function calculateLatency(station, nationalHistory, fuelKey) {
  const stationPrices = station.history[fuelKey] || [];
  if (stationPrices.length < 5 || nationalHistory.length < 5) return null;
  
  // Find periods where WTI dropped by at least 0.015 €/L in 3 days
  const wtiDrops = [];
  for (let i = 3; i < nationalHistory.length; i++) {
    const prevWti = nationalHistory[i-3].wti_eur;
    const currWti = nationalHistory[i].wti_eur;
    if (prevWti && currWti && (prevWti - currWti) >= 0.015) {
      wtiDrops.push({
        date: nationalHistory[i-3].date,
        dropAmount: prevWti - currWti
      });
    }
  }
  
  if (wtiDrops.length === 0) return null;
  
  const lags = [];
  
  for (const drop of wtiDrops) {
    const dropDate = new Date(drop.date);
    
    // Find when the station started dropping its prices correspondingly after this WTI drop
    let localLag = null;
    
    for (let j = 0; j < stationPrices.length - 1; j++) {
      const stationDate = new Date(stationPrices[j].date);
      const diffDays = (stationDate - dropDate) / (1000 * 60 * 60 * 24);
      
      // Look forward up to 10 days
      if (diffDays >= 0 && diffDays <= 10) {
        const currPrice = stationPrices[j].price;
        
        // Check if there is a price drop in the subsequent updates
        for (let k = j + 1; k < Math.min(j + 6, stationPrices.length); k++) {
          const nextPrice = stationPrices[k].price;
          const nextDate = new Date(stationPrices[k].date);
          
          if (currPrice - nextPrice >= 0.005) {
            const lagDays = (nextDate - dropDate) / (1000 * 60 * 60 * 24);
            if (lagDays >= 0 && lagDays <= 12) {
              localLag = Math.round(lagDays);
              break;
            }
          }
        }
      }
      if (localLag !== null) break;
    }
    
    if (localLag !== null) {
      lags.push(localLag);
    }
  }
  
  if (lags.length === 0) return null;
  
  // Calculate average
  const avg = lags.reduce((a, b) => a + b, 0) / lags.length;
  return Math.max(1, Math.round(avg));
}

// Render Station Details Chart
function renderStationChart(station) {
  const ctx = document.getElementById('stationChart').getContext('2d');
  
  // Theme-based colors
  const isDark = document.body.classList.contains('dark-theme');
  const labelColor = isDark ? '#94a3b8' : '#475569';
  const gridColor = isDark ? 'rgba(255, 255, 255, 0.05)' : 'rgba(15, 23, 42, 0.06)';
  const tickColor = isDark ? '#64748b' : '#475569';
  const wtiColor = isDark ? '#06b6d4' : '#0891b2';
  const nationalAvgColor = isDark ? 'rgba(255, 255, 255, 0.4)' : 'rgba(15, 23, 42, 0.4)';
  const marginColor = isDark ? '#fbbf24' : '#d97706';
  const marginBgColor = isDark ? 'rgba(251, 191, 36, 0.05)' : 'rgba(217, 119, 6, 0.05)';
  
  const fuelKey = fuelKeysMap[selectedFuel];
  const stationHistory = station.history[fuelKey] || [];
  
  // Align data
  // We plot using the dates available in the station's history
  const dates = stationHistory.map(h => h.date);
  
  // Map values
  const stationPrices = stationHistory.map(h => h.price);
  
  // Find national average and WTI for the same dates
  const nationalAverages = dates.map(date => {
    const entry = nationalData.find(d => d.date === date);
    return entry ? entry[selectedFuel] : null;
  });
  
  const wtiPrices = dates.map(date => {
    const entry = nationalData.find(d => d.date === date);
    return entry ? entry.wti_eur : null;
  });
  
  // Calculate Part Distributeur
  let ticpe = 0.6629;
  if (fuelKey === 'Gazole') {
    ticpe = 0.5940;
  } else if (fuelKey === 'E10' || fuelKey === 'SP95') {
    ticpe = 0.6629;
  } else if (fuelKey === 'SP98') {
    ticpe = 0.6829;
  }
  
  const stationDistributorShares = dates.map((date, idx) => {
    const pumpPrice = stationPrices[idx];
    const wti = wtiPrices[idx];
    if (pumpPrice && wti !== null && wti !== undefined) {
      const tva = pumpPrice / 6.0;
      return pumpPrice - (tva + ticpe + wti);
    }
    return null;
  });
  
  const nationalDistributorShares = dates.map(date => {
    const entry = nationalData.find(d => d.date === date);
    if (entry) {
      const pumpPrice = entry[selectedFuel];
      const wti = entry.wti_eur;
      if (pumpPrice && wti !== null && wti !== undefined) {
        const tva = pumpPrice / 6.0;
        return pumpPrice - (tva + ticpe + wti);
      }
    }
    return null;
  });
  
  const labels = dates.map(date => {
    const parts = date.split('-');
    return `${parts[2]}/${parts[1]}`;
  });
  
  if (stationChartInstance) {
    stationChartInstance.destroy();
  }
  
  const activeFuelName = fuelLabels[selectedFuel];
  
  stationChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: `${getBrandName(station.brand)} (Locale)`,
          data: stationPrices,
          borderColor: fuelColors[selectedFuel],
          borderWidth: 3,
          fill: false,
          tension: 0.15,
          yAxisID: 'y'
        },
        {
          label: 'Moyenne Nationale',
          data: nationalAverages,
          borderColor: nationalAvgColor,
          borderWidth: 2,
          borderDash: [3, 3],
          fill: false,
          tension: 0.1,
          yAxisID: 'y'
        },
        {
          label: 'Brut WTI',
          data: wtiPrices,
          borderColor: wtiColor,
          borderWidth: 1.5,
          borderDash: [5, 5],
          fill: false,
          tension: 0.1,
          yAxisID: 'y'
        },
        {
          label: 'Part Distributeur (Locale)',
          data: stationDistributorShares,
          borderColor: marginColor,
          borderWidth: 2.5,
          backgroundColor: marginBgColor,
          fill: false,
          tension: 0.2,
          yAxisID: 'y1'
        },
        {
          label: 'Part Distributeur (Moy. Nationale)',
          data: nationalDistributorShares,
          borderColor: isDark ? 'rgba(251, 191, 36, 0.4)' : 'rgba(217, 119, 6, 0.4)',
          borderWidth: 2,
          borderDash: [3, 3],
          fill: false,
          tension: 0.15,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
      },
      elements: {
        point: {
          radius: 0,
          hoverRadius: 5
        }
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            color: labelColor,
            font: { family: 'Outfit', size: 10 }
          }
        }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: tickColor, font: { family: 'Outfit', size: 10 } }
        },
        y: {
          position: 'left',
          grid: { color: gridColor },
          ticks: { color: labelColor, font: { family: 'Outfit', size: 10 } },
          title: { display: true, text: 'Prix à la pompe / WTI (€/L)', color: labelColor, font: { family: 'Outfit', size: 10 } }
        },
        y1: {
          position: 'right',
          grid: { drawOnChartArea: false },
          ticks: { color: marginColor, font: { family: 'Outfit', size: 10 } },
          title: { display: true, text: 'Part Distributeur (€/L)', color: marginColor, font: { family: 'Outfit', size: 10 } }
        }
      }
    }
  });
}
