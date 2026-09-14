// plugins/plugin-api.js
// LocalPlayer 最小插件接口（无外部框架，约 40 行）。
// 一个「媒体源插件」(MediaSource) 形如：
//   {
//     id: string,                                    // 唯一标识
//     name: string,                                  // 展示名
//     priority?: number,                             // 越大越优先（默认 0）
//     getMedia(): Promise<Array<{name,path,type}>>   // 返回媒体列表；失败时抛错
//   }
// 注册：LocalPlayer.plugins.register(provider)
//       （本文件须在 popup.html 中先于 popup.js 加载）
// 取数：LocalPlayer.plugins.collectMedia()
//       —— 按优先级取第一个返回非空列表的插件（fallback 链）
window.LocalPlayer = (function () {
    'use strict';
    const sources = [];

    function register(provider) {
        if (!provider || typeof provider.getMedia !== 'function' || !provider.id) {
            console.warn('LocalPlayer: 忽略无效插件', provider);
            return;
        }
        sources.push(provider);
    }

    async function collectMedia() {
        const sorted = sources.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));
        for (const src of sorted) {
            try {
                const items = await src.getMedia();
                if (Array.isArray(items) && items.length) return items;
            } catch (e) {
                // LP_SILENT 前缀：预期内的静默跳过（如后端未启动），不打日志
                if (!(e && typeof e.message === 'string' && e.message.startsWith('LP_SILENT:'))) {
                    console.warn(`LocalPlayer: 插件「${src.name || src.id}」获取失败，已跳过`, e);
                }
            }
        }
        return [];
    }

    function list() {
        return sources.map(s => ({ id: s.id, name: s.name, priority: s.priority || 0 }));
    }

    return { plugins: { register, collectMedia, list } };
})();
