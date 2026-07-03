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
from typing import Any

import requests
from flask import Flask, render_template, jsonify, request, send_from_directory
from dotenv import load_dotenv
from concurrent.futures import ThreadPoolExecutor, as_completed
import time
from threading import Thread

CACHE = {}
CACHE_TTL = 1800  # 30 minutes

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
EXPECTED_HOURS = int(os.getenv("EXPECTED_HOURS", "168"))

# Project categories
PROJECT_COLUMNS = [
    "DMS", "BMS", "IDT", "GEN", "PLT", "ITO", "HU",
    "DAT", "PAS", "PEM", "Customer Projs", "Platform Projs", "HA", "PEMV2", "ED"
]
CUSTOMER_PROJECTS = ["DMS", "BMS", "IDT", "PLT", "ITO", "HU", "DAT", "PAS", "PEM", "Customer Projs", "Platform Projs", "HA", "PEMV2"]
GENERAL_PROJECTS = ["GEN"]

# ---------------------------------------------------------------------------
# JIRA helpers
# ---------------------------------------------------------------------------

def _jira_headers():
    return {"Accept": "application/json", "Content-Type": "application/json"}


def _jira_credentials():
    email = os.getenv("JIRA_EMAIL", "")
    token = os.getenv("JIRA_API_TOKEN", "") or os.getenv("JIRA_TOKEN", "")
    return email, token


def _jira_auth():
    return _jira_credentials()

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
    jira_email, jira_token = _jira_credentials()

    if not jira_email or not jira_token:
        logger.warning("JIRA credentials not configured (email=%s, token=%s)",
                       bool(jira_email), bool(jira_token))
        return {"error": "JIRA credentials not configured. Upload an Excel file instead.", "data": []}

    # Extend fetch window 90 days into the future to catch future-dated worklogs
    # (people who accidentally log hours on future dates)
    fetch_end = (datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=90)).strftime("%Y-%m-%d")
    jql_parts = [f'worklogDate >= "{start_date}" AND worklogDate <= "{fetch_end}"']
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
            "fields": "worklog,project",
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

    with ThreadPoolExecutor(max_workers=20) as executor:
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
    Worklogs outside [start_date, end_date] (e.g. future-dated) are included
    in the worklogs list for anomaly detection but NOT counted in utilization.
    """
    records: dict[str, dict] = {}  # person -> {project: hours}
    sd = datetime.strptime(start_date, "%Y-%m-%d")
    ed = datetime.strptime(end_date, "%Y-%m-%d")
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

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

            is_future = wl_date > today
            in_period = sd <= wl_date <= ed

            # Skip worklogs that are neither in the period nor future-dated
            if not in_period and not is_future:
                continue

            author = wl.get("author", {}).get("displayName", "Unknown")
            author_email = wl.get("author", {}).get("emailAddress", "")
            hours = wl.get("timeSpentSeconds", 0) / 3600

            # DEBUG — remove after testing
            if author == "Achal Abhishek":
                logger.info("DEBUG INCLUDED: %s | %s | %.1fh | issue=%s | future=%s",
                            author, started, hours, issue_key, is_future)

            if author not in records:
                records[author] = {col: 0.0 for col in PROJECT_COLUMNS}
                records[author]["_email"] = author_email
                records[author]["_worklogs"] = []

            # Map project key to column
            if project_key in PROJECT_COLUMNS:
                col = project_key
            elif project_key in CUSTOMER_PROJECTS:
                col = project_key
            else:
                col = "Customer Projs"  # fallback for unmapped projects

            # Only count hours in utilization if worklog falls within the selected period
            if in_period:
                records[author][col] = records[author].get(col, 0.0) + hours

            records[author]["_worklogs"].append({
                "project": col,
                "issue": issue_key,
                "date": started,
                "hours": round(hours, 2),
                "is_future": is_future,
            })
            if is_future:
                logger.warning("FUTURE DATE worklog: %s logged %.1fh on %s (issue=%s)",
                               author, hours, started, issue_key)
            else:
                logger.debug("Worklog: %s → %s (%s) = %.2f hours", author, issue_key, col, hours)

    logger.info("Processed %d worklogs for %d unique employees", worklog_count, len(records))

    rows = []
    for person, hours_map in records.items():
        email = hours_map.pop("_email", "")  # Extract email BEFORE summing
        worklogs = hours_map.pop("_worklogs", [])
        total = sum(hours_map.values())
        gen_hours = hours_map.get("GEN", 0.0)
        proj_hours = total - gen_hours
        rows.append({
            "name": person,
            "email": email,
            "worklogs": sorted(worklogs, key=lambda item: (item.get("date", ""), item.get("issue", "")), reverse=True),
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
    import pandas as pd
    df: Any = pd.read_excel(io.BytesIO(file_bytes), sheet_name=0)

    # Detect the name column (first column)
    name_col = str(df.columns[0])
    df.columns = ["name" if str(c) == name_col else str(c) for c in df.columns]

    # Drop summary / NaN rows
    df = df.dropna(subset=["name"])
    df = df[~df["name"].astype(str).str.startswith("NaN")]

    # Normalise column names
    col_map: dict[str, str] = {}
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
    df.columns = [col_map.get(c, c) for c in df.columns]

    # Fill NaN with 0
    df = df.fillna(0)

    rows = []
    for _, row in df.iterrows():
        name = str(row.get("name", "")).strip()
        if not name or name.lower() == "nan":
            continue
        rec: dict[str, Any] = {"name": name, "worklogs": []}
        for col in PROJECT_COLUMNS:
            rec[col] = float(row.get(col, 0))
        rec["total"] = float(row.get("total", 0))
        rec["expected"] = float(row.get("expected", EXPECTED_HOURS))
        rec["clocked_pct"] = float(row.get("clocked_pct", 0))
        rec["proj_pct"] = float(row.get("proj_pct", 0))
        rec["general_pct"] = float(row.get("general_pct", 0))
        rec["worklogs"] = []
        rows.append(rec)
    return rows


# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Team roster management
# ---------------------------------------------------------------------------

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
        exclude_from_metrics = member.get("exclude_from_metrics", False)

        # Try name match first, then email fallback
        row = worklog_by_name.get(name_key) or worklog_by_email.get(email_key)

        if row:
            row["in_roster"] = True
            row["email"] = member.get("email", "")
            row["exclude_from_metrics"] = exclude_from_metrics
            matched_keys.add(row["name"].lower().strip())
            merged.append(row)
        else:
            merged.append({
                "name": name,
                "email": member.get("email", ""),
                "in_roster": True,
                "exclude_from_metrics": exclude_from_metrics,
                "worklogs": [],
                "total": 0,
                "expected": expected,
                "clocked_pct": 0,
                "proj_pct": 0,
                "general_pct": 0,
                **{col: 0 for col in PROJECT_COLUMNS},
            })

    # Skip JIRA users not in roster (they're from other teams)
    for r in worklogs:
        if r["name"].lower().strip() not in matched_keys:
            logger.info("  SKIPPING (not in roster): %s", r["name"])

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
# GitHub Copilot metrics (ported from the standalone copilot-dashboard)
# ---------------------------------------------------------------------------
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
COPILOT_SCOPE = os.getenv("SCOPE", "enterprise").lower()
GITHUB_ENT = os.getenv("GITHUB_ENT", "")
GITHUB_ORG = os.getenv("GITHUB_ORG", "")
GITHUB_API_BASE = os.getenv("GITHUB_API_BASE_URL", "https://api.github.com").rstrip("/")
COPILOT_CACHE_TTL = int(os.getenv("CACHE_TTL", "3600"))

_copilot_cache: dict[str, tuple[float, Any]] = {}


class CopilotError(Exception):
    """Raised for GitHub API / configuration errors; carries an HTTP status."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _copilot_cache_get(key: str):
    hit = _copilot_cache.get(key)
    if hit and (time.time() - hit[0]) < COPILOT_CACHE_TTL:
        return hit[1]
    return None


def _copilot_cache_set(key: str, value: Any):
    _copilot_cache[key] = (time.time(), value)


def _copilot_scope_path() -> str:
    if COPILOT_SCOPE == "enterprise":
        if not GITHUB_ENT:
            raise CopilotError(500, "GITHUB_ENT is not set")
        return f"/enterprises/{GITHUB_ENT}"
    if not GITHUB_ORG:
        raise CopilotError(500, "GITHUB_ORG is not set")
    return f"/orgs/{GITHUB_ORG}"


def _gh_get(path: str, params: dict | None = None, allow_404: bool = False):
    if not GITHUB_TOKEN:
        raise CopilotError(500, "GITHUB_TOKEN is not set. Add it to your .env file.")
    headers = {
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    r = requests.get(f"{GITHUB_API_BASE}{path}", headers=headers, params=params, timeout=30)
    if r.status_code == 401:
        raise CopilotError(401, "GitHub rejected the token (401). Check the PAT.")
    if r.status_code == 403:
        raise CopilotError(403, "Forbidden (403). Token likely lacks metrics scope or SSO authorization.")
    if r.status_code == 404 and allow_404:
        return None
    if r.status_code >= 400:
        raise CopilotError(r.status_code, f"GitHub API error: {r.text[:300]}")
    return r.json()


def _fetch_report_days(download_links: list[str]) -> list[dict]:
    """Report metrics are delivered as signed URLs to JSON blobs; fetch them
    (no auth header — they are pre-signed) and concatenate their day_totals.

    The signed CDN endpoints occasionally drop the connection, so each link is
    retried a few times. If any link ultimately fails we raise, because a
    partially-fetched report would silently under-report — better to surface the
    error than cache incomplete data.
    """
    day_totals: list[dict] = []
    for link in download_links:
        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                resp = requests.get(link, timeout=60)
                resp.raise_for_status()
                day_totals.extend(resp.json().get("day_totals", []))
                last_exc = None
                break
            except requests.RequestException as exc:
                last_exc = exc
                logger.warning("Copilot report fetch attempt %d failed: %s", attempt + 1, exc)
                time.sleep(0.5 * (attempt + 1))
        if last_exc is not None:
            raise CopilotError(502, f"Failed to fetch Copilot report data: {last_exc}")
    return day_totals


def _copilot_summarize(raw: list[dict]) -> dict:
    """Legacy inline /copilot/metrics schema."""
    days = []
    for d in raw:
        ide = d.get("copilot_ide_code_completions") or {}
        chat = d.get("copilot_ide_chat") or {}
        suggested = accepted = 0
        lang_totals: dict[str, dict] = {}
        for editor in ide.get("editors", []):
            for model in editor.get("models", []):
                for lang in model.get("languages", []):
                    s = lang.get("total_code_suggestions", 0)
                    a = lang.get("total_code_acceptances", 0)
                    suggested += s
                    accepted += a
                    lt = lang_totals.setdefault(
                        lang.get("name", "unknown"), {"suggested": 0, "accepted": 0}
                    )
                    lt["suggested"] += s
                    lt["accepted"] += a
        days.append({
            "date": d.get("date"),
            "active_users": d.get("total_active_users", 0),
            "engaged_users": d.get("total_engaged_users", 0),
            "suggested": suggested,
            "accepted": accepted,
            "chat_users": chat.get("total_engaged_users", 0),
        })
        days[-1]["_langs"] = lang_totals

    return _copilot_rollup(days)


def _copilot_summarize_report(day_records: list[dict], since: str | None = None,
                              until: str | None = None) -> dict:
    """Newer report-based schema (enterprise-28-day / org-28-day)."""
    by_day: dict[str, dict] = {}
    for rec in day_records:
        day = rec.get("day")
        if not day:
            continue
        if since and day < since:
            continue
        if until and day > until:
            continue
        agg = by_day.setdefault(
            day,
            {"date": day, "active_users": 0, "engaged_users": 0,
             "suggested": 0, "accepted": 0, "chat_users": 0, "_langs": {}},
        )
        agg["active_users"] = max(agg["active_users"], rec.get("daily_active_users", 0))
        agg["engaged_users"] = max(agg["engaged_users"], rec.get("weekly_active_users", 0))
        agg["chat_users"] = max(agg["chat_users"], rec.get("monthly_active_chat_users", 0))
        agg["suggested"] += rec.get("code_generation_activity_count", 0)
        agg["accepted"] += rec.get("code_acceptance_activity_count", 0)
        for lf in rec.get("totals_by_language_feature", []):
            lt = agg["_langs"].setdefault(
                lf.get("language", "unknown"), {"suggested": 0, "accepted": 0}
            )
            lt["suggested"] += lf.get("code_generation_activity_count", 0)
            lt["accepted"] += lf.get("code_acceptance_activity_count", 0)

    days = sorted(by_day.values(), key=lambda d: d["date"])
    return _copilot_rollup(days)


def _copilot_rollup(days: list[dict]) -> dict:
    """Roll per-day language totals into top languages + summary KPIs."""
    lang_roll: dict[str, dict] = {}
    for d in days:
        for name, v in d.pop("_langs", {}).items():
            r = lang_roll.setdefault(name, {"suggested": 0, "accepted": 0})
            r["suggested"] += v["suggested"]
            r["accepted"] += v["accepted"]
    top_langs = sorted(
        (
            {
                "name": n,
                "accepted": v["accepted"],
                "rate": round(100 * v["accepted"] / v["suggested"], 1) if v["suggested"] else 0,
            }
            for n, v in lang_roll.items()
        ),
        key=lambda x: x["accepted"],
        reverse=True,
    )[:5]

    total_suggested = sum(d["suggested"] for d in days)
    total_accepted = sum(d["accepted"] for d in days)
    peak_active = max((d["active_users"] for d in days), default=0)

    return {
        "scope": COPILOT_SCOPE,
        "target": GITHUB_ENT if COPILOT_SCOPE == "enterprise" else GITHUB_ORG,
        "summary": {
            "peak_active_users": peak_active,
            "avg_active_users": round(sum(d["active_users"] for d in days) / len(days)) if days else 0,
            "total_suggested": total_suggested,
            "total_accepted": total_accepted,
            "acceptance_rate": round(100 * total_accepted / total_suggested, 1) if total_suggested else 0,
        },
        "days": days,
        "top_languages": top_langs,
    }


def _iso_ts(ts: str) -> float:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


# ---------------------------------------------------------------------------
# ArgoCD deployment metrics (replicates the DevLake Grafana "ArgoCD" dashboard,
# uid Argocd001). Two data sources, preferred in this order:
#   1. DevLake MySQL (full deployment archive) — when DEVLAKE_DB_* is set
#   2. ArgoCD REST API (direct)                — when ARGOCD_API_URL/TOKEN is set
# Note: ArgoCD's API only retains ~10 revisions per app and successful syncs,
# so trends/failure rates are shallower there than in DevLake.
# ---------------------------------------------------------------------------
ARGOCD_API_URL = os.getenv("ARGOCD_API_URL", "").rstrip("/")
ARGOCD_TOKEN = os.getenv("ARGOCD_TOKEN", "")
ARGOCD_VERIFY_SSL = os.getenv("ARGOCD_VERIFY_SSL", "true").lower() != "false"
# When DNS can't resolve the ArgoCD hostname (hosts-file setups), connect to
# this IP instead while keeping the hostname in the Host header for routing.
ARGOCD_RESOLVE_IP = os.getenv("ARGOCD_RESOLVE_IP", "")
if ARGOCD_API_URL and not ARGOCD_VERIFY_SSL:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

DEVLAKE_DB_HOST = os.getenv("DEVLAKE_DB_HOST", "")
DEVLAKE_DB_PORT = int(os.getenv("DEVLAKE_DB_PORT", "3306"))
DEVLAKE_DB_NAME = os.getenv("DEVLAKE_DB_NAME", "lake")
DEVLAKE_DB_USER = os.getenv("DEVLAKE_DB_USER", "")
DEVLAKE_DB_PASSWORD = os.getenv("DEVLAKE_DB_PASSWORD", "")
ARGOCD_CACHE_TTL = int(os.getenv("ARGOCD_CACHE_TTL", "300"))

_argocd_cache: dict[str, tuple[float, Any]] = {}


class ArgocdError(Exception):
    """Raised for DevLake DB / configuration errors; carries an HTTP status."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def _argocd_cache_get(key: str):
    hit = _argocd_cache.get(key)
    if hit and (time.time() - hit[0]) < ARGOCD_CACHE_TTL:
        return hit[1]
    return None


def _devlake_connect():
    if not DEVLAKE_DB_HOST or not DEVLAKE_DB_USER:
        raise ArgocdError(
            500,
            "DevLake DB is not configured. Set DEVLAKE_DB_HOST, DEVLAKE_DB_USER "
            "and DEVLAKE_DB_PASSWORD in your .env file.",
        )
    import pymysql
    try:
        return pymysql.connect(
            host=DEVLAKE_DB_HOST,
            port=DEVLAKE_DB_PORT,
            user=DEVLAKE_DB_USER,
            password=DEVLAKE_DB_PASSWORD,
            database=DEVLAKE_DB_NAME,
            cursorclass=pymysql.cursors.DictCursor,
            connect_timeout=10,
            read_timeout=60,
        )
    except Exception as exc:
        raise ArgocdError(502, f"Cannot connect to DevLake MySQL: {exc}")


def _argocd_json_safe(rows) -> list[dict]:
    """Convert datetime/Decimal values from MySQL into JSON-friendly types."""
    from decimal import Decimal
    out = []
    for row in rows:
        clean = {}
        for k, v in row.items():
            if isinstance(v, datetime):
                clean[k] = v.strftime("%Y-%m-%d %H:%M:%S")
            elif hasattr(v, "isoformat"):  # date
                clean[k] = v.isoformat()
            elif isinstance(v, Decimal):
                clean[k] = float(v)
            else:
                clean[k] = v
        out.append(clean)
    return out


def _argocd_source() -> str:
    """Pick the data source: DevLake MySQL if configured, else the ArgoCD API."""
    if DEVLAKE_DB_HOST and DEVLAKE_DB_USER:
        return "devlake"
    if ARGOCD_API_URL and ARGOCD_TOKEN:
        return "argocd-api"
    raise ArgocdError(
        500,
        "No ArgoCD data source configured. Set ARGOCD_API_URL + ARGOCD_TOKEN "
        "(direct ArgoCD API) or DEVLAKE_DB_* (DevLake MySQL) in .env.",
    )


def _argocd_api_get(path: str, params: dict | None = None):
    headers = {"Authorization": f"Bearer {ARGOCD_TOKEN}"}
    url = f"{ARGOCD_API_URL}{path}"
    if ARGOCD_RESOLVE_IP:
        from urllib.parse import urlparse
        host = urlparse(ARGOCD_API_URL).hostname or ""
        url = url.replace(host, ARGOCD_RESOLVE_IP, 1)
        headers["Host"] = host
    try:
        r = requests.get(url, headers=headers, params=params,
                         timeout=30, verify=ARGOCD_VERIFY_SSL)
    except requests.RequestException as exc:
        raise ArgocdError(502, f"Cannot reach ArgoCD API: {exc}")
    if r.status_code == 401:
        raise ArgocdError(401, "ArgoCD rejected the token (401). Check ARGOCD_TOKEN.")
    if r.status_code == 403:
        raise ArgocdError(403, "ArgoCD returned 403 Forbidden. The token's account "
                               "may lack 'applications, get' RBAC permission.")
    if r.status_code >= 400:
        raise ArgocdError(r.status_code, f"ArgoCD API error: {r.text[:300]}")
    return r.json()


def _argocd_ts(ts: str | None) -> str:
    """ArgoCD ISO timestamp → 'YYYY-MM-DD HH:MM:SS' (sortable, JSON-friendly)."""
    if not ts:
        return ""
    return ts.replace("T", " ").replace("Z", "")[:19]


def _argocd_api_snapshot() -> dict:
    """One pass over /v1/applications → flat deployment rows + app metadata.

    ArgoCD's history array holds completed (successful) syncs, capped by each
    app's revisionHistoryLimit (~10). The latest failed operation is only
    visible via operationState, so failures beyond the most recent one are
    not recoverable from the live API.
    """
    data = _argocd_api_get("/v1/applications")
    deployments, apps, app_images = [], [], []

    for item in data.get("items", []):
        meta = item.get("metadata", {})
        name = meta.get("name", "?")
        status = item.get("status", {})
        env = (item.get("spec", {}).get("destination", {}) or {}).get("namespace", "") or "unknown"
        apps.append({"id": name, "name": name})

        history = status.get("history") or []
        for h in history:
            deployed = _argocd_ts(h.get("deployedAt"))
            started = _argocd_ts(h.get("deployStartedAt"))
            duration = None
            if deployed and started:
                try:
                    duration = (datetime.fromisoformat(deployed)
                                - datetime.fromisoformat(started)).total_seconds()
                    duration = max(duration, 0)
                except ValueError:
                    pass
            deployments.append({
                "app": name,
                "environment": env,
                "created_date": started or deployed,
                "finished_date": deployed,
                "duration_sec": duration,
                "result": "SUCCESS",
                "status": "DONE",
                "revision": (h.get("revision") or "")[:12],
                "description": f"{name} sync #{h.get('id', '')}".strip(" #"),
            })

        # The most recent operation can be a failure that history doesn't keep
        op = status.get("operationState") or {}
        phase = op.get("phase", "")
        if phase in ("Failed", "Error"):
            started = _argocd_ts(op.get("startedAt"))
            finished = _argocd_ts(op.get("finishedAt"))
            duration = None
            if started and finished:
                try:
                    duration = max((datetime.fromisoformat(finished)
                                    - datetime.fromisoformat(started)).total_seconds(), 0)
                except ValueError:
                    pass
            deployments.append({
                "app": name,
                "environment": env,
                "created_date": started or finished,
                "finished_date": finished,
                "duration_sec": duration,
                "result": "FAILURE",
                "status": phase.upper(),
                "revision": ((op.get("operation", {}).get("sync", {}) or {}).get("revision") or "")[:12],
                "description": (op.get("message") or f"{name} failed sync")[:200],
            })

        images = (status.get("summary", {}) or {}).get("images") or []
        if images:
            latest = history[-1] if history else {}
            app_images.append({
                "deployment_created": _argocd_ts(latest.get("deployedAt")),
                "deployment_name": name,
                "images": ", ".join(images),
                "revision": (latest.get("revision") or "")[:12],
                "environment": env,
                "result": "SUCCESS" if latest else "",
            })

    return {"deployments": deployments, "apps": apps, "app_images": app_images}


def _argocd_fetch_metrics_api(since: str, until_excl: str, apps: list[str]) -> dict:
    """Aggregate the API snapshot into the same payload shape as the SQL path."""
    snap = _argocd_api_snapshot()
    rows = [
        d for d in snap["deployments"]
        if d["created_date"]
        and since <= d["created_date"] < until_excl
        and (not apps or d["app"] in apps)
    ]
    rows.sort(key=lambda d: d["created_date"])

    total = len(rows)
    successful = sum(1 for d in rows if d["result"] == "SUCCESS")
    durations = [d["duration_sec"] for d in rows if d["duration_sec"] is not None]
    summary = {
        "total": total,
        "successful": successful,
        "success_rate": round(successful / total, 4) if total else 0,
        "mean_duration_min": round(sum(durations) / len(durations) / 60, 2)
        if durations else None,
    }

    result_counts: dict[str, int] = {}
    by_env: dict[str, int] = {}
    monthly: dict[str, dict] = {}
    daily: dict[str, list] = {}
    for d in rows:
        result_counts[d["result"]] = result_counts.get(d["result"], 0) + 1
        by_env[d["environment"]] = by_env.get(d["environment"], 0) + 1
        month = d["created_date"][:7] + "-01"
        m = monthly.setdefault(month, {"month": month, "deployments": 0,
                                       "successes": 0, "durs": []})
        m["deployments"] += 1
        m["successes"] += d["result"] == "SUCCESS"
        if d["duration_sec"] is not None:
            m["durs"].append(d["duration_sec"])
        if d["duration_sec"] is not None:
            daily.setdefault(d["created_date"][:10], []).append(d["duration_sec"])

    monthly_rows = []
    for month in sorted(monthly):
        m = monthly[month]
        monthly_rows.append({
            "month": month,
            "deployments": m["deployments"],
            "success_rate": round(m["successes"] / m["deployments"], 4),
            "mean_duration_min": round(sum(m["durs"]) / len(m["durs"]) / 60, 2)
            if m["durs"] else None,
        })

    # 7-day rolling average over daily means (row-based, like the SQL window)
    day_means = [(day, sum(v) / len(v) / 60) for day, v in sorted(daily.items())]
    rolling = []
    for i, (day, _) in enumerate(day_means):
        window = [v for _, v in day_means[max(0, i - 6):i + 1]]
        rolling.append({"day": day, "rolling_avg_minutes": round(sum(window) / len(window), 2)})

    def table_row(d):
        return {
            "created_date": d["created_date"],
            "deployment_name": d["app"],
            "environment": d["environment"],
            "result": d["result"],
            "status": d["status"],
            "description": d["description"],
            "finished_date": d["finished_date"],
            "duration_minutes": round(d["duration_sec"] / 60, 2)
            if d["duration_sec"] is not None else None,
        }

    longest = sorted((d for d in rows if d["duration_sec"] is not None),
                     key=lambda d: d["duration_sec"], reverse=True)[:20]
    recent = sorted(rows, key=lambda d: d["created_date"], reverse=True)[:50]

    app_filter = set(apps) if apps else None
    recent_images = [r for r in snap["app_images"]
                     if not app_filter or r["deployment_name"] in app_filter][:50]
    image_counts: dict[str, int] = {}
    for r in rows:
        img = next((a["images"] for a in snap["app_images"]
                    if a["deployment_name"] == r["app"]), None)
        if img:
            image_counts[img] = image_counts.get(img, 0) + 1
    top_image_arrays = [{"image_array": k, "deployment_count": v}
                        for k, v in sorted(image_counts.items(),
                                           key=lambda kv: kv[1], reverse=True)[:20]]

    return {
        "since": since,
        "until": until_excl,
        "summary": summary,
        "result_distribution": [{"result": k, "deployment_count": v}
                                for k, v in sorted(result_counts.items(),
                                                   key=lambda kv: kv[1], reverse=True)],
        "monthly": monthly_rows,
        "by_environment": [{"environment": k, "deployment_count": v}
                           for k, v in sorted(by_env.items(),
                                              key=lambda kv: kv[1], reverse=True)],
        "longest": [table_row(d) for d in longest],
        "rolling_duration": rolling,
        "recent": [table_row(d) for d in recent],
        "recent_images": recent_images,
        "top_image_arrays": top_image_arrays,
    }


def _argocd_fetch_metrics(since: str, until: str, apps: list[str]) -> dict:
    """Run the dashboard's panel queries against DevLake and bundle the results.

    `apps` is a list of cicd_scope_id values (empty = all applications), matching
    the Grafana dashboard's Application template variable.
    """
    scope_sql, scope_args = "", []
    if apps:
        placeholders = ",".join(["%s"] * len(apps))
        scope_sql = f" AND cicd_scope_id IN ({placeholders})"
        scope_args = apps

    # $__timeFilter(created_date) equivalent (until is exclusive next-day bound)
    time_args = [since, until]
    base_where = f"created_date >= %s AND created_date < %s{scope_sql}"
    args = time_args + scope_args

    conn = _devlake_connect()
    try:
        with conn.cursor() as cur:
            # Panels 1.1–1.3 + 3.1: headline stats
            cur.execute(
                f"""
                SELECT
                  count(DISTINCT id) AS total,
                  count(DISTINCT CASE WHEN result = 'SUCCESS' THEN id END) AS successful,
                  avg(CASE WHEN duration_sec IS NOT NULL THEN duration_sec / 60 END) AS mean_duration_min
                FROM cicd_deployments
                WHERE {base_where}
                """,
                args,
            )
            s = cur.fetchone() or {}
            total = s.get("total") or 0
            successful = s.get("successful") or 0
            summary = {
                "total": total,
                "successful": successful,
                "success_rate": round(successful / total, 4) if total else 0,
                "mean_duration_min": round(float(s["mean_duration_min"]), 2)
                if s.get("mean_duration_min") is not None else None,
            }

            # Panel 1.4: result distribution
            cur.execute(
                f"""
                SELECT result, count(DISTINCT id) AS deployment_count
                FROM cicd_deployments
                WHERE {base_where}
                GROUP BY 1 ORDER BY 2 DESC
                """,
                args,
            )
            result_distribution = _argocd_json_safe(cur.fetchall())

            # Panels 2.1, 2.2, 3.2: monthly deployments / success rate / duration
            cur.execute(
                f"""
                SELECT
                  DATE_FORMAT(created_date, '%%Y-%%m-01') AS month,
                  count(DISTINCT id) AS deployments,
                  1.0 * count(DISTINCT CASE WHEN result = 'SUCCESS' THEN id END)
                      / count(DISTINCT id) AS success_rate,
                  avg(CASE WHEN duration_sec IS NOT NULL THEN duration_sec / 60 END)
                      AS mean_duration_min
                FROM cicd_deployments
                WHERE {base_where}
                GROUP BY 1 ORDER BY 1
                """,
                args,
            )
            monthly = _argocd_json_safe(cur.fetchall())

            # Panel 2.3: deployments by environment
            cur.execute(
                f"""
                SELECT environment, count(DISTINCT id) AS deployment_count
                FROM cicd_deployments
                WHERE {base_where}
                GROUP BY 1 ORDER BY 2 DESC
                """,
                args,
            )
            by_environment = _argocd_json_safe(cur.fetchall())

            # Panel 3.3: top 20 longest deployments
            cur.execute(
                f"""
                SELECT
                  name AS deployment_name,
                  display_title AS description,
                  environment, result,
                  round(duration_sec / 60, 2) AS duration_minutes,
                  finished_date
                FROM cicd_deployments
                WHERE {base_where} AND duration_sec IS NOT NULL
                ORDER BY duration_sec DESC
                LIMIT 20
                """,
                args,
            )
            longest = _argocd_json_safe(cur.fetchall())

            # Panel 3.4: 7-day rolling average of deployment duration
            cur.execute(
                f"""
                WITH daily AS (
                  SELECT
                    DATE(created_date) AS day_bucket,
                    avg(duration_sec / 60) AS avg_duration_minutes
                  FROM cicd_deployments
                  WHERE {base_where} AND duration_sec IS NOT NULL
                  GROUP BY 1
                )
                SELECT
                  day_bucket AS day,
                  avg(avg_duration_minutes) OVER (
                    ORDER BY day_bucket ROWS BETWEEN 6 PRECEDING AND CURRENT ROW
                  ) AS rolling_avg_minutes
                FROM daily
                ORDER BY day_bucket
                """,
                args,
            )
            rolling_duration = _argocd_json_safe(cur.fetchall())

            # Panel 4.1: recent deployments
            cur.execute(
                f"""
                SELECT
                  created_date,
                  name AS deployment_name,
                  environment, result, status,
                  display_title AS description,
                  finished_date
                FROM cicd_deployments
                WHERE {base_where}
                ORDER BY created_date DESC
                LIMIT 50
                """,
                args,
            )
            recent = _argocd_json_safe(cur.fetchall())

            # Panels 5.1 / 5.2 need the ArgoCD plugin's revision-images table,
            # which may not exist on older DevLake versions — degrade gracefully.
            recent_images, top_image_arrays = [], []
            joined_where = base_where.replace("created_date", "d.created_date") \
                                     .replace("cicd_scope_id", "d.cicd_scope_id")
            try:
                cur.execute(
                    f"""
                    SELECT
                      d.created_date AS deployment_created,
                      d.name AS deployment_name,
                      ri.images AS images,
                      c.commit_sha AS revision,
                      d.environment, d.result
                    FROM cicd_deployments d
                    LEFT JOIN cicd_deployment_commits c ON c.cicd_deployment_id = d.id
                    LEFT JOIN _tool_argocd_revision_images ri ON ri.revision = c.commit_sha
                    WHERE {joined_where}
                    ORDER BY d.created_date DESC
                    LIMIT 50
                    """,
                    args,
                )
                recent_images = _argocd_json_safe(cur.fetchall())

                cur.execute(
                    f"""
                    WITH dep AS (
                      SELECT d.id, c.commit_sha
                      FROM cicd_deployments d
                      LEFT JOIN cicd_deployment_commits c ON c.cicd_deployment_id = d.id
                      WHERE {joined_where}
                    )
                    SELECT ri.images AS image_array,
                           count(DISTINCT dep.id) AS deployment_count
                    FROM dep
                    JOIN _tool_argocd_revision_images ri ON ri.revision = dep.commit_sha
                    GROUP BY 1 ORDER BY 2 DESC
                    LIMIT 20
                    """,
                    args,
                )
                top_image_arrays = _argocd_json_safe(cur.fetchall())
            except Exception as exc:
                logger.warning("ArgoCD image panels unavailable: %s", exc)

    finally:
        conn.close()

    return {
        "since": since,
        "until": until,
        "summary": summary,
        "result_distribution": result_distribution,
        "monthly": monthly,
        "by_environment": by_environment,
        "longest": longest,
        "rolling_duration": rolling_duration,
        "recent": recent,
        "recent_images": recent_images,
        "top_image_arrays": top_image_arrays,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("dashboard.html")


@app.route("/copilot")
def copilot_page():
    return render_template("copilot.html")


@app.route("/argocd")
def argocd_page():
    return render_template("argocd.html")


@app.route("/api/argocd/applications")
def argocd_applications():
    """ArgoCD applications for the filter dropdown (Grafana's Application variable)."""
    try:
        cached = _argocd_cache_get("apps")
        if cached:
            return jsonify(cached)
        if _argocd_source() == "devlake":
            conn = _devlake_connect()
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT id, name FROM cicd_scopes "
                        "WHERE id LIKE 'argocd:ArgocdApplication:%' ORDER BY name"
                    )
                    result = {"applications": _argocd_json_safe(cur.fetchall())}
            finally:
                conn.close()
        else:
            apps = _argocd_api_snapshot()["apps"]
            result = {"applications": sorted(apps, key=lambda a: a["name"])}
        _argocd_cache["apps"] = (time.time(), result)
        return jsonify(result)
    except ArgocdError as exc:
        return jsonify({"detail": exc.message}), exc.status


@app.route("/api/argocd/metrics")
def argocd_metrics():
    """All panel data for the ArgoCD dashboard in one payload."""
    until = request.args.get("until") or datetime.now().strftime("%Y-%m-%d")
    since = request.args.get("since") or (
        datetime.now() - timedelta(days=182)).strftime("%Y-%m-%d")
    apps = [a for a in (request.args.get("apps") or "").split(",") if a]

    try:
        datetime.strptime(since, "%Y-%m-%d")
        until_excl = (datetime.strptime(until, "%Y-%m-%d")
                      + timedelta(days=1)).strftime("%Y-%m-%d")
    except ValueError:
        return jsonify({"detail": "Invalid date format. Use YYYY-MM-DD"}), 400

    key = f"argocd:{since}:{until}:{','.join(sorted(apps))}"
    try:
        cached = _argocd_cache_get(key)
        if cached:
            return jsonify(cached)
        source = _argocd_source()
        if source == "devlake":
            result = _argocd_fetch_metrics(since, until_excl, apps)
        else:
            result = _argocd_fetch_metrics_api(since, until_excl, apps)
        result["until"] = until
        result["source"] = source
        _argocd_cache[key] = (time.time(), result)
        return jsonify(result)
    except ArgocdError as exc:
        return jsonify({"detail": exc.message}), exc.status


@app.route("/api/copilot/metrics")
def copilot_metrics():
    since = request.args.get("since")
    until = request.args.get("until")
    key = f"metrics:{COPILOT_SCOPE}:{since}:{until}"
    try:
        cached = _copilot_cache_get(key)
        if cached:
            return jsonify(cached)
        # Newer enterprises/orgs deliver metrics as a downloadable report (the
        # inline /copilot/metrics endpoint 404s for them). Try that first.
        report_kind = "enterprise-28-day" if COPILOT_SCOPE == "enterprise" else "org-28-day"
        report = _gh_get(
            f"{_copilot_scope_path()}/copilot/metrics/reports/{report_kind}/latest",
            allow_404=True,
        )
        if report and report.get("download_links"):
            day_records = _fetch_report_days(report["download_links"])
            result = _copilot_summarize_report(day_records, since, until)
        else:
            params = {}
            if since:
                params["since"] = since
            if until:
                params["until"] = until
            raw = _gh_get(f"{_copilot_scope_path()}/copilot/metrics", params or None)
            result = _copilot_summarize(raw if isinstance(raw, list) else [])
        # Only cache results that actually contain data. An empty payload here
        # means a transient upstream hiccup (dropped report blob, GitHub still
        # generating the report); caching it would freeze the dashboard on
        # "no data" for a full TTL. Leaving it uncached lets the next load retry.
        if result.get("days"):
            _copilot_cache_set(key, result)
        return jsonify(result)
    except CopilotError as exc:
        return jsonify({"detail": exc.message}), exc.status


@app.route("/api/copilot/seats")
def copilot_seats():
    key = f"seats:{COPILOT_SCOPE}"
    try:
        cached = _copilot_cache_get(key)
        if cached:
            return jsonify(cached)
        data = _gh_get(f"{_copilot_scope_path()}/copilot/billing/seats", {"per_page": 100})
        seats = data.get("seats", [])
        now = time.time()
        never = sum(1 for s in seats if not s.get("last_activity_at"))
        inactive7 = sum(
            1 for s in seats
            if s.get("last_activity_at") and (now - _iso_ts(s["last_activity_at"])) > 7 * 86400
        )
        result = {
            "total_assigned": data.get("total_seats", len(seats)),
            "never_used": never,
            "inactive_7d": inactive7,
        }
        _copilot_cache_set(key, result)
        return jsonify(result)
    except CopilotError as exc:
        return jsonify({"detail": exc.message}), exc.status


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
        if "error" not in result:
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

@app.route("/api/data/custom", methods=["GET"])
def api_data_custom():
    """Fetch data for custom date range."""
    start_str = request.args.get("start")
    end_str = request.args.get("end")
    
    if not start_str or not end_str:
        return jsonify({"error": "Missing start or end date"}), 400
    
    try:
        start_date = datetime.strptime(start_str, "%Y-%m-%d")
        end_date = datetime.strptime(end_str, "%Y-%m-%d")
    except ValueError:
        return jsonify({"error": "Invalid date format. Use YYYY-MM-DD"}), 400
    
    if start_date > end_date:
        return jsonify({"error": "Start date must be before end date"}), 400
    
    # Calculate expected hours based on date range
    days_diff = (end_date - start_date).days + 1
    weeks = days_diff / 7
    period_expected = int(weeks * 40)  # 40 hours per week
    
    cache_key = f"{start_str}_{end_str}"
    if cache_key in CACHE and (time.time() - CACHE[cache_key]["ts"]) < CACHE_TTL:
        logger.info("Cache HIT for custom range %s", cache_key)
        result = CACHE[cache_key]["data"]
    else:
        logger.info("Cache MISS — fetching custom range from JIRA...")
        result = fetch_jira_worklogs(start_str, end_str)
        if "error" not in result:
            CACHE[cache_key] = {"data": result, "ts": time.time()}
    
    # Merge with roster
    if "data" in result:
        result["data"] = merge_roster_with_worklogs(result.get("data", []), period_expected)
    else:
        result["data"] = merge_roster_with_worklogs([], period_expected)
    
    # Recalculate percentages
    for row in result["data"]:
        row["expected"] = period_expected
        total = row.get("total", 0)
        row["clocked_pct"] = round(total / period_expected, 4) if period_expected else 0
    
    result["period"] = "custom_range"
    result["expected_hours"] = period_expected
    result["team_size"] = len(result["data"])
    result["roster_size"] = 111
    result["start"] = start_str
    result["end"] = end_str
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


@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "timestamp": datetime.utcnow().isoformat()})


@app.route("/api/debug/config")
def debug_config():
    """Debug endpoint to check if JIRA credentials are loaded."""
    jira_email, jira_token = _jira_credentials()
    return jsonify({
        "jira_base_url": JIRA_BASE_URL[:30] + "..." if JIRA_BASE_URL else None,
        "jira_email_set": bool(jira_email),
        "jira_token_set": bool(jira_token),
        "expected_hours": EXPECTED_HOURS,
    })


@app.route("/api/debug/test-jira")
def debug_test_jira():
    """Test JIRA connectivity with a simple API call."""
    jira_email, jira_token = _jira_credentials()
    if not jira_email or not jira_token:
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
# Cache preloading
# ---------------------------------------------------------------------------

def preload_cache():
    """Background task to warm cache for current week on startup."""
    try:
        time.sleep(2)  # Wait for app to fully start
        today = datetime.now()
        start = today - timedelta(days=today.weekday())
        end = today
        start_str = start.strftime("%Y-%m-%d")
        end_str = end.strftime("%Y-%m-%d")
        
        logger.info("🔥 Preloading cache for current week (%s to %s)...", start_str, end_str)
        result = fetch_jira_worklogs(start_str, end_str)
        cache_key = f"{start_str}_{end_str}"
        CACHE[cache_key] = {"data": result, "ts": time.time()}
        logger.info("✅ Cache preload complete! %d records cached.", len(result.get("data", [])))
    except Exception as exc:
        logger.error("❌ Cache preload failed: %s", exc)

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    jira_email, jira_token = _jira_credentials()
    # Start cache preload in background thread
    if jira_email and jira_token:
        Thread(target=preload_cache, daemon=True).start()
    else:
        logger.warning("⚠️  JIRA credentials not set - skipping cache preload")
    
    port = int(os.getenv("PORT", "5000"))
    debug = os.getenv("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
