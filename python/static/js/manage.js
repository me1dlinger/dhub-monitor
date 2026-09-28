/* Image management: list, add, refresh one, delete. */
(function () {
    'use strict';

    var ICON_REFRESH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/><path d="M23 4v6h-6"/></svg>';
    var ICON_TRASH = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
    var ICON_OPEN = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14L21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>';

    function hubUrl(img) {
        // Official images live under /_/name; everything else under /r/ns/name.
        var path = img.namespace === 'library'
            ? '_/' + encodeURIComponent(img.name)
            : 'r/' + encodeURIComponent(img.namespace) + '/' + encodeURIComponent(img.name);
        return 'https://hub.docker.com/' + path;
    }

    function skeleton() {
        var body = Dhm.el('imagesBody');
        var html = '';
        for (var i = 0; i < 3; i++) {
            html += '<tr><td colspan="5"><div class="skeleton" style="height:34px"></div></td></tr>';
        }
        body.innerHTML = html;
    }

    function rowHtml(img) {
        var latest = img.latest;
        var total = latest ? Dhm.formatNumber(latest.pulls_total) : '--';
        var rate = latest ? Dhm.formatNumber(latest.avg_pulls_per_day) : '--';
        var observed = latest ? Dhm.formatRelative(latest.captured_at) : '等待采集';

        return '<tr data-id="' + img.id + '">'
            + '<td><div class="cell-name">' + Dhm.escapeHtml(img.display_name) + '</div>'
            + '<div class="cell-sub">' + Dhm.escapeHtml(img.namespace + '/' + img.name) + '</div></td>'
            + '<td class="cell-num text-right">' + total + '</td>'
            + '<td class="cell-num text-right">' + rate + '</td>'
            + '<td><span class="badge">' + Dhm.escapeHtml(observed) + '</span></td>'
            + '<td><div class="cell-actions">'
            + '<a class="btn btn--sm" href="' + hubUrl(img) + '" target="_blank" rel="noopener noreferrer" title="在 Docker Hub 打开">' + ICON_OPEN + 'Hub</a>'
            + '<button type="button" class="btn btn--sm" data-action="refresh">' + ICON_REFRESH + '刷新</button>'
            + '<button type="button" class="btn btn--sm btn--danger" data-action="delete">' + ICON_TRASH + '删除</button>'
            + '</div></td></tr>';
    }

    function render(images) {
        var body = Dhm.el('imagesBody');
        Dhm.el('imagesCount').textContent = images.length
            ? '共 ' + images.length + ' 个仓库'
            : '暂无监控仓库';

        if (!images.length) {
            body.innerHTML = '<tr><td colspan="5"><div class="empty">'
                + '<div class="empty__mark"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/></svg></div>'
                + '<div class="empty__title">还没有监控任何镜像</div>'
                + '<div class="empty__desc">在上方输入命名空间与仓库名即可添加。</div></div></td></tr>';
            return;
        }
        body.innerHTML = images.map(rowHtml).join('');
    }

    async function load() {
        skeleton();
        try {
            var images = await Dhm.api('/api/images');
            render(images);
        } catch (e) {
            if (e.status === 401) return;
            Dhm.el('imagesBody').innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty__title">'
                + Dhm.escapeHtml(e.message || '加载失败') + '</div></div></td></tr>';
        }
    }

    function bindForm() {
        var form = Dhm.el('addForm');
        form.addEventListener('submit', async function (event) {
            event.preventDefault();
            var button = Dhm.el('addSubmit');
            var note = Dhm.el('addNote');
            note.className = 'form-note';
            note.textContent = '';

            var payload = {
                namespace: Dhm.el('namespace').value.trim().toLowerCase(),
                name: Dhm.el('name').value.trim().toLowerCase(),
                display_name: Dhm.el('displayName').value.trim()
            };
            if (!payload.namespace || !payload.name) {
                note.className = 'form-note form-note--err';
                note.textContent = '请填写命名空间与仓库名';
                return;
            }

            var original = button.innerHTML;
            button.classList.add('is-loading');
            button.innerHTML = '<span class="spin"></span>添加中';
            try {
                await Dhm.api('/api/images', { method: 'POST', body: Dhm.json(payload) });
                note.className = 'form-note form-note--ok';
                note.textContent = '添加成功';
                Dhm.toast('镜像添加成功', 'success');
                form.reset();
                await load();
            } catch (e) {
                note.className = 'form-note form-note--err';
                note.textContent = e.message || '添加失败';
                Dhm.toast(e.message || '添加失败', 'error');
            } finally {
                button.classList.remove('is-loading');
                button.innerHTML = original;
            }
        });
    }

    function bindTable() {
        Dhm.el('imagesBody').addEventListener('click', async function (event) {
            var button = event.target.closest('button[data-action]');
            if (!button) return;
            var row = button.closest('tr[data-id]');
            var id = row ? row.dataset.id : null;
            if (!id) return;
            var action = button.dataset.action;

            if (action === 'refresh') {
                var original = button.innerHTML;
                button.classList.add('is-loading');
                button.innerHTML = '<span class="spin"></span>刷新中';
                try {
                    await Dhm.api('/api/images/' + id + '/refresh', { method: 'POST' });
                    Dhm.toast('镜像已刷新', 'success');
                    await load();
                } catch (e) {
                    Dhm.toast(e.message || '刷新失败', 'error');
                    button.classList.remove('is-loading');
                    button.innerHTML = original;
                }
                return;
            }

            if (action === 'delete') {
                var name = row.querySelector('.cell-name');
                var confirmed = await Dhm.confirmDialog({
                    title: '移除镜像',
                    message: '确定要停止监控「' + (name ? name.textContent : '该镜像') + '」吗？历史数据会一并删除。',
                    confirmText: '移除',
                    danger: true
                });
                if (!confirmed) return;
                try {
                    await Dhm.api('/api/images/' + id, { method: 'DELETE' });
                    Dhm.toast('镜像已移除', 'success');
                    await load();
                } catch (e) {
                    Dhm.toast(e.message || '删除失败', 'error');
                }
            }
        });
    }

    document.addEventListener('app:ready', function () {
        bindForm();
        bindTable();
        Dhm.el('reloadImages').addEventListener('click', load);
        load();
    });
})();
