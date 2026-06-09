import os
import urllib.request
import zipfile
import io
import xml.etree.ElementTree as ET
import json
import datetime
from update_data import (
    get_station_names,
    get_aligned_financial_data,
    parse_fuel_xml,
    calculate_national_averages,
    update_database,
    PROJECT_ROOT,
    DATA_DIR,
    STATIONS_DIR,
    USER_AGENT
)

def fetch_daily_fuel_data(date_str):
    """Downloads daily fuel price XML zip for a given date YYYYMMDD."""
    url = f"https://donnees.roulez-eco.fr/opendata/jour/{date_str}"
    headers = {'User-Agent': USER_AGENT}
    req = urllib.request.Request(url, headers=headers)
    try:
        print(f"Downloading fuel data for {date_str}...")
        with urllib.request.urlopen(req) as response:
            return response.read()
    except Exception as e:
        print(f"Warning: Could not fetch daily fuel data for {date_str}: {e}")
        return None

def run_bootstrap():
    print(" FuelMarginTracker Bootstrap Script Started ")
    print("---------------------------------------")
    
    # 1. Fetch station names mapping
    names_map = get_station_names()
    
    # 2. Fetch financial data for WTI and EURUSD for the last 60 days
    finance_data = get_aligned_financial_data(days=60)
    print(f"Retrieved {len(finance_data)} days of financial records.")
    
    # 3. Download and parse last 15 days of fuel prices to build historical curves
    today = datetime.date.today()
    
    # We will process dates in chronological order so that updates append correctly
    dates_to_fetch = []
    for i in range(15, -1, -1):
        dt = today - datetime.timedelta(days=i)
        dates_to_fetch.append(dt)
        
    # Temporary storage for national history to write it in order
    national_history = []
    
    # We will aggregate all station updates across these days
    # To avoid writing to disk 15 times for every postal code (which is slow),
    # we will buffer all station histories in memory and write them at the end!
    station_histories = {} # station_id -> { "cp": ..., "adresse": ..., "ville": ..., "brand": ..., "lat": ..., "lng": ..., "history": { fuel: [{"date": ..., "price": ...}, ...] } }
    
    print(f"Beginning download of {len(dates_to_fetch)} daily fuel files...")
    
    for dt in dates_to_fetch:
        date_str = dt.isoformat()
        date_param = date_str.replace("-", "")
        
        zip_bytes = fetch_daily_fuel_data(date_param)
        if not zip_bytes:
            continue
            
        try:
            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
                xml_files = [n for n in z.namelist() if n.endswith('.xml')]
                if not xml_files:
                    continue
                with z.open(xml_files[0]) as xml_f:
                    xml_content = xml_f.read()
            
            # Parse XML
            day_stations = parse_fuel_xml(xml_content, names_map)
            print(f"  Successfully parsed {len(day_stations)} stations for {date_str}.")
            
            # Calculate National Averages
            averages = calculate_national_averages(day_stations, date_str)
            
            # Find finance data for this date
            finance = finance_data.get(date_str)
            if not finance and finance_data:
                # Find closest preceding date
                past_dates = [d for d in finance_data.keys() if d <= date_str]
                if past_dates:
                    finance = finance_data[max(past_dates)]
                    
            wti_eur = finance["wti_eur"] if finance else None
            
            national_history.append({
                "date": date_str,
                "gazole": averages.get("Gazole"),
                "sp95": averages.get("SP95"),
                "sp98": averages.get("SP98"),
                "e10": averages.get("E10"),
                "wti_eur": wti_eur
            })
            
            # Aggregate station updates in memory
            for s_id, s in day_stations.items():
                if s_id not in station_histories:
                    station_histories[s_id] = {
                        "id": s_id,
                        "cp": s["cp"],
                        "brand": s["brand"],
                        "adresse": s["adresse"],
                        "ville": s["ville"],
                        "lat": s["lat"],
                        "lng": s["lng"],
                        "history": {}
                    }
                
                node = station_histories[s_id]
                # Update basic info to latest
                node["adresse"] = s["adresse"]
                node["ville"] = s["ville"]
                node["brand"] = s["brand"]
                node["lat"] = s["lat"]
                node["lng"] = s["lng"]
                
                # Append prices
                for fuel, p_info in s["prices"].items():
                    if fuel not in node["history"]:
                        node["history"][fuel] = []
                    # Avoid duplicates for same date
                    node["history"][fuel] = [h for h in node["history"][fuel] if h["date"] != p_info["date"]]
                    node["history"][fuel].append({
                        "date": p_info["date"],
                        "price": p_info["price"]
                    })
                    
        except Exception as e:
            print(f"  Error processing {date_str}: {e}")
            continue
            
    # Write National History
    national_file = os.path.join(DATA_DIR, "national.json")
    # Sort history chronologically
    national_history.sort(key=lambda x: x["date"])
    
    with open(national_file, 'w', encoding='utf-8') as f:
        json.dump(national_history, f, ensure_ascii=False, separators=(',', ':'))
    print(f"Created national.json with {len(national_history)} historical entries.")
    
    # Write Station Files grouped by postal code
    print(f"Writing station details to postal-code JSON files...")
    stations_by_cp = {}
    for s_id, node in station_histories.items():
        cp = node["cp"]
        if cp not in stations_by_cp:
            stations_by_cp[cp] = []
        
        # Sort history keys chronologically
        for fuel in node["history"]:
            node["history"][fuel].sort(key=lambda x: x["date"])
            
        stations_by_cp[cp].append(node)
        
    # Write files
    for cp, stations_list in stations_by_cp.items():
        cp_file = os.path.join(STATIONS_DIR, f"{cp}.json")
        cp_data = {
            "cp": cp,
            "stations": stations_list
        }
        with open(cp_file, 'w', encoding='utf-8') as f:
            json.dump(cp_data, f, ensure_ascii=False, separators=(',', ':'))
            
    # Generate search index
    print("Generating search index...")
    search_items = {}
    for cp_val, stations_list in stations_by_cp.items():
        cities = set()
        for st in stations_list:
            if st.get("ville"):
                cities.add(st["ville"].title())
        search_items[cp_val] = list(cities)
        
    search_index = []
    for cp_val, cities in sorted(search_items.items()):
        search_index.append({
            "cp": cp_val,
            "cities": sorted(cities)
        })
        
    index_file = os.path.join(DATA_DIR, "search_index.json")
    with open(index_file, 'w', encoding='utf-8') as f:
        json.dump(search_index, f, ensure_ascii=False, separators=(',', ':'))
        
    print("---------------------------------------")
    print(" FuelMarginTracker Bootstrap completed! ")

if __name__ == "__main__":
    run_bootstrap()
