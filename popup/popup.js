// popup/popup.js — GEO Analyzer by TripleDart

const CATEGORY_META = {
  content:        { label: 'Content Quality & Depth',      color: '#3b82f6', icon: '📝' },
  eeat:           { label: 'E-E-A-T Signals',              color: '#f59e0b', icon: '🏛️' },
  schema:         { label: 'Structured Data & Markup',     color: '#10b981', icon: '🔧' },
  formatting:     { label: 'Formatting & Scannability',    color: '#ef4444', icon: '📋' },
  conversational: { label: 'Conversational & AI-Friendly', color: '#8b5cf6', icon: '💬' },
  technical:      { label: 'Technical & Freshness',        color: '#06b6d4', icon: '⚡' }
};

const SHEET_TAB = 'Summary';
const RULES_TAB = 'Rule Details';


function buildSheetTitle(url) {
  const hostname = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'page'; } })();
  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `GEO — ${hostname} — ${date} ${time}`;
}

let lastResult = null;
let currentTab = null;
let storedSheetId = null;

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  currentTab = await getCurrentTab();
  const { geoSheetId: savedId } = await chrome.storage.local.get('geoSheetId');
  storedSheetId = savedId || null;

  // Show page URL in bar
  if (currentTab?.url) {
    try {
      const u = new URL(currentTab.url);
      document.getElementById('page-bar').textContent = u.hostname + u.pathname;
    } catch (_) {
      document.getElementById('page-bar').textContent = currentTab.url || '—';
    }
  }

  // Render Google sign-in status
  await refreshGoogleStatus();

  // Auto-load cached result if available
  if (currentTab?.url) {
    const cacheKey = `geo_cache_${currentTab.url}`;
    const cached = await chrome.storage.local.get(cacheKey);
    const entry = cached[cacheKey];
    if (entry && Date.now() - entry.timestamp < 30 * 60 * 1000) {
      showResults({ ...entry.result, fromCache: true });
      return;
    }
  }
});

// ── Analyze button ────────────────────────────────────────────────────────────
document.getElementById('btn-analyze').addEventListener('click', runAnalysis);

// ── Re-analyze (clear cache) ──────────────────────────────────────────────────
document.getElementById('btn-reanalyze').addEventListener('click', async () => {
  if (currentTab?.url) await chrome.storage.local.remove(`geo_cache_${currentTab.url}`);
  runAnalysis();
});

// ── Copy report ───────────────────────────────────────────────────────────────
document.getElementById('btn-copy').addEventListener('click', copyReport);

// ── Export to Google Sheets ───────────────────────────────────────────────────
document.getElementById('btn-export').addEventListener('click', exportToSheets);

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// ── Core analysis ─────────────────────────────────────────────────────────────
async function runAnalysis() {
  setEl('state-error', true);
  setEl('state-results', true);
  setEl('state-loading', false);
  setBtnAnalyze(true);

  try {
    if (!currentTab?.id) throw new Error('Could not get active tab');

    // Inject content script (no-op if already injected)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        files: ['content/content.js']
      });
    } catch (_) {}

    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: 'ANALYZE_TAB', tabId: currentTab.id, url: currentTab.url },
        response => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response?.success) return reject(new Error(response?.error || 'Analysis failed'));
          resolve(response.result);
        }
      );
    });

    lastResult = result;
    showResults(result);
  } catch (err) {
    showError(err.message);
  } finally {
    setEl('state-loading', true);
    setBtnAnalyze(false);
  }
}

// ── Render results ────────────────────────────────────────────────────────────
function showResults(result) {
  const { score, ruleResults, pageData, fromCache, analyzedAt } = result;
  lastResult = result;

  setEl('state-loading', true);
  setEl('state-error', true);
  setEl('state-results', false);

  // Show persistent "Open Sheet" link if a spreadsheet was previously created
  const exportStatusEl = document.getElementById('export-status');
  const sheetLinkEl = document.getElementById('sheet-link');
  const statusTextEl = document.getElementById('export-status-text');
  if (storedSheetId) {
    exportStatusEl.className = 'export-status';
    exportStatusEl.classList.remove('hidden');
    statusTextEl.textContent = '';
    sheetLinkEl.href = `https://docs.google.com/spreadsheets/d/${storedSheetId}`;
    sheetLinkEl.classList.remove('hidden');
  } else {
    exportStatusEl.classList.add('hidden');
    sheetLinkEl.classList.add('hidden');
  }

  // Score ring
  const offset = 314 - (score.total / 100) * 314;
  const ring = document.getElementById('ring-fill');
  ring.style.strokeDashoffset = offset;
  ring.style.stroke = score.gradeColor;

  const numEl = document.getElementById('score-number');
  numEl.textContent = score.total;
  numEl.style.color = score.gradeColor;
  document.getElementById('score-grade').textContent = `Grade ${score.grade}`;

  document.getElementById('score-pts').textContent = `${score.totalEarned} / ${score.totalPossible} pts`;

  const cacheEl = document.getElementById('score-cache');
  if (fromCache && analyzedAt) {
    const mins = Math.round((Date.now() - analyzedAt) / 60000);
    cacheEl.textContent = `Cached ${mins < 1 ? 'just now' : mins + 'm ago'}`;
  } else {
    cacheEl.textContent = 'Just analyzed';
  }

  // Category bars
  const barsEl = document.getElementById('category-bars');
  barsEl.innerHTML = '';
  Object.entries(CATEGORY_META).forEach(([key, meta]) => {
    const cat = score.byCategory[key];
    if (!cat) return;
    const pct = Math.round((cat.earned / cat.possible) * 100);
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `
      <div class="cat-row-top">
        <span class="cat-label">${meta.icon} ${meta.label}</span>
        <span class="cat-pts">${Math.round(cat.earned * 10) / 10}/${cat.possible}</span>
      </div>
      <div class="cat-bar-bg">
        <div class="cat-bar-fill" style="width:${pct}%;background:${meta.color}"></div>
      </div>`;
    barsEl.appendChild(row);
  });

  // Issues list
  const issuesList = document.getElementById('issues-list');
  issuesList.innerHTML = '';
  const issues = score.allIssues || ruleResults.filter(r => r.pass !== true);
  document.getElementById('issues-count').textContent = issues.length;

  if (issues.length === 0) {
    issuesList.innerHTML = `<div style="padding:20px;text-align:center;font-size:28px">🎉<br>
      <span style="font-size:13px;font-weight:600;color:#16a34a">All checks passed!</span></div>`;
  } else {
    issues.forEach(({ rule, pass, detail }) => {
      const isFail = pass === false;
      const priority = rule.points >= 4 ? 'high' : rule.points >= 2 ? 'medium' : 'low';
      const div = document.createElement('div');
      div.className = `gap-item ${priority}`;
      div.innerHTML = `
        <div class="gap-icon">${isFail ? '❌' : '⚠️'}</div>
        <div class="gap-body">
          <div class="gap-name">${escHtml(rule.label)}</div>
          <div class="gap-desc">${escHtml(detail)}</div>
        </div>
        <span class="gap-badge ${isFail ? 'missing' : 'partial'}">${isFail ? 'Missing' : 'Partial'}</span>`;
      issuesList.appendChild(div);
    });
  }

  // Passing list
  const passingList = document.getElementById('passing-list');
  passingList.innerHTML = '';
  const passing = ruleResults.filter(r => r.pass === true);
  document.getElementById('passing-count').textContent = passing.length;

  if (passing.length === 0) {
    passingList.innerHTML = '<div style="padding:16px;text-align:center;color:#9ca3af;font-size:12px">No passing checks yet</div>';
  } else {
    passing.forEach(({ rule, detail }) => {
      const div = document.createElement('div');
      div.className = 'pass-item';
      div.innerHTML = `
        <div class="pass-icon">✅</div>
        <div>
          <div class="pass-name">${escHtml(rule.label)}</div>
          <div class="pass-desc">${escHtml(detail)}</div>
        </div>`;
      passingList.appendChild(div);
    });
  }
}

// ── Google OAuth + Sheets API export ─────────────────────────────────────────

async function getGoogleToken(interactive = true) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, token => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'Sign-in cancelled'));
      } else {
        resolve(token);
      }
    });
  });
}

async function refreshGoogleStatus() {
  const statusEl = document.getElementById('google-status');
  if (!statusEl) return;

  // Try to get a token silently (non-interactive) to check if already signed in
  try {
    const token = await getGoogleToken(false);
    const userInfo = await fetchUserInfo(token);
    renderSignedIn(statusEl, userInfo);
  } catch (_) {
    renderSignedOut(statusEl);
  }
}

function renderSignedOut(container) {
  container.innerHTML = `
    <button class="btn-google-signin" id="btn-google-signin">
      <svg viewBox="0 0 18 18" fill="none">
        <path fill="#fff" d="M17.64 9.2a10.34 10.34 0 00-.16-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92C16.66 14.26 17.64 11.92 17.64 9.2z"/>
        <path fill="#fff" opacity=".7" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26C11.23 14.26 10.17 14.6 9 14.6a5.02 5.02 0 01-4.71-3.47H1.29v2.33A9 9 0 009 18z"/>
        <path fill="#fff" opacity=".5" d="M4.29 11.13A5.04 5.04 0 014.03 9c0-.74.13-1.46.26-2.13V4.54H1.29A9 9 0 000 9c0 1.45.35 2.82.97 4.04l3.32-1.91z"/>
        <path fill="#fff" opacity=".3" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 001.29 4.54L4.6 6.87C5.48 4.37 7.03 3.58 9 3.58z"/>
      </svg>
      Sign in with Google
    </button>`;
  container.querySelector('#btn-google-signin')?.addEventListener('click', async () => {
    if (!isClientIdConfigured()) {
      container.innerHTML = `<span style="color:rgba(255,255,255,0.65);font-size:11px;padding:0 4px">Setup needed — see SETUP_GOOGLE_SHEETS.txt</span>`;
      return;
    }
    try {
      const token = await getGoogleToken(true);
      const userInfo = await fetchUserInfo(token);
      renderSignedIn(container, userInfo);
    } catch (err) {
      console.warn('Sign-in failed:', err.message);
    }
  });
}

function renderSignedIn(container, userInfo) {
  const initial = (userInfo?.name || userInfo?.email || 'G')[0].toUpperCase();
  const displayName = userInfo?.given_name || userInfo?.name?.split(' ')[0] || userInfo?.email?.split('@')[0] || 'Google';
  container.innerHTML = `
    <div class="google-user-pill">
      <div class="user-avatar">${escHtml(initial)}</div>
      <span class="user-name">${escHtml(displayName)}</span>
      <button class="btn-signout" id="btn-signout" title="Sign out">✕</button>
    </div>`;
  container.querySelector('#btn-signout')?.addEventListener('click', async () => {
    try {
      const token = await getGoogleToken(false);
      await new Promise(res => chrome.identity.removeCachedAuthToken({ token }, res));
    } catch (_) {}
    renderSignedOut(container);
  });
}

async function fetchUserInfo(token) {
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error('Could not fetch user info');
  return res.json();
}

function isClientIdConfigured() {
  const manifest = chrome.runtime.getManifest();
  const clientId = manifest.oauth2?.client_id || '';
  return clientId.length > 0 && !clientId.startsWith('YOUR_CLIENT_ID');
}

async function exportToSheets() {
  if (!lastResult) return;

  const exportBtn  = document.getElementById('btn-export');
  const exportBtnText = document.getElementById('export-btn-text');
  const exportStatus = document.getElementById('export-status');
  const statusText = document.getElementById('export-status-text');
  const sheetLink  = document.getElementById('sheet-link');

  exportBtn.disabled = true;
  exportBtnText.textContent = 'Signing in…';
  exportStatus.classList.remove('hidden');
  exportStatus.className = 'export-status';
  statusText.textContent = '';
  sheetLink.classList.add('hidden');

  if (!isClientIdConfigured()) {
    exportStatus.className = 'export-status error';
    statusText.textContent = 'Setup needed — see SETUP_GOOGLE_SHEETS.txt to configure Google OAuth';
    exportBtnText.textContent = 'Export to Sheets';
    exportBtn.disabled = false;
    return;
  }

  try {
    // 1. Get auth token (shows Google sign-in if needed)
    const token = await getGoogleToken(true);
    const userInfo = await fetchUserInfo(token).catch(() => null);
    exportBtnText.textContent = 'Exporting…';
    await refreshGoogleStatus();

    // 2. Always create a fresh spreadsheet for this run
    const { score, ruleResults, pageData } = lastResult;
    const url = pageData.url || currentTab?.url || '';

    const spreadsheetId = await createSpreadsheet(token, buildSheetTitle(url));
    await chrome.storage.local.set({ geoSheetId: spreadsheetId });
    storedSheetId = spreadsheetId;

    // 3. Write summary row + all 36 rule detail rows
    const summaryRow = buildRow(score, ruleResults, pageData, url);
    const ruleRows   = buildRuleRows(score, ruleResults, pageData, url);
    await appendRows(token, spreadsheetId, SHEET_TAB, [summaryRow]);
    await appendRows(token, spreadsheetId, RULES_TAB, ruleRows);

    // 4. Success
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    exportBtnText.textContent = '✓ Exported';
    statusText.textContent = `Saved to Google Sheets${userInfo?.email ? ` (${userInfo.email})` : ''}`;
    sheetLink.href = sheetUrl;
    sheetLink.classList.remove('hidden');

    setTimeout(() => {
      exportBtnText.textContent = 'Export to Sheets';
      exportBtn.disabled = false;
    }, 4000);

  } catch (err) {
    // If token is stale, clear it so next click re-auths
    if (err.message?.includes('invalid') || err.message?.includes('401')) {
      try {
        const t = await getGoogleToken(false);
        await new Promise(res => chrome.identity.removeCachedAuthToken({ token: t }, res));
      } catch (_) {}
    }

    exportStatus.className = 'export-status error';
    statusText.textContent = `Error: ${err.message}`;
    sheetLink.classList.add('hidden');
    exportBtnText.textContent = 'Export to Sheets';
    exportBtn.disabled = false;
  }
}

// ── Sheets API helpers ────────────────────────────────────────────────────────

const HEADERS = [
  'Date', 'URL', 'Page Title', 'GEO Score', 'Grade',
  'Points Earned', 'Points Possible', 'Word Count',
  'Content Earned', 'Content Possible',
  'E-E-A-T Earned', 'E-E-A-T Possible',
  'Structured Data Earned', 'Structured Data Possible',
  'Formatting Earned', 'Formatting Possible',
  'Conv. & AI Earned', 'Conv. & AI Possible',
  'Technical Earned', 'Technical Possible',
  'Issues Count', 'Partial Count', 'Passing Count'
];

const RULE_HEADERS = [
  'Date', 'URL', 'Page Title', 'Category', 'Rule',
  'Status', 'Points Earned', 'Points Possible', 'Detail'
];

function makeHeaderRow(headers) {
  return {
    rowData: [{
      values: headers.map(h => ({
        userEnteredValue: { stringValue: h },
        userEnteredFormat: {
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          backgroundColor: { red: 0.267, green: 0.447, blue: 0.769 }  // #4472C4
        }
      }))
    }]
  };
}

async function createSpreadsheet(token, title) {
  const body = {
    properties: { title },
    sheets: [
      {
        properties: { title: SHEET_TAB, sheetId: 0 },
        data: [makeHeaderRow(HEADERS)]
      },
      {
        properties: { title: RULES_TAB, sheetId: 1 },
        data: [makeHeaderRow(RULE_HEADERS)]
      },
    ]
  };

  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message || `Sheets API error ${res.status}`);
  }

  const data = await res.json();
  await formatSpreadsheet(token, data.spreadsheetId);
  return data.spreadsheetId;
}

async function formatSpreadsheet(token, spreadsheetId) {
  const green  = { red: 0.714, green: 0.843, blue: 0.659 };  // #b6d7a8
  const orange = { red: 1.0,   green: 0.898, blue: 0.600 };  // #ffe599
  const red    = { red: 0.918, green: 0.600, blue: 0.600 };  // #ea9999

  // Conditional formatting applies to all data rows in Rule Details (skip header row 0)
  const rulesDataRange = { sheetId: 1, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 9 };

  const requests = [
    // Freeze header row on both tabs
    { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { updateSheetProperties: { properties: { sheetId: 1, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },

    // Column widths — Summary tab
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 260 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 0, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 220 }, fields: 'pixelSize' } },

    // Column widths — Rule Details tab
    { updateDimensionProperties: { range: { sheetId: 1, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 1, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 260 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 1, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 200 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 1, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 }, properties: { pixelSize: 200 }, fields: 'pixelSize' } },
    { updateDimensionProperties: { range: { sheetId: 1, dimension: 'COLUMNS', startIndex: 8, endIndex: 9 }, properties: { pixelSize: 340 }, fields: 'pixelSize' } },

    // Row color by Status — Pass = green, Partial = orange, Fail = red
    { addConditionalFormatRule: { rule: { ranges: [rulesDataRange], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$F2="Pass"' }] },    format: { backgroundColor: green  } } }, index: 0 } },
    { addConditionalFormatRule: { rule: { ranges: [rulesDataRange], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$F2="Partial"' }] }, format: { backgroundColor: orange } } }, index: 1 } },
    { addConditionalFormatRule: { rule: { ranges: [rulesDataRange], booleanRule: { condition: { type: 'CUSTOM_FORMULA', values: [{ userEnteredValue: '=$F2="Fail"' }] },    format: { backgroundColor: red    } } }, index: 2 } }
  ];

  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests })
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.warn('Sheet formatting failed:', err.error?.message);
  }
}

async function appendRows(token, spreadsheetId, tab, rows) {
  const range = `${tab}!A1`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: rows })
    }
  );

  if (res.status === 401 || res.status === 403 || res.status === 404) {
    await chrome.storage.local.remove('geoSheetId');
    storedSheetId = null;
    throw new Error('SHEET_GONE');
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const msg = err.error?.message || `Append failed (${res.status})`;
    if (msg.toLowerCase().includes('parse range') || msg.toLowerCase().includes('unable to parse')) {
      await chrome.storage.local.remove('geoSheetId');
      storedSheetId = null;
      throw new Error('SHEET_GONE');
    }
    throw new Error(msg);
  }
}

function buildRow(score, ruleResults, pageData, url) {
  const catCols = Object.entries(CATEGORY_META).flatMap(([key]) => {
    const cat = score.byCategory[key];
    return cat
      ? [Math.round(cat.earned * 10) / 10, cat.possible]
      : [0, 0];
  });

  const issuesCount   = (score.allIssues || []).filter(r => r.pass === false).length;
  const partialCount  = (score.allIssues || []).filter(r => r.pass === 'partial').length;
  const passingCount  = ruleResults.filter(r => r.pass === true).length;

  return [
    new Date().toLocaleString(),
    url,
    pageData.title || '',
    score.total,
    score.grade,
    score.totalEarned,
    score.totalPossible,
    pageData.wordCount || 0,
    ...catCols,
    issuesCount,
    partialCount,
    passingCount
  ];
}

function buildRuleRows(score, ruleResults, pageData, url) {
  const date  = new Date().toLocaleString();
  const title = pageData.title || '';

  return ruleResults.map(({ rule, pass, detail }) => {
    const categoryLabel = CATEGORY_META[rule.category]?.label || rule.category;
    const statusLabel   = pass === true ? 'Pass' : pass === 'partial' ? 'Partial' : 'Fail';
    const earned        = pass === true ? rule.points : pass === 'partial' ? Math.round(rule.points * 0.5 * 10) / 10 : 0;

    return [date, url, title, categoryLabel, rule.label, statusLabel, earned, rule.points, detail || ''];
  });
}

// ── Copy report ───────────────────────────────────────────────────────────────
async function copyReport() {
  if (!lastResult) return;
  const { score, ruleResults, pageData } = lastResult;
  const url = pageData.url || currentTab?.url || '';

  const lines = [
    `GEO Analysis Report — by TripleDart`,
    `URL: ${url}`,
    `Score: ${score.total}/100 (Grade ${score.grade}) — ${score.totalEarned}/${score.totalPossible} pts`,
    `Date: ${new Date().toLocaleString()}`,
    '',
    `─── ISSUES (${(score.allIssues || []).length}) ───`,
    ...(score.allIssues || []).map(({ rule, pass, detail }) =>
      `[${pass === false ? 'MISSING' : 'PARTIAL'}] ${rule.label}\n  ${detail}`
    ),
    '',
    `─── PASSING (${ruleResults.filter(r => r.pass === true).length}) ───`,
    ...ruleResults.filter(r => r.pass === true).map(({ rule, detail }) =>
      `[PASS] ${rule.label}\n  ${detail}`
    ),
    '',
    'Generated by GEO Analyzer (slatehq.com)'
  ];

  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    const btn = document.getElementById('btn-copy');
    const orig = btn.innerHTML;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.innerHTML = orig; }, 2000);
  } catch (_) {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showError(msg) {
  setEl('state-loading', true);
  setEl('state-results', true);
  setEl('state-error', false);
  document.getElementById('errorText').textContent =
    msg || 'Could not analyze this page. Try refreshing and clicking Analyze again.';
}

function setEl(id, hidden) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('hidden', hidden);
}

function setBtnAnalyze(loading) {
  const btn = document.getElementById('btn-analyze');
  btn.disabled = loading;
  btn.innerHTML = loading
    ? `<svg style="animation:spin .7s linear infinite" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="8" stroke-opacity=".3"/><path d="M10 2a8 8 0 018 8" stroke-linecap="round"/></svg> Analyzing…`
    : `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 3a1 1 0 012 0v.26c2.83.46 5 2.94 5 5.74a6 6 0 01-6 6 6 6 0 01-6-6c0-2.8 2.17-5.28 5-5.74V3zM10 16a4 4 0 004-4 4 4 0 00-4-4 4 4 0 00-4 4 4 4 0 004 4z"/></svg> Analyze Page`;
}

function getCurrentTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs[0]));
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
