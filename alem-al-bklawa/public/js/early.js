// Runs before first paint: skip the splash if it was already shown in this browser session.
try { if (sessionStorage.getItem('abk_splash') === '1') document.documentElement.classList.add('no-splash'); } catch (e) { /* storage blocked */ }
