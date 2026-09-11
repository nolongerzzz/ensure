// demo/app.js — stand-in for a real app's boot script.
// Sets a global (checked by the globalExists kind) and stamps the version
// tag into the DOM (checked by the agree kind, cross-referenced against
// this same script's own ?v= query param).
window.state = { ready: true, placed: [] };

// Fixture for a negative control: a global that exists but is null. typeof
// null is 'object', so this is what an expectType: 'object' check must NOT
// accept — see checks/negative-controls.json.
window.nullState = null;

var scriptEl = document.getElementById('main-script');
var src = scriptEl.getAttribute('src');
var version = new URLSearchParams(src.split('?')[1] || '').get('v');
document.getElementById('adjust-status').textContent = version;
