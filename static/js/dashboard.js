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
    loadPeriod("previous_month");
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

// ── Bar chart (Total Hours, Project Hours, General Hours vs Expected) ──
function renderBarChart() {
    const ctx = document.getElementById("barChart").getContext("2d");
    const sorted = [...dashboardData].sort((a, b) => b.total - a.total).slice(0, 30);
    const labels = sorted.map(r => shortName(r.name));

    if (barChart) barChart.destroy();
    barChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Expected Hours (Q)",
                    data: sorted.map(r => r.expected),
                    backgroundColor: "rgba(101, 84, 192, 0.25)",
                    borderColor: "#6554C0",
                    borderWidth: 2,
                    borderRadius: 3,
                    order: 1,
                },
                {
                    label: "Total Clocked Hours",
                    data: sorted.map(r => +r.total.toFixed(1)),
                    backgroundColor: "#0052CC",
                    borderRadius: 3,
                    order: 2,
                },
                {
                    label: "Project Hours",
                    data: sorted.map(r => +(r.total - (r.GEN || 0)).toFixed(1)),
                    backgroundColor: "#00875A",
                    borderRadius: 3,
                    order: 3,
                },
                {
                    label: "General/Overhead Hours",
                    data: sorted.map(r => +(r.GEN || 0).toFixed(1)),
                    backgroundColor: "#FF991F",
                    borderRadius: 3,
                    order: 4,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { position: "top", labels: { font: { size: 11 } } },
                tooltip: {
                    callbacks: {
                        label: ctx => `${ctx.dataset.label}: ${ctx.raw} hrs`
                    }
                },
            },
            scales: {
                x: { ticks: { font: { size: 10 }, maxRotation: 55, minRotation: 35 } },
                y: {
                    beginAtZero: true,
                    ticks: { callback: v => v + "h" },
                    title: { display: true, text: "Hours" },
                },
            },
        },
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