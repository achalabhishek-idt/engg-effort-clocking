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
    const healthy = d.filter(r => r.clocked_pct >= 0.75).length;
    const low = d.filter(r => r.clocked_pct < 0.30).length;

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
        if (pct >= 1.0)  return "#00875A";
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
                    <span style="font-weight:500;">${i + 1}. ${r.name}</span>
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
            <span class="legend-item"><span class="dot green"></span> ≥100%</span>
            <span class="legend-item"><span class="dot blue"></span> 75-99%</span>
            <span class="legend-item"><span class="dot orange"></span> 1-74%</span>
            <span class="legend-item"><span class="dot red"></span> 0%</span>
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

// ── Data table ─────────────────────────────────────────────────
function renderTable() {
    const tbody = document.getElementById("tableBody");
    const search = document.getElementById("searchInput").value.toLowerCase();
    const filter = document.getElementById("filterSelect").value;

    let rows = [...dashboardData];

    if (filter === "high") rows = rows.filter(r => r.clocked_pct >= 0.75);
    else if (filter === "mid") rows = rows.filter(r => r.clocked_pct >= 0.40 && r.clocked_pct < 0.75);
    else if (filter === "low") rows = rows.filter(r => r.clocked_pct < 0.40);
    else if (filter === "over") rows = rows.filter(r => r.clocked_pct >= 1.0);

    if (search) rows = rows.filter(r => r.name.toLowerCase().includes(search));

    rows.sort((a, b) => {
        let va = a[sortCol], vb = b[sortCol];
        if (typeof va === "string") { va = va.toLowerCase(); vb = vb.toLowerCase(); }
        return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
    });

    tbody.innerHTML = rows.map(r => `
        <tr>
            <td><strong>${escHtml(r.name)}</strong></td>
            <td>${r.total.toFixed(1)}</td>
            <td>${r.expected}</td>
            <td>${badge(r.clocked_pct)}</td>
            <td>${badge(r.proj_pct, "green")}</td>
            <td>${badge(r.general_pct, "amber")}</td>
        </tr>
    `).join("");
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
    else if (val >= 0.75) cls = "badge-green";
    else if (val >= 0.40) cls = "badge-amber";
    else cls = "badge-red";
    if (val >= 1.0 && !forceColor) cls = "badge-blue";
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