/* Refresh logs: summary strip and expandable execution records. */
(function () {
    'use strict';

    var ICONS = {
        runs: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h6"/></svg>',
        rate: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 1 0-9-9"/><path d="M12 12l4-3"/></svg>',
        clock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
        none: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h6"/></svg>'
    };

    function statCard(options) {
        var card = document.createElement('div');
        card.className = 'card stat reveal';
        if (options.tint) card.classList.add('stat--' + options.tint);
        card.style.setProperty('--delay', (options.delay || 0) + 'ms');
        card.innerHTML =
            '<div class="stat__top"><span class="stat__label">' + Dhm.escapeHtml(options.label) + '</span>'
            + '<span class="stat__icon">' + options.icon + '</span></div>'
            + '<div class="stat__value' + (options.compact ? ' stat__value--md' : '') + '">--</div>'
            + '<div class="stat__meta">' + (options.metaHtml || Dhm.escapeHtml(options.meta || '')) + '</div>';
        var valueNode = card.querySelector('.stat__value');
        if (typeof options.value === 'number') Dhm.countUp(valueNode, options.value);
        else valueNode.textContent = options.value == null ? '--' : options.value;
        return card;
    }

    function renderStats(logs) {
        var wrap = Dhm.el('logStats');
        wrap.innerHTML = '';
        var total = logs.length;
        var success = logs.filter(function (log) { return log.status === 'success'; }).length;
        var rate = total ? Math.round((success / total) * 100) : 0;
        var last = logs[0] ? logs[0].started_at : null;

        wrap.appendChild(statCard({
            label: '记录条数', value: total, icon: ICONS.runs, delay: 0,
            tint: 'blue', meta: '最多显示最近 200 条'
        }));
        wrap.appendChild(statCard({
            label: '完全成功率', value: rate, icon: ICONS.rate, delay: 60,
            tint: 'teal', compact: true, meta: '成功 ' + success + ' / ' + total + ' 次'
        }));
        wrap.appendChild(statCard({
            label: '最近刷新', value: last ? Dhm.formatRelative(last) : '--', icon: ICONS.clock, delay: 120,
            tint: 'amber', compact: true, metaHtml: '<span>' + Dhm.escapeHtml(last ? Dhm.formatDateTime(last) : '暂无记录') + '</span>'
        }));
    }

    function parseDetails(log) {
        if (!log.details) return null;
        try {
            var parsed = JSON.parse(log.details);
            return Array.isArray(parsed) ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    function detailsHtml(results) {
        if (!results || !results.length) {
            return '<div class="empty" style="padding:16px"><div class="empty__title">无详细记录</div></div>';
        }
        var html = '<div class="log-details__grid">';
        results.forEach(function (item) {
            var ok = item.success;
            var note = ok
                ? '拉取 ' + Dhm.formatNumber(item.pulls_total) + ' · 日均 ' + Dhm.formatNumber(item.pulls_per_day)
                : (item.error === 'not_found' ? '仓库不存在' : (item.error || '失败'));
            html += '<div class="log-details__item">'
                + '<span class="log-details__name" title="' + Dhm.escapeHtml(item.image) + '">' + Dhm.escapeHtml(item.image) + '</span>'
                + '<span class="log-details__note ' + (ok ? 'log-details__note--ok' : 'log-details__note--err') + '">' + Dhm.escapeHtml(note) + '</span>'
                + '</div>';
        });
        html += '</div>';
        return html;
    }

    function rowHtml(log, index) {
        var meta = Dhm.statusMeta(log.status);
        var results = parseDetails(log);
        var hasDetails = results && results.length;
        var details = '<div class="log-details" data-details="' + index + '">' + detailsHtml(results) + '</div>';

        return '<tr class="log-row" data-index="' + index + '"' + (hasDetails ? ' style="cursor:pointer"' : '') + '>'
            + '<td class="nowrap">' + Dhm.escapeHtml(Dhm.formatDateTime(log.started_at)) + '</td>'
            + '<td><span class="badge">' + Dhm.escapeHtml(log.source || '-') + '</span></td>'
            + '<td><span class="badge ' + meta.cls + '">' + Dhm.escapeHtml(meta.label) + '</span></td>'
            + '<td class="cell-num text-right">' + (log.total_images || 0) + '</td>'
            + '<td class="cell-num text-right">' + (log.success_count || 0) + '</td>'
            + '<td class="cell-num text-right">' + (log.fail_count || 0) + '</td>'
            + '<td class="cell-num text-right nowrap">' + Dhm.escapeHtml(Dhm.formatDuration(log.duration_ms)) + '</td>'
            + '<td class="text-right">' + (hasDetails ? '<button type="button" class="btn btn--sm btn--ghost" data-action="toggle">展开</button>' : '<span class="faint">--</span>') + '</td>'
            + '</tr>'
            + '<tr class="log-detail-row" data-detail-row="' + index + '" style="display:none">'
            + '<td colspan="8" style="padding:0">' + details + '</td></tr>';
    }

    function render(logs) {
        renderStats(logs);
        var body = Dhm.el('logsBody');
        if (!logs.length) {
            body.innerHTML = '<tr><td colspan="8"><div class="empty">'
                + '<div class="empty__mark">' + ICONS.none + '</div>'
                + '<div class="empty__title">暂无刷新记录</div>'
                + '<div class="empty__desc">调度进程会在启动后自动执行首次采集。</div></div></td></tr>';
            return;
        }
        body.innerHTML = logs.map(rowHtml).join('');
    }

    function toggle(index) {
        var detailRow = document.querySelector('tr[data-detail-row="' + index + '"]');
        var mainRow = document.querySelector('tr.log-row[data-index="' + index + '"]');
        if (!detailRow || !mainRow) return;
        var open = detailRow.style.display !== 'none';
        detailRow.style.display = open ? 'none' : 'table-row';
        // The panel keeps its own visibility flag: the wrapper row alone is not
        // enough because `.log-details` is display:none until `.is-open`.
        var panel = detailRow.querySelector('.log-details');
        if (panel) panel.classList.toggle('is-open', !open);
        mainRow.classList.toggle('is-open', !open);
        var button = mainRow.querySelector('button[data-action="toggle"]');
        if (button) button.textContent = open ? '展开' : '收起';
    }

    async function load() {
        var body = Dhm.el('logsBody');
        body.innerHTML = '<tr><td colspan="8"><div class="skeleton" style="height:120px"></div></td></tr>';
        try {
            var logs = await Dhm.api('/api/logs?limit=100');
            render(logs);
        } catch (e) {
            if (e.status === 401) return;
            body.innerHTML = '<tr><td colspan="8"><div class="empty"><div class="empty__title">'
                + Dhm.escapeHtml(e.message || '加载失败') + '</div></div></td></tr>';
        }
    }

    document.addEventListener('app:ready', function () {
        Dhm.el('reloadLogs').addEventListener('click', load);
        Dhm.el('logsBody').addEventListener('click', function (event) {
            var row = event.target.closest('tr.log-row');
            if (!row) return;
            toggle(row.dataset.index);
        });
        load();
    });
})();
