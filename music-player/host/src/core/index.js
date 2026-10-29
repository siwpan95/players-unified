// Minimal Cordis-compatible core (zero dependencies, pure Node ESM).
//
// This is a deliberately small re-implementation of the subset of the
// @cordisjs/core API that this host uses, modeled on the local E:\cordis
// source (packages/core/src/{context,service,fiber,events,registry}.ts).
//
// Swappable: when network is available, replace this file's `Context` /
// `Service` with `import { Context, Service } from 'cordis'` and the rest of
// the host keeps working unchanged (same method surface used below).
//
// Differences from real Cordis (documented, intentional for offline use):
//   * Events use a per-Context listener set (no cross-fork bubbling). For a
//     single-app host we register app-wide listeners on the root context.
//   * No HMR / no YAML loader (config is a plain JS array of plugin entries).
// Everything else (DI via provide/inject, Service, plugin apply, Fork +
// dispose lifecycle, timer effects) mirrors Cordis semantics.

export class Context {
  constructor(options = {}) {
    this.root = options.root || this;
    this.parent = options.parent || null;
    this.children = [];
    this._services = Object.create(null); // name -> instance
    this._listeners = Object.create(null); // event -> Set<fn>
    this._effects = []; // cleanup fns (timers, listeners, child forks)
    this._pending = []; // pending injects { names, callback }
    this._disposed = false;
    if (this === this.root) {
      // A tiny built-in logger, mirroring ctx.logger in Cordis.
      this.logger = new Logger('app');
    }
  }

  // ---- Services (DI) ----
  provide(name, value) {
    this._services[name] = value;
    try { this[name] = value; } catch { /* read-only names ignored */ }
    this._resolveInjects();
    return value;
  }

  get(name) {
    // Resolve up the context tree, like Cordis service lookup.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let ctx = this;
    while (ctx) {
      if (name in ctx._services) return ctx._services[name];
      ctx = ctx.parent;
    }
    return undefined;
  }

  has(name) {
    return this.get(name) !== undefined;
  }

  // ---- Events (global bus on the root context; adequate for a single app) ----
  on(event, listener) {
    const hub = this.root._listeners;
    (hub[event] ||= new Set()).add(listener);
    return () => this.off(event, listener);
  }

  off(event, listener) {
    this.root._listeners[event]?.delete(listener);
  }

  emit(event, ...args) {
    const hub = this.root._listeners;
    for (const fn of hub[event] || []) {
      try { fn(...args); } catch (e) { this.logger?.error?.('listener error', e); }
    }
  }

  // ---- Inject (demand-driven DI) ----
  inject(deps, callback) {
    const names = (Array.isArray(deps) ? deps : [deps]).slice();
    const run = () => {
      if (names.every((n) => this.get(n) !== undefined)) {
        callback(...names.map((n) => this.get(n)));
        return true;
      }
      return false;
    };
    if (!run()) this._pending.push({ names, callback });
    return () => {};
  }

  _resolveInjects() {
    this._pending = this._pending.filter((p) => {
      if (p.names.every((n) => this.get(n) !== undefined)) {
        p.callback(...p.names.map((n) => this.get(n)));
        return false;
      }
      return true;
    });
  }

  // ---- Timer effects (auto-cleared on dispose, like ctx.interval) ----
  interval(fn, ms) {
    const id = setInterval(fn, ms);
    const effect = () => clearInterval(id);
    this._effects.push(effect);
    return id;
  }

  timeout(fn, ms) {
    const id = setTimeout(() => {
      fn();
      this._removeEffect(() => clearTimeout(id));
    }, ms);
    this._effects.push(() => clearTimeout(id));
    return id;
  }

  _removeEffect(predicate) {
    this._effects = this._effects.filter((e) => e !== predicate);
  }

  // ---- Forking / plugins ----
  fork() {
    const child = new Context({ root: this.root, parent: this });
    child.logger = this.logger; // children inherit the root logger
    this.children.push(child);
    const effect = () => child.dispose();
    this._effects.push(effect);
    return child;
  }

  plugin(plugin, config) {
    const child = this.fork();
    this._applyPlugin(child, plugin, config);
    return {
      dispose: () => child.dispose(),
      context: child,
    };
  }

  _applyPlugin(ctx, plugin, config) {
    if (typeof plugin === 'function') {
      plugin(ctx, config);
    } else if (plugin && typeof plugin.apply === 'function') {
      plugin.apply(ctx, config);
    } else if (plugin && typeof plugin === 'object') {
      for (const value of Object.values(plugin)) this._applyPlugin(ctx, value, config);
    } else {
      throw new TypeError('invalid plugin');
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.emit('dispose');
    for (const child of [...this.children]) child.dispose();
    for (const effect of [...this._effects]) {
      try { effect(); } catch (e) { /* ignore */ }
    }
    this._effects = [];
  }

  get disposed() {
    return this._disposed;
  }
}

export class Service {
  constructor(ctx, name) {
    this.ctx = ctx;
    // Provide on the root context so sibling plugins can resolve it via get().
    ctx.root.provide(name, this);
  }
}

export class Logger {
  constructor(name) {
    this.name = name;
  }
  _ts() { return new Date().toISOString().slice(11, 23); }
  info(...args) { console.log(`[${this._ts()}][${this.name}]`, ...args); }
  warn(...args) { console.warn(`[${this._ts()}][${this.name}]`, ...args); }
  error(...args) { console.error(`[${this._ts()}][${this.name}]`, ...args); }
}

export { Context as default };
