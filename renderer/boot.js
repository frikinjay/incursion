// Set the theme and hold transitions before the first paint, otherwise the light-to-dark transition plays once the
// window shows.
(() => {
    const root = document.documentElement;
    const theme = window.incursion?.initialTheme;
    root.dataset.theme = theme === 'dark' || theme === 'light' ? theme : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    root.classList.add('booting');
})();
