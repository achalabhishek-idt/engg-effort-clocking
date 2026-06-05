/**
 * Engineering Resource Utilization Dashboard
 * Client-side: Charts, table, filters, export, file upload
 */

// ── State ──────────────────────────────────────────────────────
let dashboardData = [];
let barChart = null;
let donutChart = null;
let sortCol = "clocked_pct";
let sortAsc = false;

// ── Init ───────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    setupTabs();
    setupUpload();
    setupSearch();
    setupFilter();
    setupExport();
    setupInsights();
    setupTableSort();
    setupModal();
    loadPeriod("current_week");
});

// ── Tab navigation ─────────────────────────────────────────────
function setupTabs() {
    document.querySelectorAll(".tab").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
            btn.classList.add("active");
            const period = btn.dataset.period;
            if (period === "upload") {
                document.getElementById("uploadPanel").classList.remove("hidden");
            } else {
                document.getElementById("uploadPanel").classList.add("hidden");
                loadPeriod(period);
            }
        });
    });
}

// ── Data loading ───────────────────────────────────────────────
async function loadPeriod(period) {
    showLoading();
    document.getElementById("insightsContent").innerHTML =
        '<span class="spinner"></span> Loading data from JIRA…';
    try {
        const res = await fetch(`/api/data?period=${period}`);
        const json = await res.json();
        if (json.data && json.data.length) {
            dashboardData = json.data;
            renderAll();
            document.getElementById("insightsContent").innerHTML =
                '<p class="placeholder-text">Click "Generate Insights" for AI analysis.</p>';
        } else if (json.error) {
            document.getElementById("insightsContent").innerHTML =
                `<p style="color:#de350b">⚠️ ${json.error}</p>
                 <p>Use the <strong>Upload Excel</strong> tab to load data manually.</p>`;
        } else {
            document.getElementById("insightsContent").innerHTML =
                `<p style="color:#ff991f">⚠️ No worklogs found for this period.</p>
                 <p>Try <strong>Previous Month</strong> or <strong>Upload Excel</strong>.</p>`;
        }
    } catch (e) {
        console.error("Load error:", e);
        document.getElementById("insightsContent").innerHTML =
            `<p style="color:#de350b">❌ Connection error: ${e.message}</p>`;
    }   finally {
        hideLoading();
    }
}

function renderAll() {
    renderKPIs();
    renderBarChart();
    renderDonutChart();
    renderProjects();
    renderTable();
    document.getElementById("lastUpdated").textContent = "Updated: " + new Date().toLocaleString("en-IN");
}

// ── KPIs ───────────────────────────────────────────────────────
function renderKPIs() {
    const d = dashboardData;
    const n = d.length;
    const avgC = d.reduce((s, r) => s + r.clocked_pct, 0) / n;
    const avgP = d.reduce((s, r) => s + r.proj_pct, 0) / n;
    const avgG = d.reduce((s, r) => s + r.general_pct, 0) / n;
    const healthy = d.filter(r => r.clocked_pct > 1.20).length;
    const low = d.filter(r => r.clocked_pct < 0.80).length;

    document.getElementById("kpiTeamSize").textContent = n;
    document.getElementById("kpiClocked").textContent = pct(avgC);
    document.getElementById("kpiProj").textContent = pct(avgP);
    document.getElementById("kpiGeneral").textContent = pct(avgG);
    document.getElementById("kpiHealthy").textContent = healthy;
    document.getElementById("kpiLow").textContent = low;
}


// ── Bar chart (scrollable, professional) ──
function renderBarChart() {
    const container = document.getElementById("barChartContainer");
    if (barChart) { barChart.destroy(); barChart = null; }

    const logged = dashboardData.filter(r => r.total > 0).sort((a, b) => b.total - a.total);
    const notLogged = dashboardData.filter(r => r.total === 0);

    const getColor = (pct) => {
        if (pct > 1.0)  return "#6554C0"; // overutilized flag
        if (pct >= 1.0) return "#00875A";
        if (pct >= 0.75) return "#0052CC";
        if (pct >= 0.40) return "#FF991F";
        return "#DE350B";
    };

    let html = "";

    // ── SECTION 2: Top 10 & Bottom 10 ──
    const top10 = logged.slice(0, 10);
    const bottom10 = logged.slice(-10).reverse();
    const maxHours = top10[0]?.total || 168;

    function renderMiniBar(list, title, titleColor, emoji, extraHtml = "") {
        let s = `<div>
            <h3 style="font-size:14px; color:${titleColor}; margin:0 0 12px; display:flex; align-items:center; gap:6px;">
                ${emoji} ${title}
            </h3>`;
        list.forEach((r, i) => {
            const pct = ((r.total / r.expected) * 100).toFixed(0);
            const width = Math.max(3, (r.total / maxHours) * 100);
            const color = getColor(r.clocked_pct);
            s += `<div style="margin-bottom:8px;">
                <div style="display:flex; justify-content:space-between; font-size:12px; color:#172B4D; margin-bottom:3px;">
                    <span class="employee-name-link" data-employee-name="${escHtml(r.name)}" style="font-weight:500; cursor:pointer; color:#0052CC; text-decoration:none;">${i + 1}. ${r.name}</span>
                    <span style="font-weight:700; color:${color};">${r.total.toFixed(1)}h · ${pct}%</span>
                </div>
                <div style="background:#F4F5F7; border-radius:4px; height:10px; overflow:hidden;">
                    <div style="width:${width}%; height:100%; background:${color}; border-radius:4px; transition:width 0.5s;"></div>
                </div>
            </div>`;
        });
        s += extraHtml;
        s += `</div>`;
        return s;
    }

    const legendHtml = `
        <div class="chart-legend-strip" style="margin-top: 12px;">
            <span class="legend-item"><span class="dot purple"></span> >100%</span>
            <span class="legend-item"><span class="dot green"></span> 100%</span>
            <span class="legend-item"><span class="dot blue"></span> 75-99%</span>
            <span class="legend-item"><span class="dot orange"></span> 40-74%</span>
            <span class="legend-item"><span class="dot red"></span> 0-39%</span>
        </div>
    `;

    html += `<div style="display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-bottom:24px;">`;
    html += renderMiniBar(top10, "Top 10 Clockers", "#00875A", "🔝", legendHtml);
    html += renderMiniBar(bottom10, "Bottom 10 Clockers", "#DE350B", "🔻");
    html += `</div>`;

    // ── SECTION 4: Not Logged Summary ──
    if (notLogged.length > 0) {
        html += `<details style="margin-top:16px; padding:12px 16px; background:#FAFBFC; border:1px solid #DFE1E6; border-radius:8px;">
            <summary style="cursor:pointer; font-size:13px; color:#6B778C; font-weight:600;">
                🔴 ${notLogged.length} team members with 0 hours logged
            </summary>
            <div style="margin-top:8px; font-size:12px; color:#7A869A; columns:3; column-gap:20px;">
                ${notLogged.sort((a,b) => a.name.localeCompare(b.name)).map(r => `<div style="padding:2px 0;">${r.name}</div>`).join("")}
            </div>
        </details>`;
    }

    container.innerHTML = html;
    
    // Attach click handlers to employee names
    document.querySelectorAll(".employee-name-link").forEach(link => {
        link.addEventListener("click", (e) => {
            e.preventDefault();
            const empName = link.dataset.employeeName;
            const empData = dashboardData.find(d => d.name === empName);
            if (empData) {
                showEmployeeDrilldown(empData);
            }
        });
    });
}

// ── Donut chart (distribution buckets) ─────────────────────────
function renderDonutChart() {
    const ctx = document.getElementById("donutChart").getContext("2d");
    const d = dashboardData;
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

    dashboardData.forEach(emp => {
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

    let rows = [...dashboardData];

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
        const rows = dashboardData.map(r =>
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
function setupInsights() {
    document.getElementById("btnInsights").addEventListener("click", async () => {
        const el = document.getElementById("insightsContent");
        el.innerHTML = '<span class="spinner"></span> Generating insights…';
        try {
            const res = await fetch("/api/insights", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ data: dashboardData }),
            });
            const json = await res.json();
            el.innerHTML = json.insights || "No insights generated.";
        } catch (e) {
            el.textContent = "Error generating insights: " + e.message;
        }
    });
}

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