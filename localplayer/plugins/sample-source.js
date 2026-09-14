// plugins/sample-source.js
// 【示例插件 · 模板】
// 本文件演示如何编写一个「媒体源插件」。默认不会被加载——
// 如需启用，请在 popup.html 的 plugin-api.js 之后、popup.js 之前加入：
//   <script src="plugins/sample-source.js"></script>
//
// 插件接口（详见 plugins/plugin-api.js 与 README「插件式媒体源」）：
//   LocalPlayer.plugins.register({
//     id: 'my-source',                 // 唯一
//     name: '我的媒体源',
//     priority: 5,                     // 越大越优先；后端=10，本地打包=0
//     async getMedia() {               // 返回 {name,path,type}[]；失败时抛错以便 fallback
//       ...
//     }
//   });

(function () {
    if (!window.LocalPlayer) {
        console.warn('LocalPlayer: 请先加载 plugins/plugin-api.js');
        return;
    }

    // 示例：从 chrome.storage.sync 读取一个自定义媒体列表（键 userMediaList）。
    // 用户可在「扩展选项」页或 devtools 里写入该键来注入自己的媒体源。
    LocalPlayer.plugins.register({
        id: 'user-list',
        name: '示例：用户自定义列表',
        priority: 5,
        async getMedia() {
            const cfg = await new Promise(res => chrome.storage.sync.get('userMediaList', res));
            const list = Array.isArray(cfg.userMediaList) ? cfg.userMediaList : [];
            if (!list.length) throw new Error('userMediaList 为空');
            return list.map(m => ({
                name: m.name,
                type: m.type || 'video',
                path: m.path
            }));
        }
    });
})();
