/**
 * Engineering Resource Utilization Dashboard
 * Client-side: Charts, table, filters, export, file upload
 */

// ── State ──────────────────────────────────────────────────────
let dashboardData = [];
let barChart = null;
let donutChart = null;
let trendChart = null;
let sortCol = "clocked_pct";
let sortAsc = false;
let currentPeriod = "current_week";
let trendType = "utilization";

// ── Init ───────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    setupTabs();
    setupUpload();
    setupSearch();
    setupFilter();
    setupExport();
    setupTableSort();
    setupModal();
    setupComparison();
    setupTrendControls();
    loadPeriod("current_week");
});

// ── Tab navigation ─────────────────────────────────────────────
function setupTabs() {
    document.querySelectorAll(".tab").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
            btn.classList.add("active");
            const period = btn.dataset.period;
            
            // Hide all panels
            document.getElementById("uploadPanel").classList.add("hidden");
            document.getElementById("customRangePanel").classList.add("hidden");
            
            if (period === "upload") {
                document.getElementById("uploadPanel").classList.remove("hidden");
            } else if (period === "custom_range") {
                document.getElementById("customRangePanel").classList.remove("hidden");
                setupCustomRange();
            } else {
                currentPeriod = period;
                loadPeriod(period);
            }
        });
    });
}

function setupCustomRange() {
    const startInput = document.getElementById("startDate");
    const endInput = document.getElementById("endDate");
    const btn = document.getElementById("btnLoadCustomRange");
    
    // Set default dates (last 7 days)
    const today = new Date();
    const lastWeek = new Date(today);
    lastWeek.setDate(today.getDate() - 7);
    
    endInput.valueAsDate = today;
    startInput.valueAsDate = lastWeek;
    
    btn.onclick = async () => {
        const start = startInput.value;
        const end = endInput.value;
        
        if (!start || !end) {
            alert("Please select both start and end dates");
            return;
        }
        
        if (new Date(start) > new Date(end)) {
            alert("Start date must be before end date");
            return;
        }
        
        btn.textContent = "Loading...";
        btn.disabled = true;
        
        try {
            showLoading();
            const res = await fetch(`/api/data/custom?start=${start}&end=${end}`);
            const json = await res.json();
            
            if (json.data && json.data.length) {
                dashboardData = json.data;
                currentPeriod = "custom_range";
                renderAll();
            } else if (json.error) {
                alert("Error: " + json.error);
            } else {
                alert("No data found for the selected date range");
            }
        } catch (e) {
            console.error("Custom range error:", e);
            alert("Error loading data: " + e.message);
        } finally {
            hideLoading();
            btn.textContent = "Load Data";
            btn.disabled = false;
        }
    };
}

// ── Data loading ───────────────────────────────────────────────
async function loadPeriod(period) {
    showLoading();
    try {
        const res = await fetch(`/api/data?period=${period}`);
        const json = await res.json();
        if (json.data && json.data.length) {
            dashboardData = json.data;
            renderAll();
        } else if (json.error) {
            alert("Error: " + json.error + "\n\nUse the Upload Excel tab to load data manually.");
        } else {
            alert("No worklogs found for this period.\n\nTry Previous Month or Upload Excel.");
        }
    } catch (e) {
        console.error("Load error:", e);
        alert("Connection error: " + e.message);
    } finally {
        hideLoading();
    }
}

function renderAll() {
    renderKPIs();
    renderBarChart();
    renderDonutChart();
    renderProjects();
    renderTable();
    renderAlerts();
    renderAnomalies();
    renderProjectHealth();
    renderTrendChart();
    renderDailyBreakdownControls();
    document.getElementById("lastUpdated").textContent = "Updated: " + new Date().toLocaleString("en-IN");
}

// ── KPIs ───────────────────────────────────────────────────────
function renderKPIs() {
    const d = dashboardData;
    const n = d.length;
    
    // Filter out senior management (excluded from metrics)
    const metricsData = d.filter(r => !r.exclude_from_metrics);
    
    // Debug logging
    console.log("Total employees:", n);
    console.log("Employees in metrics:", metricsData.length);
    console.log("Sample employee data:", metricsData[0]);
    
    // Calculate total clocked hours and total expected hours (excluding senior mgmt)
    const totalClockedHours = metricsData.reduce((s, r) => s + (r.total || 0), 0);
    const totalExpectedHours = metricsData.reduce((s, r) => s + (r.expected || 168), 0);
    const totalClockedPct = totalExpectedHours > 0 ? totalClockedHours / totalExpectedHours : 0;
    
    console.log("Total clocked hours:", totalClockedHours);
    console.log("Total expected hours:", totalExpectedHours);
    console.log("Total clocked %:", totalClockedPct);
    
    const healthyRange = metricsData.filter(r => r.clocked_pct >= 0.80 && r.clocked_pct <= 1.20).length;
    const zeroHours = metricsData.filter(r => r.total === 0 || r.total === 0.0).length;
    const overworked = metricsData.filter(r => r.clocked_pct > 1.20).length;
    const underutilized = metricsData.filter(r => r.clocked_pct < 0.80).length;

    document.getElementById("kpiTeamSize").textContent = n;
    document.getElementById("kpiClocked").textContent = pct(totalClockedPct);
    document.getElementById("kpiHealthyRange").textContent = healthyRange;
    document.getElementById("kpiGeneral").textContent = zeroHours;
    document.getElementById("kpiHealthy").textContent = overworked;
    document.getElementById("kpiLow").textContent = underutilized;
    
    // Update sublabel with actual hours and per-person average
    const clockedRounded = Math.round(totalClockedHours);
    const expectedRounded = Math.round(totalExpectedHours);
    const avgExpectedPerPerson = metricsData.length > 0 ? Math.round(totalExpectedHours / metricsData.length) : 0;
    document.getElementById("kpiClockedSublabel").textContent = `(${clockedRounded} / ${expectedRounded} hrs | ${avgExpectedPerPerson} hrs/person)`;
    
    // Show expected hours message for current month
    updateExpectedHoursMessage();
}

function calculateWorkingDays(year, month) {
    // month is 0-indexed (0 = January, 11 = December)
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    let workingDays = 0;
    
    for (let day = new Date(firstDay); day <= lastDay; day.setDate(day.getDate() + 1)) {
        const dayOfWeek = day.getDay();
        // Monday = 1, Friday = 5 (Sunday = 0, Saturday = 6)
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
            workingDays++;
        }
    }
    
    return workingDays;
}

function getWeekDateRange() {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    
    // Calculate Monday of current week
    const monday = new Date(now);
    const daysFromMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    monday.setDate(now.getDate() + daysFromMonday);
    
    // Calculate Friday of current week
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    
    return { monday, friday };
}

function getWeekNumber(date) {
    const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
    const pastDaysOfYear = (date - firstDayOfYear) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

function updateExpectedHoursMessage() {
    const msgDiv = document.getElementById("expectedHoursMsg");
    
    if (currentPeriod === "current_week") {
        const { monday, friday } = getWeekDateRange();
        const weekNum = getWeekNumber(monday);
        
        // Format dates as "Jun 02-06"
        const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const monthName = monthNames[monday.getMonth()];
        const startDay = monday.getDate().toString().padStart(2, '0');
        const endDay = friday.getDate().toString().padStart(2, '0');
        const year = monday.getFullYear();
        
        const expectedHours = 40; // 5 days * 8 hours
        
        msgDiv.textContent = `Expected Clocking for Week ${weekNum} (${monthName} ${startDay}-${endDay}, ${year}) is ${expectedHours} hrs`;
        msgDiv.style.display = "block";
    } else if (currentPeriod === "current_month" || currentPeriod === "previous_month") {
        const now = new Date();
        let year = now.getFullYear();
        let month = now.getMonth(); // 0-indexed
        
        // For previous month, adjust the month/year
        if (currentPeriod === "previous_month") {
            month -= 1;
            if (month < 0) {
                month = 11;
                year -= 1;
            }
        }
        
        const workingDays = calculateWorkingDays(year, month);
        const expectedHours = workingDays * 8;
        
        const monthNames = ["January", "February", "March", "April", "May", "June",
                           "July", "August", "September", "October", "November", "December"];
        const monthYear = `${monthNames[month]} ${year}`;
        
        msgDiv.textContent = `Expected Clocking for month of ${monthYear} is ${expectedHours} hrs`;
        msgDiv.style.display = "block";
    } else {
        msgDiv.style.display = "none";
    }
}


// ── Bar chart (scrollable, professional) ──
function renderBarChart() {
    const container = document.getElementById("barChartContainer");
    if (barChart) { barChart.destroy(); barChart = null; }

    // Filter out senior management
    const metricsData = dashboardData.filter(r => !r.exclude_from_metrics);
    const logged = metricsData.filter(r => r.total > 0).sort((a, b) => b.total - a.total);
    const notLogged = metricsData.filter(r => r.total === 0);

    let html = "";

    // ── Zero Clockers Summary ──
    if (notLogged.length > 0) {
        html += `<details open style="padding:12px 16px; background:#FAFBFC; border:1px solid #DFE1E6; border-radius:8px;">
            <summary style="cursor:pointer; font-size:13px; color:#6B778C; font-weight:600;">
                🔴 ${notLogged.length} team members with 0 hours logged
            </summary>
            <div style="margin-top:8px; font-size:12px; color:#7A869A; columns:3; column-gap:20px;">
                ${notLogged.sort((a,b) => a.name.localeCompare(b.name)).map(r => `<div style="padding:2px 0;">${r.name}</div>`).join("")}
            </div>
        </details>`;
    }

    container.innerHTML = html;
}

// ── Donut chart (distribution buckets) ─────────────────────────
function renderDonutChart() {
    const ctx = document.getElementById("donutChart").getContext("2d");
    // Filter out senior management
    const d = dashboardData.filter(r => !r.exclude_from_metrics);
    const buckets = {
        "≥100%": d.filter(r => r.clocked_pct >= 1.0).length,
        "75–99%": d.filter(r => r.clocked_pct >= 0.75 && r.clocked_pct < 1.0).length,
        "40–74%": d.filter(r => r.clocked_pct >= 0.40 && r.clocked_pct < 0.75).length,
        "<40%": d.filter(r => r.clocked_pct < 0.40).length,
    };

    if (donutChart) donutChart.destroy();
    donutChart = new Chart(ctx, {
        type: "doughnut",
        data: {
            labels: Object.keys(buckets),
            datasets: [{
                data: Object.values(buckets),
                backgroundColor: ["#6554C0", "#0052CC", "#FF991F", "#DE350B"],
                borderWidth: 2,
                borderColor: "#fff",
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: "bottom", labels: { font: { size: 12 }, padding: 16 } },
                tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.raw} members` } },
            },
        },
    });
}

// ── Project-wise breakdown ────────────────────────────────────
function renderProjects() {
    const container = document.getElementById("projectsContainer");
    const projectList = [
        "DMS", "BMS", "IDT", "GEN", "PLT", "ITO", "HU",
        "DAT", "PAS", "PEM", "Customer Projs", "Platform Projs", "HA", "PEMV2", "ED"
    ];
    const projectLabels = {
        ED: "Engineering DevOps (ED)"
    };

    // Build project -> employees map
    const projectMap = {};
    projectList.forEach(proj => { projectMap[proj] = []; });

    // Filter out senior management
    const metricsData = dashboardData.filter(emp => !emp.exclude_from_metrics);
    metricsData.forEach(emp => {
        projectList.forEach(proj => {
            const hours = emp[proj] || 0;
            if (hours > 0) {
                projectMap[proj].push({
                    name: emp.name,
                    hours: hours.toFixed(1)
                });
            }
        });
    });

    // Render cards for projects with employees
    let html = "";
    projectList.forEach(proj => {
        const employees = projectMap[proj].sort((a, b) => parseFloat(b.hours) - parseFloat(a.hours));
        if (employees.length === 0) return; // Skip empty projects
        const projectLabel = projectLabels[proj] || proj;

        html += `<div class="project-item" data-project="${proj}" style="cursor: pointer;">
            <div class="project-name">
                <span>${projectLabel}</span>
                <span class="project-count">${employees.length}</span>
            </div>
            <div class="project-employees">`;
        
        employees.forEach(emp => {
            html += `<div class="project-employee-item">
                <span class="employee-name">${escHtml(emp.name)}</span>
                <span class="employee-hours">${emp.hours}h</span>
            </div>`;
        });

        html += `</div></div>`;
    });

    container.innerHTML = html;
    
    // Attach click handlers to project items
    document.querySelectorAll(".project-item").forEach(item => {
        item.addEventListener("click", () => {
            const project = item.dataset.project;
            showProjectDrilldown(project, projectMap[project]);
        });
    });
}

// ── Project drill-down modal ──────────────────────────────────
function showProjectDrilldown(projectName, employees) {
    const modal = document.getElementById("drilldownModal");
    const title = document.getElementById("drilldownTitle");
    const body = document.getElementById("drilldownBody");
    
    title.textContent = `📊 ${projectName} — Employee Details`;
    
    const totalHours = employees.reduce((sum, emp) => sum + parseFloat(emp.hours), 0);
    const avgHours = (totalHours / employees.length).toFixed(1);
    
    let html = `
        <div class="drilldown-stat">
            <span class="drilldown-stat-label">Total Employees</span>
            <span class="drilldown-stat-value">${employees.length}</span>
        </div>
        <div class="drilldown-stat">
            <span class="drilldown-stat-label">Total Hours</span>
            <span class="drilldown-stat-value">${totalHours.toFixed(1)}h</span>
        </div>
        <div class="drilldown-stat">
            <span class="drilldown-stat-label">Average Hours</span>
            <span class="drilldown-stat-value">${avgHours}h</span>
        </div>
        <div style="margin-top: 16px; padding-top: 12px; border-top: 2px solid var(--border);">
            <h3 style="font-size: 13px; font-weight: 600; margin: 0 0 12px; color: var(--text);">Employees</h3>
    `;
    
    employees.sort((a, b) => parseFloat(b.hours) - parseFloat(a.hours)).forEach((emp, idx) => {
        html += `<div style="padding: 8px; background: ${idx % 2 === 0 ? '#f8f9fa' : '#fff'}; margin-bottom: 4px; border-radius: 4px; display: flex; justify-content: space-between;">
            <span style="font-weight: 500;">${escHtml(emp.name)}</span>
            <span style="color: var(--text-secondary); font-size: 12px;">${emp.hours}h</span>
        </div>`;
    });
    
    html += `</div>`;
    
    body.innerHTML = html;
    modal.classList.remove("hidden");
}

// ── Employee drill-down modal ─────────────────────────────────
function showEmployeeDrilldown(employee) {
    const modal = document.getElementById("drilldownModal");
    const title = document.getElementById("drilldownTitle");
    const body = document.getElementById("drilldownBody");

    title.textContent = `👤 ${employee.name} — Worklog Breakdown`;

    const projectBreakdown = Object.entries(employee)
        .filter(([key, value]) => !["name", "email", "total", "expected", "clocked_pct", "proj_pct", "general_pct"].includes(key) && typeof value === "number" && value > 0)
        .map(([project, hours]) => ({ project, hours }))
        .sort((a, b) => b.hours - a.hours);

    const worklogs = Array.isArray(employee.worklogs) ? [...employee.worklogs] : [];
    worklogs.sort((a, b) => {
        const dateCompare = String(b.date || "").localeCompare(String(a.date || ""));
        if (dateCompare !== 0) return dateCompare;
        return String(b.issue || "").localeCompare(String(a.issue || ""));
    });

    const totalProjects = projectBreakdown.length;
    const totalHours = employee.total || 0;

    let html = `
        <div class="drilldown-stat">
            <span class="drilldown-stat-label">Total Hours</span>
            <span class="drilldown-stat-value">${totalHours.toFixed(1)}h</span>
        </div>
        <div class="drilldown-stat">
            <span class="drilldown-stat-label">Projects Logged</span>
            <span class="drilldown-stat-value">${totalProjects}</span>
        </div>
        <div class="drilldown-stat">
            <span class="drilldown-stat-label">Clocked %</span>
            <span class="drilldown-stat-value">${pct(employee.clocked_pct || 0)}</span>
        </div>
        <div style="margin-top: 16px; padding-top: 12px; border-top: 2px solid var(--border);">
            <h3 style="font-size: 13px; font-weight: 600; margin: 0 0 12px; color: var(--text);">Projects</h3>
    `;

    if (projectBreakdown.length === 0) {
        html += `<p style="color: var(--text-secondary); font-size: 13px;">No project worklogs found for this employee.</p>`;
    } else {
        projectBreakdown.forEach((item, idx) => {
            html += `<div style="padding: 8px; background: ${idx % 2 === 0 ? '#f8f9fa' : '#fff'}; margin-bottom: 4px; border-radius: 4px; display: flex; justify-content: space-between;">
                <span style="font-weight: 500;">${escHtml(item.project)}</span>
                <span style="color: var(--text-secondary); font-size: 12px;">${item.hours.toFixed(1)}h</span>
            </div>`;
        });
    }

    html += `
        <div style="margin-top: 16px; padding-top: 12px; border-top: 2px solid var(--border);">
            <h3 style="font-size: 13px; font-weight: 600; margin: 0 0 12px; color: var(--text);">Worklogs by Date</h3>
    `;

    if (worklogs.length === 0) {
        html += `<p style="color: var(--text-secondary); font-size: 13px;">No dated worklog details available.</p>`;
    } else {
        worklogs.forEach((entry, idx) => {
            html += `<div style="padding: 8px; background: ${idx % 2 === 0 ? '#f8f9fa' : '#fff'}; margin-bottom: 4px; border-radius: 4px; display: flex; justify-content: space-between; gap: 12px;">
                <span style="font-weight: 500;">${escHtml(entry.date || '')} · ${escHtml(entry.project || '')} · ${escHtml(entry.issue || '')}</span>
                <span style="color: var(--text-secondary); font-size: 12px; white-space: nowrap;">${Number(entry.hours || 0).toFixed(1)}h</span>
            </div>`;
        });
    }

    html += `</div>`;

    body.innerHTML = html;
    modal.classList.remove("hidden");
}

// ── Modal controls ────────────────────────────────────────────
function setupModal() {
    const modal = document.getElementById("drilldownModal");
    const closeBtn = document.getElementById("closeModal");
    
    closeBtn.addEventListener("click", () => {
        modal.classList.add("hidden");
    });
    
    modal.addEventListener("click", (e) => {
        if (e.target === modal) {
            modal.classList.add("hidden");
        }
    });
}

// ── Data table ─────────────────────────────────────────────────
function renderTable() {
    const tbody = document.getElementById("tableBody");
    const search = document.getElementById("searchInput").value.toLowerCase();
    const filter = document.getElementById("filterSelect").value;

    // Filter out senior management
    let rows = dashboardData.filter(r => !r.exclude_from_metrics);

    if (filter === "high") rows = rows.filter(r => r.clocked_pct >= 0.75);
    else if (filter === "mid") rows = rows.filter(r => r.clocked_pct >= 0.40 && r.clocked_pct < 0.75);
    else if (filter === "low") rows = rows.filter(r => r.clocked_pct < 0.40);
    else if (filter === "over") rows = rows.filter(r => r.clocked_pct > 1.0);

    if (search) rows = rows.filter(r => r.name.toLowerCase().includes(search));

    rows.sort((a, b) => {
        let va = a[sortCol], vb = b[sortCol];
        if (typeof va === "string") { va = va.toLowerCase(); vb = vb.toLowerCase(); }
        return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
    });

    tbody.innerHTML = rows.map(r => `
        <tr class="employee-row" data-employee-name="${escHtml(r.name)}" style="cursor: pointer;">
            <td><strong>${escHtml(r.name)}</strong></td>
            <td>${r.total.toFixed(1)}</td>
            <td>${r.expected}</td>
            <td>${badge(r.clocked_pct)}</td>
            <td>${badge(r.proj_pct, "green")}</td>
            <td>${badge(r.general_pct, "amber")}</td>
        </tr>
    `).join("");

    // Attach click handlers to employee rows
    document.querySelectorAll(".employee-row").forEach(row => {
        row.addEventListener("click", () => {
            const empName = row.dataset.employeeName;
            const empData = dashboardData.find(d => d.name === empName);
            if (empData) {
                showEmployeeDrilldown(empData);
            }
        });
    });
}

function setupTableSort() {
    document.querySelectorAll("th[data-sort]").forEach(th => {
        th.addEventListener("click", () => {
            const col = th.dataset.sort;
            if (sortCol === col) sortAsc = !sortAsc;
            else { sortCol = col; sortAsc = true; }
            renderTable();
        });
    });
}

// ── Search & filter ────────────────────────────────────────────
function setupSearch() {
    document.getElementById("searchInput").addEventListener("input", renderTable);
}
function setupFilter() {
    document.getElementById("filterSelect").addEventListener("change", renderTable);
}

// ── File upload ────────────────────────────────────────────────
function setupUpload() {
    const dropZone = document.getElementById("dropZone");
    const fileInput = document.getElementById("fileInput");

    dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("dragover"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
    dropZone.addEventListener("drop", e => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => {
        if (fileInput.files.length) uploadFile(fileInput.files[0]);
    });
}

async function uploadFile(file) {
    const fd = new FormData();
    fd.append("file", file);
    try {
        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const json = await res.json();
        if (json.data && json.data.length) {
            dashboardData = json.data;
            document.getElementById("uploadPanel").classList.add("hidden");
            renderAll();
        } else {
            alert(json.error || "Upload failed");
        }
    } catch (e) {
        alert("Upload error: " + e.message);
    }
}

// ── CSV export ─────────────────────────────────────────────────
function setupExport() {
    document.getElementById("btnExport").addEventListener("click", () => {
        if (!dashboardData.length) return alert("No data to export");
        const header = "Name,Total Hours,Expected,Clocked %,Proj %,General %";
        // Exclude senior management from export
        const exportData = dashboardData.filter(r => !r.exclude_from_metrics);
        const rows = exportData.map(r =>
            `"${r.name}",${r.total},${r.expected},${(r.clocked_pct*100).toFixed(1)}%,${(r.proj_pct*100).toFixed(1)}%,${(r.general_pct*100).toFixed(1)}%`
        );
        const csv = [header, ...rows].join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "utilization_report.csv";
        a.click();
    });
}

// ── AI Insights ────────────────────────────────────────────────
// ── Helpers ────────────────────────────────────────────────────
function pct(v) { return (v * 100).toFixed(1) + "%"; }

function shortName(name) {
    const parts = name.split(" ");
    return parts.length > 2 ? parts[0] + " " + parts[parts.length - 1] : name;
}

function badge(val, forceColor) {
    const p = (val * 100).toFixed(1);
    let cls;
    if (forceColor === "green") cls = "badge-green";
    else if (forceColor === "amber") cls = "badge-amber";
    else if (val > 1.0) cls = "badge-red";
    else if (val >= 1.0) cls = "badge-green";
    else if (val >= 0.75) cls = "badge-green";
    else if (val >= 0.40) cls = "badge-amber";
    else cls = "badge-red";
    return `<span class="badge ${cls}">${p}%</span>`;
}

function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
}

function showLoading() {
    document.getElementById("loadingOverlay").style.display = "flex";
}

function hideLoading() {
    document.getElementById("loadingOverlay").style.display = "none";
}

// Call showLoading() BEFORE your fetch call
// Call hideLoading() AFTER data is rendered

// ── NEW FEATURES ───────────────────────────────────────────────

// F: Real-time Alerts
function renderAlerts() {
    const container = document.getElementById("alertsContainer");
    const metricsData = dashboardData.filter(r => !r.exclude_from_metrics);
    const alerts = [];
    
    // Zero hours logged
    const zeroHours = metricsData.filter(r => r.total === 0);
    if (zeroHours.length > 0) {
        alerts.push({
            type: "critical",
            icon: "🚫",
            title: `${zeroHours.length} team member(s) with zero hours logged`,
            description: zeroHours.slice(0, 5).map(r => r.name).join(", ") + (zeroHours.length > 5 ? "..." : "")
        });
    }
    
    // Consistently overworked (>120%)
    const overworked = metricsData.filter(r => r.clocked_pct > 1.20);
    if (overworked.length > 0) {
        alerts.push({
            type: "warning",
            icon: "⚡",
            title: `${overworked.length} team member(s) over 120% utilization`,
            description: overworked.slice(0, 5).map(r => r.name).join(", ") + (overworked.length > 5 ? "..." : "")
        });
    }
    
    // Under-utilized (<40%)
    const underutilized = metricsData.filter(r => r.clocked_pct < 0.40 && r.total > 0);
    if (underutilized.length > 0) {
        alerts.push({
            type: "info",
            icon: "ℹ️",
            title: `${underutilized.length} team member(s) below 40% utilization`,
            description: underutilized.slice(0, 5).map(r => r.name).join(", ") + (underutilized.length > 5 ? "..." : "")
        });
    }
    
    if (alerts.length === 0) {
        container.innerHTML = '<div class="alert-empty">✅ No alerts - team utilization looks healthy!</div>';
        return;
    }
    
    let html = "";
    alerts.forEach(alert => {
        html += `<div class="alert-item ${alert.type}">
            <span class="alert-icon">${alert.icon}</span>
            <div class="alert-content">
                <div class="alert-title">${alert.title}</div>
                <div class="alert-description">${alert.description}</div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

// G: Anomaly Detection
function renderAnomalies() {
    const container = document.getElementById("anomalyContainer");
    const metricsData = dashboardData.filter(r => !r.exclude_from_metrics);
    const anomalies = [];
    
    // Check for extreme single-day logging (if worklogs available)
    metricsData.forEach(person => {
        if (!person.worklogs || person.worklogs.length === 0) return;
        
        // Group by date
        const dailyHours = {};
        person.worklogs.forEach(wl => {
            const date = wl.date;
            dailyHours[date] = (dailyHours[date] || 0) + wl.hours;
        });
        
        // Flag days with >12 hours
        Object.entries(dailyHours).forEach(([date, hours]) => {
            if (hours > 12) {
                anomalies.push(`<strong>${escHtml(person.name)}</strong> logged ${hours.toFixed(1)}h on ${date}`);
            }
        });
        
        // Check for weekend logging
        person.worklogs.forEach(wl => {
            // Parse date in local timezone to avoid day shifting
            const [year, month, day] = wl.date.split('-').map(Number);
            const date = new Date(year, month - 1, day);
            const dayOfWeek = date.getDay();
            if (dayOfWeek === 0 || dayOfWeek === 6) {  // Sunday or Saturday
                anomalies.push(`<strong>${escHtml(person.name)}</strong> logged ${wl.hours}h on ${wl.date} (weekend)`);
            }
        });
    });
    
    if (anomalies.length === 0) {
        container.innerHTML = '<div class="anomaly-empty">✅ No anomalies detected</div>';
        return;
    }
    
    let html = "";
    anomalies.slice(0, 10).forEach(anomaly => {
        html += `<div class="anomaly-item">${anomaly}</div>`;
    });
    if (anomalies.length > 10) {
        html += `<div class="anomaly-item">...and ${anomalies.length - 10} more anomalies</div>`;
    }
    container.innerHTML = html;
}

// I: Project Health Dashboard
function renderProjectHealth() {
    const container = document.getElementById("projectHealthContainer");
    const projectList = [
        "DMS", "BMS", "IDT", "GEN", "PLT", "ITO", "HU",
        "DAT", "PAS", "PEM", "Customer Projs", "Platform Projs", "HA", "PEMV2", "ED"
    ];
    
    const metricsData = dashboardData.filter(r => !r.exclude_from_metrics);
    let html = "";
    
    projectList.forEach(proj => {
        const totalHours = metricsData.reduce((sum, emp) => sum + (emp[proj] || 0), 0);
        if (totalHours === 0) return;  // Skip projects with no hours
        
        // Simple staffing level logic (can be customized)
        let status, label;
        if (totalHours > 200) {
            status = "healthy";
            label = "Healthy";
        } else if (totalHours > 100) {
            status = "understaffed";
            label = "Moderate";
        } else {
            status = "understaffed";
            label = "Low";
        }
        
        html += `<div class="project-health-item ${status}">
            <div class="project-health-name">${proj}</div>
            <div class="project-health-hours">${Math.round(totalHours)}h</div>
            <div class="project-health-label">${label}</div>
        </div>`;
    });
    
    container.innerHTML = html || '<div style="padding: 24px; text-align: center; color: var(--text-secondary);">No project data available</div>';
}

// J: Comparison Mode
function setupComparison() {
    const btn = document.getElementById("btnToggleComparison");
    const content = document.getElementById("comparisonContent");
    
    btn.addEventListener("click", async () => {
        if (content.classList.contains("hidden")) {
            btn.textContent = "Loading...";
            btn.disabled = true;
            await loadComparisonData();
            content.classList.remove("hidden");
            btn.textContent = "Hide Comparison";
            btn.disabled = false;
        } else {
            content.classList.add("hidden");
            btn.textContent = "Enable Comparison";
        }
    });
}

async function loadComparisonData() {
    // Determine previous period
    let previousPeriod;
    if (currentPeriod === "current_week") {
        previousPeriod = "previous_week";
    } else if (currentPeriod === "current_month") {
        previousPeriod = "previous_month";
    } else {
        previousPeriod = "previous_month";
    }
    
    try {
        const res = await fetch(`/api/data?period=${previousPeriod}`);
        const json = await res.json();
        
        if (json.data) {
            renderComparisonView(dashboardData, json.data);
        }
    } catch (e) {
        console.error("Comparison load error:", e);
    }
}

function renderComparisonView(current, previous) {
    const metricsData = current.filter(r => !r.exclude_from_metrics);
    const prevMetricsData = previous.filter(r => !r.exclude_from_metrics);
    
    const currentMetrics = {
        teamSize: metricsData.length,
        totalHours: metricsData.reduce((s, r) => s + (r.total || 0), 0),
        avgClocked: metricsData.reduce((s, r) => s + (r.clocked_pct || 0), 0) / metricsData.length,
        zeroHours: metricsData.filter(r => r.total === 0).length
    };
    
    const prevMetrics = {
        teamSize: prevMetricsData.length,
        totalHours: prevMetricsData.reduce((s, r) => s + (r.total || 0), 0),
        avgClocked: prevMetricsData.reduce((s, r) => s + (r.clocked_pct || 0), 0) / prevMetricsData.length,
        zeroHours: prevMetricsData.filter(r => r.total === 0).length
    };
    
    const delta = {
        teamSize: currentMetrics.teamSize - prevMetrics.teamSize,
        totalHours: currentMetrics.totalHours - prevMetrics.totalHours,
        avgClocked: currentMetrics.avgClocked - prevMetrics.avgClocked,
        zeroHours: currentMetrics.zeroHours - prevMetrics.zeroHours
    };
    
    document.getElementById("currentPeriodMetrics").innerHTML = `
        <div class="metric-row"><span class="metric-label">Team Size</span><span class="metric-value">${currentMetrics.teamSize}</span></div>
        <div class="metric-row"><span class="metric-label">Total Hours</span><span class="metric-value">${Math.round(currentMetrics.totalHours)}</span></div>
        <div class="metric-row"><span class="metric-label">Avg Clocked %</span><span class="metric-value">${pct(currentMetrics.avgClocked)}</span></div>
        <div class="metric-row"><span class="metric-label">Zero Hours</span><span class="metric-value">${currentMetrics.zeroHours}</span></div>
    `;
    
    document.getElementById("previousPeriodMetrics").innerHTML = `
        <div class="metric-row"><span class="metric-label">Team Size</span><span class="metric-value">${prevMetrics.teamSize}</span></div>
        <div class="metric-row"><span class="metric-label">Total Hours</span><span class="metric-value">${Math.round(prevMetrics.totalHours)}</span></div>
        <div class="metric-row"><span class="metric-label">Avg Clocked %</span><span class="metric-value">${pct(prevMetrics.avgClocked)}</span></div>
        <div class="metric-row"><span class="metric-label">Zero Hours</span><span class="metric-value">${prevMetrics.zeroHours}</span></div>
    `;
    
    document.getElementById("deltaMetrics").innerHTML = `
        <div class="metric-row"><span class="metric-label">Team Size</span><span class="metric-value ${delta.teamSize >= 0 ? 'positive' : 'negative'}">${delta.teamSize >= 0 ? '+' : ''}${delta.teamSize}</span></div>
        <div class="metric-row"><span class="metric-label">Total Hours</span><span class="metric-value ${delta.totalHours >= 0 ? 'positive' : 'negative'}">${delta.totalHours >= 0 ? '+' : ''}${Math.round(delta.totalHours)}</span></div>
        <div class="metric-row"><span class="metric-label">Avg Clocked %</span><span class="metric-value ${delta.avgClocked >= 0 ? 'positive' : 'negative'}">${delta.avgClocked >= 0 ? '+' : ''}${pct(delta.avgClocked)}</span></div>
        <div class="metric-row"><span class="metric-label">Zero Hours</span><span class="metric-value ${delta.zeroHours <= 0 ? 'positive' : 'negative'}">${delta.zeroHours >= 0 ? '+' : ''}${delta.zeroHours}</span></div>
    `;
}

// B: Daily Breakdown View
function renderDailyBreakdownControls() {
    const select = document.getElementById("personSelect");
    select.innerHTML = '<option value="">Select a team member...</option>';
    
    dashboardData.forEach(person => {
        const option = document.createElement("option");
        option.value = person.name;
        option.textContent = person.name;
        select.appendChild(option);
    });
    
    select.addEventListener("change", (e) => {
        if (e.target.value) {
            renderDailyBreakdown(e.target.value);
        } else {
            document.getElementById("dailyBreakdownContainer").innerHTML = '';
        }
    });
}

function renderDailyBreakdown(personName) {
    const person = dashboardData.find(p => p.name === personName);
    if (!person) {
        document.getElementById("dailyBreakdownContainer").innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-secondary);">No data available for this person</div>';
        return;
    }
    
    // Group by date from worklogs
    const dailyHours = {};
    if (person.worklogs && person.worklogs.length > 0) {
        person.worklogs.forEach(wl => {
            const date = wl.date;
            dailyHours[date] = (dailyHours[date] || 0) + wl.hours;
        });
    }
    
    // For month views, show all days in the month
    let datesToShow = [];
    if (currentPeriod === "current_month" || currentPeriod === "previous_month") {
        const today = new Date();
        let year = today.getFullYear();
        let month = today.getMonth();
        
        if (currentPeriod === "previous_month") {
            month -= 1;
            if (month < 0) {
                month = 11;
                year -= 1;
            }
        }
        
        // Generate all days in the month
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        
        for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
            // Format date in local timezone (YYYY-MM-DD)
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            datesToShow.push({
                date: dateStr,
                hours: dailyHours[dateStr] || 0,
                dateObj: new Date(d)
            });
        }
    } else {
        // For other periods, show only days with logs
        datesToShow = Object.entries(dailyHours).map(([date, hours]) => {
            // Parse date in local timezone (not UTC) to avoid day shifting
            const [year, month, day] = date.split('-').map(Number);
            const dateObj = new Date(year, month - 1, day);
            return {
                date: date,
                hours: hours,
                dateObj: dateObj
            };
        }).sort((a, b) => a.dateObj - b.dateObj);
    }
    
    if (datesToShow.length === 0) {
        document.getElementById("dailyBreakdownContainer").innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-secondary);">No worklog data available for this person</div>';
        return;
    }
    
    // Generate day cards
    let html = '<div class="daily-details-grid">';
    datesToShow.forEach(({date, hours, dateObj}) => {
        const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
        const dayNum = dateObj.getDate();
        const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
        const hasHours = hours > 0;
        
        html += `<div class="daily-day-card ${isWeekend ? 'active' : ''} ${!hasHours ? 'zero-hours' : ''}">
            <div class="daily-day-name">${dayName} ${dayNum}</div>
            <div class="daily-day-hours">${hours.toFixed(1)}h</div>
            <div class="daily-day-date">${date}</div>
        </div>`;
    });
    html += '</div>';
    
    document.getElementById("dailyDetails").innerHTML = html;
}

// A: Trend Analysis
function setupTrendControls() {
    document.querySelectorAll(".trend-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".trend-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            trendType = btn.dataset.trend;
            renderTrendChart();
        });
    });
}

function renderTrendChart() {
    const ctx = document.getElementById("trendChart");
    if (!ctx) return;
    
    const metricsData = dashboardData.filter(r => !r.exclude_from_metrics);
    
    // Simulate trend data for demonstration
    // In production, you'd fetch historical data from backend
    const labels = generateTrendLabels();
    const datasets = generateTrendDatasets(metricsData, labels);
    
    if (trendChart) trendChart.destroy();
    
    trendChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: labels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: "top",
                    labels: { font: { size: 12 }, padding: 16 }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: function(value) {
                            if (trendType === "utilization") {
                                return value + "%";
                            }
                            return value + "h";
                        }
                    }
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            }
        }
    });
}

function generateTrendLabels() {
    // Generate last 8 weeks/periods for trend
    const labels = [];
    const today = new Date();
    
    if (currentPeriod.includes("month")) {
        // Monthly trend - show last 6 months
        for (let i = 5; i >= 0; i--) {
            const date = new Date(today.getFullYear(), today.getMonth() - i, 1);
            labels.push(date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }));
        }
    } else {
        // Weekly trend - show last 8 weeks
        for (let i = 7; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(today.getDate() - (i * 7));
            labels.push("W" + getWeekNumber(date));
        }
    }
    
    return labels;
}

function generateTrendDatasets(metricsData, labels) {
    const currentValue = calculateCurrentMetric(metricsData);
    
    // Simulate historical trend (in production, fetch from backend)
    const data = labels.map((label, idx) => {
        // Generate realistic trend with slight variations
        const variation = (Math.random() - 0.5) * 10;
        const trend = currentValue + variation - (labels.length - idx - 1) * 2;
        return Math.max(0, trend);
    });
    
    let dataset = {};
    
    if (trendType === "utilization") {
        dataset = {
            label: "Team Utilization %",
            data: data,
            borderColor: "#0052CC",
            backgroundColor: "rgba(0, 82, 204, 0.1)",
            tension: 0.3,
            fill: true
        };
    } else if (trendType === "project") {
        dataset = {
            label: "Project Hours",
            data: data,
            borderColor: "#00875A",
            backgroundColor: "rgba(0, 135, 90, 0.1)",
            tension: 0.3,
            fill: true
        };
    } else if (trendType === "general") {
        dataset = {
            label: "General Hours",
            data: data,
            borderColor: "#FF991F",
            backgroundColor: "rgba(255, 153, 31, 0.1)",
            tension: 0.3,
            fill: true
        };
    }
    
    return [dataset];
}

function calculateCurrentMetric(metricsData) {
    if (trendType === "utilization") {
        const avgClocked = metricsData.reduce((s, r) => s + (r.clocked_pct || 0), 0) / metricsData.length;
        return avgClocked * 100;
    } else if (trendType === "project") {
        const totalProj = metricsData.reduce((s, r) => s + (r.total - (r.GEN || 0)), 0);
        return totalProj / metricsData.length;
    } else if (trendType === "general") {
        const totalGen = metricsData.reduce((s, r) => s + (r.GEN || 0), 0);
        return totalGen / metricsData.length;
    }
    return 0;
}