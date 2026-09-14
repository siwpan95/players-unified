'use strict';

const DEFAULT_BACKEND = 'http://127.0.0.1:5000';

const input = document.getElementById('backendUrl');
const saveBtn = document.getElementById('saveBtn');
const testBtn = document.getElementById('testBtn');
const resetBtn = document.getElementById('resetBtn');
const statusEl = document.getElementById('status');

let statusTimer = null;

function showStatus(msg, type) {
    const cls = (type === 'ok' || type === 'err' || type === 'info') ? type : (type ? 'ok' : 'err');
    statusEl.className = 'status ' + cls;
    statusEl.textContent = msg;
    statusEl.hidden = false;
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusEl.hidden = true; }, 2500);
}

function isValidUrl(v) {
    try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (e) {
        return false;
    }
}

function load() {
    chrome.storage.sync.get({ backendUrl: DEFAULT_BACKEND }, (items) => {
        input.value = items.backendUrl || '';
    });
}

function save() {
    const v = input.value.trim();
    if (v && !isValidUrl(v)) {
        showStatus('地址格式无效，需以 http:// 或 https:// 开头', 'err');
        return;
    }
    chrome.storage.sync.set({ backendUrl: v }, () => {
        showStatus(v ? '已保存：' + v : '已保存（使用本地打包媒体）', 'ok');
    });
}

// 测试连接：直接探测输入框当前地址的 /api/list，与是否保存无关
async function testConnection() {
    const v = input.value.trim();
    if (!v) {
        showStatus('请先填写后端地址再测试', 'err');
        return;
    }
    if (!isValidUrl(v)) {
        showStatus('地址格式无效，需以 http:// 或 https:// 开头', 'err');
        return;
    }
    showStatus('正在测试连接…', 'info');
    try {
        const res = await fetch(v.replace(/\/$/, '') + '/api/list', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        const n = Array.isArray(data) ? data.length : (Array.isArray(data.files) ? data.files.length : 0);
        showStatus('连接成功，清单返回 ' + n + ' 个媒体', 'ok');
    } catch (e) {
        showStatus('连接失败：' + e.message, 'err');
    }
}

function reset() {
    input.value = DEFAULT_BACKEND;
    chrome.storage.sync.set({ backendUrl: DEFAULT_BACKEND }, () => {
        showStatus('已恢复默认：' + DEFAULT_BACKEND, 'ok');
    });
}

saveBtn.addEventListener('click', save);
testBtn.addEventListener('click', testConnection);
resetBtn.addEventListener('click', reset);
load();
