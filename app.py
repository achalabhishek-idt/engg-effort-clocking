"""
Engineering Resource Utilization Dashboard
Flask backend - JIRA Cloud integration + Claude AI insights
Repository: achalabhishek-idt/engg-effort-clocking
"""

import os
import io
import json
import logging
from datetime import datetime, timedelta
from functools import lru_cache

import pandas as pd
import requests
from flask import Flask, render_template, jsonify, request, send_from_directory
from dotenv import load_dotenv
from concurrent.futures import ThreadPoolExecutor, as_completed
import time

CACHE = {}
CACHE_TTL = 300  # 5 minutes

# JIRA display name → Excel roster name mapping
NAME_MAP = {
    "Aditya Verma": "Aditya Kumar Verma",
    "Pradeep C": "Pradeepa C",
    "Rajashekar Murthy": "Raja Sekhar Murthy Elluru",
    "J Leena": "Leena J",
    "R Swathi": "Swathi R",
    "Sachin B Biradarpatil": "Sachin B",
    "Vadiraj CG": "Vadiraj C G",
}

load_dotenv()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16 MB upload limit

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
JIRA_BASE_URL = os.getenv("JIRA_BASE_URL", "https://subex.atlassian.net")
JIRA_EMAIL = os.getenv("JIRA_EMAIL", "")
JIRA_API_TOKEN = os.getenv("JIRA_API_TOKEN", "") or os.getenv("JIRA_TOKEN", "")
CLAUDE_API_KEY = os.getenv("CLAUDE_API_KEY", "")
EXPECTED_HOURS = int(os.getenv("EXPECTED_HOURS", "168"))

# Project categories
PROJECT_COLUMNS = [
    "DMS", "BMS", "IDT", "GEN", "PLT", "ITO", "HU",
    "DAT", "PAS", "PEM", "Customer Projs", "Platform Projs", "HA", "PEMV2",
]
CUSTOMER_PROJECTS = ["DMS", "BMS", "IDT", "PLT", "ITO", "HU", "DAT", "PAS", "PEM", "Customer Projs", "Platform Projs", "HA", "PEMV2"]
GENERAL_PROJECTS = ["GEN"]

# ---------------------------------------------------------------------------
# JIRA helpers
# ---------------------------------------------------------------------------

def _jira_headers():
    return {"Accept": "application/json", "Content-Type": "application/json"}


def _jira_auth():
    return (JIRA_EMAIL, JIRA_API_TOKEN)

def _fetch_full_worklogs(issue_key):
    """Fetch ALL worklogs for an issue (handles pagination beyond 20)."""
    url = f"{JIRA_BASE_URL}/rest/api/3/issue/{issue_key}/worklog"
    all_worklogs = []
    start_at = 0

    while True:
        try:
            resp = requests.get(
                url, headers=_jira_headers(), auth=_jira_auth(),
                params={"startAt": start_at, "maxResults": 100}, timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            all_worklogs.extend(data.get("worklogs", []))
            if start_at + 100 >= data.get("total", 0):
                break
            start_at += 100
        except requests.RequestException as exc:
            logger.error("Worklog fetch error for %s: %s", issue_key, exc)
            break
    return all_worklogs


def fetch_jira_worklogs(start_date: str, end_date: str, project_keys: list | None = None):
    """Fetch worklogs from JIRA Cloud REST API within a date range."""
    if not JIRA_EMAIL or not JIRA_API_TOKEN:
        logger.warning("JIRA credentials not configured (email=%s, token=%s)",
                       bool(JIRA_EMAIL), bool(JIRA_API_TOKEN))
        return {"error": "JIRA credentials not configured. Upload an Excel file instead.", "data": []}

    jql_parts = [f'worklogDate >= "{start_date}" AND worklogDate <= "{end_date}"']
    if project_keys:
        keys = ", ".join(project_keys)
        jql_parts.append(f"project in ({keys})")

    jql = " AND ".join(jql_parts)
    url = f"{JIRA_BASE_URL}/rest/api/3/search/jql"
    all_issues = []
    start_at = 0
    max_results = 100
    next_token = None

    logger.info("JIRA Query: %s", jql)

    while True:
        params = {
            "jql": jql,
            "maxResults": max_results,
            "fields": "worklog,project,summary,assignee",
        }
        if next_token:
            params["nextPageToken"] = next_token

        try:
            resp = requests.get(url, headers=_jira_headers(), auth=_jira_auth(),
                                params=params, timeout=30)            
            # ── Return the REAL error instead of hiding it ──
            if resp.status_code == 401:
                return {"error": "JIRA returned 401 Unauthorized. Check JIRA_EMAIL and JIRA_API_TOKEN.", "data": []}
            if resp.status_code == 403:
                return {"error": "JIRA returned 403 Forbidden. Your token may lack permissions, or IP allowlist is blocking Azure.", "data": []}
            
            resp.raise_for_status()
            data = resp.json()
            issues = data.get("issues", [])
            all_issues.extend(issues)
            total = data.get("total", 0) or len(all_issues) + 1  # Fallback if total is missing
            logger.info("JIRA: %d/%d issues fetched", start_at + len(issues), total)

            next_token = data.get("nextPageToken")
            if not next_token or len(issues) < max_results:
                break
        except requests.RequestException as exc:
            logger.error("JIRA API error: %s", exc)
            return {"error": f"JIRA API connection error: {str(exc)}", "data": []}

    # ── Parallel fetch full worklogs for issues with 20+ entries ──
    needs_full = [
        iss for iss in all_issues
        if iss.get("fields", {}).get("worklog", {}).get("total", 0)
         > iss.get("fields", {}).get("worklog", {}).get("maxResults", 20)
    ]
    logger.info("Fetching full worklogs for %d issues in parallel...", len(needs_full))

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(_fetch_full_worklogs, iss["key"]): iss for iss in needs_full}
        for future in as_completed(futures):
            iss = futures[future]
            iss["fields"]["worklog"]["worklogs"] = future.result()
            logger.info("  %s: %d worklogs fetched", iss["key"], len(future.result()))

    logger.info("Full worklog fetch complete.")

    rows = _transform_worklogs(all_issues, start_date, end_date)
    return {"data": rows, "start": start_date, "end": end_date}

def _transform_worklogs(issues, start_date, end_date):
    """Transform JIRA issues with worklogs into the utilization matrix.
    
    Extracts worklogs from all issues and aggregates by person and project.
    """
    records: dict[str, dict] = {}  # person -> {project: hours}
    sd = datetime.strptime(start_date, "%Y-%m-%d")
    ed = datetime.strptime(end_date, "%Y-%m-%d")

    worklog_count = 0

    for issue in issues:
        fields = issue.get("fields", {})
        project_key = fields.get("project", {}).get("key", "OTHER")
        issue_key = issue.get("key", "?")
        worklogs = fields.get("worklog", {}).get("worklogs", [])

        for wl in worklogs:
            worklog_count += 1
            started = wl.get("started", "")[:10]
            try:
                wl_date = datetime.strptime(started, "%Y-%m-%d")
            except ValueError:
                logger.warning("Invalid worklog date: %s", started)
                continue
            if not (sd <= wl_date <= ed):
                continue
            # DEBUG — remove after testing
            author_dbg = wl.get("author", {}).get("displayName", "")
            hrs_dbg = wl.get("timeSpentSeconds", 0) / 3600
            if author_dbg == "Achal Abhishek":
                logger.info("DEBUG INCLUDED: %s | %s | %.1fh | issue=%s",
                            author_dbg, started, hrs_dbg, issue_key)
            author = wl.get("author", {}).get("displayName", "Unknown")
            author_email = wl.get("author", {}).get("emailAddress", "")
            hours = wl.get("timeSpentSeconds", 0) / 3600

            if author not in records:
                records[author] = {col: 0.0 for col in PROJECT_COLUMNS}
                records[author]["_email"] = author_email
            
            # Map project key to column (customer projects, general, or unknown)
            if project_key in PROJECT_COLUMNS:
                col = project_key
            elif project_key in CUSTOMER_PROJECTS:
                col = project_key
            else:
                col = "Customer Projs"  # fallback for unmapped projects
            
            records[author][col] = records[author].get(col, 0.0) + hours
            logger.debug("Worklog: %s → %s (%s) = %.2f hours", author, issue_key, col, hours)

    logger.info("Processed %d worklogs for %d unique employees", worklog_count, len(records))

    rows = []
    for person, hours_map in records.items():
        email = hours_map.pop("_email", "")  # Extract email BEFORE summing
        total = sum(hours_map.values())
        gen_hours = hours_map.get("GEN", 0.0)
        proj_hours = total - gen_hours
        rows.append({
            "name": person,
            "email": email,
            **hours_map,
            "total": round(total, 2),
            "expected": EXPECTED_HOURS,
            "clocked_pct": round(total / EXPECTED_HOURS, 4) if EXPECTED_HOURS else 0,
            "proj_pct": round(proj_hours / EXPECTED_HOURS, 4) if EXPECTED_HOURS else 0,
            "general_pct": round(gen_hours / EXPECTED_HOURS, 4) if EXPECTED_HOURS else 0,
        })

    rows.sort(key=lambda r: r["total"], reverse=True)
    logger.info("Returning %d employee records", len(rows))
    return rows


# ---------------------------------------------------------------------------
# Excel parser
# ---------------------------------------------------------------------------

def parse_excel(file_bytes: bytes) -> list[dict]:
    """Parse the uploaded effort-clocking Excel into a list of dicts."""
    df = pd.read_excel(io.BytesIO(file_bytes), sheet_name=0)

    # Detect the name column (first column)
    name_col = df.columns[0]
    df = df.rename(columns={name_col: "name"})

    # Drop summary / NaN rows
    df = df.dropna(subset=["name"])
    df = df[~df["name"].astype(str).str.startswith("NaN")]

    # Normalise column names
    col_map = {}
    for c in df.columns:
        cl = str(c).strip()
        if cl.lower() in ("clocked %", "clocked%", "clocked_pct"):
            col_map[c] = "clocked_pct"
        elif cl.lower() in ("proj %", "proj%", "proj_pct"):
            col_map[c] = "proj_pct"
        elif cl.lower() in ("general %", "general%", "general_pct"):
            col_map[c] = "general_pct"
        elif cl.lower() == "total":
            col_map[c] = "total"
        elif cl.lower() == "expected":
            col_map[c] = "expected"
    df = df.rename(columns=col_map)

    # Fill NaN with 0
    df = df.fillna(0)

    rows = []
    for _, row in df.iterrows():
        name = str(row.get("name", "")).strip()
        if not name or name.lower() == "nan":
            continue
        rec = {"name": name}
        for col in PROJECT_COLUMNS:
            rec[col] = float(row.get(col, 0))
        rec["total"] = float(row.get("total", 0))
        rec["expected"] = float(row.get("expected", EXPECTED_HOURS))
        rec["clocked_pct"] = float(row.get("clocked_pct", 0))
        rec["proj_pct"] = float(row.get("proj_pct", 0))
        rec["general_pct"] = float(row.get("general_pct", 0))
        rows.append(rec)
    return rows


# ---------------------------------------------------------------------------
# Claude AI insights
# ---------------------------------------------------------------------------

def get_claude_insights(data: list[dict]) -> str:
    """Call Claude API to analyse the utilization data."""
    if not CLAUDE_API_KEY:
        return _fallback_insights(data)

    summary_rows = []
    for r in data[:30]:  # send top 30 to keep token usage low
        summary_rows.append(
            f"{r['name']}: Clocked={r['clocked_pct']:.0%}, Proj={r['proj_pct']:.0%}, General={r['general_pct']:.0%}"
        )
    prompt = (
        "You are an engineering manager AI assistant. Analyse the following team utilization data "
        "and provide 4-5 bullet-point insights focusing on:\n"
        "1. Overall team clocking health\n"
        "2. Who is over/under-utilized\n"
        "3. Balance between project work vs general/overhead\n"
        "4. Actionable recommendations\n\n"
        "Data (Clocked% = total/168h, Proj% = project hours/168h, General% = overhead/168h):\n"
        + "\n".join(summary_rows)
    )

    try:
        resp = requests.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": CLAUDE_API_KEY,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json={
                "model": "claude-sonnet-4-20250514",
                "max_tokens": 1024,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()["content"][0]["text"]
    except Exception as exc:
        logger.warning("Claude API error: %s — using fallback insights", exc)
        return _fallback_insights(data)


def _fallback_insights(data: list[dict]) -> str:
    """Generate basic insights without Claude."""
    if not data:
        return "No data available for analysis."

    avg_clocked = sum(r["clocked_pct"] for r in data) / len(data)
    avg_proj = sum(r["proj_pct"] for r in data) / len(data)
    avg_gen = sum(r["general_pct"] for r in data) / len(data)

    over = [r["name"] for r in data if r["clocked_pct"] >= 1.0]
    under = [r["name"] for r in data if r["clocked_pct"] < 0.30]
    healthy = [r for r in data if 0.75 <= r["clocked_pct"] < 1.0]

    lines = [
        f"📊 **Team Overview** — {len(data)} members, avg clocking {avg_clocked:.0%}",
        f"✅ **Healthy range (75-100%):** {len(healthy)} members",
        f"⚠️ **Over-utilized (≥100%):** {', '.join(over) if over else 'None'}",
        f"🔴 **Under-clocked (<30%):** {', '.join(under) if under else 'None'}",
        f"📈 **Avg Project %:** {avg_proj:.0%} | **Avg General/Overhead %:** {avg_gen:.0%}",
    ]
    return "\n".join(lines)


def load_team_roster():
    """Load fixed team roster from JSON file."""
    roster_path = os.path.join(os.path.dirname(__file__), 'team_roster.json')
    try:
        with open(roster_path, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        logger.warning("team_roster.json not found")
        return {"members": [], "expected_hours": 168}


def merge_roster_with_worklogs(worklogs: list[dict], expected_override=None) -> list[dict]:
    roster = load_team_roster()
    expected = expected_override or roster.get("expected_hours", EXPECTED_HOURS)

    # Build lookups by name AND email
    # JIRA display name → Excel roster name mapping
    worklog_by_name = {r["name"].lower().strip(): r for r in worklogs}  # ← existing line 373
    # Apply name mapping: add Excel name aliases for JIRA names
    for jira_name, excel_name in NAME_MAP.items():
        jira_key = jira_name.lower().strip()
        if jira_key in worklog_by_name:
            worklog_by_name[excel_name.lower().strip()] = worklog_by_name[jira_key]
    
    worklog_by_email = {}
    for r in worklogs:
        email = r.get("email", "").lower().strip()
        if email:
            worklog_by_email[email] = r

    merged = []
    matched_keys = set()

    for member in roster.get("members", []):
        name = member["name"]
        name_key = name.lower().strip()
        email_key = member.get("email", "").lower().strip()

        # Try name match first, then email fallback
        row = worklog_by_name.get(name_key) or worklog_by_email.get(email_key)

        if row:
            row["in_roster"] = True
            row["email"] = member.get("email", "")
            matched_keys.add(row["name"].lower().strip())
            merged.append(row)
        else:
            merged.append({
                "name": name,
                "email": member.get("email", ""),
                "in_roster": True,
                "total": 0,
                "expected": expected,
                "clocked_pct": 0,
                "proj_pct": 0,
                "general_pct": 0,
                **{col: 0 for col in PROJECT_COLUMNS},
            })

    for r in worklogs:
        if r["name"].lower().strip() not in matched_keys:
            r["in_roster"] = False
            r["email"] = r.get("email", "")
            merged.append(r)

    merged.sort(key=lambda r: (not r.get("in_roster", True), -r.get("total", 0)))
    logger.info("Roster merge: %d roster, %d matched, %d not in roster",
                len(roster.get("members", [])), len(matched_keys),
                sum(1 for r in merged if not r.get("in_roster", True)))
    
    # Log JIRA users NOT in Excel roster
    roster_names = {r["name"].strip().lower() for r in roster.get("members", [])}
    jira_names = {w["name"] for w in worklogs}
    not_in_roster = [n for n in sorted(jira_names) if n.strip().lower() not in roster_names]
    logger.info("=== JIRA USERS NOT IN ROSTER (%d) ===", len(not_in_roster))
    for name in not_in_roster:
        logger.info("  NOT IN ROSTER: %s", name)

    # Log roster members with 0 hours
    zero_hours = [r["name"] for r in merged if r.get("total", 0) == 0]
    logger.info("=== ROSTER MEMBERS WITH 0 HOURS (%d) ===", len(zero_hours))
    for name in sorted(zero_hours):
        logger.info("  ZERO HOURS: %s", name)

    return merged

# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("dashboard.html")


@app.route("/api/data", methods=["GET"])
def api_data():
    """Fetch data from JIRA or return cached/uploaded data."""
    period = request.args.get("period", "current_month")
    today = datetime.now()

    if period == "current_week":
        start = today - timedelta(days=today.weekday())
        end = today
    elif period == "previous_month":
        first_this = today.replace(day=1)
        end = first_this - timedelta(days=1)
        start = end.replace(day=1)
    elif period == "previous_week":
        start = today - timedelta(days=today.weekday() + 7)
        end = start + timedelta(days=6)
    else:
        start = today.replace(day=1)
        end = today

    start_str = start.strftime("%Y-%m-%d")
    end_str = end.strftime("%Y-%m-%d")

    # Dynamic expected hours based on period
    if period in ("current_week", "previous_week"):
        period_expected = 40   # 8h × 5 days
    else:
        period_expected = EXPECTED_HOURS  # 168h for monthly   

    cache_key = f"{start_str}_{end_str}"    # ← OUTSIDE if/else
    if cache_key in CACHE and (time.time() - CACHE[cache_key]["ts"]) < CACHE_TTL:
        logger.info("Cache HIT for %s", cache_key)
        result = CACHE[cache_key]["data"]
    else:
        logger.info("Cache MISS — fetching from JIRA...")
        result = fetch_jira_worklogs(start_str, end_str)
        CACHE[cache_key] = {"data": result, "ts": time.time()}

    # Merge with fixed 111-member roster
    if "data" in result:
        result["data"] = merge_roster_with_worklogs(result.get("data", []), period_expected)
    else:
        result["data"] = merge_roster_with_worklogs([], period_expected)

    # Recalculate percentages with period-correct expected hours
    for row in result["data"]:
        row["expected"] = period_expected
        total = row.get("total", 0)
        row["clocked_pct"] = round(total / period_expected, 4) if period_expected else 0

    result["period"] = period
    result["expected_hours"] = period_expected
    result["team_size"] = len(result["data"])
    result["roster_size"] = 111
    return jsonify(result), 200

@app.route("/api/upload", methods=["POST"])
def api_upload():
    """Accept an Excel upload and return parsed data."""
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400
    file = request.files["file"]
    if not file.filename.endswith((".xlsx", ".xls")):
        return jsonify({"error": "Only .xlsx / .xls files accepted"}), 400

    try:
        rows = parse_excel(file.read())
        return jsonify({"data": rows, "source": "upload", "filename": file.filename})
    except Exception as exc:
        logger.error("Excel parse error: %s", exc)
        return jsonify({"error": str(exc)}), 500


@app.route("/api/insights", methods=["POST"])
def api_insights():
    """Generate AI insights from posted data."""
    body = request.get_json(silent=True) or {}
    data = body.get("data", [])
    if not data:
        return jsonify({"error": "No data provided"}), 400
    insights = get_claude_insights(data)
    return jsonify({"insights": insights})


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "timestamp": datetime.utcnow().isoformat()})


@app.route("/api/debug/config")
def debug_config():
    """Debug endpoint to check if JIRA credentials are loaded."""
    return jsonify({
        "jira_base_url": JIRA_BASE_URL[:30] + "..." if JIRA_BASE_URL else None,
        "jira_email_set": bool(JIRA_EMAIL),
        "jira_token_set": bool(JIRA_API_TOKEN),
        "claude_key_set": bool(CLAUDE_API_KEY),
        "expected_hours": EXPECTED_HOURS,
    })


@app.route("/api/debug/test-jira")
def debug_test_jira():
    """Test JIRA connectivity with a simple API call."""
    if not JIRA_EMAIL or not JIRA_API_TOKEN:
        return jsonify({"status": "error", "message": "Credentials not set"})
    try:
        resp = requests.get(
            f"{JIRA_BASE_URL}/rest/api/3/myself",
            headers=_jira_headers(),
            auth=_jira_auth(),
            timeout=10,
        )
        if resp.status_code == 200:
            user = resp.json()
            return jsonify({
                "status": "ok",
                "connected_as": user.get("displayName"),
                "email": user.get("emailAddress"),
            })
        else:
            return jsonify({
                "status": "error",
                "http_code": resp.status_code,
                "message": resp.text[:500],
            })
    except Exception as exc:
        return jsonify({"status": "error", "message": str(exc)})

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
