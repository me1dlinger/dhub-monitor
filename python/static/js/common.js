/* Shared UI toolkit: auth flow, API helper, toasts, modal, formatting. */
(function () {
    'use strict';

    var TOKEN_KEY = 'dhm-token';
    var THEME_KEY = 'dhm-theme';

    var body = document.body;
    var authEnabled = body.dataset.authEnabled === 'true';
    var defaultDays = parseInt(body.dataset.defaultDays, 10) || 14;

    function el(id) {
        return document.getElementById(id);
    }

    /* ------------------------------------------------------------- storage */
    function storageGet(key) {
        try { return window.localStorage.getItem(key); } catch (e) { return null; }
    }
    function storageSet(key, value) {
        try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
    }
    function storageRemove(key) {
        try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }

    function getToken() { return storageGet(TOKEN_KEY); }
    function setToken(token) { storageSet(TOKEN_KEY, token); }
    function clearToken() { storageRemove(TOKEN_KEY); }

    /* ----------------------------------------------------------------- api */
    async function api(path, options) {
        options = options || {};
        var headers = Object.assign({}, options.headers || {});
        var token = getToken();
        if (token) headers['Authorization'] = 'Bearer ' + token;
        if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        var response = await fetch(path, Object.assign({}, options, { headers: headers }));
        var text = await response.text();
        var data = null;
        if (text) {
            try { data = JSON.parse(text); } catch (e) { data = null; }
        }

        if (response.status === 401 && authEnabled) {
            clearToken();
            showLogin();
            var authError = new Error('未授权');
            authError.status = 401;
            throw authError;
        }
        if (!response.ok) {
            var message = (data && (data.message || data.error)) || ('请求失败 (' + response.status + ')');
            var error = new Error(message);
            error.status = response.status;
            error.data = data;
            throw error;
        }
        return data;
    }

    function json(value) { return JSON.stringify(value); }

    /* -------------------------------------------------------------- screens */
    function showBoot() {
        el('boot').classList.remove('hidden');
        el('auth').classList.add('hidden');
        el('app').classList.add('hidden');
    }

    function showLogin() {
        el('boot').classList.add('hidden');
        el('app').classList.add('hidden');
        el('auth').classList.remove('hidden');
        var input = el('authKey');
        if (input) setTimeout(function () { input.focus(); }, 70);
    }

    function showApp() {
        el('boot').classList.add('hidden');
        el('auth').classList.add('hidden');
        el('app').classList.remove('hidden');
        document.dispatchEvent(new CustomEvent('app:ready'));
    }

    async function verifyToken(token) {
        try {
            var response = await fetch('/api/auth/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: json({ token: token })
            });
            return response.ok;
        } catch (e) {
            return false;
        }
    }

    async function initAuth() {
        if (!authEnabled) {
            showApp();
            return;
        }
        var token = getToken();
        if (!token) {
            showLogin();
            return;
        }
        if (await verifyToken(token)) {
            showApp();
        } else {
            clearToken();
            showLogin();
        }
    }

    function bindLogin() {
        var form = el('authForm');
        if (!form) return;

        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            var input = el('authKey');
            var button = el('authSubmit');
            var errorBox = el('authError');
            var key = (input.value || '').trim();
            errorBox.classList.remove('is-visible');
            if (!key) return;

            button.disabled = true;
            var original = button.textContent;
            button.innerHTML = '<span class="spin"></span>验证中';

            try {
                var response = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: json({ key: key })
                });
                var data = await response.json().catch(function () { return {}; });
                if (response.ok && data.token) {
                    setToken(data.token);
                    window.location.reload();
                    return;
                }
                errorBox.textContent = response.status === 429
                    ? '尝试次数过多，请稍后再试'
                    : '密钥错误，请重试';
                errorBox.classList.add('is-visible');
            } catch (e) {
                errorBox.textContent = '连接失败，请检查网络';
                errorBox.classList.add('is-visible');
            } finally {
                button.disabled = false;
                button.textContent = original;
            }
        });
    }

    /* --------------------------------------------------------------- theme */
    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    }

    function applyTheme(theme) {
        var next = theme === 'dark' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', next);
        storageSet(THEME_KEY, next);
        document.dispatchEvent(new CustomEvent('theme:change', { detail: { theme: next } }));
    }

    function bindTheme() {
        var button = el('themeToggle');
        if (!button) return;
        button.addEventListener('click', function () {
            applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
        });
    }

    /* --------------------------------------------------------------- toast */
    function toast(message, type) {
        var wrap = el('toasts');
        if (!wrap) return;
        var node = document.createElement('div');
        node.className = 'toast toast--' + (type || 'info');
        node.setAttribute('role', 'status');
        var dot = document.createElement('span');
        dot.className = 'toast__dot';
        var text = document.createElement('span');
        text.textContent = message;
        node.appendChild(dot);
        node.appendChild(text);
        wrap.appendChild(node);
        requestAnimationFrame(function () { node.classList.add('is-visible'); });
        setTimeout(function () {
            node.classList.remove('is-visible');
            setTimeout(function () { node.remove(); }, 280);
        }, 3400);
    }

    /* -------------------------------------------------------------- confirm */
    function confirmDialog(options) {
        options = options || {};
        return new Promise(function (resolve) {
            var root = el('modalRoot');
            root.innerHTML = '';

            var backdrop = document.createElement('div');
            backdrop.className = 'modal-backdrop';

            var box = document.createElement('div');
            box.className = 'modal';
            box.setAttribute('role', 'dialog');
            box.setAttribute('aria-modal', 'true');

            var title = document.createElement('h3');
            title.className = 'modal__title';
            title.textContent = options.title || '确认操作';

            var actions = document.createElement('div');
            actions.className = 'modal__actions';

            var cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'btn';
            cancel.textContent = options.cancelText || '取消';

            var confirm = document.createElement('button');
            confirm.type = 'button';
            confirm.className = 'btn ' + (options.danger ? 'btn--danger' : 'btn--primary');
            confirm.textContent = options.confirmText || '确认';

            actions.appendChild(cancel);
            actions.appendChild(confirm);
            box.appendChild(title);
            if (options.message) {
                var text = document.createElement('p');
                text.className = 'modal__text';
                text.textContent = options.message;
                box.appendChild(text);
            }
            box.appendChild(actions);
            root.appendChild(backdrop);
            root.appendChild(box);
            root.classList.add('is-open');

            function onKey(event) {
                if (event.key === 'Escape') close(false);
            }
            function close(result) {
                root.classList.remove('is-open');
                root.innerHTML = '';
                document.removeEventListener('keydown', onKey);
                resolve(result);
            }

            cancel.addEventListener('click', function () { close(false); });
            confirm.addEventListener('click', function () { close(true); });
            backdrop.addEventListener('click', function () { close(false); });
            document.addEventListener('keydown', onKey);
            setTimeout(function () { confirm.focus(); }, 40);
        });
    }

    /* ---------------------------------------------------------- formatting */
    function parseDate(value) {
        if (!value) return null;
        var text = String(value);
        var date = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(text + 'T00:00:00') : new Date(text);
        return isNaN(date.getTime()) ? null : date;
    }

    function formatNumber(value) {
        if (value === null || value === undefined || value === '') return '--';
        var number = Number(value);
        return isNaN(number) ? String(value) : number.toLocaleString('zh-CN');
    }

    function formatCompact(value) {
        var number = Number(value) || 0;
        var abs = Math.abs(number);
        if (abs >= 1e8) return (number / 1e8).toFixed(2).replace(/\.?0+$/, '') + ' 亿';
        if (abs >= 1e4) return (number / 1e4).toFixed(2).replace(/\.?0+$/, '') + ' 万';
        return number.toLocaleString('zh-CN');
    }

    function formatDate(value) {
        var date = parseDate(value);
        if (!date) return '--';
        return (date.getMonth() + 1) + '月' + date.getDate() + '日';
    }

    function pad(number) {
        return String(number).padStart(2, '0');
    }

    function formatDateTime(value) {
        var date = parseDate(value);
        if (!date) return '--';
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
            + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    function formatRelative(value) {
        var date = parseDate(value);
        if (!date) return '--';
        var seconds = Math.round((Date.now() - date.getTime()) / 1000);
        if (seconds < 0) seconds = 0;
        if (seconds < 60) return '刚刚';
        var minutes = Math.round(seconds / 60);
        if (minutes < 60) return minutes + ' 分钟前';
        var hours = Math.round(minutes / 60);
        if (hours < 24) return hours + ' 小时前';
        return Math.round(hours / 24) + ' 天前';
    }

    function formatDuration(ms) {
        var value = Number(ms) || 0;
        if (value < 1000) return value + ' ms';
        return (value / 1000).toFixed(value < 10000 ? 1 : 0) + ' s';
    }

    function escapeHtml(value) {
        return String(value === null || value === undefined ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function prefersReducedMotion() {
        return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    function countUp(node, target, options) {
        options = options || {};
        var value = Number(target) || 0;
        if (prefersReducedMotion()) {
            node.textContent = formatNumber(value);
            return;
        }
        var duration = options.duration || 720;
        var started = performance.now();
        function frame(now) {
            var progress = Math.min(1, (now - started) / duration);
            var eased = 1 - Math.pow(1 - progress, 3);
            node.textContent = formatNumber(Math.round(value * eased));
            if (progress < 1) requestAnimationFrame(frame);
        }
        requestAnimationFrame(frame);
    }

    function statusMeta(status) {
        switch (status) {
            case 'success': return { label: '成功', cls: 'badge--success' };
            case 'partial': return { label: '部分成功', cls: 'badge--warning' };
            case 'failed': return { label: '失败', cls: 'badge--danger' };
            case 'running': return { label: '运行中', cls: 'badge--accent' };
            default: return { label: status || '未知', cls: '' };
        }
    }

    /* ------------------------------------------------------------ bootstrap */
    document.addEventListener('DOMContentLoaded', function () {
        bindTheme();
        bindLogin();
        initAuth();
    });

    window.Dhm = {
        api: api,
        json: json,
        getToken: getToken,
        setToken: setToken,
        clearToken: clearToken,
        authEnabled: authEnabled,
        defaultDays: defaultDays,
        showLogin: showLogin,
        toast: toast,
        confirmDialog: confirmDialog,
        formatNumber: formatNumber,
        formatCompact: formatCompact,
        formatDate: formatDate,
        formatDateTime: formatDateTime,
        formatRelative: formatRelative,
        formatDuration: formatDuration,
        escapeHtml: escapeHtml,
        countUp: countUp,
        currentTheme: currentTheme,
        applyTheme: applyTheme,
        statusMeta: statusMeta,
        prefersReducedMotion: prefersReducedMotion,
        el: el
    };
})();
