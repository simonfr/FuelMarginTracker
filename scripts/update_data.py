import os
import urllib.request
import zipfile
import io
import xml.etree.ElementTree as ET
import json
import datetime

# Configuration
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
STATIONS_DIR = os.path.join(DATA_DIR, "stations")

# Ensure directories exist
os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(STATIONS_DIR, exist_ok=True)

# User agent to bypass basic bot blockers
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

def fetch_url(url, headers=None):
    if headers is None:
        headers = {'User-Agent': USER_AGENT}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as response:
        return response.read()

def get_station_names():
    """Fetches the station names mapping from the Home Assistant community integration."""
    url = "https://raw.githubusercontent.com/Aohzan/hass-prixcarburant/master/custom_components/prix_carburant/stations_name.json"
    try:
        print("Fetching station names from Aohzan/hass-prixcarburant...")
        data = fetch_url(url)
        return json.loads(data.decode('utf-8'))
    except Exception as e:
        print(f"Warning: Could not fetch station names: {e}. Falling back to brand guessing.")
        return {}

def fetch_yahoo_history(ticker, period="180d"):
    """Fetches historical daily close prices from Yahoo Finance."""
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}?range={period}&interval=1d"
    try:
        print(f"Fetching financial history for {ticker}...")
        data = fetch_url(url)
        parsed = json.loads(data.decode('utf-8'))
        result = parsed['chart']['result'][0]
        timestamps = result.get('timestamp', [])
        closes = result['indicators']['quote'][0].get('close', [])
        
        date_map = {}
        for ts, close in zip(timestamps, closes):
            if close is not None:
                dt = datetime.datetime.fromtimestamp(ts).date().isoformat()
                date_map[dt] = close
        return date_map
    except Exception as e:
        print(f"Error fetching Yahoo Finance data for {ticker}: {e}")
        return {}

def get_aligned_financial_data(days=180):
    """Aligns WTI Crude prices in USD with EURUSD exchange rates to compute WTI in EUR/L."""
    wti_usd_map = fetch_yahoo_history("CL=F", f"{days}d")
    eurusd_map = fetch_yahoo_history("EURUSD=X", f"{days}d")
    
    end_date = datetime.date.today()
    start_date = end_date - datetime.timedelta(days=days)
    
    aligned = {}
    last_wti = None
    last_rate = None
    
    # We default exchange rate to 1.08 if we fail to fetch
    curr = start_date
    while curr <= end_date:
        dt_str = curr.isoformat()
        if dt_str in wti_usd_map:
            last_wti = wti_usd_map[dt_str]
        if dt_str in eurusd_map:
            last_rate = eurusd_map[dt_str]
            
        if last_wti is not None and last_rate is not None:
            # 1 barrel = 158.9873 liters
            wti_eur_l = (last_wti / 158.9873) / last_rate
            aligned[dt_str] = {
                "wti_usd": round(last_wti, 2),
                "eurusd": round(last_rate, 4),
                "wti_eur": round(wti_eur_l, 4)
            }
        curr += datetime.timedelta(days=1)
        
    return aligned

def guess_brand(adresse, ville):
    addr_upper = (adresse + " " + ville).upper()
    if "TOTAL" in addr_upper:
        return "Total"
    elif "CARREFOUR" in addr_upper:
        return "Carrefour"
    elif "LECLERC" in addr_upper or "L.E.C.L.E.R.C" in addr_upper:
        return "E.Leclerc"
    elif "INTERMARCHE" in addr_upper or "INTERMARCHÉ" in addr_upper:
        return "Intermarché"
    elif "SYSTEME U" in addr_upper or "SYSTEME_U" in addr_upper or "SUPER U" in addr_upper or "HYPER U" in addr_upper or "U EXPRESS" in addr_upper:
        return "Système U"
    elif "ESSO" in addr_upper:
        return "Esso"
    elif "BP " in addr_upper or " BP" in addr_upper:
        return "BP"
    elif "AVIA" in addr_upper:
        return "Avia"
    elif "CASINO" in addr_upper:
        return "Casino"
    elif "ELAN" in addr_upper:
        return "Elan"
    elif "SHELL" in addr_upper:
        return "Shell"
    elif "DYNEFF" in addr_upper:
        return "Dyneff"
    elif "AUCHAN" in addr_upper:
        return "Auchan"
    elif "CORA" in addr_upper:
        return "Cora"
    elif "COLRUYT" in addr_upper:
        return "Colruyt"
    elif "NETTO" in addr_upper:
        return "Netto"
    return "Indépendant"

def parse_fuel_xml(xml_bytes, names_map):
    """Parses the fuel XML file and calculates averages and station details."""
    print("Parsing fuel price XML...")
    root = ET.fromstring(xml_bytes)
    
    # We want to extract station information and their latest prices
    stations = {}
    
    # To filter out inactive/closed stations, we only keep prices updated in the last 180 days
    today = datetime.date.today()
    cutoff_date = today - datetime.timedelta(days=180)
    
    for pdv in root.findall('pdv'):
        cp = pdv.get('cp')
        if not cp or len(cp) != 5:
            continue
            
        station_id = pdv.get('id')
        lat_raw = pdv.get('latitude')
        lng_raw = pdv.get('longitude')
        
        # Lat/Lng are divided by 100,000
        lat = float(lat_raw) / 100000.0 if lat_raw else None
        lng = float(lng_raw) / 100000.0 if lng_raw else None
        
        adresse_el = pdv.find('adresse')
        ville_el = pdv.find('ville')
        
        adresse = adresse_el.text.strip() if adresse_el is not None and adresse_el.text else ""
        ville = ville_el.text.strip() if ville_el is not None and ville_el.text else ""
        
        # Get brand
        brand = names_map.get(station_id, "")
        if brand and isinstance(brand, dict):
            brand = brand.get("name") or brand.get("brand") or "Station"
        elif not brand:
            brand = guess_brand(adresse, ville)
            
        # Parse prices
        prices = {}
        for prix in pdv.findall('prix'):
            nom = prix.get('nom')
            valeur = prix.get('valeur')
            maj = prix.get('maj')
            
            if nom and valeur and maj:
                # Format of maj is typically 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DDTHH:MM:SS'
                # Extract date part
                date_part = maj.split(' ')[0].split('T')[0]
                try:
                    price_val = float(valeur)
                    price_date = datetime.date.fromisoformat(date_part)
                    
                    # Ignore values older than cutoff
                    if price_date >= cutoff_date:
                        # Keep only the latest update for this fuel type
                        if nom not in prices or maj > prices[nom]['maj']:
                            prices[nom] = {
                                "price": price_val,
                                "date": date_part,
                                "maj": maj
                            }
                except ValueError:
                    continue
                    
        # Only include station if it has active prices
        if prices:
            stations[station_id] = {
                "id": station_id,
                "cp": cp,
                "lat": lat,
                "lng": lng,
                "adresse": adresse,
                "ville": ville,
                "brand": brand,
                "prices": {k: {"price": v["price"], "date": v["date"]} for k, v in prices.items()}
            }
            
    return stations

def calculate_national_averages(stations, today_str):
    """Calculates national average prices for each fuel type."""
    sums = {"Gazole": 0.0, "SP95": 0.0, "SP98": 0.0, "E10": 0.0}
    counts = {"Gazole": 0, "SP95": 0, "SP98": 0, "E10": 0}
    
    for s in stations.values():
        for fuel_type, price_info in s["prices"].items():
            if fuel_type in sums:
                # Only average prices updated recently (within 7 days of today)
                # to avoid skewing averages with very stale data
                try:
                    price_date = datetime.date.fromisoformat(price_info["date"])
                    days_diff = (datetime.date.fromisoformat(today_str) - price_date).days
                    if days_diff <= 7:
                        sums[fuel_type] += price_info["price"]
                        counts[fuel_type] += 1
                except Exception:
                    continue
                    
    averages = {}
    for fuel_type in sums:
        if counts[fuel_type] > 0:
            averages[fuel_type] = round(sums[fuel_type] / counts[fuel_type], 4)
        else:
            averages[fuel_type] = None
    return averages

def update_database(stations, finance_data):
    """Updates the static JSON files on a rolling 180-day window basis."""
    today_str = datetime.date.today().isoformat()
    
    # 1. Update National Data
    national_file = os.path.join(DATA_DIR, "national.json")
    national_history = []
    if os.path.exists(national_file):
        try:
            with open(national_file, 'r', encoding='utf-8') as f:
                national_history = json.load(f)
        except Exception as e:
            print(f"Error reading national.json: {e}. Initializing new history.")
            
    # Calculate today's averages
    today_averages = calculate_national_averages(stations, today_str)
    
    # Find finance data for today (or fallback to latest available)
    today_finance = finance_data.get(today_str)
    if not today_finance and finance_data:
        # Get the latest entry
        latest_date = max(finance_data.keys())
        today_finance = finance_data[latest_date]
        print(f"No financial data for {today_str}, using latest from {latest_date}")
        
    wti_eur = today_finance["wti_eur"] if today_finance else None
    
    # Create or update entry for today
    today_entry = {
        "date": today_str,
        "gazole": today_averages.get("Gazole"),
        "sp95": today_averages.get("SP95"),
        "sp98": today_averages.get("SP98"),
        "e10": today_averages.get("E10"),
        "wti_eur": wti_eur
    }
    
    # Merge into national history, avoiding duplicates
    updated_history = [entry for entry in national_history if entry["date"] != today_str]
    updated_history.append(today_entry)
    
    # Sort and keep rolling 180 days of national history (gives a nice chart)
    updated_history.sort(key=lambda x: x["date"])
    updated_history = updated_history[-180:]
    
    with open(national_file, 'w', encoding='utf-8') as f:
        json.dump(updated_history, f, ensure_ascii=False, separators=(',', ':'))
    print(f"Updated national.json. Current size: {len(updated_history)} days.")
    
    # 2. Group stations by postal code and update station files
    # First, list all postal codes in the current update
    updated_cps = set()
    stations_by_cp = {}
    for s_id, s in stations.items():
        cp = s["cp"]
        updated_cps.add(cp)
        if cp not in stations_by_cp:
            stations_by_cp[cp] = []
        stations_by_cp[cp].append(s)
        
    # We update the postal code files incrementally
    # Format inside data/stations/{cp}.json:
    # {
    #   "cp": "35000",
    #   "stations": [
    #      {
    #         "id": "...",
    #         "brand": "...",
    #         "adresse": "...",
    #         "ville": "...",
    #         "lat": ...,
    #         "lng": ...,
    #         "history": {
    #            "Gazole": [{"date": "2026-06-08", "price": 1.679}, ...],
    #            "E10": [...]
    #         }
    #      }
    #   ]
    # }
    print(f"Updating {len(updated_cps)} station JSON files...")
    cutoff_history = (datetime.date.today() - datetime.timedelta(days=180)).isoformat()
    
    for cp in updated_cps:
        cp_file = os.path.join(STATIONS_DIR, f"{cp}.json")
        existing_data = {"cp": cp, "stations": []}
        
        if os.path.exists(cp_file):
            try:
                with open(cp_file, 'r', encoding='utf-8') as f:
                    existing_data = json.load(f)
            except Exception:
                pass
                
        # Index existing stations by ID
        existing_stations = {s["id"]: s for s in existing_data.get("stations", [])}
        
        # Update/insert stations
        for s in stations_by_cp[cp]:
            s_id = s["id"]
            if s_id in existing_stations:
                station_node = existing_stations[s_id]
                # Update basic info
                station_node["adresse"] = s["adresse"]
                station_node["ville"] = s["ville"]
                station_node["brand"] = s["brand"]
                station_node["lat"] = s["lat"]
                station_node["lng"] = s["lng"]
            else:
                station_node = {
                    "id": s_id,
                    "brand": s["brand"],
                    "adresse": s["adresse"],
                    "ville": s["ville"],
                    "lat": s["lat"],
                    "lng": s["lng"],
                    "history": {}
                }
                existing_stations[s_id] = station_node
                
            # Append new prices to history
            if "history" not in station_node:
                station_node["history"] = {}
                
            for fuel, p_info in s["prices"].items():
                if fuel not in station_node["history"]:
                    station_node["history"][fuel] = []
                # Remove if date already exists to avoid duplicate
                station_node["history"][fuel] = [h for h in station_node["history"][fuel] if h["date"] != p_info["date"]]
                # Append new price
                station_node["history"][fuel].append({
                    "date": p_info["date"],
                    "price": p_info["price"]
                })
                
                # Sort and clean history older than 180 days
                station_node["history"][fuel].sort(key=lambda x: x["date"])
                station_node["history"][fuel] = [h for h in station_node["history"][fuel] if h["date"] >= cutoff_history]
                
        # Save updated data
        cp_stations_list = list(existing_stations.values())
        # Clean stations with empty history
        cp_stations_list = [s for s in cp_stations_list if any(s.get("history", {}).values())]
        
        existing_data["stations"] = cp_stations_list
        
        with open(cp_file, 'w', encoding='utf-8') as f:
            json.dump(existing_data, f, ensure_ascii=False, separators=(',', ':'))
            
    # 3. Create Search Index File
    print("Generating search index...")
    # Read all station files and collect postal codes and cities
    search_items = {}
    for filename in os.listdir(STATIONS_DIR):
        if filename.endswith(".json"):
            cp_val = filename[:-5]
            cp_path = os.path.join(STATIONS_DIR, filename)
            try:
                with open(cp_path, 'r', encoding='utf-8') as f:
                    content = json.load(f)
                    cities = set()
                    for st in content.get("stations", []):
                        if st.get("ville"):
                            cities.add(st["ville"].title())
                    search_items[cp_val] = list(cities)
            except Exception:
                continue
                
    # Format search index as list of {cp, cities} sorted
    search_index = []
    for cp_val, cities in sorted(search_items.items()):
        search_index.append({
            "cp": cp_val,
            "cities": sorted(cities)
        })
        
    index_file = os.path.join(DATA_DIR, "search_index.json")
    with open(index_file, 'w', encoding='utf-8') as f:
        json.dump(search_index, f, ensure_ascii=False, separators=(',', ':'))
    print("Search index updated.")
    
    # 4. Generate Margins Ranking File
    print("Generating margins ranking...")
    generate_rankings(stations, wti_eur)

def generate_rankings(stations, wti_eur):
    """Generates the top 10 and bottom 10 stations by margin for each fuel type."""
    if wti_eur is None:
        print("Warning: Cannot calculate margins ranking because WTI price is missing.")
        return
        
    fuels = ["Gazole", "SP95", "SP98", "E10"]
    rankings = {}
    
    for fuel in fuels:
        fuel_stations = []
        for s_id, s in stations.items():
            if fuel in s["prices"]:
                p_info = s["prices"][fuel]
                price = p_info["price"]
                brand_name = s["brand"]
                if isinstance(brand_name, dict):
                    brand_name = brand_name.get("name") or brand_name.get("brand") or "Station"
                    
                fuel_stations.append({
                    "id": s_id,
                    "brand": brand_name,
                    "adresse": s["adresse"],
                    "ville": s["ville"],
                    "cp": s["cp"],
                    "price": price,
                    "margin": round(price - wti_eur, 4)
                })
                
        if not fuel_stations:
            rankings[fuel] = {"top": [], "bottom": []}
            continue
            
        # Sort by price ascending
        fuel_stations.sort(key=lambda x: x["price"])
        
        # Bottom 10 (cheapest prices/margins)
        bottom_10 = fuel_stations[:10]
        
        # Top 10 (most expensive prices/margins)
        top_10 = fuel_stations[-10:]
        top_10.reverse()
        
        rankings[fuel] = {
            "top": top_10,
            "bottom": bottom_10
        }
        
    ranking_file = os.path.join(DATA_DIR, "margins_ranking.json")
    with open(ranking_file, 'w', encoding='utf-8') as f:
        json.dump(rankings, f, ensure_ascii=False, separators=(',', ':'))
    print("Margins rankings updated.")

def run_update():
    print("FuelMarginTracker Update Job Started.")
    
    # Step 1: Fetch station names
    names_map = get_station_names()
    
    # Step 2: Fetch Yahoo finance data
    finance_data = get_aligned_financial_data(days=180)
    
    # Step 3: Fetch French fuel instant data
    print("Downloading French fuel price instant data...")
    fuel_zip_url = "https://donnees.roulez-eco.fr/opendata/instantane"
    try:
        zip_bytes = fetch_url(fuel_zip_url)
        print(f"Downloaded zip file ({len(zip_bytes)} bytes).")
        with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
            xml_files = [n for n in z.namelist() if n.endswith('.xml')]
            if not xml_files:
                raise Exception("No XML file found inside the zip.")
            
            with z.open(xml_files[0]) as xml_f:
                xml_content = xml_f.read()
                
        stations = parse_fuel_xml(xml_content, names_map)
        print(f"Parsed {len(stations)} active stations.")
        
        # Step 4: Update database
        update_database(stations, finance_data)
        print("FuelMarginTracker Update Job completed successfully!")
    except Exception as e:
        print(f"CRITICAL ERROR in Update Job: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    run_update()
