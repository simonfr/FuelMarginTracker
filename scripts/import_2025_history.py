import os
import zipfile
import io
import xml.etree.ElementTree as ET
import json
import datetime
import urllib.request
import sys

# Add scripts directory to path to import update_data
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from update_data import (
    get_aligned_financial_data,
    guess_brand,
    PROJECT_ROOT,
    DATA_DIR,
    STATIONS_DIR,
    USER_AGENT
)

def download_2025_archive():
    url = "https://donnees.roulez-eco.fr/opendata/annee/2025"
    headers = {'User-Agent': USER_AGENT}
    req = urllib.request.Request(url, headers=headers)
    print("Downloading 2025 annual archive (approx. 31MB)...")
    try:
        with urllib.request.urlopen(req) as response:
            return response.read()
    except Exception as e:
        print(f"Error downloading 2025 archive: {e}")
        return None

def parse_annual_xml(xml_content):
    print("Parsing annual XML file...")
    context = ET.iterparse(io.BytesIO(xml_content), events=('end',))
    stations_data = {}
    
    count = 0
    for event, elem in context:
        if elem.tag == 'pdv':
            station_id = elem.get('id')
            cp = elem.get('cp')
            if not cp or len(cp) != 5:
                elem.clear()
                continue
                
            lat_raw = elem.get('latitude')
            lng_raw = elem.get('longitude')
            lat = float(lat_raw) / 100000.0 if lat_raw else None
            lng = float(lng_raw) / 100000.0 if lng_raw else None
            
            adresse_el = elem.find('adresse')
            ville_el = elem.find('ville')
            adresse = adresse_el.text.strip() if adresse_el is not None and adresse_el.text else ""
            ville = ville_el.text.strip() if ville_el is not None and ville_el.text else ""
            
            # Extract all prices
            price_updates = []
            for prix in elem.findall('prix'):
                nom = prix.get('nom')
                valeur = prix.get('valeur')
                maj = prix.get('maj')
                if nom and valeur and maj:
                    date_part = maj.split(' ')[0].split('T')[0]
                    try:
                        price_val = float(valeur)
                        price_updates.append({
                            "fuel": nom,
                            "price": price_val,
                            "date": date_part,
                            "maj": maj
                        })
                    except ValueError:
                        continue
            
            if price_updates:
                stations_data[station_id] = {
                    "cp": cp,
                    "lat": lat,
                    "lng": lng,
                    "adresse": adresse,
                    "ville": ville,
                    "price_updates": price_updates
                }
            
            count += 1
            if count % 2000 == 0:
                print(f"  Processed {count} stations...")
            
            # Clear element to free memory
            elem.clear()
            
    print(f"Finished parsing. Total stations found: {len(stations_data)}")
    return stations_data

def run_import():
    print("=== FuelMarginTracker 2025 History Import Started ===")
    
    # 1. Fetch financial data for Yahoo Finance (last 400 days to cover mid-2025 to today)
    finance_data = get_aligned_financial_data(days=400)
    print(f"Retrieved WTI data for {len(finance_data)} days.")
    
    # 2. Download and extract 2025 archive
    zip_bytes = download_2025_archive()
    if not zip_bytes:
        print("Failed to obtain 2025 zip archive. Aborting.")
        return
        
    xml_content = None
    print("Extracting XML...")
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        xml_files = [n for n in z.namelist() if n.endswith('.xml')]
        if not xml_files:
            print("No XML file found inside the zip. Aborting.")
            return
        with z.open(xml_files[0]) as xml_f:
            xml_content = xml_f.read()
            
    # 3. Parse XML
    stations_data = parse_annual_xml(xml_content)
    del xml_content  # Free memory
    
    # 4. Build timeline for daily national averages (2025-06-09 to 2025-12-31)
    print("Building historical timeline...")
    current_prices = {} # station_id -> { fuel -> price }
    daily_changes = {} # date_str -> list of (station_id, fuel, price)
    
    for s_id, s in stations_data.items():
        current_prices[s_id] = {}
        updates_by_fuel = {}
        for up in s["price_updates"]:
            fuel = up["fuel"]
            if fuel not in updates_by_fuel:
                updates_by_fuel[fuel] = []
            updates_by_fuel[fuel].append(up)
            
        for fuel, ups in updates_by_fuel.items():
            ups.sort(key=lambda x: x["maj"])
            
            # Find price before 2025-06-09 to initialize state
            initial_price = None
            for up in ups:
                if up["date"] < "2025-06-09":
                    initial_price = up["price"]
                else:
                    dt = up["date"]
                    if dt not in daily_changes:
                        daily_changes[dt] = []
                    daily_changes[dt].append((s_id, fuel, up["price"]))
                    
            if initial_price is not None:
                current_prices[s_id][fuel] = initial_price

    start_date = datetime.date(2025, 6, 9)
    end_date = datetime.date(2025, 12, 31)
    
    curr = start_date
    calculated_averages = []
    print("Calculating daily averages...")
    
    while curr <= end_date:
        dt_str = curr.isoformat()
        
        # Apply changes for this day
        if dt_str in daily_changes:
            for s_id, fuel, price in daily_changes[dt_str]:
                if s_id not in current_prices:
                    current_prices[s_id] = {}
                current_prices[s_id][fuel] = price
                
        # Calculate averages for this day
        sums = {"Gazole": 0.0, "SP95": 0.0, "SP98": 0.0, "E10": 0.0}
        counts = {"Gazole": 0, "SP95": 0, "SP98": 0, "E10": 0}
        
        for s_id, fuels in current_prices.items():
            for fuel, price in fuels.items():
                if fuel in sums:
                    sums[fuel] += price
                    counts[fuel] += 1
                    
        averages = {}
        for fuel in sums:
            if counts[fuel] > 0:
                averages[fuel] = round(sums[fuel] / counts[fuel], 4)
            else:
                averages[fuel] = None
                
        # Align with WTI
        finance = finance_data.get(dt_str)
        if not finance and finance_data:
            past_dates = [d for d in finance_data.keys() if d <= dt_str]
            if past_dates:
                finance = finance_data[max(past_dates)]
        wti_eur = finance["wti_eur"] if finance else None
        
        calculated_averages.append({
            "date": dt_str,
            "gazole": averages.get("Gazole"),
            "sp95": averages.get("SP95"),
            "sp98": averages.get("SP98"),
            "e10": averages.get("E10"),
            "wti_eur": wti_eur
        })
        
        curr += datetime.timedelta(days=1)
        
    print(f"Computed {len(calculated_averages)} days of 2025 national history.")
    
    # 5. Load and Merge National Data
    national_file = os.path.join(DATA_DIR, "national.json")
    existing_national = []
    if os.path.exists(national_file):
        with open(national_file, 'r', encoding='utf-8') as f:
            existing_national = json.load(f)
            
    # Combine and deduplicate
    combined_national = {entry["date"]: entry for entry in existing_national}
    for entry in calculated_averages:
        combined_national[entry["date"]] = entry
        
    sorted_national = [combined_national[d] for d in sorted(combined_national.keys())]
    
    # Keep rolling 365 days
    cutoff_365 = (datetime.date.today() - datetime.timedelta(days=365)).isoformat()
    sorted_national = [entry for entry in sorted_national if entry["date"] >= cutoff_365]
    
    with open(national_file, 'w', encoding='utf-8') as f:
        json.dump(sorted_national, f, ensure_ascii=False, separators=(',', ':'))
    print(f"Updated national.json. Current size: {len(sorted_national)} entries (starts {sorted_national[0]['date']}).")
    
    # 6. Prepend history to all station files
    print("Merging 2025 station histories into postal code files...")
    # List all station files
    for filename in os.listdir(STATIONS_DIR):
        if not filename.endswith(".json"):
            continue
            
        cp_path = os.path.join(STATIONS_DIR, filename)
        try:
            with open(cp_path, 'r', encoding='utf-8') as f:
                cp_data = json.load(f)
                
            modified = False
            for station in cp_data.get("stations", []):
                s_id = station["id"]
                if s_id not in stations_data:
                    continue
                    
                s_annual_info = stations_data[s_id]
                
                # Filter 2025 updates for this station
                updates_2025 = [
                    up for up in s_annual_info["price_updates"]
                    if "2025-06-09" <= up["date"] <= "2025-12-31"
                ]
                
                if not updates_2025:
                    continue
                    
                # Group 2025 updates by fuel
                grouped_2025 = {}
                for up in updates_2025:
                    fuel = up["fuel"]
                    if fuel not in grouped_2025:
                        grouped_2025[fuel] = []
                    grouped_2025[fuel].append({
                        "date": up["date"],
                        "price": up["price"]
                    })
                    
                # Merge into existing history
                if "history" not in station:
                    station["history"] = {}
                    
                for fuel, new_history in grouped_2025.items():
                    existing_history = station["history"].get(fuel, [])
                    
                    # Deduplicate by date
                    merged_history = {h["date"]: h for h in existing_history}
                    for h in new_history:
                        if h["date"] not in merged_history:
                            merged_history[h["date"]] = h
                            
                    sorted_history = [merged_history[d] for d in sorted(merged_history.keys())]
                    
                    # Keep rolling 365 days
                    sorted_history = [h for h in sorted_history if h["date"] >= cutoff_365]
                    
                    station["history"][fuel] = sorted_history
                    modified = True
                    
            if modified:
                with open(cp_path, 'w', encoding='utf-8') as f:
                    json.dump(cp_data, f, ensure_ascii=False, separators=(',', ':'))
                    
        except Exception as e:
            print(f"Error processing station file {filename}: {e}")
            
    print("=== FuelMarginTracker 2025 History Import Completed Successfully ===")

if __name__ == "__main__":
    run_import()
