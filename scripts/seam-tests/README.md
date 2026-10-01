# Static collision seam regressions

Run with Node 20.19+:

```sh
cd scripts/seam-tests
npm install --ignore-scripts
npm test
```

Tests use the production Physics.js and Vehicle.js. They cover touching elevated,
pool and tunnel floors at 10, 25, 50 and 100 world units/second; elevated ramps
uphill/downhill in all orientations; pool/tunnel entry and exit; real wall impacts;
real cliffs and jump ramps; dynamic boxes; 2x mega wall height and restoration;
unaltered vehicle controls climbing all four ramp orientations; a 1,000-tile
build; and sliding along straight/rotated wall seams.

The regular solver and continuous collision detection are both exercised. No
whole-velocity restoration is used. The helper only removes buried faces from
static boxes and repairs normals/contact points along shared exterior edges.
Real exposed edges, original body friction/restitution, moving obstacles,
sensors and imported triangle meshes remain separate. Visual GLB files are not
modified. Shared-edge triangle flags use the pinned Crashcat 0.0.2 layout.
