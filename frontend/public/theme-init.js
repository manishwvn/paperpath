/* global document, localStorage */
(() => {
  try {
    const preference = localStorage.getItem('paperpath.theme');
    if (preference === 'system' || preference === 'light' || preference === 'dark') {
      document.documentElement.dataset.theme = preference;
    }
  } catch {
    // The HTML default and system color scheme remain available without storage.
  }
})();
