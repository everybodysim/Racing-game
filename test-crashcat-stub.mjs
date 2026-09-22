// Minimal crashcat stub for node tests: Vehicle.js imports { rigidBody } from
// 'crashcat' at module level (used only at runtime for physics bodies). The
// static slope-tilt math under test needs none of it.
export const rigidBody = new Proxy( {}, { get: () => () => null } );
export const box = () => null;
export const sphere = () => null;
export const MotionType = { STATIC: 0, KINEMATIC: 1, DYNAMIC: 2 };
export const MotionQuality = { LINEAR: 0, SUBSTEPPED: 1 };
