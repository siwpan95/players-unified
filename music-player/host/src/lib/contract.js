// 状态契约（对齐 Python music_player/engine/player_state.py 的 PlayerState
// 与 media_item.py 的 MediaItem）。
//
// 这是 A/B 对拍的「观测点契约」：Python 侧 `engine.get_state().snapshot().__dict__`
// 与 Node 侧 `playerState(ctx)` 必须返回同一组字段名与取值（含枚举字符串）。

export const PlaybackStatus = Object.freeze({ STOPPED: 'stopped', PLAYING: 'playing', PAUSED: 'paused' });
export const PlayMode = Object.freeze({ SEQUENTIAL: 'sequential', LOOP: 'loop', SINGLE: 'single', RANDOM: 'random' });
export const MediaType = Object.freeze({ LOCAL_FILE: 'local_file', DECRYPTED_CACHE: 'decrypted_cache', RADIO_HLS: 'radio_hls', RADIO_HTTP: 'radio_http' });

/** 归一 status：VLC 的 "ended" 在 Python 侧归为 "stopped"（end_reached 即 STOPPED）。 */
function normalizeStatus(status) {
  return status === 'ended' ? PlaybackStatus.STOPPED : (status || PlaybackStatus.STOPPED);
}

/** 聚合 player/playlist/equalizer 服务，返回 Python PlayerState 契约字段。 */
export function playerState(ctx) {
  const player = ctx.get('player');
  const playlist = ctx.get('playlist');
  const equalizer = ctx.get('equalizer');
  const ps = player ? player.getState() : {};
  return {
    status: normalizeStatus(ps.status),
    current_index: playlist ? playlist.currentIndex : -1,
    current_uri: ps.uri || '',
    position_ms: Math.round((ps.currentTime || 0) * 1000),
    duration_ms: Math.round((ps.duration || 0) * 1000),
    volume: ps.volume != null ? ps.volume : 80,
    mute: !!ps.muted,
    play_mode: playlist ? playlist.mode : PlayMode.SEQUENTIAL,
    equalizer_on: equalizer ? equalizer.on : false,
  };
}

export function isRadioMedia(media) {
  return !!media && (media.item_type === MediaType.RADIO_HLS || media.item_type === MediaType.RADIO_HTTP);
}

/** 对齐 Python MediaItem.display_title：metadata.artist 前缀。 */
export function displayTitle(media) {
  if (!media) return '';
  const md = media.metadata || {};
  const title = md.title || media.title || media.name || '';
  return md.artist ? `${md.artist} - ${title}` : title;
}

export default { PlaybackStatus, PlayMode, MediaType, playerState, isRadioMedia, displayTitle };
