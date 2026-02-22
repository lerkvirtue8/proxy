const fs = require('fs');
const path = 'c:/Users/dirtmercy/Documents/repos/GitHub/proxy/index (10).html';
let html = fs.readFileSync(path, 'utf8');
const start = '<!-- Poe Adapter v3 — inlined to avoid CSP blocks and 404s -->';
const end = '</script>';
const i = html.indexOf(start);
if (i < 0) {
  console.error('start not found');
  process.exit(1);
}
const j = html.indexOf(end, i);
if (j < 0) {
  console.error('end not found');
  process.exit(1);
}
const before = html.slice(0, i);
const after = html.slice(j + end.length);
const newSnippet = `    <!-- Poe Adapter (external) -->
    <script>
    window.POE_ADAPTER_CONFIG = {
        // leave proxyUrl unspecified to use current origin
        debug: true
    };
    </script>
    <script src=\"https://vercel-poe-proxy.vercel.app/poe-adapter.js\"></script>
`;
fs.writeFileSync(path, before + newSnippet + after, 'utf8');
console.log('patched');
