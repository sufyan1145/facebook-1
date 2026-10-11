// Run once from the repo root:  node install-chatbot.js
// Idempotent: registers /api/chat in server.js and loads the widget on every dashboard page via app.js.
const fs = require('fs');
const path = require('path');
const root = process.cwd();
const log = (m) => console.log(m);

// 1) server.js route
const serverPath = path.join(root, 'server.js');
let server = fs.readFileSync(serverPath, 'utf8');
if (server.includes("/api/chat")) {
  log('server.js: already has /api/chat');
} else {
  const m = server.match(/^.*app\.use\('\/api\/videoedit',\s*require\('([^']*)videoEdit'\)\);.*$/m);
  if (!m) { console.error("server.js: could not find the /api/videoedit line; add manually:\napp.use('/api/chat', require('./routes.chat'));"); process.exit(1); }
  const line = m[0].replace('/api/videoedit', '/api/chat').replace(/videoEdit'/, "chat'");
  server = server.replace(m[0], m[0] + '\n' + line);
  fs.writeFileSync(serverPath, server);
  log('server.js: route added -> ' + line.trim());
}

// 2) widget loader at the end of app.js
const candidates = ['public.app.js', 'public/app.js'].map((p) => path.join(root, p));
const appJs = candidates.find((p) => fs.existsSync(p));
if (!appJs) { console.error('app.js not found; add <script src="chat-widget.js"></script> to your dashboard pages manually.'); process.exit(1); }
let app = fs.readFileSync(appJs, 'utf8');
if (app.includes('chat-widget.js')) {
  log(path.basename(appJs) + ': loader already present');
} else {
  app += "\n\n// AI help chat widget (loads on every page that includes app.js)\n(function(){var s=document.createElement('script');s.src='chat-widget.js';s.defer=true;document.body.appendChild(s);})();\n";
  fs.writeFileSync(appJs, app);
  log(path.basename(appJs) + ': loader added');
}
log('Done. Make sure chat-widget.js is in the same folder as app.js (public/).');
