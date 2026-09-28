/* Apply the saved theme before first paint to avoid a flash. */
(function () {
    var theme = 'light';
    try {
        if (window.localStorage.getItem('dhm-theme') === 'dark') {
            theme = 'dark';
        }
    } catch (e) {
        theme = 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
})();
