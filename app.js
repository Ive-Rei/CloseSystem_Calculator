// Close System, RP & Buffer Simulator — Linear, CS2 & Cent Account Engine
const PRESETS = {
  XAUUSD: { capital: 25000, contractSize: 100, upper: 2700, lower: 1800, floor: 0, zones: 10, lot: 0.01, leverage: 500, tp: 20, onePip: 0.01, isUsdBase: false, decimals: 2 },
  EURUSD: { capital: 12000, contractSize: 100000, upper: 1.1500, lower: 1.0000, floor: 0, zones: 10, lot: 0.01, leverage: 500, tp: 0.0050, onePip: 0.0001, isUsdBase: false, decimals: 4 },
  USDJPY: { capital: 10000, contractSize: 100000, upper: 160.00, lower: 130.00, floor: 80.00, zones: 10, lot: 0.01, leverage: 500, tp: 1.00, onePip: 0.01, isUsdBase: true, decimals: 2 },
  AUDUSD: { capital: 8000, contractSize: 100000, upper: 0.7200, lower: 0.5800, floor: 0, zones: 10, lot: 0.01, leverage: 500, tp: 0.0050, onePip: 0.0001, isUsdBase: false, decimals: 4 },
  BTCUSDT: { capital: 10000, contractSize: 1, upper: 100000, lower: 40000, floor: 0, zones: 12, lot: 0.01, leverage: 1, tp: 2000, onePip: 1, isUsdBase: false, decimals: 0 },
  TDEX: { capital: 25000, contractSize: 100, upper: 11.32, lower: 8.92, floor: 0, zones: 25, lot: 1, leverage: 1, tp: 0.20, onePip: 0.01, isUsdBase: false, decimals: 2 },
};

const els = {
  preset: document.getElementById("preset"),
  accountMode: document.getElementById("accountMode"),
  gridModel: document.getElementById("gridModel"),
  cs2Options: document.getElementById("cs2Options"),
  cs2Gamma: document.getElementById("cs2Gamma"),
  capital: document.getElementById("capital"),
  contractSize: document.getElementById("contractSize"),
  upperPrice: document.getElementById("upperPrice"),
  lowerPrice: document.getElementById("lowerPrice"),
  floorPrice: document.getElementById("floorPrice"),
  numZones: document.getElementById("numZones"),
  lotSize: document.getElementById("lotSize"),
  lotSizeLabel: document.getElementById("lotSizeLabel"),
  leverage: document.getElementById("leverage"),
  stopOutPct: document.getElementById("stopOutPct"),
  tpDistance: document.getElementById("tpDistance"),
  cyclesPerMonth: document.getElementById("cyclesPerMonth"),
  btnAutoLot: document.getElementById("btnAutoLot"),
  btnExportCsv: document.getElementById("btnExportCsv"),
};

let drawdownChart = null;
let marginChart = null;
let lastZonesData = [];

function getParams() {
  const presetKey = els.preset.value;
  const meta = PRESETS[presetKey] || { onePip: 0.01, isUsdBase: false, decimals: 2 };
  const isCent = els.accountMode.value === "CENT";
  const gridModel = els.gridModel.value;
  const cs2Gamma = Math.max(1, Math.min(4, parseFloat(els.cs2Gamma.value) || 1.5));

  const capital = Math.max(1, parseFloat(els.capital.value) || 0);
  const rawContractSize = Math.max(0.0001, parseFloat(els.contractSize.value) || 1);
  // In a Cent account, 1.00 Cent Lot = 1/100 of a Standard Lot in USD exposure
  const effectiveContractSize = isCent ? rawContractSize / 100 : rawContractSize;

  const upper = Math.max(0.0001, parseFloat(els.upperPrice.value) || 1);
  let lower = Math.max(0, parseFloat(els.lowerPrice.value) || 0);
  if (lower >= upper) lower = upper * 0.5;
  let floor = Math.max(0, parseFloat(els.floorPrice.value) || 0);
  if (floor > lower) floor = lower;

  const numZones = Math.max(2, Math.min(200, Math.round(parseFloat(els.numZones.value) || 10)));
  const lotSize = Math.max(0.001, parseFloat(els.lotSize.value) || 0.01);
  const leverage = Math.max(1, parseFloat(els.leverage.value) || 1);
  const stopOutPct = Math.max(0, Math.min(100, parseFloat(els.stopOutPct.value) || 0));
  const tpDistance = Math.max(0.0001, parseFloat(els.tpDistance.value) || 1);
  const cyclesPerMonth = Math.max(1, parseFloat(els.cyclesPerMonth.value) || 1);

  return {
    presetKey, isCent, gridModel, cs2Gamma, capital, rawContractSize, effectiveContractSize,
    upper, lower, floor, numZones, lotSize, leverage, stopOutPct, tpDistance, cyclesPerMonth,
    onePip: meta.onePip, isUsdBase: meta.isUsdBase, decimals: meta.decimals
  };
}

function fmtUsd(val, isCent = false) {
  const s = "$" + val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!isCent) return s;
  const usc = Math.round(val * 100).toLocaleString("en-US");
  return `${s} (${usc} USC)`;
}

function fmtUsdShort(val) {
  return "$" + val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPrice(val, dec) {
  return val.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function computeModel(p) {
  const step = (p.upper - p.lower) / (p.numZones - 1);
  const zones = [];
  let totalBufferToFloor = 0;
  let totalUsedMargin = 0;
  let totalLots = 0;
  let weightedPriceSum = 0;

  // Compute CS2 Inverse Function weights if CS2 mode is active
  // Target(P) = Capital * ((Upper - P) / (Upper - Lower))^gamma
  const cs2Weights = [];
  if (p.gridModel === "CS2") {
    let prevTarget = 0;
    for (let i = 0; i < p.numZones; i++) {
      const entry = p.upper - i * step;
      const norm = Math.max(0.02, (p.upper - entry) / Math.max(1e-6, p.upper - p.lower));
      const targetFrac = Math.pow(norm, p.cs2Gamma);
      const deltaFrac = i === 0 ? Math.max(0.03, targetFrac) : Math.max(0.01, targetFrac - prevTarget);
      prevTarget = targetFrac;
      // Inverse price multiplier: lower price buys proportionally more units
      const invRatio = (p.upper / Math.max(1e-6, entry)) * deltaFrac;
      cs2Weights.push(invRatio);
    }
    const minW = Math.min(...cs2Weights);
    for (let i = 0; i < cs2Weights.length; i++) {
      cs2Weights[i] = cs2Weights[i] / minW; // Normalize so smallest top zone = 1x base lot
    }
  }

  for (let i = 0; i < p.numZones; i++) {
    const entry = p.upper - i * step;
    const tp = entry + p.tpDistance;
    const zoneLot = p.gridModel === "CS2"
      ? Math.max(0.01, Math.round(p.lotSize * cs2Weights[i] * 100) / 100)
      : p.lotSize;

    const convDivisor = p.isUsdBase ? Math.max(1e-6, p.floor > 0 ? p.floor : entry) : 1;
    const bulletBuffer = ((entry - p.floor) * p.effectiveContractSize * zoneLot) / convDivisor;
    const usedMargin = p.isUsdBase
      ? (p.effectiveContractSize * zoneLot) / p.leverage
      : (entry * p.effectiveContractSize * zoneLot) / p.leverage;

    totalBufferToFloor += bulletBuffer;
    totalUsedMargin += usedMargin;
    totalLots += zoneLot;
    weightedPriceSum += entry * zoneLot;

    zones.push({
      index: i + 1,
      entry,
      tp,
      lotSize: zoneLot,
      bulletBuffer,
      usedMargin,
    });
  }

  const simSteps = 25;
  const simPrices = [];
  const simEquities = [];
  const simFloatingDD = [];
  const simMarginLevels = [];
  const simStopOutLine = [];
  const stopOutEquity = (p.stopOutPct / 100) * totalUsedMargin;

  for (let s = 0; s <= simSteps; s++) {
    const price = p.upper - (s / simSteps) * (p.upper - p.floor);
    let dd = 0;
    let activeMargin = 0;
    for (const z of zones) {
      if (price <= z.entry) {
        const div = p.isUsdBase ? Math.max(1e-6, price || 1) : 1;
        dd += ((z.entry - price) * p.effectiveContractSize * z.lotSize) / div;
        activeMargin += z.usedMargin;
      }
    }
    const equity = p.capital - dd;
    const ml = activeMargin > 0 ? (equity / activeMargin) * 100 : 9999;

    simPrices.push(fmtPrice(price, p.decimals));
    simEquities.push(Number(equity.toFixed(2)));
    simFloatingDD.push(Number(dd.toFixed(2)));
    simMarginLevels.push(Number(Math.min(5000, Math.max(-200, ml)).toFixed(1)));
    simStopOutLine.push(Number(stopOutEquity.toFixed(2)));
  }

  for (const z of zones) {
    let ddAtEntry = 0;
    for (const prev of zones) {
      if (prev.entry > z.entry) {
        const div = p.isUsdBase ? Math.max(1e-6, z.entry) : 1;
        ddAtEntry += ((prev.entry - z.entry) * p.effectiveContractSize * prev.lotSize) / div;
      }
    }
    z.ddAtEntry = ddAtEntry;
    z.equityAtEntry = p.capital - ddAtEntry;
  }

  const equityAtFloor = p.capital - totalBufferToFloor;
  const marginLevelAtFloor = totalUsedMargin > 0 ? (equityAtFloor / totalUsedMargin) * 100 : Infinity;
  const maxDrawdownZone = Math.max(1e-6, p.upper - p.floor);
  const rpZone = p.capital / maxDrawdownZone;
  const bulletRP = (p.upper * p.effectiveContractSize * zones[0].lotSize) / (p.isUsdBase ? p.upper : 1);

  const avgEntry = weightedPriceSum / Math.max(1e-6, totalLots);
  const avgLot = totalLots / p.numZones;
  const pipValue = (avgLot * p.effectiveContractSize * p.onePip) / (p.isUsdBase ? avgEntry : 1);

  let stopOutPrice = 0;
  if (!p.isUsdBase) {
    stopOutPrice = avgEntry - (p.capital - stopOutEquity) / (p.effectiveContractSize * totalLots);
  } else {
    stopOutPrice = avgEntry / (1 + (p.capital - stopOutEquity) / (p.effectiveContractSize * totalLots));
  }

  const cfPerCycle = (p.tpDistance * p.effectiveContractSize * avgLot) / (p.isUsdBase ? avgEntry : 1);
  const monthlyCF = cfPerCycle * p.cyclesPerMonth;
  const monthsToTrueAlpha = monthlyCF > 0 ? p.capital / monthlyCF : Infinity;

  return {
    step, zones, totalBufferToFloor, totalUsedMargin, equityAtFloor,
    marginLevelAtFloor, rpZone, bulletRP, totalLots, avgLot, pipValue,
    stopOutPrice, cfPerCycle, monthlyCF, monthsToTrueAlpha,
    simPrices, simEquities, simFloatingDD, simMarginLevels, simStopOutLine, stopOutEquity
  };
}

function updateUI() {
  const p = getParams();
  els.cs2Options.classList.toggle("hidden", p.gridModel !== "CS2");
  els.lotSizeLabel.textContent = p.gridModel === "CS2"
    ? (p.isCent ? "Base Cent Lot (บนสุด)" : "Base Lot (โซนบนสุด)")
    : (p.isCent ? "ขนาดต่อไม้ (Cent Lot)" : "ขนาดต่อไม้ (Lot Size)");

  const m = computeModel(p);
  lastZonesData = m.zones;

  const banner = document.getElementById("statusBanner");
  const icon = document.getElementById("statusIcon");
  const title = document.getElementById("statusTitle");
  const desc = document.getElementById("statusDesc");
  banner.className = "status-banner";

  if (m.equityAtFloor > m.stopOutEquity && p.floor === 0) {
    banner.classList.add("status-safe");
    icon.textContent = "🛡️";
    title.textContent = `FULL CLOSE SYSTEM VERIFIED (${p.isCent ? "Cent Account • " : ""}${p.gridModel === "CS2" ? "CS2 Inverse" : "Linear"})`;
    desc.textContent = `เงินทุน ${fmtUsd(p.capital, p.isCent)} เพียงพอรองรับการลากลงถึง 0 ได้ครบทั้ง ${p.numZones} โซน (Margin Level ที่จุด Floor = ${m.marginLevelAtFloor === Infinity ? "∞" : m.marginLevelAtFloor.toFixed(0) + "%"})`;
  } else if (m.equityAtFloor > m.stopOutEquity) {
    banner.classList.add("status-warn");
    icon.textContent = "⚠️";
    title.textContent = `BOUNDED CLOSE SYSTEM (ปลอดภัยถึง Floor ${fmtPrice(p.floor, p.decimals)})`;
    desc.textContent = `รองรับถึงระดับราคา Floor ที่กำหนดไว้ได้ แต่หากราคาทะลุต่ำกว่า ${fmtPrice(m.stopOutPrice, p.decimals)} จะเข้าสู่โซน Stop Out`;
  } else {
    banner.classList.add("status-danger");
    icon.textContent = "🚨";
    title.textContent = "OVERLEVERAGE WARNING — เสี่ยงโดน Stop Out!";
    const centHint = !p.isCent ? " หรือสลับเป็นโหมด Cent Account" : "";
    desc.textContent = `เงินทุนที่ต้องใช้ถึง Floor คือ ${fmtUsd(m.totalBufferToFloor, p.isCent)} ซึ่งเกินทุนที่มี! กด 'คำนวณ Lot ปลอดภัยสูงสุด'${centHint}`;
  }

  document.getElementById("kpiRequiredCap").textContent = fmtUsdShort(m.totalBufferToFloor);
  const utilPct = (m.totalBufferToFloor / p.capital) * 100;
  document.getElementById("kpiCapRatio").textContent = p.isCent
    ? `${Math.round(m.totalBufferToFloor * 100).toLocaleString("en-US")} USC (${utilPct.toFixed(1)}%)`
    : `ใช้หน้าตัก ${utilPct.toFixed(1)}% ของทุน`;

  document.getElementById("kpiRP").textContent = `${fmtUsdShort(m.rpZone)} / 1.00`;
  document.getElementById("kpiBulletRP").textContent = `RP นัดบนสุด: ${fmtUsdShort(m.bulletRP)}`;

  document.getElementById("kpiGridStep").textContent = fmtPrice(m.step, p.decimals);
  document.getElementById("kpiTotalExposure").textContent = `Total ${p.isCent ? "Cent " : ""}Lots: ${m.totalLots.toFixed(2)}`;

  document.getElementById("kpiMarginLevel").textContent = m.marginLevelAtFloor === Infinity ? "∞ (No Margin)" : `${m.marginLevelAtFloor.toFixed(0)}%`;
  document.getElementById("kpiStopOutPrice").textContent = `Stop Out Price: ${m.stopOutPrice <= 0 ? "ไม่มี (≤ 0)" : fmtPrice(m.stopOutPrice, p.decimals)}`;

  document.getElementById("kpiMonthlyCF").textContent = `${fmtUsdShort(m.monthlyCF)} / mo`;
  document.getElementById("kpiTrueAlpha").textContent = `คืนทุน (True Alpha): ${m.monthsToTrueAlpha.toFixed(1)} เดือน`;

  document.getElementById("kpiPipValue").textContent = fmtUsdShort(m.pipValue);
  document.getElementById("kpiUsedMargin").textContent = `Max Used Margin: ${fmtUsdShort(m.totalUsedMargin)}`;
  document.getElementById("modeBadge").textContent = `${p.isCent ? "Cent (USC)" : "Standard"} • ${p.gridModel === "CS2" ? "CS2 (γ=" + p.cs2Gamma + ")" : "Linear"}`;
  document.getElementById("tableSummary").textContent = `${p.numZones} โซน`;

  const tbody = document.querySelector("#zoneTable tbody");
  tbody.innerHTML = "";
  for (const z of m.zones) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>A${z.index}</td>
      <td>${fmtPrice(z.entry, p.decimals)}</td>
      <td>${fmtPrice(z.tp, p.decimals)}</td>
      <td>${z.lotSize.toFixed(2)}</td>
      <td>${fmtUsdShort(z.bulletBuffer)}</td>
      <td>${fmtUsdShort(z.usedMargin)}</td>
      <td>${fmtUsdShort(z.ddAtEntry)}</td>
      <td style="color:${z.equityAtEntry > m.stopOutEquity ? "#10b981" : "#ef4444"}">${fmtUsdShort(z.equityAtEntry)}</td>
    `;
    tbody.appendChild(tr);
  }

  renderCharts(p, m);
}

function renderCharts(p, m) {
  if (typeof Chart === "undefined") return;

  const ctx1 = document.getElementById("drawdownChart").getContext("2d");
  if (drawdownChart) drawdownChart.destroy();
  drawdownChart = new Chart(ctx1, {
    type: "line",
    data: {
      labels: m.simPrices,
      datasets: [
        {
          label: "Equity ($)",
          data: m.simEquities,
          borderColor: "#38bdf8",
          backgroundColor: "rgba(56, 189, 248, 0.14)",
          fill: true,
          tension: 0.25,
        },
        {
          label: "Floating Drawdown ($)",
          data: m.simFloatingDD,
          borderColor: "#f59e0b",
          borderDash: [5, 4],
          fill: false,
          tension: 0.25,
        },
        {
          label: `Stop Out Threshold (${p.stopOutPct}%)`,
          data: m.simStopOutLine,
          borderColor: "#ef4444",
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cbd5e1", font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 8 }, grid: { color: "rgba(38,49,71,0.4)" } },
        y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(38,49,71,0.4)" } },
      },
    },
  });

  const ctx2 = document.getElementById("marginChart").getContext("2d");
  if (marginChart) marginChart.destroy();
  marginChart = new Chart(ctx2, {
    type: "line",
    data: {
      labels: m.simPrices,
      datasets: [
        {
          label: "Margin Level (%)",
          data: m.simMarginLevels,
          borderColor: "#10b981",
          backgroundColor: "rgba(16, 185, 129, 0.12)",
          fill: true,
          tension: 0.25,
        },
        {
          label: `เกณฑ์ Stop Out (${p.stopOutPct}%)`,
          data: m.simPrices.map(() => p.stopOutPct),
          borderColor: "#ef4444",
          borderDash: [4, 4],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cbd5e1", font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 8 }, grid: { color: "rgba(38,49,71,0.4)" } },
        y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(38,49,71,0.4)" } },
      },
    },
  });
}

els.preset.addEventListener("change", () => {
  const pr = PRESETS[els.preset.value];
  if (!pr) return;
  els.capital.value = els.accountMode.value === "CENT" ? Math.round(pr.capital / 100) : pr.capital;
  els.contractSize.value = pr.contractSize;
  els.upperPrice.value = pr.upper;
  els.lowerPrice.value = pr.lower;
  els.floorPrice.value = pr.floor;
  els.numZones.value = pr.zones;
  els.lotSize.value = pr.lot;
  els.leverage.value = pr.leverage;
  els.tpDistance.value = pr.tp;
  updateUI();
});

els.accountMode.addEventListener("change", () => {
  const curCap = parseFloat(els.capital.value) || 0;
  if (els.accountMode.value === "CENT" && curCap >= 5000) {
    els.capital.value = Math.round(curCap / 100);
  } else if (els.accountMode.value === "STANDARD" && curCap <= 500) {
    els.capital.value = Math.round(curCap * 100);
  }
  updateUI();
});

els.btnAutoLot.addEventListener("click", () => {
  const p = getParams();
  const baseLot = p.lotSize;
  // Temporarily compute model with current baseLot and scale linearly
  const mCur = computeModel(p);
  const totalCostCur = mCur.totalBufferToFloor + mCur.stopOutEquity;
  const scaleFactor = (p.capital * 0.94) / Math.max(1e-6, totalCostCur);
  const safeLot = Math.max(0.01, Math.floor(baseLot * scaleFactor * 100) / 100);
  els.lotSize.value = safeLot.toFixed(2);
  updateUI();
});

els.btnExportCsv.addEventListener("click", () => {
  const p = getParams();
  let csv = "Zone,Entry_Price,TP_Price,Lot_Size,Buffer_To_Floor_USD,Used_Margin_USD,Cumulative_DD_USD,Equity_At_Entry_USD\n";
  for (const z of lastZonesData) {
    csv += `A${z.index},${z.entry.toFixed(p.decimals)},${z.tp.toFixed(p.decimals)},${z.lotSize.toFixed(2)},${z.bulletBuffer.toFixed(2)},${z.usedMargin.toFixed(2)},${z.ddAtEntry.toFixed(2)},${z.equityAtEntry.toFixed(2)}\n`;
  }
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `CloseSystem_${p.presetKey}_${p.accountMode}_${p.gridModel}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

Object.values(els).forEach((el) => {
  if (el && (el.tagName === "INPUT" || el.tagName === "SELECT")) {
    el.addEventListener("input", updateUI);
    el.addEventListener("change", updateUI);
  }
});

updateUI();
