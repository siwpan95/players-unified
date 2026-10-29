// Host bootstrap: build the root Cordis context, register services, and load
// plugins from a declarative config (mirrors Cordis loader semantics).
//
// Run:  node app.js
// Then open http://127.0.0.1:19718 in a browser.
//
// NOTE on the core: we use the zero-dependency Cordis-compatible core in
// ./src/core/index.js because the local E:\cordis source can't run offline
// (it needs @cordisjs/cosmokit + a build step, and npm is unreachable here).
// To switch to the real framework later, change the single import below to
//   import { Context } from 'cordis';
// and every service/plugin keeps working unchanged.

import { Context, Logger } from './src/core/index.js';
import { PlayerService } from './src/services/player.js';
import { PlaylistService } from './src/services/playlist.js';
import { EqualizerService } from './src/services/equalizer.js';
import { LyricsService } from './src/services/lyrics.js';
import { VisualizerService } from './src/services/visualizer.js';
import { EncryptedImportService } from './src/services/encrypted-import.js';
import { RpcService } from './src/services/rpc.js';
import { webUi } from './src/plugins/webui.js';
import { examplePlugin } from './src/plugins/example.js';

const root = new Context({ root: null });
root.logger = new Logger('host');

// ---- services (instantiated on the root context; provide() registers them) ----
new PlayerService(root, {
  vlcPath: process.env.VLC_PATH || 'E:/VLC/vlc.exe',
  rcPort: parseInt(process.env.VLC_RC_PORT || '18199', 10),
  debug: process.env.VLC_DEBUG === '1',
});
new PlaylistService(root, {
  mode: process.env.PLAY_MODE || 'sequential',
  autoAdvance: true,
});
new EqualizerService(root);
new LyricsService(root);
new VisualizerService(root, { mode: process.env.VIZ_MODE || 'spectrum' });
new EncryptedImportService(root, {
  ncmDir: process.env.NCMTURNMP3_DIR || 'D:/projects/ncmturnmp3',
});
new RpcService(root, {
  port: parseInt(process.env.RPC_PORT || '7700', 10),
  host: process.env.RPC_HOST || '127.0.0.1',
});

// ---- plugins (declarative loader; each entry is [pluginFn, config]) ----
const plugins = [
  [webUi, { port: parseInt(process.env.WEB_PORT || '19718', 10), host: process.env.WEB_HOST || '127.0.0.1' }],
  [examplePlugin, {}], // proves the extensibility point (logs on track change)
];
for (const [plugin, config] of plugins) root.plugin(plugin, config);

root.logger.info('host started; services = player, playlist, equalizer, lyrics, visualizer, encrypted-import, rpc');

// ---- graceful shutdown ----
let shutting = false;
function shutdown(sig) {
  if (shutting) return;
  shutting = true;
  root.logger.info(`received ${sig}, shutting down…`);
  root.dispose();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
