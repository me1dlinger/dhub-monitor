/* Dashboard: overview + per-image detail, powered by ApexCharts. */
(function () {
    'use strict';

    var PALETTE = [
        '#4f7cf0', '#2fb3a3', '#e9a94e', '#e781a3', '#8f86e0',
        '#3fa9d0', '#7db56a', '#e88f5f', '#5aa9e6', '#b07cc6'
    ];

    var ICONS = {
        layers: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>',
        trend: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
        box: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 21v-8"/></svg>',
        clock: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
        empty: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/></svg>'
    };

    var state = {
        days: Dhm.defaultDays,
        view: 'overall',
        data: null,
        charts: {},
        totalsScale: 'auto'
    };

    var SCALE_KEY = 'dhm-totals-scale';
    try {
        var storedScale = window.localStorage.getItem(SCALE_KEY);
        if (storedScale === 'linear' || storedScale === 'log' || storedScale === 'auto') {
            state.totalsScale = storedScale;
        }
    } catch (e) { /* storage unavailable */ }

    /* ------------------------------------------------------------- helpers */
    function cssVar(name, fallback) {
        var value = getComputedStyle(document.documentElement).getPropertyValue(name);
        return (value || '').trim() || fallback;
    }

    function palette() {
        return PALETTE.slice();
    }

    function imageColor(images, id) {
        var index = -1;
        for (var i = 0; i < images.length; i++) {
            if (images[i].id === id) { index = i; break; }
        }
        return PALETTE[(index < 0 ? 0 : index) % PALETTE.length];
    }

    function baseChart(extra) {
        var reduced = Dhm.prefersReducedMotion();
        var options = {
            chart: {
                toolbar: { show: false },
                zoom: { enabled: false },
                fontFamily: 'inherit',
                foreColor: cssVar('--text-muted', '#5b6472'),
                background: 'transparent',
                parentHeightOffset: 0,
                animations: {
                    enabled: !reduced,
                    easing: 'easeinout',
                    speed: 620,
                    animateGradually: { enabled: true, delay: 70 }
                }
            },
            theme: { mode: Dhm.currentTheme() },
            colors: palette(),
            grid: {
                borderColor: cssVar('--border', '#dde3ea'),
                strokeDashArray: 0,
                padding: { left: 6, right: 12, top: 0, bottom: 0 }
            },
            dataLabels: { enabled: false },
            tooltip: {
                theme: Dhm.currentTheme(),
                style: { fontSize: '12px', fontFamily: 'inherit' }
            },
            legend: {
                position: 'bottom',
                horizontalAlign: 'left',
                fontSize: '12px',
                fontWeight: 600,
                markers: { width: 9, height: 9, radius: 3 },
                itemMargin: { horizontal: 12, vertical: 5 }
            },
            states: { hover: { filter: { type: 'none' } } }
        };
        return Object.assign(options, extra || {});
    }

    function axisLabels(dates) {
        return dates.map(function (date) { return Dhm.formatDate(date); });
    }

    function destroyCharts() {
        Object.keys(state.charts).forEach(function (key) {
            if (state.charts[key]) state.charts[key].destroy();
        });
        state.charts = {};
    }

    function setChart(key, containerId, options) {
        if (state.charts[key]) state.charts[key].destroy();
        var node = Dhm.el(containerId);
        node.innerHTML = '';
        var chart = new ApexCharts(node, options);
        state.charts[key] = chart;
        chart.render();
    }

    function chartEmpty(key, containerId, text, height) {
        if (state.charts[key]) {
            state.charts[key].destroy();
            delete state.charts[key];
        }
        var node = Dhm.el(containerId);
        if (!node) return;
        node.innerHTML = '<div class="empty" style="min-height:' + (height || 220) + 'px">'
            + '<div class="empty__mark">' + ICONS.empty + '</div>'
            + '<div class="empty__title">' + Dhm.escapeHtml(text) + '</div></div>';
    }

    function unionDates(images) {
        var seen = {};
        images.forEach(function (img) {
            (img.series || []).forEach(function (point) { seen[point.date] = true; });
        });
        return Object.keys(seen).sort();
    }

    function buildSeries(images, dates, key) {
        return images.map(function (img) {
            var map = {};
            (img.series || []).forEach(function (point) { map[point.date] = point[key] || 0; });
            return {
                name: img.display_name,
                data: dates.map(function (date) {
                    return map[date] === undefined ? null : map[date];
                })
            };
        });
    }

    /* Decide whether the cumulative chart needs a logarithmic axis. When the
       largest repository is orders of magnitude bigger than the smallest, a
       linear axis flattens every smaller series into an invisible line. */
    var LOG_SPREAD_RATIO = 10;

    function hasWideSpread(images) {
        var values = images
            .map(function (img) { return (img.latest && img.latest.pulls_total) || 0; })
            .filter(function (value) { return value > 0; });
        if (values.length < 2) return false;
        return Math.max.apply(null, values) / Math.min.apply(null, values) >= LOG_SPREAD_RATIO;
    }

    function logSafe(images) {
        var safe = true;
        images.forEach(function (img) {
            (img.series || []).forEach(function (point) {
                if (point.pulls_total != null && point.pulls_total <= 0) safe = false;
            });
        });
        return safe;
    }

    function totalsScaleMode(images) {
        var requested = (state.totalsScale === 'linear' || state.totalsScale === 'log')
            ? state.totalsScale
            : (hasWideSpread(images) ? 'log' : 'linear');
        // A logarithmic axis is undefined at zero, so fall back when any
        // observed total is non-positive.
        if (requested === 'log' && !logSafe(images)) return 'linear';
        return requested;
    }

    function renderScaleToggle(mode) {
        var seg = Dhm.el('totalsScaleSeg');
        if (!seg) return;
        seg.querySelectorAll('.seg__btn').forEach(function (btn) {
            btn.classList.toggle('is-active', btn.dataset.scale === state.totalsScale);
        });
        seg.title = mode === 'log'
            ? '量级差异较大，当前使用对数刻度'
            : '当前使用线性刻度';
    }

    function statCard(options) {
        var card = document.createElement('div');
        card.className = 'card card--hover stat';
        if (options.tint) card.classList.add('stat--' + options.tint);
        card.style.setProperty('--delay', (options.delay || 0) + 'ms');

        var meta = options.metaHtml
            ? options.metaHtml
            : Dhm.escapeHtml(options.meta || '');

        card.innerHTML =
            '<div class="stat__top"><span class="stat__label">' + Dhm.escapeHtml(options.label) + '</span>'
            + '<span class="stat__icon">' + (options.icon || ICONS.layers) + '</span></div>'
            + '<div class="stat__value' + (options.compact ? ' stat__value--md' : '') + '">--</div>'
            + '<div class="stat__meta">' + meta + '</div>';

        var valueNode = card.querySelector('.stat__value');
        if (typeof options.value === 'number') {
            Dhm.countUp(valueNode, options.value);
        } else {
            valueNode.textContent = options.value == null ? '--' : options.value;
        }
        return card;
    }

    function renderSkeletons() {
        var wrap = Dhm.el('statCards');
        wrap.innerHTML = '';
        for (var i = 0; i < 3; i++) {
            var card = document.createElement('div');
            card.className = 'card stat';
            card.innerHTML = '<div class="skeleton" style="height:11px;width:45%;margin-bottom:16px"></div>'
                + '<div class="skeleton" style="height:32px;width:70%;margin-bottom:12px"></div>'
                + '<div class="skeleton" style="height:11px;width:55%"></div>';
            wrap.appendChild(card);
        }
        ['chartTotals', 'chartDaily', 'chartDistribution', 'chartRanking'].forEach(function (id) {
            Dhm.el(id).innerHTML = '<div class="skeleton" style="height:240px"></div>';
        });
    }

    /* --------------------------------------------------------------- status */
    function renderSchedulerStatus(summary) {
        var pill = Dhm.el('schedulerPill');
        var text = Dhm.el('schedulerText');
        var online = summary && summary.scheduler_online;
        pill.classList.toggle('is-online', !!online);
        pill.classList.toggle('is-offline', !online);
        if (online) {
            text.textContent = '调度运行中';
            pill.title = '每 ' + summary.refresh_interval_hours + ' 小时自动刷新';
        } else {
            text.textContent = '调度离线';
            pill.title = '未检测到调度心跳：本地开发需运行 app.py（已内置调度）或 scheduler.py，Docker 部署请检查 scheduler 服务';
        }
    }

    function renderPageSub(summary) {
        if (!summary) return;
        var parts = [];
        parts.push('上次刷新 ' + Dhm.formatRelative(summary.last_refresh_at));
        if (summary.scheduler_online) {
            parts.push('每 ' + summary.refresh_interval_hours + ' 小时自动采集');
        }
        Dhm.el('pageSub').textContent = parts.join(' · ');
    }

    /* -------------------------------------------------------------- overall */
    function renderOverall() {
        Dhm.el('overallView').classList.remove('hidden');
        Dhm.el('detailView').classList.add('hidden');
        Dhm.el('pageTitle').textContent = '仪表盘';

        var data = state.data;
        if (!data) return;

        renderSchedulerStatus(data.summary);
        renderPageSub(data.summary);

        var images = data.images || [];
        var wrap = Dhm.el('statCards');
        wrap.innerHTML = '';

        wrap.appendChild(statCard({
            label: '累计拉取总量', value: data.summary.total_pulls, icon: ICONS.layers, delay: 0,
            tint: 'blue', meta: '全部镜像合计'
        }));
        wrap.appendChild(statCard({
            label: '日均新增', value: data.summary.avg_pulls_per_day, icon: ICONS.trend, delay: 60,
            tint: 'teal', meta: '近 ' + (data.days || state.days) + ' 天平均'
        }));
        wrap.appendChild(statCard({
            label: '监控镜像', value: data.summary.image_count, icon: ICONS.box, delay: 120,
            tint: 'violet', meta: '当前启用中的仓库'
        }));

        if (images.length === 0) {
            ['chartTotals', 'chartDaily', 'chartDistribution', 'chartRanking'].forEach(function (id) {
                chartEmpty(id, id, '还没有监控任何镜像', 220);
            });
            return;
        }

        var dates = unionDates(images);
        var ranking = images.slice().sort(function (a, b) {
            return ((b.latest && b.latest.pulls_total) || 0) - ((a.latest && a.latest.pulls_total) || 0);
        });
        var names = images.map(function (img) { return img.display_name; });
        var totals = images.map(function (img) { return (img.latest && img.latest.pulls_total) || 0; });

        // Stable per-image colour, keyed by the canonical (alphabetical)
        // order so the same repository keeps the same colour in every chart
        // regardless of how that chart sorts or groups its series.
        var colorByImage = {};
        images.forEach(function (img, index) {
            colorByImage[img.id] = PALETTE[index % PALETTE.length];
        });
        function colorOf(id) { return colorByImage[id] || PALETTE[0]; }
        var imageColors = images.map(function (img) { return colorOf(img.id); });

        var scaleMode = totalsScaleMode(images);
        renderScaleToggle(scaleMode);

        // 1. cumulative totals (area)
        if (dates.length === 0) {
            chartEmpty('totals', 'chartTotals', '数据收集中', 240);
        } else {
            setChart('totals', 'chartTotals', baseChart({
                chart: Object.assign(baseChart().chart, { type: 'area', height: 300 }),
                series: buildSeries(images, dates, 'pulls_total'),
                colors: imageColors,
                stroke: { curve: 'smooth', width: 2 },
                fill: { type: 'solid', opacity: 0.1 },
                markers: { size: 0, hover: { size: 5 } },
                xaxis: {
                    categories: axisLabels(dates),
                    tickAmount: Math.min(8, dates.length),
                    labels: { style: { fontSize: '11px', fontWeight: 600 } },
                    axisBorder: { show: false }, axisTicks: { show: false }
                },
                yaxis: {
                    logarithmic: scaleMode === 'log',
                    tickAmount: scaleMode === 'log' ? 5 : undefined,
                    labels: { formatter: Dhm.formatCompact, style: { fontSize: '11px', fontWeight: 600 } }
                },
                tooltip: { shared: true, intersect: false, y: { formatter: Dhm.formatNumber } }
            }));
        }

        // 2. daily rate (grouped bars)
        var dailyHasData = dates.some(function (date) {
            return images.some(function (img) {
                var point = (img.series || []).find(function (p) { return p.date === date; });
                return point && point.pulls_per_day > 0;
            });
        });
        if (!dailyHasData) {
            chartEmpty('daily', 'chartDaily', '数据收集中，暂无可用的每日增量', 280);
        } else {
            setChart('daily', 'chartDaily', baseChart({
                chart: Object.assign(baseChart().chart, { type: 'bar', height: 300, stacked: false }),
                series: buildSeries(images, dates, 'pulls_per_day'),
                colors: imageColors,
                plotOptions: { bar: { columnWidth: '58%', borderRadius: 4, borderRadiusApplication: 'end' } },
                xaxis: {
                    categories: axisLabels(dates),
                    tickAmount: Math.min(8, dates.length),
                    labels: { style: { fontSize: '11px', fontWeight: 600 } },
                    axisBorder: { show: false }, axisTicks: { show: false }
                },
                yaxis: { labels: { formatter: Dhm.formatCompact, style: { fontSize: '11px', fontWeight: 600 } } },
                tooltip: { shared: true, intersect: false, y: { formatter: Dhm.formatNumber } },
                fill: { opacity: 1 }
            }));
        }

        // 3. distribution (donut)
        var total = totals.reduce(function (sum, value) { return sum + value; }, 0);
        if (total <= 0) {
            chartEmpty('distribution', 'chartDistribution', '暂无拉取数据', 280);
        } else {
            setChart('distribution', 'chartDistribution', baseChart({
                chart: Object.assign(baseChart().chart, { type: 'donut', height: 300 }),
                series: totals,
                labels: names,
                colors: imageColors,
                stroke: { width: 2, colors: [cssVar('--surface', '#fff')] },
                plotOptions: {
                    pie: {
                        donut: { size: '64%', labels: {
                            show: true,
                            name: { fontSize: '12px', fontWeight: 600, color: cssVar('--text-muted', '#5b6472') },
                            value: {
                                fontSize: '20px', fontWeight: 800, color: cssVar('--text', '#131820'),
                                formatter: function (value) { return Dhm.formatCompact(value); }
                            },
                            total: {
                                show: true, label: '合计', fontSize: '12px', fontWeight: 600,
                                color: cssVar('--text-muted', '#5b6472'),
                                formatter: function (w) { return Dhm.formatCompact(w.globals.seriesTotals.reduce(function (a, b) { return a + b; }, 0)); }
                            }
                        } }
                    }
                },
                legend: { position: 'bottom', horizontalAlign: 'center' }
            }));
        }

        // 4. ranking (horizontal bars)
        if (ranking.length === 0 || total <= 0) {
            chartEmpty('ranking', 'chartRanking', '暂无拉取数据', 280);
        } else {
            setChart('ranking', 'chartRanking', baseChart({
                chart: Object.assign(baseChart().chart, { type: 'bar', height: 300 }),
                series: [{ name: '累计拉取', data: ranking.map(function (img) { return (img.latest && img.latest.pulls_total) || 0; }) }],
                colors: ranking.map(function (img) { return colorOf(img.id); }),
                plotOptions: {
                    bar: { horizontal: true, borderRadius: 4, borderRadiusApplication: 'end', distributed: true, barHeight: '58%' }
                },
                legend: { show: false },
                xaxis: {
                    categories: ranking.map(function (img) { return img.display_name; }),
                    labels: { formatter: Dhm.formatCompact, style: { fontSize: '11px', fontWeight: 600 } },
                    axisBorder: { show: false }, axisTicks: { show: false }
                },
                yaxis: { labels: { style: { fontSize: '12px', fontWeight: 600 } } },
                tooltip: { y: { formatter: Dhm.formatNumber } }
            }));
        }
    }

    /* --------------------------------------------------------------- detail */
    function renderDetail(imageId) {
        Dhm.el('overallView').classList.add('hidden');
        Dhm.el('detailView').classList.remove('hidden');
        Dhm.el('pageTitle').textContent = '镜像详情';

        var img = (state.data.images || []).find(function (item) { return item.id === imageId; });
        if (!img) {
            Dhm.toast('镜像不存在', 'error');
            return;
        }

        Dhm.el('detailName').textContent = img.display_name;
        Dhm.el('detailRepo').textContent = img.namespace + '/' + img.name;

        var latest = img.latest || {};
        var wrap = Dhm.el('detailStats');
        wrap.innerHTML = '';
        wrap.appendChild(statCard({
            label: '累计拉取', value: latest.pulls_total || 0, icon: ICONS.layers, delay: 0,
            tint: 'blue', meta: 'Docker Hub pull_count'
        }));
        wrap.appendChild(statCard({
            label: '日均新增', value: latest.avg_pulls_per_day || 0, icon: ICONS.trend, delay: 60,
            tint: 'teal',
            meta: latest.gap_days ? ('近 ' + state.days + ' 天平均') : '首个观测日，暂无增量'
        }));
        wrap.appendChild(statCard({
            label: '最近观测', value: Dhm.formatRelative(latest.captured_at), icon: ICONS.clock, delay: 120,
            tint: 'violet', compact: true,
            metaHtml: '<span>Docker Hub 更新 ' + Dhm.escapeHtml(Dhm.formatDateTime(latest.last_updated)) + '</span>'
        }));

        var series = img.series || [];
        var detailColor = imageColor(state.data.images || [], imageId);
        if (series.length < 2) {
            chartEmpty('detailTotal', 'chartDetailTotal', '数据收集中，至少需要两次观测', 240);
            chartEmpty('detailDaily', 'chartDetailDaily', '数据收集中，至少需要两次观测', 240);
        } else {
            setChart('detailTotal', 'chartDetailTotal', baseChart({
                chart: Object.assign(baseChart().chart, { type: 'area', height: 300 }),
                series: [{ name: '累计拉取', data: series.map(function (p) { return p.pulls_total; }) }],
                colors: [detailColor],
                stroke: { curve: 'smooth', width: 2 },
                fill: { type: 'solid', opacity: 0.12 },
                markers: { size: 0, hover: { size: 5 } },
                legend: { show: false },
                xaxis: {
                    categories: axisLabels(series.map(function (p) { return p.date; })),
                    tickAmount: Math.min(8, series.length),
                    labels: { style: { fontSize: '11px', fontWeight: 600 } },
                    axisBorder: { show: false }, axisTicks: { show: false }
                },
                yaxis: { labels: { formatter: Dhm.formatCompact, style: { fontSize: '11px', fontWeight: 600 } } },
                tooltip: { y: { formatter: Dhm.formatNumber } }
            }));

            setChart('detailDaily', 'chartDetailDaily', baseChart({
                chart: Object.assign(baseChart().chart, { type: 'bar', height: 300 }),
                series: [{ name: '每日新增', data: series.map(function (p) { return p.pulls_per_day; }) }],
                colors: [detailColor],
                plotOptions: { bar: { columnWidth: '56%', borderRadius: 4, borderRadiusApplication: 'end' } },
                legend: { show: false },
                xaxis: {
                    categories: axisLabels(series.map(function (p) { return p.date; })),
                    tickAmount: Math.min(8, series.length),
                    labels: { style: { fontSize: '11px', fontWeight: 600 } },
                    axisBorder: { show: false }, axisTicks: { show: false }
                },
                yaxis: { labels: { formatter: Dhm.formatCompact, style: { fontSize: '11px', fontWeight: 600 } } },
                tooltip: { y: { formatter: Dhm.formatNumber } },
                fill: { opacity: 1 }
            }));
        }

        loadTags(imageId, false);
    }

    function renderTags(imageId, tags, cachedAt) {
        var wrap = Dhm.el('detailTags');
        if (!tags || tags.length === 0) {
            wrap.innerHTML = '<div class="empty"><div class="empty__mark">' + ICONS.empty + '</div>'
                + '<div class="empty__title">暂无版本信息</div>'
                + '<div class="empty__desc">Docker Hub 未返回该仓库的标签</div></div>';
            return;
        }
        Dhm.el('tagsSub').textContent = cachedAt
            ? '缓存于 ' + Dhm.formatRelative(new Date(cachedAt * 1000).toISOString()) + ' · 共 ' + tags.length + ' 个'
            : '共 ' + tags.length + ' 个版本';

        var html = '<div class="tags">';
        tags.forEach(function (tag) {
            var active = tag.status === 'active';
            html += '<div class="tag-chip">'
                + '<span class="tag-chip__name" title="' + Dhm.escapeHtml(tag.name) + '">' + Dhm.escapeHtml(tag.name) + '</span>'
                + '<span class="tag-chip__meta">'
                + '<span class="badge ' + (active ? 'badge--success' : '') + '">' + (active ? '可用' : '停用') + '</span>'
                + '<span class="tag-chip__time">推送 ' + Dhm.escapeHtml(Dhm.formatDate(tag.tag_last_pushed)) + '</span>'
                + '</span></div>';
        });
        html += '</div>';
        wrap.innerHTML = html;
    }

    async function loadTags(imageId, force) {
        var wrap = Dhm.el('detailTags');
        wrap.innerHTML = '<div class="skeleton" style="height:120px"></div>';
        try {
            var data = await Dhm.api('/api/images/' + imageId + '/tags' + (force ? '?force=1' : ''));
            renderTags(imageId, data.tags, data.cached_at);
        } catch (e) {
            wrap.innerHTML = '<div class="empty"><div class="empty__mark">' + ICONS.empty + '</div>'
                + '<div class="empty__title">版本信息获取失败</div>'
                + '<div class="empty__desc">' + Dhm.escapeHtml(e.message || '请稍后重试') + '</div></div>';
        }
    }

    /* ------------------------------------------------------------- selector */
    function renderSelector(images) {
        var select = Dhm.el('imageSelect');
        var current = state.view;
        var html = '<option value="overall">总览</option>';
        images.forEach(function (img) {
            html += '<option value="' + img.id + '">' + Dhm.escapeHtml(img.display_name) + '</option>';
        });
        select.innerHTML = html;
        select.value = (current === 'overall') ? 'overall' : String(current);
        if (!select.value) {
            select.value = 'overall';
            state.view = 'overall';
        }
    }

    function setView(view) {
        state.view = (view === 'overall') ? 'overall' : parseInt(view, 10);
        destroyCharts();
        if (state.view === 'overall') {
            renderOverall();
        } else {
            renderDetail(state.view);
        }
    }

    /* ---------------------------------------------------------------- load */
    async function loadOverview() {
        try {
            var data = await Dhm.api('/api/overview?days=' + state.days);
            state.data = data;
            renderSelector(data.images || []);
            setView(state.view);
        } catch (e) {
            if (e.status === 401) return;
            Dhm.toast(e.message || '加载失败', 'error');
        }
    }

    function bindDays() {
        var buttons = Dhm.el('daysSeg').querySelectorAll('.seg__btn');
        buttons.forEach(function (button) {
            button.classList.toggle('is-active', parseInt(button.dataset.days, 10) === state.days);
            button.addEventListener('click', function () {
                state.days = parseInt(button.dataset.days, 10);
                buttons.forEach(function (b) { b.classList.toggle('is-active', b === button); });
                destroyCharts();
                loadOverview();
            });
        });
    }

    function bindTotalsScale() {
        var seg = Dhm.el('totalsScaleSeg');
        if (!seg) return;
        seg.querySelectorAll('.seg__btn').forEach(function (button) {
            button.classList.toggle('is-active', button.dataset.scale === state.totalsScale);
        });
        seg.addEventListener('click', function (event) {
            var button = event.target.closest('.seg__btn');
            if (!button || !button.dataset.scale) return;
            state.totalsScale = button.dataset.scale;
            try { window.localStorage.setItem(SCALE_KEY, state.totalsScale); } catch (e) { /* ignore */ }
            seg.querySelectorAll('.seg__btn').forEach(function (b) {
                b.classList.toggle('is-active', b === button);
            });
            if (state.view === 'overall' && state.data) renderOverall();
        });
    }

    function bindRefresh() {
        var all = Dhm.el('refreshAll');
        all.addEventListener('click', async function () {
            all.classList.add('is-loading');
            var original = all.innerHTML;
            all.innerHTML = '<span class="spin"></span>刷新中';
            try {
                var result = await Dhm.api('/api/refresh', { method: 'POST' });
                var message = result.status === 'success'
                    ? '刷新完成，' + result.success + ' 个镜像'
                    : '刷新完成：成功 ' + result.success + ' / 失败 ' + result.failed;
                Dhm.toast(message, result.failed > 0 ? 'warning' : 'success');
                await loadOverview();
            } catch (e) {
                Dhm.toast(e.message || '刷新失败', 'error');
            } finally {
                all.classList.remove('is-loading');
                all.innerHTML = original;
            }
        });

        Dhm.el('refreshOne').addEventListener('click', async function () {
            if (state.view === 'overall') return;
            var button = this;
            var original = button.innerHTML;
            button.classList.add('is-loading');
            button.innerHTML = '<span class="spin"></span>刷新中';
            try {
                await Dhm.api('/api/images/' + state.view + '/refresh', { method: 'POST' });
                Dhm.toast('镜像已刷新', 'success');
                await loadOverview();
            } catch (e) {
                Dhm.toast(e.message || '刷新失败', 'error');
            } finally {
                button.classList.remove('is-loading');
                button.innerHTML = original;
            }
        });

        Dhm.el('refreshTags').addEventListener('click', function () {
            if (state.view !== 'overall') loadTags(state.view, true);
        });
    }

    function bindNavigation() {
        Dhm.el('imageSelect').addEventListener('change', function () {
            setView(this.value);
        });
        Dhm.el('backToOverview').addEventListener('click', function () {
            Dhm.el('imageSelect').value = 'overall';
            setView('overall');
        });
    }

    async function pollHealth() {
        try {
            var health = await fetch('/api/health').then(function (r) { return r.json(); });
            renderSchedulerStatus(health);
        } catch (e) {
            renderSchedulerStatus({ scheduler_online: false });
        }
    }

    document.addEventListener('app:ready', function () {
        renderSkeletons();
        bindDays();
        bindTotalsScale();
        bindRefresh();
        bindNavigation();
        loadOverview();
        pollHealth();
        setInterval(pollHealth, 45000);
    });

    document.addEventListener('theme:change', function () {
        if (state.data) {
            destroyCharts();
            if (state.view === 'overall') renderOverall();
            else renderDetail(state.view);
        }
    });
})();
