// Shared audibility rules for playback, controls and track colours.
export function trackState(name, player, { solo = new Set(), previewStem = null, masterMuted = false, masterVolume = 1 } = {}) {
  const soloed = solo.has(name);
  const excluded = previewStem ? previewStem !== name : solo.size > 0 && !soloed;
  const muted = Boolean(player.muted);
  return {
    soloed,
    muted,
    dimmed: muted || excluded,
    gain: muted || excluded || masterMuted ? 0 : player.volume * masterVolume,
    previewed: previewStem === name
  };
}
