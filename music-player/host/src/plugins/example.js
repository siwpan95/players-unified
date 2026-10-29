// Example plugin: proves the host's extensibility point.
//
// A "plugin" is just a function (ctx, config) that subscribes to the global
// event bus and/or registers its own services. It needs no build step and no
// npm dependencies — drop a file in src/plugins and add it to the `plugins`
// list in app.js. This one merely observes playback events; a real plugin
// could add an API endpoint, a scrobbler, a visualizer feed, etc.

export function examplePlugin(ctx, config = {}) {
  ctx.logger?.info?.('[example] loaded — demonstrating the event-bus extension point');
  const offs = [
    ctx.on('player/current', (media) => {
      ctx.logger?.info?.('[example] now playing ->', media ? media.title : '(none)');
    }),
    ctx.on('playlist/changed', (list, idx, mode) => {
      ctx.logger?.info?.('[example] playlist updated ->', list.length, 'tracks, mode =', mode);
    }),
    ctx.on('player/end', () => {
      ctx.logger?.info?.('[example] end-of-track signal received');
    }),
  ];
  ctx.on('dispose', () => offs.forEach((off) => off()));
}

export default examplePlugin;
