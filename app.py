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
JIRA_API_TOKEN = os.getenv("JIRA_API_TOKEN", "")
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


def fetch_jira_worklogs(start_date: str, end_date: str, project_keys: list | None = None):
    """Fetch worklogs from JIRA Cloud REST API within a date range."""
    if not JIRA_EMAIL or not JIRA_API_TOKEN:
        return None

    jql_parts = [f'worklogDate >= "{start_date}" AND worklogDate <= "{end_date}"']
    if project_keys:
        keys = ", ".join(project_keys)
        jql_parts.append(f"project in ({keys})")

    jql = " AND ".join(jql_parts)
    url = f"{JIRA_BASE_URL}/rest/api/3/search"
    all_issues = []
    start_at = 0
    max_results = 100

    while True:
        params = {
            "jql": jql,
            "startAt": start_at,
            "maxResults": max_results,
            "fields": "worklog,project,summary,assignee",
        }
        try:
            resp = requests.get(url, headers=_jira_headers(), auth=_jira_auth(), params=params, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            issues = data.get("issues", [])
            all_issues.extend(issues)
            if start_at + max_results >= data.get("total", 0):
                break
            start_at += max_results
        except requests.RequestException as exc:
            logger.error("JIRA API error: %s", exc)
            break

    return _transform_worklogs(all_issues, start_date, end_date)


def _transform_worklogs(issues, start_date, end_date):
    """Transform JIRA issues with worklogs into the utilization matrix."""
    records: dict[str, dict] = {}  # person -> {project: hours}
    sd = datetime.strptime(start_date, "%Y-%m-%d")
    ed = datetime.strptime(end_date, "%Y-%m-%d")

    for issue in issues:
        fields = issue.get("fields", {})
        project_key = fields.get("project", {}).get("key", "OTHER")
        worklogs = fields.get("worklog", {}).get("worklogs", [])

        for wl in worklogs:
            started = wl.get("started", "")[:10]
            try:
                wl_date = datetime.strptime(started, "%Y-%m-%d")
            except ValueError:
                continue
            if not (sd <= wl_date <= ed):
                continue

            author = wl.get("author", {}).get("displayName", "Unknown")
            hours = wl.get("timeSpentSeconds", 0) / 3600

            if author not in records:
                records[author] = {col: 0.0 for col in PROJECT_COLUMNS}
            col = project_key if project_key in PROJECT_COLUMNS else "Customer Projs"
            records[author][col] = records[author].get(col, 0.0) + hours

    rows = []
    for person, hours_map in records.items():
        total = sum(hours_map.values())
        gen_hours = hours_map.get("GEN", 0.0)
        proj_hours = total - gen_hours
        rows.append({
            "name": person,
            **hours_map,
            "total": round(total, 2),
            "expected": EXPECTED_HOURS,
            "clocked_pct": round(total / EXPECTED_HOURS, 4) if EXPECTED_HOURS else 0,
            "proj_pct": round(proj_hours / EXPECTED_HOURS, 4) if EXPECTED_HOURS else 0,
            "general_pct": round(gen_hours / EXPECTED_HOURS, 4) if EXPECTED_HOURS else 0,
        })
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
    else:  # current_month
        start = today.replace(day=1)
        end = today

    start_str = start.strftime("%Y-%m-%d")
    end_str = end.strftime("%Y-%m-%d")

    rows = fetch_jira_worklogs(start_str, end_str)
    if rows is None:
        return jsonify({"error": "JIRA credentials not configured. Upload an Excel file instead.", "data": []}), 200
    return jsonify({"data": rows, "period": period, "start": start_str, "end": end_str})


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


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
