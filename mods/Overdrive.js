const state = {
  keyLatch: Object.create(null),
  active: false,
};

const OVERDRIVE = {
  id: 'overdrive',
  name: 'Overdrive',
  description: 'A high-speed arcade mod: stronger acceleration, looser grip, and Space-triggered turbo.',

  init(context) {
    this.ctx = context;
    state.keyLatch = Object.create(null);
    state.active = false;

    const api = context?.api || {};
    if (typeof api.setAccelMultiplier === 'function') api.setAccelMultiplier(1.35);
    if (typeof api.setDriveMultiplier === 'function') api.setDriveMultiplier(1.15);
    if (typeof api.setGripMultiplier === 'function') api.setGripMultiplier(0.82);
    if (typeof api.showMessage === 'function') api.showMessage('OVERDRIVE ONLINE');
  },

  applyFrame({ controls, dt }) {
    const ctx = this.ctx || {};
    const api = ctx.api || {};
    const spaceDown = Boolean(controls?.keys?.Space);

    if (spaceDown && !state.keyLatch.Space) {
      state.active = true;
      if (typeof api.boost === 'function') api.boost(9);
      if (typeof api.cameraShake === 'function') api.cameraShake(1.2);
      if (typeof api.showMessage === 'function') api.showMessage('TURBO!');
    }
    state.keyLatch.Space = spaceDown;

    if (state.active) {
      if (typeof api.setDriveMultiplier === 'function') api.setDriveMultiplier(1.45);
      if (typeof api.setGripMultiplier === 'function') api.setGripMultiplier(0.72);
      state.active = false;
    } else {
      if (typeof api.setDriveMultiplier === 'function') api.setDriveMultiplier(1.15);
      if (typeof api.setGripMultiplier === 'function') api.setGripMultiplier(0.82);
    }
  },
};

export default OVERDRIVE;
export { OVERDRIVE };
